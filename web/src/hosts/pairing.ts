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
  | { status: "idle" | "scanning" | "validating" | "connecting" | "paired" }
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
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.scannerActive) return;
    this.scannerActive = true;
    this.set({ status: "scanning" });
    this.scanner.start();
  }

  cancel(): void {
    if (this.scannerActive) this.scanner.cancel();
  }

  close(): void {
    this.stopListening();
  }

  private async onScanner(message: QrScannerMessage): Promise<void> {
    if (!this.scannerActive) return;
    if (message.type === "scanner-state") {
      this.set({ status: "scanning" });
      return;
    }
    if (message.type === "scanner-cancelled") {
      this.scannerActive = false;
      this.set({ status: "idle" });
      return;
    }
    if (message.type === "scanner-error") {
      this.scannerActive = false;
      this.set({ status: "error", code: message.code });
      return;
    }
    this.scannerActive = false;
    this.set({ status: "validating" });
    try {
      const candidate = parsePairingOffer(message.value);
      this.set({ status: "connecting" });
      await this.registry.addCandidate(candidate);
      this.set({ status: "paired" });
    } catch (error) {
      this.set({
        status: "error",
        code: error instanceof HostError ? error.code : "connection_failure",
      });
    }
  }

  private set(state: PairingState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}
