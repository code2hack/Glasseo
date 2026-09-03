import assert from "node:assert/strict";
import test from "node:test";
import {
  availableDraftAreas,
  createDraftSession,
  reduceDraft,
  validateDraftRecord,
} from "../src/draft/model";
import { DraftController } from "../src/draft/controller";
import { draftDiagnostics } from "../src/draft/diagnostics";
import { bindDraftLifecycle } from "../src/draft/lifecycle";
import { draftKey, IndexedDbDraftStorage } from "../src/draft/storage";
import type { DraftRecord, DraftStorage } from "../src/draft/types";
import type { GlobalAgentDirectorySnapshot } from "../src/directory/types";
import type {
  HostRuntimeLease,
  HostRuntimeLeaseListener,
} from "../src/hosts/types";
import type { SemanticInput } from "../src/native/semanticInput";

test("Draft areas are canonical, dynamic, wrapping, and cursor-bounded", () => {
  const record = draft({
    images: [image("one"), image("two")],
    activeArea: "text",
  });
  let state = createDraftSession(record, ["request-a", "request-b"]);
  assert.deepEqual(availableDraftAreas(state), ["request", "text", "images"]);

  state = reduceDraft(state, input("LEFT", 1)).state;
  assert.equal(state.record.activeArea, "request");
  state = reduceDraft(state, input("UP", 2)).state;
  assert.equal(state.record.cursors.requestId, "request-a");
  state = reduceDraft(state, input("DOWN", 3)).state;
  state = reduceDraft(state, input("DOWN", 4)).state;
  assert.equal(state.record.cursors.requestId, "request-b");
  state = reduceDraft(state, input("RIGHT", 5)).state;
  assert.equal(state.record.activeArea, "text");
  const textMove = reduceDraft(state, input("DOWN", 6));
  assert.equal(textMove.state.record, state.record);
  assert.equal(textMove.effect, "none");
  assert.equal(textMove.handled, true);
  state = textMove.state;
  state = reduceDraft(state, input("RIGHT", 7)).state;
  state = reduceDraft(state, input("DOWN", 8)).state;
  state = reduceDraft(state, input("DOWN", 9)).state;
  assert.equal(state.record.cursors.imageId, "two");
  state = reduceDraft(state, input("RIGHT", 10)).state;
  assert.equal(state.record.activeArea, "request");
});

test("disappearing optional areas fall back without losing surviving cursors", () => {
  let state = createDraftSession(
    draft({
      images: [image("one")],
      activeArea: "images",
      cursors: { requestId: "request-b", textOffset: 2, imageId: "one" },
    }),
    ["request-a", "request-b"],
  );
  state = reduceDraft(state, { type: "set-images", images: [] }).state;
  assert.equal(state.record.activeArea, "text");
  assert.equal(state.record.cursors.imageId, null);
  assert.equal(state.record.cursors.requestId, "request-b");
  state = reduceDraft(state, { type: "set-requests", requestIds: [] }).state;
  assert.deepEqual(availableDraftAreas(state), ["text"]);
  assert.equal(reduceDraft(state, input("RIGHT", 11)).effect, "none");
});

test("request descriptor changes keep the current stable ID and update order", () => {
  let state = createDraftSession(draft({ activeArea: "request" }), ["a"]);
  state = reduceDraft(state, {
    type: "set-requests",
    requestIds: ["b", "a"],
  }).state;
  assert.deepEqual(state.requestIds, ["b", "a"]);
  assert.equal(state.record.cursors.requestId, "a");
  state = reduceDraft(state, input("UP", 11)).state;
  assert.equal(state.record.cursors.requestId, "b");
});

test("Draft consumes each supported terminal interaction once", () => {
  const state = createDraftSession(draft({ images: [image("one")] }), []);
  const moved = reduceDraft(state, input("RIGHT", 12));
  assert.equal(moved.effect, "persist");
  assert.equal(moved.state.record.activeArea, "images");
  const duplicate = reduceDraft(moved.state, input("RIGHT", 12));
  assert.equal(duplicate.effect, "none");
  assert.equal(duplicate.handled, true);
  const begun = reduceDraft(moved.state, input("RIGHT", 13, "BEGIN"));
  assert.equal(begun.effect, "persist");
  assert.equal(begun.state.record.activeArea, "text");
  assert.equal(
    reduceDraft(begun.state, input("RIGHT", 13, "UPDATE")).effect,
    "none",
  );
  assert.equal(reduceDraft(moved.state, input("COMMAND", 14)).handled, false);
});

test("every Draft area combination cycles in canonical order", () => {
  for (const requestIds of [[], ["request"]]) {
    for (const images of [[], [image("image")]]) {
      let state = createDraftSession(draft({ images }), requestIds);
      const expected = [
        ...(requestIds.length ? ["request"] : []),
        "text",
        ...(images.length ? ["images"] : []),
      ];
      assert.deepEqual(availableDraftAreas(state), expected);
      for (let index = 0; index < expected.length; index++)
        state = reduceDraft(state, input("RIGHT", 20 + index)).state;
      assert.equal(state.record.activeArea, "text");
    }
  }
});

test("stored Draft validation clamps Unicode offsets and isolates corrupt records", () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const value = draft({
    key,
    text: "a😀b",
    cursors: {
      requestId: null,
      textOffset: 2,
      imageId: null,
    },
  });
  assert.equal(validateDraftRecord(value, key).cursors.textOffset, 1);
  assert.equal(
    validateDraftRecord(
      { ...value, cursors: { ...value.cursors, textOffset: -5 } },
      key,
    ).cursors.textOffset,
    0,
  );
  assert.throws(() =>
    validateDraftRecord({ ...value, key: { ...key, serverId: "beta" } }, key),
  );
  assert.throws(() =>
    validateDraftRecord(
      { ...value, images: [image("same"), image("same")] },
      key,
    ),
  );
  assert.throws(() => validateDraftRecord({ ...value, schemaVersion: 0 }, key));
});

test("controller isolates composite identities, restores persistent state, and resets transient state", async () => {
  const storage = new MemoryDraftStorage();
  const alpha = { serverId: "alpha", agentId: "same" };
  const beta = { serverId: "beta", agentId: "same" };
  const controller = new DraftController(storage, () => 100);

  await controller.activate(alpha);
  await controller.replaceText("alpha text");
  await controller.setTextCursor(5);
  await controller.appendImageRefs([image("alpha-image")]);
  await controller.cycleArea("right");
  assert.equal(controller.snapshot().session?.record.activeArea, "images");

  await controller.activate(beta, ["request"]);
  await controller.replaceText("beta text");
  assert.equal(controller.snapshot().session?.record.text, "beta text");
  await controller.activate(alpha);
  assert.equal(controller.snapshot().session?.record.text, "alpha text");
  assert.equal(controller.snapshot().session?.record.activeArea, "images");
  assert.deepEqual(controller.snapshot().session?.transient, {
    mode: "edit",
    textSelection: null,
    selectedImageIds: [],
    provisionalText: null,
    wheelOpen: false,
    pending: false,
  });
  assert.notEqual(draftKey(alpha), draftKey(beta));

  const sameHost = { serverId: "alpha", agentId: "other" };
  await controller.activate(sameHost);
  await controller.replaceText("same host, other Agent");
  const restarted = new DraftController(storage);
  await restarted.activate(alpha);
  assert.equal(restarted.snapshot().session?.record.text, "alpha text");
  await restarted.activate(sameHost);
  assert.equal(
    restarted.snapshot().session?.record.text,
    "same host, other Agent",
  );
});

test("controller fences delayed loads and keeps in-memory state on write failure", async () => {
  const storage = new MemoryDraftStorage();
  const slow = { serverId: "alpha", agentId: "slow" };
  const fast = { serverId: "alpha", agentId: "fast" };
  const delayed = deferred<unknown | null>();
  storage.loads.set(draftKey(slow), delayed.promise);
  const controller = new DraftController(storage, () => 200);
  const activating = controller.activate(slow);
  await controller.activate(fast);
  delayed.resolve(draft({ key: slow, text: "stale" }));
  await activating;
  assert.deepEqual(controller.snapshot().current, fast);

  storage.failWrites = true;
  await controller.replaceText("retained");
  assert.equal(controller.snapshot().session?.record.text, "retained");
  assert.equal(controller.snapshot().storageStatus, "error");
  storage.failWrites = false;
  await controller.replaceText("recovered");
  assert.equal(controller.snapshot().storageStatus, "ready");
});

test("same-Agent delayed loads and writes cannot replace newer revisions", async () => {
  const storage = new MemoryDraftStorage();
  const key = { serverId: "alpha", agentId: "agent" };
  const read = deferred<unknown | null>();
  storage.loads.set(draftKey(key), read.promise);
  const controller = new DraftController(storage);
  const activating = controller.activate(key);
  const edit = controller.replaceText("newer than load");
  read.resolve(draft({ key, revision: 50, text: "stale load" }));
  await activating;
  await edit;
  assert.equal(controller.snapshot().session?.record.text, "newer than load");

  const delayedWrite = deferred<void>();
  storage.writeDelays.set(2, delayedWrite.promise);
  const oldWrite = controller.replaceText("old write");
  const newWrite = controller.replaceText("new write");
  await newWrite;
  delayedWrite.resolve();
  await oldWrite;
  assert.equal(storage.records.get(draftKey(key))?.text, "new write");
});

test("delayed restore preserves terminal IDs handled while loading", async () => {
  const storage = new MemoryDraftStorage();
  const key = { serverId: "alpha", agentId: "agent" };
  const read = deferred<unknown | null>();
  storage.loads.set(draftKey(key), read.promise);
  const controller = new DraftController(storage);
  const activating = controller.activate(key);
  assert.equal(await controller.handle(input("RIGHT", 90)), true);
  read.resolve(draft({ key, images: [image("image")] }));
  await activating;
  assert.equal(controller.snapshot().session?.record.activeArea, "text");
  assert.equal(await controller.handle(input("RIGHT", 90)), true);
  assert.equal(controller.snapshot().session?.record.activeArea, "text");
});

test("a corrupt record is replaced without poisoning sibling Agents", async () => {
  const storage = new MemoryDraftStorage();
  const bad = { serverId: "alpha", agentId: "bad" };
  const good = { serverId: "alpha", agentId: "good" };
  storage.loads.set(
    draftKey(bad),
    Promise.resolve({ ...draft({ key: bad }), schemaVersion: 0 }),
  );
  storage.records.set(draftKey(good), draft({ key: good, text: "good" }));
  const controller = new DraftController(storage);
  await controller.activate(bad);
  assert.equal(controller.snapshot().session?.record.text, "");
  assert.equal(controller.snapshot().storageStatus, "error");
  assert.equal(storage.records.get(draftKey(bad))?.schemaVersion, 1);
  await controller.activate(good);
  assert.equal(controller.snapshot().session?.record.text, "good");
});

test("IndexedDB Draft storage round-trips, fences revisions, and deletes exact scopes", async () => {
  const storage = new IndexedDbDraftStorage(new FakeIndexedDbFactory().value);
  const alpha = { serverId: "alpha", agentId: "same" };
  const alphaOther = { serverId: "alpha", agentId: "other" };
  const beta = { serverId: "beta", agentId: "same" };
  await storage.putAgent(draft({ key: alpha, revision: 2, text: "alpha" }));
  await storage.putAgent(draft({ key: alphaOther, text: "other" }));
  await storage.putAgent(draft({ key: beta, text: "beta" }));
  await storage.putAgent(draft({ key: alpha, revision: 1, text: "stale" }));
  assert.equal(((await storage.loadAgent(alpha)) as DraftRecord).text, "alpha");
  assert.deepEqual(
    (await storage.loadHost("alpha"))
      .map((value) => (value as DraftRecord).text)
      .sort(),
    ["alpha", "other"],
  );
  await storage.deleteAgent(alpha);
  assert.equal(await storage.loadAgent(alpha), null);
  assert.notEqual(await storage.loadAgent(beta), null);
  await storage.deleteHost("alpha");
  assert.equal(await storage.loadAgent(alphaOther), null);
  assert.notEqual(await storage.loadAgent(beta), null);
});

test("lifecycle retains offline Drafts and cleans only confirmed Agent or host removal", async () => {
  const alpha = { serverId: "alpha", agentId: "one" };
  const other = { serverId: "alpha", agentId: "other" };
  const beta = { serverId: "beta", agentId: "one" };
  const storage = new MemoryDraftStorage();
  for (const key of [alpha, other, beta])
    storage.records.set(draftKey(key), draft({ key, text: draftKey(key) }));
  const controller = new DraftController(storage);
  const directory = new FakeDirectory(directorySnapshot([alpha, beta]));
  const leases = new FakeLeases([hostLease("alpha"), hostLease("beta")]);
  const dispose = bindDraftLifecycle(controller, directory, leases);

  leases.emit([
    { ...hostLease("alpha"), status: "offline" },
    hostLease("beta"),
  ]);
  await tick();
  assert.equal(storage.records.has(draftKey(alpha)), true);
  directory.emit(directorySnapshot([beta]));
  await tick();
  assert.equal(storage.records.has(draftKey(alpha)), false);
  assert.equal(storage.records.has(draftKey(other)), true);
  leases.emit([hostLease("beta")]);
  await tick();
  assert.equal(storage.records.has(draftKey(other)), false);
  assert.equal(storage.records.has(draftKey(beta)), true);
  dispose();
});

test("failed and late cleanup retries without deleting a reappeared identity", async () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const storage = new MemoryDraftStorage();
  storage.records.set(draftKey(key), draft({ key, text: "keep" }));
  const directory = new FakeDirectory(directorySnapshot([key]));
  const leases = new FakeLeases([hostLease("alpha")]);
  const controller = new DraftController(storage);
  const dispose = bindDraftLifecycle(controller, directory, leases);

  storage.failDeletes = true;
  directory.emit(directorySnapshot([]));
  await tick();
  assert.equal(storage.records.has(draftKey(key)), true);
  storage.failDeletes = false;
  const deletion = deferred<void>();
  storage.deletes.set(draftKey(key), deletion.promise);
  directory.emit(directorySnapshot([]));
  await tick();
  directory.emit(directorySnapshot([key]));
  deletion.resolve();
  await tick();
  await tick();
  assert.equal(storage.records.get(draftKey(key))?.text, "keep");
  dispose();
});

test("late host cleanup restores records when the host reappears", async () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const storage = new MemoryDraftStorage();
  storage.records.set(draftKey(key), draft({ key, text: "keep" }));
  const directory = new FakeDirectory(directorySnapshot([key]));
  const leases = new FakeLeases([hostLease("alpha")]);
  const controller = new DraftController(storage);
  const dispose = bindDraftLifecycle(controller, directory, leases);
  const deletion = deferred<void>();
  storage.hostDeletes.set("alpha", deletion.promise);

  leases.emit([]);
  await tick();
  leases.emit([hostLease("alpha")]);
  deletion.resolve();
  await tick();
  await tick();
  assert.equal(storage.records.get(draftKey(key))?.text, "keep");
  dispose();
});

test("overlapping Agent and host cleanup cannot resurrect a removed Draft", async () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const storage = new MemoryDraftStorage();
  storage.records.set(draftKey(key), draft({ key, text: "remove" }));
  const directory = new FakeDirectory(directorySnapshot([key]));
  const leases = new FakeLeases([hostLease("alpha")]);
  const controller = new DraftController(storage);
  const dispose = bindDraftLifecycle(controller, directory, leases);
  const agentDeletion = deferred<void>();
  const hostDeletion = deferred<void>();
  storage.deletes.set(draftKey(key), agentDeletion.promise);
  storage.hostDeletes.set("alpha", hostDeletion.promise);

  directory.emit(directorySnapshot([]));
  leases.emit([]);
  await tick();
  agentDeletion.resolve();
  await tick();
  leases.emit([hostLease("alpha")]);
  hostDeletion.resolve();
  await tick();
  assert.equal(storage.records.has(draftKey(key)), false);
  dispose();
});

test("diagnostics expose counts and hashes without Draft content or private tokens", async () => {
  const controller = new DraftController(new MemoryDraftStorage());
  await controller.activate(
    { serverId: "secret-host", agentId: "secret-agent" },
    ["secret-request"],
  );
  await controller.replaceText("secret Draft text");
  await controller.appendImageRefs([
    { ...image("secret-image"), token: "secret-private-token" },
  ]);
  const encoded = JSON.stringify(draftDiagnostics(controller.snapshot()));
  assert.match(encoded, /"textLength":17/);
  for (const secret of [
    "secret-host",
    "secret-agent",
    "secret-request",
    "secret Draft text",
    "secret-image",
    "secret-private-token",
  ])
    assert.equal(encoded.includes(secret), false);
});

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    schemaVersion: 1,
    key: { serverId: "alpha", agentId: "agent" },
    revision: 1,
    updatedAt: 1,
    text: "text",
    images: [],
    activeArea: "text",
    cursors: { requestId: null, textOffset: 0, imageId: null },
    ...overrides,
  };
}

function image(id: string) {
  return {
    id,
    token: `private-${id}`,
    mimeType: "image/jpeg",
    capturedAt: 1,
  };
}

function input(
  control: SemanticInput["control"],
  interactionId: number,
  action: SemanticInput["action"] = "SHORT",
): SemanticInput {
  return {
    type: "semantic-input",
    control,
    action,
    interactionId,
    timeMillis: interactionId,
  };
}

class MemoryDraftStorage implements DraftStorage {
  readonly records = new Map<string, DraftRecord>();
  readonly loads = new Map<string, Promise<unknown | null>>();
  readonly deletes = new Map<string, Promise<void>>();
  readonly hostDeletes = new Map<string, Promise<void>>();
  readonly writeDelays = new Map<number, Promise<void>>();
  failWrites = false;
  failDeletes = false;

  loadAgent(key: DraftRecord["key"]): Promise<unknown | null> {
    return (
      this.loads.get(draftKey(key)) ??
      Promise.resolve(this.records.get(draftKey(key)) ?? null)
    );
  }
  async loadHost(serverId: string): Promise<unknown[]> {
    return [...this.records.values()].filter(
      (value) => value.key.serverId === serverId,
    );
  }
  async putAgent(record: DraftRecord): Promise<void> {
    if (this.failWrites) throw new Error("write failed");
    await this.writeDelays.get(record.revision);
    const present = this.records.get(draftKey(record.key));
    if (!present || present.revision < record.revision)
      this.records.set(draftKey(record.key), record);
  }
  async deleteAgent(key: DraftRecord["key"]): Promise<void> {
    if (this.failDeletes) throw new Error("delete failed");
    await this.deletes.get(draftKey(key));
    this.records.delete(draftKey(key));
  }
  async deleteHost(serverId: string): Promise<void> {
    if (this.failDeletes) throw new Error("delete failed");
    await this.hostDeletes.get(serverId);
    for (const [key, record] of this.records)
      if (record.key.serverId === serverId) this.records.delete(key);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeDirectory {
  private listener: (snapshot: GlobalAgentDirectorySnapshot) => void = () => {};

  constructor(private value: GlobalAgentDirectorySnapshot) {}
  snapshot(): GlobalAgentDirectorySnapshot {
    return this.value;
  }
  subscribe(listener: (snapshot: GlobalAgentDirectorySnapshot) => void) {
    this.listener = listener;
    listener(this.value);
    return () => {
      this.listener = () => {};
    };
  }
  emit(value: GlobalAgentDirectorySnapshot): void {
    this.value = value;
    this.listener(value);
  }
}

class FakeLeases {
  private listener: HostRuntimeLeaseListener = () => {};

  constructor(private value: readonly HostRuntimeLease[]) {}
  subscribeRuntimeLeases(listener: HostRuntimeLeaseListener) {
    this.listener = listener;
    listener(this.value);
    return () => {
      this.listener = () => {};
    };
  }
  emit(value: readonly HostRuntimeLease[]): void {
    this.value = value;
    this.listener(value);
  }
}

function directorySnapshot(
  keys: readonly DraftRecord["key"][],
): GlobalAgentDirectorySnapshot {
  return {
    hosts: new Map(),
    orderedAgents: keys.map((key) => ({
      serverId: key.serverId,
      agentId: key.agentId,
    })) as unknown as GlobalAgentDirectorySnapshot["orderedAgents"],
    current: keys[0] ?? null,
    destination: keys.length ? "agent" : "config",
    restoring: false,
  };
}

function hostLease(serverId: string): HostRuntimeLease {
  return {
    serverId,
    profile: {} as HostRuntimeLease["profile"],
    status: "online",
    runtime: {} as HostRuntimeLease["runtime"],
    slotGeneration: 1,
    connectionEpoch: 1,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeIndexedDbFactory {
  private readonly rows = new Map<IDBValidKey, unknown>();
  private created = false;
  readonly value = {
    open: () => {
      const request = {} as IDBOpenDBRequest;
      const database = this.database();
      Object.defineProperty(request, "result", { value: database });
      queueMicrotask(() => {
        request.onupgradeneeded?.(
          new Event("upgradeneeded") as IDBVersionChangeEvent,
        );
        request.onsuccess?.(new Event("success"));
      });
      return request;
    },
  } as unknown as IDBFactory;

  private database(): IDBDatabase {
    return {
      objectStoreNames: { contains: () => this.created },
      createObjectStore: () => {
        this.created = true;
        return {} as IDBObjectStore;
      },
      transaction: () => new FakeTransaction(this.rows).value,
      close: () => {},
    } as unknown as IDBDatabase;
  }
}

class FakeTransaction {
  private pending = 0;
  readonly value: IDBTransaction;

  constructor(private readonly rows: Map<IDBValidKey, unknown>) {
    this.value = {
      objectStore: () => this.store(),
      error: null,
      oncomplete: null,
      onabort: null,
      onerror: null,
    } as unknown as IDBTransaction;
  }

  private store(): IDBObjectStore {
    return {
      get: (key: IDBValidKey) => this.request(() => this.rows.get(key)),
      getAll: () => this.request(() => [...this.rows.values()]),
      put: (value: { id: IDBValidKey }) =>
        this.request(() => {
          this.rows.set(value.id, value);
          return value.id;
        }),
      delete: (key: IDBValidKey) =>
        this.request(() => {
          this.rows.delete(key);
          return undefined;
        }),
    } as unknown as IDBObjectStore;
  }

  private request<T>(operation: () => T): IDBRequest<T> {
    this.pending++;
    const request = { error: null } as IDBRequest<T>;
    queueMicrotask(() => {
      Object.defineProperty(request, "result", { value: operation() });
      request.onsuccess?.(new Event("success"));
      this.pending--;
      queueMicrotask(() => {
        if (this.pending === 0) this.value.oncomplete?.(new Event("complete"));
      });
    });
    return request;
  }
}
