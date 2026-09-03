import { HID_KEYS_SECTION_ID } from "../project";
import type {
  ConfigActionResult,
  ConfigRow,
  ConfigRowAction,
  ConfigRowId,
  ConfigSectionProvider,
} from "../types";
import { HidConfigController } from "./controller";
import {
  HID_RESET_CANCEL_ROW_ID,
  HID_RESET_CONFIRM_ROW_ID,
  HID_RESET_ROW_ID,
  hidControlRowId,
  projectHidConfig,
} from "./project";
import { hidControls, type HidControl } from "./types";

const BIND = "hid-bind";
const RESET = "hid-reset";
const CANCEL_RESET = "hid-reset-cancel";
const CONFIRM_RESET = "hid-reset-confirm";

export class HidConfigSection implements ConfigSectionProvider {
  readonly sectionId = HID_KEYS_SECTION_ID;
  private readonly handled = new Set<number>();

  constructor(private readonly controller: HidConfigController) {}

  rows(_expanded: ReadonlySet<ConfigRowId>): readonly ConfigRow[] {
    void _expanded;
    return projectHidConfig(this.controller.snapshot()).map((row) => ({
      id: row.id,
      parentId: HID_KEYS_SECTION_ID,
      kind: "action",
      depth: 1,
      label: row.label,
      detail: row.detail || null,
      foldable: false,
      expanded: false,
      agentKey: null,
      action: actionFor(row.id, row.control),
    }));
  }

  subscribe(listener: () => void): () => void {
    return this.controller.subscribe(() => listener());
  }

  activate(action: ConfigRowAction, interactionId: number): ConfigActionResult {
    if (action.sectionId !== this.sectionId || this.handled.has(interactionId))
      return;
    this.handled.add(interactionId);
    if (this.handled.size > 64)
      this.handled.delete(this.handled.values().next().value!);
    switch (action.type) {
      case BIND: {
        const control = action.targetId as HidControl | null;
        if (!control || !hidControls.includes(control)) return;
        this.controller.startCapture(control);
        return { focusRowId: hidControlRowId(control) };
      }
      case RESET:
        this.controller.openResetConfirmation();
        return { focusRowId: HID_RESET_CANCEL_ROW_ID };
      case CANCEL_RESET:
        this.controller.cancelReset();
        return { focusRowId: HID_RESET_ROW_ID };
      case CONFIRM_RESET:
        this.controller.confirmReset();
        return { focusRowId: HID_RESET_ROW_ID };
      default:
        return;
    }
  }

  deactivate(): void {
    this.controller.cancelCapture();
  }

  dispose(): void {
    this.controller.dispose();
  }

  diagnostics() {
    const state = this.controller.snapshot();
    return {
      hidRevision: state.revision,
      hidCapturePhase: state.capture?.phase ?? "idle",
    };
  }
}

function actionFor(
  id: string,
  control: HidControl | null,
): ConfigRow["action"] {
  if (control)
    return { sectionId: HID_KEYS_SECTION_ID, type: BIND, targetId: control };
  if (id === HID_RESET_ROW_ID)
    return { sectionId: HID_KEYS_SECTION_ID, type: RESET, targetId: null };
  if (id === HID_RESET_CANCEL_ROW_ID)
    return {
      sectionId: HID_KEYS_SECTION_ID,
      type: CANCEL_RESET,
      targetId: null,
    };
  if (id === HID_RESET_CONFIRM_ROW_ID)
    return {
      sectionId: HID_KEYS_SECTION_ID,
      type: CONFIRM_RESET,
      targetId: null,
    };
  return null;
}
