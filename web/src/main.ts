import { bootstrap } from "./app/bootstrap";

void bootstrap().catch((error: unknown) => {
  const root = document.querySelector<HTMLElement>("#app");
  if (root)
    root.textContent = error instanceof Error ? error.message : String(error);
});
