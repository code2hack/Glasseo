import assert from "node:assert/strict";
import test from "node:test";
import { decodeNativeMessage } from "../src/native/bridge";

test("bridge accepts its two narrow message types", () => {
  assert.deepEqual(decodeNativeMessage('{"type":"hello"}'), { type: "hello" });
  assert.equal(
    decodeNativeMessage(
      '{"type":"probe-result","passed":true,"checks":{"origin":true},"details":{"origin":"PASS"}}',
    ).type,
    "probe-result",
  );
});

test("bridge rejects malformed and unknown messages", () => {
  for (const value of [
    "null",
    "{}",
    '{"type":"other"}',
    '{"type":"probe-result"}',
  ]) {
    assert.throws(() => decodeNativeMessage(value));
  }
});
