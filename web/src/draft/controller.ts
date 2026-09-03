import { sameAgentKey } from "../directory/normalize";
import type { AgentKey } from "../directory/types";
import type { SemanticInput } from "../native/semanticInput";
import {
  createDraftRecord,
  createDraftSession,
  defaultDraftTransientState,
  reduceDraft,
  validateDraftRecord,
} from "./model";
import { draftKey } from "./storage";
import type {
  DraftAction,
  DraftImageRef,
  DraftRecord,
  DraftSessionState,
  DraftSnapshot,
  DraftStorage,
} from "./types";

export class DraftController {
  private readonly records = new Map<string, DraftRecord>();
  private readonly listeners = new Set<(snapshot: DraftSnapshot) => void>();
  private state: DraftSnapshot = {
    current: null,
    session: null,
    storageStatus: "ready",
  };
  private generation = 0;
  private cleanup = Promise.resolve();

  constructor(
    private readonly storage: DraftStorage,
    private readonly clock: () => number = Date.now,
  ) {}

  snapshot(): DraftSnapshot {
    return this.state;
  }

  subscribe(listener: (snapshot: DraftSnapshot) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => this.listeners.delete(listener);
  }

  async activate(
    key: AgentKey,
    requestIds: readonly string[] = [],
  ): Promise<void> {
    const generation = ++this.generation;
    const cached = this.records.get(draftKey(key));
    const session = createDraftSession(
      cached ?? createDraftRecord(key, this.clock()),
      requestIds,
    );
    this.state = {
      current: { ...key },
      session,
      storageStatus: cached ? "ready" : "loading",
    };
    const activationRevision = session.record.revision;
    this.publish();
    if (cached) {
      this.records.set(draftKey(key), session.record);
      if (session.record.revision !== cached.revision)
        await this.persist(
          { ...session.record, updatedAt: this.clock() },
          generation,
        );
      return;
    }
    let loaded = false;
    try {
      const value = await this.storage.loadAgent(key);
      loaded = true;
      if (
        !this.isCurrent(key, generation) ||
        this.state.session?.record.revision !== activationRevision
      )
        return;
      const currentSession = this.state.session;
      const record =
        value === null
          ? createDraftRecord(key, this.clock())
          : validateDraftRecord(value, key);
      const restoredRecord = createDraftSession(
        record,
        currentSession.requestIds,
      );
      const restored = {
        ...restoredRecord,
        transient: currentSession.transient,
        handledInteractionIds: currentSession.handledInteractionIds,
      };
      this.records.set(draftKey(key), restored.record);
      this.state = {
        current: { ...key },
        session: restored,
        storageStatus: "ready",
      };
      this.publish();
      if (restored.record.revision !== record.revision)
        await this.persist(restored.record, generation);
    } catch {
      if (!this.isCurrent(key, generation)) return;
      const record = createDraftRecord(key, this.clock());
      this.records.set(draftKey(key), record);
      this.state = {
        current: { ...key },
        session: createDraftSession(record, requestIds),
        storageStatus: "error",
      };
      this.publish();
      if (loaded)
        try {
          await this.storage.deleteAgent(key);
          await this.storage.putAgent(record);
        } catch {
          // The blank in-memory Draft remains usable and a later mutation retries storage.
        }
    }
  }

  deactivate(): void {
    this.generation++;
    this.state = { current: null, session: null, storageStatus: "ready" };
    this.publish();
  }

  handle(input: SemanticInput): Promise<boolean> {
    const transition = this.transition(input);
    return transition.then(({ handled }) => handled);
  }

  cycleArea(direction: "left" | "right"): Promise<void> {
    return this.transition({ type: "cycle-area", direction }).then(() => {});
  }

  moveWithinArea(direction: "up" | "down"): Promise<void> {
    return this.transition({ type: "move-within-area", direction }).then(
      () => {},
    );
  }

  setRequestDescriptors(requestIds: readonly string[]): Promise<void> {
    return this.transition({ type: "set-requests", requestIds }).then(() => {});
  }

  replaceText(text: string): Promise<void> {
    if (typeof text !== "string")
      return Promise.reject(new Error("Invalid Draft text"));
    return this.mutateRecord((record) => ({ ...record, text }));
  }

  setTextCursor(textOffset: number): Promise<void> {
    return this.mutateRecord((record) => ({
      ...record,
      cursors: { ...record.cursors, textOffset },
    }));
  }

  appendImageRefs(images: readonly DraftImageRef[]): Promise<void> {
    const present = this.requireSession().record.images;
    return this.transition({
      type: "set-images",
      images: [...present, ...images],
    }).then(() => {});
  }

  removeImageRefs(imageIds: readonly string[]): Promise<void> {
    const removed = new Set(imageIds);
    const present = this.requireSession().record.images;
    return this.transition({
      type: "set-images",
      images: present.filter(({ id }) => !removed.has(id)),
    }).then(() => {});
  }

  resetTransientState(): void {
    const session = this.state.session;
    if (!session) return;
    this.state = {
      ...this.state,
      session: { ...session, transient: defaultDraftTransientState() },
    };
    this.publish();
  }

  deleteAgent(
    key: AgentKey,
    stillRemoved: () => boolean = () => true,
  ): Promise<void> {
    return this.clean(async () => {
      const id = draftKey(key);
      const backup = await this.backupAgent(key);
      if (!stillRemoved()) return;
      await this.storage.deleteAgent(key);
      if (!stillRemoved()) {
        const restore = this.records.get(id) ?? backup;
        if (restore) await this.storage.putAgent(restore);
        return;
      }
      this.records.delete(id);
      if (sameAgentKey(this.state.current, key)) this.deactivate();
    });
  }

  deleteHost(
    serverId: string,
    stillRemoved: () => boolean = () => true,
  ): Promise<void> {
    return this.clean(async () => {
      const backups = await this.backupHost(serverId);
      if (!stillRemoved()) return;
      await this.storage.deleteHost(serverId);
      if (!stillRemoved()) {
        for (const record of this.currentHostRecords(serverId, backups))
          await this.storage.putAgent(record);
        return;
      }
      for (const [id, record] of this.records)
        if (record.key.serverId === serverId) this.records.delete(id);
      if (this.state.current?.serverId === serverId) this.deactivate();
    });
  }

  dispose(): void {
    this.generation++;
    this.records.clear();
    this.listeners.clear();
    this.state = { current: null, session: null, storageStatus: "ready" };
  }

  private async transition(action: DraftAction) {
    const session = this.requireSession();
    const result = reduceDraft(session, action);
    if (result.state !== session) {
      const record =
        result.effect === "persist"
          ? { ...result.state.record, updatedAt: this.clock() }
          : result.state.record;
      this.state = { ...this.state, session: { ...result.state, record } };
      this.records.set(draftKey(record.key), record);
      this.publish();
      if (result.effect === "persist")
        await this.persist(record, this.generation);
    }
    return result;
  }

  private mutateRecord(
    change: (record: DraftRecord) => DraftRecord,
  ): Promise<void> {
    const session = this.requireSession();
    const changed = validateDraftRecord(
      change(session.record),
      session.record.key,
    );
    if (
      changed.text === session.record.text &&
      changed.cursors.textOffset === session.record.cursors.textOffset
    )
      return Promise.resolve();
    const record = {
      ...changed,
      revision: session.record.revision + 1,
      updatedAt: this.clock(),
    };
    this.state = { ...this.state, session: { ...session, record } };
    this.records.set(draftKey(record.key), record);
    this.publish();
    return this.persist(record, this.generation);
  }

  private async persist(
    record: DraftRecord,
    generation: number,
  ): Promise<void> {
    try {
      await this.storage.putAgent(record);
      if (this.isCurrent(record.key, generation)) {
        this.state = { ...this.state, storageStatus: "ready" };
        this.publish();
      }
    } catch {
      if (this.isCurrent(record.key, generation)) {
        this.state = { ...this.state, storageStatus: "error" };
        this.publish();
      }
    }
  }

  private requireSession(): DraftSessionState {
    if (!this.state.session) throw new Error("No active Draft");
    return this.state.session;
  }

  private isCurrent(key: AgentKey, generation: number): boolean {
    return (
      generation === this.generation && sameAgentKey(this.state.current, key)
    );
  }

  private async backupAgent(key: AgentKey): Promise<DraftRecord | null> {
    const cached = this.records.get(draftKey(key));
    if (cached) return cached;
    try {
      const value = await this.storage.loadAgent(key);
      return value === null ? null : validateDraftRecord(value, key);
    } catch {
      return null;
    }
  }

  private clean(job: () => Promise<void>): Promise<void> {
    const next = this.cleanup.then(job, job);
    this.cleanup = next.catch(() => {});
    return next;
  }

  private async backupHost(serverId: string): Promise<DraftRecord[]> {
    try {
      return (await this.storage.loadHost(serverId)).flatMap((value) => {
        const candidate = value as { key?: AgentKey };
        if (!candidate?.key) return [];
        try {
          return [validateDraftRecord(value, candidate.key)];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  private currentHostRecords(
    serverId: string,
    backups: readonly DraftRecord[],
  ): readonly DraftRecord[] {
    const records = new Map(
      backups.map((record) => [draftKey(record.key), record]),
    );
    for (const record of this.records.values())
      if (record.key.serverId === serverId)
        records.set(draftKey(record.key), record);
    return [...records.values()];
  }

  private publish(): void {
    for (const listener of this.listeners) this.notify(listener);
  }

  private notify(listener: (snapshot: DraftSnapshot) => void): void {
    try {
      listener(this.state);
    } catch {
      // Observers cannot affect Draft state.
    }
  }
}
