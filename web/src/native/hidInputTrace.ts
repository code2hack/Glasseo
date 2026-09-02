export type HidInputTraceEntry = {
  sequence: number;
  action: "DOWN" | "UP" | "CANCEL";
  keyCode: number;
  scanCode: number;
  repeatCount: number;
  eventTimeMillis: number;
  receivedElapsedRealtimeMillis: number;
  eventSource: number;
  deviceId: number;
  descriptor: string;
  vendorId: number;
  productId: number;
  sources: number;
  physicalSource: "HID";
  pressDurationMillis: number | null;
  releaseToNextDownMillis: number | null;
  reason: string;
};

export type HidInputTrace = {
  type: "hid-input-trace";
  events: HidInputTraceEntry[];
};

export function decodeHidInputTrace(value: unknown): HidInputTrace {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object")
    throw new Error("Invalid HID input trace");
  const message = parsed as Record<string, unknown>;
  if (
    Object.keys(message).length !== 2 ||
    message.type !== "hid-input-trace" ||
    !Array.isArray(message.events) ||
    message.events.length > 8 ||
    !message.events.every(isTraceEntry)
  ) {
    throw new Error("Unknown or malformed HID input trace");
  }
  return message as HidInputTrace;
}

export function formatHidInputTrace(events: HidInputTraceEntry[]): string {
  return events
    .map(
      (event) =>
        `#${event.sequence} ${event.action} keyCode=${event.keyCode} scanCode=${event.scanCode} ` +
        `repeatCount=${event.repeatCount} eventTime=${event.eventTimeMillis} ` +
        `elapsed=${event.receivedElapsedRealtimeMillis} eventSource=${event.eventSource} ` +
        `deviceId=${event.deviceId} ` +
        `descriptor=${event.descriptor} vendorId=${event.vendorId} productId=${event.productId} ` +
        `sources=${event.sources} physicalSource=${event.physicalSource} ` +
        `duration=${event.pressDurationMillis ?? "-"} ` +
        `gap=${event.releaseToNextDownMillis ?? "-"} reason=${event.reason}`,
    )
    .join("\n");
}

export function listenForHidInputTrace(
  listener: (message: HidInputTrace) => void,
): () => void {
  const receive = (event: MessageEvent<unknown>) => {
    try {
      listener(decodeHidInputTrace(event.data));
    } catch {
      // Unknown native messages fail closed.
    }
  };
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
}

function isTraceEntry(value: unknown): value is HidInputTraceEntry {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    Object.keys(event).length === 17 &&
    isPositiveInteger(event.sequence) &&
    ["DOWN", "UP", "CANCEL"].includes(event.action as string) &&
    isNonnegativeInteger(event.keyCode) &&
    isNonnegativeInteger(event.scanCode) &&
    isNonnegativeInteger(event.repeatCount) &&
    isNonnegativeInteger(event.eventTimeMillis) &&
    isNonnegativeInteger(event.receivedElapsedRealtimeMillis) &&
    isNonnegativeInteger(event.eventSource) &&
    Number.isSafeInteger(event.deviceId) &&
    typeof event.descriptor === "string" &&
    isNonnegativeInteger(event.vendorId) &&
    isNonnegativeInteger(event.productId) &&
    isNonnegativeInteger(event.sources) &&
    event.physicalSource === "HID" &&
    isNullableNonnegativeInteger(event.pressDurationMillis) &&
    isNullableNonnegativeInteger(event.releaseToNextDownMillis) &&
    typeof event.reason === "string" &&
    event.reason.length > 0
  );
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableNonnegativeInteger(value: unknown): boolean {
  return value === null || isNonnegativeInteger(value);
}
