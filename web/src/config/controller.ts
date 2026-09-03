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
  private write: Promise<void> = Promise.resolve();
  private mutation = 0;
  private lastUpdatedAt = 0;
  private pendingRestore: ReturnType<typeof validateStoredConfigUi> | null =
    null;
  private activatedAgent: AgentKey | null = null;

  constructor(
    private readonly directory: ConfigDirectorySource,
    private readonly storage: ConfigStorage,
    private readonly activateAgent: (key: {
      serverId: string;
      agentId: string;
    }) => boolean,
    private readonly clock: () => number = Date.now,
  ) {
    this.directoryValue = directory.snapshot();
    this.stateValue = initialConfigState(this.directoryValue);
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
        );
      } else {
        this.stateValue = reprojectConfigState(this.stateValue, snapshot);
      }
      if (this.stateValue.revision !== revision) {
        this.mutation++;
        this.persist();
      }
      this.publish();
    });
  }

  snapshot(): ConfigState {
    return this.stateValue;
  }

  lastActivatedAgent(): AgentKey | null {
    return this.activatedAgent ? { ...this.activatedAgent } : null;
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
    );
    if (transition.state === this.stateValue) return false;
    const revision = this.stateValue.revision;
    this.stateValue = transition.state;
    this.mutation++;
    this.pendingRestore = null;
    if (transition.activate && this.activateAgent(transition.activate))
      this.activatedAgent = { ...transition.activate };
    if (this.stateValue.revision !== revision) this.persist();
    this.publish();
    return true;
  }

  dispose(): void {
    this.unsubscribeDirectory();
    this.listeners.clear();
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
