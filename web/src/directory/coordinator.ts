import type {
  HostRuntimeLease,
  HostRuntimeLeaseListener,
} from "../hosts/types";
import type {
  PaseoAgentEntry,
  PaseoDirectoryEvent,
  PaseoWorkspaceRecord,
} from "../paseo/adapter";
import {
  agentKey,
  compareAgents,
  isEligibleAgent,
  normalizeAgent,
  normalizeProject,
  normalizeWorkspace,
  sameAgentKey,
  validateAgentKey,
  validateCachedHostDirectory,
} from "./normalize";
import {
  DIRECTORY_CACHE_VERSION,
  DirectoryError,
  type AgentKey,
  type CachedHostDirectory,
  type DirectoryAgent,
  type DirectoryProject,
  type DirectoryStorage,
  type DirectoryWorkspace,
  type GlobalAgentDirectorySnapshot,
  type HostDirectorySnapshot,
  type SourceToken,
} from "./types";

const PAGE_SIZE = 200;

export interface HostRuntimeLeaseSource {
  restore(): Promise<void>;
  subscribeRuntimeLeases(listener: HostRuntimeLeaseListener): () => void;
}

type HostState = {
  snapshot: HostDirectorySnapshot;
  unsubscribe: () => void;
  load: Promise<void>;
  sequences: EntitySequences;
};

export class DirectoryCoordinator {
  private readonly hosts = new Map<string, HostState>();
  private readonly leases = new Map<string, HostRuntimeLease>();
  private readonly listeners = new Set<
    (snapshot: GlobalAgentDirectorySnapshot) => void
  >();
  private readonly syncs = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();
  private unsubscribeLeases: (() => void) | null = null;
  private current: AgentKey | null = null;
  private preferred: AgentKey | null = null;
  private restoring = true;

  constructor(
    private readonly registry: HostRuntimeLeaseSource,
    private readonly storage: DirectoryStorage,
    private readonly clock: () => number = Date.now,
  ) {}

  snapshot(): GlobalAgentDirectorySnapshot {
    const hosts = new Map(
      [...this.hosts].map(([serverId, state]) => [serverId, state.snapshot]),
    );
    const orderedAgents = [...hosts.values()]
      .flatMap((host) => [...host.agents.values()])
      .filter(isEligibleAgent)
      .sort(compareAgents);
    return {
      hosts,
      orderedAgents,
      current: this.current,
      destination: this.current ? "agent" : "config",
      restoring: this.restoring,
    };
  }

  subscribe(
    listener: (snapshot: GlobalAgentDirectorySnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => this.listeners.delete(listener);
  }

  async restore(): Promise<void> {
    if (this.unsubscribeLeases) return;
    try {
      this.preferred = validateAgentKey(
        await this.storage.getLastViewedAgent(),
      );
    } catch {
      this.preferred = null;
    }
    this.unsubscribeLeases = this.registry.subscribeRuntimeLeases((leases) =>
      this.updateLeases(leases),
    );
    await this.registry.restore();
    await Promise.allSettled([...this.hosts.values()].map((host) => host.load));
    await Promise.allSettled([...this.syncs.values()]);
    await this.removeOrphanCaches();
    this.restoring = false;
    this.reconcileSelection();
    this.publish();
  }

  async refresh(serverId: string): Promise<void> {
    const lease = this.leases.get(serverId);
    if (lease?.status !== "online") return;
    await this.syncs.get(serverId);
    if (!this.isCurrent(token(lease))) return;
    await this.startSync(lease, true);
  }

  selectAgent(key: AgentKey): boolean {
    const selected = this.snapshot().orderedAgents.some(
      (agent) =>
        agent.serverId === key.serverId && agent.agentId === key.agentId,
    );
    if (!selected) return false;
    this.current = agentKey(key.serverId, key.agentId);
    this.preferred = null;
    this.persistSelection();
    this.publish();
    return true;
  }

  dispose(): void {
    this.unsubscribeLeases?.();
    this.unsubscribeLeases = null;
    for (const host of this.hosts.values()) host.unsubscribe();
    this.hosts.clear();
    this.leases.clear();
    this.listeners.clear();
  }

  private updateLeases(next: readonly HostRuntimeLease[]): void {
    const nextIds = new Set(next.map((lease) => lease.serverId));
    for (const serverId of this.leases.keys()) {
      if (nextIds.has(serverId)) continue;
      this.leases.delete(serverId);
      const removed = this.hosts.get(serverId);
      removed?.unsubscribe();
      this.hosts.delete(serverId);
      this.queueWrite(serverId, () => this.storage.deleteHost(serverId));
    }

    for (const lease of next) {
      const previous = this.leases.get(lease.serverId);
      this.leases.set(lease.serverId, lease);
      const state = this.ensureHost(lease);
      state.snapshot = { ...state.snapshot, profile: lease.profile };
      if (lease.status === "online") {
        if (!previous || !sameToken(token(previous), token(lease)))
          void this.startSync(lease);
      } else if (
        (lease.status === "removing" || lease.status === "error") &&
        state.snapshot.status === "ready" &&
        sameToken(state.snapshot.sourceToken, token(lease))
      ) {
        // Removal is provisional until #5 drops the lease after persisted deletion.
      } else {
        state.unsubscribe();
        state.unsubscribe = () => {};
        state.snapshot = {
          ...state.snapshot,
          status: lease.status === "error" ? "error" : "offline",
          stale: true,
          error: lease.status === "error" ? "sync_error" : state.snapshot.error,
        };
      }
    }
    if (!this.restoring) this.reconcileSelection();
    this.publish();
  }

  private ensureHost(lease: HostRuntimeLease): HostState {
    const present = this.hosts.get(lease.serverId);
    if (present) return present;
    const state: HostState = {
      snapshot: {
        serverId: lease.serverId,
        profile: lease.profile,
        status: "loading",
        revision: 0,
        sourceToken: null,
        projects: new Map(),
        workspaces: new Map(),
        agents: new Map(),
        stale: true,
        error: null,
        lastSuccessfulSyncAt: null,
      },
      unsubscribe: () => {},
      load: Promise.resolve(),
      sequences: emptySequences(),
    };
    this.hosts.set(lease.serverId, state);
    state.load = this.loadCache(state);
    return state;
  }

  private async loadCache(state: HostState): Promise<void> {
    try {
      const value = await this.storage.loadHost(state.snapshot.serverId);
      if (value === null) return;
      const cached = validateCachedHostDirectory(
        value,
        state.snapshot.serverId,
      );
      state.snapshot = {
        ...state.snapshot,
        revision: cached.revision,
        projects: mapBy(cached.projects, (project) => project.projectId),
        workspaces: mapBy(
          cached.workspaces,
          (workspace) => workspace.workspaceId,
        ),
        agents: mapBy(cached.agents, (agent) => agent.agentId),
        lastSuccessfulSyncAt: cached.lastSuccessfulSyncAt,
        stale: true,
      };
      state.sequences = sequencesFrom(state.snapshot);
    } catch {
      state.snapshot = { ...state.snapshot, error: "cache_error", stale: true };
    }
    this.publish();
  }

  private startSync(lease: HostRuntimeLease, force = false): Promise<void> {
    const state = this.ensureHost(lease);
    const source = token(lease);
    if (!force && sameToken(state.snapshot.sourceToken, source))
      return this.syncs.get(lease.serverId) ?? Promise.resolve();
    state.unsubscribe();
    const buffered: PaseoDirectoryEvent[] = [];
    let buffering = true;
    state.unsubscribe = lease.runtime.subscribeDirectory((event) => {
      if (!this.isCurrent(source)) return;
      if (buffering) buffered.push(event);
      else this.applyLive(state, source, event);
    });
    state.snapshot = {
      ...state.snapshot,
      status: "syncing",
      sourceToken: source,
      stale: true,
      error: null,
    };
    this.publish();
    const sync = (async () => {
      await state.load;
      try {
        const [projectRows, workspaceRows, agentRows] = await Promise.all([
          lease.runtime.listProjects().then((response) => response.projects),
          allWorkspaces(lease),
          allAgents(lease),
        ]);
        if (!this.isCurrent(source)) return;
        const projects = mapSnapshot(
          projectRows.map((project) =>
            normalizeProject(lease.serverId, project),
          ),
          (project) => project.projectId,
        );
        const workspaces = mapSnapshot(
          workspaceRows.map((workspace) =>
            normalizeWorkspace(lease.serverId, workspace),
          ),
          (workspace) => workspace.workspaceId,
        );
        const agents = mapSnapshot(
          agentRows.map((agent) =>
            normalizeAgent(lease.serverId, agent, projects, workspaces),
          ),
          (agent) => agent.agentId,
        );
        const sequences = sequencesFrom({ projects, workspaces, agents });
        let next: MutableDirectory = { projects, workspaces, agents };
        for (const event of buffered)
          next = applyEvent(lease.serverId, next, event, sequences);
        buffering = false;
        if (!this.isCurrent(source)) return;
        state.snapshot = {
          ...state.snapshot,
          status: "ready",
          revision: state.snapshot.revision + 1,
          projects: next.projects,
          workspaces: next.workspaces,
          agents: next.agents,
          stale: false,
          error: null,
          lastSuccessfulSyncAt: this.clock(),
        };
        state.sequences = sequences;
        this.afterMutation(state, source);
      } catch (error) {
        buffering = false;
        if (!this.isCurrent(source)) return;
        state.unsubscribe();
        state.unsubscribe = () => {};
        state.snapshot = {
          ...state.snapshot,
          status: "error",
          stale: true,
          error: error instanceof DirectoryError ? error.code : "sync_error",
        };
        this.publish();
      }
    })();
    this.syncs.set(lease.serverId, sync);
    void sync.finally(() => {
      if (this.syncs.get(lease.serverId) === sync)
        this.syncs.delete(lease.serverId);
    });
    return sync;
  }

  private applyLive(
    state: HostState,
    source: SourceToken,
    event: PaseoDirectoryEvent,
  ): void {
    try {
      const next = applyEvent(
        source.serverId,
        {
          projects: state.snapshot.projects,
          workspaces: state.snapshot.workspaces,
          agents: state.snapshot.agents,
        },
        event,
        state.sequences,
      );
      if (
        next.projects === state.snapshot.projects &&
        next.workspaces === state.snapshot.workspaces &&
        next.agents === state.snapshot.agents
      )
        return;
      state.snapshot = {
        ...state.snapshot,
        revision: state.snapshot.revision + 1,
        projects: next.projects,
        workspaces: next.workspaces,
        agents: next.agents,
        status: "ready",
        stale: false,
        error: null,
        lastSuccessfulSyncAt: this.clock(),
      };
      this.afterMutation(state, source);
    } catch {
      state.snapshot = {
        ...state.snapshot,
        status: "error",
        stale: true,
        error: "sync_error",
      };
      this.publish();
    }
  }

  private afterMutation(state: HostState, source: SourceToken): void {
    if (!this.restoring) this.reconcileSelection();
    const cached = toCache(state.snapshot);
    this.queueWrite(source.serverId, async () => {
      const current = this.hosts.get(source.serverId)?.snapshot;
      if (
        !this.isCurrent(source) ||
        !current ||
        current.revision > cached.revision
      )
        return;
      await this.storage.putHost(cached);
    });
    this.publish();
  }

  private reconcileSelection(): void {
    const agents = this.snapshot().orderedAgents;
    const eligible = (key: AgentKey | null) =>
      key &&
      agents.some(
        (agent) =>
          agent.serverId === key.serverId && agent.agentId === key.agentId,
      );
    const next = eligible(this.current)
      ? this.current
      : eligible(this.preferred)
        ? this.preferred
        : agents[0]
          ? agentKey(agents[0].serverId, agents[0].agentId)
          : null;
    const changed = !sameAgentKey(this.current, next);
    this.current = next;
    if (eligible(this.preferred) || !this.restoring) this.preferred = null;
    if (changed) this.persistSelection();
  }

  private persistSelection(): void {
    const key = this.current;
    this.queueWrite("$selection", () => this.storage.putLastViewedAgent(key));
  }

  private queueWrite(key: string, operation: () => Promise<void>): void {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.writes.set(key, next);
    void next
      .catch(() => {
        const host = this.hosts.get(key);
        if (host) {
          host.snapshot = { ...host.snapshot, error: "cache_error" };
          this.publish();
        }
      })
      .finally(() => {
        if (this.writes.get(key) === next) this.writes.delete(key);
      });
  }

  private async removeOrphanCaches(): Promise<void> {
    let cachedIds: string[];
    try {
      cachedIds = await this.storage.listHostIds();
    } catch {
      return;
    }
    await Promise.allSettled(
      cachedIds
        .filter((serverId) => !this.leases.has(serverId))
        .map((serverId) => this.storage.deleteHost(serverId)),
    );
  }

  private isCurrent(source: SourceToken): boolean {
    const lease = this.leases.get(source.serverId);
    const state = this.hosts.get(source.serverId)?.snapshot;
    return (
      !!lease &&
      sameToken(source, token(lease)) &&
      (lease.status === "online" ||
        ((lease.status === "removing" || lease.status === "error") &&
          state?.status === "ready"))
    );
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) this.notify(listener, snapshot);
  }

  private notify(
    listener: (snapshot: GlobalAgentDirectorySnapshot) => void,
    snapshot = this.snapshot(),
  ): void {
    try {
      listener(snapshot);
    } catch {
      // Directory consumers cannot affect reconciliation.
    }
  }
}

type MutableDirectory = {
  projects: ReadonlyMap<string, DirectoryProject>;
  workspaces: ReadonlyMap<string, DirectoryWorkspace>;
  agents: ReadonlyMap<string, DirectoryAgent>;
};

type EntitySequences = {
  projects: Map<string, number>;
  workspaces: Map<string, number>;
  agents: Map<string, number>;
};

function applyEvent(
  serverId: string,
  current: MutableDirectory,
  event: PaseoDirectoryEvent,
  sequences: EntitySequences,
): MutableDirectory {
  if (event.type === "agent_deleted") {
    sequences.agents.set(event.agentId, Number.MAX_SAFE_INTEGER);
    return removeAgent(current, event.agentId);
  }
  if (event.type === "agent_archived") {
    sequences.agents.set(event.agentId, Number.MAX_SAFE_INTEGER);
    const present = current.agents.get(event.agentId);
    if (!present || present.archivedAt === event.archivedAt) return current;
    return {
      ...current,
      agents: replacing(current.agents, event.agentId, {
        ...present,
        archivedAt: event.archivedAt,
      }),
    };
  }
  if (event.type === "agent_update") {
    const payload = event.payload;
    if (payload.kind === "remove") {
      if (stale(payload.seq, sequences.agents.get(payload.agentId)))
        return current;
      rememberRemoval(sequences.agents, payload.agentId, payload.seq);
      return removeAgent(current, payload.agentId);
    }
    const present = current.agents.get(payload.agent.id);
    if (stale(payload.seq, sequences.agents.get(payload.agent.id)))
      return current;
    remember(sequences.agents, payload.agent.id, payload.seq);
    const agent = normalizeAgent(
      serverId,
      { agent: payload.agent, project: payload.project, syncSeq: payload.seq },
      current.projects,
      current.workspaces,
      present,
    );
    return equal(present, agent)
      ? current
      : { ...current, agents: replacing(current.agents, agent.agentId, agent) };
  }
  if (event.type === "workspace_update") {
    const payload = event.payload;
    if (payload.kind === "upsert") {
      const present = current.workspaces.get(payload.workspace.id);
      if (stale(payload.seq, sequences.workspaces.get(payload.workspace.id)))
        return current;
      remember(sequences.workspaces, payload.workspace.id, payload.seq);
      const workspace = {
        ...normalizeWorkspace(serverId, payload.workspace),
        syncSeq: payload.seq ?? payload.workspace.syncSeq ?? null,
      };
      return equal(present, workspace)
        ? current
        : {
            ...current,
            workspaces: replacing(
              current.workspaces,
              workspace.workspaceId,
              workspace,
            ),
          };
    }
    let projects = current.projects;
    if (stale(payload.seq, sequences.workspaces.get(payload.id)))
      return current;
    rememberRemoval(sequences.workspaces, payload.id, payload.seq);
    let workspaces = removing(current.workspaces, payload.id);
    if (payload.emptyProject) {
      const project = {
        ...normalizeProject(serverId, payload.emptyProject),
        syncSeq: payload.seq ?? payload.emptyProject.syncSeq ?? null,
      };
      const present = projects.get(project.projectId);
      if (!stale(payload.seq, sequences.projects.get(project.projectId))) {
        remember(sequences.projects, project.projectId, payload.seq);
        if (!equal(present, project))
          projects = replacing(projects, project.projectId, project);
      }
    }
    if (payload.removedProjectId) {
      if (
        !stale(payload.seq, sequences.projects.get(payload.removedProjectId))
      ) {
        rememberRemoval(
          sequences.projects,
          payload.removedProjectId,
          payload.seq,
        );
        projects = removing(projects, payload.removedProjectId);
        workspaces = new Map(
          [...workspaces].filter(
            ([, workspace]) => workspace.projectId !== payload.removedProjectId,
          ),
        );
      }
    }
    return projects === current.projects && workspaces === current.workspaces
      ? current
      : { ...current, projects, workspaces };
  }
  const payload = event.payload;
  if (payload.kind === "upsert") {
    const present = current.projects.get(payload.project.projectId);
    if (stale(payload.seq, sequences.projects.get(payload.project.projectId)))
      return current;
    remember(sequences.projects, payload.project.projectId, payload.seq);
    const project = {
      ...normalizeProject(serverId, payload.project),
      syncSeq: payload.seq ?? payload.project.syncSeq ?? null,
    };
    return equal(present, project)
      ? current
      : {
          ...current,
          projects: replacing(current.projects, project.projectId, project),
        };
  }
  if (stale(payload.seq, sequences.projects.get(payload.projectId)))
    return current;
  rememberRemoval(sequences.projects, payload.projectId, payload.seq);
  const projects = removing(current.projects, payload.projectId);
  const workspaces = new Map(
    [...current.workspaces].filter(
      ([, workspace]) => workspace.projectId !== payload.projectId,
    ),
  );
  return projects === current.projects &&
    workspaces.size === current.workspaces.size
    ? current
    : { ...current, projects, workspaces };
}

async function allWorkspaces(
  lease: HostRuntimeLease,
): Promise<PaseoWorkspaceRecord[]> {
  return paginate((cursor) =>
    lease.runtime.listWorkspaces({
      ...(cursor ? {} : { subscribe: {} }),
      page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    }),
  );
}

async function allAgents(lease: HostRuntimeLease): Promise<PaseoAgentEntry[]> {
  return paginate((cursor) =>
    lease.runtime.listAgents({
      sort: [{ key: "updated_at", direction: "desc" }],
      ...(cursor ? {} : { subscribe: {} }),
      page: { limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    }),
  );
}

async function paginate<T>(
  fetch: (cursor: string | null) => Promise<{
    entries: T[];
    pageInfo: { hasMore: boolean; nextCursor: string | null };
  }>,
): Promise<T[]> {
  const entries: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await fetch(cursor);
    entries.push(...page.entries);
    if (!page.pageInfo.hasMore) return entries;
    const next = page.pageInfo.nextCursor;
    if (!next || cursors.has(next))
      throw new DirectoryError(
        "pagination_error",
        "Directory pagination did not advance",
      );
    cursors.add(next);
    cursor = next;
  }
}

function toCache(snapshot: HostDirectorySnapshot): CachedHostDirectory {
  return {
    schemaVersion: DIRECTORY_CACHE_VERSION,
    serverId: snapshot.serverId,
    revision: snapshot.revision,
    lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt ?? 0,
    projects: [...snapshot.projects.values()],
    workspaces: [...snapshot.workspaces.values()],
    agents: [...snapshot.agents.values()],
  };
}

function token(lease: HostRuntimeLease): SourceToken {
  return {
    serverId: lease.serverId,
    slotGeneration: lease.slotGeneration,
    connectionEpoch: lease.connectionEpoch,
  };
}

function sameToken(a: SourceToken | null, b: SourceToken): boolean {
  return (
    a?.serverId === b.serverId &&
    a.slotGeneration === b.slotGeneration &&
    a.connectionEpoch === b.connectionEpoch
  );
}

function mapBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T> {
  return new Map(values.map((value) => [key(value), value]));
}

function mapSnapshot<T extends { syncSeq: number | null }>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    const present = result.get(id);
    if (!present || equal(present, value)) {
      result.set(id, value);
      continue;
    }
    if (present.syncSeq !== null && value.syncSeq !== null) {
      if (value.syncSeq > present.syncSeq) result.set(id, value);
      continue;
    }
    throw new DirectoryError(
      "pagination_error",
      "Directory pages contained conflicting rows",
    );
  }
  return result;
}

function replacing<T>(
  source: ReadonlyMap<string, T>,
  key: string,
  value: T,
): Map<string, T> {
  const copy = new Map(source);
  copy.set(key, value);
  return copy;
}

function removing<T>(
  source: ReadonlyMap<string, T>,
  key: string,
): ReadonlyMap<string, T> {
  if (!source.has(key)) return source;
  const copy = new Map(source);
  copy.delete(key);
  return copy;
}

function removeAgent(current: MutableDirectory, id: string): MutableDirectory {
  const agents = removing(current.agents, id);
  return agents === current.agents ? current : { ...current, agents };
}

function stale(
  incoming: number | undefined,
  current: number | undefined,
): boolean {
  return (
    current !== undefined &&
    ((incoming === undefined && current === Number.MAX_SAFE_INTEGER) ||
      (incoming !== undefined && incoming <= current))
  );
}

function remember(
  target: Map<string, number>,
  id: string,
  seq: number | undefined,
): void {
  if (seq !== undefined) target.set(id, Math.max(target.get(id) ?? 0, seq));
}

function rememberRemoval(
  target: Map<string, number>,
  id: string,
  seq: number | undefined,
): void {
  target.set(id, seq ?? Number.MAX_SAFE_INTEGER);
}

function emptySequences(): EntitySequences {
  return { projects: new Map(), workspaces: new Map(), agents: new Map() };
}

function sequencesFrom(directory: MutableDirectory): EntitySequences {
  const sequences = emptySequences();
  for (const project of directory.projects.values())
    remember(
      sequences.projects,
      project.projectId,
      project.syncSeq ?? undefined,
    );
  for (const workspace of directory.workspaces.values())
    remember(
      sequences.workspaces,
      workspace.workspaceId,
      workspace.syncSeq ?? undefined,
    );
  for (const agent of directory.agents.values())
    remember(sequences.agents, agent.agentId, agent.syncSeq ?? undefined);
  return sequences;
}

function equal(a: unknown, b: unknown): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}
