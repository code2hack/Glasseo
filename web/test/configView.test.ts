import assert from "node:assert/strict";
import test from "node:test";
import { ConfigController } from "../src/config/controller";
import { ConfigDestinationBody } from "../src/config/view";
import type { ConfigStorage } from "../src/config/types";
import type { GlobalAgentDirectorySnapshot } from "../src/directory/types";
import type { SemanticInput } from "../src/native/semanticInput";

test("Config view keeps keyed rows, routes only owned input, and redacts diagnostics", () => {
  installDom();
  const directory = new EmptyDirectory();
  const controller = new ConfigController(
    directory,
    memoryStorage,
    () => false,
  );
  const root = new FakeElement("main") as unknown as HTMLElement;
  const view = new ConfigDestinationBody(controller);
  view.mount(root);
  view.update({
    destination: { kind: "config", returnTo: null },
    timeline: null,
  });
  const viewport = root.children[0] as unknown as FakeElement;
  const list = viewport.children[0]!;
  assert.equal(list.children.length, 4);
  const hosts = list.children[2];

  assert.equal(view.handleInput(input("PRIMARY", 1)), true);
  assert.equal(list.children.length, 3);
  assert.equal(list.children[1], hosts);
  assert.equal(view.handleInput(input("DOWN", 2)), true);
  assert.equal(view.handleInput(input("PRIMARY", 3)), true);
  assert.equal(list.children.length, 4);
  assert.equal(list.children[1], hosts);
  assert.equal(view.handleInput(input("COMMAND", 4)), false);
  assert.ok(viewport.scrollCalls > 0);

  const diagnostics = view.diagnostics();
  assert.equal(diagnostics.duplicateDomRows, 0);
  assert.equal(diagnostics.visibleRowCount, 4);
  assert.equal(diagnostics.lastControl, "PRIMARY");
  assert.equal(
    JSON.stringify(diagnostics).includes('["section","workspaces"]'),
    false,
  );
  view.dispose();
  assert.equal(directory.listenerCount, 1);
  controller.dispose();
  assert.equal(directory.listenerCount, 0);
});

class EmptyDirectory {
  listenerCount = 0;
  private readonly value: GlobalAgentDirectorySnapshot = {
    hosts: new Map(),
    orderedAgents: [],
    current: null,
    destination: "config",
    restoring: false,
  };
  snapshot() {
    return this.value;
  }
  subscribe(listener: (value: GlobalAgentDirectorySnapshot) => void) {
    this.listenerCount++;
    listener(this.value);
    return () => this.listenerCount--;
  }
}

const memoryStorage: ConfigStorage = {
  load: async () => null,
  put: async () => {},
};

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  dataset: Record<string, string> = {};
  style = { setProperty() {} };
  className = "";
  textContent = "";
  hidden = false;
  scrollTop = 0;
  scrollCalls = 0;
  constructor(readonly tagName: string) {}
  get scrollHeight(): number {
    return this.children.length * 42;
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
  setAttribute(): void {}
  removeAttribute(): void {}
  scrollIntoView(): void {
    if (this.parent?.parent) this.parent.parent.scrollCalls++;
  }
}

function installDom(): void {
  Object.assign(globalThis, {
    document: { createElement: (name: string) => new FakeElement(name) },
  });
}

function input(
  control: SemanticInput["control"],
  interactionId: number,
): SemanticInput {
  return {
    type: "semantic-input",
    control,
    action: "SHORT",
    interactionId,
    timeMillis: interactionId,
  };
}
