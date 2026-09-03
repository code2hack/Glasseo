import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentPagerController,
  openAgentFromConfig,
  type AgentDirectorySource,
} from "../src/agent-pages/pager";
import {
  ConfigController,
  type ConfigDirectorySource,
} from "../src/config/controller";
import { configDiagnostics } from "../src/config/diagnostics";
import {
  HID_KEYS_SECTION_ID,
  HOSTS_SECTION_ID,
  WORKSPACES_SECTION_ID,
  collapsesWorkspace,
  projectConfig,
  rowId,
} from "../src/config/project";
import {
  initialConfigState,
  reduceConfig,
  reprojectConfigState,
} from "../src/config/reducer";
import { validateStoredConfigUi } from "../src/config/storage";
import {
  CONFIG_UI_VERSION,
  type ConfigStorage,
  type StoredConfigUi,
} from "../src/config/types";
import type {
  AgentKey,
  DirectoryAgent,
  DirectoryProject,
  DirectoryWorkspace,
  GlobalAgentDirectorySnapshot,
  HostDirectorySnapshot,
} from "../src/directory/types";
import type { SemanticInput } from "../src/native/semanticInput";

test("Config projection is deterministic, composite, collapses only ordinary workspaces, and retains incomplete Agents", () => {
  const alpha = host("server:a", "Zulu", { status: "offline", stale: true });
  const beta = host("server:b", "alpha", {
    status: "error",
    error: "sync_error",
  });
  const ordinary = workspace(
    alpha,
    "workspace:ordinary",
    "project:one",
    "Only",
    "directory",
  );
  const checkout = workspace(
    beta,
    "workspace:checkout",
    "project:one",
    "Only",
    "worktree",
  );
  put(alpha.projects, "project:one", project(alpha, "project:one", "Same"));
  put(beta.projects, "project:one", project(beta, "project:one", "Same"));
  put(alpha.workspaces, ordinary.workspaceId, ordinary);
  put(beta.workspaces, checkout.workspaceId, checkout);
  const alphaAgent = agent(alpha, "shared", ordinary, "2026-09-03T03:00:00Z");
  const betaAgent = agent(beta, "shared", checkout, "2026-09-03T02:00:00Z");
  const unplaced = {
    ...agent(alpha, "unplaced", ordinary, "2026-09-03T01:00:00Z"),
    workspaceId: "missing",
    projectId: "missing",
  };
  put(alpha.agents, alphaAgent.agentId, alphaAgent);
  put(alpha.agents, unplaced.agentId, unplaced);
  put(beta.agents, betaAgent.agentId, betaAgent);
  const directory = snapshot([alpha, beta], [alphaAgent, betaAgent, unplaced]);
  const expanded = new Set([
    WORKSPACES_SECTION_ID,
    rowId("host", alpha.serverId),
    rowId("host", beta.serverId),
    rowId("project", alpha.serverId, "project:one"),
    rowId("project", beta.serverId, "project:one"),
    rowId("workspace", beta.serverId, checkout.workspaceId),
    rowId("project", alpha.serverId, "$unplaced"),
  ]);
  const projection = projectConfig(directory, expanded);

  assert.deepEqual(
    projection.rows
      .filter(({ kind }) => kind === "section")
      .map(({ id }) => id),
    [WORKSPACES_SECTION_ID, HOSTS_SECTION_ID, HID_KEYS_SECTION_ID],
  );
  assert.deepEqual(
    projection.rows
      .filter(({ kind }) => kind === "host")
      .map(({ label }) => label),
    ["alpha", "Zulu"],
  );
  assert.equal(
    projection.allRows.has(
      rowId("workspace", alpha.serverId, ordinary.workspaceId),
    ),
    false,
  );
  assert.equal(
    projection.allRows.has(
      rowId("workspace", beta.serverId, checkout.workspaceId),
    ),
    true,
  );
  assert.equal(
    projection.allRows.has(rowId("agent", alpha.serverId, "shared")),
    true,
  );
  assert.equal(
    projection.allRows.has(rowId("agent", beta.serverId, "shared")),
    true,
  );
  assert.equal(
    projection.rows.some(({ label }) => label === "Other"),
    true,
  );
  assert.deepEqual(projection.counts, {
    hosts: 2,
    projects: 2,
    workspaces: 2,
    agents: 3,
    stale: 1,
    offline: 1,
    errors: 1,
  });
  assert.equal(collapsesWorkspace(ordinary, [ordinary]), true);
  assert.equal(collapsesWorkspace(checkout, [checkout]), false);
  assert.equal(collapsesWorkspace(ordinary, [ordinary], true), false);
});

test("Config reducer handles terminal controls once, clamps movement, folds, activates, and re-anchors live focus", () => {
  const directory = directoryFixture();
  let state = initialConfigState(directory);
  state = reduceConfig(state, directory, input("UP", 1)).state;
  assert.equal(state.focusedRowId, WORKSPACES_SECTION_ID);
  state = reduceConfig(state, directory, input("PRIMARY", 2)).state;
  assert.equal(state.projection.rows.length, 3);
  assert.equal(
    reduceConfig(state, directory, input("PRIMARY", 2)).state,
    state,
  );
  state = reduceConfig(state, directory, input("PRIMARY", 3)).state;
  state = reduceConfig(state, directory, input("DOWN", 4)).state;
  const hostId = rowId("host", "alpha");
  assert.equal(state.focusedRowId, hostId);
  state = reduceConfig(state, directory, input("PRIMARY", 5)).state;
  state = reduceConfig(state, directory, input("DOWN", 6)).state;
  state = reduceConfig(state, directory, input("PRIMARY", 7)).state;
  state = reduceConfig(state, directory, input("DOWN", 8)).state;
  const activation = reduceConfig(state, directory, input("PRIMARY", 9));
  assert.deepEqual(activation.activate, {
    serverId: "alpha",
    agentId: "agent-a",
  });
  assert.equal(
    reduceConfig(state, directory, { ...input("DOWN", 10), action: "BEGIN" })
      .state,
    state,
  );

  const removed = snapshot([], []);
  const reprojected = reprojectConfigState(state, removed);
  assert.notEqual(reprojected.focusedRowId, state.focusedRowId);
  assert.equal(
    reprojected.projection.rows.some(
      ({ id }) => id === reprojected.focusedRowId,
    ),
    true,
  );
});

test("Config controller fences delayed restore and writes and isolates observers", async () => {
  const source = new FakeDirectory(directoryFixture());
  const delayed = deferred<unknown | null>();
  const storage = new MemoryStorage(delayed.promise);
  const activations: AgentKey[] = [];
  const controller = new ConfigController(
    source,
    storage,
    (key) => {
      if (!source.snapshot().orderedAgents.some((agent) => sameKey(agent, key)))
        return false;
      activations.push(key);
      return true;
    },
    () => 42,
  );
  controller.subscribe(() => {
    throw new Error("observer");
  });
  const restore = controller.restore();
  controller.handle(input("DOWN", 1));
  delayed.resolve(stored([HOSTS_SECTION_ID], HOSTS_SECTION_ID, 50));
  await restore;
  assert.notEqual(controller.snapshot().focusedRowId, HOSTS_SECTION_ID);

  const expanded = [...controller.snapshot().expandedRowIds];
  assert.equal(
    validateStoredConfigUi(
      stored(expanded, controller.snapshot().focusedRowId, 1),
    ).schemaVersion,
    1,
  );
  assert.throws(() => validateStoredConfigUi({ schemaVersion: 1 }));

  assert.deepEqual(activations, []);
  await tick();
  assert.equal(storage.writes.at(-1)?.updatedAt, 42);
});

test("Config controller restores validated fold/focus state and activates exact composite Agent", async () => {
  const directory = directoryFixture();
  const source = new FakeDirectory(directory);
  const agentId = rowId("agent", "alpha", "agent-a");
  const restoredExpanded = [
    WORKSPACES_SECTION_ID,
    rowId("host", "alpha"),
    rowId("project", "alpha", "project-a"),
  ];
  const storage = new MemoryStorage(
    Promise.resolve(stored(restoredExpanded, agentId, 7)),
  );
  const pager = new AgentPagerController(source);
  const controller = new ConfigController(source, storage, (key) =>
    pager.openAgent(key),
  );
  await controller.restore();
  assert.equal(controller.snapshot().focusedRowId, agentId);
  assert.equal(controller.handle(input("PRIMARY", 1)), true);
  assert.deepEqual(source.selections, [
    { serverId: "alpha", agentId: "agent-a" },
  ]);
  assert.deepEqual(pager.snapshot().destination, {
    kind: "agent",
    key: { serverId: "alpha", agentId: "agent-a" },
    pane: "timeline",
  });
});

test("Config restore waits for the authoritative directory before pruning stable IDs", async () => {
  const restoring = { ...snapshot([], []), restoring: true };
  const source = new FakeDirectory(restoring);
  const agentId = rowId("agent", "alpha", "agent-a");
  const expanded = [
    WORKSPACES_SECTION_ID,
    rowId("host", "alpha"),
    rowId("project", "alpha", "project-a"),
  ];
  const controller = new ConfigController(
    source,
    new MemoryStorage(Promise.resolve(stored(expanded, agentId, 7))),
    () => true,
  );
  await controller.restore();
  assert.equal(controller.snapshot().focusedRowId, WORKSPACES_SECTION_ID);
  source.emit(directoryFixture());
  assert.equal(controller.snapshot().focusedRowId, agentId);
  assert.deepEqual([...controller.snapshot().expandedRowIds], expanded);
});

test("pager Config activation is pure, rejects stale rows, clears return route, and selects once", () => {
  const directory = directoryFixture();
  const source = new FakeDirectory(directory);
  const pager = new AgentPagerController(source);
  const key = { serverId: "alpha", agentId: "agent-a" };
  const transition = openAgentFromConfig(pager.snapshot(), directory, key);
  assert.deepEqual(transition.state.destination, {
    kind: "agent",
    key,
    pane: "timeline",
  });
  assert.deepEqual(transition.select, key);
  assert.equal(pager.openAgent({ ...key, agentId: "missing" }), false);
  assert.equal(pager.openAgent(key), true);
  assert.equal(pager.openAgent(key), false);
  assert.deepEqual(source.selections, [key]);
});

test("Config diagnostics expose only hashed identities and aggregate state", () => {
  const facts = configDiagnostics(initialConfigState(directoryFixture()), {
    serverId: "alpha",
    agentId: "agent-a",
  });
  assert.equal(facts.destination, "config");
  assert.equal(facts.hosts, 1);
  assert.equal(facts.agents, 1);
  assert.equal(facts.duplicateRowCount, 0);
  assert.equal(JSON.stringify(facts).includes("agent-a"), false);
  assert.equal(JSON.stringify(facts).includes("alpha"), false);
});

class FakeDirectory implements ConfigDirectorySource, AgentDirectorySource {
  private readonly listeners = new Set<
    (value: GlobalAgentDirectorySnapshot) => void
  >();
  readonly selections: AgentKey[] = [];
  constructor(private value: GlobalAgentDirectorySnapshot) {}
  snapshot() {
    return this.value;
  }
  subscribe(listener: (value: GlobalAgentDirectorySnapshot) => void) {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }
  selectAgent(key: AgentKey) {
    if (!this.value.orderedAgents.some((agent) => sameKey(agent, key)))
      return false;
    this.selections.push(key);
    this.emit({ ...this.value, current: key, destination: "agent" });
    return true;
  }
  emit(value: GlobalAgentDirectorySnapshot) {
    this.value = value;
    for (const listener of this.listeners) listener(value);
  }
}

class MemoryStorage implements ConfigStorage {
  readonly writes: StoredConfigUi[] = [];
  constructor(private readonly value: Promise<unknown | null>) {}
  load() {
    return this.value;
  }
  async put(value: StoredConfigUi) {
    this.writes.push(value);
  }
}

function directoryFixture(): GlobalAgentDirectorySnapshot {
  const alpha = host("alpha", "Alpha");
  const projectValue = project(alpha, "project-a", "Project A");
  const workspaceValue = workspace(
    alpha,
    "workspace-a",
    projectValue.projectId,
    "Main",
    "directory",
  );
  const agentValue = agent(
    alpha,
    "agent-a",
    workspaceValue,
    "2026-09-03T03:00:00Z",
  );
  put(alpha.projects, projectValue.projectId, projectValue);
  put(alpha.workspaces, workspaceValue.workspaceId, workspaceValue);
  put(alpha.agents, agentValue.agentId, agentValue);
  return snapshot([alpha], [agentValue]);
}

function snapshot(
  hosts: HostDirectorySnapshot[],
  agents: DirectoryAgent[],
): GlobalAgentDirectorySnapshot {
  return {
    hosts: new Map(hosts.map((value) => [value.serverId, value])),
    orderedAgents: agents,
    current: null,
    destination: "config",
    restoring: false,
  };
}

function host(
  serverId: string,
  hostname: string,
  overrides: Partial<HostDirectorySnapshot> = {},
): HostDirectorySnapshot {
  return {
    serverId,
    profile: {
      schemaVersion: 1,
      serverId,
      relayEndpoint: "relay.paseo.sh:443",
      useTls: true,
      daemonPublicKey: "redacted",
      hostname,
      createdAt: 1,
      updatedAt: 1,
    },
    status: "ready",
    revision: 1,
    sourceToken: { serverId, slotGeneration: 1, connectionEpoch: 1 },
    projects: new Map(),
    workspaces: new Map(),
    agents: new Map(),
    stale: false,
    error: null,
    lastSuccessfulSyncAt: 1,
    ...overrides,
  };
}

function project(
  hostValue: HostDirectorySnapshot,
  projectId: string,
  displayName: string,
): DirectoryProject {
  return {
    serverId: hostValue.serverId,
    projectId,
    projectKey: projectId,
    displayName,
    customName: null,
    rootPath: "/project",
    kind: "git",
    syncSeq: null,
  };
}

function workspace(
  hostValue: HostDirectorySnapshot,
  workspaceId: string,
  projectId: string,
  name: string,
  kind: DirectoryWorkspace["kind"],
): DirectoryWorkspace {
  return {
    serverId: hostValue.serverId,
    workspaceId,
    projectId,
    projectName: projectId,
    name,
    title: null,
    directory: "/workspace",
    kind,
    status: "done",
    activityAt: null,
    pinnedAt: null,
    labels: [],
    syncSeq: null,
  };
}

function agent(
  hostValue: HostDirectorySnapshot,
  agentId: string,
  workspaceValue: DirectoryWorkspace,
  updatedAt: string,
): DirectoryAgent {
  return {
    serverId: hostValue.serverId,
    agentId,
    workspaceId: workspaceValue.workspaceId,
    projectId: workspaceValue.projectId,
    projectKey: workspaceValue.projectId,
    projectName: workspaceValue.projectName,
    workspaceName: workspaceValue.name,
    title: "Agent",
    provider: "codex",
    model: null,
    thinkingOptionId: null,
    currentModeId: null,
    availableModes: [],
    status: "idle",
    activeTurn: null,
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt,
    lastUserMessageAt: null,
    cwd: "/workspace",
    labels: {},
    archivedAt: null,
    pendingPermissions: [],
    syncSeq: null,
  };
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
    timeMillis: 1,
  };
}

function stored(
  expandedRowIds: readonly string[],
  focusedRowId: string | null,
  revision: number,
): StoredConfigUi {
  return {
    schemaVersion: CONFIG_UI_VERSION,
    revision,
    updatedAt: 1,
    expandedRowIds,
    focusedRowId,
  };
}

function sameKey(left: AgentKey, right: AgentKey): boolean {
  return left.serverId === right.serverId && left.agentId === right.agentId;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function put<T>(map: ReadonlyMap<string, T>, key: string, value: T): void {
  (map as Map<string, T>).set(key, value);
}
