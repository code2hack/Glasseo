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
  private hydratingGeneration: number | null = null;
  private blockedGeneration: number | null = null;
  private pendingActions: DraftAction[] = [];
  private readonly dirtyRecords = new Set<string>();
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
    this.blockedGeneration = null;
    this.pendingActions = [];
    const id = draftKey(key);
    const cached = this.records.get(id);
    const session = createDraftSession(
      cached ?? createDraftRecord(key, this.clock()),
      requestIds,
    );
    const needsPersist =
      !!cached &&
      (session.record.revision !== cached.revision ||
        this.dirtyRecords.has(id));
    this.state = {
      current: { ...key },
      session,
      storageStatus: cached && !needsPersist ? "ready" : "loading",
    };
    this.publish();
    if (cached) {
      this.records.set(id, session.record);
      if (needsPersist)
        await this.persist(
          { ...session.record, updatedAt: this.clock() },
          generation,
        );
      return;
    }
    this.hydratingGeneration = generation;
    let value: unknown | null;
    try {
      value = await this.storage.loadAgent(key);
    } catch {
      if (!this.isCurrent(key, generation)) return;
      this.pendingActions = [];
      this.hydratingGeneration = null;
      this.blockedGeneration = generation;
      this.state = { ...this.state, storageStatus: "error" };
      this.publish();
      return;
    }
    if (!this.isCurrent(key, generation)) return;
    const currentSession = this.state.session!;
    let record: DraftRecord;
    try {
      record =
        value === null
          ? createDraftRecord(key, this.clock())
          : validateDraftRecord(value, key);
    } catch {
      await this.replaceCorrupt(currentSession, generation);
      return;
    }
    let restored = createDraftSession(record, requestIds);
    try {
      for (const action of this.pendingActions)
        restored = reduceDraft(restored, action).state;
    } catch {
      this.pendingActions = [];
      this.hydratingGeneration = null;
      this.blockedGeneration = generation;
      this.records.set(id, record);
      this.dirtyRecords.delete(id);
      this.state = {
        current: { ...key },
        session: {
          record,
          requestIds: currentSession.requestIds,
          transient: currentSession.transient,
          handledInteractionIds: currentSession.handledInteractionIds,
        },
        storageStatus: "error",
      };
      this.publish();
      return;
    }
    restored = {
      ...restored,
      transient: currentSession.transient,
    };
    this.pendingActions = [];
    this.hydratingGeneration = null;
    const changed = restored.record.revision !== record.revision;
    const restoredRecord = changed
      ? { ...restored.record, updatedAt: this.clock() }
      : restored.record;
    restored = { ...restored, record: restoredRecord };
    this.records.set(id, restoredRecord);
    this.dirtyRecords.delete(id);
    this.state = {
      current: { ...key },
      session: restored,
      storageStatus: changed ? "loading" : "ready",
    };
    this.publish();
    if (changed) await this.persist(restoredRecord, generation);
  }

  deactivate(): void {
    this.generation++;
    this.hydratingGeneration = null;
    this.blockedGeneration = null;
    this.pendingActions = [];
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
    return this.transition({ type: "replace-text", text }).then(() => {});
  }

  setTextCursor(textOffset: number): Promise<void> {
    if (!Number.isSafeInteger(textOffset))
      return Promise.reject(new Error("Invalid Draft text cursor"));
    return this.transition({ type: "set-text-cursor", textOffset }).then(
      () => {},
    );
  }

  appendImageRefs(images: readonly DraftImageRef[]): Promise<void> {
    return this.transition({
      type: "append-images",
      images,
    }).then(() => {});
  }

  removeImageRefs(imageIds: readonly string[]): Promise<void> {
    return this.transition({
      type: "remove-images",
      imageIds,
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
      await this.storage.deleteHost(serverId, stillRemoved);
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
    this.hydratingGeneration = null;
    this.blockedGeneration = null;
    this.pendingActions = [];
    this.records.clear();
    this.dirtyRecords.clear();
    this.listeners.clear();
    this.state = { current: null, session: null, storageStatus: "ready" };
  }

  private async transition(action: DraftAction) {
    const session = this.requireSession();
    const result = reduceDraft(session, action);
    if (this.hydratingGeneration === this.generation) {
      this.pendingActions.push(action);
      if (result.state !== session) {
        this.state = { ...this.state, session: result.state };
        this.publish();
      }
      return result;
    }
    if (this.blockedGeneration === this.generation) {
      if (result.state !== session) {
        this.state = { ...this.state, session: result.state };
        this.publish();
      }
      return result;
    }
    if (result.state !== session) {
      const record =
        result.effect === "persist"
          ? { ...result.state.record, updatedAt: this.clock() }
          : result.state.record;
      this.state = { ...this.state, session: { ...result.state, record } };
      if (result.effect === "persist")
        this.state = { ...this.state, storageStatus: "loading" };
      this.records.set(draftKey(record.key), record);
      this.publish();
      if (result.effect === "persist")
        await this.persist(record, this.generation);
    }
    return result;
  }

  private async persist(
    record: DraftRecord,
    generation: number,
  ): Promise<boolean> {
    try {
      const written = await this.storage.putAgent(record);
      const id = draftKey(record.key);
      if (written && this.records.get(id)?.revision === record.revision)
        this.dirtyRecords.delete(id);
      if (
        this.isCurrent(record.key, generation) &&
        this.state.session?.record.revision === record.revision
      ) {
        if (!written && this.records.get(id)?.revision === record.revision) {
          this.records.delete(id);
          this.dirtyRecords.delete(id);
        }
        if (!written) this.blockedGeneration = generation;
        this.state = {
          ...this.state,
          storageStatus: written ? "ready" : "error",
        };
        this.publish();
      }
      return written;
    } catch {
      if (this.records.get(draftKey(record.key))?.revision === record.revision)
        this.dirtyRecords.add(draftKey(record.key));
      if (
        this.isCurrent(record.key, generation) &&
        this.state.session?.record.revision === record.revision
      ) {
        this.state = { ...this.state, storageStatus: "error" };
        this.publish();
      }
      return false;
    }
  }

  private async replaceCorrupt(
    replacement: DraftSessionState,
    generation: number,
  ): Promise<void> {
    const record = replacement.record;
    const id = draftKey(record.key);
    this.pendingActions = [];
    let written = false;
    try {
      written = await this.storage.putAgent(record);
    } catch {
      // A later activation reloads and retries the corrupt row.
    }
    if (!this.isCurrent(record.key, generation)) return;
    const currentSession = this.state.session!;
    const pendingActions = this.pendingActions;
    this.pendingActions = [];
    this.hydratingGeneration = null;
    if (!written) {
      this.blockedGeneration = generation;
      this.state = { ...this.state, storageStatus: "error" };
      this.publish();
      return;
    }
    this.records.set(id, record);
    this.dirtyRecords.delete(id);
    let restored = replacement;
    try {
      for (const action of pendingActions)
        restored = reduceDraft(restored, action).state;
    } catch {
      this.blockedGeneration = generation;
      this.state = {
        ...this.state,
        session: {
          ...replacement,
          requestIds: currentSession.requestIds,
          transient: currentSession.transient,
          handledInteractionIds: currentSession.handledInteractionIds,
        },
        storageStatus: "error",
      };
      this.publish();
      return;
    }
    restored = { ...restored, transient: currentSession.transient };
    const changed = restored.record.revision !== record.revision;
    const restoredRecord = changed
      ? { ...restored.record, updatedAt: this.clock() }
      : restored.record;
    this.records.set(id, restoredRecord);
    this.state = {
      ...this.state,
      session: { ...restored, record: restoredRecord },
      storageStatus: changed ? "loading" : "ready",
    };
    this.publish();
    if (changed) await this.persist(restoredRecord, generation);
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
