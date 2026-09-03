import { HidConfigController } from "./controller";
import type { HidBindingPort, HidCommand, NativeHidMessage } from "./types";

export class HidConfigHarness implements HidBindingPort {
  readonly commands: HidCommand[] = [];
  private readonly listeners = new Set<(message: NativeHidMessage) => void>();
  readonly controller = new HidConfigController(this);

  post(command: HidCommand): void {
    this.commands.push(command);
  }

  subscribe(listener: (message: NativeHidMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  receive(message: NativeHidMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}
