import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentPagerController,
  initialPagerState,
  reconcilePagerState,
  reduceAgentPager,
  type AgentDirectorySource,
} from "../src/agent-pages/pager";
import {
  projectAgentHeader,
  type AgentRuntimeMetadata,
} from "../src/agent-pages/header";
import {
  AgentHeaderMetadataController,
  formatProviderUsage,
  projectAgentMetadata,
  type MetadataDirectorySource,
  type MetadataLeaseSource,
} from "../src/agent-pages/headerMetadata";
import type { PaseoAgent, PaseoUsage } from "../src/paseo/adapter";
import type { HostRuntimeLeaseListener } from "../src/hosts/types";
import type {
  AgentKey,
  DirectoryAgent,
  DirectoryProject,
  DirectoryWorkspace,
  GlobalAgentDirectorySnapshot,
  HostDirectorySnapshot,
} from "../src/directory/types";
import type { SemanticInput } from "../src/native/semanticInput";

test("pager wraps composite Agent keys and preserves identity across reorder", () => {
  const alpha = agent("alpha", "same", "2026-09-03T03:00:00Z");
  const beta = agent("beta", "same", "2026-09-03T02:00:00Z");
  const gamma = agent("alpha", "gamma", "2026-09-03T01:00:00Z");
  const directory = snapshot([alpha, beta, gamma], key(alpha));
  let state = initialPagerState(directory);
  state = reduceAgentPager(state, directory, input("LEFT", "SHORT", 1)).state;
  assert.deepEqual(state.destination, {
    kind: "agent",
    key: key(gamma),
    pane: "timeline",
  });
  state = reduceAgentPager(state, directory, input("RIGHT", "SHORT", 2)).state;
  assert.deepEqual(state.destination, {
    kind: "agent",
    key: key(alpha),
    pane: "timeline",
  });
  const reordered = snapshot([gamma, alpha, beta], key(alpha));
  assert.deepEqual(reconcilePagerState(state, reordered).destination, {
    kind: "agent",
    key: key(alpha),
    pane: "timeline",
  });
  assert.deepEqual(
    reconcilePagerState(state, snapshot([beta], key(beta))).destination,
    { kind: "agent", key: key(beta), pane: "timeline" },
  );
});

test("pager handles one, zero, fallback, shell commands, and duplicate terminals", () => {
  const alpha = agent("alpha", "a", "2026-09-03T03:00:00Z");
  const beta = agent("beta", "b", "2026-09-03T02:00:00Z");
  const one = snapshot([alpha], key(alpha));
  let state = initialPagerState(one);
  state = reduceAgentPager(state, one, input("RIGHT", "SHORT", 1)).state;
  assert.deepEqual(state.destination, {
    kind: "agent",
    key: key(alpha),
    pane: "timeline",
  });
  state = reduceAgentPager(state, one, input("COMMAND", "SHORT", 2)).state;
  assert.equal(
    state.destination.kind === "agent" && state.destination.pane,
    "draft",
  );
  assert.equal(
    reduceAgentPager(state, one, input("LEFT", "SHORT", 3)).state,
    state,
  );
  state = reduceAgentPager(state, one, input("COMMAND", "SHORT", 4)).state;
  state = reduceAgentPager(state, one, input("COMMAND", "LONG", 5)).state;
  assert.deepEqual(state.destination, { kind: "config", returnTo: key(alpha) });
  assert.equal(
    reduceAgentPager(state, one, input("LEFT", "SHORT", 6)).state,
    state,
  );
  const fallback = snapshot([beta], key(beta));
  state = reduceAgentPager(state, fallback, input("COMMAND", "SHORT", 7)).state;
  assert.deepEqual(state.destination, {
    kind: "agent",
    key: key(beta),
    pane: "timeline",
  });
  assert.equal(
    reduceAgentPager(state, fallback, input("RIGHT", "SHORT", 7)).state,
    state,
  );
  assert.equal(
    reduceAgentPager(state, fallback, input("RIGHT", "BEGIN", 8)).state,
    state,
  );
  assert.deepEqual(reconcilePagerState(state, snapshot([], null)).destination, {
    kind: "config",
    returnTo: null,
  });
  assert.deepEqual(
    reconcilePagerState(
      initialPagerState(snapshot([], null, false, 1, true)),
      snapshot([alpha], key(alpha)),
    ).destination,
    { kind: "agent", key: key(alpha), pane: "timeline" },
  );
  assert.deepEqual(
    reconcilePagerState(
      initialPagerState(snapshot([], null)),
      snapshot([alpha], key(alpha)),
    ).destination,
    { kind: "config", returnTo: null },
  );
});

test("pager controller delegates selection once and isolates subscribers", () => {
  const alpha = agent("alpha", "a", "2026-09-03T03:00:00Z");
  const beta = agent("beta", "b", "2026-09-03T02:00:00Z");
  const source = new FakeDirectory(snapshot([alpha, beta], key(alpha)));
  const pager = new AgentPagerController(source);
  pager.subscribe(() => {
    throw new Error("observer");
  });
  pager.handle(input("RIGHT", "SHORT", 1));
  pager.handle(input("RIGHT", "SHORT", 1));
  assert.deepEqual(source.selections, [key(beta)]);
  assert.deepEqual(pager.snapshot().destination, {
    kind: "agent",
    key: key(beta),
    pane: "timeline",
  });
});

test("header projects placement, optional workspace, fallbacks, and matching runtime facts", () => {
  const selected = agent(
    "alpha",
    "agent-very-long-身份",
    "2026-09-03T03:00:00Z",
    {
      title: "Long · Agent / title Ω".repeat(10),
      thinkingOptionId: "high",
      currentModeId: "plan",
      availableModes: [{ id: "plan", label: "Plan mode" }],
    },
  );
  const directory = snapshot([selected], key(selected), true);
  const host = directory.hosts.get("alpha")!;
  const metadata: AgentRuntimeMetadata = {
    key: key(selected),
    sourceToken: host.sourceToken!,
    revision: 3,
    model: "gpt-runtime",
    thinkingOptionId: "high",
    thinkingOptionLabel: "High reasoning",
    currentModeId: "plan",
    currentModeLabel: "Plan mode",
    usage: "Weekly 73% remaining",
  };
  assert.deepEqual(projectAgentHeader(directory, key(selected), metadata), {
    line1: `host-alpha · Custom project / workspace-alpha / ${selected.title}`,
    line2: "gpt-runtime · High reasoning · Plan mode · Weekly 73% remaining",
    status: "ready",
  });
  const staleMetadata = {
    ...metadata,
    sourceToken: { ...metadata.sourceToken, connectionEpoch: 0 },
  };
  assert.equal(
    projectAgentHeader(directory, key(selected), staleMetadata)?.line2,
    "gpt-directory · high · Plan mode",
  );
  const noWorkspace = snapshot([selected], key(selected));
  assert.equal(
    projectAgentHeader(noWorkspace, key(selected), null)?.line1,
    `host-alpha · Custom project / ${selected.title}`,
  );
});

test("header omits unavailable values and formats real usage semantics", () => {
  const selected = agent("alpha", "fallback-id", "2026-09-03T03:00:00Z", {
    title: null,
    model: null,
  });
  const directory = snapshot([selected], key(selected));
  const host = directory.hosts.get("alpha")!;
  host.profile.hostname = null;
  assert.deepEqual(projectAgentHeader(directory, key(selected), null), {
    line1: "alpha · Custom project / fallback-id",
    line2: "",
    status: "ready",
  });
  const usage = usageFixture();
  assert.equal(formatProviderUsage(usage, "codex"), "Weekly 73% remaining");
  assert.equal(formatProviderUsage(usage, "missing"), null);
  usage.providers[0]!.windows[1]!.remainingPct = Number.NaN;
  usage.providers[0]!.windows[1]!.usedPct = 140;
  assert.equal(formatProviderUsage(usage, "codex"), "Daily 45% used");
});

test("header omits every runtime field independently without empty separators", () => {
  const selected = agent("alpha", "a", "2026-09-03T03:00:00Z", {
    model: null,
    thinkingOptionId: null,
    currentModeId: null,
  });
  const directory = snapshot([selected], key(selected));
  const sourceToken = directory.hosts.get("alpha")!.sourceToken!;
  const metadata: AgentRuntimeMetadata = {
    key: key(selected),
    sourceToken,
    revision: 1,
    model: "runtime-model",
    thinkingOptionId: "high",
    thinkingOptionLabel: "High reasoning",
    currentModeId: "plan",
    currentModeLabel: "Plan mode",
    usage: "Weekly 73% remaining",
  };
  for (const missing of ["model", "thinking", "mode", "usage"] as const) {
    const value = {
      ...metadata,
      ...(missing === "model" ? { model: null } : {}),
      ...(missing === "thinking"
        ? { thinkingOptionId: null, thinkingOptionLabel: null }
        : {}),
      ...(missing === "mode"
        ? { currentModeId: null, currentModeLabel: null }
        : {}),
      ...(missing === "usage" ? { usage: null } : {}),
    };
    const line = projectAgentHeader(directory, key(selected), value)!.line2;
    const omitted = {
      model: "runtime-model",
      thinking: "High reasoning",
      mode: "Plan mode",
      usage: "Weekly 73% remaining",
    }[missing];
    assert.equal(line.includes(omitted), false);
    assert.equal(line.includes("undefined"), false);
    assert.equal(line.includes("null"), false);
    assert.equal(line.startsWith(" · ") || line.endsWith(" · "), false);
  }
});

test("runtime metadata projection uses exact mode and thinking labels", () => {
  assert.deepEqual(projectAgentMetadata(paseoAgent("a", "runtime-model")), {
    model: "runtime-model",
    thinkingOptionId: "high",
    thinkingOptionLabel: "High reasoning",
    currentModeId: "plan",
    currentModeLabel: "Plan mode",
  });
  assert.deepEqual(projectAgentMetadata(null), {
    model: null,
    thinkingOptionId: null,
    thinkingOptionLabel: null,
    currentModeId: null,
    currentModeLabel: null,
  });
});

test("metadata controller fences Agent switches and isolates RPC failures", async () => {
  const alpha = agent("alpha", "a", "2026-09-03T03:00:00Z");
  const beta = agent("alpha", "b", "2026-09-03T02:00:00Z");
  const directory = new FakeDirectory(snapshot([alpha, beta], key(alpha)));
  const alphaResult = deferred<PaseoAgent>();
  const betaResult = deferred<PaseoAgent>();
  const runtime = runtimeFixture(
    (agentId) => (agentId === "a" ? alphaResult.promise : betaResult.promise),
    () => Promise.reject(new Error("usage unavailable")),
  );
  const leases = new FakeLeases([lease(runtime)]);
  const controller = new AgentHeaderMetadataController(leases, directory);
  controller.subscribe(() => {
    throw new Error("observer");
  });
  directory.emit(snapshot([alpha, beta], key(beta)));
  alphaResult.resolve(paseoAgent("a", "wrong-model"));
  betaResult.resolve(paseoAgent("b", "right-model"));
  await tick();
  assert.equal(controller.snapshot()?.key.agentId, "b");
  assert.equal(controller.snapshot()?.model, "right-model");
  assert.equal(controller.snapshot()?.usage, null);
  directory.emit(snapshot([], null));
  assert.equal(controller.snapshot(), null);
});

test("metadata controller fences reconnect completions by connection epoch", async () => {
  const selected = agent("alpha", "a", "2026-09-03T03:00:00Z");
  const directory = new FakeDirectory(snapshot([selected], key(selected)));
  const oldResult = deferred<PaseoAgent>();
  const newResult = deferred<PaseoAgent>();
  const oldRuntime = runtimeFixture(
    () => oldResult.promise,
    () => Promise.resolve(usageFixture()),
  );
  const newRuntime = runtimeFixture(
    () => newResult.promise,
    () => Promise.resolve(usageFixture()),
  );
  const leases = new FakeLeases([lease(oldRuntime)]);
  const controller = new AgentHeaderMetadataController(leases, directory);
  directory.emit(snapshot([selected], key(selected), false, 2));
  leases.emit([{ ...lease(newRuntime), connectionEpoch: 2 }]);
  oldResult.resolve(paseoAgent("a", "stale-model"));
  newResult.resolve(paseoAgent("a", "fresh-model"));
  await tick();
  assert.equal(controller.snapshot()?.model, "fresh-model");
  assert.equal(controller.snapshot()?.usage, "Weekly 73% remaining");
});

class FakeDirectory implements AgentDirectorySource, MetadataDirectorySource {
  private listeners = new Set<(value: GlobalAgentDirectorySnapshot) => void>();
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
  selectAgent(selected: AgentKey) {
    this.selections.push(selected);
    this.emit({ ...this.value, current: selected, destination: "agent" });
    return true;
  }
  emit(value: GlobalAgentDirectorySnapshot) {
    this.value = value;
    for (const listener of this.listeners) listener(value);
  }
}

class FakeLeases implements MetadataLeaseSource {
  private listener: HostRuntimeLeaseListener = () => {};
  constructor(private leases: Parameters<HostRuntimeLeaseListener>[0]) {}
  subscribeRuntimeLeases(listener: HostRuntimeLeaseListener) {
    this.listener = listener;
    listener(this.leases);
    return () => {
      this.listener = () => {};
    };
  }
  emit(leases: Parameters<HostRuntimeLeaseListener>[0]) {
    this.leases = leases;
    this.listener(leases);
  }
}

function snapshot(
  agents: DirectoryAgent[],
  current: AgentKey | null,
  secondWorkspace = false,
  connectionEpoch = 1,
  restoring = false,
): GlobalAgentDirectorySnapshot {
  const grouped = new Map<string, DirectoryAgent[]>();
  for (const value of agents)
    grouped.set(value.serverId, [
      ...(grouped.get(value.serverId) ?? []),
      value,
    ]);
  const hosts = new Map<string, HostDirectorySnapshot>();
  for (const [serverId, hostAgents] of grouped) {
    const project: DirectoryProject = {
      serverId,
      projectId: `project-${serverId}`,
      projectKey: `key-${serverId}`,
      displayName: "Project display",
      customName: "Custom project",
      rootPath: "/project",
      kind: "git",
      syncSeq: null,
    };
    const workspace: DirectoryWorkspace = {
      serverId,
      workspaceId: `workspace-${serverId}`,
      projectId: project.projectId,
      projectName: project.displayName,
      name: `workspace-${serverId}`,
      title: null,
      directory: "/workspace",
      kind: "worktree",
      status: "done",
      activityAt: null,
      pinnedAt: null,
      labels: [],
      syncSeq: null,
    };
    const workspaces = new Map([[workspace.workspaceId, workspace]]);
    if (secondWorkspace)
      workspaces.set("workspace-other", {
        ...workspace,
        workspaceId: "workspace-other",
        name: "other",
      });
    hosts.set(serverId, {
      serverId,
      profile: {
        schemaVersion: 1,
        serverId,
        relayEndpoint: "relay.paseo.sh:443",
        useTls: true,
        daemonPublicKey: "public",
        hostname: `host-${serverId}`,
        createdAt: 1,
        updatedAt: 1,
      },
      status: "ready",
      revision: 1,
      sourceToken: { serverId, slotGeneration: 1, connectionEpoch },
      projects: new Map([[project.projectId, project]]),
      workspaces,
      agents: new Map(hostAgents.map((value) => [value.agentId, value])),
      stale: false,
      error: null,
      lastSuccessfulSyncAt: 1,
    });
  }
  return {
    hosts,
    orderedAgents: agents,
    current,
    destination: current ? "agent" : "config",
    restoring,
  };
}

function agent(
  serverId: string,
  agentId: string,
  updatedAt: string,
  overrides: Partial<DirectoryAgent> = {},
): DirectoryAgent {
  return {
    serverId,
    agentId,
    workspaceId: `workspace-${serverId}`,
    projectId: `project-${serverId}`,
    projectKey: `key-${serverId}`,
    projectName: "Project display",
    workspaceName: `workspace-${serverId}`,
    title: agentId,
    provider: "codex",
    model: "gpt-directory",
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
    ...overrides,
  };
}

function key(value: DirectoryAgent): AgentKey {
  return { serverId: value.serverId, agentId: value.agentId };
}

function input(
  control: SemanticInput["control"],
  action: SemanticInput["action"],
  interactionId: number,
): SemanticInput {
  return {
    type: "semantic-input",
    control,
    action,
    interactionId,
    timeMillis: 1,
  };
}

function paseoAgent(agentId: string, model: string): PaseoAgent {
  return {
    agent: {
      id: agentId,
      provider: "codex",
      cwd: "/workspace",
      model,
      thinkingOptionId: "high",
      effectiveThinkingOptionId: "high",
      features: [
        {
          type: "select",
          id: "reasoning",
          label: "Reasoning",
          value: "high",
          options: [{ id: "high", label: "High reasoning" }],
        },
      ],
      createdAt: "2026-09-03T00:00:00Z",
      updatedAt: "2026-09-03T00:00:00Z",
      lastUserMessageAt: null,
      status: "idle",
      activeTurn: null,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: false,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: "plan",
      availableModes: [{ id: "plan", label: "Plan mode" }],
      pendingPermissions: [],
      persistence: null,
      title: agentId,
      labels: {},
    },
    project: null,
  };
}

function usageFixture(): PaseoUsage {
  return {
    requestId: "usage",
    fetchedAt: "2026-09-03T00:00:00Z",
    providers: [
      {
        providerId: "codex",
        displayName: "Codex",
        status: "available",
        planLabel: null,
        windows: [
          { id: "daily", label: "Daily", usedPct: 45 },
          { id: "weekly", label: "Weekly", remainingPct: 73 },
        ],
      },
    ],
  };
}

function runtimeFixture(
  getAgent: (agentId: string) => Promise<PaseoAgent>,
  listUsage: () => Promise<PaseoUsage>,
) {
  return {
    getAgent,
    listUsage,
    getHost: () => null,
    listProjects: async () => ({ requestId: "projects", projects: [] }),
    listWorkspaces: async () => ({
      requestId: "workspaces",
      entries: [],
      emptyProjects: [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    }),
    listAgents: async () => ({
      requestId: "agents",
      entries: [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    }),
    subscribeDirectory: () => () => {},
  };
}

function lease(runtime: ReturnType<typeof runtimeFixture>) {
  return {
    serverId: "alpha",
    slotGeneration: 1,
    connectionEpoch: 1,
    status: "online" as const,
    profile: snapshot(
      [agent("alpha", "a", "2026-09-03T00:00:00Z")],
      null,
    ).hosts.get("alpha")!.profile,
    runtime,
  };
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
