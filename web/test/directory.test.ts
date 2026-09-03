import assert from "node:assert/strict";
import test from "node:test";
import { DirectoryCoordinator } from "../src/directory/coordinator";
import {
  agentKey,
  compositeKey,
  isEligibleAgent,
  validateCachedHostDirectory,
} from "../src/directory/normalize";
import {
  getAgentPlacement,
  getHostname,
  hostSyncState,
  orderedAgentKeys,
} from "../src/directory/selectors";
import type {
  AgentKey,
  CachedHostDirectory,
  DirectoryStorage,
} from "../src/directory/types";
import type {
  HostDirectoryRuntime,
  HostStorage,
  HostRuntimeLease,
  HostRuntimeLeaseListener,
  StoredHostProfile,
} from "../src/hosts/types";
import { HostRegistry } from "../src/hosts/registry";
import type {
  PaseoConnectionState,
  PaseoAgentEntry,
  PaseoAgentRecord,
  PaseoAgents,
  PaseoDirectoryEvent,
  PaseoProjects,
  PaseoWorkspaceRecord,
  PaseoWorkspaces,
} from "../src/paseo/adapter";

test("two hosts bootstrap every page, filter exactly, order globally, and retain selection", async () => {
  const alpha = new FakeDirectoryRuntime("alpha");
  alpha.projects = projects("alpha");
  alpha.workspacePages.set(
    null,
    workspacePage([workspace("alpha")], "more", true),
  );
  alpha.workspacePages.set(
    "more",
    workspacePage([workspace("alpha-2")], null, false),
  );
  alpha.agentPages.set(
    null,
    agentPage(
      [
        agentEntry("shared", "2026-09-03T03:00:00Z", { status: "closed" }),
        agentEntry("delegated", "2026-09-03T05:00:00Z", {
          labels: { "paseo.parent-agent-id": "parent" },
        }),
      ],
      "more",
      true,
    ),
  );
  alpha.agentPages.set(
    "more",
    agentPage(
      [
        agentEntry("shared", "2026-09-03T03:00:00Z", { status: "closed" }),
        agentEntry("archived", "2026-09-03T06:00:00Z", {
          archivedAt: "2026-09-03T07:00:00Z",
        }),
      ],
      null,
      false,
    ),
  );
  const beta = new FakeDirectoryRuntime("beta");
  beta.projects = projects("beta");
  beta.workspacePages.set(
    null,
    workspacePage([workspace("beta")], null, false),
  );
  beta.agentPages.set(
    null,
    agentPage(
      [
        agentEntry("shared", "2026-09-03T04:00:00Z", {
          pendingPermissions: [
            {
              id: "permission-1",
              provider: "codex",
              name: "shell",
              kind: "tool",
              title: "Run command",
              input: { prompt: "must not persist" },
            },
          ],
        }),
        agentEntry("zeta", "2026-09-03T03:00:00Z"),
      ],
      null,
      false,
    ),
  );
  const source = new FakeLeaseSource([
    lease("alpha", alpha),
    lease("beta", beta),
  ]);
  const storage = new MemoryDirectoryStorage();
  const directory = new DirectoryCoordinator(source, storage, () => 100);
  await directory.restore();

  assert.deepEqual(orderedAgentKeys(directory.snapshot()), [
    agentKey("beta", "shared"),
    agentKey("alpha", "shared"),
    agentKey("beta", "zeta"),
  ]);
  assert.deepEqual(directory.snapshot().current, agentKey("beta", "shared"));
  assert.equal(directory.snapshot().orderedAgents[1]?.status, "closed");
  assert.equal(
    isEligibleAgent(
      directory.snapshot().hosts.get("alpha")!.agents.get("delegated")!,
    ),
    false,
  );
  assert.notEqual(
    compositeKey("alpha", "shared"),
    compositeKey("beta", "shared"),
  );
  assert.equal(getHostname(directory.snapshot(), "alpha"), "host-alpha");
  assert.deepEqual(
    directory.snapshot().hosts.get("beta")?.agents.get("shared")
      ?.pendingPermissions,
    [
      {
        id: "permission-1",
        provider: "codex",
        name: "shell",
        kind: "tool",
        title: "Run command",
      },
    ],
  );
  assert.equal(
    getAgentPlacement(directory.snapshot(), agentKey("alpha", "shared"))
      ?.workspace?.name,
    "workspace-alpha",
  );
  assert.deepEqual(alpha.agentRequests, [
    {
      sort: [{ key: "updated_at", direction: "desc" }],
      subscribe: {},
      page: { limit: 200 },
    },
    {
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200, cursor: "more" },
    },
  ]);
  assert.deepEqual(alpha.workspaceRequests, [
    { subscribe: {}, page: { limit: 200 } },
    { page: { limit: 200, cursor: "more" } },
  ]);

  assert.equal(directory.selectAgent(agentKey("alpha", "shared")), true);
  beta.emit(agentUpsert("newest", "2026-09-03T08:00:00Z"));
  assert.deepEqual(
    orderedAgentKeys(directory.snapshot())[0],
    agentKey("beta", "newest"),
  );
  assert.deepEqual(directory.snapshot().current, agentKey("alpha", "shared"));
  beta.emit({ type: "agent_deleted", agentId: "newest" });
  alpha.emit({
    type: "agent_archived",
    agentId: "shared",
    archivedAt: "2026-09-03T09:00:00Z",
  });
  assert.deepEqual(directory.snapshot().current, agentKey("beta", "shared"));
});

test("events buffered during a snapshot win over older fetched rows", async () => {
  const runtime = new FakeDirectoryRuntime("alpha");
  const agents = deferred<PaseoAgents>();
  runtime.projects = projects("alpha");
  runtime.workspacePages.set(
    null,
    workspacePage([workspace("alpha")], null, false),
  );
  runtime.listAgentsImpl = async () => agents.promise;
  const directory = new DirectoryCoordinator(
    new FakeLeaseSource([lease("alpha", runtime)]),
    new MemoryDirectoryStorage(),
  );
  const restoring = directory.restore();
  await tick();
  const live = agentUpsert("live", "2026-09-03T05:00:00Z");
  if (live.type !== "agent_update" || live.payload.kind !== "upsert")
    throw new Error("invalid fixture");
  live.payload.project = undefined;
  runtime.emit(live);
  runtime.emit({ type: "agent_deleted", agentId: "old" });
  agents.resolve(
    agentPage(
      [
        agentEntry("old", "2026-09-03T01:00:00Z"),
        agentEntry("snapshot", "2026-09-03T02:00:00Z"),
      ],
      null,
      false,
    ),
  );
  await restoring;
  assert.deepEqual(orderedAgentKeys(directory.snapshot()), [
    agentKey("alpha", "live"),
    agentKey("alpha", "snapshot"),
  ]);
});

test("sequenced tombstones reject stale resurrection and removals stay host-scoped", async () => {
  const alpha = readyRuntime("alpha", [
    agentEntry("kept", "2026-09-03T01:00:00Z"),
  ]);
  const beta = readyRuntime("beta", [
    agentEntry("kept", "2026-09-03T01:00:00Z", {
      workspaceId: "workspace-beta",
    }),
  ]);
  const directory = new DirectoryCoordinator(
    new FakeLeaseSource([lease("alpha", alpha), lease("beta", beta)]),
    new MemoryDirectoryStorage(),
  );
  await directory.restore();
  const newer = agentUpsert("sequenced", "2026-09-03T05:00:00Z");
  if (newer.type !== "agent_update" || newer.payload.kind !== "upsert")
    throw new Error("invalid fixture");
  newer.payload.seq = 5;
  alpha.emit(newer);
  alpha.emit({
    type: "agent_update",
    agentId: "sequenced",
    payload: { kind: "remove", agentId: "sequenced", seq: 7 },
  });
  const stale = agentUpsert("sequenced", "2026-09-03T06:00:00Z");
  if (stale.type !== "agent_update" || stale.payload.kind !== "upsert")
    throw new Error("invalid fixture");
  stale.payload.seq = 6;
  alpha.emit(stale);
  assert.equal(
    directory.snapshot().hosts.get("alpha")?.agents.has("sequenced"),
    false,
  );

  alpha.emit({
    type: "project.update",
    payload: { kind: "remove", projectId: "project-alpha", seq: 8 },
  });
  assert.equal(directory.snapshot().hosts.get("alpha")?.projects.size, 0);
  assert.equal(directory.snapshot().hosts.get("alpha")?.workspaces.size, 0);
  assert.equal(
    directory.snapshot().hosts.get("alpha")?.agents.has("kept"),
    true,
  );
  assert.equal(directory.snapshot().hosts.get("beta")?.projects.size, 1);
  assert.equal(
    directory.snapshot().hosts.get("beta")?.agents.has("kept"),
    true,
  );
});

test("a reconnect discards stale fetch completion and refreshes the new epoch", async () => {
  const oldRuntime = new FakeDirectoryRuntime("alpha");
  const oldAgents = deferred<PaseoAgents>();
  oldRuntime.projects = projects("alpha");
  oldRuntime.workspacePages.set(
    null,
    workspacePage([workspace("alpha")], null, false),
  );
  oldRuntime.listAgentsImpl = async () => oldAgents.promise;
  const source = new FakeLeaseSource([lease("alpha", oldRuntime)]);
  const directory = new DirectoryCoordinator(
    source,
    new MemoryDirectoryStorage(),
  );
  const restoring = directory.restore();
  await tick();

  const currentRuntime = new FakeDirectoryRuntime("alpha");
  currentRuntime.projects = projects("alpha");
  currentRuntime.workspacePages.set(
    null,
    workspacePage([workspace("alpha")], null, false),
  );
  currentRuntime.agentPages.set(
    null,
    agentPage([agentEntry("current", "2026-09-03T04:00:00Z")], null, false),
  );
  source.emit([lease("alpha", currentRuntime, 1, 2)]);
  oldAgents.resolve(
    agentPage([agentEntry("stale", "2026-09-03T09:00:00Z")], null, false),
  );
  await restoring;
  await tick();
  assert.deepEqual(orderedAgentKeys(directory.snapshot()), [
    agentKey("alpha", "current"),
  ]);
  assert.equal(oldRuntime.subscriberCount, 0);
});

test("pagination failure is host-local and explicit refresh recovers", async () => {
  const bad = new FakeDirectoryRuntime("bad");
  bad.projects = projects("bad");
  bad.workspacePages.set(null, workspacePage([], "repeat", true));
  bad.workspacePages.set("repeat", workspacePage([], "repeat", true));
  bad.agentPages.set(null, agentPage([], null, false));
  const good = new FakeDirectoryRuntime("good");
  good.projects = projects("good");
  good.workspacePages.set(
    null,
    workspacePage([workspace("good")], null, false),
  );
  good.agentPages.set(
    null,
    agentPage([agentEntry("ready", "2026-09-03T02:00:00Z")], null, false),
  );
  const directory = new DirectoryCoordinator(
    new FakeLeaseSource([lease("bad", bad), lease("good", good)]),
    new MemoryDirectoryStorage(),
  );
  await directory.restore();
  assert.deepEqual(hostSyncState(directory.snapshot(), "bad"), {
    status: "error",
    stale: true,
    error: "pagination_error",
  });
  assert.deepEqual(orderedAgentKeys(directory.snapshot()), [
    agentKey("good", "ready"),
  ]);
  bad.emit(agentUpsert("partial", "2026-09-03T03:00:00Z"));
  assert.equal(hostSyncState(directory.snapshot(), "bad")?.status, "error");
  assert.equal(bad.subscriberCount, 0);

  bad.workspacePages.set(null, workspacePage([workspace("bad")], null, false));
  await directory.refresh("bad");
  assert.equal(hostSyncState(directory.snapshot(), "bad")?.status, "ready");
  bad.emit(agentUpsert("malformed", "not-a-timestamp"));
  assert.equal(hostSyncState(directory.snapshot(), "bad")?.status, "error");
  assert.equal(hostSyncState(directory.snapshot(), "good")?.status, "ready");
});

test("failed removal retains the connected directory subscription", async () => {
  const runtime = readyRuntime("alpha", [
    agentEntry("present", "2026-09-03T01:00:00Z"),
  ]);
  const source = new FakeLeaseSource([lease("alpha", runtime)]);
  const directory = new DirectoryCoordinator(
    source,
    new MemoryDirectoryStorage(),
  );
  await directory.restore();

  source.emit([{ ...lease("alpha", runtime), status: "error" }]);
  source.emit([{ ...lease("alpha", runtime), status: "error" }]);
  assert.equal(runtime.subscriberCount, 1);
  runtime.emit(agentUpsert("live", "2026-09-03T02:00:00Z"));
  assert.deepEqual(
    orderedAgentKeys(directory.snapshot())[0],
    agentKey("alpha", "live"),
  );
  assert.equal(hostSyncState(directory.snapshot(), "alpha")?.status, "ready");
});

test("real registry failed removal preserves live directory until successful retry", async () => {
  const alpha = readyRuntime("alpha", [
    agentEntry("selected", "2026-09-03T02:00:00Z"),
  ]);
  const beta = readyRuntime("beta", [
    agentEntry("fallback", "2026-09-03T01:00:00Z"),
  ]);
  const profiles = new FailingHostStorage([profile("alpha"), profile("beta")]);
  const registry = new HostRegistry(profiles, (options) =>
    options.expectedServerId === "alpha" ? alpha : beta,
  );
  const cache = new MemoryDirectoryStorage();
  const directory = new DirectoryCoordinator(registry, cache);
  const transitions: string[] = [];
  registry.subscribe((snapshot) => {
    const host = snapshot.hosts.find(
      ({ profile: stored }) => stored.serverId === "alpha",
    );
    if (host) transitions.push(host.status);
  });
  await directory.restore();
  await tick();
  assert.equal(directory.selectAgent(agentKey("alpha", "selected")), true);
  assert.equal(alpha.subscriberCount, 1);
  assert.equal(cache.hosts.has("alpha"), true);

  profiles.failDelete = true;
  await assert.rejects(registry.remove("alpha"), {
    name: "HostError",
    code: "storage_error",
  });
  assert.deepEqual(transitions.slice(-2), ["removing", "error"]);
  assert.equal(hostSyncState(directory.snapshot(), "alpha")?.status, "ready");
  assert.equal(alpha.subscriberCount, 1);
  alpha.emit(agentUpsert("live", "2026-09-03T03:00:00Z"));
  assert.equal(
    directory.snapshot().hosts.get("alpha")?.agents.has("live"),
    true,
  );

  profiles.failDelete = false;
  await registry.remove("alpha");
  await tick();
  assert.equal(alpha.closed, true);
  assert.equal(alpha.subscriberCount, 0);
  assert.equal(directory.snapshot().hosts.has("alpha"), false);
  assert.equal(cache.hosts.has("alpha"), false);
  assert.deepEqual(directory.snapshot().current, agentKey("beta", "fallback"));
  alpha.emitStale(agentUpsert("late", "2026-09-03T04:00:00Z"));
  assert.equal(directory.snapshot().hosts.has("alpha"), false);
  assert.deepEqual(orderedAgentKeys(directory.snapshot()), [
    agentKey("beta", "fallback"),
  ]);
});

test("cache restores selection before delayed refresh and removal cleans only its host", async () => {
  const storage = new MemoryDirectoryStorage();
  storage.hosts.set(
    "alpha",
    cached("alpha", [agentEntry("saved", "2026-09-03T01:00:00Z")]),
  );
  storage.hosts.set("orphan", cached("orphan", []));
  storage.selection = agentKey("alpha", "saved");
  const runtime = new FakeDirectoryRuntime("alpha");
  const network = deferred<PaseoAgents>();
  runtime.projects = projects("alpha");
  runtime.workspacePages.set(
    null,
    workspacePage([workspace("alpha")], null, false),
  );
  runtime.listAgentsImpl = async () => network.promise;
  const source = new FakeLeaseSource([lease("alpha", runtime)]);
  const directory = new DirectoryCoordinator(source, storage);
  const seen: string[][] = [];
  directory.subscribe((snapshot) =>
    seen.push(snapshot.orderedAgents.map((agent) => agent.agentId)),
  );
  const restoring = directory.restore();
  await tick();
  assert.equal(
    seen.some((ids) => ids.includes("saved")),
    true,
  );
  network.resolve(
    agentPage([agentEntry("fresh", "2026-09-03T02:00:00Z")], null, false),
  );
  await restoring;
  assert.deepEqual(directory.snapshot().current, agentKey("alpha", "fresh"));
  assert.equal(storage.hosts.has("orphan"), false);

  source.emit([]);
  await tick();
  assert.equal(directory.snapshot().destination, "config");
  assert.equal(storage.hosts.has("alpha"), false);
  assert.equal(storage.selection, null);
});

test("validated offline cache round-trip restores an eligible last selection", async () => {
  const storage = new MemoryDirectoryStorage();
  storage.hosts.set(
    "alpha",
    cached("alpha", [agentEntry("a", "2026-09-03T01:00:00Z")]),
  );
  storage.hosts.set(
    "beta",
    cached("beta", [
      agentEntry("b", "2026-09-03T02:00:00Z", {
        workspaceId: "workspace-beta",
      }),
    ]),
  );
  storage.selection = agentKey("alpha", "a");
  const alpha = lease("alpha", new FakeDirectoryRuntime("alpha"));
  const beta = lease("beta", new FakeDirectoryRuntime("beta"));
  alpha.status = beta.status = "offline";
  const directory = new DirectoryCoordinator(
    new FakeLeaseSource([alpha, beta]),
    storage,
  );
  await directory.restore();
  assert.deepEqual(directory.snapshot().current, agentKey("alpha", "a"));
  assert.deepEqual(orderedAgentKeys(directory.snapshot()), [
    agentKey("beta", "b"),
    agentKey("alpha", "a"),
  ]);
  assert.equal(hostSyncState(directory.snapshot(), "alpha")?.stale, true);
});

test("version one directory caches are deterministically invalidated", () => {
  const old = { ...cached("alpha", []), schemaVersion: 1 };
  assert.throws(() => validateCachedHostDirectory(old, "alpha"));
});

test("corrupt host cache is isolated and delayed older writes cannot win", async () => {
  const storage = new MemoryDirectoryStorage();
  const putBarrier = deferred<void>();
  storage.putBarrier = putBarrier.promise;
  storage.hosts.set("bad", { corrupt: true });
  const bad = new FakeDirectoryRuntime("bad");
  const good = new FakeDirectoryRuntime("good");
  for (const runtime of [bad, good]) {
    runtime.projects = projects(runtime.serverId);
    runtime.workspacePages.set(
      null,
      workspacePage([workspace(runtime.serverId)], null, false),
    );
    runtime.agentPages.set(null, agentPage([], null, false));
  }
  const directory = new DirectoryCoordinator(
    new FakeLeaseSource([lease("bad", bad), lease("good", good)]),
    storage,
    (() => {
      let now = 10;
      return () => ++now;
    })(),
  );
  await directory.restore();
  assert.equal(hostSyncState(directory.snapshot(), "good")?.status, "ready");
  bad.emit(agentUpsert("one", "2026-09-03T01:00:00Z"));
  bad.emit(agentUpsert("two", "2026-09-03T02:00:00Z"));
  putBarrier.resolve();
  await tick();
  await tick();
  assert.deepEqual(
    (storage.hosts.get("bad") as CachedHostDirectory).agents
      .map((agent) => agent.agentId)
      .sort(),
    ["one", "two"],
  );
});

class FakeLeaseSource {
  private listener: HostRuntimeLeaseListener = () => {};
  constructor(private leases: HostRuntimeLease[]) {}
  async restore() {}
  subscribeRuntimeLeases(listener: HostRuntimeLeaseListener) {
    this.listener = listener;
    listener(this.leases);
    return () => {
      this.listener = () => {};
    };
  }
  emit(leases: HostRuntimeLease[]) {
    this.leases = leases;
    this.listener(leases);
  }
}

class FakeDirectoryRuntime implements HostDirectoryRuntime {
  projects: PaseoProjects = projects("unset");
  workspacePages = new Map<string | null, PaseoWorkspaces>();
  agentPages = new Map<string | null, PaseoAgents>();
  workspaceRequests: unknown[] = [];
  agentRequests: unknown[] = [];
  listAgentsImpl: ((options: unknown) => Promise<PaseoAgents>) | null = null;
  private listeners = new Set<(event: PaseoDirectoryEvent) => void>();
  private staleListeners = new Set<(event: PaseoDirectoryEvent) => void>();
  private connectionListeners = new Set<
    (state: PaseoConnectionState) => void
  >();
  closed = false;
  constructor(readonly serverId: string) {}
  get subscriberCount() {
    return this.listeners.size;
  }
  getHost() {
    return {
      serverId: this.serverId,
      hostname: `host-${this.serverId}`,
      version: "0.7.0",
      capabilities: {},
      features: {},
    };
  }
  async connect() {
    for (const listener of this.connectionListeners)
      listener({ status: "connected" });
    return this.getHost();
  }
  async close() {
    this.closed = true;
  }
  subscribeConnection(listener: (state: PaseoConnectionState) => void) {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
  async listProjects() {
    return this.projects;
  }
  async listWorkspaces(options?: { page?: { cursor?: string } }) {
    this.workspaceRequests.push(structuredClone(options ?? {}));
    const cursor = options?.page?.cursor ?? null;
    const page = this.workspacePages.get(cursor);
    if (!page) throw new Error(`missing workspace page ${cursor}`);
    return page;
  }
  async listAgents(options?: { page?: { cursor?: string } }) {
    this.agentRequests.push(structuredClone(options ?? {}));
    if (this.listAgentsImpl) return this.listAgentsImpl(options);
    const cursor = options?.page?.cursor ?? null;
    const page = this.agentPages.get(cursor);
    if (!page) throw new Error(`missing agent page ${cursor}`);
    return page;
  }
  async getAgent() {
    return null;
  }
  async listUsage() {
    return {
      requestId: "usage",
      fetchedAt: "2026-09-03T00:00:00Z",
      providers: [],
    };
  }
  getTimeline(): Promise<never> {
    return Promise.reject(new Error("unused timeline fixture"));
  }
  async setTimelineSubscription() {}
  subscribeTimeline() {
    return () => {};
  }
  subscribeDirectory(listener: (event: PaseoDirectoryEvent) => void) {
    this.listeners.add(listener);
    this.staleListeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: PaseoDirectoryEvent) {
    for (const listener of this.listeners) listener(event);
  }
  emitStale(event: PaseoDirectoryEvent) {
    for (const listener of this.staleListeners) listener(event);
  }
}

class FailingHostStorage implements HostStorage {
  readonly profiles = new Map<string, StoredHostProfile>();
  failDelete = false;
  constructor(profiles: StoredHostProfile[]) {
    for (const stored of profiles) this.profiles.set(stored.serverId, stored);
  }
  async loadProfiles() {
    return [...this.profiles.values()];
  }
  async putProfile(stored: StoredHostProfile) {
    this.profiles.set(stored.serverId, stored);
  }
  async deleteProfile(serverId: string) {
    if (this.failDelete) throw new Error("delete failed");
    this.profiles.delete(serverId);
  }
  async getClientId() {
    return "0123456789abcdef0123456789abcdef";
  }
  async putClientId() {}
}

class MemoryDirectoryStorage implements DirectoryStorage {
  hosts = new Map<string, unknown>();
  selection: unknown | null = null;
  putBarrier: Promise<void> | null = null;
  async loadHost(serverId: string) {
    return structuredClone(this.hosts.get(serverId) ?? null);
  }
  async listHostIds() {
    return [...this.hosts.keys()];
  }
  async putHost(value: CachedHostDirectory) {
    await this.putBarrier;
    this.putBarrier = null;
    this.hosts.set(value.serverId, structuredClone(value));
  }
  async deleteHost(serverId: string) {
    this.hosts.delete(serverId);
  }
  async getLastViewedAgent() {
    return structuredClone(this.selection);
  }
  async putLastViewedAgent(key: AgentKey | null) {
    this.selection = structuredClone(key);
  }
}

function lease(
  serverId: string,
  runtime: HostDirectoryRuntime,
  slotGeneration = 1,
  connectionEpoch = 1,
): HostRuntimeLease {
  return {
    serverId,
    slotGeneration,
    connectionEpoch,
    status: "online",
    profile: profile(serverId),
    runtime,
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

function projects(serverId: string): PaseoProjects {
  return {
    requestId: "projects",
    projects: [
      {
        projectId: `project-${serverId}`,
        projectKey: `key-${serverId}`,
        projectDisplayName: `project ${serverId}`,
        projectRootPath: `/projects/${serverId}`,
        projectKind: "git",
      },
    ],
  };
}

function workspace(serverId: string): PaseoWorkspaceRecord {
  return {
    id: `workspace-${serverId}`,
    projectId: `project-${serverId}`,
    projectDisplayName: `project ${serverId}`,
    projectRootPath: `/projects/${serverId}`,
    workspaceDirectory: `/projects/${serverId}/workspace`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: `workspace-${serverId}`,
    archivingAt: null,
    status: "done",
    statusEnteredAt: null,
    activityAt: "2026-09-03T00:00:00Z",
    scripts: [],
    gitRuntime: null,
    githubRuntime: null,
  };
}

function agentEntry(
  id: string,
  updatedAt: string,
  overrides: Partial<PaseoAgentRecord> = {},
): PaseoAgentEntry {
  const agent: PaseoAgentRecord = {
    id,
    provider: "codex",
    cwd: "/workspace",
    workspaceId: "workspace-alpha",
    model: "gpt-fixture",
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt,
    lastUserMessageAt: null,
    status: "idle",
    activeTurn: null,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: id,
    labels: {},
    ...overrides,
  };
  const serverId = agent.workspaceId?.replace("workspace-", "") ?? "alpha";
  return {
    agent,
    project: {
      projectKey: `key-${serverId}`,
      projectName: `project ${serverId}`,
      workspaceName: `workspace-${serverId}`,
      checkout: {
        cwd: `/projects/${serverId}`,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

function agentPage(
  entries: PaseoAgentEntry[],
  nextCursor: string | null,
  hasMore: boolean,
): PaseoAgents {
  return {
    requestId: "agents",
    entries,
    pageInfo: { nextCursor, prevCursor: null, hasMore },
  };
}

function workspacePage(
  entries: PaseoWorkspaceRecord[],
  nextCursor: string | null,
  hasMore: boolean,
): PaseoWorkspaces {
  return {
    requestId: "workspaces",
    entries,
    emptyProjects: [],
    pageInfo: { nextCursor, prevCursor: null, hasMore },
  };
}

function agentUpsert(id: string, updatedAt: string): PaseoDirectoryEvent {
  const entry = agentEntry(id, updatedAt);
  return {
    type: "agent_update",
    agentId: id,
    payload: { kind: "upsert", agent: entry.agent, project: entry.project },
  };
}

function readyRuntime(serverId: string, entries: PaseoAgentEntry[]) {
  const runtime = new FakeDirectoryRuntime(serverId);
  runtime.projects = projects(serverId);
  runtime.workspacePages.set(
    null,
    workspacePage([workspace(serverId)], null, false),
  );
  runtime.agentPages.set(null, agentPage(entries, null, false));
  return runtime;
}

function cached(
  serverId: string,
  entries: PaseoAgentEntry[],
): CachedHostDirectory {
  const runtime = new FakeDirectoryRuntime(serverId);
  runtime.projects = projects(serverId);
  const projectsById = new Map(
    runtime.projects.projects.map((project) => [
      project.projectId,
      {
        serverId,
        projectId: project.projectId,
        projectKey: project.projectKey ?? null,
        displayName: project.projectDisplayName,
        customName: null,
        rootPath: project.projectRootPath,
        kind: project.projectKind,
        syncSeq: null,
      } as const,
    ]),
  );
  const workspaceRow = workspace(serverId);
  const workspacesById = new Map([
    [
      workspaceRow.id,
      {
        serverId,
        workspaceId: workspaceRow.id,
        projectId: workspaceRow.projectId,
        projectName: workspaceRow.projectDisplayName,
        name: workspaceRow.name,
        title: null,
        directory: workspaceRow.workspaceDirectory,
        kind: workspaceRow.workspaceKind,
        status: workspaceRow.status,
        activityAt: workspaceRow.activityAt,
        pinnedAt: null,
        labels: [],
        syncSeq: null,
      } as const,
    ],
  ]);
  return {
    schemaVersion: 2,
    serverId,
    revision: 1,
    lastSuccessfulSyncAt: 1,
    projects: [...projectsById.values()],
    workspaces: [...workspacesById.values()],
    agents: entries.map(({ agent, project, syncSeq }) => ({
      serverId,
      agentId: agent.id,
      workspaceId: `workspace-${serverId}`,
      projectId: `project-${serverId}`,
      projectKey: project.projectKey,
      projectName: project.projectName,
      workspaceName: project.workspaceName ?? null,
      title: agent.title,
      provider: agent.provider,
      model: agent.model,
      thinkingOptionId:
        agent.effectiveThinkingOptionId ?? agent.thinkingOptionId ?? null,
      currentModeId: agent.currentModeId,
      availableModes: agent.availableModes.map(({ id, label }) => ({
        id,
        label,
      })),
      status: agent.status,
      activeTurn: agent.activeTurn ?? null,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      lastUserMessageAt: agent.lastUserMessageAt,
      cwd: agent.cwd,
      labels: agent.labels,
      archivedAt: agent.archivedAt ?? null,
      pendingPermissions: agent.pendingPermissions.map((permission) => ({
        id: permission.id,
        provider: permission.provider,
        name: permission.name,
        kind: permission.kind,
        title: permission.title ?? null,
      })),
      syncSeq: syncSeq ?? null,
    })),
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
