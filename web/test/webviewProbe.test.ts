import assert from "node:assert/strict";
import test from "node:test";
import { probePromiseBehavior } from "../src/compat/webviewProbe";

test("Promise probe exercises rejection recovery and continuation", async () => {
  assert.equal(await probePromiseBehavior(), true);
});
