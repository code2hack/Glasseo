import type {
  HidBinding,
  HidBindingPort,
  HidCaptureStateMessage,
  HidControl,
  NativeHidMessage,
} from "./types";

export type HidConfigState = Readonly<{
  revision: number;
  bindings: readonly HidBinding[];
  capture: HidCaptureStateMessage | null;
  resetConfirmation: boolean;
  error: string | null;
}>;

export class HidConfigController {
  private value: HidConfigState = {
    revision: 0,
    bindings: [],
    capture: null,
    resetConfirmation: false,
    error: null,
  };
  private readonly listeners = new Set<(state: HidConfigState) => void>();
  private readonly unsubscribe: () => void;
  private requestSequence = 0;
  private activeCaptureRequestId: string | null = null;
  private activeResetRequestId: string | null = null;

  constructor(private readonly port: HidBindingPort) {
    this.unsubscribe = port.subscribe((message) => this.receive(message));
  }

  snapshot(): HidConfigState {
    return this.value;
  }

  subscribe(listener: (state: HidConfigState) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => this.listeners.delete(listener);
  }

  restore(): void {
    this.port.post({ type: "hid-bindings-get" });
  }

  startCapture(control: HidControl): void {
    const requestId = this.nextRequestId();
    this.activeCaptureRequestId = requestId;
    this.value = {
      ...this.value,
      capture: null,
      resetConfirmation: false,
      error: null,
    };
    this.publish();
    this.port.post({ type: "hid-binding-capture-start", control, requestId });
  }

  cancelCapture(): void {
    const requestId = this.activeCaptureRequestId;
    if (requestId)
      this.port.post({ type: "hid-binding-capture-cancel", requestId });
  }

  openResetConfirmation(): void {
    this.value = { ...this.value, resetConfirmation: true, error: null };
    this.publish();
  }

  cancelReset(): void {
    this.value = { ...this.value, resetConfirmation: false };
    this.publish();
  }

  confirmReset(): void {
    if (!this.value.resetConfirmation) return;
    const requestId = this.nextRequestId();
    this.activeResetRequestId = requestId;
    this.port.post({ type: "hid-bindings-reset", requestId });
  }

  dispose(): void {
    this.cancelCapture();
    this.unsubscribe();
    this.listeners.clear();
  }

  private receive(message: NativeHidMessage): void {
    if (message.revision < this.value.revision) return;
    if (message.type === "hid-bindings-state") {
      this.value = {
        ...this.value,
        revision: message.revision,
        bindings: message.bindings,
        error: null,
      };
    } else if (message.type === "hid-binding-capture-state") {
      if (message.requestId !== this.activeCaptureRequestId) return;
      if (!["awaiting-down", "awaiting-up"].includes(message.phase))
        this.activeCaptureRequestId = null;
      this.value = {
        ...this.value,
        revision: Math.max(this.value.revision, message.revision),
        capture: message,
        error: message.error,
      };
    } else {
      if (message.requestId !== this.activeResetRequestId) return;
      this.activeResetRequestId = null;
      this.value = {
        ...this.value,
        revision: message.revision,
        resetConfirmation: message.status !== "ok",
        error: message.status === "ok" ? null : message.status,
      };
    }
    this.publish();
  }

  private nextRequestId(): string {
    return `hid_${++this.requestSequence}`;
  }

  private publish(): void {
    for (const listener of this.listeners) this.notify(listener);
  }

  private notify(listener: (state: HidConfigState) => void): void {
    try {
      listener(this.value);
    } catch {
      // One UI observer cannot block HID state delivery.
    }
  }
}
