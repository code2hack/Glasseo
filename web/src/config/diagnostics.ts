import type { AgentKey } from "../directory/types";
import type { ConfigState } from "./types";

export function configDiagnostics(
  state: ConfigState,
  selected: AgentKey | null = null,
  renderRevision = state.revision,
) {
  const focused = state.projection.allRows.get(state.focusedRowId);
  const rowIds = state.projection.rows.map(({ id }) => id);
  return {
    destination: "config" as const,
    focusedRowHash: hash(state.focusedRowId),
    focusedRowType: focused?.kind ?? null,
    focusedRowDepth: focused?.depth ?? null,
    visibleRowCount: rowIds.length,
    rowIdHashes: rowIds.map(hash),
    expansionCount: state.expandedRowIds.size,
    ...state.projection.counts,
    lastControl: state.lastInput?.control ?? null,
    lastAction: state.lastInput?.action ?? null,
    lastInteractionId: state.lastInteractionId,
    selectedAgentKeyHash: selected
      ? hash(`${selected.serverId}\0${selected.agentId}`)
      : null,
    duplicateRowCount: rowIds.length - new Set(rowIds).size,
    renderRevision,
  };
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
