import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentPagerController,
  initialPagerState,
  openAgentFromConfig,
  reconcilePagerState,
  reduceAgentPager,
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
  restoreConfigState,
} from "../src/config/reducer";
import { validateStoredConfigUi } from "../src/config/storage";
import {
  CONFIG_UI_VERSION,
  type ConfigRow,
  type ConfigSectionProjector,
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
  assert.notEqual(
    rowId("fallback-project", alpha.serverId),
    rowId("project", alpha.serverId, "$unplaced"),
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

  const empty = host("empty", "Empty");
  const emptyProjection = projectConfig(
    snapshot([empty], []),
    new Set([WORKSPACES_SECTION_ID, rowId("host", empty.serverId)]),
  );
  assert.equal(
    emptyProjection.rows.some(({ label }) => label === "No eligible Agents"),
    true,
  );
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
  const moved = reduceConfig(state, directory, input("DOWN", 10)).state;
  assert.equal(reduceConfig(moved, directory, input("DOWN", 10)).state, moved);
  for (const action of ["UPDATE", "END", "CANCEL"] as const)
    assert.equal(
      reduceConfig(moved, directory, input("DOWN", 10, action)).state,
      moved,
    );
  for (const [action, interactionId] of [
    ["UPDATE", 20],
    ["END", 21],
    ["CANCEL", 22],
  ] as const)
    assert.equal(
      reduceConfig(moved, directory, input("DOWN", interactionId, action))
        .state,
      moved,
    );
  assert.equal(
    reduceConfig(moved, directory, input("DOWN", 11, "SHORT")).state,
    moved,
  );
  const lower = reduceConfig(
    { ...moved, focusedRowId: HID_KEYS_SECTION_ID },
    directory,
    input("DOWN", 12),
  ).state;
  assert.equal(lower.focusedRowId, HID_KEYS_SECTION_ID);
  assert.equal(
    reduceConfig(lower, directory, input("PRIMARY", 13, "BEGIN")).state,
    lower,
  );

  const removed = snapshot([], []);
  const reprojected = reprojectConfigState(state, removed);
  assert.equal(reprojected.focusedRowId, HID_KEYS_SECTION_ID);
});

test("Config reducer projects provider rows from each candidate expansion set", () => {
  const directory = snapshot([], []);
  const hostId = rowId("hosts", "host", "alpha");
  const childId = rowId("hosts", "status", "alpha");
  const sectionRows: ConfigSectionProjector = (expanded) =>
    new Map([
      [
        HOSTS_SECTION_ID,
        providerHostRows(hostId, childId, expanded.has(hostId)),
      ],
    ]);
  let state = restoreConfigState(
    initialConfigState(directory, sectionRows),
    directory,
    [HOSTS_SECTION_ID],
    hostId,
    0,
    sectionRows,
  );
  assert.equal(state.projection.allRows.get(hostId)?.expanded, false);
  assert.equal(
    state.projection.rows.some(({ id }) => id === childId),
    false,
  );

  state = reduceConfig(
    state,
    directory,
    input("PRIMARY", 1),
    sectionRows,
  ).state;
  assert.equal(state.projection.allRows.get(hostId)?.expanded, true);
  assert.equal(
    state.projection.rows.some(({ id }) => id === childId),
    true,
  );

  state = reduceConfig(
    state,
    directory,
    input("PRIMARY", 2),
    sectionRows,
  ).state;
  assert.equal(state.projection.allRows.get(hostId)?.expanded, false);
  assert.equal(
    state.projection.rows.some(({ id }) => id === childId),
    false,
  );

  state = restoreConfigState(
    state,
    directory,
    [HOSTS_SECTION_ID, hostId],
    hostId,
    3,
    sectionRows,
  );
  assert.equal(state.projection.allRows.get(hostId)?.expanded, true);
  assert.equal(
    state.projection.rows.some(({ id }) => id === childId),
    true,
  );
});

test("Config reprojection retains focus through live host and Agent updates", () => {
  const directory = directoryFixture();
  let state = initialConfigState(directory);
  for (const event of [
    input("DOWN", 1),
    input("PRIMARY", 2),
    input("DOWN", 3),
    input("PRIMARY", 4),
    input("DOWN", 5),
  ])
    state = reduceConfig(state, directory, event).state;
  const focused = state.focusedRowId;
  const changedHost = {
    ...directory.hosts.get("alpha")!,
    status: "offline" as const,
    stale: true,
    profile: { ...directory.hosts.get("alpha")!.profile, hostname: "Renamed" },
  };
  const changed = {
    ...directory,
    hosts: new Map([["alpha", changedHost]]),
    orderedAgents: [{ ...directory.orderedAgents[0]!, title: "Renamed Agent" }],
  };
  state = reprojectConfigState(state, changed);
  assert.equal(state.focusedRowId, focused);
  assert.equal(state.projection.counts.offline, 1);
  state = reprojectConfigState(state, directory);
  assert.equal(state.focusedRowId, focused);
});

test("Config reprojection retains inserted focus, climbs folds, and falls forward then back on removal", () => {
  const directory = directoryFixture();
  const hostValue = directory.hosts.get("alpha")!;
  const current = directory.orderedAgents[0]!;
  const inserted = {
    ...current,
    agentId: "agent-new",
    updatedAt: "2026-09-03T04:00:00Z",
  };
  const expanded = [
    WORKSPACES_SECTION_ID,
    rowId("host", "alpha"),
    rowId("project", "alpha", "project-a"),
  ];
  let state = restoreConfigState(
    initialConfigState(directory),
    directory,
    expanded,
    rowId("agent", "alpha", "agent-a"),
    0,
  );
  const withInsertion = {
    ...directory,
    hosts: new Map([
      [
        "alpha",
        {
          ...hostValue,
          agents: new Map([
            [current.agentId, current],
            [inserted.agentId, inserted],
          ]),
        },
      ],
    ]),
    orderedAgents: [inserted, current],
  };
  state = reprojectConfigState(state, withInsertion);
  assert.equal(state.focusedRowId, rowId("agent", "alpha", "agent-a"));

  state = restoreConfigState(
    state,
    withInsertion,
    [WORKSPACES_SECTION_ID, rowId("host", "alpha")],
    rowId("agent", "alpha", "agent-a"),
    state.revision,
  );
  assert.equal(state.focusedRowId, rowId("project", "alpha", "project-a"));

  state = restoreConfigState(
    state,
    withInsertion,
    expanded,
    rowId("agent", "alpha", "agent-new"),
    state.revision,
  );
  state = reprojectConfigState(state, directory);
  assert.equal(state.focusedRowId, rowId("agent", "alpha", "agent-a"));
  state = reprojectConfigState(state, snapshot([], []));
  assert.equal(state.focusedRowId, HID_KEYS_SECTION_ID);
});

test("Config focus survives host removal/reconnect and pager returns exactly after Agent or empty entry", () => {
  const alpha = directoryFixture();
  const betaHost = host("beta", "Beta");
  const betaProject = project(betaHost, "project-b", "Project B");
  const betaWorkspace = workspace(
    betaHost,
    "workspace-b",
    betaProject.projectId,
    "Main",
    "directory",
  );
  const betaAgent = agent(
    betaHost,
    "agent-b",
    betaWorkspace,
    "2026-09-03T02:00:00Z",
  );
  put(betaHost.projects, betaProject.projectId, betaProject);
  put(betaHost.workspaces, betaWorkspace.workspaceId, betaWorkspace);
  put(betaHost.agents, betaAgent.agentId, betaAgent);
  const both = snapshot(
    [alpha.hosts.get("alpha")!, betaHost],
    [...alpha.orderedAgents, betaAgent],
  );
  const betaRow = rowId("agent", "beta", "agent-b");
  const expanded = [
    WORKSPACES_SECTION_ID,
    rowId("host", "beta"),
    rowId("project", "beta", "project-b"),
  ];
  let config = restoreConfigState(
    initialConfigState(both),
    both,
    expanded,
    betaRow,
    0,
  );
  config = reprojectConfigState(config, snapshot([betaHost], [betaAgent]));
  assert.equal(config.focusedRowId, betaRow);
  config = reprojectConfigState(config, both);
  assert.equal(config.focusedRowId, betaRow);

  const key = { serverId: "beta", agentId: "agent-b" };
  const selected = { ...both, current: key, destination: "agent" as const };
  let pager = initialPagerState(selected);
  pager = reduceAgentPager(pager, selected, {
    ...input("COMMAND", 1),
    action: "LONG",
  }).state;
  const returned = reduceAgentPager(pager, selected, input("COMMAND", 2));
  assert.deepEqual(returned.select, key);

  const empty = snapshot([], []);
  pager = reconcilePagerState(initialPagerState(empty), selected);
  assert.deepEqual(pager.destination, { kind: "config", returnTo: null });
  const arrived = reduceAgentPager(pager, selected, input("COMMAND", 3));
  assert.deepEqual(arrived.select, key);
  assert.deepEqual(arrived.state.destination, {
    kind: "agent",
    key,
    pane: "timeline",
  });
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

test("Config controller fences a delayed restore after directory re-anchors focus", async () => {
  const source = new FakeDirectory(directoryFixture());
  const delayed = deferred<unknown | null>();
  const controller = new ConfigController(
    source,
    new MemoryStorage(delayed.promise),
    () => false,
  );
  for (const event of [
    input("DOWN", 1),
    input("PRIMARY", 2),
    input("DOWN", 3),
    input("PRIMARY", 4),
    input("DOWN", 5),
  ])
    controller.handle(event);
  const restore = controller.restore();
  source.emit(snapshot([], []));
  const reanchored = controller.snapshot().focusedRowId;
  delayed.resolve(stored([HOSTS_SECTION_ID], HOSTS_SECTION_ID, 0));
  await restore;
  assert.equal(controller.snapshot().focusedRowId, reanchored);
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
  action: SemanticInput["action"] = control === "UP" || control === "DOWN"
    ? "BEGIN"
    : "SHORT",
): SemanticInput {
  return {
    type: "semantic-input",
    control,
    action,
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
