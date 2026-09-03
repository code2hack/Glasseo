import type { AgentKey } from "../directory/types";
import {
  normalizePage,
  provisionalRow,
  sameAgentKey,
  timelineKey,
  validateCachedTimeline,
} from "./normalize";
import {
  TIMELINE_CACHE_VERSION,
  type AgentTimelineSnapshot,
  type CachedAgentTimeline,
  type OlderAnchor,
  type PaseoTimeline,
  type PaseoTimelineEvent,
  type TimelineActivation,
  type TimelineCoordinatorSnapshot,
  type TimelineRow,
  type TimelineRuntime,
  type TimelineSourceToken,
  type TimelineStorage,
} from "./types";

const PAGE_SIZE = 100;

type Replica = {
  snapshot: AgentTimelineSnapshot;
  runtime: TimelineRuntime | null;
  generation: number;
  authorityGeneration: number;
  authoritative: boolean;
  subscriptionError: boolean;
  unsubscribe: () => void;
  buffer: PaseoTimelineEvent[] | null;
  tail: Promise<void> | null;
  older: Promise<OlderAnchor> | null;
  catchup: CatchupJob | null;
};

type CatchupJob = {
  promise: Promise<void>;
  generation: number;
  authorityGeneration: number;
  source: TimelineSourceToken;
  cursor: { epoch: string; seq: number };
};

type SubscriptionDemand = {
  agentIds: readonly string[];
  sourceToken: TimelineSourceToken | null;
};

export class TimelineCoordinator {
  private readonly replicas = new Map<string, Replica>();
  private readonly listeners = new Set<
    (snapshot: TimelineCoordinatorSnapshot) => void
  >();
  private readonly desiredSubscriptions = new Map<
    TimelineRuntime,
    SubscriptionDemand
  >();
  private readonly appliedSubscriptions = new Map<
    TimelineRuntime,
    SubscriptionDemand
  >();
  private readonly subscriptionJobs = new Map<TimelineRuntime, Promise<void>>();
  private current: AgentKey | null = null;
  private generation = 0;

  constructor(
    private readonly storage: TimelineStorage,
    private readonly clock: () => number = Date.now,
  ) {}

  snapshot(): TimelineCoordinatorSnapshot {
    return {
      current: this.current,
      replicas: new Map(
        [...this.replicas].map(([key, state]) => [key, state.snapshot]),
      ),
    };
  }

  currentSnapshot(): AgentTimelineSnapshot | null {
    return this.current ? (this.replica(this.current)?.snapshot ?? null) : null;
  }

  snapshotFor(key: AgentKey): AgentTimelineSnapshot | null {
    return this.replica(key)?.snapshot ?? null;
  }

  currentSubscriptionTarget(): AgentKey | null {
    const state = this.current ? this.replica(this.current) : null;
    return state && this.subscriptionReady(state) ? state.snapshot.key : null;
  }

  subscribe(
    listener: (snapshot: TimelineCoordinatorSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => this.listeners.delete(listener);
  }

  async activate(activation: TimelineActivation): Promise<void> {
    const previous = this.current ? this.replica(this.current) : null;
    if (
      previous &&
      sameAgentKey(this.current, activation.key) &&
      sameToken(previous.snapshot.sourceToken, activation.sourceToken) &&
      previous.runtime === activation.runtime
    )
      return previous.tail ?? previous.catchup?.promise ?? Promise.resolve();

    if (previous) this.release(previous);
    this.current = { ...activation.key };
    const state = this.ensure(activation.key);
    this.release(state);
    state.runtime = activation.runtime;
    state.generation = ++this.generation;
    state.authorityGeneration++;
    state.authoritative = false;
    state.subscriptionError = false;
    state.tail = null;
    state.older = null;
    state.catchup = null;
    state.buffer = [];
    state.snapshot = {
      ...state.snapshot,
      sourceToken: activation.sourceToken,
      loading: true,
      olderLoading: false,
      catchingUp: false,
      stale: true,
      error: null,
    };
    const generation = state.generation;
    state.unsubscribe = activation.runtime.subscribeTimeline((event) => {
      if (!this.isActive(state, generation, activation.sourceToken)) return;
      if (state.buffer) state.buffer.push(event);
      else this.applyLive(state, generation, activation.sourceToken, event);
    });
    this.setDesiredSubscription(
      activation.runtime,
      [activation.key.agentId],
      activation.sourceToken,
    );
    this.publish();

    await this.loadCache(state, generation, activation.sourceToken);
    if (!this.isActive(state, generation, activation.sourceToken)) return;
    return this.fetchTail(state, generation, activation.sourceToken);
  }

  deactivate(): void {
    const state = this.current ? this.replica(this.current) : null;
    if (state) this.release(state);
    this.current = null;
    this.publish();
  }

  refresh(): Promise<void> {
    const state = this.current ? this.replica(this.current) : null;
    const source = state?.snapshot.sourceToken;
    if (!state || !source || !state.runtime) return Promise.resolve();
    this.setDesiredSubscription(
      state.runtime,
      [state.snapshot.key.agentId],
      source,
    );
    return this.fetchTail(state, state.generation, source);
  }

  loadOlder(key: AgentKey = this.current as AgentKey): Promise<OlderAnchor> {
    const state = key ? this.replica(key) : null;
    const source = state?.snapshot.sourceToken;
    if (
      !state ||
      !source ||
      !state.runtime ||
      !state.snapshot.range ||
      !state.snapshot.hasOlder
    )
      return Promise.resolve({ anchorRowId: null, prependedRowIds: [] });
    if (state.older) return state.older;
    const generation = state.generation;
    const authorityGeneration = state.authorityGeneration;
    const anchorRowId = state.snapshot.rows[0]?.id ?? null;
    state.snapshot = {
      ...state.snapshot,
      olderLoading: true,
      error: state.subscriptionError ? "sync_error" : null,
    };
    this.publish();
    const request = (async (): Promise<OlderAnchor> => {
      try {
        const page = await state.runtime!.getTimeline(key.agentId, {
          direction: "before",
          cursor: {
            epoch: state.snapshot.range!.epoch,
            seq: state.snapshot.range!.startSeq,
          },
          limit: PAGE_SIZE,
          projection: "projected",
        });
        if (
          !this.isActive(state, generation, source) ||
          state.authorityGeneration !== authorityGeneration
        )
          return emptyAnchor(anchorRowId);
        if (page.direction !== "before")
          throw new Error("Unexpected timeline direction");
        if (requiresReplacement(page, state.snapshot.range!.epoch)) {
          state.snapshot = { ...state.snapshot, error: "reset" };
          void this.fetchTail(state, generation, source);
          return emptyAnchor(anchorRowId);
        }
        const normalized = normalizePage(key, page);
        if (
          (page.hasOlder && !normalized.range) ||
          (normalized.range &&
            (normalized.range.startSeq > state.snapshot.range!.startSeq ||
              normalized.range.endSeq < state.snapshot.range!.startSeq - 1))
        )
          throw new Error(
            "Timeline older page was not adjacent or overlapping",
          );
        const before = new Set(state.snapshot.rows.map(({ id }) => id));
        const rows = mergeTimelineRows(state.snapshot.rows, normalized.rows);
        state.snapshot = {
          ...state.snapshot,
          rows,
          range: normalized.range
            ? {
                epoch: normalized.range.epoch,
                startSeq: Math.min(
                  state.snapshot.range!.startSeq,
                  normalized.range.startSeq,
                ),
                endSeq: state.snapshot.range!.endSeq,
              }
            : state.snapshot.range,
          hasOlder: page.hasOlder,
          hasNewer: state.snapshot.hasNewer,
          revision: state.snapshot.revision + 1,
          error: state.subscriptionError ? "sync_error" : null,
        };
        this.persist(state, source);
        this.publish();
        return {
          anchorRowId,
          prependedRowIds: rows
            .filter((row) => !before.has(row.id))
            .map(({ id }) => id),
        };
      } catch {
        if (
          this.isActive(state, generation, source) &&
          state.authorityGeneration === authorityGeneration
        )
          this.fail(state, "sync_error");
        return emptyAnchor(anchorRowId);
      } finally {
        if (
          this.isActive(state, generation, source) &&
          state.authorityGeneration === authorityGeneration
        ) {
          state.snapshot = { ...state.snapshot, olderLoading: false };
          this.publish();
        }
      }
    })();
    state.older = request;
    void request.finally(() => {
      if (state.older === request) state.older = null;
    });
    return request;
  }

  setFollowing(value: boolean): void {
    this.mutateCurrent((snapshot) => ({
      ...snapshot,
      following: value,
      unseenLiveCount:
        value && snapshot.atLatest ? 0 : snapshot.unseenLiveCount,
    }));
  }

  setAtLatest(value: boolean): void {
    this.mutateCurrent((snapshot) => ({
      ...snapshot,
      atLatest: value,
      unseenLiveCount:
        value && snapshot.following ? 0 : snapshot.unseenLiveCount,
    }));
  }

  acknowledgeLatest(): void {
    this.mutateCurrent((snapshot) => ({
      ...snapshot,
      atLatest: true,
      unseenLiveCount: 0,
    }));
  }

  async deleteAgent(key: AgentKey): Promise<void> {
    const state = this.replica(key);
    if (state) {
      if (sameAgentKey(this.current, key)) this.deactivate();
      else this.release(state);
      this.replicas.delete(timelineKey(key));
    }
    await this.storage.deleteAgent(key);
    this.publish();
  }

  async deleteHost(
    serverId: string,
    stillRemoved: () => boolean = () => true,
  ): Promise<void> {
    if (!stillRemoved()) throw new Error("Host cleanup is stale");
    if (this.current?.serverId === serverId) this.deactivate();
    for (const [key, state] of this.replicas) {
      if (state.snapshot.key.serverId !== serverId) continue;
      this.release(state);
      this.replicas.delete(key);
    }
    if (!stillRemoved()) throw new Error("Host cleanup is stale");
    await this.storage.deleteHost(serverId, stillRemoved);
    if (!stillRemoved()) throw new Error("Host cleanup is stale");
    this.publish();
  }

  dispose(): void {
    for (const state of this.replicas.values()) this.release(state);
    this.replicas.clear();
    this.current = null;
    this.listeners.clear();
  }

  private async loadCache(
    state: Replica,
    generation: number,
    source: TimelineSourceToken,
  ): Promise<void> {
    const revision = state.snapshot.revision;
    try {
      const value = await this.storage.loadAgent(state.snapshot.key);
      if (
        value === null ||
        !this.isActive(state, generation, source) ||
        state.snapshot.revision !== revision
      )
        return;
      const cached = validateCachedTimeline(value, state.snapshot.key);
      state.snapshot = {
        ...state.snapshot,
        rows: cached.rows,
        range: cached.range,
        hasOlder: cached.hasOlder,
        hasNewer: cached.hasNewer,
        revision: Math.max(state.snapshot.revision, cached.revision),
        stale: true,
      };
      this.publish();
    } catch {
      if (this.isActive(state, generation, source)) {
        state.snapshot = {
          ...state.snapshot,
          error: "cache_error",
          stale: true,
        };
        this.publish();
      }
    }
  }

  private fetchTail(
    state: Replica,
    generation: number,
    source: TimelineSourceToken,
  ): Promise<void> {
    if (state.tail) return state.tail;
    const authorityGeneration = ++state.authorityGeneration;
    state.authoritative = false;
    if (state.buffer === null) state.buffer = [];
    const beforeFetch = state.snapshot;
    state.snapshot = { ...state.snapshot, loading: true, stale: true };
    this.publish();
    const request = (async () => {
      try {
        const page = await state.runtime!.getTimeline(
          state.snapshot.key.agentId,
          {
            direction: "tail",
            limit: PAGE_SIZE,
            projection: "projected",
          },
        );
        if (
          !this.isActive(state, generation, source) ||
          state.authorityGeneration !== authorityGeneration
        )
          return;
        if (page.direction !== "tail")
          throw new Error("Unexpected timeline direction");
        const normalized = normalizePage(state.snapshot.key, page);
        state.authoritative = true;
        state.subscriptionError = !this.subscriptionReady(state);
        const buffered = state.buffer ?? [];
        const authoritative: AgentTimelineSnapshot = {
          ...state.snapshot,
          rows: normalized.rows,
          range: normalized.range,
          hasOlder: page.hasOlder,
          hasNewer: page.hasNewer,
          loading: false,
          catchingUp: false,
          stale: state.subscriptionError,
          error: state.subscriptionError ? "sync_error" : null,
          revision: state.snapshot.revision + 1,
        };
        let reduction = reduceLiveBatch(authoritative, buffered);
        if (reduction.reconcile === "tail") {
          state.authoritative = false;
          reduction = reduceLiveBatch(
            { ...beforeFetch, loading: false, stale: true, error: "reset" },
            buffered,
          );
        }
        state.buffer = null;
        state.snapshot = { ...reduction.snapshot, loading: false };
        if (reduction.reconcile !== "tail") this.persist(state, source);
        this.publish();
        this.scheduleReconcile(state, generation, source, reduction.reconcile);
      } catch {
        if (
          this.isActive(state, generation, source) &&
          state.authorityGeneration === authorityGeneration
        ) {
          state.authoritative = false;
          const reduction = reduceLiveBatch(
            {
              ...beforeFetch,
              loading: false,
              stale: true,
              error: "sync_error",
            },
            state.buffer ?? [],
          );
          state.buffer = null;
          state.snapshot = {
            ...reduction.snapshot,
            loading: false,
            stale: true,
            error: "sync_error",
          };
          this.publish();
        }
      }
    })();
    state.tail = request;
    void request.finally(() => {
      if (state.tail === request) state.tail = null;
    });
    return request;
  }

  private applyLive(
    state: Replica,
    generation: number,
    source: TimelineSourceToken,
    event: PaseoTimelineEvent,
  ): void {
    const reduction = reduceLive(state.snapshot, event);
    if (reduction.snapshot === state.snapshot) return;
    state.snapshot = reduction.snapshot;
    this.publish();
    this.scheduleReconcile(state, generation, source, reduction.reconcile);
  }

  private scheduleReconcile(
    state: Replica,
    generation: number,
    source: TimelineSourceToken,
    kind: ReconcileKind,
  ): void {
    if (!kind) return;
    const reconcile = () =>
      kind === "tail"
        ? this.fetchTail(state, generation, source)
        : this.catchUp(state, generation, source);
    if (state.tail) void state.tail.finally(reconcile);
    else void reconcile();
  }

  private catchUp(
    state: Replica,
    generation: number,
    source: TimelineSourceToken,
  ): Promise<void> {
    if (state.tail) return state.tail;
    if (!state.snapshot.range) return this.fetchTail(state, generation, source);
    const authorityGeneration = state.authorityGeneration;
    const cursor = {
      epoch: state.snapshot.range.epoch,
      seq: state.snapshot.range.endSeq,
    };
    if (
      state.catchup?.generation === generation &&
      state.catchup.authorityGeneration === authorityGeneration &&
      sameToken(state.catchup.source, source) &&
      sameCursor(state.catchup.cursor, cursor)
    )
      return state.catchup.promise;
    state.snapshot = { ...state.snapshot, catchingUp: true };
    this.publish();
    const job: CatchupJob = {
      promise: Promise.resolve(),
      generation,
      authorityGeneration,
      source,
      cursor,
    };
    const request = (async () => {
      try {
        for (;;) {
          const range = state.snapshot.range;
          if (!range)
            return void (await this.fetchTail(state, generation, source));
          job.cursor = { epoch: range.epoch, seq: range.endSeq };
          const page = await state.runtime!.getTimeline(
            state.snapshot.key.agentId,
            {
              direction: "after",
              cursor: { epoch: range.epoch, seq: range.endSeq },
              limit: PAGE_SIZE,
              projection: "projected",
            },
          );
          if (
            !this.isActive(state, generation, source) ||
            state.authorityGeneration !== authorityGeneration
          )
            return;
          if (page.direction !== "after")
            throw new Error("Unexpected timeline direction");
          if (requiresReplacement(page, range.epoch)) {
            state.snapshot = { ...state.snapshot, error: "reset" };
            return void (await this.fetchTail(state, generation, source));
          }
          const normalized = normalizePage(state.snapshot.key, page);
          if (
            normalized.range &&
            (normalized.range.startSeq > range.endSeq + 1 ||
              (page.hasNewer && normalized.range.endSeq <= range.endSeq))
          )
            throw new Error("Timeline catch-up did not advance contiguously");
          if (page.hasNewer && !normalized.range)
            throw new Error("Timeline catch-up did not advance");
          state.snapshot = {
            ...state.snapshot,
            rows: mergeTimelineRows(state.snapshot.rows, normalized.rows),
            range: normalized.range
              ? {
                  epoch: range.epoch,
                  startSeq: range.startSeq,
                  endSeq: Math.max(range.endSeq, normalized.range.endSeq),
                }
              : range,
            hasNewer: page.hasNewer,
            stale: state.subscriptionError,
            error: state.subscriptionError ? "sync_error" : null,
            revision: state.snapshot.revision + 1,
          };
          this.persist(state, source);
          this.publish();
          if (!page.hasNewer) {
            const pending = state.snapshot.rows.some(
              (row) =>
                row.provisional && row.seqStart > state.snapshot.range!.endSeq,
            );
            if (!pending) return;
            if (!normalized.range || normalized.range.endSeq <= range.endSeq)
              throw new Error("Timeline catch-up did not certify live rows");
          }
        }
      } catch {
        if (
          this.isActive(state, generation, source) &&
          state.authorityGeneration === authorityGeneration
        )
          this.fail(state, "sync_error");
      } finally {
        if (
          this.isActive(state, generation, source) &&
          state.authorityGeneration === authorityGeneration
        ) {
          state.snapshot = { ...state.snapshot, catchingUp: false };
          this.publish();
        }
      }
    })();
    job.promise = request;
    state.catchup = job;
    void request.finally(() => {
      if (state.catchup === job) state.catchup = null;
    });
    return request;
  }

  private persist(state: Replica, source: TimelineSourceToken): void {
    const rows = state.snapshot.rows.filter(({ provisional }) => !provisional);
    const record: CachedAgentTimeline = {
      schemaVersion: TIMELINE_CACHE_VERSION,
      key: state.snapshot.key,
      revision: state.snapshot.revision,
      lastAuthoritativeSyncAt: this.clock(),
      sourceToken: source,
      range: state.snapshot.range,
      hasOlder: state.snapshot.hasOlder,
      hasNewer: state.snapshot.hasNewer,
      rows,
    };
    void this.storage.putAgent(record).catch(() => {
      if (this.isActive(state, state.generation, source))
        this.fail(state, "cache_error");
    });
  }

  private setDesiredSubscription(
    runtime: TimelineRuntime,
    agentIds: readonly string[],
    sourceToken: TimelineSourceToken | null,
  ): void {
    this.desiredSubscriptions.set(runtime, { agentIds, sourceToken });
    if (this.subscriptionJobs.has(runtime)) return;
    const job = (async () => {
      let failures = 0;
      for (;;) {
        const desired = this.desiredSubscriptions.get(runtime) ?? {
          agentIds: [],
          sourceToken: null,
        };
        const applied = this.appliedSubscriptions.get(runtime);
        if (sameDemand(desired, applied)) return;
        try {
          await runtime.setTimelineSubscription([...desired.agentIds]);
        } catch {
          if (!sameDemand(desired, this.desiredSubscriptions.get(runtime))) {
            failures = 0;
            continue;
          }
          const active = this.current ? this.replica(this.current) : null;
          if (
            active?.runtime === runtime &&
            sameToken(active.snapshot.sourceToken, desired.sourceToken)
          ) {
            active.subscriptionError = true;
            this.fail(active, "sync_error");
          }
          if (++failures === 3) return;
          await Promise.resolve();
          continue;
        }
        if (!sameDemand(desired, this.desiredSubscriptions.get(runtime))) {
          failures = 0;
          continue;
        }
        this.appliedSubscriptions.set(runtime, desired);
        failures = 0;
        const active = this.current ? this.replica(this.current) : null;
        if (active?.runtime === runtime && active.subscriptionError) {
          active.subscriptionError = false;
          if (active.authoritative) {
            active.snapshot = { ...active.snapshot, stale: false, error: null };
            this.publish();
          }
        }
      }
    })();
    this.subscriptionJobs.set(runtime, job);
    void job.finally(() => {
      if (this.subscriptionJobs.get(runtime) === job)
        this.subscriptionJobs.delete(runtime);
    });
  }

  private ensure(key: AgentKey): Replica {
    const id = timelineKey(key);
    const present = this.replicas.get(id);
    if (present) return present;
    const state: Replica = {
      snapshot: emptySnapshot(key),
      runtime: null,
      generation: 0,
      authorityGeneration: 0,
      authoritative: false,
      subscriptionError: false,
      unsubscribe: () => {},
      buffer: null,
      tail: null,
      older: null,
      catchup: null,
    };
    this.replicas.set(id, state);
    return state;
  }

  private replica(key: AgentKey): Replica | undefined {
    return this.replicas.get(timelineKey(key));
  }

  private release(state: Replica): void {
    state.unsubscribe();
    state.unsubscribe = () => {};
    if (state.runtime) {
      this.appliedSubscriptions.delete(state.runtime);
      this.setDesiredSubscription(state.runtime, [], null);
    }
    state.runtime = null;
    state.buffer = null;
    state.snapshot = {
      ...state.snapshot,
      sourceToken: null,
      loading: false,
      olderLoading: false,
      catchingUp: false,
      stale: true,
    };
  }

  private isActive(
    state: Replica,
    generation: number,
    source: TimelineSourceToken,
  ): boolean {
    return (
      state.generation === generation &&
      sameAgentKey(this.current, state.snapshot.key) &&
      sameToken(state.snapshot.sourceToken, source) &&
      state.runtime !== null
    );
  }

  private subscriptionReady(state: Replica): boolean {
    const source = state.snapshot.sourceToken;
    const expected = {
      agentIds: [state.snapshot.key.agentId],
      sourceToken: source,
    };
    return (
      state.runtime !== null &&
      source !== null &&
      sameDemand(this.desiredSubscriptions.get(state.runtime), expected) &&
      sameDemand(this.appliedSubscriptions.get(state.runtime), expected)
    );
  }

  private fail(state: Replica, error: AgentTimelineSnapshot["error"]): void {
    state.snapshot = { ...state.snapshot, stale: true, error };
    this.publish();
  }

  private mutateCurrent(
    change: (snapshot: AgentTimelineSnapshot) => AgentTimelineSnapshot,
  ): void {
    const state = this.current ? this.replica(this.current) : null;
    if (!state) return;
    state.snapshot = change(state.snapshot);
    this.publish();
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) this.notify(listener, snapshot);
  }

  private notify(
    listener: (snapshot: TimelineCoordinatorSnapshot) => void,
    snapshot = this.snapshot(),
  ): void {
    try {
      listener(snapshot);
    } catch {
      // Timeline consumers cannot affect synchronization.
    }
  }
}

function emptySnapshot(key: AgentKey): AgentTimelineSnapshot {
  return {
    key: { ...key },
    rows: [],
    range: null,
    hasOlder: false,
    hasNewer: false,
    loading: false,
    olderLoading: false,
    catchingUp: false,
    stale: true,
    error: null,
    sourceToken: null,
    revision: 0,
    following: true,
    atLatest: true,
    unseenLiveCount: 0,
    duplicateCount: 0,
    gapCount: 0,
  };
}

type ReconcileKind = "tail" | "catchup" | null;
type LiveReduction = {
  snapshot: AgentTimelineSnapshot;
  reconcile: ReconcileKind;
};

function reduceLiveBatch(
  initial: AgentTimelineSnapshot,
  events: readonly PaseoTimelineEvent[],
): LiveReduction {
  let snapshot = initial;
  let reconcile: ReconcileKind = null;
  for (const event of events) {
    const reduced = reduceLive(snapshot, event);
    snapshot = reduced.snapshot;
    if (reduced.reconcile === "tail" || reconcile === null)
      reconcile = reduced.reconcile;
  }
  return { snapshot, reconcile };
}

function reduceLive(
  snapshot: AgentTimelineSnapshot,
  event: PaseoTimelineEvent,
): LiveReduction {
  if (event.agentId !== snapshot.key.agentId)
    return { snapshot, reconcile: null };
  const range = snapshot.range;
  if (
    event.type === "agent.timeline.replacement" ||
    (event.epoch !== undefined && range !== null && event.epoch !== range.epoch)
  )
    return {
      snapshot: {
        ...snapshot,
        stale: true,
        gapCount: snapshot.gapCount + 1,
        error: "reset",
      },
      reconcile: "tail",
    };
  if (event.seq !== undefined && range && event.seq <= range.endSeq)
    return {
      snapshot: { ...snapshot, duplicateCount: snapshot.duplicateCount + 1 },
      reconcile: null,
    };

  let next = snapshot;
  const row = provisionalRow(event.epoch ?? range?.epoch ?? "pending", event);
  if (row) {
    const duplicate = snapshot.rows.some(
      (present) =>
        present.provisional &&
        present.id === row.id &&
        present.seqStart === row.seqStart,
    );
    if (duplicate)
      return {
        snapshot: { ...snapshot, duplicateCount: snapshot.duplicateCount + 1 },
        reconcile: null,
      };
    next = {
      ...snapshot,
      rows: mergeTimelineRows(snapshot.rows, [row]),
      revision: snapshot.revision + 1,
      unseenLiveCount:
        snapshot.following && snapshot.atLatest
          ? 0
          : snapshot.unseenLiveCount + 1,
    };
  }
  if (event.seq === undefined || !range || event.seq > range.endSeq) {
    if (!range || event.seq === undefined || event.seq > range.endSeq + 1)
      next = { ...next, gapCount: next.gapCount + 1 };
    return { snapshot: next, reconcile: range ? "catchup" : "tail" };
  }
  return { snapshot: next, reconcile: null };
}

export function mergeTimelineRows(
  current: readonly TimelineRow[],
  incoming: readonly TimelineRow[],
): TimelineRow[] {
  const rows = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) {
    const present = rows.get(row.id);
    if (!present || present.provisional || row.seqEnd >= present.seqEnd)
      rows.set(row.id, row);
  }
  const authoritative = incoming.filter(({ provisional }) => !provisional);
  for (const [id, row] of rows) {
    if (
      row.provisional &&
      authoritative.some(({ sourceSeqRanges }) =>
        sourceSeqRanges.some(
          ({ startSeq, endSeq }) =>
            row.seqStart >= startSeq && row.seqEnd <= endSeq,
        ),
      )
    )
      rows.delete(id);
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.seqStart - b.seqStart ||
      a.seqEnd - b.seqEnd ||
      a.id.localeCompare(b.id),
  );
}

function requiresReplacement(page: PaseoTimeline, epoch: string): boolean {
  return page.reset || page.staleCursor || page.gap || page.epoch !== epoch;
}

function sameToken(
  a: TimelineSourceToken | null,
  b: TimelineSourceToken | null,
): boolean {
  return (
    a?.serverId === b?.serverId &&
    a?.slotGeneration === b?.slotGeneration &&
    a?.connectionEpoch === b?.connectionEpoch
  );
}

function sameCursor(
  a: { epoch: string; seq: number },
  b: { epoch: string; seq: number },
): boolean {
  return a.epoch === b.epoch && a.seq === b.seq;
}

function sameDemand(
  a: SubscriptionDemand | undefined,
  b: SubscriptionDemand | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    sameToken(a.sourceToken, b.sourceToken) &&
    sameStrings(a.agentIds, b.agentIds)
  );
}

function sameStrings(
  a: readonly string[],
  b: readonly string[] | undefined,
): boolean {
  return (
    !!b &&
    a.length === b.length &&
    a.every((value, index) => value === b[index])
  );
}

function emptyAnchor(anchorRowId: string | null): OlderAnchor {
  return { anchorRowId, prependedRowIds: [] };
}
