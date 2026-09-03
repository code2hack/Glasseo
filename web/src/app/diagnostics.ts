import { postNative } from "../native/bridge";
import {
  formatHidInputTrace,
  listenForHidInputTrace,
  type HidInputTrace,
} from "../native/hidInputTrace";
import {
  listenForQualification,
  qualificationHeading,
  qualificationLandingActions,
  reduceQualification,
  type QualificationState,
} from "../native/qualification";
import type { PairingController, PairingState } from "../hosts/pairing";

export function setupDiagnostics(pairing: PairingController): () => void {
  const root = document.querySelector<HTMLElement>("#diagnostics");
  const hosts = document.querySelector<HTMLElement>("#hosts");
  if (!root || !hosts) return () => {};
  let qualification: QualificationState = { view: "landing" };
  let hidInputTrace: HidInputTrace = {
    type: "hid-input-trace",
    events: [],
    totalRawReceipts: 0,
    totalDecisions: 0,
    droppedRecords: 0,
    attempt: null,
  };
  let pairingState: PairingState = { status: "idle" };
  const renderHosts = () => {
    const state = document.createElement("output");
    state.id = "pairing-state";
    state.textContent =
      pairingState.status === "error"
        ? `Pairing error: ${pairingState.code}`
        : pairingState.status;
    const add = document.createElement("button");
    add.textContent = "Scan Paseo host";
    add.addEventListener("click", () => pairing.start());
    hosts.replaceChildren(add, state);
  };
  const unsubscribePairing = pairing.subscribe((state) => {
    pairingState = state;
    renderHosts();
  });
  const unsubscribeQualification = listenForQualification((message) => {
    qualification = reduceQualification(
      qualification,
      message.type === "qualification-landing"
        ? { type: "landing" }
        : { type: "native-state", snapshot: message },
    );
    root.hidden = false;
    document.querySelector<HTMLElement>("#app")?.setAttribute("hidden", "");
    renderQualification(root, qualification, hidInputTrace);
    if (
      message.type === "qualification-state" &&
      qualification.sessionId === message.sessionId &&
      qualification.revision === message.revision
    ) {
      postNative({
        type: "qualification-rendered",
        sessionId: message.sessionId,
        revision: message.revision,
        stepIndex: message.stepIndex,
        phase: message.phase,
      });
    } else if (
      message.type === "hid-qualification-state" &&
      qualification.sessionId === message.sessionId &&
      qualification.revision === message.revision
    ) {
      postNative({
        type: "hid-qualification-rendered",
        sessionId: message.sessionId,
        revision: message.revision,
        stage: message.stage,
        stepIndex: message.stepIndex,
        phase: message.phase,
      });
    }
  });
  const unsubscribeHid = listenForHidInputTrace((message) => {
    hidInputTrace = message;
    if (!root.hidden) renderQualification(root, qualification, hidInputTrace);
  });
  return () => {
    unsubscribePairing();
    unsubscribeQualification();
    unsubscribeHid();
  };
}

function renderQualification(
  root: HTMLElement,
  state: QualificationState,
  hidInputTrace: HidInputTrace,
): void {
  root.replaceChildren();
  const heading = document.createElement("h1");
  if (state.view === "landing") {
    heading.textContent = "Input qualification";
    root.append(heading);
    qualificationLandingActions.forEach((label, index) => {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () =>
        postNative({
          type: "qualification-start",
          mode: index === 0 ? "BUILT_IN" : "HID",
        }),
      );
      root.append(button);
    });
    return;
  }
  heading.textContent = qualificationHeading(state);
  const description = document.createElement("p");
  description.textContent = state.description ?? "";
  const prompt = document.createElement("p");
  prompt.className = "qualification-prompt";
  prompt.textContent = state.prompt ?? "";
  root.append(heading, description, prompt);
  if (state.error) {
    const error = document.createElement("p");
    error.className = "qualification-error";
    error.textContent = state.error;
    root.append(error);
  }
  if (state.candidateDisplay) {
    const identity = document.createElement("output");
    identity.textContent = state.candidateDisplay;
    root.append(identity);
  }
  if (state.mode !== "HID") return;
  const trace = document.createElement("output");
  trace.className = "hid-input-trace";
  trace.textContent =
    formatHidInputTrace(hidInputTrace.events) || "No HID input received";
  root.append(trace);
}
