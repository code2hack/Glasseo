import type {
  DirectoryAgent,
  DirectoryProject,
  DirectoryWorkspace,
  GlobalAgentDirectorySnapshot,
  HostDirectorySnapshot,
} from "../directory/types";
import type { ConfigProjection, ConfigRow, ConfigRowId } from "./types";

export const WORKSPACES_SECTION_ID = rowId("section", "workspaces");
export const HOSTS_SECTION_ID = rowId("section", "hosts");
export const HID_KEYS_SECTION_ID = rowId("section", "hid-keys");

export function rowId(...parts: string[]): ConfigRowId {
  return JSON.stringify(parts);
}

export function projectConfig(
  directory: GlobalAgentDirectorySnapshot,
  expandedRowIds: ReadonlySet<ConfigRowId>,
): ConfigProjection {
  const all: ConfigRow[] = [];
  const section = (id: ConfigRowId, label: string, child: () => void) => {
    add(all, id, null, "section", 0, label, null, true, expandedRowIds);
    child();
  };

  section(WORKSPACES_SECTION_ID, "Workspaces", () => {
    if (directory.hosts.size === 0) {
      add(
        all,
        rowId("empty", "workspaces"),
        WORKSPACES_SECTION_ID,
        "empty",
        1,
        "No paired hosts",
        null,
        false,
        expandedRowIds,
      );
      return;
    }
    for (const host of sortedHosts(directory))
      appendHost(all, host, directory, expandedRowIds);
  });
  section(HOSTS_SECTION_ID, "Hosts", () =>
    add(
      all,
      rowId("placeholder", "hosts"),
      HOSTS_SECTION_ID,
      "placeholder",
      1,
      "Host controls arrive in #11",
      null,
      false,
      expandedRowIds,
    ),
  );
  section(HID_KEYS_SECTION_ID, "HID Keys", () =>
    add(
      all,
      rowId("placeholder", "hid-keys"),
      HID_KEYS_SECTION_ID,
      "placeholder",
      1,
      "HID controls arrive in #12",
      null,
      false,
      expandedRowIds,
    ),
  );

  const byId = new Map(all.map((row) => [row.id, row]));
  const visible = all.filter((row) => visibleFrom(row, byId, expandedRowIds));
  const hosts = [...directory.hosts.values()];
  return {
    rows: visible,
    allRows: byId,
    counts: {
      hosts: hosts.length,
      projects: hosts.reduce((count, host) => count + host.projects.size, 0),
      workspaces: hosts.reduce(
        (count, host) => count + host.workspaces.size,
        0,
      ),
      agents: directory.orderedAgents.length,
      stale: hosts.filter((host) => host.stale).length,
      offline: hosts.filter((host) => host.status === "offline").length,
      errors: hosts.filter((host) => host.status === "error" || host.error)
        .length,
    },
  };
}

export function collapsesWorkspace(
  workspace: DirectoryWorkspace,
  projectWorkspaces: readonly DirectoryWorkspace[],
  hasOtherPlacement = false,
): boolean {
  return (
    projectWorkspaces.length === 1 &&
    !hasOtherPlacement &&
    workspace.kind === "directory" &&
    workspace.labels.length === 0
  );
}

function appendHost(
  rows: ConfigRow[],
  host: HostDirectorySnapshot,
  directory: GlobalAgentDirectorySnapshot,
  expanded: ReadonlySet<ConfigRowId>,
): void {
  const hostId = rowId("host", host.serverId);
  const status = [
    host.stale ? "stale" : null,
    host.status !== "ready" ? host.status : null,
    host.error,
  ]
    .filter(Boolean)
    .join(" · ");
  add(
    rows,
    hostId,
    WORKSPACES_SECTION_ID,
    "host",
    1,
    host.profile.hostname ?? host.serverId,
    status || null,
    true,
    expanded,
  );

  const placedAgents = new Set<string>();
  const projects = [...host.projects.values()].sort(compareProjects);
  for (const project of projects) {
    const projectId = rowId("project", host.serverId, project.projectId);
    add(
      rows,
      projectId,
      hostId,
      "project",
      2,
      project.customName || project.displayName || project.projectId,
      null,
      true,
      expanded,
    );
    const workspaces = [...host.workspaces.values()]
      .filter((workspace) => workspace.projectId === project.projectId)
      .sort(compareWorkspaces);
    const directAgents = orderedAgents(directory, host.serverId).filter(
      (agent) => agent.projectId === project.projectId && !agent.workspaceId,
    );
    for (const agent of directAgents) {
      placedAgents.add(agent.agentId);
      appendAgent(rows, agent, projectId, 3, expanded);
    }
    for (const workspace of workspaces) {
      const agents = orderedAgents(directory, host.serverId).filter(
        (agent) => agent.workspaceId === workspace.workspaceId,
      );
      agents.forEach((agent) => placedAgents.add(agent.agentId));
      if (collapsesWorkspace(workspace, workspaces, directAgents.length > 0)) {
        agents.forEach((agent) =>
          appendAgent(rows, agent, projectId, 3, expanded),
        );
        continue;
      }
      const workspaceId = rowId(
        "workspace",
        host.serverId,
        workspace.workspaceId,
      );
      add(
        rows,
        workspaceId,
        projectId,
        "workspace",
        3,
        workspace.title || workspace.name || workspace.workspaceId,
        workspace.kind === "directory"
          ? null
          : workspace.kind.replace("_", " "),
        true,
        expanded,
      );
      agents.forEach((agent) =>
        appendAgent(rows, agent, workspaceId, 4, expanded),
      );
    }
  }

  const unplaced = orderedAgents(directory, host.serverId).filter(
    (agent) => !placedAgents.has(agent.agentId),
  );
  if (unplaced.length > 0) {
    const fallbackProjectId = rowId("project", host.serverId, "$unplaced");
    add(
      rows,
      fallbackProjectId,
      hostId,
      "project",
      2,
      "Other",
      "Placement unavailable",
      true,
      expanded,
    );
    const fallbackWorkspaceId = rowId("workspace", host.serverId, "$unplaced");
    add(
      rows,
      fallbackWorkspaceId,
      fallbackProjectId,
      "workspace",
      3,
      "Unknown workspace",
      null,
      true,
      expanded,
    );
    unplaced.forEach((agent) =>
      appendAgent(rows, agent, fallbackWorkspaceId, 4, expanded),
    );
  }
}

function appendAgent(
  rows: ConfigRow[],
  agent: DirectoryAgent,
  parentId: ConfigRowId,
  depth: number,
  expanded: ReadonlySet<ConfigRowId>,
): void {
  add(
    rows,
    rowId("agent", agent.serverId, agent.agentId),
    parentId,
    "agent",
    depth,
    agent.title || agent.agentId,
    agent.status,
    false,
    expanded,
    { serverId: agent.serverId, agentId: agent.agentId },
  );
}

function add(
  rows: ConfigRow[],
  id: ConfigRowId,
  parentId: ConfigRowId | null,
  kind: ConfigRow["kind"],
  depth: number,
  label: string,
  detail: string | null,
  foldable: boolean,
  expandedIds: ReadonlySet<ConfigRowId>,
  agentKey: ConfigRow["agentKey"] = null,
): void {
  rows.push({
    id,
    parentId,
    kind,
    depth,
    label,
    detail,
    foldable,
    expanded: foldable && expandedIds.has(id),
    agentKey,
  });
}

function visibleFrom(
  row: ConfigRow,
  rows: ReadonlyMap<ConfigRowId, ConfigRow>,
  expanded: ReadonlySet<ConfigRowId>,
): boolean {
  let parentId = row.parentId;
  while (parentId) {
    if (!expanded.has(parentId)) return false;
    parentId = rows.get(parentId)?.parentId ?? null;
  }
  return true;
}

function sortedHosts(
  directory: GlobalAgentDirectorySnapshot,
): HostDirectorySnapshot[] {
  return [...directory.hosts.values()].sort(
    (a, b) =>
      normalized(a.profile.hostname ?? a.serverId).localeCompare(
        normalized(b.profile.hostname ?? b.serverId),
      ) || a.serverId.localeCompare(b.serverId),
  );
}

function compareProjects(a: DirectoryProject, b: DirectoryProject): number {
  return (
    normalized(a.customName || a.displayName).localeCompare(
      normalized(b.customName || b.displayName),
    ) || a.projectId.localeCompare(b.projectId)
  );
}

function compareWorkspaces(
  a: DirectoryWorkspace,
  b: DirectoryWorkspace,
): number {
  return (
    normalized(a.title || a.name).localeCompare(
      normalized(b.title || b.name),
    ) || a.workspaceId.localeCompare(b.workspaceId)
  );
}

function orderedAgents(
  directory: GlobalAgentDirectorySnapshot,
  serverId: string,
): readonly DirectoryAgent[] {
  return directory.orderedAgents.filter((agent) => agent.serverId === serverId);
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}
