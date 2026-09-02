import { AgentTimelineEntryPayloadSchema } from "@getpaseo/protocol/messages";
import type { AgentKey } from "../directory/types";
import type {
  CachedAgentTimeline,
  PaseoTimeline,
  TimelineRange,
  TimelineRow,
} from "./types";
import { TIMELINE_CACHE_VERSION } from "./types";

export function timelineKey(key: AgentKey): string {
  return `${key.serverId.length}:${key.serverId}${key.agentId}`;
}

export function sameAgentKey(a: AgentKey | null, b: AgentKey | null): boolean {
  return a?.serverId === b?.serverId && a?.agentId === b?.agentId;
}

export function normalizePage(
  expected: AgentKey,
  page: PaseoTimeline,
): { rows: TimelineRow[]; range: TimelineRange | null } {
  if (
    page.agentId !== expected.agentId ||
    page.projection !== "projected" ||
    page.error !== null ||
    !page.epoch ||
    page.window.minSeq > page.window.maxSeq ||
    (page.window.nextSeq !== page.window.maxSeq + 1 &&
      !(
        page.window.minSeq === 0 &&
        page.window.maxSeq === 0 &&
        page.window.nextSeq === 0 &&
        page.startCursor === null &&
        page.endCursor === null &&
        page.entries.length === 0
      )) ||
    (page.startCursor !== null && page.startCursor.epoch !== page.epoch) ||
    (page.endCursor !== null && page.endCursor.epoch !== page.epoch) ||
    (page.startCursor === null) !== (page.endCursor === null) ||
    (page.startCursor &&
      page.endCursor &&
      (page.startCursor.seq > page.endCursor.seq ||
        page.startCursor.seq < page.window.minSeq ||
        page.endCursor.seq > page.window.maxSeq))
  )
    throw new Error("Invalid timeline page identity or range");

  const range =
    page.startCursor && page.endCursor
      ? {
          epoch: page.epoch,
          startSeq: page.startCursor.seq,
          endSeq: page.endCursor.seq,
        }
      : null;
  const rows = page.entries.map((entry) => {
    if (
      entry.seqStart > entry.seqEnd ||
      entry.sourceSeqRanges.length === 0 ||
      entry.sourceSeqRanges.some(
        ({ startSeq, endSeq }) =>
          startSeq > endSeq ||
          startSeq < entry.seqStart ||
          endSeq > entry.seqEnd,
      )
    )
      throw new Error("Invalid timeline entry range");
    return {
      ...entry,
      id: rowId(page.epoch, entry.item, entry.turnId, entry.seqStart),
      provisional: false,
    };
  });
  if (
    (range === null) !== (rows.length === 0) ||
    (range !== null &&
      !coversRange(
        rows.flatMap(({ sourceSeqRanges }) => sourceSeqRanges),
        range,
      ))
  )
    throw new Error("Timeline page did not certify its range");
  return { rows, range };
}

export function provisionalRow(
  epoch: string,
  event: Extract<
    import("./types").PaseoTimelineEvent,
    { type: "agent_stream" }
  >,
): TimelineRow | null {
  if (event.event.type !== "timeline") return null;
  const seq = event.seq ?? Number.MAX_SAFE_INTEGER;
  return {
    id: rowId(epoch, event.event.item, event.event.turnId, seq),
    provider: event.event.provider,
    item: event.event.item,
    ...(event.event.turnId ? { turnId: event.event.turnId } : {}),
    timestamp: event.timestamp,
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges:
      event.seq === undefined ? [] : [{ startSeq: seq, endSeq: seq }],
    collapsed: [],
    provisional: true,
  };
}

export function rowId(
  epoch: string,
  item: { type: string; [key: string]: unknown },
  turnId: string | undefined,
  seqStart: number,
): string {
  if (item.type === "tool_call" && typeof item.callId === "string")
    return `tool:${item.callId}`;
  if (
    (item.type === "user_message" || item.type === "assistant_message") &&
    typeof item.messageId === "string"
  )
    return `message:${item.messageId}`;
  if (item.type === "user_message" && typeof item.clientMessageId === "string")
    return `client:${item.clientMessageId}`;
  return `${epoch}:${item.type}:${turnId ?? ""}:${seqStart}`;
}

export function validateCachedTimeline(
  value: unknown,
  expected: AgentKey,
): CachedAgentTimeline {
  if (!value || typeof value !== "object")
    throw new Error("Invalid timeline cache");
  const record = value as CachedAgentTimeline;
  if (
    record.schemaVersion !== TIMELINE_CACHE_VERSION ||
    record.key?.serverId !== expected.serverId ||
    record.key?.agentId !== expected.agentId ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !Number.isSafeInteger(record.lastAuthoritativeSyncAt) ||
    record.lastAuthoritativeSyncAt < 0 ||
    record.sourceToken?.serverId !== expected.serverId ||
    !validSeq(record.sourceToken?.slotGeneration) ||
    !validSeq(record.sourceToken?.connectionEpoch) ||
    typeof record.hasOlder !== "boolean" ||
    typeof record.hasNewer !== "boolean" ||
    !Array.isArray(record.rows)
  )
    throw new Error("Invalid timeline cache");
  if (
    record.range !== null &&
    (!record.range.epoch ||
      !validSeq(record.range.startSeq) ||
      !validSeq(record.range.endSeq) ||
      record.range.startSeq > record.range.endSeq)
  )
    throw new Error("Invalid timeline cache range");
  if ((record.range === null) !== (record.rows.length === 0))
    throw new Error("Invalid timeline cache coverage");
  const ids = new Set<string>();
  let previous: TimelineRow | null = null;
  const coverage: { startSeq: number; endSeq: number }[] = [];
  for (const row of record.rows) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !row.id ||
      typeof row.provider !== "string" ||
      typeof row.timestamp !== "string" ||
      !validSeq(row.seqStart) ||
      !validSeq(row.seqEnd) ||
      row.seqStart > row.seqEnd ||
      row.provisional !== false ||
      !Array.isArray(row.sourceSeqRanges) ||
      row.sourceSeqRanges.length === 0 ||
      !Array.isArray(row.collapsed) ||
      !AgentTimelineEntryPayloadSchema.safeParse({
        provider: row.provider,
        item: row.item,
        ...(row.turnId ? { turnId: row.turnId } : {}),
        timestamp: row.timestamp,
        seqStart: row.seqStart,
        seqEnd: row.seqEnd,
        sourceSeqRanges: row.sourceSeqRanges,
        collapsed: row.collapsed,
      }).success ||
      ids.has(row.id) ||
      row.id !==
        rowId(record.range!.epoch, row.item, row.turnId, row.seqStart) ||
      (previous !== null && compareRows(previous, row) >= 0) ||
      row.seqStart < record.range!.startSeq ||
      row.seqEnd > record.range!.endSeq ||
      row.sourceSeqRanges.some(
        ({ startSeq, endSeq }: { startSeq: number; endSeq: number }) =>
          !validSeq(startSeq) ||
          !validSeq(endSeq) ||
          startSeq > endSeq ||
          startSeq < row.seqStart ||
          endSeq > row.seqEnd ||
          startSeq < record.range!.startSeq ||
          endSeq > record.range!.endSeq,
      )
    )
      throw new Error("Invalid timeline cache row");
    ids.add(row.id);
    previous = row;
    coverage.push(...row.sourceSeqRanges);
  }
  if (record.range && !coversRange(coverage, record.range))
    throw new Error("Invalid timeline cache coverage");
  return record;
}

function compareRows(left: TimelineRow, right: TimelineRow): number {
  return (
    left.seqStart - right.seqStart ||
    left.seqEnd - right.seqEnd ||
    left.id.localeCompare(right.id)
  );
}

function coversRange(
  ranges: { startSeq: number; endSeq: number }[],
  expected: TimelineRange,
): boolean {
  const ordered = [...ranges].sort(
    (left, right) =>
      left.startSeq - right.startSeq || left.endSeq - right.endSeq,
  );
  let coveredThrough = expected.startSeq - 1;
  for (const range of ordered) {
    if (range.startSeq > coveredThrough + 1) return false;
    coveredThrough = Math.max(coveredThrough, range.endSeq);
  }
  return coveredThrough >= expected.endSeq;
}

function validSeq(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
