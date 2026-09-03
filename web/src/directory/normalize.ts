import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import type {
  PaseoAgentEntry,
  PaseoAgentRecord,
  PaseoProjectRecord,
  PaseoWorkspaceRecord,
} from "../paseo/adapter";
import {
  DIRECTORY_CACHE_VERSION,
  DirectoryError,
  type AgentKey,
  type CachedHostDirectory,
  type DirectoryAgent,
  type DirectoryProject,
  type DirectoryWorkspace,
} from "./types";

export function agentKey(serverId: string, agentId: string): AgentKey {
  return { serverId, agentId };
}

export function compositeKey(serverId: string, id: string): string {
  return JSON.stringify([serverId, id]);
}

export function sameAgentKey(a: AgentKey | null, b: AgentKey | null): boolean {
  return a?.serverId === b?.serverId && a?.agentId === b?.agentId;
}

export function isEligibleAgent(agent: DirectoryAgent): boolean {
  return agent.archivedAt === null && !isDelegatedAgent(agent);
}

export function compareAgents(a: DirectoryAgent, b: DirectoryAgent): number {
  const recency = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return (
    recency ||
    a.serverId.localeCompare(b.serverId) ||
    a.agentId.localeCompare(b.agentId)
  );
}

export function normalizeProject(
  serverId: string,
  project: PaseoProjectRecord,
): DirectoryProject {
  requireId(project.projectId);
  return {
    serverId,
    projectId: project.projectId,
    projectKey: project.projectKey ?? null,
    displayName: project.projectDisplayName,
    customName: project.projectCustomName ?? null,
    rootPath: project.projectRootPath,
    kind: project.projectKind,
    syncSeq: project.syncSeq ?? null,
  };
}

export function normalizeWorkspace(
  serverId: string,
  workspace: PaseoWorkspaceRecord,
): DirectoryWorkspace {
  requireId(workspace.id);
  requireId(workspace.projectId);
  if (workspace.activityAt !== null) requireTimestamp(workspace.activityAt);
  return {
    serverId,
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    projectName: workspace.projectDisplayName,
    name: workspace.name,
    title: workspace.title ?? null,
    directory: workspace.workspaceDirectory,
    kind: workspace.workspaceKind,
    status: workspace.status,
    activityAt: workspace.activityAt,
    pinnedAt: workspace.pinnedAt ?? null,
    labels: workspace.labels ?? [],
    syncSeq: workspace.syncSeq ?? null,
  };
}

export function normalizeAgent(
  serverId: string,
  entry: {
    agent: PaseoAgentRecord;
    project?: PaseoAgentEntry["project"] | null;
    syncSeq?: number;
  },
  projects: ReadonlyMap<string, DirectoryProject>,
  workspaces: ReadonlyMap<string, DirectoryWorkspace>,
  previous?: DirectoryAgent,
): DirectoryAgent {
  const { agent } = entry;
  requireId(agent.id);
  requireTimestamp(agent.createdAt);
  requireTimestamp(agent.updatedAt);
  if (agent.lastUserMessageAt !== null)
    requireTimestamp(agent.lastUserMessageAt);
  if (agent.archivedAt) requireTimestamp(agent.archivedAt);
  const workspace = agent.workspaceId
    ? workspaces.get(agent.workspaceId)
    : undefined;
  const workspaceProject = workspace
    ? projects.get(workspace.projectId)
    : undefined;
  const project = [...projects.values()].find(
    (candidate) => candidate.projectKey === entry.project?.projectKey,
  );
  const placement =
    entry.project ??
    (workspace && workspaceProject?.projectKey
      ? {
          projectKey: workspaceProject.projectKey,
          projectName: workspace.projectName,
          workspaceName: workspace.name,
        }
      : null) ??
    (previous
      ? {
          projectKey: previous.projectKey,
          projectName: previous.projectName,
          workspaceName: previous.workspaceName,
        }
      : null);
  if (!placement)
    throw new DirectoryError("sync_error", "Agent placement is missing");
  return {
    serverId,
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? null,
    projectId:
      workspace?.projectId ?? project?.projectId ?? previous?.projectId ?? null,
    projectKey: placement.projectKey,
    projectName: placement.projectName,
    workspaceName: placement.workspaceName ?? null,
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
    syncSeq: entry.syncSeq ?? null,
  };
}

export function validateAgentKey(value: unknown): AgentKey | null {
  if (!record(value)) return null;
  const keys = Object.keys(value);
  return keys.length === 2 && text(value.serverId) && text(value.agentId)
    ? { serverId: value.serverId, agentId: value.agentId }
    : null;
}

export function validateCachedHostDirectory(
  value: unknown,
  expectedServerId: string,
): CachedHostDirectory {
  if (
    !record(value) ||
    Object.keys(value).length !== 7 ||
    value.schemaVersion !== DIRECTORY_CACHE_VERSION ||
    value.serverId !== expectedServerId ||
    !integer(value.revision) ||
    !integer(value.lastSuccessfulSyncAt) ||
    !Array.isArray(value.projects) ||
    !Array.isArray(value.workspaces) ||
    !Array.isArray(value.agents)
  )
    throw cacheError();
  return {
    schemaVersion: DIRECTORY_CACHE_VERSION,
    serverId: expectedServerId,
    revision: value.revision,
    lastSuccessfulSyncAt: value.lastSuccessfulSyncAt,
    projects: unique(
      value.projects.map((item) => validateProject(item, expectedServerId)),
      (item) => item.projectId,
    ),
    workspaces: unique(
      value.workspaces.map((item) => validateWorkspace(item, expectedServerId)),
      (item) => item.workspaceId,
    ),
    agents: unique(
      value.agents.map((item) => validateAgent(item, expectedServerId)),
      (item) => item.agentId,
    ),
  };
}

function validateProject(value: unknown, serverId: string): DirectoryProject {
  if (
    !record(value) ||
    value.serverId !== serverId ||
    !text(value.projectId) ||
    !(value.projectKey === null || string(value.projectKey)) ||
    !string(value.displayName) ||
    !(value.customName === null || string(value.customName)) ||
    !string(value.rootPath) ||
    !["git", "non_git", "directory"].includes(String(value.kind)) ||
    !sequence(value.syncSeq)
  )
    throw cacheError();
  return value as DirectoryProject;
}

function validateWorkspace(
  value: unknown,
  serverId: string,
): DirectoryWorkspace {
  if (
    !record(value) ||
    value.serverId !== serverId ||
    !text(value.workspaceId) ||
    !text(value.projectId) ||
    !string(value.projectName) ||
    !string(value.name) ||
    !(value.title === null || string(value.title)) ||
    !string(value.directory) ||
    !["directory", "local_checkout", "checkout", "worktree"].includes(
      String(value.kind),
    ) ||
    !text(value.status) ||
    !(value.activityAt === null || timestamp(value.activityAt)) ||
    !(value.pinnedAt === null || timestamp(value.pinnedAt)) ||
    !Array.isArray(value.labels) ||
    !value.labels.every(string) ||
    !sequence(value.syncSeq)
  )
    throw cacheError();
  return value as unknown as DirectoryWorkspace;
}

function validateAgent(value: unknown, serverId: string): DirectoryAgent {
  if (
    !record(value) ||
    value.serverId !== serverId ||
    !text(value.agentId) ||
    !(value.workspaceId === null || text(value.workspaceId)) ||
    !(value.projectId === null || text(value.projectId)) ||
    !string(value.projectKey) ||
    !string(value.projectName) ||
    !(value.workspaceName === null || string(value.workspaceName)) ||
    !(value.title === null || string(value.title)) ||
    !text(value.provider) ||
    !(value.model === null || string(value.model)) ||
    !(value.thinkingOptionId === null || string(value.thinkingOptionId)) ||
    !(value.currentModeId === null || string(value.currentModeId)) ||
    !Array.isArray(value.availableModes) ||
    !value.availableModes.every(mode) ||
    !text(value.status) ||
    !activeTurn(value.activeTurn) ||
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    !(value.lastUserMessageAt === null || timestamp(value.lastUserMessageAt)) ||
    !string(value.cwd) ||
    !stringRecord(value.labels) ||
    !(value.archivedAt === null || timestamp(value.archivedAt)) ||
    !Array.isArray(value.pendingPermissions) ||
    !value.pendingPermissions.every(
      (permission) =>
        record(permission) &&
        Object.keys(permission).length === 5 &&
        text(permission.id) &&
        text(permission.provider) &&
        text(permission.name) &&
        ["tool", "plan", "question", "mode", "other"].includes(
          String(permission.kind),
        ) &&
        (permission.title === null || string(permission.title)),
    ) ||
    !sequence(value.syncSeq)
  )
    throw cacheError();
  return value as unknown as DirectoryAgent;
}

function activeTurn(value: unknown): boolean {
  return (
    value === null ||
    (record(value) &&
      Object.keys(value).length === 2 &&
      text(value.turnId) &&
      (value.startedAt === null || timestamp(value.startedAt)))
  );
}

function mode(value: unknown): boolean {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    text(value.id) &&
    text(value.label)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function timestamp(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sequence(value: unknown): boolean {
  return (
    value === null || (Number.isSafeInteger(value) && (value as number) > 0)
  );
}

function stringRecord(value: unknown): value is Record<string, string> {
  return (
    record(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function cacheError(): DirectoryError {
  return new DirectoryError("cache_error", "Stored host directory is invalid");
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  if (new Set(values.map(key)).size !== values.length) throw cacheError();
  return values;
}

function requireId(value: string): void {
  if (!text(value))
    throw new DirectoryError("sync_error", "Directory identity is invalid");
}

function requireTimestamp(value: string): void {
  if (!timestamp(value))
    throw new DirectoryError("sync_error", "Directory timestamp is invalid");
}

export type { PaseoAgentRecord };
