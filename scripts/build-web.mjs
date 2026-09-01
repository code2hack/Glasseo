import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "app/build/generated/web";
await mkdir(outdir, { recursive: true });
await build({
  entryPoints: ["web/src/main.ts", "web/src/styles.css"],
  bundle: true,
  conditions: ["node"],
  format: "iife",
  outdir,
  target: "chrome95",
  sourcemap: true,
});
await copyFile("web/index.html", `${outdir}/index.html`);
