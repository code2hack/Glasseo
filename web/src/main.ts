import { postNative } from "./native/bridge";
import { runWebViewProbe } from "./compat/webviewProbe";

const status = document.querySelector<HTMLElement>("#status");

async function main() {
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
