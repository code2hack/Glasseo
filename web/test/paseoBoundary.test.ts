import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("only the Paseo adapter imports the internal client entrypoint", async () => {
  const files = await sourceFiles("web/src");
  const importers = [];
  for (const file of files) {
    if ((await readFile(file, "utf8")).includes("@getpaseo/client/internal/"))
      importers.push(file);
  }
  assert.deepEqual(importers, ["web/src/paseo/adapter.ts"]);
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory()
        ? sourceFiles(path)
        : Promise.resolve(path.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat().sort();
}
