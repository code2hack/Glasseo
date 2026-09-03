import assert from "node:assert/strict";
import test from "node:test";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { GlobalAgentDirectorySnapshot } from "../src/directory/types";
import type {
  PaseoPermissionEvent,
  PaseoPermissionRequest,
} from "../src/paseo/adapter";
import { normalizePermissionRequest } from "../src/paseo/adapter";
import {
  RequestReplicaCoordinator,
  type RequestDirectorySource,
  type RequestLeaseSource,
  type RequestRuntimeLease,
} from "../src/draft/request/coordinator";
import type {
  RequestAnswerStorage,
  RequestKey,
} from "../src/draft/request/types";

test("snapshot buffers live requests and resolutions while fetching", async () => {
  const runtime = new Runtime();
  const leases = new Leases();
  const directory = new Directory(directorySnapshot("host", "agent", ["live"]));
  const storage = new Storage();
  const coordinator = new RequestReplicaCoordinator(leases, directory, storage);
  coordinator.start();
  leases.emit([lease("host", 1, runtime)]);
  const activating = coordinator.activate({
    serverId: "host",
    agentId: "agent",
  });
  runtime.emit({ type: "resolved", agentId: "agent", requestId: "old" });
  runtime.emit({
    type: "requested",
    agentId: "agent",
    request: request("live"),
  });
  runtime.resolveNext([request("old")]);
  await activating;
  assert.deepEqual(
    coordinator.snapshot().requests.map(({ key }) => key.requestId),
    ["live"],
  );
  assert.equal(coordinator.snapshot().authoritative, true);
  assert.deepEqual(
    storage.deleted.map(({ requestId }) => requestId),
    [],
  );
  coordinator.dispose();
});

test("new epochs fence old fetches and offline retains a read-only view", async () => {
  const first = new Runtime();
  const second = new Runtime();
  const leases = new Leases();
  const directory = new Directory(
    directorySnapshot("host", "agent", ["fresh"]),
  );
  const coordinator = new RequestReplicaCoordinator(
    leases,
    directory,
    new Storage(),
  );
  coordinator.start();
  leases.emit([lease("host", 1, first)]);
  void coordinator.activate({ serverId: "host", agentId: "agent" });
  leases.emit([lease("host", 2, second)]);
  second.resolveNext([request("fresh")]);
  await tick();
  first.resolveNext([request("stale")]);
  await tick();
  assert.deepEqual(
    coordinator.snapshot().requests.map(({ key }) => key.requestId),
    ["fresh"],
  );
  leases.emit([{ ...lease("host", 2, second), status: "offline" }]);
  assert.equal(coordinator.snapshot().status, "offline");
  assert.equal(coordinator.snapshot().authoritative, false);
  assert.equal(coordinator.snapshot().requests.length, 1);
  coordinator.dispose();
});

test("directory gaps refetch once and external resolution discards answer state", async () => {
  const runtime = new Runtime();
  runtime.responses.push([], [request("gap")]);
  const leases = new Leases();
  const directory = new Directory(directorySnapshot("host", "agent", ["gap"]));
  const storage = new Storage();
  const coordinator = new RequestReplicaCoordinator(leases, directory, storage);
  coordinator.subscribe(() => {
    throw new Error("isolated listener");
  });
  coordinator.start();
  leases.emit([lease("host", 1, runtime)]);
  await coordinator.activate({ serverId: "host", agentId: "agent" });
  assert.equal(runtime.fetches, 2);
  assert.equal(coordinator.snapshot().requests[0]?.key.requestId, "gap");

  directory.emit(directorySnapshot("host", "agent", []));
  await tick();
  assert.equal(coordinator.snapshot().requests.length, 0);
  assert.deepEqual(
    storage.deleted.map(({ requestId }) => requestId),
    ["gap"],
  );
  coordinator.dispose();
});

test("same request ID remains isolated across hosts and Agents", async () => {
  const hostA = new Runtime([[request("same")], [request("same")]]);
  const hostB = new Runtime([[request("same")]]);
  const leases = new Leases();
  const directory = new Directory(
    directorySnapshot("host-a", "agent-a", ["same"]),
  );
  const coordinator = new RequestReplicaCoordinator(
    leases,
    directory,
    new Storage(),
  );
  coordinator.start();
  leases.emit([lease("host-a", 1, hostA), lease("host-b", 1, hostB)]);
  await coordinator.activate({ serverId: "host-a", agentId: "agent-a" });
  const first = coordinator.snapshot().requests[0]!.key;
  directory.emit(directorySnapshot("host-a", "agent-b", ["same"]));
  await coordinator.activate({ serverId: "host-a", agentId: "agent-b" });
  const sibling = coordinator.snapshot().requests[0]!.key;
  directory.emit(directorySnapshot("host-b", "agent-a", ["same"]));
  await coordinator.activate({ serverId: "host-b", agentId: "agent-a" });
  const otherHost = coordinator.snapshot().requests[0]!.key;
  assert.equal(JSON.stringify(first) === JSON.stringify(sibling), false);
  assert.equal(JSON.stringify(first) === JSON.stringify(otherHost), false);
  coordinator.dispose();
});

class Runtime {
  readonly listeners = new Set<(event: PaseoPermissionEvent) => void>();
  readonly pending: Array<
    (requests: readonly PaseoPermissionRequest[]) => void
  > = [];
  readonly responses: Array<readonly PaseoPermissionRequest[]>;
  fetches = 0;
  constructor(responses: Array<readonly PaseoPermissionRequest[]> = []) {
    this.responses = responses;
  }
  getPermissionSnapshot(): Promise<readonly PaseoPermissionRequest[]> {
    this.fetches++;
    const response = this.responses.shift();
    return response
      ? Promise.resolve(response)
      : new Promise((resolve) => this.pending.push(resolve));
  }
  subscribePermissions(listener: (event: PaseoPermissionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: PaseoPermissionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  resolveNext(requests: readonly PaseoPermissionRequest[]): void {
    const resolve = this.pending.shift();
    assert.ok(resolve, "expected a pending permission snapshot");
    resolve(requests);
  }
}

class Leases implements RequestLeaseSource {
  private listener: ((leases: readonly RequestRuntimeLease[]) => void) | null =
    null;
  subscribeRuntimeLeases(
    listener: (leases: readonly RequestRuntimeLease[]) => void,
  ) {
    this.listener = listener;
    return () => (this.listener = null);
  }
  emit(leases: readonly RequestRuntimeLease[]): void {
    this.listener?.(leases);
  }
}

class Directory implements RequestDirectorySource {
  private listeners = new Set<
    (snapshot: GlobalAgentDirectorySnapshot) => void
  >();
  constructor(private value: GlobalAgentDirectorySnapshot) {}
  snapshot(): GlobalAgentDirectorySnapshot {
    return this.value;
  }
  subscribe(listener: (snapshot: GlobalAgentDirectorySnapshot) => void) {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }
  emit(value: GlobalAgentDirectorySnapshot): void {
    this.value = value;
    for (const listener of this.listeners) listener(value);
  }
}

class Storage implements RequestAnswerStorage {
  readonly deleted: RequestKey[] = [];
  async load(): Promise<null> {
    return null;
  }
  async put(): Promise<boolean> {
    return true;
  }
  async delete(key: RequestKey): Promise<void> {
    this.deleted.push(key);
  }
  async deleteHost(): Promise<void> {}
}

function lease(
  serverId: string,
  connectionEpoch: number,
  runtime: Runtime,
): RequestRuntimeLease {
  return {
    serverId,
    slotGeneration: 1,
    connectionEpoch,
    status: "online",
    runtime,
  };
}

function request(id: string): PaseoPermissionRequest {
  const raw: AgentPermissionRequest = {
    id,
    provider: "codex",
    name: "CodexBash",
    kind: "tool",
  };
  return normalizePermissionRequest(raw);
}

function directorySnapshot(
  serverId: string,
  agentId: string,
  requestIds: readonly string[],
): GlobalAgentDirectorySnapshot {
  return {
    hosts: new Map([[serverId, { stale: false }]]),
    orderedAgents: [
      {
        serverId,
        agentId,
        pendingPermissions: requestIds.map((id) => ({ id })),
      },
    ],
    current: { serverId, agentId },
    destination: "agent",
    restoring: false,
  } as unknown as GlobalAgentDirectorySnapshot;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
