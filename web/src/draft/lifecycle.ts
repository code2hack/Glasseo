import type { DirectoryCoordinator } from "../directory/coordinator";
import type {
  AgentKey,
  GlobalAgentDirectorySnapshot,
} from "../directory/types";
import type { HostRegistry } from "../hosts/registry";
import { draftKey } from "./storage";
import type { DraftController } from "./controller";

type DirectorySource = Pick<DirectoryCoordinator, "subscribe">;
type LeaseSource = Pick<HostRegistry, "subscribeRuntimeLeases">;

export function bindDraftLifecycle(
  controller: DraftController,
  directory: DirectorySource,
  registry: LeaseSource,
): () => void {
  let agents = new Map<string, AgentKey>();
  let hosts = new Set<string>();
  let directorySeen = false;
  let leasesSeen = false;
  const restorationBaseline = new Map<string, AgentKey>();
  let disposed = false;
  const pendingAgents = new Map<string, AgentKey>();
  const pendingHosts = new Set<string>();
  const agentJobs = new Set<string>();
  const hostJobs = new Set<string>();

  const cleanAgent = (id: string, key: AgentKey) => {
    if (agentJobs.has(id)) return;
    agentJobs.add(id);
    void controller
      .deleteAgent(key, () => !disposed && pendingAgents.has(id))
      .then(() => pendingAgents.delete(id))
      .catch(() => {})
      .finally(() => agentJobs.delete(id));
  };
  const cleanHost = (serverId: string) => {
    if (hostJobs.has(serverId)) return;
    hostJobs.add(serverId);
    void controller
      .deleteHost(serverId, () => !disposed && pendingHosts.has(serverId))
      .then(() => pendingHosts.delete(serverId))
      .catch(() => {})
      .finally(() => hostJobs.delete(serverId));
  };

  const unsubscribeDirectory = directory.subscribe((snapshot) => {
    const next = agentKeys(snapshot);
    if (snapshot.restoring) {
      for (const [id, key] of agents) restorationBaseline.set(id, key);
      for (const [id, key] of next) restorationBaseline.set(id, key);
      for (const id of next.keys()) pendingAgents.delete(id);
      agents = next;
      directorySeen = true;
      return;
    }
    if (directorySeen)
      for (const [id, key] of restorationBaseline.size
        ? restorationBaseline
        : agents)
        if (!next.has(id)) pendingAgents.set(id, key);
    restorationBaseline.clear();
    for (const id of next.keys()) pendingAgents.delete(id);
    agents = next;
    directorySeen = true;
    for (const [id, key] of pendingAgents) cleanAgent(id, key);
  });
  const unsubscribeLeases = registry.subscribeRuntimeLeases((leases) => {
    const next = new Set(leases.map(({ serverId }) => serverId));
    if (leasesSeen)
      for (const serverId of hosts)
        if (!next.has(serverId)) pendingHosts.add(serverId);
    for (const serverId of next) pendingHosts.delete(serverId);
    hosts = next;
    leasesSeen = true;
    for (const serverId of pendingHosts) cleanHost(serverId);
  });

  return () => {
    disposed = true;
    pendingAgents.clear();
    pendingHosts.clear();
    unsubscribeDirectory();
    unsubscribeLeases();
  };
}

function agentKeys(
  snapshot: GlobalAgentDirectorySnapshot,
): Map<string, AgentKey> {
  return new Map(
    snapshot.orderedAgents.map(({ serverId, agentId }) => {
      const key = { serverId, agentId };
      return [draftKey(key), key];
    }),
  );
}
