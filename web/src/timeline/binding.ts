import type { DirectoryCoordinator } from "../directory/coordinator";
import type {
  AgentKey,
  GlobalAgentDirectorySnapshot,
} from "../directory/types";
import type { HostRegistry } from "../hosts/registry";
import type { HostRuntimeLease } from "../hosts/types";
import type { TimelineCoordinator } from "./coordinator";
import { timelineKey } from "./normalize";

type DirectorySource = Pick<DirectoryCoordinator, "snapshot" | "subscribe">;
type LeaseSource = Pick<HostRegistry, "subscribeRuntimeLeases">;

export function bindTimeline(
  coordinator: TimelineCoordinator,
  directory: DirectorySource,
  registry: LeaseSource,
): () => void {
  let leases: readonly HostRuntimeLease[] = [];
  let agents = new Map<string, AgentKey>();
  let hosts = new Set<string>();
  let directorySeen = false;
  let leasesReady = false;
  const pendingAgents = new Map<string, AgentKey>();
  const pendingHosts = new Set<string>();
  const agentJobs = new Set<string>();
  const hostJobs = new Set<string>();

  const cleanAgent = (id: string, key: AgentKey) => {
    if (agentJobs.has(id)) return;
    agentJobs.add(id);
    void coordinator
      .deleteAgent(key)
      .then(() => pendingAgents.delete(id))
      .catch(() => {})
      .finally(() => agentJobs.delete(id));
  };
  const cleanHost = (serverId: string) => {
    if (hostJobs.has(serverId)) return;
    hostJobs.add(serverId);
    void coordinator
      .deleteHost(serverId)
      .then(() => pendingHosts.delete(serverId))
      .catch(() => {})
      .finally(() => hostJobs.delete(serverId));
  };

  const reconcile = (snapshot = directory.snapshot()) => {
    const key = snapshot.current;
    const lease = key
      ? leases.find(
          (candidate) =>
            candidate.serverId === key.serverId &&
            candidate.status === "online",
        )
      : null;
    if (!key || !lease) return coordinator.deactivate();
    void coordinator
      .activate({
        key,
        runtime: lease.runtime,
        sourceToken: {
          serverId: lease.serverId,
          slotGeneration: lease.slotGeneration,
          connectionEpoch: lease.connectionEpoch,
        },
      })
      .catch(() => {});
  };

  const unsubscribeDirectory = directory.subscribe((snapshot) => {
    const next = agentKeys(snapshot);
    if (!snapshot.restoring && directorySeen)
      for (const [id, key] of agents)
        if (!next.has(id)) pendingAgents.set(id, key);
    for (const id of next.keys()) pendingAgents.delete(id);
    agents = next;
    directorySeen = true;
    if (!snapshot.restoring)
      for (const [id, key] of pendingAgents) cleanAgent(id, key);
    reconcile(snapshot);
  });
  const unsubscribeLeases = registry.subscribeRuntimeLeases((next) => {
    const nextHosts = new Set(next.map(({ serverId }) => serverId));
    if (leasesReady)
      for (const serverId of hosts)
        if (!nextHosts.has(serverId)) pendingHosts.add(serverId);
    for (const serverId of nextHosts) pendingHosts.delete(serverId);
    leases = next;
    hosts = nextHosts;
    leasesReady = true;
    for (const serverId of pendingHosts) cleanHost(serverId);
    reconcile();
  });
  return () => {
    unsubscribeDirectory();
    unsubscribeLeases();
    coordinator.deactivate();
  };
}

function agentKeys(
  snapshot: GlobalAgentDirectorySnapshot,
): Map<string, AgentKey> {
  return new Map(
    snapshot.orderedAgents.map(({ serverId, agentId }) => {
      const key = { serverId, agentId };
      return [timelineKey(key), key];
    }),
  );
}
