import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { TimelineRow } from "./types";

export type TimelineViewRow = Readonly<{
  id: string;
  kind: "user" | "assistant" | "reasoning" | "tool" | "status" | "error";
  state: string | null;
  unknown: boolean;
  label: string;
  text: string;
  meta: string;
  provisional: boolean;
  preformatted: boolean;
}>;

export function projectTimelineRow(row: TimelineRow): TimelineViewRow {
  const item = row.item;
  const base = {
    id: row.id,
    meta: compactMeta(row.provider, row.timestamp),
    provisional: row.provisional,
    preformatted: false,
    state: null,
    unknown: false,
  };
  switch (item.type) {
    case "user_message":
      return { ...base, kind: "user", label: "You", text: item.text };
    case "assistant_message":
      return {
        ...base,
        kind: "assistant",
        label: "Assistant",
        text: item.text,
      };
    case "reasoning":
      return {
        ...base,
        kind: "reasoning",
        label: "Reasoning",
        text: item.text,
      };
    case "tool_call":
      return {
        ...base,
        kind: "tool",
        state: item.status,
        label: `${item.name} · ${item.status}`,
        text: toolSummary(item),
        preformatted: true,
      };
    case "todo":
      return {
        ...base,
        kind: "status",
        label: "Tasks",
        text: item.items
          .map((task) => `${task.completed ? "✓" : "○"} ${task.text}`)
          .join("\n"),
      };
    case "error":
      return { ...base, kind: "error", label: "Error", text: item.message };
    case "compaction":
      return {
        ...base,
        kind: "status",
        label: "Context",
        text: item.status === "loading" ? "Compacting…" : "Compaction complete",
      };
    default:
      return unknownTimelineRow(row, item);
  }
}

function unknownTimelineRow(row: TimelineRow, item: never): TimelineViewRow {
  const type = String((item as { type?: unknown }).type ?? "unknown");
  return {
    id: row.id,
    kind: "status",
    state: null,
    unknown: true,
    label: "Update",
    text: `Unsupported timeline item: ${type}`,
    meta: compactMeta(row.provider, row.timestamp),
    provisional: row.provisional,
    preformatted: false,
  };
}

function compactMeta(provider: string, timestamp: string): string {
  const date = new Date(timestamp);
  const time = Number.isNaN(date.getTime())
    ? ""
    : date.toISOString().slice(11, 16);
  return [provider, time].filter(Boolean).join(" · ");
}

function toolSummary(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
): string {
  if (item.status === "failed") return readable(item.error) || "Tool failed";
  const detail = item.detail;
  switch (detail.type) {
    case "shell":
      return detail.command;
    case "read":
    case "edit":
    case "write":
      return detail.filePath;
    case "search":
      return detail.query;
    case "fetch":
      return detail.url;
    case "worktree_setup":
      return detail.branchName || detail.worktreePath;
    case "sub_agent":
      return detail.description || detail.subAgentType || "Sub-agent";
    case "plain_text":
      return detail.text || detail.label || "Tool update";
    case "plan":
      return detail.text;
    case "unknown":
      return "Tool details unavailable";
  }
}

function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object" && "message" in value)
    return readable((value as { message: unknown }).message);
  return "";
}
