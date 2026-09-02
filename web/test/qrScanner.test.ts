import assert from "node:assert/strict";
import test from "node:test";
import { PairingController, type PairingState } from "../src/hosts/pairing";
import { HostRegistry } from "../src/hosts/registry";
import type { HostStorage } from "../src/hosts/types";
import {
  decodeQrScannerMessage,
  type QrScannerMessage,
} from "../src/native/qrScanner";

test("scanner bridge accepts only typed redacted lifecycle messages", () => {
  assert.deepEqual(
    decodeQrScannerMessage({ type: "scanner-state", state: "scanning" }),
    {
      type: "scanner-state",
      state: "scanning",
    },
  );
  assert.deepEqual(
    decodeQrScannerMessage({ type: "scanner-result", value: "opaque" }),
    {
      type: "scanner-result",
      value: "opaque",
    },
  );
  assert.deepEqual(
    decodeQrScannerMessage({ type: "scanner-error", code: "camera_denied" }),
    {
      type: "scanner-error",
      code: "camera_denied",
    },
  );
  assert.deepEqual(decodeQrScannerMessage({ type: "scanner-cancelled" }), {
    type: "scanner-cancelled",
  });
});

test("scanner bridge rejects unknown, extra, and empty result data", () => {
  for (const value of [
    "{}",
    '{"type":"scanner-result","value":""}',
    '{"type":"scanner-error","code":"raw-camera-error"}',
    '{"type":"scanner-cancelled","value":"secret"}',
  ])
    assert.throws(() => decodeQrScannerMessage(value));
});

test("pairing accepts results only while its scanner session is active", () => {
  let receive: (message: QrScannerMessage) => void = () => {};
  let started = "";
  let cancels = 0;
  const registry = new HostRegistry(emptyStorage, () => {
    throw new Error("unexpected runtime");
  });
  const pairing = new PairingController(registry, {
    listen(listener) {
      receive = listener;
      return () => {};
    },
    start() {
      started = "started";
    },
    cancel() {
      cancels++;
    },
  });
  let state: PairingState = { status: "idle" };
  pairing.subscribe((next) => (state = next));

  receive({ type: "scanner-result", value: "ignored while idle" });
  assert.deepEqual(state, { status: "idle" });
  pairing.start();
  assert.equal(started, "started");
  receive({ type: "scanner-error", code: "busy" });
  assert.deepEqual(state, { status: "error", code: "busy" });
  receive({ type: "scanner-result", value: "late" });
  pairing.cancel();
  assert.equal(cancels, 0);
});

const emptyStorage: HostStorage = {
  loadProfiles: async () => [],
  putProfile: async () => {},
  deleteProfile: async () => {},
  getClientId: async () => null,
  putClientId: async () => {},
};
