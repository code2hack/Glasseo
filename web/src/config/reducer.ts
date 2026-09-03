import type {
  AgentKey,
  GlobalAgentDirectorySnapshot,
} from "../directory/types";
import type { SemanticInput } from "../native/semanticInput";
import { projectConfig, WORKSPACES_SECTION_ID } from "./project";
import type { ConfigRowId, ConfigState } from "./types";

export type ConfigTransition = Readonly<{
  state: ConfigState;
  activate: AgentKey | null;
}>;

export function initialConfigState(
  directory: GlobalAgentDirectorySnapshot,
): ConfigState {
  const expandedRowIds = new Set<ConfigRowId>([WORKSPACES_SECTION_ID]);
  return {
    focusedRowId: WORKSPACES_SECTION_ID,
    expandedRowIds,
    projection: projectConfig(directory, expandedRowIds),
    handledInteractionIds: [],
    lastInteractionId: null,
    lastInput: null,
    revision: 0,
  };
}

export function restoreConfigState(
  state: ConfigState,
  directory: GlobalAgentDirectorySnapshot,
  expandedRowIds: readonly ConfigRowId[],
  focusedRowId: ConfigRowId | null,
  revision: number,
): ConfigState {
  let expanded = new Set(expandedRowIds);
  let projection = projectConfig(directory, expanded);
  if (!directory.restoring) {
    expanded = new Set(
      [...expanded].filter((id) => projection.allRows.get(id)?.foldable),
    );
    projection = projectConfig(directory, expanded);
  }
  return {
    ...state,
    expandedRowIds: expanded,
    projection,
    focusedRowId: resolveFocus(state, projection, focusedRowId),
    revision,
  };
}

export function reprojectConfigState(
  state: ConfigState,
  directory: GlobalAgentDirectorySnapshot,
): ConfigState {
  let expanded = state.expandedRowIds;
  let projection = projectConfig(directory, expanded);
  if (!directory.restoring) {
    expanded = new Set(
      [...expanded].filter((id) => projection.allRows.get(id)?.foldable),
    );
    projection = projectConfig(directory, expanded);
  }
  const focusedRowId = resolveFocus(state, projection, state.focusedRowId);
  const changed =
    focusedRowId !== state.focusedRowId ||
    !sameIds(expanded, state.expandedRowIds);
  return {
    ...state,
    expandedRowIds: expanded,
    projection,
    focusedRowId,
    revision: state.revision + (changed ? 1 : 0),
  };
}

function sameIds(
  left: ReadonlySet<ConfigRowId>,
  right: ReadonlySet<ConfigRowId>,
): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

export function reduceConfig(
  state: ConfigState,
  directory: GlobalAgentDirectorySnapshot,
  input: SemanticInput,
): ConfigTransition {
  const directional = input.control === "UP" || input.control === "DOWN";
  if (
    input.action !== (directional ? "BEGIN" : "SHORT") ||
    state.handledInteractionIds.includes(input.interactionId)
  )
    return { state, activate: null };
  if (directional) {
    const index = state.projection.rows.findIndex(
      (row) => row.id === state.focusedRowId,
    );
    const next = Math.max(
      0,
      Math.min(
        state.projection.rows.length - 1,
        index + (input.control === "UP" ? -1 : 1),
      ),
    );
    const focusedRowId =
      state.projection.rows[next]?.id ?? WORKSPACES_SECTION_ID;
    if (focusedRowId === state.focusedRowId)
      return { state: handled(state, input), activate: null };
    return {
      state: handled(
        { ...state, focusedRowId, revision: state.revision + 1 },
        input,
      ),
      activate: null,
    };
  }
  if (input.control !== "PRIMARY") return { state, activate: null };
  const row = state.projection.allRows.get(state.focusedRowId);
  if (!row) return { state, activate: null };
  if (row.agentKey)
    return {
      state: handled(state, input),
      activate: row.agentKey,
    };
  if (!row.foldable) return { state: handled(state, input), activate: null };
  const expanded = new Set(state.expandedRowIds);
  if (expanded.has(row.id)) expanded.delete(row.id);
  else expanded.add(row.id);
  const projection = projectConfig(directory, expanded);
  return {
    state: handled(
      {
        ...state,
        expandedRowIds: expanded,
        projection,
        focusedRowId: row.id,
        revision: state.revision + 1,
      },
      input,
    ),
    activate: null,
  };
}

function resolveFocus(
  previous: ConfigState,
  next: ConfigState["projection"],
  requested: ConfigRowId | null,
): ConfigRowId {
  const visible = new Set(next.rows.map(({ id }) => id));
  if (requested && visible.has(requested)) return requested;
  let ancestor =
    requested && next.allRows.has(requested)
      ? previous.projection.allRows.get(requested)?.parentId
      : null;
  while (ancestor) {
    if (visible.has(ancestor)) return ancestor;
    ancestor = previous.projection.allRows.get(ancestor)?.parentId ?? null;
  }
  const previousIndex = previous.projection.rows.findIndex(
    (row) => row.id === (requested ?? previous.focusedRowId),
  );
  return (
    next.rows[Math.min(Math.max(previousIndex, 0), next.rows.length - 1)]?.id ??
    WORKSPACES_SECTION_ID
  );
}

function handled(state: ConfigState, input: SemanticInput): ConfigState {
  return {
    ...state,
    lastInteractionId: input.interactionId,
    lastInput: {
      control: input.control,
      action: input.action,
      interactionId: input.interactionId,
    },
    handledInteractionIds: [
      ...state.handledInteractionIds.slice(-63),
      input.interactionId,
    ],
  };
}
