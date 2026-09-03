import type { AgentKey } from "../../directory/types";
import {
  listenForSemanticInput,
  type SemanticInput,
} from "../../native/semanticInput";
import { DraftController } from "../controller";
import { IndexedDbDraftStorage } from "../storage";
import { DraftDestinationBody } from "../view";

declare global {
  interface Window {
    __glasseoDraftTextAcceptance?: {
      run(): Promise<Readonly<Record<string, unknown>>>;
      beginPhysical(): Promise<Readonly<Record<string, unknown>>>;
      finishPhysical(): Promise<Readonly<Record<string, unknown>>>;
    };
  }
}

const key = { serverId: "text-acceptance", agentId: "unicode-agent" };
const requestIds = ["private-request"];
const fixture = "alpha,  beta\nCafe\u0301 👩🏽‍💻 <b>";
const physicalKey = { serverId: "text-physical", agentId: "joy-con" };
const physicalFixture = "one two three four five";
const physicalSequence = [
  "UP:BEGIN",
  "DOWN:BEGIN",
  "PRIMARY:SHORT",
  "DOWN:BEGIN",
  "PRIMARY:SHORT",
  "PRIMARY:SHORT",
  "SECONDARY:LONG",
  "SECONDARY:LONG",
];
let physicalSession:
  | Readonly<{
      storage: IndexedDbDraftStorage;
      controller: DraftController;
      view: DraftDestinationBody;
      disposeInput: () => void;
      handled: string[];
    }>
  | undefined;

window.__glasseoDraftTextAcceptance = {
  async run() {
    const root = document.querySelector<HTMLElement>("#agent-body");
    const header = document.querySelector<HTMLElement>("#agent-header");
    if (!root || !header) throw new Error("Application shell missing");
    const storage = new IndexedDbDraftStorage();
    await storage.deleteHost(key.serverId);
    const controller = new DraftController(storage, () => 50);
    const view = new DraftDestinationBody(controller, () => requestIds);
    root.replaceChildren();
    root.dataset.destination = "draft";
    view.mount(root);
    view.update(context(key));
    await tick();
    await controller.replaceText(fixture);
    await tick();

    const alpha = Array.from(
      root.querySelectorAll<HTMLElement>(".draft-unit"),
    ).find(({ textContent }) => textContent === "alpha");
    await controller.setRequestDescriptors([
      "private-request",
      "other-request",
    ]);
    await tick();
    const stableAlpha = Array.from(
      root.querySelectorAll<HTMLElement>(".draft-unit"),
    ).find(({ textContent }) => textContent === "alpha");

    const moved = view.handleInput(input("DOWN", "BEGIN", 1));
    const selectionStarted = view.handleInput(input("PRIMARY", "SHORT", 2));
    view.handleInput(input("DOWN", "BEGIN", 3));
    await tick();
    const selectionCount = root.querySelectorAll(".draft-unit.selected").length;
    view.handleInput(input("PRIMARY", "SHORT", 4));
    await tick();
    const copied = view.diagnostics().textCopyLength === 7;
    view.handleInput(input("PRIMARY", "SHORT", 5));
    view.handleInput(input("UP", "BEGIN", 6));
    view.handleInput(input("SECONDARY", "LONG", 7));
    await tick();
    const cut =
      controller.snapshot().session?.record.text === "alpha\nCafe\u0301 👩🏽‍💻 <b>";
    view.handleInput(input("SECONDARY", "LONG", 8));
    await tick();
    const dw = controller.snapshot().session?.record.text === "alpha\n👩🏽‍💻 <b>";
    const beforeDouble = controller.snapshot().session?.record.text;
    const doubleConsumed = view.handleInput(input("SECONDARY", "DOUBLE", 9));
    const doublePreserved =
      controller.snapshot().session?.record.text === beforeDouble;

    view.handleInput(input("PRIMARY", "SHORT", 10));
    view.handleInput(input("LEFT", "BEGIN", 11));
    await tick();
    const leavingCleared =
      controller.snapshot().session?.record.activeArea === "request" &&
      controller.snapshot().session?.transient.textSelection === null;
    view.handleInput(input("RIGHT", "BEGIN", 12));
    await tick();
    await waitReady(controller);

    const viewport = root.querySelector<HTMLElement>(".draft-viewport")!;
    const rootRect = root.getBoundingClientRect();
    const active = root.querySelector<HTMLElement>(".draft-unit.cursor");
    const activeRect = active?.getBoundingClientRect();
    const diagnostics = view.diagnostics();
    const encodedDiagnostics = JSON.stringify(diagnostics);
    const persisted = controller.snapshot().session!.record;
    view.dispose();
    controller.dispose();

    const restarted = new DraftController(storage);
    await restarted.activate(key, requestIds);
    const restart = restarted.snapshot().session!;
    const result = {
      width: innerWidth,
      height: innerHeight,
      bodyTop: rootRect.top,
      bodyBottom: rootRect.bottom,
      headerBottom: header.getBoundingClientRect().bottom,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportScrollWidth: viewport.scrollWidth,
      viewportClientWidth: viewport.clientWidth,
      cursorVisible:
        !!activeRect &&
        activeRect.top >= rootRect.top &&
        activeRect.bottom <= rootRect.bottom,
      moved,
      selectionStarted,
      selectionCount,
      copied,
      cut,
      dw,
      doubleUnconsumed: !doubleConsumed,
      doublePreserved,
      leavingCleared,
      stableToken: alpha !== undefined && alpha === stableAlpha,
      noHtmlElement: root.querySelector("b") === null,
      persistedRevision: persisted.revision,
      restartMatches:
        restart.record.text === persisted.text &&
        restart.record.cursors.textOffset === persisted.cursors.textOffset,
      restartTransientReset:
        restart.transient.textSelection === null &&
        restart.transient.textCopyBuffer === "",
      diagnosticsRedacted: ![
        key.serverId,
        key.agentId,
        requestIds[0],
        fixture,
      ].some((secret) => encodedDiagnostics.includes(secret)),
      diagnostics,
    };
    restarted.dispose();
    await storage.deleteHost(key.serverId);
    return result;
  },

  async beginPhysical() {
    if (physicalSession) throw new Error("Physical acceptance already active");
    const root = document.querySelector<HTMLElement>("#agent-body");
    if (!root) throw new Error("Application shell missing");
    const storage = new IndexedDbDraftStorage();
    await storage.deleteHost(physicalKey.serverId);
    const controller = new DraftController(storage, () => 100);
    const view = new DraftDestinationBody(controller, () => []);
    root.replaceChildren();
    root.dataset.destination = "draft";
    view.mount(root);
    view.update(context(physicalKey));
    await tick();
    await controller.replaceText(physicalFixture);
    await controller.setTextCursor(4);
    await waitReady(controller);
    const handled: string[] = [];
    const disposeInput = listenForSemanticInput((semantic) => {
      if (!view.handleInput(semantic)) return;
      handled.push(`${semantic.control}:${semantic.action}`);
      document.body.dataset.draftTextPhysicalHandled = String(handled.length);
    });
    physicalSession = { storage, controller, view, disposeInput, handled };
    document.body.dataset.draftTextPhysical = "ready";
    return { ready: true, expectedActions: physicalSequence.length };
  },

  async finishPhysical() {
    const session = physicalSession;
    if (!session) throw new Error("Physical acceptance is not active");
    await waitReady(session.controller);
    const beforeRestart = session.controller.snapshot().session!;
    const diagnostics = session.view.diagnostics();
    const sequenceMatches =
      session.handled.length === physicalSequence.length &&
      session.handled.every(
        (entry, index) => entry === physicalSequence[index],
      );
    session.disposeInput();
    session.view.dispose();
    session.controller.dispose();
    const restarted = new DraftController(session.storage);
    await restarted.activate(physicalKey);
    const afterRestart = restarted.snapshot().session!;
    const result = {
      sequenceMatches,
      handledActions: session.handled.length,
      textMatches: beforeRestart.record.text === "one two  five",
      cursorMatches: beforeRestart.record.cursors.textOffset === 9,
      copyLength: beforeRestart.transient.textCopyBuffer.length,
      selectionCleared: beforeRestart.transient.textSelection === null,
      revision: beforeRestart.record.revision,
      restartMatches:
        afterRestart.record.text === beforeRestart.record.text &&
        afterRestart.record.cursors.textOffset ===
          beforeRestart.record.cursors.textOffset,
      restartTransientReset:
        afterRestart.transient.textSelection === null &&
        afterRestart.transient.textCopyBuffer === "",
      diagnosticsRedacted: !JSON.stringify(diagnostics).includes("three"),
      diagnostics,
    };
    restarted.dispose();
    await session.storage.deleteHost(physicalKey.serverId);
    physicalSession = undefined;
    return result;
  },
};

function context(agentKey: AgentKey) {
  return {
    destination: {
      kind: "agent" as const,
      key: agentKey,
      pane: "draft" as const,
    },
    timeline: null,
  };
}

function input(
  control: SemanticInput["control"],
  action: SemanticInput["action"],
  interactionId: number,
): SemanticInput {
  return {
    type: "semantic-input",
    control,
    action,
    interactionId,
    timeMillis: interactionId,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitReady(controller: DraftController): Promise<void> {
  for (let frame = 0; frame < 120; frame++) {
    const status = controller.snapshot().storageStatus;
    if (status === "ready") return;
    if (status === "error") throw new Error("Draft persistence failed");
    await tick();
  }
  throw new Error("Draft persistence timed out");
}
