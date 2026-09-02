import type {
  AgentKey,
  DirectoryAgent,
  DirectoryProject,
  DirectoryWorkspace,
  GlobalAgentDirectorySnapshot,
  HostDirectorySnapshot,
} from "./types";

export function getAgent(
  directory: GlobalAgentDirectorySnapshot,
  key: AgentKey,
): DirectoryAgent | null {
  return directory.hosts.get(key.serverId)?.agents.get(key.agentId) ?? null;
}

export function getAgentPlacement(
  directory: GlobalAgentDirectorySnapshot,
  key: AgentKey,
): {
  agent: DirectoryAgent;
  workspace: DirectoryWorkspace | null;
  project: DirectoryProject | null;
} | null {
  const host = directory.hosts.get(key.serverId);
  const agent = host?.agents.get(key.agentId);
  if (!host || !agent) return null;
  return {
    agent,
    workspace: agent.workspaceId
      ? (host.workspaces.get(agent.workspaceId) ?? null)
      : null,
    project: agent.projectId
      ? (host.projects.get(agent.projectId) ?? null)
      : null,
  };
}

export function getHostname(
  directory: GlobalAgentDirectorySnapshot,
  serverId: string,
): string | null {
  const profile = directory.hosts.get(serverId)?.profile;
  return profile ? (profile.hostname ?? profile.serverId) : null;
}

export function orderedAgentKeys(
  directory: GlobalAgentDirectorySnapshot,
): AgentKey[] {
  return directory.orderedAgents.map(({ serverId, agentId }) => ({
    serverId,
    agentId,
  }));
}

export function currentAgent(
  directory: GlobalAgentDirectorySnapshot,
): DirectoryAgent | null {
  return directory.current ? getAgent(directory, directory.current) : null;
}

export function hostSyncState(
  directory: GlobalAgentDirectorySnapshot,
  serverId: string,
): Pick<HostDirectorySnapshot, "status" | "stale" | "error"> | null {
  const host = directory.hosts.get(serverId);
  return host
    ? { status: host.status, stale: host.stale, error: host.error }
    : null;
}
