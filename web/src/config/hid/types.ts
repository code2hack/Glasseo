export const hidControls = [
  "PRIMARY",
  "SECONDARY",
  "COMMAND",
  "LEFT",
  "RIGHT",
  "UP",
  "DOWN",
] as const;

export type HidControl = (typeof hidControls)[number];
export type BuiltInCapability =
  | "AVAILABLE_SAFE"
  | "AVAILABLE_WITH_SUPPRESSION"
  | "UNAVAILABLE_BUILTIN";
export type HidCapturePhase =
  | "idle"
  | "awaiting-down"
  | "awaiting-up"
  | "committed"
  | "duplicate"
  | "invalid"
  | "cancelled"
  | "timed-out";

export type HidBinding = Readonly<{
  control: HidControl;
  label: string | null;
  connected: boolean;
  builtInCapability: BuiltInCapability;
}>;

export type HidBindingsStateMessage = Readonly<{
  type: "hid-bindings-state";
  revision: number;
  bindings: readonly HidBinding[];
}>;

export type HidCaptureStateMessage = Readonly<{
  type: "hid-binding-capture-state";
  requestId: string | null;
  control: HidControl | null;
  phase: HidCapturePhase;
  revision: number;
  candidateLabel: string | null;
  error: string | null;
}>;

export type HidResetResultMessage = Readonly<{
  type: "hid-bindings-reset-result";
  requestId: string;
  status: "ok" | "storage_error";
  revision: number;
}>;

export type NativeHidMessage =
  | HidBindingsStateMessage
  | HidCaptureStateMessage
  | HidResetResultMessage;

export type HidCommand =
  | { type: "hid-bindings-get" }
  | {
      type: "hid-binding-capture-start";
      control: HidControl;
      requestId: string;
    }
  | { type: "hid-binding-capture-cancel"; requestId: string }
  | { type: "hid-bindings-reset"; requestId: string };

export interface HidBindingPort {
  post(command: HidCommand): void;
  subscribe(listener: (message: NativeHidMessage) => void): () => void;
}
