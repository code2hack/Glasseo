import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeHidInputTrace,
  formatHidInputTrace,
} from "../src/native/hidInputTrace";

test("HID trace decodes and displays every exact raw field and decision", () => {
  const trace = decodeHidInputTrace({
    type: "hid-input-trace",
    totalRawReceipts: 1,
    totalDecisions: 1,
    droppedRecords: 0,
    attempt: null,
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
    {
      type: "hid-input-trace",
      events: new Array(9).fill({}),
      totalRawReceipts: 9,
      totalDecisions: 0,
      droppedRecords: 0,
      attempt: null,
    },
    {
      type: "hid-input-trace",
      events: [{ action: "DOWN" }],
      totalRawReceipts: 1,
      totalDecisions: 0,
      droppedRecords: 0,
      attempt: null,
    },
    {
      type: "hid-input-trace",
      events: [],
      totalRawReceipts: 0,
      totalDecisions: 0,
      droppedRecords: 0,
      attempt: null,
      rawKeyCode: 105,
    },
    {
      type: "hid-input-trace",
      events: [],
      totalRawReceipts: 1,
      totalDecisions: 0,
      droppedRecords: 1,
      attempt: null,
    },
  ]) {
    assert.throws(() => decodeHidInputTrace(value));
  }
});

test("HID trace requires exact supervisor attempt context", () => {
  const trace = decodeHidInputTrace({
    type: "hid-input-trace",
    events: [],
    totalRawReceipts: 0,
    totalDecisions: 0,
    droppedRecords: 0,
    attempt: {
      attemptId: "A01",
      operation: "SHORT_PRIMARY",
      phase: "AWAITING_INPUT",
      supervisorElapsedRealtimeMillis: 490,
      startedElapsedRealtimeMillis: 500,
      watchdogDeadlineMillis: 2000,
      status: "NO_ANDROID_EVENT",
      firstRawSequence: null,
    },
  });

  assert.equal(trace.attempt?.operation, "SHORT_PRIMARY");
  assert.equal(trace.attempt?.supervisorElapsedRealtimeMillis, 490);
});
