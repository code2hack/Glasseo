import { AgentHeaderMetadataController } from "../agent-pages/headerMetadata";
import { AgentPagerController } from "../agent-pages/pager";
import { AgentShellView } from "../agent-pages/view";
import { runWebViewProbe } from "../compat/webviewProbe";
import { DirectoryCoordinator } from "../directory/coordinator";
import { IndexedDbDirectoryStorage } from "../directory/storage";
import { PairingController } from "../hosts/pairing";
import { HostRegistry } from "../hosts/registry";
import { IndexedDbHostStorage } from "../hosts/storage";
import { postNative } from "../native/bridge";
import { listenForSemanticInput } from "../native/semanticInput";
import { setupDiagnostics } from "./diagnostics";
import { InputRouter } from "./inputRouter";
import { TimelineCoordinator } from "../timeline/coordinator";
import { IndexedDbTimelineStorage } from "../timeline/storage";
import { bindTimeline } from "../timeline/binding";
import type { TimelineStorage } from "../timeline/types";

export function createTimelineComposition(
  directory: Pick<DirectoryCoordinator, "snapshot" | "subscribe">,
  registry: Pick<HostRegistry, "subscribeRuntimeLeases">,
  storage: TimelineStorage = new IndexedDbTimelineStorage(),
): { coordinator: TimelineCoordinator; dispose(): void } {
  const coordinator = new TimelineCoordinator(storage);
  const disposeBinding = bindTimeline(coordinator, directory, registry);
  return {
    coordinator,
    dispose() {
      disposeBinding();
      coordinator.dispose();
    },
  };
}

export async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Application root missing");
  const registry = new HostRegistry(new IndexedDbHostStorage());
  const pairing = new PairingController(registry);
  const directory = new DirectoryCoordinator(
    registry,
    new IndexedDbDirectoryStorage(),
  );
  const pager = new AgentPagerController(directory);
  const metadata = new AgentHeaderMetadataController(registry, directory);
  const timelineComposition = createTimelineComposition(directory, registry);
  const timeline = timelineComposition.coordinator;
  const view = new AgentShellView(root, pager, directory, metadata, timeline);
  const inputRouter = new InputRouter(view, pager);
  view.render();
  const disposeDiagnostics = setupDiagnostics(pairing);
  const disposeSemanticInput = listenForSemanticInput((input) => {
    inputRouter.handle(input);
    postNative({
      type: "semantic-received",
      control: input.control,
      action: input.action,
      interactionId: input.interactionId,
    });
  });
  window.addEventListener(
    "pagehide",
    () => {
      disposeSemanticInput();
      disposeDiagnostics();
      view.dispose();
      timelineComposition.dispose();
      metadata.dispose();
      pager.dispose();
      directory.dispose();
    },
    { once: true },
  );
  postNative({ type: "hello" });
  void directory.restore();
  const result = await runWebViewProbe();
  postNative({ type: "probe-result", ...result });
}
