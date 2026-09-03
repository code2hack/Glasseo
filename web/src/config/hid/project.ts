import { hidControls, type HidControl } from "./types";
import type { HidConfigState } from "./controller";

export const hidControlRowId = (control: HidControl) =>
  `hid-control:${control}` as const;
export const HID_RESET_ROW_ID = "hid-reset" as const;

export type HidConfigRow = Readonly<{
  id: ReturnType<typeof hidControlRowId> | typeof HID_RESET_ROW_ID;
  label: string;
  detail: string;
  control: HidControl | null;
}>;

export function projectHidConfig(
  state: HidConfigState,
): readonly HidConfigRow[] {
  const byControl = new Map(
    state.bindings.map((binding) => [binding.control, binding]),
  );
  return [
    ...hidControls.map((control) => {
      const binding = byControl.get(control);
      const capture = state.capture?.control === control ? state.capture : null;
      const detail = capture
        ? (capture.error ??
          capture.candidateLabel ??
          capture.phase.replace("-", " "))
        : binding?.label
          ? `${binding.label}${binding.connected ? "" : " · disconnected"}`
          : "Unbound";
      return { id: hidControlRowId(control), label: control, detail, control };
    }),
    {
      id: HID_RESET_ROW_ID,
      label: "Reset HID bindings",
      detail: state.resetConfirmation ? "Cancel · Confirm reset" : "",
      control: null,
    },
  ];
}
