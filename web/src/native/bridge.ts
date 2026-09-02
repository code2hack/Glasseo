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
