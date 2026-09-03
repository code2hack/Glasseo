import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { AgentKey } from "../../directory/types";
import type {
  PaseoPermissionRequest,
  PaseoPermissionSuggestion,
} from "../../paseo/adapter";

export const REQUEST_ANSWER_VERSION = 1 as const;

export type RequestKey = AgentKey & Readonly<{ requestId: string }>;
export type RequestUnit =
  | Readonly<{
      id: string;
      kind: "action";
      requestId: string;
      actionId: string;
      label: string;
      required: true;
    }>
  | Readonly<{
      id: string;
      kind: "option";
      requestId: string;
      fieldId: string;
      optionId: string;
      label: string;
      multiple: boolean;
      required: boolean;
    }>
  | Readonly<{
      id: string;
      kind: "text";
      requestId: string;
      fieldId: string;
      label: string;
      required: boolean;
    }>
  | Readonly<{
      id: string;
      kind: "suggestion";
      requestId: string;
      suggestionId: string;
      label: string;
      required: false;
    }>;

export type NormalizedRequest = Readonly<{
  key: RequestKey;
  request: PaseoPermissionRequest;
  fingerprint: string;
  units: readonly RequestUnit[];
  suggestions: readonly PaseoPermissionSuggestion[];
}>;

export type RequestAnswer = Readonly<{
  schemaVersion: typeof REQUEST_ANSWER_VERSION;
  key: RequestKey;
  fingerprint: string;
  selectedActionId: string | null;
  selectedOptionIds: readonly string[];
  selectedSuggestionIds: readonly string[];
  fieldTexts: Readonly<Record<string, string>>;
  revision: number;
  updatedAt: number;
}>;

export type RequestSession = Readonly<{
  model: NormalizedRequest;
  answer: RequestAnswer;
  authoritative: boolean;
  cursor: number;
  focusedFieldId: string | null;
  handledInteractionIds: readonly number[];
}>;

export type RequestAreaSession = Readonly<{
  requests: readonly RequestSession[];
  cursorUnitId: string | null;
  handledInteractionIds: readonly number[];
}>;

export type PreparedRequestResponse =
  | Readonly<{
      status: "complete";
      requestId: string;
      fingerprint: string;
      answerRevision: number;
      response: AgentPermissionResponse;
    }>
  | Readonly<{ status: "incomplete"; missing: readonly string[] }>
  | Readonly<{ status: "unsupported"; reason: string }>
  | Readonly<{ status: "stale" }>;

export interface RequestAnswerStorage {
  load(key: RequestKey): Promise<unknown | null>;
  put(answer: RequestAnswer): Promise<boolean>;
  delete(key: RequestKey): Promise<void>;
  deleteHost(serverId: string): Promise<void>;
}

export type RequestReplicaStatus =
  | "idle"
  | "syncing"
  | "ready"
  | "offline"
  | "error";
export type RequestReplicaSnapshot = Readonly<{
  key: AgentKey | null;
  status: RequestReplicaStatus;
  requests: readonly NormalizedRequest[];
  authoritative: boolean;
  revision: number;
  error: boolean;
}>;
