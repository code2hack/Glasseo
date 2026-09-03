import { getAgentPlacement } from "../directory/selectors";
import type {
  AgentKey,
  GlobalAgentDirectorySnapshot,
  SourceToken,
} from "../directory/types";

export type AgentRuntimeMetadata = Readonly<{
  key: AgentKey;
  sourceToken: SourceToken;
  revision: number;
  model: string | null;
  thinkingOptionId: string | null;
  thinkingOptionLabel: string | null;
  currentModeId: string | null;
  currentModeLabel: string | null;
  usage: string | null;
}>;

export type AgentHeaderViewModel = Readonly<{
  line1: string;
  line2: string;
  status: "ready" | "stale" | "offline" | "error";
}>;

export function projectAgentHeader(
  directory: GlobalAgentDirectorySnapshot,
  key: AgentKey,
  metadata: AgentRuntimeMetadata | null,
): AgentHeaderViewModel | null {
  const placement = getAgentPlacement(directory, key);
  const host = directory.hosts.get(key.serverId);
  if (!placement || !host) return null;
  const { agent, project, workspace } = placement;
  const hostname = host.profile.hostname?.trim() || key.serverId;
  const projectName =
    project?.customName?.trim() ||
    project?.displayName.trim() ||
    agent.projectName.trim() ||
    agent.projectKey;
  const workspaceName = workspace?.name.trim() || agent.workspaceName?.trim();
  const workspaces = new Set(
    [...host.workspaces.values()]
      .filter((candidate) => candidate.projectId === agent.projectId)
      .map((candidate) => candidate.name.trim())
      .filter(Boolean),
  );
  const title = agent.title?.trim() || agent.agentId;
  const line1 = [
    hostname,
    "·",
    projectName,
    "/",
    ...(workspaceName && workspaces.size > 1 ? [workspaceName, "/"] : []),
    title,
  ].join(" ");

  const current = matches(metadata, key, host.sourceToken) ? metadata : null;
  const thinkingId = current?.thinkingOptionId ?? agent.thinkingOptionId;
  const modeId = current?.currentModeId ?? agent.currentModeId;
  const thinking = current?.thinkingOptionLabel ?? thinkingId;
  const mode =
    current?.currentModeLabel ??
    agent.availableModes.find((candidate) => candidate.id === modeId)?.label ??
    modeId;
  const status = host.error
    ? "error"
    : host.status === "offline"
      ? "offline"
      : host.stale
        ? "stale"
        : "ready";
  const line2 = [
    current?.model ?? agent.model,
    thinking,
    mode,
    current?.usage,
    status === "ready" ? null : status,
  ]
    .filter((value): value is string => !!value?.trim())
    .join(" · ");
  return { line1, line2, status };
}

function matches(
  metadata: AgentRuntimeMetadata | null,
  key: AgentKey,
  sourceToken: SourceToken | null,
): metadata is AgentRuntimeMetadata {
  return (
    !!metadata &&
    !!sourceToken &&
    metadata.key.serverId === key.serverId &&
    metadata.key.agentId === key.agentId &&
    metadata.sourceToken.serverId === sourceToken.serverId &&
    metadata.sourceToken.slotGeneration === sourceToken.slotGeneration &&
    metadata.sourceToken.connectionEpoch === sourceToken.connectionEpoch
  );
}
