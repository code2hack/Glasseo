export type ProbeResult = {
  type: "probe-result";
  passed: boolean;
  checks: Record<string, boolean>;
  details: Record<string, string>;
};

export const requiredProbeChecks = [
  "localHttpsOrigin",
  "textCodec",
  "promiseScheduling",
  "structuredStorageReopen",
  "secureRandom",
  "paseoRelayCrypto",
  "binaryWss",
  "untrustedBridgeRejected",
  "remoteNavigationRejected",
] as const;

export type NativeMessage =
  | { type: "hello" }
  | { type: "scanner-start" }
  | { type: "scanner-cancel" }
  | { type: "host-media-cleanup"; requestId: number; serverId: string }
  | { type: "qualification-start"; mode: "BUILT_IN" | "HID" }
  | {
      type: "qualification-rendered";
      sessionId: string;
      revision: number;
      stepIndex: number;
      phase:
        | "AWAITING_FIRST"
        | "SETTLING_FIRST"
        | "AWAITING_CONFIRMATION"
        | "SETTLING_SECOND"
        | "STEP_CONFIRMED";
    }
  | {
      type: "hid-qualification-rendered";
      sessionId: string;
      revision: number;
      stage: "BINDING" | "RECOGNITION" | "COMPLETE";
      stepIndex: number;
      phase: "AWAITING_INPUT" | "STEP_CONFIRMED" | "COMPLETE";
    }
  | ProbeResult
  | {
      type: "semantic-received";
      control: string;
      action: string;
      interactionId: number;
    };

type NativePort = { postMessage(message: string): void };

declare global {
  interface Window {
    glasseoNative?: NativePort;
  }
}

export function decodeNativeMessage(value: string): NativeMessage {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    throw new Error("Invalid native message");
  }
  const message = parsed as Record<string, unknown>;
  if (message.type === "hello") return { type: "hello" };
  if (
    (message.type === "scanner-start" || message.type === "scanner-cancel") &&
    Object.keys(message).length === 1
  )
    return message as NativeMessage;
  if (
    message.type === "host-media-cleanup" &&
    Object.keys(message).length === 3 &&
    Number.isSafeInteger(message.requestId) &&
    (message.requestId as number) > 0 &&
    typeof message.serverId === "string" &&
    message.serverId.length > 0
  )
    return message as NativeMessage;
  if (
    message.type === "qualification-start" &&
    Object.keys(message).length === 2 &&
    (message.mode === "BUILT_IN" || message.mode === "HID")
  ) {
    return message as NativeMessage;
  }
  if (
    message.type === "qualification-rendered" &&
    Object.keys(message).length === 5 &&
    typeof message.sessionId === "string" &&
    message.sessionId.length > 0 &&
    Number.isSafeInteger(message.revision) &&
    (message.revision as number) > 0 &&
    Number.isSafeInteger(message.stepIndex) &&
    (message.stepIndex as number) >= 0 &&
    (message.stepIndex as number) < 10 &&
    [
      "AWAITING_FIRST",
      "SETTLING_FIRST",
      "AWAITING_CONFIRMATION",
      "SETTLING_SECOND",
      "STEP_CONFIRMED",
    ].includes(message.phase as string)
  ) {
    return message as NativeMessage;
  }
  if (
    message.type === "hid-qualification-rendered" &&
    Object.keys(message).length === 6 &&
    typeof message.sessionId === "string" &&
    message.sessionId.length > 0 &&
    Number.isSafeInteger(message.revision) &&
    (message.revision as number) > 0 &&
    ["BINDING", "RECOGNITION", "COMPLETE"].includes(message.stage as string) &&
    Number.isSafeInteger(message.stepIndex) &&
    (message.stepIndex as number) >= 0 &&
    (message.stepIndex as number) <= 10 &&
    ["AWAITING_INPUT", "STEP_CONFIRMED", "COMPLETE"].includes(
      message.phase as string,
    )
  ) {
    return message as NativeMessage;
  }
  if (
    message.type === "semantic-received" &&
    Object.keys(message).length === 4 &&
    typeof message.control === "string" &&
    typeof message.action === "string" &&
    Number.isSafeInteger(message.interactionId) &&
    (message.interactionId as number) > 0
  ) {
    return message as NativeMessage;
  }
  if (
    message.type === "probe-result" &&
    typeof message.passed === "boolean" &&
    isBooleanRecord(message.checks) &&
    isStringRecord(message.details) &&
    hasExactKeys(message.checks) &&
    hasExactKeys(message.details) &&
    message.passed === Object.values(message.checks).every(Boolean)
  ) {
    return message as ProbeResult;
  }
  throw new Error("Unknown or malformed native message");
}

export function isPassingProbeResult(message: ProbeResult): boolean {
  return (
    message.passed &&
    hasExactKeys(message.checks) &&
    hasExactKeys(message.details) &&
    Object.values(message.checks).every(Boolean)
  );
}

export function postNative(message: NativeMessage): void {
  if (!window.glasseoNative)
    throw new Error("Trusted native bridge unavailable");
  window.glasseoNative.postMessage(JSON.stringify(message));
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value).every((item) => typeof item === "boolean")
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === requiredProbeChecks.length &&
    requiredProbeChecks.every((key) => keys.includes(key))
  );
}
