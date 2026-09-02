import { postNative } from "./native/bridge";
import {
  formatHidInputTrace,
  listenForHidInputTrace,
  type HidInputTrace,
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
import { HostRegistry } from "./hosts/registry";
import { IndexedDbHostStorage } from "./hosts/storage";
import { PairingController, type PairingState } from "./hosts/pairing";
import { DirectoryCoordinator } from "./directory/coordinator";
import { IndexedDbDirectoryStorage } from "./directory/storage";
import type { GlobalAgentDirectorySnapshot } from "./directory/types";

const status = document.querySelector<HTMLElement>("#status");
const content = document.querySelector<HTMLElement>("main");

function renderQualification(
  state: QualificationState,
  hidInputTrace: HidInputTrace,
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
    traceHeading.textContent =
      `Raw HID input — receipts=${hidInputTrace.totalRawReceipts} ` +
      `decisions=${hidInputTrace.totalDecisions} dropped=${hidInputTrace.droppedRecords}`;
    const trace = document.createElement("output");
    trace.className = "hid-input-trace";
    trace.setAttribute("aria-live", "polite");
    trace.textContent =
      formatHidInputTrace(hidInputTrace.events) || "No HID input received";
    content.append(traceHeading, trace);
    if (hidInputTrace.attempt) {
      const attempt = document.createElement("output");
      attempt.className = "hid-attempt-marker";
      attempt.textContent =
        `Attempt ${hidInputTrace.attempt.attemptId} ${hidInputTrace.attempt.operation} ` +
        `${hidInputTrace.attempt.phase}: ${hidInputTrace.attempt.status} ` +
        `supervisor=${hidInputTrace.attempt.supervisorElapsedRealtimeMillis} ` +
        `received=${hidInputTrace.attempt.startedElapsedRealtimeMillis}`;
      content.append(attempt);
    }
  }
}

let qualification: QualificationState = { view: "landing" };
let hidInputTrace: HidInputTrace = {
  type: "hid-input-trace",
  events: [],
  totalRawReceipts: 0,
  totalDecisions: 0,
  droppedRecords: 0,
  attempt: null,
};

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
  listenForHidInputTrace((message) => {
    hidInputTrace = message;
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
  const registry = new HostRegistry(new IndexedDbHostStorage());
  const pairing = new PairingController(registry);
  const directory = new DirectoryCoordinator(
    registry,
    new IndexedDbDirectoryStorage(),
  );
  setupHostAcceptance(registry, pairing, directory);
  void directory.restore();
  const result = await runWebViewProbe();
  postNative({ type: "probe-result", ...result });
  if (status)
    status.textContent = result.passed
      ? "Device ready"
      : "Compatibility check failed";
}

function setupHostAcceptance(
  registry: HostRegistry,
  pairing: PairingController,
  directory: DirectoryCoordinator,
): void {
  const hosts = document.querySelector<HTMLElement>("#hosts");
  if (!hosts) return;
  let pairingState: PairingState = { status: "idle" };
  let registryState = registry.snapshot();
  let directoryState: GlobalAgentDirectorySnapshot = directory.snapshot();
  const render = () => {
    const title = document.createElement("h2");
    title.textContent = "Relay hosts";
    const state = document.createElement("p");
    state.id = "pairing-state";
    state.textContent =
      pairingState.status === "error"
        ? `Pairing error: ${pairingState.code}`
        : pairingState.status;
    const add = document.createElement("button");
    add.textContent = "Scan Paseo host";
    add.disabled = ["scanning", "validating", "connecting"].includes(
      pairingState.status,
    );
    add.addEventListener("click", () => pairing.start());
    const list = document.createElement("ul");
    for (const host of registryState.hosts) {
      const row = document.createElement("li");
      row.textContent = `${host.profile.hostname ?? host.profile.serverId} · ${host.profile.serverId} · ${host.status}`;
      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.addEventListener(
        "click",
        () => void registry.remove(host.profile.serverId),
      );
      row.append(remove);
      list.append(row);
    }
    const directoryTitle = document.createElement("h2");
    directoryTitle.textContent = "Directory diagnostics";
    const directoryHosts = document.createElement("ul");
    [...directoryState.hosts.values()].forEach((host, index) => {
      const row = document.createElement("li");
      row.textContent =
        `Host ${index + 1} · ${host.status}${host.stale ? " stale" : ""} · ` +
        `${host.projects.size} projects · ${host.workspaces.size} workspaces · ` +
        `${host.agents.size} agents`;
      const refresh = document.createElement("button");
      refresh.textContent = "Refresh directory";
      refresh.dataset.directoryRefresh = String(index);
      refresh.addEventListener(
        "click",
        () => void directory.refresh(host.serverId),
      );
      row.append(refresh);
      directoryHosts.append(row);
    });
    const ordered = document.createElement("output");
    ordered.id = "directory-order";
    ordered.textContent = directoryState.orderedAgents.length
      ? directoryState.orderedAgents
          .map((_, index) => `Agent ${index + 1}`)
          .join(" · ")
      : "No eligible agents";
    const current = document.createElement("output");
    current.id = "directory-current";
    const currentIndex = directoryState.current
      ? directoryState.orderedAgents.findIndex(
          (agent) =>
            agent.serverId === directoryState.current?.serverId &&
            agent.agentId === directoryState.current.agentId,
        )
      : -1;
    current.textContent =
      directoryState.destination === "config"
        ? "Destination: Config"
        : `Destination: Agent ${currentIndex + 1}`;
    hosts.replaceChildren(
      title,
      state,
      add,
      list,
      directoryTitle,
      directoryHosts,
      ordered,
      current,
    );
  };
  pairing.subscribe((value) => {
    pairingState = value;
    render();
  });
  registry.subscribe((value) => {
    registryState = value;
    render();
  });
  directory.subscribe((value) => {
    directoryState = value;
    render();
  });
}

void main().catch((error: unknown) => {
  if (status)
    status.textContent = error instanceof Error ? error.message : String(error);
});
