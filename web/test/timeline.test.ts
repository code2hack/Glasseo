import assert from "node:assert/strict";
import test from "node:test";
import { FetchAgentTimelineResponseMessageSchema } from "@getpaseo/protocol/messages";
import type { AgentKey } from "../src/directory/types";
import {
  TimelineCoordinator,
  mergeTimelineRows,
} from "../src/timeline/coordinator";
import { timelineAcceptanceStatus } from "../src/timeline/acceptance";
import {
  normalizePage,
  rowId,
  timelineKey,
  validateCachedTimeline,
} from "../src/timeline/normalize";
import {
  MAX_TIMELINE_BYTES,
  MAX_TIMELINE_ROWS,
  boundTimelineCache,
} from "../src/timeline/storage";
import type {
  CachedAgentTimeline,
  PaseoTimeline,
  PaseoTimelineEvent,
  PaseoTimelineOptions,
  TimelineRuntime,
  TimelineStorage,
} from "../src/timeline/types";

test("tail, live catch-up, duplicates, older anchors, and host identity stay canonical", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(
    page("agent", "tail", 3, 4, { hasOlder: true }),
    page("agent", "after", 5, 5, { hasNewer: true }),
    page("agent", "after", 6, 6),
    page("agent", "before", 1, 3, { hasNewer: true }),
  );
  const storage = new MemoryStorage();
  const coordinator = new TimelineCoordinator(storage, () => 123);
  const key = { serverId: "alpha", agentId: "agent" };
  await coordinator.activate(activation(key, runtime));

  assert.deepEqual(runtime.subscriptions[0], ["agent"]);
  assert.deepEqual(coordinator.currentSnapshot()?.range, {
    epoch: "epoch-1",
    startSeq: 3,
    endSeq: 4,
  });
  coordinator.setFollowing(false);
  runtime.emit(stream("agent", 5));
  await settle();
  assert.deepEqual(coordinator.currentSnapshot()?.range, {
    epoch: "epoch-1",
    startSeq: 3,
    endSeq: 6,
  });
  assert.equal(coordinator.currentSnapshot()?.rows.length, 4);
  assert.equal(coordinator.currentSnapshot()?.unseenLiveCount, 1);

  runtime.emit(stream("agent", 6));
  assert.equal(coordinator.currentSnapshot()?.duplicateCount, 1);
  const anchor = await coordinator.loadOlder(key);
  assert.equal(anchor.anchorRowId, rowId("epoch-1", item(3), "turn", 3));
  assert.equal(anchor.prependedRowIds.length, 2);
  assert.equal(coordinator.currentSnapshot()?.rows.length, 6);
  assert.deepEqual(coordinator.currentSnapshot()?.range, {
    epoch: "epoch-1",
    startSeq: 1,
    endSeq: 6,
  });

  const betaRuntime = new FakeRuntime();
  betaRuntime.responses.push(page("agent", "tail", 10, 10));
  await coordinator.activate(
    activation({ serverId: "beta", agentId: "agent" }, betaRuntime),
  );
  assert.equal(coordinator.currentSnapshot()?.rows[0]?.seqStart, 10);
  assert.equal(coordinator.snapshotFor(key)?.rows.length, 6);
  assert.deepEqual(runtime.subscriptions.at(-1), []);
  assert.notEqual(
    timelineKey(key),
    timelineKey({ serverId: "beta", agentId: "agent" }),
  );
});

test("cache is display-only, buffered live wins, and stale completions cannot cross activation", async () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const storage = new MemoryStorage();
  storage.records.set(
    timelineKey(key),
    cache(key, page("agent", "tail", 1, 1)),
  );
  const runtime = new FakeRuntime();
  const tail = deferred<PaseoTimeline>();
  const after = deferred<PaseoTimeline>();
  runtime.impl = (options) =>
    options.direction === "tail" ? tail.promise : after.promise;
  const coordinator = new TimelineCoordinator(storage);
  const activating = coordinator.activate(activation(key, runtime));
  await settle();
  assert.equal(coordinator.currentSnapshot()?.stale, true);
  assert.equal(coordinator.currentSnapshot()?.rows.length, 1);

  runtime.emit(stream("agent", 3));
  tail.resolve(page("agent", "tail", 1, 2));
  await settle();
  assert.equal(coordinator.currentSnapshot()?.rows.at(-1)?.provisional, true);
  assert.equal(
    storage.records.get(timelineKey(key))?.rows.some((row) => row.provisional),
    false,
  );
  after.resolve(page("agent", "after", 3, 3));
  await activating;
  await settle();
  assert.equal(coordinator.currentSnapshot()?.rows.at(-1)?.provisional, false);

  const staleRuntime = new FakeRuntime();
  const staleTail = deferred<PaseoTimeline>();
  staleRuntime.impl = () => staleTail.promise;
  const staleActivation = coordinator.activate(
    activation({ serverId: "stale", agentId: "same" }, staleRuntime),
  );
  await settle();
  const currentRuntime = new FakeRuntime();
  currentRuntime.responses.push(
    page("same", "tail", 8, 8, { epoch: "epoch-current" }),
  );
  await coordinator.activate(
    activation({ serverId: "current", agentId: "same" }, currentRuntime, {
      connectionEpoch: 2,
    }),
  );
  staleTail.resolve(page("same", "tail", 99, 99, { epoch: "epoch-stale" }));
  await staleActivation;
  assert.equal(coordinator.currentSnapshot()?.rows[0]?.seqStart, 8);
});

test("replacement, malformed pages, and subscription order recover without poisoning siblings", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(
    page("one", "tail", 1, 1),
    page("one", "tail", 10, 10, { epoch: "epoch-2" }),
    page("two", "tail", 20, 20, { epoch: "epoch-2" }),
  );
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  const one = { serverId: "alpha", agentId: "one" };
  await coordinator.activate(activation(one, runtime));
  runtime.emit({
    type: "agent.timeline.replacement",
    agentId: "one",
    epoch: "epoch-2",
  });
  await settle();
  assert.equal(coordinator.currentSnapshot()?.range?.epoch, "epoch-2");
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "two" }, runtime),
  );
  assert.deepEqual(runtime.subscriptions, [["one"], [], ["two"]]);
  assert.equal(coordinator.currentSnapshot()?.rows[0]?.seqStart, 20);
  assert.equal(coordinator.snapshotFor(one)?.rows[0]?.seqStart, 10);

  const broken = new FakeRuntime();
  broken.responses.push({ ...page("bad", "tail", 1, 1), agentId: "wrong" });
  await coordinator.activate(
    activation({ serverId: "broken", agentId: "bad" }, broken),
  );
  assert.equal(coordinator.currentSnapshot()?.error, "sync_error");
  assert.equal(coordinator.snapshotFor(one)?.error, null);
});

test("an empty v0.7 timeline window is an authoritative bootstrap", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push({
    ...page("agent", "tail", 1, 1),
    window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
    startCursor: null,
    endCursor: null,
    entries: [],
  });
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  assert.equal(coordinator.currentSnapshot()?.rows.length, 0);
  assert.equal(coordinator.currentSnapshot()?.range, null);
  assert.equal(coordinator.currentSnapshot()?.stale, false);
  assert.equal(coordinator.currentSnapshot()?.error, null);
});

test("a rejected selective subscription retries and cannot be masked by tail success", async () => {
  const runtime = new FakeRuntime();
  runtime.subscriptionFailures = 1;
  runtime.responses.push(page("agent", "tail", 1, 1));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  await settle();
  assert.equal(runtime.subscriptionAttempts, 2);
  assert.deepEqual(runtime.subscriptions, [["agent"]]);
  assert.equal(coordinator.currentSnapshot()?.stale, false);
  assert.equal(coordinator.currentSnapshot()?.error, null);
});

test("older loading cannot hide an exhausted subscription failure", async () => {
  const runtime = new FakeRuntime();
  runtime.subscriptionFailures = 3;
  runtime.responses.push(page("agent", "tail", 1, 1, { hasOlder: true }));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  await settle();
  assert.equal(coordinator.currentSnapshot()?.error, "sync_error");
  const older = deferred<PaseoTimeline>();
  runtime.impl = () => older.promise;
  const loading = coordinator.loadOlder();
  assert.equal(coordinator.currentSnapshot()?.olderLoading, true);
  assert.equal(coordinator.currentSnapshot()?.error, "sync_error");
  older.resolve({
    ...page("agent", "before", 1, 1),
    window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
    startCursor: null,
    endCursor: null,
    entries: [],
  });
  await loading;
  assert.equal(coordinator.currentSnapshot()?.error, "sync_error");
});

test("a new source token for the same Agent fences its unresolved tail", async () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const staleRuntime = new FakeRuntime();
  const staleTail = deferred<PaseoTimeline>();
  staleRuntime.impl = () => staleTail.promise;
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  const staleActivation = coordinator.activate(activation(key, staleRuntime));
  await settle();

  const currentRuntime = new FakeRuntime();
  currentRuntime.responses.push(
    page("agent", "tail", 7, 7, { epoch: "epoch-current" }),
  );
  await coordinator.activate(
    activation(key, currentRuntime, { connectionEpoch: 2 }),
  );
  staleTail.resolve(page("agent", "tail", 99, 99, { epoch: "epoch-stale" }));
  await staleActivation;

  assert.equal(coordinator.currentSnapshot()?.range?.epoch, "epoch-current");
  assert.equal(coordinator.currentSnapshot()?.rows[0]?.seqStart, 7);
  assert.deepEqual(staleRuntime.subscriptions.at(-1), []);
});

test("tail refresh fences old catch-up and reconciles live events buffered during refresh", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(page("agent", "tail", 1, 1));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  const key = { serverId: "alpha", agentId: "agent" };
  await coordinator.activate(activation(key, runtime));

  const staleAfter = deferred<PaseoTimeline>();
  const refreshedTail = deferred<PaseoTimeline>();
  runtime.impl = (options) =>
    options.direction === "after" ? staleAfter.promise : refreshedTail.promise;
  runtime.emit(stream("agent", 2));
  const refreshing = coordinator.refresh();
  refreshedTail.resolve(page("agent", "tail", 1, 3));
  await refreshing;
  staleAfter.resolve(page("agent", "after", 2, 2));
  await settle();
  assert.equal(coordinator.currentSnapshot()?.range?.endSeq, 3);

  const liveTail = deferred<PaseoTimeline>();
  const published: number[][] = [];
  coordinator.subscribe(({ replicas }) => {
    published.push(
      (replicas.get(timelineKey(key))?.rows ?? [])
        .filter(({ provisional }) => provisional)
        .map(({ seqStart }) => seqStart),
    );
  });
  runtime.impl = (options) =>
    options.direction === "after"
      ? Promise.resolve(page("agent", "after", 4, 5))
      : liveTail.promise;
  const liveRefresh = coordinator.refresh();
  runtime.emit(stream("agent", 4));
  runtime.emit(stream("agent", 5));
  liveTail.resolve(page("agent", "tail", 1, 3));
  await liveRefresh;
  await settle();
  assert.equal(coordinator.currentSnapshot()?.range?.endSeq, 5);
  assert.equal(coordinator.currentSnapshot()?.rows.at(-1)?.provisional, false);
  assert.equal(
    published.some((seqs) => seqs.includes(4) && !seqs.includes(5)),
    false,
  );
});

test("a failed tail keeps buffered live rows visible and reports a recoverable error", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(page("agent", "tail", 1, 1));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  const tail = deferred<PaseoTimeline>();
  runtime.impl = () => tail.promise;
  const refresh = coordinator.refresh();
  runtime.emit(stream("agent", 2));
  tail.reject(new Error("fixture failure"));
  await refresh;
  assert.equal(coordinator.currentSnapshot()?.rows.at(-1)?.seqStart, 2);
  assert.equal(coordinator.currentSnapshot()?.rows.at(-1)?.provisional, true);
  assert.equal(coordinator.currentSnapshot()?.error, "sync_error");
});

test("cache validation and explicit row/byte bounds preserve only certified rows", () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const source = cache(key, page("agent", "tail", 1, MAX_TIMELINE_ROWS + 5));
  const bounded = boundTimelineCache(source);
  assert.equal(bounded.rows.length, MAX_TIMELINE_ROWS);
  assert.equal(bounded.hasOlder, true);
  assert.equal(bounded.range?.startSeq, 6);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(bounded)).byteLength <=
      MAX_TIMELINE_BYTES,
  );
  assert.equal(validateCachedTimeline(bounded, key), bounded);
  assert.throws(() =>
    validateCachedTimeline(
      { ...bounded, rows: [{ ...bounded.rows[0], provisional: true }] },
      key,
    ),
  );
  assert.notEqual(
    rowId("epoch", { type: "reasoning", text: "same" }, "turn", 1),
    rowId("epoch", { type: "reasoning", text: "same" }, "turn", 2),
  );

  const disjoint = boundTimelineCache({
    ...source,
    range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
    rows: [
      {
        ...source.rows[0]!,
        item: {
          ...item(1),
          text: "x".repeat(MAX_TIMELINE_BYTES),
        },
      },
      {
        ...source.rows[1]!,
        seqStart: 2,
        seqEnd: 4,
        sourceSeqRanges: [
          { startSeq: 2, endSeq: 2 },
          { startSeq: 4, endSeq: 4 },
        ],
      },
    ],
  });
  assert.equal(disjoint.range, null);
  assert.equal(disjoint.rows.length, 0);
});

test("projected envelopes cannot erase uncovered live rows or certify source gaps", () => {
  const live = {
    ...cache(
      { serverId: "alpha", agentId: "agent" },
      page("agent", "tail", 3, 3),
    ).rows[0]!,
    provisional: true,
  };
  const collapsed = {
    ...live,
    id: "tool:call-1",
    item: {
      type: "tool_call" as const,
      callId: "call-1",
      name: "fixture",
      detail: { type: "plain_text" as const, text: "redacted" },
      status: "completed" as const,
      error: null,
    },
    seqStart: 2,
    seqEnd: 4,
    sourceSeqRanges: [
      { startSeq: 2, endSeq: 2 },
      { startSeq: 4, endSeq: 4 },
    ],
    collapsed: ["tool_lifecycle" as const],
    provisional: false,
  };
  assert.equal(mergeTimelineRows([live], [collapsed]).length, 2);
  assert.throws(() =>
    normalizePage(
      { serverId: "alpha", agentId: "agent" },
      { ...page("agent", "after", 2, 4), entries: [collapsed] },
    ),
  );
  assert.throws(() =>
    normalizePage(
      { serverId: "alpha", agentId: "agent" },
      { ...page("agent", "tail", 1, 1), error: "fixture error" },
    ),
  );
  const outsideWindow = page("agent", "tail", 1, 2);
  assert.throws(() =>
    normalizePage(
      { serverId: "alpha", agentId: "agent" },
      {
        ...outsideWindow,
        window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
      },
    ),
  );
});

test("acceptance status hashes identities and never returns timeline content", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(page("agent", "tail", 1, 1));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  const status = timelineAcceptanceStatus(coordinator);
  assert.equal(status.rowCount, 1);
  assert.equal(status.range?.endSeq, 1);
  assert.equal(JSON.stringify(status).includes("text-1"), false);
  assert.equal(status.keyHash?.length, 8);
  assert.equal(status.subscriptionTargetHash, status.keyHash);
});

class FakeRuntime implements TimelineRuntime {
  readonly listeners = new Set<(event: PaseoTimelineEvent) => void>();
  readonly subscriptions: string[][] = [];
  readonly requests: PaseoTimelineOptions[] = [];
  readonly responses: PaseoTimeline[] = [];
  subscriptionFailures = 0;
  subscriptionAttempts = 0;
  impl: ((options: PaseoTimelineOptions) => Promise<PaseoTimeline>) | null =
    null;

  async getTimeline(
    _agentId: string,
    options: PaseoTimelineOptions = {},
  ): Promise<PaseoTimeline> {
    this.requests.push(options);
    if (this.impl) return this.impl(options);
    const response = this.responses.shift();
    if (!response) throw new Error("Missing timeline fixture response");
    return response;
  }

  async setTimelineSubscription(agentIds: string[]): Promise<void> {
    this.subscriptionAttempts++;
    if (this.subscriptionFailures-- > 0)
      throw new Error("Fixture subscription failure");
    this.subscriptions.push(agentIds);
  }

  subscribeTimeline(listener: (event: PaseoTimelineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: PaseoTimelineEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class MemoryStorage implements TimelineStorage {
  readonly records = new Map<string, CachedAgentTimeline>();

  async loadAgent(key: AgentKey): Promise<unknown | null> {
    return this.records.get(timelineKey(key)) ?? null;
  }
  async putAgent(record: CachedAgentTimeline): Promise<void> {
    const key = timelineKey(record.key);
    const present = this.records.get(key);
    if (!present || present.revision < record.revision)
      this.records.set(key, record);
  }
  async deleteAgent(key: AgentKey): Promise<void> {
    this.records.delete(timelineKey(key));
  }
  async deleteHost(serverId: string): Promise<void> {
    for (const [key, record] of this.records)
      if (record.key.serverId === serverId) this.records.delete(key);
  }
}

function activation(
  key: AgentKey,
  runtime: TimelineRuntime,
  source: Partial<{ slotGeneration: number; connectionEpoch: number }> = {},
) {
  return {
    key,
    runtime,
    sourceToken: {
      serverId: key.serverId,
      slotGeneration: source.slotGeneration ?? 1,
      connectionEpoch: source.connectionEpoch ?? 1,
    },
  };
}

function stream(agentId: string, seq?: number): PaseoTimelineEvent {
  return {
    type: "agent_stream",
    agentId,
    event: {
      type: "timeline",
      provider: "codex",
      turnId: "turn",
      item: item(seq ?? 99),
    },
    timestamp: "2026-09-03T00:00:00Z",
    ...(seq === undefined ? {} : { seq, epoch: "epoch-1" }),
  };
}

function item(seq: number) {
  return {
    type: "assistant_message" as const,
    text: `text-${seq}`,
    messageId: `message-${seq}`,
  };
}

function page(
  agentId: string,
  direction: "tail" | "before" | "after",
  start: number,
  end: number,
  options: Partial<{
    epoch: string;
    hasOlder: boolean;
    hasNewer: boolean;
  }> = {},
): PaseoTimeline {
  const epoch = options.epoch ?? "epoch-1";
  return FetchAgentTimelineResponseMessageSchema.parse({
    type: "fetch_agent_timeline_response",
    payload: {
      requestId: `request-${direction}-${start}`,
      agentId,
      agent: null,
      direction,
      projection: "projected",
      epoch,
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: end, nextSeq: end + 1 },
      startCursor: { epoch, seq: start },
      endCursor: { epoch, seq: end },
      hasOlder: options.hasOlder ?? false,
      hasNewer: options.hasNewer ?? false,
      entries: Array.from({ length: end - start + 1 }, (_, offset) => {
        const seq = start + offset;
        return {
          provider: "codex",
          item: item(seq),
          turnId: "turn",
          timestamp: "2026-09-03T00:00:00Z",
          seqStart: seq,
          seqEnd: seq,
          sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
          collapsed: [],
        };
      }),
      error: null,
    },
  }).payload;
}

function cache(key: AgentKey, source: PaseoTimeline): CachedAgentTimeline {
  return {
    schemaVersion: 1,
    key,
    revision: 1,
    lastAuthoritativeSyncAt: 1,
    sourceToken: {
      serverId: key.serverId,
      slotGeneration: 1,
      connectionEpoch: 1,
    },
    range:
      source.startCursor && source.endCursor
        ? {
            epoch: source.epoch,
            startSeq: source.startCursor.seq,
            endSeq: source.endCursor.seq,
          }
        : null,
    hasOlder: source.hasOlder,
    hasNewer: source.hasNewer,
    rows: source.entries.map((entry) => ({
      ...entry,
      id: rowId(source.epoch, entry.item, entry.turnId, entry.seqStart),
      provisional: false,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let count = 0; count < 5; count++)
    await new Promise((resolve) => setImmediate(resolve));
}
