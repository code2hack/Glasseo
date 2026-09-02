import { postNative } from "./native/bridge";
import {
  formatHidInputTrace,
  listenForHidInputTrace,
  type HidInputTraceEntry,
} from "./native/hidInputTrace";
import {
  listenForQualification,
  qualificationHeading,
  qualificationLandingActions,
  reduceQualification,
  type QualificationState,
} from "./native/qualification";
import { listenForSemanticInput } from "./native/semanticInput";
import { runWebViewProbe } from "./compat/webviewProbe";

const status = document.querySelector<HTMLElement>("#status");
const content = document.querySelector<HTMLElement>("main");

function renderQualification(
  state: QualificationState,
  hidInputTrace: HidInputTraceEntry[],
) {
  if (!content) return;
  content.replaceChildren();
  if (state.view === "landing") {
    const heading = document.createElement("h1");
    heading.textContent = "Input qualification";
    content.append(heading);
    qualificationLandingActions.forEach((label, index) => {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => {
        const mode = index === 0 ? "BUILT_IN" : "HID";
        postNative({ type: "qualification-start", mode });
      });
      content.append(button);
    });
    return;
  }

  const heading = document.createElement("h1");
  heading.textContent = qualificationHeading(state);
  const description = document.createElement("p");
  description.textContent = state.description ?? "";
  const prompt = document.createElement("p");
  prompt.className = "qualification-prompt";
  prompt.textContent = state.prompt ?? "";
  content.append(heading, description, prompt);
  if (state.error) {
    const error = document.createElement("p");
    error.className = "qualification-error";
    error.textContent = state.error;
    content.append(error);
  }
  if (state.candidateDisplay) {
    const identity = document.createElement("output");
    identity.textContent = state.candidateDisplay;
    content.append(identity);
  }
  if (state.mode === "HID") {
    const traceHeading = document.createElement("p");
    traceHeading.className = "hid-input-trace-heading";
    traceHeading.textContent = "Raw HID input";
    const trace = document.createElement("output");
    trace.className = "hid-input-trace";
    trace.setAttribute("aria-live", "polite");
    trace.textContent =
      formatHidInputTrace(hidInputTrace) || "No HID input received";
    content.append(traceHeading, trace);
  }
}

let qualification: QualificationState = { view: "landing" };
let hidInputTrace: HidInputTraceEntry[] = [];

async function main() {
  listenForQualification((message) => {
    qualification = reduceQualification(
      qualification,
      message.type === "qualification-landing"
        ? { type: "landing" }
        : { type: "native-state", snapshot: message },
    );
    renderQualification(qualification, hidInputTrace);
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
    }
  });
  listenForHidInputTrace((message) => {
    hidInputTrace = message.events;
    renderQualification(qualification, hidInputTrace);
  });
  listenForSemanticInput((input) =>
    postNative({
      type: "semantic-received",
      control: input.control,
      action: input.action,
      interactionId: input.interactionId,
    }),
  );
  postNative({ type: "hello" });
  const result = await runWebViewProbe();
  postNative({ type: "probe-result", ...result });
  if (status)
    status.textContent = result.passed
      ? "Device ready"
      : "Compatibility check failed";
}

void main().catch((error: unknown) => {
  if (status)
    status.textContent = error instanceof Error ? error.message : String(error);
});
