import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeNativeMessage,
  isPassingProbeResult,
  requiredProbeChecks,
} from "../src/native/bridge";

test("bridge accepts its narrow message types", () => {
  assert.deepEqual(decodeNativeMessage('{"type":"hello"}'), { type: "hello" });
  assert.equal(
    decodeNativeMessage(JSON.stringify(probeResult())).type,
    "probe-result",
  );
  assert.equal(
    decodeNativeMessage(
      '{"type":"semantic-received","control":"PRIMARY","action":"SHORT","interactionId":1}',
    ).type,
    "semantic-received",
  );
  assert.equal(
    decodeNativeMessage('{"type":"qualification-start","mode":"HID"}').type,
    "qualification-start",
  );
  assert.deepEqual(
    decodeNativeMessage(
      '{"type":"qualification-rendered","sessionId":"session-1","revision":7,' +
        '"stepIndex":5,"phase":"AWAITING_FIRST"}',
    ),
    {
      type: "qualification-rendered",
      sessionId: "session-1",
      revision: 7,
      stepIndex: 5,
      phase: "AWAITING_FIRST",
    },
  );
});

test("bridge rejects malformed and unknown messages", () => {
  for (const value of [
    "null",
    "{}",
    '{"type":"other"}',
    '{"type":"probe-result"}',
    '{"type":"qualification-rendered","sessionId":"session-1","revision":0,"stepIndex":5,"phase":"AWAITING_FIRST"}',
  ]) {
    assert.throws(() => decodeNativeMessage(value));
  }
});

test("probe contract rejects missing unknown and contradictory checks", () => {
  const missing = probeResult();
  delete missing.checks.remoteNavigationRejected;
  const unknown = probeResult();
  unknown.checks.unknown = true;
  const contradictory = probeResult();
  contradictory.passed = false;

  for (const value of [missing, unknown, contradictory]) {
    assert.throws(() => decodeNativeMessage(JSON.stringify(value)));
  }
});

test("a required false check cannot pass acceptance", () => {
  const failed = probeResult();
  failed.passed = false;
  failed.checks.secureRandom = false;
  const decoded = decodeNativeMessage(JSON.stringify(failed));
  assert.equal(decoded.type, "probe-result");
  assert.equal(isPassingProbeResult(decoded), false);
});

function probeResult() {
  return {
    type: "probe-result" as const,
    passed: true,
    checks: Object.fromEntries(
      requiredProbeChecks.map((name) => [name, true]),
    ) as Record<string, boolean>,
    details: Object.fromEntries(
      requiredProbeChecks.map((name) => [name, "PASS"]),
    ),
  };
}
