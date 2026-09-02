import { postNative } from "./bridge";

export type QrScannerMessage =
  | { type: "scanner-state"; state: "requesting-permission" | "scanning" }
  | { type: "scanner-result"; value: string }
  | {
      type: "scanner-error";
      code: "camera_denied" | "camera_unavailable" | "decode_error" | "busy";
    }
  | { type: "scanner-cancelled" };

export function decodeQrScannerMessage(value: unknown): QrScannerMessage {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object")
    throw new Error("Invalid scanner message");
  const message = parsed as Record<string, unknown>;
  if (
    message.type === "scanner-state" &&
    Object.keys(message).length === 2 &&
    (message.state === "requesting-permission" || message.state === "scanning")
  )
    return message as QrScannerMessage;
  if (
    message.type === "scanner-result" &&
    Object.keys(message).length === 2 &&
    typeof message.value === "string" &&
    message.value.length > 0
  )
    return message as QrScannerMessage;
  if (
    message.type === "scanner-error" &&
    Object.keys(message).length === 2 &&
    ["camera_denied", "camera_unavailable", "decode_error", "busy"].includes(
      message.code as string,
    )
  )
    return message as QrScannerMessage;
  if (message.type === "scanner-cancelled" && Object.keys(message).length === 1)
    return { type: "scanner-cancelled" };
  throw new Error("Unknown or malformed scanner message");
}

export function listenForQrScanner(
  listener: (message: QrScannerMessage) => void,
): () => void {
  const receive = (event: MessageEvent<unknown>) => {
    try {
      listener(decodeQrScannerMessage(event.data));
    } catch {
      // Unknown native messages fail closed.
    }
  };
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
}

export const startQrScanner = () => postNative({ type: "scanner-start" });
export const cancelQrScanner = () => postNative({ type: "scanner-cancel" });
