import type {
  DestinationBody,
  DestinationContext,
} from "../app/destinationHost";
import { diagnosticHash } from "../app/hash";
import type { SemanticInput } from "../native/semanticInput";
import type { ConfigController } from "./controller";
import { configDiagnostics } from "./diagnostics";
import type { ConfigRow, ConfigState } from "./types";

export type ConfigViewController = Pick<
  ConfigController,
  | "snapshot"
  | "subscribe"
  | "handle"
  | "lastActivatedAgent"
  | "deactivate"
  | "sectionDiagnostics"
>;
export type ConfigDiagnostics = ReturnType<typeof configDiagnostics> &
  Readonly<{
    scrollTop: number;
    scrollHeight: number;
    duplicateDomRows: number;
  }>;

export class ConfigDestinationBody implements DestinationBody {
  private readonly viewport = document.createElement("div");
  private readonly list = document.createElement("div");
  private readonly elements = new Map<string, HTMLElement>();
  private state: ConfigState;
  private unsubscribe: (() => void) | null = null;
  private mounted = false;
  private renderRevision = 0;

  constructor(
    private readonly controller: ConfigViewController,
    private readonly invalidateShell: () => void = () => {},
  ) {
    this.state = controller.snapshot();
    this.viewport.className = "config-viewport";
    this.viewport.setAttribute("aria-label", "Config");
    this.list.className = "config-list";
    this.list.setAttribute("role", "tree");
    this.viewport.append(this.list);
  }

  mount(root: HTMLElement): void {
    root.append(this.viewport);
    this.unsubscribe = this.controller.subscribe((state) => {
      this.state = state;
      this.render();
      if (this.mounted) this.invalidateShell();
    });
    this.mounted = true;
  }

  update(context: DestinationContext): void {
    if (context.destination.kind === "config") this.render();
  }

  handleInput(input: SemanticInput): boolean {
    return this.controller.handle(input);
  }

  diagnostics(): ConfigDiagnostics {
    return {
      ...configDiagnostics(
        this.state,
        this.controller.lastActivatedAgent(),
        this.renderRevision,
      ),
      ...this.controller.sectionDiagnostics(),
      scrollTop: Math.round(this.viewport.scrollTop),
      scrollHeight: Math.round(this.viewport.scrollHeight),
      duplicateDomRows:
        this.list.children.length -
        new Set(
          Array.from(this.list.children).map(
            (element) => (element as HTMLElement).dataset.rowHash,
          ),
        ).size,
    };
  }

  dispose(): void {
    this.mounted = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller.deactivate();
  }

  private render(): void {
    const wanted = new Set(this.state.projection.rows.map(({ id }) => id));
    for (const [id, element] of this.elements)
      if (!wanted.has(id)) {
        element.remove();
        this.elements.delete(id);
      }
    const ordered = this.state.projection.rows.map((row) =>
      this.renderRow(row),
    );
    this.list.append(...ordered);
    this.elements
      .get(this.state.focusedRowId)
      ?.scrollIntoView({ block: "nearest" });
    this.renderRevision++;
  }

  private renderRow(row: ConfigRow): HTMLElement {
    let element = this.elements.get(row.id);
    if (!element) {
      element = document.createElement("div");
      element.dataset.rowHash = diagnosticHash(row.id);
      element.setAttribute("role", "treeitem");
      this.elements.set(row.id, element);
    }
    const focused = row.id === this.state.focusedRowId;
    element.className = [
      "config-row",
      `config-${row.kind}`,
      focused ? "focused" : "",
    ]
      .filter(Boolean)
      .join(" ");
    element.style.setProperty("--config-depth", String(row.depth));
    element.setAttribute("aria-level", String(row.depth + 1));
    element.setAttribute("aria-selected", String(focused));
    if (row.foldable)
      element.setAttribute("aria-expanded", String(row.expanded));
    else element.removeAttribute("aria-expanded");
    const fold = document.createElement("span");
    fold.className = "config-fold";
    fold.textContent = row.foldable ? (row.expanded ? "−" : "+") : "·";
    fold.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "config-label";
    label.textContent = row.label;
    const detail = document.createElement("span");
    detail.className = "config-detail";
    detail.textContent = row.detail ?? "";
    detail.hidden = !row.detail;
    element.replaceChildren(fold, label, detail);
    return element;
  }
}
