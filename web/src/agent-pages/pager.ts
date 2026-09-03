import type {
  AgentKey,
  GlobalAgentDirectorySnapshot,
} from "../directory/types";
import type { DirectoryCoordinator } from "../directory/coordinator";
import type { SemanticInput } from "../native/semanticInput";

export type AgentDestination =
  | { kind: "agent"; key: AgentKey; pane: "timeline" | "draft" }
  | { kind: "config"; returnTo: AgentKey | null };

export type AgentPagerState = Readonly<{
  destination: AgentDestination;
  lastCommand: Pick<
    SemanticInput,
    "control" | "action" | "interactionId"
  > | null;
  handledInteractionIds: readonly number[];
  waitingForRestore: boolean;
}>;

export type PagerTransition = Readonly<{
  state: AgentPagerState;
  select: AgentKey | null;
}>;

export type AgentDirectorySource = Pick<
  DirectoryCoordinator,
  "snapshot" | "subscribe" | "selectAgent"
>;

export function initialPagerState(
  directory: GlobalAgentDirectorySnapshot,
): AgentPagerState {
  return {
    destination: directory.current
      ? { kind: "agent", key: directory.current, pane: "timeline" }
      : { kind: "config", returnTo: null },
    lastCommand: null,
    handledInteractionIds: [],
    waitingForRestore: directory.restoring,
  };
}

export function reconcilePagerState(
  state: AgentPagerState,
  directory: GlobalAgentDirectorySnapshot,
): AgentPagerState {
  if (state.waitingForRestore) {
    if (directory.restoring) return state;
    return {
      ...state,
      waitingForRestore: false,
      destination: directory.current
        ? { kind: "agent", key: directory.current, pane: "timeline" }
        : { kind: "config", returnTo: null },
    };
  }
  if (state.destination.kind === "config") return state;
  if (!directory.current)
    return { ...state, destination: { kind: "config", returnTo: null } };
  const same = sameKey(state.destination.key, directory.current);
  return {
    ...state,
    destination: {
      kind: "agent",
      key: directory.current,
      pane: same ? state.destination.pane : "timeline",
    },
  };
}

export function reduceAgentPager(
  state: AgentPagerState,
  directory: GlobalAgentDirectorySnapshot,
  input: SemanticInput,
): PagerTransition {
  if (
    !["SHORT", "LONG", "DOUBLE"].includes(input.action) ||
    state.handledInteractionIds.includes(input.interactionId)
  )
    return { state, select: null };

  let destination: AgentDestination | null = null;
  let select: AgentKey | null = null;
  const current = state.destination;
  if (
    current.kind === "agent" &&
    current.pane === "timeline" &&
    input.action === "SHORT" &&
    (input.control === "LEFT" || input.control === "RIGHT")
  ) {
    const index = directory.orderedAgents.findIndex((agent) =>
      sameKey(agent, current.key),
    );
    if (index >= 0 && directory.orderedAgents.length > 0) {
      const offset = input.control === "LEFT" ? -1 : 1;
      const agent =
        directory.orderedAgents[
          (index + offset + directory.orderedAgents.length) %
            directory.orderedAgents.length
        ];
      select = { serverId: agent.serverId, agentId: agent.agentId };
      destination = { kind: "agent", key: select, pane: "timeline" };
    }
  } else if (
    current.kind === "agent" &&
    input.control === "COMMAND" &&
    input.action === "SHORT"
  ) {
    destination = {
      ...current,
      pane: current.pane === "timeline" ? "draft" : "timeline",
    };
  } else if (
    current.kind === "agent" &&
    current.pane === "timeline" &&
    input.control === "COMMAND" &&
    input.action === "LONG"
  ) {
    destination = { kind: "config", returnTo: current.key };
  } else if (
    current.kind === "config" &&
    input.control === "COMMAND" &&
    input.action === "SHORT"
  ) {
    const key = eligible(directory, current.returnTo)
      ? current.returnTo
      : directory.current;
    if (key) {
      select = key;
      destination = { kind: "agent", key, pane: "timeline" };
    }
  }
  if (!destination) return { state, select: null };
  return {
    state: {
      destination,
      lastCommand: {
        control: input.control,
        action: input.action,
        interactionId: input.interactionId,
      },
      handledInteractionIds: [
        // ponytail: retain 64 IDs; use a persisted monotonic ledger if native IDs can replay beyond this window.
        ...state.handledInteractionIds.slice(-63),
        input.interactionId,
      ],
      waitingForRestore: state.waitingForRestore,
    },
    select,
  };
}

export function openAgentFromConfig(
  state: AgentPagerState,
  directory: GlobalAgentDirectorySnapshot,
  key: AgentKey,
): PagerTransition {
  if (state.destination.kind !== "config" || !eligible(directory, key))
    return { state, select: null };
  return {
    state: {
      ...state,
      destination: { kind: "agent", key, pane: "timeline" },
    },
    select: key,
  };
}

export class AgentPagerController {
  private stateValue: AgentPagerState;
  private readonly listeners = new Set<(state: AgentPagerState) => void>();
  private readonly unsubscribeDirectory: () => void;

  constructor(private readonly directory: AgentDirectorySource) {
    this.stateValue = initialPagerState(directory.snapshot());
    this.unsubscribeDirectory = directory.subscribe((snapshot) => {
      this.stateValue = reconcilePagerState(this.stateValue, snapshot);
      this.publish();
    });
  }

  snapshot(): AgentPagerState {
    return this.stateValue;
  }

  subscribe(listener: (state: AgentPagerState) => void): () => void {
    this.listeners.add(listener);
    this.notify(listener);
    return () => this.listeners.delete(listener);
  }

  handle(input: SemanticInput): void {
    const transition = reduceAgentPager(
      this.stateValue,
      this.directory.snapshot(),
      input,
    );
    if (transition.state === this.stateValue) return;
    this.stateValue = transition.state;
    if (transition.select) this.directory.selectAgent(transition.select);
    else this.publish();
  }

  openAgent(key: AgentKey): boolean {
    const transition = openAgentFromConfig(
      this.stateValue,
      this.directory.snapshot(),
      key,
    );
    if (!transition.select) return false;
    const previous = this.stateValue;
    this.stateValue = transition.state;
    if (!this.directory.selectAgent(transition.select)) {
      this.stateValue = previous;
      return false;
    }
    return true;
  }

  dispose(): void {
    this.unsubscribeDirectory();
    this.listeners.clear();
  }

  private publish(): void {
    for (const listener of this.listeners) this.notify(listener);
  }

  private notify(listener: (state: AgentPagerState) => void): void {
    try {
      listener(this.stateValue);
    } catch {
      // UI observers cannot affect navigation.
    }
  }
}

function eligible(
  directory: GlobalAgentDirectorySnapshot,
  key: AgentKey | null,
): key is AgentKey {
  return !!key && directory.orderedAgents.some((agent) => sameKey(agent, key));
}

function sameKey(
  left: { serverId: string; agentId: string },
  right: AgentKey,
): boolean {
  return left.serverId === right.serverId && left.agentId === right.agentId;
}
