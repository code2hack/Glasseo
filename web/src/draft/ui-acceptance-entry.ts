import {
  DestinationHost,
  PlaceholderDestinationBody,
} from "../app/destinationHost";
import { InputRouter } from "../app/inputRouter";
import type { AgentKey } from "../directory/types";
import type { SemanticInput } from "../native/semanticInput";
import { DraftController } from "./controller";
import { IndexedDbDraftStorage } from "./storage";
import { DraftDestinationBody } from "./view";

declare global {
  interface Window {
    __glasseoDraftUiAcceptance?: {
      run(): Promise<Readonly<Record<string, unknown>>>;
      inspectRestart(): Promise<Readonly<Record<string, unknown>>>;
    };
  }
}

const alpha = { serverId: "draft-acceptance-alpha", agentId: "shared-agent" };
const beta = { serverId: "draft-acceptance-beta", agentId: "shared-agent" };
const sibling = { serverId: alpha.serverId, agentId: "other-agent" };
const requestIds = ["private-request-a", "private-request-b"];
const image = {
  id: "private-image",
  token: "private-media-token",
  mimeType: "image/jpeg",
  capturedAt: 1,
  width: 320,
  height: 240,
  bytes: 123,
} as const;

window.__glasseoDraftUiAcceptance = {
  async run() {
    const root = document.querySelector<HTMLElement>("#agent-body");
    const header = document.querySelector<HTMLElement>("#agent-header");
    if (!root || !header) throw new Error("Application shell missing");
    const storage = new IndexedDbDraftStorage();
    await storage.deleteHost(alpha.serverId);
    await storage.deleteHost(beta.serverId);

    const writer = new DraftController(storage, () => 10);
    await writer.activate(alpha, requestIds);
    await writer.replaceText("private draft text");
    await writer.setTextCursor(8);
    await writer.appendImageRefs([image]);
    await writer.cycleArea("left");
    await writer.moveWithinArea("down");
    writer.resetTransientState();
    writer.dispose();

    const controller = new DraftController(storage, () => 20);
    await controller.activate(alpha, requestIds);
    const restored = controller.snapshot().session!;
    await controller.activate(beta);
    const betaBlank = blank(controller);
    await controller.activate(sibling);
    const siblingBlank = blank(controller);

    let draftBody: DraftDestinationBody | null = null;
    const forwarded: SemanticInput[] = [];
    const host = new DestinationHost(root, {
      timeline: () => new PlaceholderDestinationBody(),
      config: () => new PlaceholderDestinationBody(),
      draft: () => {
        draftBody = new DraftDestinationBody(controller, () => requestIds);
        return draftBody;
      },
    });
    root.replaceChildren();
    root.dataset.destination = "draft";
    host.update(context(alpha));
    await tick();
    const stableArea = root.querySelector('[data-area="request"]');
    const router = new InputRouter(host, {
      handle(value) {
        forwarded.push(value);
      },
    });
    router.handle(input("RIGHT", "BEGIN", 101));
    router.handle(input("RIGHT", "UPDATE", 101));
    router.handle(input("DOWN", "BEGIN", 102));
    router.handle(input("DOWN", "UPDATE", 102));
    router.handle(input("COMMAND", "SHORT", 103));
    await tick();
    host.update(context(alpha));
    const stableAfter = root.querySelector('[data-area="request"]');
    const viewport = root.querySelector<HTMLElement>(".draft-viewport")!;
    const rootRect = root.getBoundingClientRect();
    const diagnostics = draftBody!.diagnostics();
    const raw = (await storage.loadAgent(alpha)) as Record<string, unknown>;
    const encodedDiagnostics = JSON.stringify(diagnostics);
    const result = {
      width: innerWidth,
      height: innerHeight,
      bodyTop: rootRect.top,
      bodyBottom: rootRect.bottom,
      headerBottom: header.getBoundingClientRect().bottom,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportScrollWidth: viewport.scrollWidth,
      viewportClientWidth: viewport.clientWidth,
      restoredTextLength: restored.record.text.length,
      restoredTextOffset: restored.record.cursors.textOffset,
      restoredRequestCursor:
        restored.record.cursors.requestId === requestIds[1],
      restoredImageCount: restored.record.images.length,
      betaBlank,
      siblingBlank,
      stableArea: stableArea !== null && stableArea === stableAfter,
      forwardedCommand:
        forwarded.filter(({ control }) => control === "COMMAND").length === 1,
      structuredRecordOnly:
        raw.schemaVersion === 1 &&
        !["blob", "data", "base64", "audio", "permission"].some(
          (field) => field in raw,
        ),
      diagnosticsRedacted: ![
        alpha.serverId,
        alpha.agentId,
        requestIds[0],
        requestIds[1],
        image.id,
        image.token,
        "private draft text",
      ].some((secret) => encodedDiagnostics.includes(secret)),
      diagnostics,
    };
    host.dispose();
    controller.dispose();
    return result;
  },
  async inspectRestart() {
    const storage = new IndexedDbDraftStorage();
    const controller = new DraftController(storage);
    await controller.activate(alpha, requestIds);
    const snapshot = controller.snapshot();
    const result = {
      textLength: snapshot.session?.record.text.length,
      textOffset: snapshot.session?.record.cursors.textOffset,
      requestCursorRestored:
        snapshot.session?.record.cursors.requestId === requestIds[1],
      imageCount: snapshot.session?.record.images.length,
      activeArea: snapshot.session?.record.activeArea,
      transientReset:
        snapshot.session?.transient.mode === "edit" &&
        snapshot.session.transient.textSelection === null &&
        snapshot.session.transient.selectedImageIds.length === 0 &&
        snapshot.session.transient.provisionalText === null &&
        !snapshot.session.transient.wheelOpen &&
        !snapshot.session.transient.pending,
    };
    controller.dispose();
    await storage.deleteHost(alpha.serverId);
    await storage.deleteHost(beta.serverId);
    return result;
  },
};

function blank(controller: DraftController): boolean {
  const record = controller.snapshot().session?.record;
  return record?.text === "" && record.images.length === 0;
}

function context(key: AgentKey) {
  return {
    destination: { kind: "agent" as const, key, pane: "draft" as const },
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
