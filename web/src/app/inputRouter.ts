import type { AgentPagerController } from "../agent-pages/pager";
import type { SemanticInput } from "../native/semanticInput";
import type { DestinationHost } from "./destinationHost";

export class InputRouter {
  private readonly handledTerminals = new Set<number>();

  constructor(
    private readonly destination: Pick<DestinationHost, "handleInput">,
    private readonly pager: Pick<AgentPagerController, "handle">,
  ) {}

  handle(input: SemanticInput): void {
    const terminal = ["SHORT", "LONG", "DOUBLE"].includes(input.action);
    if (terminal && this.handledTerminals.has(input.interactionId)) return;
    if (terminal) {
      this.handledTerminals.add(input.interactionId);
      if (this.handledTerminals.size > 64)
        this.handledTerminals.delete(
          this.handledTerminals.values().next().value!,
        );
    }
    if (this.destination.handleInput(input)) return;
    this.pager.handle(input);
  }
}
