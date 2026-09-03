import assert from "node:assert/strict";
import test from "node:test";
import { decodeHidMessage } from "../src/config/hid/bridge";
import { HidConfigHarness } from "../src/config/hid/harness";
import {
  HID_RESET_CANCEL_ROW_ID,
  HID_RESET_CONFIRM_ROW_ID,
  HID_RESET_ROW_ID,
  hidControlRowId,
  projectHidConfig,
} from "../src/config/hid/project";
import { HidConfigSection } from "../src/config/hid/section";
import { HID_KEYS_SECTION_ID } from "../src/config/project";
import {
  hidControls,
  type HidBindingsStateMessage,
} from "../src/config/hid/types";

test("native projection has exactly seven stable control rows and reset", () => {
  const harness = new HidConfigHarness();
  harness.receive(bindingsState(4, { PRIMARY: "Key 96/304 · 057e:2007" }));

  const rows = projectHidConfig(harness.controller.snapshot());

  assert.deepEqual(
    rows.map(({ id }) => id),
    [...hidControls.map(hidControlRowId), HID_RESET_ROW_ID],
  );
  assert.equal(rows[0]?.detail, "Key 96/304 · 057e:2007");
  assert.equal(rows[1]?.detail, "Unbound");
});

test("capture commands correlate progress, fence stale results, and report duplicates", () => {
  const harness = new HidConfigHarness();
  harness.controller.startCapture("PRIMARY");
  assert.deepEqual(harness.commands[0], {
    type: "hid-binding-capture-start",
    control: "PRIMARY",
    requestId: "hid_1",
  });
  harness.receive(capture("hid_1", "PRIMARY", "awaiting-down", 0));
  harness.receive(capture("stale", "PRIMARY", "committed", 99));
  assert.equal(harness.controller.snapshot().capture?.phase, "awaiting-down");
  harness.receive(
    capture("hid_1", "PRIMARY", "duplicate", 0, "duplicate_binding"),
  );
  assert.equal(harness.controller.snapshot().error, "duplicate_binding");

  harness.receive(bindingsState(5, { PRIMARY: "new" }));
  harness.receive(bindingsState(4, { PRIMARY: "old" }));
  assert.equal(harness.controller.snapshot().bindings[0]?.label, "new");
});

test("reset requires confirmation and preserves it on native write failure", () => {
  const harness = new HidConfigHarness();
  harness.controller.confirmReset();
  assert.equal(harness.commands.length, 0);
  harness.controller.openResetConfirmation();
  harness.controller.confirmReset();
  assert.deepEqual(harness.commands[0], {
    type: "hid-bindings-reset",
    requestId: "hid_1",
  });
  harness.receive({
    type: "hid-bindings-reset-result",
    requestId: "hid_1",
    status: "storage_error",
    revision: 0,
  });
  assert.equal(harness.controller.snapshot().resetConfirmation, true);
  assert.equal(harness.controller.snapshot().error, "storage_error");
});

test("typed decoder rejects missing controls, extra fields, and raw descriptors", () => {
  assert.equal(
    decodeHidMessage(JSON.stringify(bindingsState(1))).type,
    "hid-bindings-state",
  );
  const missing = bindingsState(1);

  assert.throws(() =>
    decodeHidMessage({ ...missing, bindings: missing.bindings.slice(1) }),
  );
  assert.throws(() =>
    decodeHidMessage({ ...bindingsState(1), descriptor: "forbidden" }),
  );
  assert.throws(() =>
    decodeHidMessage(capture("bad id", "PRIMARY", "awaiting-down", 1)),
  );
});

test("throwing subscribers cannot block later HID subscribers", () => {
  const harness = new HidConfigHarness();
  let calls = 0;
  harness.controller.subscribe(() => {
    throw new Error("broken view");
  });
  harness.controller.subscribe(() => calls++);

  harness.receive(bindingsState(1));

  assert.equal(calls, 2);
});

test("Config section exposes stable rows, bind actions, and reset confirmation focus", () => {
  const harness = new HidConfigHarness();
  const section = new HidConfigSection(harness.controller);

  const initial = section.rows(new Set());
  assert.deepEqual(
    initial.map(({ id }) => id),
    [...hidControls.map(hidControlRowId), HID_RESET_ROW_ID],
  );
  assert.deepEqual(initial[0]?.action, {
    sectionId: HID_KEYS_SECTION_ID,
    type: "hid-bind",
    targetId: "PRIMARY",
  });
  assert.deepEqual(initial[7]?.action, {
    sectionId: HID_KEYS_SECTION_ID,
    type: "hid-reset",
    targetId: null,
  });

  const focus = section.activate(
    { sectionId: HID_KEYS_SECTION_ID, type: "hid-reset", targetId: null },
    1,
  );
  assert.deepEqual(focus, { focusRowId: HID_RESET_CANCEL_ROW_ID });
  const confirming = section.rows(new Set());
  assert.deepEqual(confirming.map(({ id }) => id).slice(-2), [
    HID_RESET_CANCEL_ROW_ID,
    HID_RESET_CONFIRM_ROW_ID,
  ]);

  section.activate(
    {
      sectionId: HID_KEYS_SECTION_ID,
      type: "hid-reset-confirm",
      targetId: null,
    },
    2,
  );
  assert.deepEqual(harness.commands[0], {
    type: "hid-bindings-reset",
    requestId: "hid_1",
  });
});

test("Config section forwards duplicate feedback without displacing prior rows", () => {
  const harness = new HidConfigHarness();
  const section = new HidConfigSection(harness.controller);
  section.activate(
    { sectionId: HID_KEYS_SECTION_ID, type: "hid-bind", targetId: "PRIMARY" },
    1,
  );
  harness.receive(
    capture("hid_1", "PRIMARY", "duplicate", 0, "duplicate_binding"),
  );
  const rows = section.rows(new Set());
  assert.equal(rows[0]?.detail, "duplicate_binding");
  assert.deepEqual(
    rows.slice(1, 7).map(({ id }) => id),
    [
      hidControlRowId("SECONDARY"),
      hidControlRowId("COMMAND"),
      hidControlRowId("LEFT"),
      hidControlRowId("RIGHT"),
      hidControlRowId("UP"),
      hidControlRowId("DOWN"),
    ],
  );
});

function bindingsState(
  revision: number,
  labels: Partial<Record<(typeof hidControls)[number], string>> = {},
): HidBindingsStateMessage {
  return {
    type: "hid-bindings-state",
    revision,
    bindings: hidControls.map((control) => ({
      control,
      label: labels[control] ?? null,
      connected: labels[control] !== undefined,
      builtInCapability:
        control === "COMMAND"
          ? "AVAILABLE_WITH_SUPPRESSION"
          : control === "UP" || control === "DOWN"
            ? "AVAILABLE_SAFE"
            : "UNAVAILABLE_BUILTIN",
    })),
  };
}

function capture(
  requestId: string,
  control: (typeof hidControls)[number],
  phase: "awaiting-down" | "awaiting-up" | "committed" | "duplicate",
  revision: number,
  error: string | null = null,
) {
  return {
    type: "hid-binding-capture-state" as const,
    requestId,
    control,
    phase,
    revision,
    candidateLabel: null,
    error,
  };
}
