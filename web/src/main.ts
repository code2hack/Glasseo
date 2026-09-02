import { postNative } from "./native/bridge";
import { listenForSemanticInput } from "./native/semanticInput";
import { runWebViewProbe } from "./compat/webviewProbe";

const status = document.querySelector<HTMLElement>("#status");

async function main() {
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
