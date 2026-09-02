import assert from "node:assert/strict";
import test from "node:test";
import {
  createPaseoRuntime,
  PaseoRuntimeError,
  type PaseoDirectoryEvent,
  type PaseoConnectionState,
  type PaseoHostInfo,
} from "../src/paseo/adapter";
import { parsePairingOffer } from "../src/hosts/offer";
import { HostRegistry } from "../src/hosts/registry";
import {
  HostError,
  validateStoredHostProfile,
  type HostRuntime,
  type HostRuntimeFactory,
  type HostStorage,
  type StoredHostProfile,
} from "../src/hosts/types";

test("official v2 offers normalize the exact Relay client URL and TLS fallback", () => {
  assert.deepEqual(parsePairingOffer(offer("alpha", "relay.paseo.sh:443")), {
    serverId: "alpha",
    daemonPublicKey: "public-alpha",
    relayEndpoint: "relay.paseo.sh:443",
    useTls: true,
    relayUrl: "wss://relay.paseo.sh/ws?serverId=alpha&role=client&v=2",
  });
  assert.equal(
    parsePairingOffer(offer("beta", "localhost:6767", false)).relayUrl,
    "ws://localhost:6767/ws?serverId=beta&role=client&v=2",
  );
  assert.equal(
    parsePairingOffer(offer("case", "Relay.Paseo.sh:443")).relayEndpoint,
    "relay.paseo.sh:443",
  );
});

test("non-offers and malformed official payloads fail closed", () => {
  for (const value of [
    "",
    "not a URL",
    "https://example.com/#offer=e30",
    "https://user@app.paseo.sh/#offer=e30",
    "https://app.paseo.sh/?debug=1#offer=e30",
    "https://app.paseo.sh/other#offer=e30",
    "https://app.paseo.sh/",
    "https://app.paseo.sh/#offer=%%%",
    encoded({
      v: 1,
      serverId: "a",
      daemonPublicKeyB64: "k",
      relay: { endpoint: "h:1" },
    }),
    encoded({
      v: 2,
      serverId: "",
      daemonPublicKeyB64: "k",
      relay: { endpoint: "h:1" },
    }),
    encoded({
      v: 2,
      serverId: "a",
      daemonPublicKeyB64: "k",
      relay: { endpoint: "missing-port" },
    }),
    offer("bad-path", "evil/path:443"),
    offer("bad-user", "user@foo:443"),
    offer("bad-query", "foo?x:443"),
  ]) {
    assert.throws(() => parsePairingOffer(value), HostError);
  }
});

test("profile validation rejects corrupt restored records", () => {
  assert.deepEqual(
    validateStoredHostProfile(profile("alpha")),
    profile("alpha"),
  );
  for (const value of [
    null,
    {},
    { ...profile("alpha"), schemaVersion: 2 },
    { ...profile("alpha"), extra: true },
    { ...profile("alpha"), serverId: " alpha" },
    { ...profile("alpha"), daemonPublicKey: "public-alpha " },
    { ...profile("alpha"), hostname: " host-alpha" },
  ]) {
    assert.throws(() => validateStoredHostProfile(value), HostError);
  }
});

test("client identity is stable and corrupt profiles stay disconnected", async () => {
  const storage = new MemoryStorage([profile("alpha"), { corrupt: true }]);
  const first = new FakeFactory();
  const registry = new HostRegistry(storage, first.create, () => 100);
  await registry.restore();
  assert.equal(registry.snapshot().storageErrors, 1);
  assert.deepEqual(
    registry.snapshot().hosts.map((host) => host.profile.serverId),
    ["alpha"],
  );
  const clientId = first.options[0]?.clientId;
  assert.equal(typeof clientId, "string");
  assert.equal(clientId?.length, 32);

  const second = new FakeFactory();
  await new HostRegistry(storage, second.create).restore();
  assert.equal(second.options[0]?.clientId, clientId);
});

test("add is transactional and rejects identical or conflicting duplicates", async () => {
  const storage = new MemoryStorage();
  const factory = new FakeFactory();
  const registry = new HostRegistry(storage, factory.create, () => 42);
  await registry.restore();
  const raw = offer("alpha", "relay.paseo.sh:443");
  const added = await registry.add(raw);
  assert.equal(added.hostname, "host-alpha");
  assert.equal(storage.profiles.size, 1);
  assert.equal(factory.runtimes.length, 1);
  assert.equal("relayUrl" in (storage.profiles.get("alpha") as object), false);
  assert.equal(
    JSON.stringify(storage.profiles.get("alpha")).includes(raw),
    false,
  );

  await assert.rejects(registry.add(raw), hasCode("duplicate_host"));
  await assert.rejects(
    registry.add(offer("alpha", "elsewhere.test:443")),
    hasCode("conflicting_profile"),
  );
  assert.equal(factory.runtimes.length, 1);
  assert.equal(storage.profiles.size, 1);
});

test("failed connection or storage closes the provisional runtime without mutation", async () => {
  const storage = new MemoryStorage();
  const factory = new FakeFactory();
  factory.failNext = new Error("connect failed");
  const registry = new HostRegistry(storage, factory.create);
  await registry.restore();
  await assert.rejects(
    registry.add(offer("bad", "relay.paseo.sh:443")),
    hasCode("connection_failure"),
  );
  assert.equal(factory.runtimes[0]?.closed, true);
  assert.equal(storage.profiles.size, 0);

  storage.failPut = true;
  await assert.rejects(
    registry.add(offer("alpha", "relay.paseo.sh:443")),
    hasCode("storage_error"),
  );
  assert.equal(factory.runtimes[1]?.closed, true);
  assert.equal(storage.profiles.size, 0);
  assert.equal(registry.snapshot().hosts.length, 0);
});

test("restored hosts retain specific runtime failure codes", async () => {
  for (const [runtimeCode, hostCode] of [
    ["wrong_daemon", "identity_mismatch"],
    ["unsupported_daemon", "unsupported_daemon"],
    ["unverified_version", "unsupported_daemon"],
  ] as const) {
    const factory = new FakeFactory();
    factory.failNext = new PaseoRuntimeError(runtimeCode, "rejected");
    const registry = new HostRegistry(
      new MemoryStorage([profile(runtimeCode)]),
      factory.create,
    );
    await registry.restore();
    assert.equal(registry.snapshot().hosts[0]?.error, hostCode);
  }
});

test("identity and version failures retain typed errors and close the provisional runtime", async () => {
  for (const [runtimeCode, hostCode] of [
    ["wrong_daemon", "identity_mismatch"],
    ["unsupported_daemon", "unsupported_daemon"],
    ["unverified_version", "unsupported_daemon"],
  ] as const) {
    const storage = new MemoryStorage();
    const factory = new FakeFactory();
    factory.failNext = new PaseoRuntimeError(runtimeCode, "rejected");
    const registry = new HostRegistry(storage, factory.create);
    await registry.restore();
    await assert.rejects(
      registry.add(offer(runtimeCode, "relay.paseo.sh:443")),
      hasCode(hostCode),
    );
    assert.equal(factory.runtimes[0]?.closed, true);
    assert.equal(storage.profiles.size, 0);
  }
});

test("real DaemonClient identity rejection closes without persisting", async () => {
  const storage = new MemoryStorage();
  const transport = new RealAdapterTransport();
  const registry = new HostRegistry(storage, (options) =>
    createPaseoRuntime({
      ...options,
      reconnect: { enabled: false },
      connectTimeoutMs: 50,
      testTransportFactory: () => transport,
    }),
  );
  await registry.restore();
  const pairing = registry.add(offer("expected", "relay.paseo.sh:443"));
  await tick();
  transport.open();
  transport.receive({
    type: "status",
    payload: {
      status: "server_info",
      serverId: "different",
      hostname: "fixture",
      version: "0.7.0",
    },
  });
  await assert.rejects(pairing, hasCode("identity_mismatch"));
  assert.equal(transport.closed, true);
  assert.equal(storage.profiles.size, 0);
});

test("pending pair and delayed restore cannot create duplicate runtimes", async () => {
  const pendingStorage = new MemoryStorage();
  const pendingFactory = new FakeFactory();
  pendingFactory.manual = true;
  const pendingRegistry = new HostRegistry(
    pendingStorage,
    pendingFactory.create,
  );
  await pendingRegistry.restore();
  const first = pendingRegistry.add(offer("alpha", "relay.paseo.sh:443"));
  await tick();
  await assert.rejects(
    pendingRegistry.add(offer("alpha", "relay.paseo.sh:443")),
    hasCode("duplicate_host"),
  );
  assert.equal(pendingFactory.runtimes.length, 1);
  pendingFactory.runtimes[0]?.resolveConnect();
  await first;

  const gate = deferred<void>();
  const stored = new MemoryStorage([profile("saved")]);
  stored.loadBarrier = gate.promise;
  const restoredFactory = new FakeFactory();
  const restoredRegistry = new HostRegistry(stored, restoredFactory.create);
  const restoring = restoredRegistry.restore();
  const duplicate = restoredRegistry.add(offer("saved", "relay.paseo.sh:443"));
  await tick();
  assert.equal(restoredFactory.runtimes.length, 0);
  gate.resolve();
  await assert.rejects(duplicate, hasCode("duplicate_host"));
  await restoring;
  assert.equal(restoredFactory.runtimes.length, 1);
});

test("hosts restore concurrently and expose independent connection states", async () => {
  const storage = new MemoryStorage([profile("alpha"), profile("beta")]);
  const factory = new FakeFactory();
  factory.manual = true;
  const registry = new HostRegistry(storage, factory.create);
  const restoring = registry.restore();
  await tick();
  assert.deepEqual(
    registry.snapshot().hosts.map((host) => host.status),
    ["connecting", "connecting"],
  );
  assert.equal(factory.runtimes.length, 2);
  factory.runtimes[0]?.resolveConnect();
  factory.runtimes[1]?.rejectConnect();
  await restoring;
  assert.deepEqual(
    registry.snapshot().hosts.map((host) => host.status),
    ["online", "error"],
  );
  factory.runtimes[0]?.emit({ status: "disconnected", reason: "test" });
  assert.deepEqual(
    registry.snapshot().hosts.map((host) => host.status),
    ["offline", "error"],
  );
  factory.runtimes[0]?.emit({ status: "connecting", attempt: 1 });
  factory.runtimes[0]?.emit({ status: "connected" });
  assert.deepEqual(
    registry.snapshot().hosts.map((host) => host.status),
    ["online", "error"],
  );
});

test("storage read failure blocks add instead of overwriting unseen profiles", async () => {
  const storage = new MemoryStorage([profile("saved")]);
  storage.failLoad = true;
  const registry = new HostRegistry(storage, new FakeFactory().create);
  await registry.restore();
  await assert.rejects(
    registry.add(offer("saved", "elsewhere.test:443")),
    hasCode("storage_error"),
  );
  assert.deepEqual(storage.profiles.get("saved"), profile("saved"));
});

test("removal deletes and closes one host while fencing late callbacks", async () => {
  const storage = new MemoryStorage([profile("alpha"), profile("beta")]);
  const factory = new FakeFactory();
  const registry = new HostRegistry(storage, factory.create);
  await registry.restore();
  const removed = factory.runtimes[0]!;
  await registry.remove("alpha");
  assert.equal(removed.closed, true);
  removed.emit({ status: "connected" });
  assert.deepEqual(
    registry.snapshot().hosts.map((host) => host.profile.serverId),
    ["beta"],
  );
  assert.deepEqual([...storage.profiles.keys()], ["beta"]);

  const restarted = new FakeFactory();
  await new HostRegistry(storage, restarted.create).restore();
  assert.deepEqual(
    restarted.options.map((options) => options.expectedServerId),
    ["beta"],
  );
});

test("failed removal keeps live callbacks and retry fences only after success", async () => {
  const storage = new MemoryStorage([profile("alpha")]);
  const factory = new FakeFactory();
  const registry = new HostRegistry(storage, factory.create);
  await registry.restore();
  const runtime = factory.runtimes[0]!;

  storage.failDelete = true;
  await assert.rejects(registry.remove("alpha"), hasCode("storage_error"));
  assert.equal(runtime.closed, false);
  assert.equal(storage.profiles.has("alpha"), true);
  assert.equal(registry.snapshot().hosts[0]?.error, "storage_error");
  runtime.emit({ status: "disconnected", reason: "test" });
  assert.equal(registry.snapshot().hosts[0]?.status, "offline");
  runtime.emit({ status: "connecting", attempt: 1 });
  assert.equal(registry.snapshot().hosts[0]?.status, "connecting");
  runtime.emit({ status: "connected" });
  assert.equal(registry.snapshot().hosts[0]?.status, "online");

  storage.failDelete = false;
  await registry.remove("alpha");
  assert.equal(runtime.closed, true);
  assert.equal(storage.profiles.has("alpha"), false);
  runtime.emitStale({ status: "connected" });
  assert.equal(registry.snapshot().hosts.length, 0);
});

test("throwing registry subscriber cannot starve observers or transactions", async () => {
  const storage = new MemoryStorage();
  const factory = new FakeFactory();
  const registry = new HostRegistry(storage, factory.create);
  const observed: string[] = [];
  registry.subscribe(() => {
    throw new Error("observer failed");
  });
  registry.subscribe((snapshot) => {
    observed.push(snapshot.hosts.map((host) => host.status).join(","));
  });

  await registry.restore();
  await registry.add(offer("alpha", "relay.paseo.sh:443"));
  await registry.remove("alpha");

  assert.deepEqual(observed, ["", "", "online", "removing", ""]);
  assert.equal(storage.profiles.size, 0);
  assert.equal(factory.runtimes[0]?.closed, true);
});

test("directory runtime leases fence reconnect, failed removal, and removal", async () => {
  const storage = new MemoryStorage([profile("alpha")]);
  const factory = new FakeFactory();
  const registry = new HostRegistry(storage, factory.create);
  const observed: Array<[number, number, string] | null> = [];
  registry.subscribeRuntimeLeases(() => {
    throw new Error("fixture lease subscriber");
  });
  registry.subscribeRuntimeLeases((leases) => {
    const lease = leases[0];
    observed.push(
      lease
        ? [lease.slotGeneration, lease.connectionEpoch, lease.status]
        : null,
    );
  });
  await registry.restore();
  const runtime = factory.runtimes[0]!;
  const first = observed.at(-1)!;
  assert.deepEqual(first && first.slice(1), [1, "online"]);

  runtime.emit({ status: "disconnected", reason: "fixture" });
  runtime.emit({ status: "connecting", attempt: 1 });
  runtime.emit({ status: "connected" });
  const reconnected = observed.at(-1)!;
  assert.deepEqual(reconnected && reconnected.slice(1), [2, "online"]);
  assert.equal(reconnected?.[0], first?.[0]);

  storage.failDelete = true;
  await assert.rejects(registry.remove("alpha"), hasCode("storage_error"));
  assert.equal(observed.at(-1)?.[0], first?.[0]);
  storage.failDelete = false;
  await registry.remove("alpha");
  assert.equal(observed.at(-1), null);

  await registry.add(offer("beta", "relay.paseo.sh:443"));
  const added = observed.at(-1)!;
  assert.deepEqual(added && added.slice(1), [1, "online"]);
  assert.notEqual(added?.[0], first?.[0]);
});

class MemoryStorage implements HostStorage {
  profiles = new Map<string, unknown>();
  clientId: string | null = null;
  failPut = false;
  failLoad = false;
  failDelete = false;
  loadBarrier: Promise<void> | null = null;

  constructor(profiles: unknown[] = []) {
    for (const value of profiles) {
      const serverId =
        (value as { serverId?: string }).serverId ??
        `invalid-${this.profiles.size}`;
      this.profiles.set(serverId, structuredClone(value));
    }
  }

  async loadProfiles() {
    if (this.failLoad) throw new Error("load failed");
    await this.loadBarrier;
    return [...this.profiles.values()].map((value) => structuredClone(value));
  }
  async putProfile(value: StoredHostProfile) {
    if (this.failPut) throw new Error("put failed");
    this.profiles.set(value.serverId, structuredClone(value));
  }
  async deleteProfile(serverId: string) {
    if (this.failDelete) throw new Error("delete failed");
    this.profiles.delete(serverId);
  }
  async getClientId() {
    return this.clientId;
  }
  async putClientId(clientId: string) {
    this.clientId = clientId;
  }
}

class FakeRuntime implements HostRuntime {
  closed = false;
  private listener: (state: PaseoConnectionState) => void = () => {};
  private lastListener: (state: PaseoConnectionState) => void = () => {};
  private resolve!: (host: PaseoHostInfo) => void;
  private reject!: (error: Error) => void;
  readonly pending = new Promise<PaseoHostInfo>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });

  constructor(
    private readonly serverId: string,
    private readonly manual: boolean,
    private readonly fail: Error | null,
  ) {}

  async connect(): Promise<PaseoHostInfo> {
    this.emit({ status: "connecting", attempt: 0 });
    if (this.manual) return this.pending;
    if (this.fail) throw this.fail;
    const host = hostInfo(this.serverId);
    this.emit({ status: "connected" });
    return host;
  }
  async close() {
    this.closed = true;
  }
  subscribeConnection(listener: (state: PaseoConnectionState) => void) {
    this.listener = this.lastListener = listener;
    listener({ status: "idle" });
    return () => {
      this.listener = () => {};
    };
  }
  emit(state: PaseoConnectionState) {
    this.listener(state);
  }
  emitStale(state: PaseoConnectionState) {
    this.lastListener(state);
  }
  resolveConnect() {
    this.emit({ status: "connected" });
    this.resolve(hostInfo(this.serverId));
  }
  rejectConnect() {
    this.reject(new Error("offline"));
  }
  getHost() {
    return this.closed ? null : hostInfo(this.serverId);
  }
  async listProjects() {
    return { requestId: "projects", projects: [] };
  }
  async listWorkspaces() {
    return {
      requestId: "workspaces",
      entries: [],
      emptyProjects: [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    };
  }
  async listAgents() {
    return {
      requestId: "agents",
      entries: [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    };
  }
  subscribeDirectory(_listener: (event: PaseoDirectoryEvent) => void) {
    void _listener;
    return () => {};
  }
}

class RealAdapterTransport {
  closed = false;
  private openHandler: () => void = () => {};
  private messageHandler: (data: unknown, isBinary: boolean) => void = () => {};

  send() {}
  close() {
    this.closed = true;
  }
  onOpen = (listener: () => void) => {
    this.openHandler = listener;
    return () => {};
  };
  onMessage = (listener: (data: unknown, isBinary: boolean) => void) => {
    this.messageHandler = listener;
    return () => {};
  };
  onClose = () => () => {};
  onError = () => () => {};
  open() {
    this.openHandler();
  }
  receive(message: Record<string, unknown>) {
    this.messageHandler(JSON.stringify({ type: "session", message }), false);
  }
}

class FakeFactory {
  runtimes: FakeRuntime[] = [];
  options: Parameters<HostRuntimeFactory>[0][] = [];
  failNext: Error | null = null;
  manual = false;
  create: HostRuntimeFactory = (options) => {
    this.options.push(options);
    const runtime = new FakeRuntime(
      options.expectedServerId,
      this.manual,
      this.failNext,
    );
    this.failNext = null;
    this.runtimes.push(runtime);
    return runtime;
  };
}

function profile(serverId: string): StoredHostProfile {
  return {
    schemaVersion: 1,
    serverId,
    relayEndpoint: "relay.paseo.sh:443",
    useTls: true,
    daemonPublicKey: `public-${serverId}`,
    hostname: `host-${serverId}`,
    createdAt: 1,
    updatedAt: 1,
  };
}

function offer(serverId: string, endpoint: string, useTls?: boolean): string {
  return encoded({
    v: 2,
    serverId,
    daemonPublicKeyB64: `public-${serverId}`,
    relay: { endpoint, ...(useTls === undefined ? {} : { useTls }) },
  });
}

function encoded(value: unknown): string {
  return `https://app.paseo.sh/#offer=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

function hostInfo(serverId: string): PaseoHostInfo {
  return {
    serverId,
    hostname: `host-${serverId}`,
    version: "0.7.0",
    capabilities: {},
    features: {},
  };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof HostError && error.code === code;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
