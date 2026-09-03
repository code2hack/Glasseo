import type { PaseoAgent, PaseoUsage } from "../paseo/adapter";
import type { HostRuntimeLease } from "../hosts/types";
import type { HostRegistry } from "../hosts/registry";
import type { DirectoryCoordinator } from "../directory/coordinator";
import type { AgentKey, SourceToken } from "../directory/types";
import type { AgentRuntimeMetadata } from "./header";

export type MetadataLeaseSource = Pick<HostRegistry, "subscribeRuntimeLeases">;
export type MetadataDirectorySource = Pick<
  DirectoryCoordinator,
  "snapshot" | "subscribe"
>;

export class AgentHeaderMetadataController {
  private readonly listeners = new Set<
    (metadata: AgentRuntimeMetadata | null) => void
  >();
  private leases: readonly HostRuntimeLease[] = [];
  private metadata: AgentRuntimeMetadata | null = null;
  private target: { key: AgentKey; sourceToken: SourceToken } | null = null;
  private request = 0;
  private revision = 0;
  private readonly unsubscribeLeases: () => void;
  private readonly unsubscribeDirectory: () => void;

  constructor(
    leaseSource: MetadataLeaseSource,
    private readonly directory: MetadataDirectorySource,
  ) {
    this.unsubscribeLeases = leaseSource.subscribeRuntimeLeases((leases) => {
      this.leases = leases;
      this.refresh();
    });
    this.unsubscribeDirectory = directory.subscribe(() => this.refresh());
  }

  snapshot(): AgentRuntimeMetadata | null {
    return this.metadata;
  }

  subscribe(
    listener: (metadata: AgentRuntimeMetadata | null) => void,
  ): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribeLeases();
    this.unsubscribeDirectory();
    this.target = null;
    this.request++;
    this.listeners.clear();
  }

  private refresh(): void {
    const snapshot = this.directory.snapshot();
    const key = snapshot.current;
    const sourceToken = key
      ? snapshot.hosts.get(key.serverId)?.sourceToken
      : null;
    const lease = key
      ? this.leases.find(
          (candidate) =>
            candidate.serverId === key.serverId &&
            candidate.status === "online" &&
            sameToken(candidate, sourceToken),
        )
      : null;
    if (!key || !sourceToken || !lease) {
      if (this.target === null && this.metadata === null) return;
      this.target = null;
      this.request++;
      this.metadata = null;
      this.publish();
      return;
    }
    if (sameTarget(this.target, key, sourceToken)) return;
    this.target = { key, sourceToken };
    const request = ++this.request;
    this.metadata = emptyMetadata(key, sourceToken, ++this.revision);
    this.publish();
    void lease.runtime
      .getAgent(key.agentId)
      .then((agent) => this.applyAgent(request, agent))
      .catch(() => undefined);
    void lease.runtime
      .listUsage()
      .then((usage) => this.applyUsage(request, key, usage))
      .catch(() => undefined);
  }

  private applyAgent(request: number, agent: PaseoAgent): void {
    if (request !== this.request || !this.metadata) return;
    const snapshot = projectAgentMetadata(agent);
    this.metadata = {
      ...this.metadata,
      ...snapshot,
      revision: ++this.revision,
    };
    this.publish();
  }

  private applyUsage(request: number, key: AgentKey, usage: PaseoUsage): void {
    if (request !== this.request || !this.metadata) return;
    const provider = this.directory
      .snapshot()
      .hosts.get(key.serverId)
      ?.agents.get(key.agentId)?.provider;
    this.metadata = {
      ...this.metadata,
      usage: provider ? formatProviderUsage(usage, provider) : null,
      revision: ++this.revision,
    };
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) this.notify(listener);
  }

  private notify(
    listener: (metadata: AgentRuntimeMetadata | null) => void,
  ): void {
    try {
      listener(this.metadata);
    } catch {
      // Header observers cannot affect runtime fencing.
    }
  }
}

export function projectAgentMetadata(
  agent: PaseoAgent,
): Pick<
  AgentRuntimeMetadata,
  | "model"
  | "thinkingOptionId"
  | "thinkingOptionLabel"
  | "currentModeId"
  | "currentModeLabel"
> {
  if (!agent)
    return {
      model: null,
      thinkingOptionId: null,
      thinkingOptionLabel: null,
      currentModeId: null,
      currentModeLabel: null,
    };
  const value = agent.agent;
  const thinkingOptionId =
    value.effectiveThinkingOptionId ?? value.thinkingOptionId ?? null;
  const thinkingOptionLabel = value.features
    ?.filter((feature) => feature.type === "select")
    .flatMap((feature) => feature.options)
    .find((option) => option.id === thinkingOptionId)?.label;
  return {
    model: value.model,
    thinkingOptionId,
    thinkingOptionLabel: thinkingOptionLabel ?? null,
    currentModeId: value.currentModeId,
    currentModeLabel:
      value.availableModes.find((mode) => mode.id === value.currentModeId)
        ?.label ?? null,
  };
}

export function formatProviderUsage(
  usage: PaseoUsage,
  providerId: string,
): string | null {
  const provider = usage.providers.find(
    (candidate) =>
      candidate.providerId === providerId && candidate.status === "available",
  );
  if (!provider) return null;
  const valid = provider.windows.filter(
    (window) =>
      validPercent(window.remainingPct) || validPercent(window.usedPct),
  );
  const window =
    valid.find((candidate) =>
      /week/i.test(`${candidate.id} ${candidate.label}`),
    ) ?? valid[0];
  if (!window) return null;
  if (validPercent(window.remainingPct))
    return `${window.label} ${Math.round(window.remainingPct)}% remaining`;
  return `${window.label} ${Math.round(window.usedPct as number)}% used`;
}

function emptyMetadata(
  key: AgentKey,
  sourceToken: SourceToken,
  revision: number,
): AgentRuntimeMetadata {
  return {
    key,
    sourceToken,
    revision,
    model: null,
    thinkingOptionId: null,
    thinkingOptionLabel: null,
    currentModeId: null,
    currentModeLabel: null,
    usage: null,
  };
}

function sameToken(
  lease: HostRuntimeLease,
  token: SourceToken | null | undefined,
): boolean {
  return (
    !!token &&
    lease.slotGeneration === token.slotGeneration &&
    lease.connectionEpoch === token.connectionEpoch
  );
}

function sameTarget(
  target: { key: AgentKey; sourceToken: SourceToken } | null,
  key: AgentKey,
  sourceToken: SourceToken,
): boolean {
  return (
    target?.key.serverId === key.serverId &&
    target.key.agentId === key.agentId &&
    target.sourceToken.slotGeneration === sourceToken.slotGeneration &&
    target.sourceToken.connectionEpoch === sourceToken.connectionEpoch
  );
}

function validPercent(value: number | null | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}
