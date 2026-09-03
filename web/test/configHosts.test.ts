import assert from "node:assert/strict";
import test from "node:test";
import { HostsConfigController } from "../src/config/hosts/controller";
import {
  HostCleanupCoordinator,
  HostCleanupError,
} from "../src/config/hosts/cleanup";
import {
  ADD_HOST_ROW_ID,
  hostCancelRemovalRowId,
  hostRowId,
  projectHosts,
} from "../src/config/hosts/project";
import { HOSTS_SECTION_ID } from "../src/config/project";
import type { PairingState } from "../src/hosts/pairing";
import type {
  HostErrorCode,
  HostRegistrySnapshot,
  HostRuntimeSnapshot,
} from "../src/hosts/types";

test("Hosts projection is stable, product-safe, complete, and keeps Add last", () => {
  const hosts = [
    host("zeta", "Beta", "reconnecting"),
    host("alpha", "Alpha", "online"),
    host("error", null, "error", "identity_mismatch"),
  ];
  const expanded = new Set([
    HOSTS_SECTION_ID,
    ...hosts.map((value) => hostRowId(value.profile.serverId)),
  ]);
  const rows = projectHosts(
    { hosts, storageErrors: 0 },
    { status: "idle" },
    state(),
    expanded,
  );

  assert.deepEqual(
    rows.filter((row) => row.kind === "host").map((row) => row.id),
    [hostRowId("alpha"), hostRowId("zeta"), hostRowId("error")],
  );
  assert.equal(rows.at(-1)?.id, ADD_HOST_ROW_ID);
  assert.equal(
    rows.some((row) => row.detail === "Daemon identity mismatch"),
    true,
  );
  assert.equal(JSON.stringify(rows).includes("relay.paseo.sh"), false);
  assert.equal(JSON.stringify(rows).includes("public-alpha"), false);
  assert.deepEqual(
    projectHosts(
      { hosts: [], storageErrors: 0 },
      { status: "idle" },
      state(),
      new Set(),
    ).map(({ id }) => id),
    [ADD_HOST_ROW_ID],
  );
});

test("removal defaults to Cancel, requires a distinct action, and cleans only its host", async () => {
  const registry = new FakeRegistry([
    host("alpha", "Alpha"),
    host("beta", "Beta"),
  ]);
  const pairing = new FakePairing();
  const stores = {
    directory: new Set(["alpha", "beta"]),
    timeline: new Set(["alpha", "beta"]),
    drafts: new Set(["alpha", "beta"]),
  };
  const cleanup = new HostCleanupCoordinator(
    Object.entries(stores).map(([name, values]) => ({
      name,
      cleanup: async (serverId: string) => {
        values.delete(serverId);
      },
    })),
  );
  const controller = new HostsConfigController(registry, pairing, cleanup);
  const expanded = new Set([
    HOSTS_SECTION_ID,
    hostRowId("alpha"),
    hostRowId("beta"),
  ]);

  const confirmation = controller.activate(action("remove", "alpha"), 1);
  assert.deepEqual(confirmation, {
    focusRowId: hostCancelRemovalRowId("alpha"),
    expandRowIds: [HOSTS_SECTION_ID, hostRowId("alpha")],
  });
  assert.equal(registry.removals.length, 0);
  assert.deepEqual(
    controller
      .rows(expanded)
      .filter((row) => row.label.includes("removal"))
      .map((row) => row.label),
    ["Cancel removal", "Confirm removal"],
  );

  await controller.activate(action("confirm-removal", "alpha"), 2);
  await controller.activate(action("confirm-removal", "alpha"), 2);
  assert.deepEqual(registry.removals, ["alpha"]);
  for (const values of Object.values(stores))
    assert.deepEqual([...values], ["beta"]);
  assert.equal(
    controller.rows(expanded).some((row) => row.id === hostRowId("alpha")),
    false,
  );
  assert.equal(controller.diagnostics().hostCleanupCompleted, 3);
  controller.dispose();
});

test("failed profile deletion retains the host and skips cleanup", async () => {
  const registry = new FakeRegistry([host("alpha", "Alpha")]);
  registry.failRemove = true;
  let cleanupCalls = 0;
  const controller = new HostsConfigController(
    registry,
    new FakePairing(),
    new HostCleanupCoordinator([
      { name: "directory", cleanup: async () => void cleanupCalls++ },
    ]),
  );
  controller.activate(action("remove", "alpha"), 1);
  const result = await controller.activate(
    action("confirm-removal", "alpha"),
    2,
  );

  assert.equal(registry.snapshot().hosts.length, 1);
  assert.equal(cleanupCalls, 0);
  assert.deepEqual(result, { focusRowId: hostRowId("alpha") });
  assert.equal(
    controller
      .rows(new Set([HOSTS_SECTION_ID]))
      .some((row) => row.label === "Removal failed"),
    true,
  );
  controller.dispose();
});

test("a pending removal cannot be confirmed a second time", async () => {
  const registry = new FakeRegistry([host("alpha", "Alpha")]);
  const gate = deferred<void>();
  registry.removeBarrier = gate.promise;
  const controller = new HostsConfigController(
    registry,
    new FakePairing(),
    new HostCleanupCoordinator([]),
  );
  controller.activate(action("remove", "alpha"), 1);
  const pending = controller.activate(action("confirm-removal", "alpha"), 2);
  assert.equal(controller.activate(action("remove", "alpha"), 3), undefined);
  assert.equal(
    await controller.activate(action("confirm-removal", "alpha"), 4),
    undefined,
  );
  gate.resolve();
  await pending;
  assert.deepEqual(registry.removals, ["alpha"]);
  controller.dispose();
});

test("pairing success focuses the new stable host row and cancellation disposes scanning", async () => {
  const registry = new FakeRegistry([]);
  const pairing = new FakePairing();
  const controller = new HostsConfigController(
    registry,
    pairing,
    new HostCleanupCoordinator([]),
  );
  const adding = controller.activate(action("add", null), 1);
  assert.equal(pairing.starts, 1);
  registry.add(host("new-host", "New"));
  pairing.emit({ status: "paired", serverId: "new-host" });
  assert.deepEqual(await adding, {
    focusRowId: hostRowId("new-host"),
    expandRowIds: [HOSTS_SECTION_ID],
  });
  controller.activate(action("add", null), 2);
  controller.deactivate();
  assert.equal(pairing.cancels, 1);
  controller.dispose();
});

test("cleanup reports isolated participant failures for retry", async () => {
  const beta = new Set(["alpha", "beta"]);
  const coordinator = new HostCleanupCoordinator([
    { name: "ok", cleanup: async (id) => void beta.delete(id) },
    { name: "failed", cleanup: async () => Promise.reject(new Error("disk")) },
  ]);
  await assert.rejects(coordinator.cleanup("alpha"), (error) => {
    assert.ok(error instanceof HostCleanupError);
    assert.deepEqual(error.result.completed, ["ok"]);
    assert.deepEqual(error.result.failed, ["failed"]);
    return true;
  });
  assert.deepEqual([...beta], ["beta"]);
});

function action(type: string, targetId: string | null) {
  return { sectionId: HOSTS_SECTION_ID, type, targetId };
}

function state() {
  return {
    confirmingServerId: null,
    removingServerId: null,
    notice: null,
    operationRevision: 0,
    cleanup: null,
  };
}

function host(
  serverId: string,
  hostname: string | null,
  status: HostRuntimeSnapshot["status"] = "online",
  error: HostErrorCode | null = null,
): HostRuntimeSnapshot {
  return {
    profile: {
      schemaVersion: 1,
      serverId,
      relayEndpoint: "relay.paseo.sh:443",
      useTls: true,
      daemonPublicKey: `public-${serverId}`,
      hostname,
      createdAt: 1,
      updatedAt: 1,
    },
    status,
    error,
  };
}

class FakeRegistry {
  private value: HostRegistrySnapshot;
  private listeners = new Set<(snapshot: HostRegistrySnapshot) => void>();
  removals: string[] = [];
  failRemove = false;
  removeBarrier: Promise<void> | null = null;
  constructor(hosts: HostRuntimeSnapshot[]) {
    this.value = { hosts, storageErrors: 0 };
  }
  snapshot() {
    return this.value;
  }
  subscribe(listener: (snapshot: HostRegistrySnapshot) => void) {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }
  async remove(serverId: string) {
    this.removals.push(serverId);
    await this.removeBarrier;
    if (this.failRemove) throw new Error("storage");
    this.value = {
      ...this.value,
      hosts: this.value.hosts.filter(
        (host) => host.profile.serverId !== serverId,
      ),
    };
    this.publish();
  }
  add(value: HostRuntimeSnapshot) {
    this.value = { ...this.value, hosts: [...this.value.hosts, value] };
    this.publish();
  }
  private publish() {
    for (const listener of this.listeners) listener(this.value);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

class FakePairing {
  private value: PairingState = { status: "idle" };
  private listeners = new Set<(state: PairingState) => void>();
  starts = 0;
  cancels = 0;
  snapshot() {
    return this.value;
  }
  subscribe(listener: (state: PairingState) => void) {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }
  start() {
    this.starts++;
    this.emit({ status: "scanning" });
  }
  cancel() {
    if (this.value.status === "scanning") {
      this.cancels++;
      this.emit({ status: "cancelled" });
    }
  }
  emit(state: PairingState) {
    this.value = state;
    for (const listener of this.listeners) listener(state);
  }
}
