import type { AgentKey } from "../directory/types";
import { diagnosticHash } from "../app/hash";
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
    focusedRowHash: diagnosticHash(state.focusedRowId),
    focusedRowType: focused?.kind ?? null,
    focusedRowDepth: focused?.depth ?? null,
    visibleRowCount: rowIds.length,
    rowIdHashes: rowIds.map(diagnosticHash),
    expansionCount: state.expandedRowIds.size,
    ...state.projection.counts,
    lastControl: state.lastInput?.control ?? null,
    lastAction: state.lastInput?.action ?? null,
    lastInteractionId: state.lastInteractionId,
    selectedAgentKeyHash: selected
      ? diagnosticHash(`${selected.serverId}\0${selected.agentId}`)
      : null,
    duplicateRowCount: rowIds.length - new Set(rowIds).size,
    renderRevision,
  };
}
