import assert from "node:assert/strict";
import test from "node:test";
import { createTimelineComposition } from "../src/app/bootstrap";
import {
  DestinationHost,
  type DestinationBody,
} from "../src/app/destinationHost";
import { InputRouter } from "../src/app/inputRouter";
import { projectTimelineRow } from "../src/timeline/presentation";
import { TimelineDestinationBody } from "../src/timeline/view";
import type {
  AgentTimelineSnapshot,
  TimelineRow,
  TimelineStorage,
} from "../src/timeline/types";
import type { SemanticInput } from "../src/native/semanticInput";

test("projects every pinned Timeline item and safely falls back for future types", () => {
  const items: TimelineRow["item"][] = [
    { type: "user_message", text: "user" },
    { type: "assistant_message", text: "assistant" },
    { type: "reasoning", text: "reasoning" },
    {
      type: "tool_call",
      callId: "call",
      name: "exec",
      detail: { type: "plain_text", text: "tool detail" },
      status: "completed",
      error: null,
    },
    { type: "todo", items: [{ text: "task", completed: false }] },
    { type: "error", message: "failure" },
    { type: "compaction", status: "loading" },
  ];
  assert.deepEqual(
    items.map(
      (item, index) => projectTimelineRow(row(String(index), item)).kind,
    ),
    ["user", "assistant", "reasoning", "tool", "status", "error", "status"],
  );
  assert.match(
    projectTimelineRow(row("future", { type: "future_notice" } as never)).text,
    /future_notice/,
  );
});

test("Timeline keeps keyed rows, protects diagnostics, and handles follow and held scrolling", async () => {
  installDom();
  const calls = {
    following: [] as boolean[],
    latest: [] as boolean[],
    acknowledge: 0,
    older: 0,
  };
  let current = snapshot(
    Array.from({ length: 8 }, (_, index) =>
      row(String(index), {
        type: "assistant_message",
        text: index === 0 ? "private prompt" : `row ${index}`,
      }),
    ),
  );
  const controller = {
    loadOlder: async () => {
      calls.older++;
      return { anchorRowId: "0" };
    },
    setFollowing: (value: boolean) => calls.following.push(value),
    setAtLatest: (value: boolean) => calls.latest.push(value),
    acknowledgeLatest: () => calls.acknowledge++,
  };
  const root = new FakeElement("main") as unknown as HTMLElement;
  const view = new TimelineDestinationBody(controller);
  view.mount(root);
  view.update(context(current));
  const list = (root.children[0] as unknown as FakeElement)
    .children[0] as FakeElement;
  const original = list.children[0];

  current = {
    ...current,
    revision: 2,
    rows: [
      { ...current.rows[0]!, provisional: false },
      ...current.rows.slice(1),
    ],
  };
  view.update(context(current));
  assert.equal(list.children[0], original);
  assert.equal(
    new Set(list.children.map((item) => item.dataset.rowId)).size,
    8,
  );
  assert.equal(
    JSON.stringify(view.diagnostics()).includes("private prompt"),
    false,
  );

  current = {
    ...current,
    following: false,
    atLatest: false,
    stale: true,
    unseenLiveCount: 3,
  };
  view.update(context(current));
  assert.equal(view.diagnostics().stale, true);
  assert.equal(view.diagnostics().unseenLiveCount, 3);
  const viewport = root.children[0] as unknown as FakeElement;
  viewport.scrollTop = 120;
  assert.equal(view.handleInput(input("UP", "BEGIN", 1, 100)), true);
  assert.equal(viewport.scrollTop, 96);
  assert.equal(view.handleInput(input("UP", "UPDATE", 1, 200)), true);
  assert.ok(viewport.scrollTop < 96);
  assert.equal(view.handleInput(input("UP", "CANCEL", 1, 201)), true);
  assert.equal(view.handleInput(input("PRIMARY", "SHORT", 2)), true);
  assert.deepEqual(calls.following, [true]);
  assert.equal(view.handleInput(input("PRIMARY", "LONG", 3)), true);
  assert.equal(calls.acknowledge, 1);
  assert.equal(calls.latest[calls.latest.length - 1], true);
  assert.equal(view.handleInput(input("SECONDARY", "LONG", 4)), false);
  assert.equal(view.handleInput(input("SECONDARY", "DOUBLE", 5)), false);

  current = { ...current, hasOlder: true, error: null };
  view.update(context(current));
  viewport.scrollTop = 0;
  viewport.dispatch("scroll");
  viewport.dispatch("scroll");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.older, 1);

  viewport.scrollTop = 75;
  current = {
    ...current,
    hasOlder: false,
    range: { epoch: "replacement", startSeq: 1, endSeq: 1 },
    rows: [row("replacement", { type: "assistant_message", text: "new" })],
  };
  view.update(context(current));
  assert.equal(viewport.scrollTop, 0);
  view.dispose();
});

test("Timeline preserves reading anchors across live, prepend, and Agent switches", async () => {
  installDom();
  let finishOlder!: (value: { anchorRowId: string | null }) => void;
  const controller = {
    loadOlder: () =>
      new Promise<{ anchorRowId: string | null }>((resolve) => {
        finishOlder = resolve;
      }),
    setFollowing() {},
    setAtLatest() {},
    acknowledgeLatest() {},
  };
  const root = new FakeElement("main") as unknown as HTMLElement;
  const view = new TimelineDestinationBody(controller);
  const agentA = { serverId: "server", agentId: "a" };
  const agentB = { serverId: "server", agentId: "b" };
  const initialRows = Array.from({ length: 6 }, (_, index) =>
    row(String(index), { type: "assistant_message", text: `row ${index}` }),
  );
  let current = {
    ...snapshot(initialRows),
    key: agentA,
    following: false,
    atLatest: false,
  };
  view.mount(root);
  view.update(context(current));
  const viewport = root.children[0] as unknown as FakeElement;
  viewport.scrollTop = 75;

  current = {
    ...current,
    revision: 2,
    rows: [
      ...current.rows,
      row("6", { type: "assistant_message", text: "live" }),
    ],
    unseenLiveCount: 1,
  };
  view.update(context(current));
  assert.equal(viewport.scrollTop, 75);
  assert.equal(view.diagnostics().unseenLiveCount, 1);

  current = { ...current, revision: 3, following: true, atLatest: true };
  view.update(context(current));
  assert.equal(viewport.scrollTop, viewport.scrollHeight);

  current = {
    ...current,
    revision: 4,
    following: false,
    atLatest: false,
    hasOlder: true,
  };
  view.update(context(current));
  viewport.scrollTop = 0;
  viewport.dispatch("scroll");
  current = {
    ...current,
    revision: 5,
    hasOlder: false,
    rows: [
      row("-2", { type: "assistant_message", text: "older 2" }),
      row("-1", { type: "assistant_message", text: "older 1" }),
      ...current.rows,
    ],
  };
  view.update(context(current));
  finishOlder({ anchorRowId: "0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewport.scrollTop, 100);

  viewport.scrollTop = 125;
  view.update(
    context({
      ...snapshot(initialRows.slice(0, 3)),
      key: agentB,
      following: false,
      atLatest: false,
    }),
  );
  viewport.scrollTop = 25;
  view.update(context(current));
  assert.equal(viewport.scrollTop, 125);
  view.update(
    context({
      ...snapshot(initialRows.slice(0, 3)),
      key: agentB,
      following: false,
      atLatest: false,
    }),
  );
  assert.equal(viewport.scrollTop, 25);
  view.dispose();
});

test("pending older load does not override a newer user scroll", async () => {
  const { view, viewport, finishOlder, prepended } = pendingOlderTimeline();
  view.update(context(prepended));
  assert.equal(viewport.scrollTop, 100);

  viewport.scrollTop = 200;
  viewport.dispatch("scroll");
  finishOlder({ anchorRowId: "0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewport.scrollTop, 200);
  view.dispose();
});

test("pending older load does not override long PRIMARY latest intent", async () => {
  const { view, viewport, finishOlder, prepended } = pendingOlderTimeline();
  view.update(context(prepended));
  view.handleInput(input("PRIMARY", "LONG", 1));
  assert.equal(viewport.scrollTop, viewport.scrollHeight);

  finishOlder({ anchorRowId: "0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewport.scrollTop, viewport.scrollHeight);
  view.dispose();
});

test("failed and reset older loads do not move the current viewport", async () => {
  const failed = pendingOlderTimeline();
  failed.viewport.scrollTop = 75;
  failed.finishOlder({ anchorRowId: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failed.viewport.scrollTop, 75);
  failed.view.dispose();

  const reset = pendingOlderTimeline();
  reset.view.update(
    context({
      ...snapshot([
        row("replacement", {
          type: "assistant_message",
          text: "replacement",
        }),
      ]),
      range: { epoch: "replacement", startSeq: 1, endSeq: 1 },
      error: "reset",
    }),
  );
  const resetPosition = reset.viewport.scrollTop;
  reset.finishOlder({ anchorRowId: "0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reset.viewport.scrollTop, resetPosition);
  reset.view.dispose();
});

test("Agent switches and disposal fence pending older loads", async () => {
  const switched = pendingOlderTimeline();
  switched.view.update(
    context({
      ...snapshot(switched.rows.slice(0, 3)),
      key: { serverId: "server", agentId: "other" },
      following: false,
      atLatest: false,
    }),
  );
  switched.viewport.scrollTop = 25;
  switched.finishOlder({ anchorRowId: "0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(switched.viewport.scrollTop, 25);
  switched.view.dispose();

  const disposed = pendingOlderTimeline();
  disposed.viewport.scrollTop = 40;
  disposed.view.dispose();
  disposed.finishOlder({ anchorRowId: "0" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed.viewport.scrollTop, 40);
});

test("destination changes dispose bodies and the router delegates each terminal once", () => {
  installDom();
  const root = new FakeElement("main") as unknown as HTMLElement;
  const bodies: FakeBody[] = [];
  const factory = () => {
    const body = new FakeBody();
    bodies.push(body);
    return body;
  };
  const host = new DestinationHost(root, {
    timeline: factory,
    draft: factory,
    config: factory,
  });
  const timeline = context(snapshot([]));
  host.update(timeline);
  host.update(timeline);
  assert.equal(bodies.length, 1);
  host.update({
    ...timeline,
    destination: { ...timeline.destination, pane: "draft" },
  });
  assert.equal(bodies[0]!.disposed, true);
  assert.equal(bodies.length, 2);

  bodies[1]!.handled = true;
  const pagerInputs: SemanticInput[] = [];
  const router = new InputRouter(host, {
    handle: (value) => pagerInputs.push(value),
  });
  router.handle(input("PRIMARY", "SHORT", 7));
  router.handle(input("PRIMARY", "SHORT", 7));
  bodies[1]!.handled = false;
  router.handle(input("COMMAND", "SHORT", 8));
  assert.equal(bodies[1]!.inputs.length, 2);
  assert.deepEqual(
    pagerInputs.map(({ interactionId }) => interactionId),
    [8],
  );
  bodies[1]!.throwOnUpdate = true;
  assert.doesNotThrow(() =>
    host.update({
      ...timeline,
      destination: { ...timeline.destination, pane: "draft" },
    }),
  );
  assert.equal(host.rendererLossCount, 1);
});

test("normal Timeline composition binds and disposes each production source once", () => {
  let directoryUnsubscribed = 0;
  let leasesUnsubscribed = 0;
  const directory = {
    snapshot: emptyDirectory,
    subscribe(listener: (value: ReturnType<typeof emptyDirectory>) => void) {
      listener(emptyDirectory());
      return () => directoryUnsubscribed++;
    },
  };
  const registry = {
    subscribeRuntimeLeases(listener: (value: readonly never[]) => void) {
      listener([]);
      return () => leasesUnsubscribed++;
    },
  };
  const composition = createTimelineComposition(
    directory,
    registry,
    new MemoryStorage(),
  );
  composition.dispose();
  assert.equal(directoryUnsubscribed, 1);
  assert.equal(leasesUnsubscribed, 1);
  assert.equal(composition.coordinator.snapshot().replicas.size, 0);
});

class FakeBody implements DestinationBody {
  disposed = false;
  handled = false;
  throwOnUpdate = false;
  inputs: SemanticInput[] = [];
  mount(): void {}
  update(): void {
    if (this.throwOnUpdate) throw new Error("renderer");
  }
  handleInput(input: SemanticInput): boolean {
    this.inputs.push(input);
    return this.handled;
  }
  dispose(): void {
    this.disposed = true;
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
  clientHeight = 100;
  private listeners = new Map<string, Set<() => void>>();

  constructor(readonly tagName: string) {}
  get scrollHeight(): number {
    if (this.className === "timeline-viewport")
      return (this.children[0]?.children.length ?? 0) * 50;
    return this.children.length * 50;
  }
  append(...items: FakeElement[]): void {
    for (const item of items) {
      item.parent?.children.splice(item.parent.children.indexOf(item), 1);
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...items);
  }
  remove(): void {
    if (this.parent)
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(): void {}
  addEventListener(name: string, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name: string, listener: () => void): void {
    this.listeners.get(name)?.delete(listener);
  }
  dispatch(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
  getBoundingClientRect() {
    if (this.className === "timeline-viewport")
      return rect(0, this.clientHeight);
    const viewport = ancestors(this).find(
      (value) => value.className === "timeline-viewport",
    );
    const index = this.parent?.children.indexOf(this) ?? 0;
    const top = index * 50 - (viewport?.scrollTop ?? 0);
    return rect(top, top + 50);
  }
}

function installDom(): void {
  Object.assign(globalThis, {
    document: { createElement: (name: string) => new FakeElement(name) },
    getComputedStyle: () => ({ lineHeight: "24px" }),
  });
}

function ancestors(element: FakeElement): FakeElement[] {
  const values: FakeElement[] = [];
  for (let value = element.parent; value; value = value.parent)
    values.push(value);
  return values;
}

function rect(top: number, bottom: number) {
  return {
    top,
    bottom,
    left: 0,
    right: 480,
    width: 480,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON() {},
  };
}

function row(id: string, item: TimelineRow["item"]): TimelineRow {
  return {
    id,
    provider: "codex",
    item,
    timestamp: "2026-09-03T00:00:00Z",
    seqStart: Number(id) || 1,
    seqEnd: Number(id) || 1,
    sourceSeqRanges: [],
    collapsed: [],
    provisional: true,
  };
}

function snapshot(rows: readonly TimelineRow[]): AgentTimelineSnapshot {
  return {
    key: { serverId: "server", agentId: "agent" },
    rows,
    range: { epoch: "epoch", startSeq: 1, endSeq: Math.max(1, rows.length) },
    hasOlder: false,
    hasNewer: false,
    loading: false,
    olderLoading: false,
    catchingUp: false,
    stale: false,
    error: null,
    sourceToken: { serverId: "server", slotGeneration: 1, connectionEpoch: 1 },
    revision: 1,
    following: true,
    atLatest: true,
    unseenLiveCount: 0,
    duplicateCount: 0,
    gapCount: 0,
  };
}

function context(timeline: AgentTimelineSnapshot) {
  return {
    destination: {
      kind: "agent" as const,
      key: timeline.key,
      pane: "timeline" as const,
    },
    timeline,
  };
}

function input(
  control: SemanticInput["control"],
  action: SemanticInput["action"],
  interactionId: number,
  timeMillis = 1,
): SemanticInput {
  return { type: "semantic-input", control, action, interactionId, timeMillis };
}

function pendingOlderTimeline() {
  installDom();
  let finishOlder!: (value: { anchorRowId: string | null }) => void;
  const view = new TimelineDestinationBody({
    loadOlder: () =>
      new Promise<{ anchorRowId: string | null }>((resolve) => {
        finishOlder = resolve;
      }),
    setFollowing() {},
    setAtLatest() {},
    acknowledgeLatest() {},
  });
  const root = new FakeElement("main") as unknown as HTMLElement;
  const rows = Array.from({ length: 6 }, (_, index) =>
    row(String(index), { type: "assistant_message", text: `row ${index}` }),
  );
  const current = {
    ...snapshot(rows),
    following: false,
    atLatest: false,
    hasOlder: true,
  };
  view.mount(root);
  view.update(context(current));
  const viewport = root.children[0] as unknown as FakeElement;
  viewport.dispatch("scroll");
  return {
    view,
    viewport,
    rows,
    finishOlder,
    prepended: {
      ...current,
      revision: 2,
      hasOlder: false,
      rows: [
        row("-2", { type: "assistant_message", text: "older 2" }),
        row("-1", { type: "assistant_message", text: "older 1" }),
        ...rows,
      ],
    },
  };
}

function emptyDirectory() {
  return {
    hosts: new Map(),
    orderedAgents: [],
    current: null,
    destination: "config" as const,
    restoring: false,
  };
}

class MemoryStorage implements TimelineStorage {
  async loadAgent() {
    return null;
  }
  async putAgent() {}
  async deleteAgent() {}
  async deleteHost() {}
}
