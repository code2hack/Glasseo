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

test("Draft Text renders stable safe tokens and routes only the accepted grammar", async () => {
  installDom();
  const key = { serverId: "alpha", agentId: "text" };
  let requests: string[] = [];
  const controller = new DraftController(new MemoryStorage());
  const root = new FakeElement("main") as unknown as HTMLElement;
  const view = new DraftDestinationBody(controller, () => requests);
  view.mount(root);
  view.update(context(key));
  await tick();
  const text = "<b>one</b>  two\n👩🏽‍💻";
  await controller.replaceText(text);
  await tick();

  const list = (root.children[0] as unknown as FakeElement).children[0]!;
  const textArea = list.children.find(
    ({ dataset }) => dataset.area === "text",
  )!;
  const textUnits = textArea.children[1]!;
  assert.equal(
    textUnits.children.map(({ textContent }) => textContent).join(""),
    text,
  );
  const stable = textUnits.children.find(
    ({ textContent }) => textContent === "one",
  )!;
  requests = ["request"];
  view.update(context(key));
  await tick();
  assert.equal(
    textUnits.children.find(({ textContent }) => textContent === "one"),
    stable,
  );

  assert.equal(view.handleInput(input("DOWN", "BEGIN", 501)), true);
  assert.equal(view.handleInput(input("PRIMARY", "SHORT", 502)), true);
  assert.equal(view.handleInput(input("DOWN", "BEGIN", 503)), true);
  await tick();
  assert.equal(
    textUnits.children.filter(({ className }) => className.includes("selected"))
      .length,
    2,
  );
  assert.equal(view.handleInput(input("PRIMARY", "SHORT", 504)), true);
  await tick();
  assert.equal(view.diagnostics().textSelectionActive, false);
  assert.equal(view.diagnostics().textCopyLength > 0, true);

  assert.equal(view.handleInput(input("PRIMARY", "SHORT", 505)), true);
  assert.equal(view.handleInput(input("SECONDARY", "LONG", 506)), true);
  await tick();
  const afterCut = controller.snapshot().session!.record.text;
  assert.notEqual(afterCut, text);
  assert.equal(view.handleInput(input("SECONDARY", "DOUBLE", 507)), false);
  assert.equal(controller.snapshot().session?.record.text, afterCut);
  assert.equal(view.handleInput(input("LEFT", "BEGIN", 508)), true);
  await tick();
  assert.equal(controller.snapshot().session?.record.activeArea, "request");
  assert.equal(controller.snapshot().session?.transient.textSelection, null);
  view.dispose();
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
  async putAgent(record: DraftRecord): Promise<boolean> {
    this.records.set(
      JSON.stringify([record.key.serverId, record.key.agentId]),
      record,
    );
    return true;
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
