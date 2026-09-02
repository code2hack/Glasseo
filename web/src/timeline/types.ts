import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { AgentKey, SourceToken } from "../directory/types";
import type {
  PaseoRuntime,
  PaseoTimelineEvent,
  PaseoTimelineOptions,
  PaseoTimeline,
} from "../paseo/adapter";

export const TIMELINE_CACHE_VERSION = 1 as const;

export type TimelineRuntime = Pick<
  PaseoRuntime,
  "getTimeline" | "setTimelineSubscription" | "subscribeTimeline"
>;
export type TimelineSourceToken = SourceToken;
export type TimelineRange = Readonly<{
  epoch: string;
  startSeq: number;
  endSeq: number;
}>;
export type TimelineSeqRange = Readonly<{ startSeq: number; endSeq: number }>;

export type TimelineRow = Readonly<{
  id: string;
  provider: string;
  item: AgentTimelineItem;
  turnId?: string;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges: readonly TimelineSeqRange[];
  collapsed: readonly (
    | "assistant_merge"
    | "reasoning_merge"
    | "tool_lifecycle"
  )[];
  provisional: boolean;
}>;

export type TimelineErrorCode =
  | "cache_error"
  | "protocol_error"
  | "sync_error"
  | "reset";

export type AgentTimelineSnapshot = Readonly<{
  key: AgentKey;
  rows: readonly TimelineRow[];
  range: TimelineRange | null;
  hasOlder: boolean;
  hasNewer: boolean;
  loading: boolean;
  olderLoading: boolean;
  catchingUp: boolean;
  stale: boolean;
  error: TimelineErrorCode | null;
  sourceToken: TimelineSourceToken | null;
  revision: number;
  following: boolean;
  atLatest: boolean;
  unseenLiveCount: number;
  duplicateCount: number;
  gapCount: number;
}>;

export type TimelineCoordinatorSnapshot = Readonly<{
  current: AgentKey | null;
  replicas: ReadonlyMap<string, AgentTimelineSnapshot>;
}>;

export type CachedAgentTimeline = Readonly<{
  schemaVersion: typeof TIMELINE_CACHE_VERSION;
  key: AgentKey;
  revision: number;
  lastAuthoritativeSyncAt: number;
  sourceToken: TimelineSourceToken;
  range: TimelineRange | null;
  hasOlder: boolean;
  hasNewer: boolean;
  rows: readonly TimelineRow[];
}>;

export interface TimelineStorage {
  loadAgent(key: AgentKey): Promise<unknown | null>;
  putAgent(record: CachedAgentTimeline): Promise<void>;
  deleteAgent(key: AgentKey): Promise<void>;
  deleteHost(serverId: string): Promise<void>;
}

export type OlderAnchor = Readonly<{
  anchorRowId: string | null;
  prependedRowIds: readonly string[];
}>;

export type TimelineActivation = Readonly<{
  key: AgentKey;
  sourceToken: TimelineSourceToken;
  runtime: TimelineRuntime;
}>;

export type { PaseoTimeline, PaseoTimelineEvent, PaseoTimelineOptions };
