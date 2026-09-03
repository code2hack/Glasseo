import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { normalizePermissionRequest } from "../src/paseo/adapter";
import {
  createRequestSession,
  projectRequest,
} from "../src/draft/request/model";
import { StandaloneRequestHarness } from "../src/draft/request/harness";

test("standalone Request harness renders selection/cursor and redacted diagnostics", () => {
  installDom();
  const root = new FakeElement("main") as unknown as HTMLElement;
  const harness = new StandaloneRequestHarness(root);
  const request = createRequestSession(
    projectRequest(
      "private-host",
      "private-agent",
      normalizePermissionRequest(question("private-request")),
    ),
  );
  harness.setRequests([request]);
  assert.equal(root.children.length, 3);
  assert.equal(
    (root.children[1] as unknown as FakeElement).className.includes("cursor"),
    true,
  );
  assert.equal(harness.handleInput(input("PRIMARY", "SHORT", 1)), true);
  assert.equal(
    (root.children[1] as unknown as FakeElement).className.includes("selected"),
    true,
  );
  assert.equal(harness.handleInput(input("DOWN", "BEGIN", 2)), true);
  assert.equal(
    (root.children[2] as unknown as FakeElement).className.includes("cursor"),
    true,
  );

  const encoded = JSON.stringify(harness.diagnostics());
  for (const secret of [
    "private-host",
    "private-agent",
    "private-request",
    "Alpha",
  ])
    assert.equal(encoded.includes(secret), false);

  harness.setRequests([]);
  assert.equal(root.children.length, 0);
});

function question(id: string): AgentPermissionRequest {
  return {
    id,
    provider: "codex",
    name: "request_user_input",
    kind: "question",
    title: "Private question",
    input: {
      questions: [
        {
          id: "private-field",
          header: "Private header",
          question: "Private prompt",
          options: [{ label: "Alpha" }, { label: "Beta" }],
        },
      ],
    },
  };
}

function input(
  control: "PRIMARY" | "DOWN",
  action: "SHORT" | "BEGIN",
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

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  dataset: Record<string, string> = {};
  textContent = "";
  constructor(readonly tagName: string) {}
  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }
}

function installDom(): void {
  Object.assign(globalThis, {
    document: { createElement: (tag: string) => new FakeElement(tag) },
  });
}
