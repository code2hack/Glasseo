import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeHidInputTrace,
  formatHidInputTrace,
} from "../src/native/hidInputTrace";

test("HID trace decodes and displays every exact raw field and decision", () => {
  const trace = decodeHidInputTrace({
    type: "hid-input-trace",
    events: [
      {
        sequence: 7,
        action: "DOWN",
        keyCode: 105,
        scanCode: 313,
        repeatCount: 0,
        eventTimeMillis: 480,
        receivedElapsedRealtimeMillis: 482,
        eventSource: 1281,
        deviceId: 6,
        descriptor: "joy-con",
        vendorId: 1406,
        productId: 8199,
        sources: 16778513,
        physicalSource: "HID",
        pressDurationMillis: null,
        releaseToNextDownMillis: 280,
        reason: "secondary-down:confirmation gap=280ms",
      },
    ],
  });

  assert.equal(
    formatHidInputTrace(trace.events),
    "#7 DOWN keyCode=105 scanCode=313 repeatCount=0 eventTime=480 elapsed=482 eventSource=1281 " +
      "deviceId=6 descriptor=joy-con vendorId=1406 productId=8199 sources=16778513 " +
      "physicalSource=HID duration=- gap=280 reason=secondary-down:confirmation gap=280ms",
  );
});

test("HID trace rejects malformed or oversized native payloads", () => {
  for (const value of [
    { type: "hid-input-trace", events: new Array(9).fill({}) },
    { type: "hid-input-trace", events: [{ action: "DOWN" }] },
    { type: "hid-input-trace", events: [], rawKeyCode: 105 },
  ]) {
    assert.throws(() => decodeHidInputTrace(value));
  }
});
