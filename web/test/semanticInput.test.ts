import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSemanticInput,
  semanticActions,
  semanticControls,
} from "../src/native/semanticInput";

test("semantic input accepts only the normalized seven-control schema", () => {
  assert.deepEqual(semanticControls, [
    "PRIMARY",
    "SECONDARY",
    "COMMAND",
    "LEFT",
    "RIGHT",
    "UP",
    "DOWN",
  ]);
  assert.equal(
    decodeSemanticInput({
      type: "semantic-input",
      control: "PRIMARY",
      action: "SHORT",
      interactionId: 1,
      timeMillis: 20,
    }).control,
    "PRIMARY",
  );
  assert.equal(semanticActions.length, 7);
});

test("semantic input rejects raw, unknown, and malformed payloads", () => {
  for (const value of [
    null,
    { type: "semantic-input", control: "OTHER" },
    {
      type: "semantic-input",
      control: "PRIMARY",
      action: "SHORT",
      interactionId: 1,
      timeMillis: 20,
      keyCode: 66,
    },
    {
      type: "semantic-input",
      control: "PRIMARY",
      action: "SHORT",
      interactionId: 1.5,
      timeMillis: 20,
    },
  ]) {
    assert.throws(() => decodeSemanticInput(value));
  }
});
