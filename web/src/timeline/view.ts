import type {
  DestinationBody,
  DestinationContext,
} from "../app/destinationHost";
import { diagnosticHash } from "../app/hash";
import type { AgentKey } from "../directory/types";
import type { SemanticInput } from "../native/semanticInput";
import { sameAgentKey, timelineKey } from "./normalize";
import { projectTimelineRow, type TimelineViewRow } from "./presentation";
import type { AgentTimelineSnapshot } from "./types";

export type TimelineController = Readonly<{
  loadOlder(key?: AgentKey): Promise<{ anchorRowId: string | null }>;
  setFollowing(value: boolean): void;
  setAtLatest(value: boolean): void;
  acknowledgeLatest(): void;
}>;

type ViewportState = {
  scrollTop: number;
  anchorId: string | null;
  offset: number;
};
type Anchor = { id: string | null; offset: number };

export type TimelineDiagnostics = Readonly<{
  keyHash: string | null;
  rowCount: number;
  rowIdHashes: readonly string[];
  revision: number;
  range: { startSeq: number; endSeq: number } | null;
  stale: boolean;
  error: string | null;
  loading: boolean;
  following: boolean;
  atLatest: boolean;
  unseenLiveCount: number;
  scrollTop: number;
  scrollHeight: number;
  visibleAnchorHash: string | null;
  olderLoadCount: number;
  lastHandled: Pick<
    SemanticInput,
    "control" | "action" | "interactionId"
  > | null;
  duplicateDomRows: number;
  unknownRowCount: number;
}>;

export class TimelineDestinationBody implements DestinationBody {
  private readonly viewport = document.createElement("div");
  private readonly list = document.createElement("div");
  private readonly status = document.createElement("div");
  private readonly unseen = document.createElement("div");
  private readonly elements = new Map<string, HTMLElement>();
  private snapshot: AgentTimelineSnapshot | null = null;
  private key: AgentKey | null = null;
  private hold: { id: number; direction: number; time: number } | null = null;
  private olderPending = false;
  private olderLoadCount = 0;
  private unknownRowCount = 0;
  private lastHandled: TimelineDiagnostics["lastHandled"] = null;
  private disposed = false;

  constructor(
    private readonly timeline: TimelineController,
    private readonly viewports: Map<string, ViewportState> = new Map(),
  ) {
    this.viewport.className = "timeline-viewport";
    this.viewport.setAttribute("aria-label", "Agent timeline");
    this.list.className = "timeline-list";
    this.list.setAttribute("role", "feed");
    this.status.className = "timeline-status";
    this.status.setAttribute("role", "status");
    this.unseen.className = "timeline-unseen";
    this.unseen.setAttribute("aria-live", "polite");
    this.viewport.append(this.list);
    this.viewport.addEventListener("scroll", this.onScroll);
  }

  mount(root: HTMLElement): void {
    root.append(this.viewport, this.status, this.unseen);
  }

  update(context: DestinationContext): void {
    if (
      context.destination.kind !== "agent" ||
      context.destination.pane !== "timeline"
    )
      return;
    const next = context.timeline;
    if (!sameAgentKey(this.key, context.destination.key)) {
      this.saveViewport();
      this.key = { ...context.destination.key };
      this.snapshot = null;
      this.elements.clear();
      this.list.replaceChildren();
    }
    const anchor = this.captureAnchor();
    const previousEpoch = this.snapshot?.range?.epoch ?? null;
    this.snapshot = next;
    this.renderRows(next?.rows.map(projectTimelineRow) ?? []);
    this.renderState();
    if (!next) return;
    if (next.following && next.atLatest)
      this.viewport.scrollTop = this.viewport.scrollHeight;
    else if (previousEpoch && next.range?.epoch !== previousEpoch) {
      if (!this.restoreSavedViewport(false)) this.viewport.scrollTop = 0;
      this.viewports.delete(timelineKey(next.key));
    } else if (!this.restoreAnchor(anchor)) this.restoreSavedViewport(true);
    this.saveViewport();
  }

  handleInput(input: SemanticInput): boolean {
    if (!this.snapshot) return false;
    if (input.control === "UP" || input.control === "DOWN") {
      if (input.action === "BEGIN") {
        this.hold = {
          id: input.interactionId,
          direction: input.control === "UP" ? -1 : 1,
          time: input.timeMillis,
        };
        this.scroll(this.hold.direction * this.lineHeight());
        return this.handled(input);
      }
      if (input.action === "UPDATE" && this.hold?.id === input.interactionId) {
        const elapsed = Math.max(0, input.timeMillis - this.hold.time);
        this.hold.time = input.timeMillis;
        this.scroll(
          this.hold.direction * Math.max(this.lineHeight(), elapsed * 0.18),
        );
        return this.handled(input);
      }
      if (
        (input.action === "END" || input.action === "CANCEL") &&
        this.hold?.id === input.interactionId
      ) {
        this.hold = null;
        return this.handled(input);
      }
      return false;
    }
    if (input.control === "PRIMARY" && input.action === "SHORT") {
      this.timeline.setFollowing(!this.snapshot.following);
      return this.handled(input);
    }
    if (input.control === "PRIMARY" && input.action === "LONG") {
      this.viewport.scrollTop = this.viewport.scrollHeight;
      this.timeline.setFollowing(true);
      this.timeline.setAtLatest(true);
      this.timeline.acknowledgeLatest();
      return this.handled(input);
    }
    return false;
  }

  diagnostics(): TimelineDiagnostics {
    const anchor = this.captureAnchor();
    const ids = Array.from(this.list.children).map(
      (element) => (element as HTMLElement).dataset.rowId ?? "",
    );
    return {
      keyHash: this.key
        ? diagnosticHash(`${this.key.serverId}\0${this.key.agentId}`)
        : null,
      rowCount: this.snapshot?.rows.length ?? 0,
      rowIdHashes: (this.snapshot?.rows ?? []).map(({ id }) =>
        diagnosticHash(id),
      ),
      revision: this.snapshot?.revision ?? 0,
      range: this.snapshot?.range
        ? {
            startSeq: this.snapshot.range.startSeq,
            endSeq: this.snapshot.range.endSeq,
          }
        : null,
      stale: this.snapshot?.stale ?? true,
      error: this.snapshot?.error ?? null,
      loading: !!(
        this.snapshot?.loading ||
        this.snapshot?.olderLoading ||
        this.snapshot?.catchingUp
      ),
      following: this.snapshot?.following ?? true,
      atLatest: this.snapshot?.atLatest ?? true,
      unseenLiveCount: this.snapshot?.unseenLiveCount ?? 0,
      scrollTop: Math.round(this.viewport.scrollTop),
      scrollHeight: Math.round(this.viewport.scrollHeight),
      visibleAnchorHash: anchor.id ? diagnosticHash(anchor.id) : null,
      olderLoadCount: this.olderLoadCount,
      lastHandled: this.lastHandled,
      duplicateDomRows: ids.length - new Set(ids).size,
      unknownRowCount: this.unknownRowCount,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.saveViewport();
    this.viewport.removeEventListener("scroll", this.onScroll);
    this.hold = null;
  }

  private renderRows(rows: readonly TimelineViewRow[]): void {
    const wanted = new Set(rows.map(({ id }) => id));
    for (const [id, element] of this.elements)
      if (!wanted.has(id)) {
        element.remove();
        this.elements.delete(id);
      }
    this.unknownRowCount = 0;
    const ordered = rows.map((row) => {
      let element = this.elements.get(row.id);
      if (!element) {
        element = document.createElement("article");
        element.dataset.rowId = row.id;
        element.setAttribute("role", "article");
        this.elements.set(row.id, element);
      }
      element.className = [
        "timeline-row",
        row.kind,
        row.state ? `${row.kind}-${row.state}` : "",
        row.unknown ? "unknown" : "",
        row.provisional ? "provisional" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const label = document.createElement("div");
      label.className = "timeline-row-label";
      label.textContent = row.label;
      const meta = document.createElement("span");
      meta.textContent = row.meta;
      label.append(meta);
      const content = document.createElement(row.preformatted ? "pre" : "div");
      content.className = "timeline-row-content";
      content.textContent = row.text;
      element.replaceChildren(label, content);
      if (row.unknown) this.unknownRowCount++;
      return element;
    });
    this.list.append(...ordered);
  }

  private renderState(): void {
    const snapshot = this.snapshot;
    this.status.textContent = !snapshot
      ? "Timeline unavailable"
      : snapshot.error === "reset"
        ? "Timeline changed; loading the latest history…"
        : snapshot.error
          ? "Timeline sync paused; retained history is shown."
          : snapshot.olderLoading
            ? "Loading earlier history…"
            : snapshot.catchingUp
              ? "Catching up…"
              : snapshot.loading
                ? snapshot.rows.length
                  ? "Refreshing…"
                  : "Loading timeline…"
                : snapshot.stale
                  ? snapshot.rows.length
                    ? "Cached history · offline"
                    : "Offline"
                  : snapshot.rows.length
                    ? ""
                    : "No timeline entries yet";
    this.status.hidden = !this.status.textContent;
    this.unseen.textContent = snapshot?.unseenLiveCount
      ? `${snapshot.unseenLiveCount} new`
      : "";
    this.unseen.hidden = !this.unseen.textContent;
  }

  private readonly onScroll = () => {
    if (!this.snapshot) return;
    const atLatest =
      this.viewport.scrollTop + this.viewport.clientHeight >=
      this.viewport.scrollHeight - 2;
    if (atLatest !== this.snapshot.atLatest)
      this.timeline.setAtLatest(atLatest);
    if (atLatest && this.snapshot.following) this.timeline.acknowledgeLatest();
    this.saveViewport();
    void this.maybeLoadOlder();
  };

  private scroll(delta: number): void {
    this.viewport.scrollTop = Math.max(
      0,
      Math.min(
        this.viewport.scrollHeight - this.viewport.clientHeight,
        this.viewport.scrollTop + delta,
      ),
    );
    this.onScroll();
  }

  private async maybeLoadOlder(): Promise<void> {
    if (
      this.disposed ||
      this.olderPending ||
      !this.key ||
      !this.snapshot?.hasOlder ||
      this.snapshot.olderLoading ||
      this.snapshot.error ||
      this.viewport.scrollTop > this.lineHeight() * 2
    )
      return;
    this.olderPending = true;
    this.olderLoadCount++;
    const key = { ...this.key };
    const anchor = this.captureAnchor();
    const expectedAnchorId = this.snapshot.rows[0]?.id ?? null;
    const expectedAnchorOffset = expectedAnchorId
      ? this.offsetFor(expectedAnchorId)
      : anchor.offset;
    try {
      const result = await this.timeline.loadOlder(key);
      if (!this.disposed && sameAgentKey(this.key, key))
        this.restoreAnchor({
          id: result.anchorRowId ?? anchor.id,
          offset:
            result.anchorRowId === expectedAnchorId
              ? expectedAnchorOffset
              : anchor.offset,
        });
    } finally {
      this.olderPending = false;
    }
  }

  private lineHeight(): number {
    const value = Number.parseFloat(getComputedStyle(this.viewport).lineHeight);
    return Number.isFinite(value) ? value : 24;
  }

  private captureAnchor(): Anchor {
    const top = this.viewport.getBoundingClientRect().top;
    const element = Array.from(this.list.children).find(
      (child) => child.getBoundingClientRect().bottom > top,
    ) as HTMLElement | undefined;
    return {
      id: element?.dataset.rowId ?? null,
      offset: element ? element.getBoundingClientRect().top - top : 0,
    };
  }

  private restoreAnchor(anchor: {
    id?: string | null;
    anchorId?: string | null;
    offset: number;
  }): boolean {
    const id = anchor.id ?? anchor.anchorId;
    const element = id ? this.elements.get(id) : null;
    if (!element) return false;
    this.viewport.scrollTop += this.offsetFor(id!) - anchor.offset;
    return true;
  }

  private offsetFor(id: string): number {
    const element = this.elements.get(id);
    return element
      ? element.getBoundingClientRect().top -
          this.viewport.getBoundingClientRect().top
      : 0;
  }

  private saveViewport(): void {
    if (!this.key) return;
    const anchor = this.captureAnchor();
    this.viewports.set(timelineKey(this.key), {
      scrollTop: this.viewport.scrollTop,
      anchorId: anchor.id,
      offset: anchor.offset,
    });
  }

  private restoreSavedViewport(allowScrollTop: boolean): boolean {
    if (!this.key) return false;
    const saved = this.viewports.get(timelineKey(this.key));
    if (!saved) return false;
    if (this.restoreAnchor(saved)) return true;
    if (allowScrollTop) this.viewport.scrollTop = saved.scrollTop;
    return allowScrollTop;
  }

  private handled(input: SemanticInput): true {
    this.lastHandled = {
      control: input.control,
      action: input.action,
      interactionId: input.interactionId,
    };
    return true;
  }
}
