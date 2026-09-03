import type { AgentKey } from "../directory/types";
import type { SemanticInput } from "../native/semanticInput";

export const DRAFT_SCHEMA_VERSION = 1 as const;

export type DraftArea = "request" | "text" | "images";

export type DraftImageRef = Readonly<{
  id: string;
  token: string;
  mimeType: string;
  capturedAt: number;
  width?: number;
  height?: number;
  bytes?: number;
}>;

export type DraftRecord = Readonly<{
  schemaVersion: typeof DRAFT_SCHEMA_VERSION;
  key: AgentKey;
  revision: number;
  updatedAt: number;
  text: string;
  images: readonly DraftImageRef[];
  activeArea: DraftArea;
  cursors: Readonly<{
    requestId: string | null;
    textOffset: number;
    imageId: string | null;
  }>;
}>;

export type DraftTransientState = Readonly<{
  mode: "edit";
  textSelection: null;
  selectedImageIds: readonly string[];
  provisionalText: null;
  wheelOpen: false;
  pending: false;
}>;

export type DraftSessionState = Readonly<{
  record: DraftRecord;
  requestIds: readonly string[];
  transient: DraftTransientState;
  handledInteractionIds: readonly number[];
}>;

export type DraftAction =
  | SemanticInput
  | Readonly<{ type: "set-requests"; requestIds: readonly string[] }>
  | Readonly<{ type: "set-images"; images: readonly DraftImageRef[] }>
  | Readonly<{ type: "append-images"; images: readonly DraftImageRef[] }>
  | Readonly<{ type: "remove-images"; imageIds: readonly string[] }>
  | Readonly<{ type: "replace-text"; text: string }>
  | Readonly<{ type: "set-text-cursor"; textOffset: number }>
  | Readonly<{ type: "cycle-area"; direction: "left" | "right" }>
  | Readonly<{ type: "move-within-area"; direction: "up" | "down" }>;

export type DraftTransition = Readonly<{
  state: DraftSessionState;
  effect: "persist" | "none";
  handled: boolean;
}>;

export type DraftStorageStatus = "loading" | "ready" | "error";

export type DraftSnapshot = Readonly<{
  current: AgentKey | null;
  session: DraftSessionState | null;
  storageStatus: DraftStorageStatus;
}>;

export interface DraftStorage {
  loadAgent(key: AgentKey): Promise<unknown | null>;
  loadHost(serverId: string): Promise<unknown[]>;
  putAgent(record: DraftRecord): Promise<boolean>;
  deleteAgent(key: AgentKey): Promise<void>;
  deleteHost(serverId: string, stillRemoved?: () => boolean): Promise<void>;
}
