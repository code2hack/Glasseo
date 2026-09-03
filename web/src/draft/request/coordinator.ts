import { sameAgentKey } from "../../directory/normalize";
import type {
  AgentKey,
  GlobalAgentDirectorySnapshot,
} from "../../directory/types";
import type { PaseoPermissionEvent, PaseoRuntime } from "../../paseo/adapter";
import { projectRequest } from "./model";
import type {
  NormalizedRequest,
  RequestAnswerStorage,
  RequestReplicaSnapshot,
} from "./types";

type RequestRuntime = Pick<
  PaseoRuntime,
  "getPermissionSnapshot" | "subscribePermissions"
>;
export type RequestRuntimeLease = Readonly<{
  serverId: string;
  slotGeneration: number;
  connectionEpoch: number;
  status:
    | "restoring"
    | "connecting"
    | "online"
    | "offline"
    | "error"
    | "removing";
  runtime: RequestRuntime;
}>;
export interface RequestLeaseSource {
  subscribeRuntimeLeases(
    listener: (leases: readonly RequestRuntimeLease[]) => void,
  ): () => void;
}
export interface RequestDirectorySource {
  snapshot(): GlobalAgentDirectorySnapshot;
  subscribe(
    listener: (snapshot: GlobalAgentDirectorySnapshot) => void,
  ): () => void;
}

type Source = Readonly<{
  serverId: string;
  slotGeneration: number;
  connectionEpoch: number;
  agentId: string;
}>;

export class RequestReplicaCoordinator {
  private readonly leases = new Map<string, RequestRuntimeLease>();
  private readonly listeners = new Set<
    (snapshot: RequestReplicaSnapshot) => void
  >();
  private current: RequestReplicaSnapshot = {
    key: null,
    status: "idle",
    requests: [],
    authoritative: false,
    revision: 0,
    error: false,
  };
  private directory: GlobalAgentDirectorySnapshot;
  private unsubscribeLease: (() => void) | null = null;
  private unsubscribeDirectory: (() => void) | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private sync: Promise<void> | null = null;
  private activeSource: Source | null = null;

  constructor(
    private readonly leaseSource: RequestLeaseSource,
    private readonly directorySource: RequestDirectorySource,
    private readonly storage: RequestAnswerStorage,
  ) {
    this.directory = directorySource.snapshot();
  }

  start(): void {
    if (this.unsubscribeLease) return;
    this.unsubscribeLease = this.leaseSource.subscribeRuntimeLeases((leases) =>
      this.updateLeases(leases),
    );
    this.unsubscribeDirectory = this.directorySource.subscribe((snapshot) => {
      this.directory = snapshot;
      this.reconcileDirectory();
    });
  }

  snapshot(): RequestReplicaSnapshot {
    return this.current;
  }

  subscribe(listener: (snapshot: RequestReplicaSnapshot) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => this.listeners.delete(listener);
  }

  activate(key: AgentKey | null): Promise<void> {
    if (sameOptionalKey(this.current.key, key))
      return this.sync ?? Promise.resolve();
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.activeSource = null;
    this.current = {
      key: key ? { ...key } : null,
      status: key ? "syncing" : "idle",
      requests: [],
      authoritative: false,
      revision: this.current.revision + 1,
      error: false,
    };
    this.publish();
    return key ? this.beginSync(key) : Promise.resolve();
  }

  dispose(): void {
    this.unsubscribeLease?.();
    this.unsubscribeDirectory?.();
    this.unsubscribeEvents?.();
    this.unsubscribeLease = null;
    this.unsubscribeDirectory = null;
    this.unsubscribeEvents = null;
    this.activeSource = null;
    this.listeners.clear();
    this.leases.clear();
  }

  private updateLeases(leases: readonly RequestRuntimeLease[]): void {
    this.leases.clear();
    leases.forEach((lease) => this.leases.set(lease.serverId, lease));
    const key = this.current.key;
    if (!key) return;
    const lease = this.leases.get(key.serverId);
    if (lease?.status === "online") {
      const source = sourceToken(lease, key.agentId);
      if (
        !sameSource(this.activeSource, source) ||
        this.current.status !== "ready"
      )
        void this.beginSync(key);
      return;
    }
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    this.activeSource = null;
    this.current = {
      ...this.current,
      status: lease?.status === "error" ? "error" : "offline",
      authoritative: false,
      error: lease?.status === "error",
      revision: this.current.revision + 1,
    };
    this.publish();
  }

  private beginSync(key: AgentKey): Promise<void> {
    const lease = this.leases.get(key.serverId);
    if (lease?.status !== "online") {
      this.current = {
        ...this.current,
        status: lease?.status === "error" ? "error" : "offline",
        authoritative: false,
        error: lease?.status === "error",
      };
      this.publish();
      return Promise.resolve();
    }
    const source = sourceToken(lease, key.agentId);
    this.unsubscribeEvents?.();
    this.activeSource = source;
    const buffered: PaseoPermissionEvent[] = [];
    let buffering = true;
    this.unsubscribeEvents = lease.runtime.subscribePermissions((event) => {
      if (!this.isCurrent(source) || event.agentId !== source.agentId) return;
      if (buffering) buffered.push(event);
      else this.applyEvent(source, event);
    });
    this.current = {
      ...this.current,
      status: "syncing",
      authoritative: false,
      error: false,
      revision: this.current.revision + 1,
    };
    this.publish();
    const pending = (async () => {
      try {
        let requests = await lease.runtime.getPermissionSnapshot(key.agentId);
        if (!this.isCurrent(source)) return;
        for (const event of buffered)
          requests = applyPermissionEvent(requests, event);
        buffering = false;
        let projected = requests.map((request) =>
          projectRequest(key.serverId, key.agentId, request),
        );
        const expected = this.authoritativeDirectoryRequestIds(key);
        if (expected && !sameIds(projected, expected)) {
          requests = await lease.runtime.getPermissionSnapshot(key.agentId);
          if (!this.isCurrent(source)) return;
          projected = requests.map((request) =>
            projectRequest(key.serverId, key.agentId, request),
          );
        }
        await this.removeStaleAnswers(this.current.requests, projected);
        if (!this.isCurrent(source)) return;
        const reconciledExpected = this.authoritativeDirectoryRequestIds(key);
        const matched =
          reconciledExpected === null || sameIds(projected, reconciledExpected);
        this.current = {
          key: { ...key },
          status: matched ? "ready" : "error",
          requests: projected,
          authoritative: matched,
          revision: this.current.revision + 1,
          error: !matched,
        };
        this.publish();
      } catch {
        buffering = false;
        if (!this.isCurrent(source)) return;
        this.current = {
          ...this.current,
          status: "error",
          authoritative: false,
          error: true,
          revision: this.current.revision + 1,
        };
        this.publish();
      }
    })();
    this.sync = pending;
    void pending.finally(() => {
      if (this.sync === pending) this.sync = null;
    });
    return pending;
  }

  private applyEvent(source: Source, event: PaseoPermissionEvent): void {
    const requests = applyPermissionEvent(
      this.current.requests.map(({ request }) => request),
      event,
    ).map((request) =>
      projectRequest(source.serverId, source.agentId, request),
    );
    void this.removeStaleAnswers(this.current.requests, requests);
    this.current = {
      ...this.current,
      requests,
      authoritative: true,
      status: "ready",
      revision: this.current.revision + 1,
      error: false,
    };
    this.publish();
    const expected = this.authoritativeDirectoryRequestIds(source);
    if (expected && !sameIds(requests, expected)) void this.beginSync(source);
  }

  private reconcileDirectory(): void {
    const key = this.current.key;
    if (!key) return;
    const host = this.directory.hosts.get(key.serverId);
    if (!host || host.stale) return;
    const expected = this.directoryRequestIds(key);
    if (sameIds(this.current.requests, expected)) return;
    if (expected.length === 0) {
      const removed = this.current.requests;
      this.current = {
        ...this.current,
        requests: [],
        authoritative: true,
        status: "ready",
        revision: this.current.revision + 1,
        error: false,
      };
      void this.removeStaleAnswers(removed, []);
      this.publish();
    } else void this.beginSync(key);
  }

  private directoryRequestIds(key: AgentKey): readonly string[] {
    return (
      this.directory.orderedAgents
        .find((agent) => sameAgentKey(agent, key))
        ?.pendingPermissions.map(({ id }) => id) ?? []
    );
  }

  private authoritativeDirectoryRequestIds(
    key: AgentKey,
  ): readonly string[] | null {
    const host = this.directory.hosts.get(key.serverId);
    return host && !host.stale ? this.directoryRequestIds(key) : null;
  }

  private async removeStaleAnswers(
    previous: readonly NormalizedRequest[],
    next: readonly NormalizedRequest[],
  ): Promise<void> {
    const current = new Map(
      next.map((request) => [request.key.requestId, request]),
    );
    await Promise.allSettled(
      previous
        .filter((request) => {
          const replacement = current.get(request.key.requestId);
          return (
            !replacement || replacement.fingerprint !== request.fingerprint
          );
        })
        .map((request) => this.storage.delete(request.key)),
    );
  }

  private isCurrent(source: Source): boolean {
    const lease = this.leases.get(source.serverId);
    return (
      lease?.status === "online" &&
      sameSource(this.activeSource, source) &&
      lease.slotGeneration === source.slotGeneration &&
      lease.connectionEpoch === source.connectionEpoch &&
      this.current.key?.serverId === source.serverId &&
      this.current.key.agentId === source.agentId
    );
  }

  private publish(): void {
    for (const listener of this.listeners) this.notify(listener);
  }

  private notify(listener: (snapshot: RequestReplicaSnapshot) => void): void {
    try {
      listener(this.current);
    } catch {
      // Listener failure never affects request authority.
    }
  }
}

function sameSource(left: Source | null, right: Source): boolean {
  return (
    left?.serverId === right.serverId &&
    left.slotGeneration === right.slotGeneration &&
    left.connectionEpoch === right.connectionEpoch &&
    left.agentId === right.agentId
  );
}

function applyPermissionEvent(
  requests: readonly import("../../paseo/adapter").PaseoPermissionRequest[],
  event: PaseoPermissionEvent,
): readonly import("../../paseo/adapter").PaseoPermissionRequest[] {
  if (event.type === "resolved")
    return requests.filter(({ id }) => id !== event.requestId);
  const index = requests.findIndex(({ id }) => id === event.request.id);
  return index < 0
    ? [...requests, event.request]
    : requests.map((request, candidate) =>
        candidate === index ? event.request : request,
      );
}

function sourceToken(lease: RequestRuntimeLease, agentId: string): Source {
  return {
    serverId: lease.serverId,
    slotGeneration: lease.slotGeneration,
    connectionEpoch: lease.connectionEpoch,
    agentId,
  };
}

function sameIds(
  requests: readonly NormalizedRequest[],
  expected: readonly string[],
): boolean {
  return (
    requests.length === expected.length &&
    requests.every(({ key }, index) => key.requestId === expected[index])
  );
}

function sameOptionalKey(
  left: AgentKey | null,
  right: AgentKey | null,
): boolean {
  return left === null || right === null
    ? left === right
    : sameAgentKey(left, right);
}
