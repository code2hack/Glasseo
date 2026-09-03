import type {
  DestinationBody,
  DestinationContext,
} from "../app/destinationHost";
import { diagnosticHash } from "../app/hash";
import { sameAgentKey } from "../directory/normalize";
import type { AgentKey } from "../directory/types";
import type { SemanticInput } from "../native/semanticInput";
import type { DraftController } from "./controller";
import { draftDiagnostics } from "./diagnostics";
import { availableDraftAreas, isDraftNavigationInput } from "./model";
import { projectTextSegments } from "./text/presentation";
import { unitAtOffset } from "./text/ranges";
import { isTextEditorInput } from "./text/reducer";
import type { DraftArea, DraftSessionState, DraftSnapshot } from "./types";

export type DraftViewController = Pick<
  DraftController,
  | "snapshot"
  | "subscribe"
  | "activate"
  | "deactivate"
  | "handle"
  | "setRequestDescriptors"
  | "resetTransientState"
>;

export type DraftViewDiagnostics = ReturnType<typeof draftDiagnostics> &
  Readonly<{
    scrollTop: number;
    scrollHeight: number;
    renderRevision: number;
    duplicateDomAreas: number;
    duplicateDomUnits: number;
    lastHandled: Pick<
      SemanticInput,
      "control" | "action" | "interactionId"
    > | null;
  }>;

type AreaElement = {
  section: HTMLElement;
  units: HTMLElement;
};

export class DraftDestinationBody implements DestinationBody {
  private readonly viewport = document.createElement("div");
  private readonly list = document.createElement("div");
  private readonly status = document.createElement("div");
  private readonly areas = new Map<DraftArea, AreaElement>();
  private readonly units = new Map<string, HTMLElement>();
  private key: AgentKey | null = null;
  private state: DraftSnapshot;
  private unsubscribe: (() => void) | null = null;
  private renderRevision = 0;
  private textRevision = 0;
  private renderedText: string | null = null;
  private lastHandled: DraftViewDiagnostics["lastHandled"] = null;

  constructor(
    private readonly controller: DraftViewController,
    private readonly requestIds: (key: AgentKey) => readonly string[],
  ) {
    this.state = controller.snapshot();
    this.viewport.className = "draft-viewport";
    this.viewport.setAttribute("aria-label", "Agent Draft");
    this.list.className = "draft-list";
    this.status.className = "draft-status";
    this.status.setAttribute("role", "status");
    this.viewport.append(this.list);
  }

  mount(root: HTMLElement): void {
    root.append(this.viewport, this.status);
    this.unsubscribe = this.controller.subscribe((state) => {
      this.state = state;
      this.render();
    });
  }

  update(context: DestinationContext): void {
    if (
      context.destination.kind !== "agent" ||
      context.destination.pane !== "draft"
    )
      return;
    const key = context.destination.key;
    const requestIds = this.requestIds(key);
    if (sameAgentKey(this.key, key)) {
      void this.controller.setRequestDescriptors(requestIds);
      return;
    }
    this.key = { ...key };
    this.renderedText = null;
    void this.controller.activate(key, requestIds);
  }

  handleInput(input: SemanticInput): boolean {
    if (
      !this.state.session ||
      !sameAgentKey(this.state.current, this.key) ||
      (!isDraftNavigationInput(input) &&
        !(
          this.state.session.record.activeArea === "text" &&
          isTextEditorInput(input)
        ))
    )
      return false;
    this.lastHandled = {
      control: input.control,
      action: input.action,
      interactionId: input.interactionId,
    };
    void this.controller.handle(input);
    return true;
  }

  diagnostics(): DraftViewDiagnostics {
    const areaIds = Array.from(this.list.children).map(
      (element) => (element as HTMLElement).dataset.area ?? "",
    );
    const unitIds = Array.from(
      this.list.querySelectorAll<HTMLElement>(".draft-unit"),
    ).map((element) => element.dataset.unitHash ?? "");
    return {
      ...draftDiagnostics(this.state),
      scrollTop: Math.round(this.viewport.scrollTop),
      scrollHeight: Math.round(this.viewport.scrollHeight),
      renderRevision: this.renderRevision,
      duplicateDomAreas: areaIds.length - new Set(areaIds).size,
      duplicateDomUnits: unitIds.length - new Set(unitIds).size,
      lastHandled: this.lastHandled,
    };
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller.resetTransientState();
    this.controller.deactivate();
    this.key = null;
  }

  private render(): void {
    const session = this.state.session;
    if (!session || !sameAgentKey(this.state.current, this.key)) return;
    if (this.renderedText !== session.record.text) {
      this.renderedText = session.record.text;
      this.textRevision++;
    }
    const available = availableDraftAreas(session);
    const wanted = new Set(available);
    for (const [area, element] of this.areas)
      if (!wanted.has(area)) {
        element.section.remove();
        this.areas.delete(area);
      }
    const ordered = available.map((area) => this.renderArea(area, session));
    this.list.append(...ordered);
    this.areas.get(session.record.activeArea)?.section.scrollIntoView({
      block: "nearest",
    });
    this.status.textContent =
      this.state.storageStatus === "error"
        ? "Draft storage unavailable; local edits are retained."
        : this.state.storageStatus === "loading"
          ? "Restoring Draft…"
          : "";
    this.status.hidden = !this.status.textContent;
    this.renderRevision++;
  }

  private renderArea(area: DraftArea, session: DraftSessionState): HTMLElement {
    let element = this.areas.get(area);
    if (!element) {
      const section = document.createElement("section");
      section.dataset.area = area;
      section.setAttribute("aria-label", `${areaLabel(area)} Draft area`);
      const heading = document.createElement("h2");
      heading.textContent = areaLabel(area);
      const units = document.createElement("div");
      units.className = `draft-units${area === "text" ? " text" : ""}`;
      units.setAttribute("role", "listbox");
      section.append(heading, units);
      element = { section, units };
      this.areas.set(area, element);
    }
    element.section.className = `draft-area${session.record.activeArea === area ? " active" : ""}`;
    element.section.setAttribute(
      "aria-current",
      String(session.record.activeArea === area),
    );
    const descriptors = unitsFor(area, session, this.textRevision);
    const wanted = new Set(descriptors.map(({ id }) => `${area}:${id}`));
    for (const [id, unit] of this.units)
      if (id.startsWith(`${area}:`) && !wanted.has(id)) {
        unit.remove();
        this.units.delete(id);
      }
    const ordered = descriptors.map(
      ({ id, label, cursor, selected, option, empty, scroll }) => {
        const key = `${area}:${id}`;
        let unit = this.units.get(key);
        if (!unit) {
          unit = document.createElement(area === "text" ? "span" : "div");
          unit.dataset.unitHash = diagnosticHash(key);
          this.units.set(key, unit);
        }
        unit.className = option
          ? `draft-unit${cursor ? " cursor" : ""}${selected ? " selected" : ""}${empty ? " empty" : ""}`
          : "draft-text-whitespace";
        unit.textContent = label;
        if (option) {
          unit.setAttribute("role", "option");
          unit.setAttribute("aria-selected", String(selected || cursor));
        } else {
          unit.removeAttribute("role");
          unit.removeAttribute("aria-selected");
        }
        if (scroll)
          unit.scrollIntoView({ block: "nearest", inline: "nearest" });
        return unit;
      },
    );
    element.units.append(...ordered);
    return element.section;
  }
}

function unitsFor(
  area: DraftArea,
  session: DraftSessionState,
  textRevision: number,
): readonly UnitDescriptor[] {
  if (area === "request")
    return session.requestIds.map((id, index) => ({
      id,
      label: `Pending request ${index + 1}`,
      cursor: id === session.record.cursors.requestId,
      selected: false,
      option: true,
      empty: false,
      scroll:
        session.record.activeArea === "request" &&
        id === session.record.cursors.requestId,
    }));
  if (area === "images")
    return session.record.images.map((image, index) => ({
      id: image.id,
      label: `Image ${index + 1} · ${image.mimeType}`,
      cursor: image.id === session.record.cursors.imageId,
      selected: false,
      option: true,
      empty: false,
      scroll:
        session.record.activeArea === "images" &&
        image.id === session.record.cursors.imageId,
    }));
  const focus = unitAtOffset(
    session.record.text,
    session.transient.textSelection?.focusOffset ??
      session.record.cursors.textOffset,
  ).start;
  return projectTextSegments(
    {
      text: session.record.text,
      cursorOffset: session.record.cursors.textOffset,
      selection: session.transient.textSelection,
      copyBuffer: session.transient.textCopyBuffer,
      handledInteractionIds: session.handledInteractionIds,
    },
    textRevision,
  ).map((segment) => ({
    id: segment.key,
    label: segment.text,
    cursor: segment.cursor,
    selected: segment.selected,
    option: segment.kind !== "whitespace",
    empty: segment.start === segment.end,
    scroll:
      session.record.activeArea === "text" &&
      segment.kind !== "whitespace" &&
      segment.start === focus &&
      (segment.cursor || segment.selected),
  }));
}

type UnitDescriptor = Readonly<{
  id: string;
  label: string;
  cursor: boolean;
  selected: boolean;
  option: boolean;
  empty: boolean;
  scroll: boolean;
}>;

function areaLabel(area: DraftArea): string {
  return area[0]!.toUpperCase() + area.slice(1);
}
