import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { normalizePermissionRequest } from "../src/paseo/adapter";
import {
  createRequestArea,
  createRequestSession,
  insertCommittedText,
  prepareRequestResponse,
  projectRequest,
  reduceRequestAreaInput,
  reduceRequestInput,
  replaceFieldText,
  setRequestAuthority,
} from "../src/draft/request/model";
import type { RequestSession } from "../src/draft/request/types";

test("actions preserve exact behavior, action ID, and selected permission updates", () => {
  let state = session({
    id: "tool",
    provider: "acp",
    name: "shell",
    kind: "tool",
    actions: [
      { id: "deny-once", label: "Deny", behavior: "deny" },
      { id: "allow-always", label: "Always", behavior: "allow" },
    ],
    suggestions: [{ type: "addRules", rules: ["shell"] }],
  });
  state = select(state, "Always", 1);
  state = select(state, "Suggested permission 1", 2);
  assert.deepEqual(prepareRequestResponse(state), {
    status: "complete",
    requestId: "tool",
    fingerprint: state.model.fingerprint,
    answerRevision: 2,
    response: {
      behavior: "allow",
      selectedActionId: "allow-always",
      updatedPermissions: [{ type: "addRules", rules: ["shell"] }],
    },
  });
});

test("single-select replacement/cancellation and multi-select toggles are explicit", () => {
  let required = session(question("required", [q("Required", ["A", "B"])]));
  required = select(required, "A", 1);
  required = select(required, "A", 2);
  assert.deepEqual(selectedLabels(required), ["A"]);
  required = select(required, "B", 3);
  assert.deepEqual(selectedLabels(required), ["B"]);

  let optional = session(
    question("optional", [{ ...q("Optional", ["A"]), allowEmpty: true }]),
  );
  optional = select(optional, "A", 4);
  optional = select(optional, "A", 5);
  assert.deepEqual(selectedLabels(optional), []);
  assert.equal(prepareRequestResponse(optional).status, "complete");

  let multiple = session(
    question("multiple", [{ ...q("Many", ["A", "B"]), multiSelect: true }]),
  );
  multiple = select(multiple, "A", 6);
  multiple = select(multiple, "B", 7);
  multiple = select(multiple, "A", 8);
  assert.deepEqual(selectedLabels(multiple), ["B"]);
});

test("multiple questions and eligible free text encode header-keyed Paseo answers", () => {
  let state = session(
    question("questions", [
      q("Choice", ["Coffee", "Tea"]),
      {
        ...q("Comment", []),
        allowEmpty: true,
        placeholder: "Optional comment",
      },
      { ...q("Other", ["Known"]), allowOther: true },
    ]),
  );
  assert.equal(prepareRequestResponse(state).status, "incomplete");
  state = select(state, "Tea", 1);
  const textUnits = state.model.units.filter(
    (
      unit,
    ): unit is Extract<(typeof state.model.units)[number], { kind: "text" }> =>
      unit.kind === "text",
  );
  state = replaceFieldText(state, textUnits[1]!.fieldId, "Custom", 20);
  const prepared = prepareRequestResponse(state);
  assert.equal(prepared.status, "complete");
  assert.deepEqual(prepared.status === "complete" ? prepared.response : null, {
    behavior: "allow",
    updatedInput: {
      questions: [
        {
          header: "Choice",
          question: "Choice?",
          options: [{ label: "Coffee" }, { label: "Tea" }],
        },
        {
          header: "Comment",
          question: "Comment?",
          options: [],
          allowEmpty: true,
          placeholder: "Optional comment",
        },
        {
          header: "Other",
          question: "Other?",
          options: [{ label: "Known" }],
          allowOther: true,
        },
      ],
      answers: { Choice: "Tea", Comment: "", Other: "Custom" },
    },
  });
});

test("request-area navigation crosses request groups, clamps, and consumes duplicates once", () => {
  const first = session(permission("one"));
  const second = session(permission("two"));
  let area = createRequestArea([first, second]);
  const ids = area.requests.flatMap(({ model }) =>
    model.units.map(({ id }) => id),
  );
  area = reduceRequestAreaInput(area, input("UP", "BEGIN", 1));
  assert.equal(area.cursorUnitId, ids[0]);
  area = reduceRequestAreaInput(area, input("DOWN", "BEGIN", 2));
  area = reduceRequestAreaInput(area, input("DOWN", "BEGIN", 2));
  assert.equal(area.cursorUnitId, ids[1]);
  area = reduceRequestAreaInput(area, input("DOWN", "UPDATE", 2));
  area = reduceRequestAreaInput(area, input("DOWN", "END", 2));
  assert.equal(area.cursorUnitId, ids[1]);
  for (let id = 3; id < 10; id++)
    area = reduceRequestAreaInput(area, input("DOWN", "BEGIN", id));
  assert.equal(area.cursorUnitId, ids.at(-1));
});

test("stale, unsupported, fingerprint replacement, and Unicode range fencing fail closed", () => {
  let state = session(
    question("unicode", [{ ...q("Text", []), allowEmpty: false }]),
  );
  const field = state.model.units.find(
    (
      unit,
    ): unit is Extract<(typeof state.model.units)[number], { kind: "text" }> =>
      unit.kind === "text",
  )!;
  state = insertCommittedText(state, field.fieldId, "A😀B");
  state = insertCommittedText(state, field.fieldId, "X", { start: 2, end: 2 });
  assert.equal(state.answer.fieldTexts[field.fieldId], "AX😀B");
  assert.equal(
    prepareRequestResponse(setRequestAuthority(state, false)).status,
    "stale",
  );

  const unsupported = session(
    question("future", [q("Nope", ["A"])], "future-provider"),
  );
  assert.equal(prepareRequestResponse(unsupported).status, "unsupported");

  const replacement = projectRequest(
    "host",
    "agent",
    normalizePermissionRequest(question("unicode", [q("Changed", ["B"])])),
  );
  assert.notEqual(replacement.fingerprint, state.model.fingerprint);
  assert.equal(
    createRequestSession(replacement, state.answer).answer.revision,
    0,
  );
});

function session(raw: AgentPermissionRequest): RequestSession {
  return createRequestSession(
    projectRequest("host", "agent", normalizePermissionRequest(raw)),
  );
}

function select(state: RequestSession, label: string, interactionId: number) {
  const cursor = state.model.units.findIndex((unit) => unit.label === label);
  assert.notEqual(cursor, -1);
  return reduceRequestInput(
    { ...state, cursor },
    input("PRIMARY", "SHORT", interactionId),
    interactionId,
  );
}

function selectedLabels(state: RequestSession): string[] {
  return state.model.units
    .filter(
      (unit) =>
        unit.kind === "option" &&
        state.answer.selectedOptionIds.includes(unit.id),
    )
    .map(({ label }) => label);
}

function permission(id: string): AgentPermissionRequest {
  return { id, provider: "codex", name: "tool", kind: "tool" };
}

function question(
  id: string,
  questions: unknown[],
  provider = "codex",
): AgentPermissionRequest {
  return {
    id,
    provider,
    name: provider === "codex" ? "request_user_input" : "question",
    kind: "question",
    input: { questions },
  } as AgentPermissionRequest;
}

function q(header: string, options: string[]) {
  return {
    header,
    question: `${header}?`,
    options: options.map((label) => ({ label })),
  };
}

function input(
  control: "UP" | "DOWN" | "PRIMARY",
  action: "BEGIN" | "UPDATE" | "END" | "SHORT",
  interactionId: number,
) {
  return {
    type: "semantic-input" as const,
    control,
    action,
    interactionId,
    timeMillis: interactionId,
  };
}
