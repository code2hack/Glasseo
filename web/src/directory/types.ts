import type { StoredHostProfile } from "../hosts/types";

export const DIRECTORY_CACHE_VERSION = 1 as const;

export type AgentKey = Readonly<{ serverId: string; agentId: string }>;
export type SourceToken = Readonly<{
  serverId: string;
  slotGeneration: number;
  connectionEpoch: number;
}>;

export type DirectoryProject = Readonly<{
  serverId: string;
  projectId: string;
  projectKey: string | null;
  displayName: string;
  customName: string | null;
  rootPath: string;
  kind: "git" | "non_git" | "directory";
  syncSeq: number | null;
}>;

export type DirectoryWorkspace = Readonly<{
  serverId: string;
  workspaceId: string;
  projectId: string;
  projectName: string;
  name: string;
  title: string | null;
  directory: string;
  kind: "directory" | "local_checkout" | "checkout" | "worktree";
  status: string;
  activityAt: string | null;
  pinnedAt: string | null;
  labels: readonly string[];
  syncSeq: number | null;
}>;

export type DirectoryAgent = Readonly<{
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  projectId: string | null;
  projectKey: string;
  projectName: string;
  workspaceName: string | null;
  title: string | null;
  provider: string;
  model: string | null;
  status: string;
  activeTurn: { turnId: string; startedAt: string | null } | null;
  createdAt: string;
  updatedAt: string;
  lastUserMessageAt: string | null;
  cwd: string;
  labels: Readonly<Record<string, string>>;
  archivedAt: string | null;
  pendingPermissions: readonly DirectoryPendingPermission[];
  syncSeq: number | null;
}>;

export type DirectoryPendingPermission = Readonly<{
  id: string;
  provider: string;
  name: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title: string | null;
}>;

export type HostDirectoryStatus =
  | "loading"
  | "syncing"
  | "ready"
  | "offline"
  | "error";

export type HostDirectorySnapshot = Readonly<{
  serverId: string;
  profile: StoredHostProfile;
  status: HostDirectoryStatus;
  revision: number;
  sourceToken: SourceToken | null;
  projects: ReadonlyMap<string, DirectoryProject>;
  workspaces: ReadonlyMap<string, DirectoryWorkspace>;
  agents: ReadonlyMap<string, DirectoryAgent>;
  stale: boolean;
  error: DirectoryErrorCode | null;
  lastSuccessfulSyncAt: number | null;
}>;

export type GlobalAgentDirectorySnapshot = Readonly<{
  hosts: ReadonlyMap<string, HostDirectorySnapshot>;
  orderedAgents: readonly DirectoryAgent[];
  current: AgentKey | null;
  destination: "agent" | "config";
}>;

export type CachedHostDirectory = Readonly<{
  schemaVersion: typeof DIRECTORY_CACHE_VERSION;
  serverId: string;
  revision: number;
  lastSuccessfulSyncAt: number;
  projects: readonly DirectoryProject[];
  workspaces: readonly DirectoryWorkspace[];
  agents: readonly DirectoryAgent[];
}>;

export interface DirectoryStorage {
  loadHost(serverId: string): Promise<unknown | null>;
  listHostIds(): Promise<string[]>;
  putHost(directory: CachedHostDirectory): Promise<void>;
  deleteHost(serverId: string): Promise<void>;
  getLastViewedAgent(): Promise<unknown | null>;
  putLastViewedAgent(key: AgentKey | null): Promise<void>;
}

export type DirectoryErrorCode =
  | "cache_error"
  | "pagination_error"
  | "sync_error";

export class DirectoryError extends Error {
  constructor(
    public readonly code: DirectoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DirectoryError";
  }
}
