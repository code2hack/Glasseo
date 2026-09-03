import assert from "node:assert/strict";
import test from "node:test";
import { DraftController } from "../src/draft/controller";
import { DraftDestinationBody } from "../src/draft/view";
import type { AgentKey } from "../src/directory/types";
import type { DraftRecord, DraftStorage } from "../src/draft/types";
import type { SemanticInput } from "../src/native/semanticInput";

test("Draft body keeps keyed areas, routes owned input, and redacts diagnostics", async () => {
  installDom();
  const key = { serverId: "private-host", agentId: "private-agent" };
  let requests = ["private-request-a", "private-request-b"];
  const controller = new DraftController(new MemoryStorage());
  const root = new FakeElement("main") as unknown as HTMLElement;
  const view = new DraftDestinationBody(controller, () => requests);
  view.mount(root);
  view.update(context(key));
  await tick();

  const viewport = root.children[0] as unknown as FakeElement;
  const list = viewport.children[0]!;
  assert.deepEqual(
    list.children.map((area) => area.dataset.area),
    ["request", "text"],
  );
  const requestArea = list.children[0];
  assert.equal(view.handleInput(input("RIGHT", "BEGIN", 1)), true);
  await tick();
  assert.equal(controller.snapshot().session?.record.activeArea, "request");
  assert.equal(view.handleInput(input("DOWN", "BEGIN", 2)), true);
  await tick();
  assert.equal(
    controller.snapshot().session?.record.cursors.requestId,
    "private-request-b",
  );

  await controller.appendImageRefs([
    {
      id: "private-image",
      token: "private-token",
      mimeType: "image/jpeg",
      capturedAt: 1,
    },
  ]);
  assert.deepEqual(
    list.children.map((area) => area.dataset.area),
    ["request", "text", "images"],
  );
  assert.equal(list.children[0], requestArea);
  requests = [];
  view.update(context(key));
  await tick();
  assert.deepEqual(
    list.children.map((area) => area.dataset.area),
    ["text", "images"],
  );
  assert.equal(controller.snapshot().session?.record.activeArea, "text");
  assert.equal(view.handleInput(input("COMMAND", "SHORT", 3)), false);

  const encoded = JSON.stringify(view.diagnostics());
  assert.equal(view.diagnostics().duplicateDomAreas, 0);
  assert.equal(view.diagnostics().lastHandled?.interactionId, 2);
  for (const secret of [
    "private-host",
    "private-agent",
    "private-request",
    "private-image",
    "private-token",
  ])
    assert.equal(encoded.includes(secret), false);
  view.dispose();
  assert.equal(controller.snapshot().current, null);
});

function context(key: AgentKey) {
  return {
    destination: { kind: "agent" as const, key, pane: "draft" as const },
    timeline: null,
  };
}

function input(
  control: SemanticInput["control"],
  action: SemanticInput["action"],
  interactionId: number,
): SemanticInput {
  return {
    type: "semantic-input",
    control,
    action,
    interactionId,
    timeMillis: interactionId,
  };
}

class MemoryStorage implements DraftStorage {
  private readonly records = new Map<string, DraftRecord>();
  async loadAgent(key: AgentKey): Promise<unknown | null> {
    return (
      this.records.get(JSON.stringify([key.serverId, key.agentId])) ?? null
    );
  }
  async loadHost(serverId: string): Promise<unknown[]> {
    return [...this.records.values()].filter(
      (record) => record.key.serverId === serverId,
    );
  }
  async putAgent(record: DraftRecord): Promise<void> {
    this.records.set(
      JSON.stringify([record.key.serverId, record.key.agentId]),
      record,
    );
  }
  async deleteAgent(key: AgentKey): Promise<void> {
    this.records.delete(JSON.stringify([key.serverId, key.agentId]));
  }
  async deleteHost(serverId: string): Promise<void> {
    for (const [id, record] of this.records)
      if (record.key.serverId === serverId) this.records.delete(id);
  }
}

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  hidden = false;
  scrollTop = 0;
  scrollCalls = 0;
  constructor(readonly tagName: string) {}
  get scrollHeight(): number {
    return this.children.length * 48;
  }
  get clientHeight(): number {
    return 200;
  }
  append(...items: FakeElement[]): void {
    for (const item of items) {
      item.parent?.children.splice(item.parent.children.indexOf(item), 1);
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items: FakeElement[]): void {
    this.children.forEach((child) => (child.parent = null));
    this.children = [];
    this.append(...items);
  }
  remove(): void {
    if (this.parent)
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const matches = this.children.flatMap((child) => [
      ...(selector === ".draft-unit" &&
      child.className.split(" ").includes("draft-unit")
        ? [child]
        : []),
      ...child.querySelectorAll(selector),
    ]);
    return matches;
  }
  setAttribute(): void {}
  removeAttribute(): void {}
  scrollIntoView(): void {
    this.scrollCalls++;
  }
}

function installDom(): void {
  Object.assign(globalThis, {
    document: { createElement: (name: string) => new FakeElement(name) },
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
