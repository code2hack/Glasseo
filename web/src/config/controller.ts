import type { DirectoryCoordinator } from "../directory/coordinator";
import type {
  AgentKey,
  GlobalAgentDirectorySnapshot,
} from "../directory/types";
import type { SemanticInput } from "../native/semanticInput";
import {
  reduceConfig,
  initialConfigState,
  reprojectConfigState,
  restoreConfigState,
} from "./reducer";
import { validateStoredConfigUi } from "./storage";
import {
  CONFIG_UI_VERSION,
  type ConfigActionResult,
  type ConfigRowAction,
  type ConfigSectionProvider,
  type ConfigSectionRows,
  type ConfigState,
  type ConfigStorage,
} from "./types";

export type ConfigDirectorySource = Pick<
  DirectoryCoordinator,
  "snapshot" | "subscribe"
>;

export class ConfigController {
  private stateValue: ConfigState;
  private directoryValue: GlobalAgentDirectorySnapshot;
  private readonly listeners = new Set<(state: ConfigState) => void>();
  private readonly unsubscribeDirectory: () => void;
  private readonly unsubscribeSections: readonly (() => void)[];
  private write: Promise<void> = Promise.resolve();
  private mutation = 0;
  private lastUpdatedAt = 0;
  private pendingRestore: ReturnType<typeof validateStoredConfigUi> | null =
    null;
  private activatedAgent: AgentKey | null = null;
  private actionGeneration = 0;
  private disposed = false;

  constructor(
    private readonly directory: ConfigDirectorySource,
    private readonly storage: ConfigStorage,
    private readonly activateAgent: (key: {
      serverId: string;
      agentId: string;
    }) => boolean,
    private readonly clock: () => number = Date.now,
    private readonly sections: readonly ConfigSectionProvider[] = [],
  ) {
    this.directoryValue = directory.snapshot();
    this.stateValue = initialConfigState(
      this.directoryValue,
      this.sectionRows(),
    );
    this.unsubscribeDirectory = directory.subscribe((snapshot) => {
      this.directoryValue = snapshot;
      const revision = this.stateValue.revision;
      if (this.pendingRestore && !snapshot.restoring) {
        const stored = this.pendingRestore;
        this.pendingRestore = null;
        this.stateValue = restoreConfigState(
          this.stateValue,
          snapshot,
          stored.expandedRowIds,
          stored.focusedRowId,
          stored.revision,
          this.sectionRows(),
        );
      } else {
        this.stateValue = reprojectConfigState(
          this.stateValue,
          snapshot,
          this.sectionRows(),
        );
      }
      if (this.stateValue.revision !== revision) {
        this.mutation++;
        this.persist();
      }
      this.publish();
    });
    this.unsubscribeSections = sections.map((section) =>
      section.subscribe(() => this.reproject()),
    );
  }

  snapshot(): ConfigState {
    return this.stateValue;
  }

  lastActivatedAgent(): AgentKey | null {
    return this.activatedAgent ? { ...this.activatedAgent } : null;
  }

  sectionDiagnostics(): Readonly<Record<string, unknown>> {
    return Object.assign(
      {},
      ...this.sections.map((section) => section.diagnostics?.() ?? {}),
    );
  }

  subscribe(listener: (state: ConfigState) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => this.listeners.delete(listener);
  }

  async restore(): Promise<void> {
    const mutation = this.mutation;
    try {
      const raw = await this.storage.load();
      if (raw === null || mutation !== this.mutation) return;
      const stored = validateStoredConfigUi(raw);
      this.lastUpdatedAt = stored.updatedAt;
      if (this.directoryValue.restoring) {
        this.pendingRestore = stored;
        return;
      }
      this.stateValue = restoreConfigState(
        this.stateValue,
        this.directoryValue,
        stored.expandedRowIds,
        stored.focusedRowId,
        stored.revision,
        this.sectionRows(),
      );
      this.publish();
    } catch {
      // Corrupt presentation state cannot block Config.
    }
  }

  handle(input: SemanticInput): boolean {
    const transition = reduceConfig(
      this.stateValue,
      this.directoryValue,
      input,
      this.sectionRows(),
    );
    if (transition.state === this.stateValue) return false;
    const revision = this.stateValue.revision;
    this.stateValue = transition.state;
    this.mutation++;
    this.pendingRestore = null;
    if (transition.activate && this.activateAgent(transition.activate))
      this.activatedAgent = { ...transition.activate };
    if (transition.action) this.activateSection(transition.action, input);
    if (this.stateValue.revision !== revision) this.persist();
    this.publish();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.actionGeneration++;
    this.unsubscribeDirectory();
    this.unsubscribeSections.forEach((unsubscribe) => unsubscribe());
    this.sections.forEach((section) => section.dispose?.());
    this.listeners.clear();
  }

  deactivate(): void {
    this.actionGeneration++;
    this.sections.forEach((section) => section.deactivate?.());
  }

  private sectionRows(): ConfigSectionRows {
    return new Map(
      this.sections.map((section) => [
        section.sectionId,
        section.rows(this.stateValue?.expandedRowIds ?? new Set()),
      ]),
    );
  }

  private reproject(): void {
    if (this.disposed) return;
    const previous = this.stateValue;
    this.stateValue = reprojectConfigState(
      previous,
      this.directoryValue,
      this.sectionRows(),
    );
    if (this.stateValue !== previous) this.publish();
  }

  private activateSection(action: ConfigRowAction, input: SemanticInput): void {
    const section = this.sections.find(
      (candidate) => candidate.sectionId === action.sectionId,
    );
    if (!section) return;
    const generation = ++this.actionGeneration;
    void Promise.resolve(section.activate(action, input.interactionId))
      .then((result) => {
        if (!result || this.disposed || generation !== this.actionGeneration)
          return;
        this.applyActionResult(result);
      })
      .catch(() => {});
  }

  private applyActionResult(result: Exclude<ConfigActionResult, void>): void {
    const expanded = new Set(this.stateValue.expandedRowIds);
    result.expandRowIds?.forEach((id) => expanded.add(id));
    this.stateValue = restoreConfigState(
      this.stateValue,
      this.directoryValue,
      [...expanded],
      result.focusRowId ?? this.stateValue.focusedRowId,
      this.stateValue.revision + 1,
      this.sectionRows(),
    );
    this.mutation++;
    this.persist();
    this.publish();
  }

  private persist(): void {
    this.lastUpdatedAt = Math.max(this.lastUpdatedAt + 1, this.clock());
    const value = {
      schemaVersion: CONFIG_UI_VERSION,
      revision: this.stateValue.revision,
      updatedAt: this.lastUpdatedAt,
      expandedRowIds: [...this.stateValue.expandedRowIds],
      focusedRowId: this.stateValue.focusedRowId,
    } as const;
    this.write = this.write
      .catch(() => undefined)
      .then(() => this.storage.put(value));
    void this.write.catch(() => undefined);
  }

  private publish(): void {
    for (const listener of this.listeners) this.notify(listener);
  }

  private notify(listener: (state: ConfigState) => void): void {
    try {
      listener(this.stateValue);
    } catch {
      // UI observers cannot affect Config state.
    }
  }
}
