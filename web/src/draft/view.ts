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
    void this.controller.activate(key, requestIds);
  }

  handleInput(input: SemanticInput): boolean {
    if (
      !this.state.session ||
      !sameAgentKey(this.state.current, this.key) ||
      !isDraftNavigationInput(input)
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
      units.className = "draft-units";
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
    const descriptors = unitsFor(area, session);
    const wanted = new Set(descriptors.map(({ id }) => `${area}:${id}`));
    for (const [id, unit] of this.units)
      if (id.startsWith(`${area}:`) && !wanted.has(id)) {
        unit.remove();
        this.units.delete(id);
      }
    const ordered = descriptors.map(({ id, label, cursor }) => {
      const key = `${area}:${id}`;
      let unit = this.units.get(key);
      if (!unit) {
        unit = document.createElement("div");
        unit.className = "draft-unit";
        unit.setAttribute("role", "option");
        unit.dataset.unitHash = diagnosticHash(key);
        this.units.set(key, unit);
      }
      unit.className = `draft-unit${cursor ? " cursor" : ""}`;
      unit.textContent = label;
      unit.setAttribute("aria-selected", String(cursor));
      return unit;
    });
    element.units.append(...ordered);
    return element.section;
  }
}

function unitsFor(
  area: DraftArea,
  session: DraftSessionState,
): readonly { id: string; label: string; cursor: boolean }[] {
  if (area === "request")
    return session.requestIds.map((id, index) => ({
      id,
      label: `Pending request ${index + 1}`,
      cursor: id === session.record.cursors.requestId,
    }));
  if (area === "images")
    return session.record.images.map((image, index) => ({
      id: image.id,
      label: `Image ${index + 1} · ${image.mimeType}`,
      cursor: image.id === session.record.cursors.imageId,
    }));
  return [
    {
      id: "text",
      label: session.record.text || "Empty Draft",
      cursor: true,
    },
  ];
}

function areaLabel(area: DraftArea): string {
  return area[0]!.toUpperCase() + area.slice(1);
}
