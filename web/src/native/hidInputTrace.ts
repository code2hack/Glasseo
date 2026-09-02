import type { HidQualificationPhase } from "./qualification";

const hidAttemptOperations = [
  "SHORT_PRIMARY",
  "LONG_PRIMARY",
  "LONG_SECONDARY",
  "DOUBLE_SECONDARY",
  "SHORT_COMMAND",
  "LONG_COMMAND",
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
] as const;

export type HidAttemptOperation = (typeof hidAttemptOperations)[number];

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
  totalRawReceipts: number;
  totalDecisions: number;
  droppedRecords: 0;
  attempt: HidAttemptMarker | null;
};

export type HidAttemptMarker = {
  attemptId: string;
  operation: HidAttemptOperation;
  phase: HidQualificationPhase;
  supervisorElapsedRealtimeMillis: number;
  startedElapsedRealtimeMillis: number;
  watchdogDeadlineMillis: number;
  status:
    | "AWAITING_ANDROID_EVENT"
    | "ANDROID_EVENT_RECEIVED"
    | "NO_ANDROID_EVENT";
  firstRawSequence: number | null;
};

export function decodeHidInputTrace(value: unknown): HidInputTrace {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object")
    throw new Error("Invalid HID input trace");
  const message = parsed as Record<string, unknown>;
  if (
    Object.keys(message).length !== 6 ||
    message.type !== "hid-input-trace" ||
    !Array.isArray(message.events) ||
    message.events.length > 8 ||
    !isNonnegativeInteger(message.totalRawReceipts) ||
    !isNonnegativeInteger(message.totalDecisions) ||
    message.droppedRecords !== 0 ||
    !isAttemptMarker(message.attempt) ||
    !message.events.every(isTraceEntry)
  ) {
    throw new Error("Unknown or malformed HID input trace");
  }
  return message as HidInputTrace;
}

function isAttemptMarker(value: unknown): value is HidAttemptMarker | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const marker = value as Record<string, unknown>;
  return (
    Object.keys(marker).length === 8 &&
    typeof marker.attemptId === "string" &&
    /^[A-Za-z0-9_-]{1,32}$/.test(marker.attemptId) &&
    hidAttemptOperations.includes(marker.operation as HidAttemptOperation) &&
    ["AWAITING_INPUT", "STEP_CONFIRMED", "COMPLETE"].includes(
      marker.phase as string,
    ) &&
    isNonnegativeInteger(marker.supervisorElapsedRealtimeMillis) &&
    isNonnegativeInteger(marker.startedElapsedRealtimeMillis) &&
    isNonnegativeInteger(marker.watchdogDeadlineMillis) &&
    [
      "AWAITING_ANDROID_EVENT",
      "ANDROID_EVENT_RECEIVED",
      "NO_ANDROID_EVENT",
    ].includes(marker.status as string) &&
    (marker.firstRawSequence === null ||
      isPositiveInteger(marker.firstRawSequence))
  );
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
