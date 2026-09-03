import type { SemanticInput } from "../../native/semanticInput";
import type { GlobalAgentDirectorySnapshot } from "../../directory/types";
import { ConfigController } from "../controller";
import { ConfigDestinationBody } from "../view";
import { HidConfigHarness } from "./harness";
import { HidConfigSection } from "./section";
import { hidControls, type HidBinding, type HidControl } from "./types";

declare global {
  interface Window {
    __glasseoConfigHidAcceptance?: {
      run(): Promise<Readonly<Record<string, unknown>>>;
    };
  }
}

window.__glasseoConfigHidAcceptance = {
  async run() {
    const root = document.querySelector<HTMLElement>("#agent-body");
    const header = document.querySelector<HTMLElement>("#agent-header");
    if (!root || !header) throw new Error("Application shell missing");
    const harness = new HidConfigHarness();
    const section = new HidConfigSection(harness.controller);
    const directory = new AcceptanceDirectory();
    const controller = new ConfigController(
      directory,
      { load: async () => null, put: async () => {} },
      () => false,
      Date.now,
      [section],
    );
    const view = new ConfigDestinationBody(controller);
    root.replaceChildren();
    root.dataset.destination = "config";
    view.mount(root);
    view.update({
      destination: { kind: "config", returnTo: null },
      timeline: null,
    });

    let id = 1;
    const press = async (control: "PRIMARY" | "DOWN") => {
      view.handleInput(input(control, id++));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await press("DOWN");
    await press("DOWN");
    await press("DOWN");
    await press("PRIMARY");
    await press("DOWN");
    await press("PRIMARY");
    const labels = visibleLabels(root);
    const captureCommand = harness.commands[0];
    harness.receive(capture("hid_1", "PRIMARY", "awaiting-down", 0));
    await tick();
    const bindingDetail = visibleLabels(root).find(
      (row) => row.label === "PRIMARY",
    )?.detail;
    harness.receive(
      capture("hid_1", "PRIMARY", "duplicate", 0, "duplicate_binding"),
    );
    await tick();
    const duplicateDetail = visibleLabels(root).find(
      (row) => row.label === "PRIMARY",
    )?.detail;
    harness.receive(bindingsState(1, { PRIMARY: "Key 96/304 · 057e:2007" }));
    await tick();

    for (let i = 0; i < 7; i++) await press("DOWN");
    await press("PRIMARY");
    const confirmationLabels = visibleLabels(root);
    const confirmDefault = root.querySelector(
      ".config-row.focused .config-label",
    )?.textContent;
    await press("DOWN");
    await press("PRIMARY");
    const resetCommand = harness.commands[1];
    harness.receive({
      type: "hid-bindings-reset-result",
      requestId: "hid_2",
      status: "ok",
      revision: 2,
    });
    await tick();
    harness.receive(bindingsState(2));
    await tick();

    const viewport = root.querySelector<HTMLElement>(".config-viewport")!;
    const body = root.getBoundingClientRect();
    const diagnostics = view.diagnostics();
    const result = {
      width: innerWidth,
      height: innerHeight,
      headerBottom: header.getBoundingClientRect().bottom,
      bodyTop: body.top,
      bodyBottom: body.bottom,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportScrollWidth: viewport.scrollWidth,
      viewportClientWidth: viewport.clientWidth,
      captureStarted:
        captureCommand?.type === "hid-binding-capture-start" &&
        captureCommand.control === "PRIMARY" &&
        captureCommand.requestId === "hid_1",
      sevenLabels: labels.map((row) => row.label),
      bindingDetail,
      duplicateDetail,
      duplicateRows: diagnostics.duplicateDomRows,
      resetRows: confirmationLabels.slice(-2).map((row) => row.label),
      confirmDefault,
      resetConfirmed:
        resetCommand?.type === "hid-bindings-reset" &&
        resetCommand.requestId === "hid_2",
      resetRestored: visibleLabels(root).some(
        (row) => row.label === "Reset HID bindings",
      ),
      diagnostics,
    };
    view.dispose();
    controller.dispose();
    return result;
  },
};

function visibleLabels(root: HTMLElement): { label: string; detail: string }[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".config-row")).map(
    (row) => ({
      label: row.querySelector(".config-label")?.textContent ?? "",
      detail: row.querySelector(".config-detail")?.textContent ?? "",
    }),
  );
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function bindingsState(
  revision: number,
  bound: Partial<Record<HidControl, string>> = {},
): HidBindingsStateMessage {
  const bindings: HidBinding[] = hidControls.map((control) => ({
    control,
    label: bound[control] ?? null,
    connected: true,
    builtInCapability:
      control === "COMMAND"
        ? "AVAILABLE_WITH_SUPPRESSION"
        : control === "UP" || control === "DOWN"
          ? "AVAILABLE_SAFE"
          : "UNAVAILABLE_BUILTIN",
  }));
  return { type: "hid-bindings-state", revision, bindings };
}

function capture(
  requestId: string,
  control: HidControl,
  phase: HidConfigHarnessPhase,
  revision: number,
  error: string | null = null,
) {
  return {
    type: "hid-binding-capture-state" as const,
    requestId,
    control,
    phase,
    revision,
    candidateLabel: phase === "awaiting-up" ? "Key 96/304 · 057e:2007" : null,
    error,
  };
}

type HidConfigHarnessPhase =
  | "idle"
  | "awaiting-down"
  | "awaiting-up"
  | "committed"
  | "duplicate"
  | "invalid"
  | "cancelled"
  | "timed-out";

type HidBindingsStateMessage = {
  type: "hid-bindings-state";
  revision: number;
  bindings: HidBinding[];
};

class AcceptanceDirectory {
  private readonly listeners = new Set<
    (snapshot: GlobalAgentDirectorySnapshot) => void
  >();
  private readonly value: GlobalAgentDirectorySnapshot = {
    hosts: new Map(),
    orderedAgents: [],
    current: null,
    destination: "config",
    restoring: false,
  };
  snapshot(): GlobalAgentDirectorySnapshot {
    return this.value;
  }
  subscribe(listener: (snapshot: GlobalAgentDirectorySnapshot) => void) {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }
}

function input(
  control: "PRIMARY" | "DOWN",
  interactionId: number,
): SemanticInput {
  return {
    type: "semantic-input",
    control,
    action: control === "DOWN" ? "BEGIN" : "SHORT",
    interactionId,
    timeMillis: interactionId,
  };
}
