import { HostRegistry } from "./registry";
import { HostError, type HostErrorCode } from "./types";
import { parsePairingOffer } from "./offer";
import {
  cancelQrScanner,
  listenForQrScanner,
  startQrScanner,
  type QrScannerMessage,
} from "../native/qrScanner";

type PairingErrorCode =
  | HostErrorCode
  | "camera_unavailable"
  | "decode_error"
  | "busy";

export type PairingState =
  | { status: "idle" | "scanning" | "validating" | "connecting" }
  | { status: "paired"; serverId: string }
  | { status: "cancelled" }
  | { status: "error"; code: PairingErrorCode };

type ScannerPort = {
  listen(listener: (message: QrScannerMessage) => void): () => void;
  start(): void;
  cancel(): void;
};

const scannerPort: ScannerPort = {
  listen: listenForQrScanner,
  start: startQrScanner,
  cancel: cancelQrScanner,
};

export class PairingController {
  private state: PairingState = { status: "idle" };
  private scannerActive = false;
  private operation = 0;
  private abort: AbortController | null = null;
  private readonly listeners = new Set<(state: PairingState) => void>();
  private readonly stopListening: () => void;

  constructor(
    private readonly registry: HostRegistry,
    private readonly scanner: ScannerPort = scannerPort,
  ) {
    this.stopListening = scanner.listen(
      (message) => void this.onScanner(message),
    );
  }

  subscribe(listener: (state: PairingState) => void): () => void {
    this.listeners.add(listener);
    try {
      listener(this.state);
    } catch {
      // Subscribers cannot affect pairing control flow.
    }
    return () => this.listeners.delete(listener);
  }

  snapshot(): PairingState {
    return this.state;
  }

  start(): void {
    if (this.scannerActive || this.abort) return;
    this.operation++;
    this.scannerActive = true;
    this.set({ status: "scanning" });
    this.scanner.start();
  }

  cancel(): void {
    if (!this.scannerActive && !this.abort) return;
    this.operation++;
    if (this.scannerActive) this.scanner.cancel();
    this.scannerActive = false;
    this.abort?.abort();
    this.abort = null;
    this.set({ status: "cancelled" });
  }

  close(): void {
    this.cancel();
    this.stopListening();
  }

  private async onScanner(message: QrScannerMessage): Promise<void> {
    if (!this.scannerActive) return;
    const operation = this.operation;
    if (message.type === "scanner-state") {
      this.set({ status: "scanning" });
      return;
    }
    if (message.type === "scanner-cancelled") {
      this.scannerActive = false;
      if (operation === this.operation) this.set({ status: "cancelled" });
      return;
    }
    if (message.type === "scanner-error") {
      this.scannerActive = false;
      this.set({ status: "error", code: message.code });
      return;
    }
    this.scannerActive = false;
    this.abort = new AbortController();
    this.set({ status: "validating" });
    try {
      const candidate = parsePairingOffer(message.value);
      this.set({ status: "connecting" });
      const profile = await this.registry.addCandidate(
        candidate,
        this.abort.signal,
      );
      if (operation === this.operation)
        this.set({ status: "paired", serverId: profile.serverId });
    } catch (error) {
      if (operation !== this.operation) return;
      this.set({
        status: "error",
        code: error instanceof HostError ? error.code : "connection_failure",
      });
    } finally {
      if (operation === this.operation) this.abort = null;
    }
  }

  private set(state: PairingState): void {
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // Subscribers cannot affect pairing control flow.
      }
    }
  }
}
