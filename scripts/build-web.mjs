import { copyFile, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "app/build/generated/web";
await rm(outdir, { force: true, recursive: true });
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: [
    "web/src/main.ts",
    "web/src/styles.css",
    "web/src/timeline/acceptance-entry.ts",
    "web/src/timeline/ui-acceptance-entry.ts",
  ],
  bundle: true,
  conditions: ["node"],
  format: "iife",
  outdir,
  target: "chrome95",
  sourcemap: true,
});
await copyFile("web/index.html", `${outdir}/index.html`);
await copyFile(
  "web/timeline-acceptance.html",
  `${outdir}/timeline-acceptance.html`,
);
