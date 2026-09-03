import type {
  AgentKey,
  DirectoryAgent,
  DirectoryProject,
  DirectoryWorkspace,
  GlobalAgentDirectorySnapshot,
  HostDirectorySnapshot,
} from "../directory/types";
import type { SemanticInput } from "../native/semanticInput";
import { ConfigController } from "./controller";
import { ConfigDestinationBody } from "./view";

declare global {
  interface Window {
    __glasseoConfigUiAcceptance?: {
      run(): Readonly<Record<string, unknown>>;
    };
  }
}

window.__glasseoConfigUiAcceptance = {
  run() {
    const root = document.querySelector<HTMLElement>("#agent-body");
    const header = document.querySelector<HTMLElement>("#agent-header");
    if (!root || !header) throw new Error("Application shell missing");
    const source = new AcceptanceDirectory(fixture());
    const selected: AgentKey[] = [];
    const controller = new ConfigController(
      source,
      { load: async () => null, put: async () => {} },
      (key) => {
        selected.push(key);
        return true;
      },
    );
    const view = new ConfigDestinationBody(controller);
    root.replaceChildren();
    root.dataset.destination = "config";
    view.mount(root);
    view.update({
      destination: { kind: "config", returnTo: null },
      timeline: null,
    });

    for (const [control, id] of [
      ["DOWN", 1],
      ["PRIMARY", 2],
      ["DOWN", 3],
      ["PRIMARY", 4],
      ["DOWN", 5],
      ["PRIMARY", 6],
      ["DOWN", 7],
    ] as const)
      view.handleInput(input(control, id));
    const stable = root.querySelector(".config-agent");
    source.renameSelectedAgent();
    const stableAfter = root.querySelector(".config-agent");
    view.handleInput(input("PRIMARY", 8));

    const viewport = root.querySelector<HTMLElement>(".config-viewport")!;
    const rootRect = root.getBoundingClientRect();
    const diagnostics = view.diagnostics();
    const result = {
      width: innerWidth,
      height: innerHeight,
      bodyTop: rootRect.top,
      bodyBottom: rootRect.bottom,
      headerBottom: header.getBoundingClientRect().bottom,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportScrollWidth: viewport.scrollWidth,
      viewportClientWidth: viewport.clientWidth,
      stableRow: stable !== null && stable === stableAfter,
      selectedCount: selected.length,
      selectedServer: selected[0]?.serverId,
      selectedAgent: selected[0]?.agentId,
      diagnostics,
    };
    view.dispose();
    controller.dispose();
    return result;
  },
};

class AcceptanceDirectory {
  private readonly listeners = new Set<
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
  renameSelectedAgent(): void {
    const selected = this.value.orderedAgents[0]!;
    const renamed = { ...selected, title: "Renamed Agent" };
    const host = this.value.hosts.get(selected.serverId)!;
    this.value = {
      ...this.value,
      hosts: new Map([
        ...[...this.value.hosts].filter(([id]) => id !== selected.serverId),
        [
          selected.serverId,
          { ...host, agents: new Map([[renamed.agentId, renamed]]) },
        ],
      ]),
      orderedAgents: [renamed, ...this.value.orderedAgents.slice(1)],
    };
    for (const listener of this.listeners) listener(this.value);
  }
}

function fixture(): GlobalAgentDirectorySnapshot {
  const alpha = populatedHost("acceptance-alpha", "Alpha", "worktree");
  const beta = populatedHost("acceptance-beta", "Beta", "directory");
  return {
    hosts: new Map([
      [alpha.host.serverId, alpha.host],
      [beta.host.serverId, beta.host],
    ]),
    orderedAgents: [alpha.agent, beta.agent],
    current: null,
    destination: "config",
    restoring: false,
  };
}

function populatedHost(
  serverId: string,
  hostname: string,
  kind: "directory" | "worktree",
): { host: HostDirectorySnapshot; agent: DirectoryAgent } {
  const projectId = "same-project";
  const workspaceId = "same-workspace";
  const project: DirectoryProject = {
    serverId,
    projectId,
    projectKey: projectId,
    displayName: "Project",
    customName: null,
    rootPath: "/redacted",
    kind: "git",
    syncSeq: null,
  };
  const workspace: DirectoryWorkspace = {
    serverId,
    workspaceId,
    projectId,
    projectName: "Project",
    name: "Workspace",
    title: null,
    directory: "/redacted",
    kind,
    status: "done",
    activityAt: null,
    pinnedAt: null,
    labels: [],
    syncSeq: null,
  };
  const agent: DirectoryAgent = {
    serverId,
    agentId: "shared-agent",
    workspaceId,
    projectId,
    projectKey: projectId,
    projectName: "Project",
    workspaceName: "Workspace",
    title: "Agent",
    provider: "codex",
    model: null,
    thinkingOptionId: null,
    currentModeId: null,
    availableModes: [],
    status: "idle",
    activeTurn: null,
    createdAt: "2026-09-03T00:00:00Z",
    updatedAt: "2026-09-03T01:00:00Z",
    lastUserMessageAt: null,
    cwd: "/redacted",
    labels: {},
    archivedAt: null,
    pendingPermissions: [],
    syncSeq: null,
  };
  return {
    host: {
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
      projects: new Map([[projectId, project]]),
      workspaces: new Map([[workspaceId, workspace]]),
      agents: new Map([[agent.agentId, agent]]),
      stale: false,
      error: null,
      lastSuccessfulSyncAt: 1,
    },
    agent,
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
    timeMillis: interactionId,
  };
}
