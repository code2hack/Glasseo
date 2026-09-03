import type { AgentKey } from "../directory/types";
import type { SemanticInput } from "../native/semanticInput";

export const CONFIG_UI_VERSION = 1 as const;

export type ConfigRowId = string;
export type ConfigRowKind =
  | "section"
  | "host"
  | "project"
  | "workspace"
  | "agent"
  | "placeholder"
  | "empty";

export type ConfigRow = Readonly<{
  id: ConfigRowId;
  parentId: ConfigRowId | null;
  kind: ConfigRowKind;
  depth: number;
  label: string;
  detail: string | null;
  foldable: boolean;
  expanded: boolean;
  agentKey: AgentKey | null;
}>;

export type ConfigProjection = Readonly<{
  rows: readonly ConfigRow[];
  allRows: ReadonlyMap<ConfigRowId, ConfigRow>;
  counts: Readonly<{
    hosts: number;
    projects: number;
    workspaces: number;
    agents: number;
    stale: number;
    offline: number;
    errors: number;
  }>;
}>;

export type ConfigState = Readonly<{
  focusedRowId: ConfigRowId;
  expandedRowIds: ReadonlySet<ConfigRowId>;
  projection: ConfigProjection;
  handledInteractionIds: readonly number[];
  lastInteractionId: number | null;
  lastInput: Pick<SemanticInput, "control" | "action" | "interactionId"> | null;
  revision: number;
}>;

export type StoredConfigUi = Readonly<{
  schemaVersion: typeof CONFIG_UI_VERSION;
  revision: number;
  updatedAt: number;
  expandedRowIds: readonly ConfigRowId[];
  focusedRowId: ConfigRowId | null;
}>;

export interface ConfigStorage {
  load(): Promise<unknown | null>;
  put(value: StoredConfigUi): Promise<void>;
}
