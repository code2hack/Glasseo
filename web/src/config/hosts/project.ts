import type { PairingState } from "../../hosts/pairing";
import type {
  HostErrorCode,
  HostRegistrySnapshot,
  HostRuntimeSnapshot,
} from "../../hosts/types";
import { HOSTS_SECTION_ID, rowId } from "../project";
import type { ConfigRow, ConfigRowId } from "../types";
import type { HostsConfigState } from "./types";

export const hostRowId = (serverId: string) => rowId("hosts", "host", serverId);
export const hostRemoveRowId = (serverId: string) =>
  rowId("hosts", "remove", serverId);
export const hostCancelRemovalRowId = (serverId: string) =>
  rowId("hosts", "cancel-removal", serverId);
export const hostConfirmRemovalRowId = (serverId: string) =>
  rowId("hosts", "confirm-removal", serverId);
export const ADD_HOST_ROW_ID = rowId("hosts", "add");

export function projectHosts(
  registry: HostRegistrySnapshot,
  pairing: PairingState,
  state: HostsConfigState,
  expanded: ReadonlySet<ConfigRowId>,
): readonly ConfigRow[] {
  const rows: ConfigRow[] = [];
  for (const host of [...registry.hosts].sort(compareHosts)) {
    const parentId = hostRowId(host.profile.serverId);
    rows.push(
      row(
        parentId,
        HOSTS_SECTION_ID,
        "host",
        1,
        host.profile.hostname ?? "Unnamed host",
        hostDetail(host),
        true,
        expanded,
      ),
      row(
        rowId("hosts", "status", host.profile.serverId),
        parentId,
        "detail",
        2,
        "Status",
        host.error ? mapHostError(host.error) : host.status,
        false,
        expanded,
      ),
      row(
        rowId("hosts", "paired", host.profile.serverId),
        parentId,
        "detail",
        2,
        "Paired",
        new Date(host.profile.updatedAt).toISOString().slice(0, 10),
        false,
        expanded,
      ),
      row(
        hostRemoveRowId(host.profile.serverId),
        parentId,
        "action",
        2,
        "Remove host",
        host.status === "removing" ? "Removing…" : null,
        false,
        expanded,
        "remove",
        host.profile.serverId,
      ),
    );
    if (state.confirmingServerId === host.profile.serverId)
      rows.push(
        row(
          hostCancelRemovalRowId(host.profile.serverId),
          parentId,
          "action",
          2,
          "Cancel removal",
          "Default",
          false,
          expanded,
          "cancel-removal",
          host.profile.serverId,
        ),
        row(
          hostConfirmRemovalRowId(host.profile.serverId),
          parentId,
          "action",
          2,
          "Confirm removal",
          null,
          false,
          expanded,
          "confirm-removal",
          host.profile.serverId,
        ),
      );
  }
  if (state.notice)
    rows.push(
      row(
        rowId("hosts", "notice", String(state.notice.revision)),
        HOSTS_SECTION_ID,
        state.notice.retryServerId ? "action" : "notice",
        1,
        state.notice.label,
        state.notice.detail,
        false,
        expanded,
        state.notice.retryServerId ? "retry-cleanup" : null,
        state.notice.retryServerId,
      ),
    );
  if (!["idle", "paired", "cancelled"].includes(pairing.status))
    rows.push(
      row(
        rowId("hosts", "pairing-status"),
        HOSTS_SECTION_ID,
        "notice",
        1,
        pairingLabel(pairing),
        pairing.status === "error" ? mapHostError(pairing.code) : null,
        false,
        expanded,
      ),
    );
  rows.push(
    row(
      ADD_HOST_ROW_ID,
      HOSTS_SECTION_ID,
      "action",
      1,
      "+ Add new host",
      state.removingServerId ? "Unavailable during host cleanup" : null,
      false,
      expanded,
      state.removingServerId ? null : "add",
      null,
    ),
  );
  return rows;
}

function row(
  id: ConfigRowId,
  parentId: ConfigRowId,
  kind: ConfigRow["kind"],
  depth: number,
  label: string,
  detail: string | null,
  foldable: boolean,
  expanded: ReadonlySet<ConfigRowId>,
  actionType: string | null = null,
  targetId: string | null = null,
): ConfigRow {
  return {
    id,
    parentId,
    kind,
    depth,
    label,
    detail,
    foldable,
    expanded: foldable && expanded.has(id),
    agentKey: null,
    action: actionType
      ? { sectionId: HOSTS_SECTION_ID, type: actionType, targetId }
      : null,
  };
}

function compareHosts(a: HostRuntimeSnapshot, b: HostRuntimeSnapshot): number {
  return (
    (a.profile.hostname ?? a.profile.serverId).localeCompare(
      b.profile.hostname ?? b.profile.serverId,
      undefined,
      {
        sensitivity: "base",
      },
    ) || a.profile.serverId.localeCompare(b.profile.serverId)
  );
}

function hostDetail(host: HostRuntimeSnapshot): string {
  return host.error
    ? `${host.status} · ${mapHostError(host.error)}`
    : host.status;
}

function pairingLabel(pairing: PairingState): string {
  switch (pairing.status) {
    case "scanning":
      return "Scanning Relay QR…";
    case "validating":
      return "Validating Relay offer…";
    case "connecting":
      return "Connecting and saving…";
    case "error":
      return "Pairing failed";
    default:
      return pairing.status;
  }
}

export function mapHostError(
  code: HostErrorCode | "camera_unavailable" | "decode_error" | "busy",
): string {
  return {
    invalid_qr: "Invalid QR",
    invalid_offer: "Invalid Relay offer",
    duplicate_host: "Host already paired",
    conflicting_profile: "Pairing conflicts with saved host",
    identity_mismatch: "Daemon identity mismatch",
    unsupported_daemon: "Unsupported Paseo daemon",
    camera_denied: "Camera permission denied",
    camera_unavailable: "Camera unavailable",
    decode_error: "QR could not be decoded",
    busy: "Camera busy",
    connection_failure: "Connection failed",
    storage_error: "Storage failed",
  }[code];
}
