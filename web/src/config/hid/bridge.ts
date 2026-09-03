import type {
  HidBinding,
  HidBindingPort,
  HidCommand,
  NativeHidMessage,
} from "./types";
import { hidControls } from "./types";

type NativePort = { postMessage(message: string): void };

export class WebViewHidBindingPort implements HidBindingPort {
  constructor(
    private readonly native: NativePort | undefined = window.glasseoNative,
  ) {}

  post(command: HidCommand): void {
    if (!this.native) throw new Error("Trusted native bridge unavailable");
    this.native.postMessage(JSON.stringify(command));
  }

  subscribe(listener: (message: NativeHidMessage) => void): () => void {
    const receive = (event: MessageEvent<unknown>) => {
      try {
        listener(decodeHidMessage(event.data));
      } catch {
        // Unknown or malformed native messages fail closed.
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }
}

export function decodeHidMessage(value: unknown): NativeHidMessage {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object")
    throw new Error("Invalid HID message");
  const message = parsed as Record<string, unknown>;
  if (
    message.type === "hid-bindings-state" &&
    exactKeys(message, ["type", "revision", "bindings"]) &&
    validRevision(message.revision) &&
    Array.isArray(message.bindings) &&
    validBindings(message.bindings)
  )
    return message as HidBindingsStateMessage;
  if (
    message.type === "hid-binding-capture-state" &&
    exactKeys(message, [
      "type",
      "requestId",
      "control",
      "phase",
      "revision",
      "candidateLabel",
      "error",
    ]) &&
    (message.requestId === null || validRequestId(message.requestId)) &&
    (message.control === null || isControl(message.control)) &&
    [
      "idle",
      "awaiting-down",
      "awaiting-up",
      "committed",
      "duplicate",
      "invalid",
      "cancelled",
      "timed-out",
    ].includes(message.phase as string) &&
    validRevision(message.revision) &&
    nullableString(message.candidateLabel) &&
    nullableString(message.error)
  )
    return message as HidCaptureStateMessage;
  if (
    message.type === "hid-bindings-reset-result" &&
    exactKeys(message, ["type", "requestId", "status", "revision"]) &&
    validRequestId(message.requestId) &&
    (message.status === "ok" || message.status === "storage_error") &&
    validRevision(message.revision)
  )
    return message as HidResetResultMessage;
  throw new Error("Unknown or malformed HID message");
}

type HidBindingsStateMessage = Extract<
  NativeHidMessage,
  { type: "hid-bindings-state" }
>;
type HidCaptureStateMessage = Extract<
  NativeHidMessage,
  { type: "hid-binding-capture-state" }
>;
type HidResetResultMessage = Extract<
  NativeHidMessage,
  { type: "hid-bindings-reset-result" }
>;

function validBindings(value: unknown[]): value is HidBinding[] {
  if (value.length !== hidControls.length) return false;
  const controls = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return false;
    const binding = item as Record<string, unknown>;
    if (
      !exactKeys(binding, [
        "control",
        "label",
        "connected",
        "builtInCapability",
      ]) ||
      !isControl(binding.control) ||
      !nullableString(binding.label) ||
      typeof binding.connected !== "boolean" ||
      ![
        "AVAILABLE_SAFE",
        "AVAILABLE_WITH_SUPPRESSION",
        "UNAVAILABLE_BUILTIN",
      ].includes(binding.builtInCapability as string) ||
      controls.has(binding.control)
    )
      return false;
    controls.add(binding.control);
  }
  return hidControls.every((control) => controls.has(control));
}

const isControl = (value: unknown): value is (typeof hidControls)[number] =>
  hidControls.includes(value as (typeof hidControls)[number]);
const validRevision = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const validRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => key in value);
