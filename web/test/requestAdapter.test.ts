import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { normalizePermissionRequest } from "../src/paseo/adapter";

test("permission adapter preserves proven action semantics and redacts detail", () => {
  for (const kind of ["tool", "plan", "mode", "other"] as const) {
    const request = normalizePermissionRequest({
      id: `request-${kind}`,
      provider: "codex",
      name: kind,
      kind,
      title: ` ${kind} title `,
      detail: { type: "shell", command: "private-command" },
      actions:
        kind === "plan"
          ? [
              {
                id: "implement",
                label: "Implement",
                behavior: "allow",
                variant: "primary",
                intent: "implement",
              },
              {
                id: "dismiss",
                label: "Dismiss",
                behavior: "deny",
                variant: "danger",
                intent: "dismiss",
              },
            ]
          : undefined,
    });
    assert.equal(request.kind, kind);
    assert.equal(request.title, `${kind} title`);
    assert.deepEqual(request.detail, { type: "shell", truncated: false });
    assert.equal(JSON.stringify(request).includes("private-command"), false);
    assert.equal(request.actions.length, 2);
  }
});

test("permission adapter pins Codex, Claude, OMP, and Pi question forms", () => {
  for (const provider of ["codex", "claude", "omp", "pi"]) {
    const request = normalizePermissionRequest(
      question(provider, [
        {
          id: "choice",
          header: "Choice",
          question: "Choose",
          options: [{ label: "One", description: "First" }, { label: "Two" }],
          multiSelect: true,
          allowOther: true,
        },
        {
          header: "Comment",
          question: "Optional comment",
          options: [],
          multiSelect: false,
          allowEmpty: true,
          placeholder: "Optional",
        },
      ]),
    );
    assert.equal(request.unsupportedReason, null);
    assert.equal(request.questions.length, 2);
    assert.equal(request.questions[0]?.multiSelect, true);
    assert.equal(request.questions[0]?.allowOther, true);
    assert.equal(request.questions[1]?.allowEmpty, true);
    assert.deepEqual(
      request.questions[0]?.options.map(({ id }) => id),
      ["0", "1"],
    );
  }
});

test("unknown, malformed, duplicate, and secret questions fail closed", () => {
  const cases = [
    question("future", [validQuestion()]),
    question("codex", [{ ...validQuestion(), options: "invalid" }]),
    question("codex", [
      validQuestion(),
      { ...validQuestion(), question: "Duplicate header" },
    ]),
    question("codex", [{ ...validQuestion(), isSecret: true }]),
  ] as AgentPermissionRequest[];
  for (const fixture of cases) {
    const request = normalizePermissionRequest(fixture);
    assert.equal(request.questions.length, 0);
    assert.ok(request.unsupportedReason);
  }
});

function question(
  provider: string,
  questions: unknown[],
): AgentPermissionRequest {
  return {
    id: `question-${provider}`,
    provider,
    name: provider === "codex" ? "request_user_input" : "AskUserQuestion",
    kind: "question",
    input: { questions },
  };
}

function validQuestion() {
  return {
    header: "Header",
    question: "Question?",
    options: [{ label: "Answer" }],
    multiSelect: false,
  };
}
