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
  const view = new AgentShellView(root, pager, directory, metadata);
  view.render();
  const disposeDiagnostics = setupDiagnostics(pairing);
  const disposeSemanticInput = listenForSemanticInput((input) => {
    pager.handle(input);
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
