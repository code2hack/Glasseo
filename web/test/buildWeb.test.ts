import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const output = "app/build/generated/web";

test("Web build removes obsolete generated assets", async () => {
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/obsolete.js`, "stale");
  await run(process.execPath, ["scripts/build-web.mjs"]);

  await assert.rejects(access(`${output}/obsolete.js`));
  assert.deepEqual((await readdir(output)).sort(), [
    "index.html",
    "main.js",
    "main.js.map",
    "styles.css",
    "styles.css.map",
  ]);
});
