import { TimelineDestinationBody } from "./view";
import type { AgentTimelineSnapshot, TimelineRow } from "./types";
import type { SemanticInput } from "../native/semanticInput";

declare global {
  interface Window {
    __glasseoTimelineUiAcceptance?: {
      run(): Readonly<Record<string, unknown>>;
    };
  }
}

window.__glasseoTimelineUiAcceptance = {
  run() {
    const root = document.querySelector<HTMLElement>("#agent-body");
    if (!root) throw new Error("Agent body missing");
    let snapshot = fixture();
    const calls = { following: 0, latest: 0, acknowledged: 0 };
    const view = new TimelineDestinationBody({
      loadOlder: async () => ({ anchorRowId: snapshot.rows[0]?.id ?? null }),
      setFollowing: () => calls.following++,
      setAtLatest: () => calls.latest++,
      acknowledgeLatest: () => calls.acknowledged++,
    });
    root.replaceChildren();
    root.dataset.destination = "timeline";
    view.mount(root);
    view.update(context(snapshot));
    const stable = root.querySelector('[data-row-id="message:1"]');
    snapshot = {
      ...snapshot,
      revision: 2,
      rows: [
        { ...snapshot.rows[0]!, provisional: false },
        ...snapshot.rows.slice(1),
      ],
    };
    view.update(context(snapshot));
    view.handleInput(input("PRIMARY", "SHORT", 1));
    view.handleInput(input("PRIMARY", "LONG", 2));
    const viewport = root.querySelector<HTMLElement>(".timeline-viewport")!;
    const header = document.querySelector<HTMLElement>("#agent-header")!;
    const rootRect = root.getBoundingClientRect();
    const result = {
      width: innerWidth,
      height: innerHeight,
      bodyTop: rootRect.top,
      bodyBottom: rootRect.bottom,
      headerBottom: header.getBoundingClientRect().bottom,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportScrollWidth: viewport.scrollWidth,
      viewportClientWidth: viewport.clientWidth,
      stableRow: stable === root.querySelector('[data-row-id="message:1"]'),
      diagnostics: view.diagnostics(),
      calls,
    };
    view.dispose();
    return result;
  },
};

function fixture(): AgentTimelineSnapshot {
  const rows = [
    row("message:1", {
      type: "assistant_message",
      messageId: "1",
      text: "Unicode 眼鏡 Ω ".repeat(80),
    }),
    row("tool:1", {
      type: "tool_call",
      callId: "1",
      name: "exec",
      detail: { type: "plain_text", text: "x".repeat(800) },
      status: "completed",
      error: null,
    }),
    row("error:1", { type: "error", message: "recoverable failure" }),
  ];
  return {
    key: { serverId: "acceptance-server", agentId: "acceptance-agent" },
    rows,
    range: { epoch: "acceptance-epoch", startSeq: 1, endSeq: 3 },
    hasOlder: true,
    hasNewer: false,
    loading: false,
    olderLoading: false,
    catchingUp: false,
    stale: false,
    error: null,
    sourceToken: {
      serverId: "acceptance-server",
      slotGeneration: 1,
      connectionEpoch: 1,
    },
    revision: 1,
    following: true,
    atLatest: true,
    unseenLiveCount: 2,
    duplicateCount: 0,
    gapCount: 0,
  };
}

function row(id: string, item: TimelineRow["item"]): TimelineRow {
  return {
    id,
    provider: "codex",
    item,
    timestamp: "2026-09-03T00:00:00Z",
    seqStart: 1,
    seqEnd: 1,
    sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    collapsed: [],
    provisional: true,
  };
}

function context(timeline: AgentTimelineSnapshot) {
  return {
    destination: {
      kind: "agent" as const,
      key: timeline.key,
      pane: "timeline" as const,
    },
    timeline,
  };
}

function input(
  control: SemanticInput["control"],
  action: SemanticInput["action"],
  interactionId: number,
): SemanticInput {
  return {
    type: "semantic-input",
    control,
    action,
    interactionId,
    timeMillis: interactionId,
  };
}
