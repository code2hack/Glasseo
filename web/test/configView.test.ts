import assert from "node:assert/strict";
import test from "node:test";
import { ConfigController } from "../src/config/controller";
import { HOSTS_SECTION_ID, rowId } from "../src/config/project";
import { ConfigDestinationBody } from "../src/config/view";
import {
  CONFIG_UI_VERSION,
  type ConfigRow,
  type ConfigSectionProvider,
  type ConfigStorage,
} from "../src/config/types";
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
  let shellInvalidations = 0;
  const view = new ConfigDestinationBody(
    controller,
    () => shellInvalidations++,
  );
  view.mount(root);
  assert.equal(shellInvalidations, 0);
  view.update({
    destination: { kind: "config", returnTo: null },
    timeline: null,
  });
  const viewport = root.children[0] as unknown as FakeElement;
  const list = viewport.children[0]!;
  assert.equal(list.children.length, 4);
  const hosts = list.children[2];

  assert.equal(view.handleInput(input("PRIMARY", 1)), true);
  assert.equal(shellInvalidations, 1);
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

test("provider Host fold state, glyph, aria, and children update together after restore", async () => {
  installDom();
  const hostId = rowId("hosts", "host", "alpha");
  const childId = rowId("hosts", "status", "alpha");
  const provider: ConfigSectionProvider = {
    sectionId: HOSTS_SECTION_ID,
    rows: (expanded) => providerHostRows(hostId, childId, expanded.has(hostId)),
    subscribe: () => () => {},
    activate: () => {},
  };
  const controller = new ConfigController(
    new EmptyDirectory(),
    {
      load: async () => ({
        schemaVersion: CONFIG_UI_VERSION,
        revision: 1,
        updatedAt: 1,
        expandedRowIds: [HOSTS_SECTION_ID, hostId],
        focusedRowId: hostId,
      }),
      put: async () => {},
    },
    () => false,
    undefined,
    [provider],
  );
  await controller.restore();
  const root = new FakeElement("main") as unknown as HTMLElement;
  const view = new ConfigDestinationBody(controller);
  view.mount(root);
  const list = root.children[0]!.children[0]! as unknown as FakeElement;
  let host = rowWithLabel(list, "Host Alpha");
  assert.equal(host.children[0]?.textContent, "−");
  assert.equal(host.getAttribute("aria-expanded"), "true");
  assert.ok(rowWithLabel(list, "Online"));

  view.handleInput(input("PRIMARY", 1));
  host = rowWithLabel(list, "Host Alpha");
  assert.equal(host.children[0]?.textContent, "+");
  assert.equal(host.getAttribute("aria-expanded"), "false");
  assert.equal(hasRowWithLabel(list, "Online"), false);

  view.handleInput(input("PRIMARY", 2));
  host = rowWithLabel(list, "Host Alpha");
  assert.equal(host.children[0]?.textContent, "−");
  assert.equal(host.getAttribute("aria-expanded"), "true");
  assert.equal(hasRowWithLabel(list, "Online"), true);
  view.dispose();
  controller.dispose();
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
  private readonly attributes = new Map<string, string>();
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
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  scrollIntoView(): void {
    if (this.parent?.parent) this.parent.parent.scrollCalls++;
  }
}

function providerHostRows(
  hostId: string,
  childId: string,
  expanded: boolean,
): readonly ConfigRow[] {
  return [
    {
      id: hostId,
      parentId: HOSTS_SECTION_ID,
      kind: "host",
      depth: 1,
      label: "Host Alpha",
      detail: null,
      foldable: true,
      expanded,
      agentKey: null,
      action: null,
    },
    {
      id: childId,
      parentId: hostId,
      kind: "detail",
      depth: 2,
      label: "Online",
      detail: null,
      foldable: false,
      expanded: false,
      agentKey: null,
      action: null,
    },
  ];
}

function hasRowWithLabel(list: FakeElement, label: string): boolean {
  return list.children.some((row) => row.children[1]?.textContent === label);
}

function rowWithLabel(list: FakeElement, label: string): FakeElement {
  const row = list.children.find(
    (candidate) => candidate.children[1]?.textContent === label,
  );
  assert.ok(row, `missing row ${label}`);
  return row;
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
    action: control === "UP" || control === "DOWN" ? "BEGIN" : "SHORT",
    interactionId,
    timeMillis: interactionId,
  };
}
