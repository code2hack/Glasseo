import assert from "node:assert/strict";
import test from "node:test";
import {
  qualificationLandingActions,
  qualificationSteps,
  qualificationHeading,
  decodeQualificationMessage,
  reduceQualification,
  type QualificationState,
} from "../src/native/qualification";

test("qualification landing has exactly the two accepted actions", () => {
  assert.deepEqual(qualificationLandingActions, [
    "Start testing builtin keys",
    "Start HID binding",
  ]);
  assert.equal(qualificationSteps.length, 10);
});

test("HID wizard confirms twice and clears a mismatch", () => {
  let state: QualificationState = { view: "landing" };

  state = reduceQualification(state, {
    type: "native-state",
    snapshot: snapshot({
      sessionId: "hid-1",
      revision: 1,
      stepIndex: 0,
      stepName: "Short PRIMARY",
      phase: "AWAITING_CONFIRMATION",
      attempt: 1,
      candidateDisplay: "keyboard:66:28",
      prompt: "Press the same button again",
    }),
  });
  assert.equal(state.prompt, "Press the same button again");

  state = reduceQualification(state, {
    type: "native-state",
    snapshot: snapshot({
      sessionId: "hid-1",
      revision: 2,
      stepIndex: 0,
      stepName: "Short PRIMARY",
      error: "Two operations must be the same, try again",
      prompt: "Press the button you wanna bind",
    }),
  });
  assert.equal(state.error, "Two operations must be the same, try again");
  assert.equal(state.candidateDisplay, null);
});

test("built-in mode uses fixed-operation wording", () => {
  const state = reduceQualification(
    { view: "landing" },
    {
      type: "native-state",
      snapshot: snapshot(),
    },
  );
  assert.equal(state.prompt, "Perform the intended action");
});

test("qualification native messages fail closed", () => {
  assert.deepEqual(
    decodeQualificationMessage('{"type":"qualification-landing"}'),
    {
      type: "qualification-landing",
    },
  );
  assert.throws(() =>
    decodeQualificationMessage(
      '{"type":"qualification-state","step":"Short PRIMARY","prompt":"x","error":null,"capturedIdentity":null,"complete":false,"keyCode":66}',
    ),
  );
});

test("newest native revision wins and duplicate snapshots are idempotent", () => {
  const shortCommand = snapshot({
    sessionId: "builtin-1",
    revision: 10,
    stepIndex: 4,
    stepName: "Short COMMAND",
  });
  const longCommand = snapshot({
    sessionId: "builtin-1",
    revision: 11,
    stepIndex: 5,
    stepName: "Long COMMAND",
  });
  let state = reduceQualification(
    { view: "landing" },
    { type: "native-state", snapshot: shortCommand },
  );
  state = reduceQualification(state, {
    type: "native-state",
    snapshot: longCommand,
  });
  const newest = state;

  state = reduceQualification(state, {
    type: "native-state",
    snapshot: shortCommand,
  });
  assert.strictEqual(state, newest);
  state = reduceQualification(state, {
    type: "native-state",
    snapshot: longCommand,
  });
  assert.strictEqual(state, newest);
  assert.equal(state.stepName, "Long COMMAND");
  assert.equal(state.revision, 11);
});

test("reload accepts the replayed revision and a landing reset admits a new session", () => {
  const replay = snapshot({
    sessionId: "session-before-reload",
    revision: 8,
    stepIndex: 5,
    stepName: "Long COMMAND",
  });
  const restored = reduceQualification(
    { view: "landing" },
    { type: "native-state", snapshot: replay },
  );
  assert.equal(restored.revision, 8);

  const landing = reduceQualification(restored, { type: "landing" });
  const next = reduceQualification(landing, {
    type: "native-state",
    snapshot: snapshot({ sessionId: "new-session", revision: 1 }),
  });
  assert.equal(next.sessionId, "new-session");
  assert.equal(next.revision, 1);
});

test("revision one starts a new authoritative native session", () => {
  const old = reduceQualification(
    { view: "landing" },
    {
      type: "native-state",
      snapshot: snapshot({ sessionId: "old", revision: 9 }),
    },
  );
  const next = reduceQualification(old, {
    type: "native-state",
    snapshot: snapshot({ sessionId: "new", revision: 1 }),
  });
  assert.equal(next.sessionId, "new");
  assert.equal(next.revision, 1);
  assert.strictEqual(
    reduceQualification(next, {
      type: "native-state",
      snapshot: snapshot({ sessionId: "old", revision: 10 }),
    }),
    next,
  );
});

test("visible progress and settle prompts are exact", () => {
  const shortCommand = snapshot({
    stepIndex: 4,
    stepName: "Short COMMAND",
    phase: "SETTLING_FIRST",
    attempt: 1,
    operationId: 10,
    settleDeadlineMillis: 11_200,
    prompt: "Captured — checking…",
  });
  const longCommand = snapshot({
    revision: 2,
    stepIndex: 5,
    stepName: "Long COMMAND",
    phase: "SETTLING_SECOND",
    attempt: 2,
    operationId: 11,
    settleDeadlineMillis: 12_400,
    prompt: "Captured — confirming…",
  });
  const up = snapshot({ revision: 3, stepIndex: 6, stepName: "UP" });

  assert.equal(qualificationHeading(shortCommand), "5/10 Short COMMAND");
  assert.equal(shortCommand.prompt, "Captured — checking…");
  assert.equal(qualificationHeading(longCommand), "6/10 Long COMMAND");
  assert.equal(longCommand.prompt, "Captured — confirming…");
  assert.equal(qualificationHeading(up), "7/10 UP");
});

test("paused target snapshots remain visible and idempotent across replay", () => {
  const paused = snapshot({
    revision: 12,
    stepIndex: 6,
    stepName: "UP",
    paused: true,
    prompt: "Qualification paused — resume with ADB",
  });
  const decoded = decodeQualificationMessage(JSON.stringify(paused));
  assert.equal(decoded.type, "qualification-state");
  assert.equal(decoded.paused, true);

  const rendered = reduceQualification(
    { view: "landing" },
    { type: "native-state", snapshot: paused },
  );
  const replayed = reduceQualification(rendered, {
    type: "native-state",
    snapshot: paused,
  });
  assert.strictEqual(replayed, rendered);
  assert.equal(replayed.stepName, "UP");
  assert.equal(replayed.prompt, "Qualification paused — resume with ADB");
});

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    type: "qualification-state" as const,
    sessionId: "session-1",
    mode: "BUILT_IN" as const,
    revision: 1,
    stepIndex: 0,
    stepName: "Short PRIMARY",
    phase: "AWAITING_FIRST" as const,
    attempt: 0,
    operationId: null,
    candidateDisplay: null,
    suppressionResult: null,
    settleDeadlineMillis: null,
    description: "Briefly use the intended PRIMARY control",
    prompt: "Perform the intended action",
    error: null,
    paused: false,
    complete: false,
    ...overrides,
  };
}
