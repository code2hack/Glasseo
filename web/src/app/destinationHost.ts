import type { AgentDestination } from "../agent-pages/pager";
import type { AgentTimelineSnapshot } from "../timeline/types";
import type { SemanticInput } from "../native/semanticInput";
import { timelineKey } from "../timeline/normalize";

export type DestinationContext = Readonly<{
  destination: AgentDestination;
  timeline: AgentTimelineSnapshot | null;
}>;

export interface DestinationBody {
  mount(root: HTMLElement): void;
  update(context: DestinationContext): void;
  handleInput(input: SemanticInput): boolean;
  dispose(): void;
}

export type DestinationBodyFactory = () => DestinationBody;
export type DestinationBodyFactories = Readonly<{
  timeline: DestinationBodyFactory;
  draft: DestinationBodyFactory;
  config: DestinationBodyFactory;
}>;

export class DestinationHost {
  private active: DestinationBody | null = null;
  private identity = "";
  rendererLossCount = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly factories: DestinationBodyFactories,
  ) {}

  update(context: DestinationContext): void {
    try {
      const identity = destinationIdentity(context.destination);
      if (identity !== this.identity) {
        this.active?.dispose();
        this.root.replaceChildren();
        this.active = this.factories[destinationName(context.destination)]();
        this.active.mount(this.root);
        this.identity = identity;
      }
      this.active?.update(context);
    } catch {
      this.rendererLossCount++;
      try {
        this.active?.dispose();
      } catch {
        // A failed renderer remains fenced.
      }
      this.active = null;
      this.identity = "";
    }
  }

  handleInput(input: SemanticInput): boolean {
    try {
      return this.active?.handleInput(input) ?? false;
    } catch {
      this.rendererLossCount++;
      return false;
    }
  }

  dispose(): void {
    this.active?.dispose();
    this.active = null;
    this.identity = "";
  }
}

export class PlaceholderDestinationBody implements DestinationBody {
  private readonly heading = document.createElement("h1");
  private readonly message = document.createElement("p");

  mount(root: HTMLElement): void {
    root.append(this.heading, this.message);
  }

  update(context: DestinationContext): void {
    const name = destinationName(context.destination);
    const title = name[0]!.toUpperCase() + name.slice(1);
    this.heading.textContent = title;
    this.message.textContent = `${title} content arrives in a later milestone.`;
  }

  handleInput(): boolean {
    return false;
  }

  dispose(): void {}
}

function destinationName(
  destination: AgentDestination,
): keyof DestinationBodyFactories {
  return destination.kind === "config" ? "config" : destination.pane;
}

function destinationIdentity(destination: AgentDestination): string {
  return destination.kind === "config"
    ? "config"
    : `${destination.pane}:${timelineKey(destination.key)}`;
}
