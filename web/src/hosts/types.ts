import type {
  PaseoConnectionState,
  PaseoHostInfo,
  PaseoDirectoryEvent,
  PaseoRuntime,
  PaseoRuntimeOptions,
} from "../paseo/adapter";
import { validatedRelayConnection } from "./relay";

export const HOST_PROFILE_VERSION = 1 as const;

export type StoredHostProfile = {
  schemaVersion: typeof HOST_PROFILE_VERSION;
  serverId: string;
  relayEndpoint: string;
  useTls: boolean;
  daemonPublicKey: string;
  hostname: string | null;
  createdAt: number;
  updatedAt: number;
};

export type HostConnectionStatus =
  | "restoring"
  | "connecting"
  | "online"
  | "offline"
  | "error"
  | "removing";

export type HostRuntimeSnapshot = {
  profile: StoredHostProfile;
  status: HostConnectionStatus;
  error: HostErrorCode | null;
};

export type HostRegistrySnapshot = {
  hosts: HostRuntimeSnapshot[];
  storageErrors: number;
};

export type HostErrorCode =
  | "invalid_qr"
  | "invalid_offer"
  | "duplicate_host"
  | "conflicting_profile"
  | "identity_mismatch"
  | "unsupported_daemon"
  | "camera_denied"
  | "connection_failure"
  | "storage_error";

export class HostError extends Error {
  constructor(
    public readonly code: HostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostError";
  }
}

export interface HostStorage {
  loadProfiles(): Promise<unknown[]>;
  putProfile(profile: StoredHostProfile): Promise<void>;
  deleteProfile(serverId: string): Promise<void>;
  getClientId(): Promise<string | null>;
  putClientId(clientId: string): Promise<void>;
}

export type HostRuntime = Pick<
  PaseoRuntime,
  "connect" | "close" | "subscribeConnection"
>;
export type HostDirectoryRuntime = Pick<
  PaseoRuntime,
  | "getHost"
  | "listProjects"
  | "listWorkspaces"
  | "listAgents"
  | "subscribeDirectory"
>;
export type HostRuntimeLease = {
  serverId: string;
  slotGeneration: number;
  connectionEpoch: number;
  status: HostConnectionStatus;
  profile: StoredHostProfile;
  runtime: HostDirectoryRuntime;
};
export type HostRuntimeLeaseListener = (
  leases: readonly HostRuntimeLease[],
) => void;
export type HostRuntimeFactory = (options: PaseoRuntimeOptions) => HostRuntime;
export type HostRegistryListener = (snapshot: HostRegistrySnapshot) => void;

export function isHostDirectoryRuntime(
  runtime: HostRuntime,
): runtime is HostRuntime & HostDirectoryRuntime {
  const candidate = runtime as HostRuntime & Partial<HostDirectoryRuntime>;
  return (
    typeof candidate.getHost === "function" &&
    typeof candidate.listProjects === "function" &&
    typeof candidate.listWorkspaces === "function" &&
    typeof candidate.listAgents === "function" &&
    typeof candidate.subscribeDirectory === "function"
  );
}

export type { PaseoDirectoryEvent };

export type HostClock = () => number;

export type PairingCandidate = {
  serverId: string;
  relayEndpoint: string;
  useTls: boolean;
  daemonPublicKey: string;
  relayUrl: string;
};

export function validateStoredHostProfile(value: unknown): StoredHostProfile {
  if (!value || typeof value !== "object") throw invalidProfile();
  const profile = value as Record<string, unknown>;
  if (
    Object.keys(profile).length !== 8 ||
    profile.schemaVersion !== HOST_PROFILE_VERSION ||
    !canonicalNonEmpty(profile.serverId) ||
    !canonicalNonEmpty(profile.relayEndpoint) ||
    typeof profile.useTls !== "boolean" ||
    !canonicalNonEmpty(profile.daemonPublicKey) ||
    (profile.hostname !== null && !canonicalNonEmpty(profile.hostname)) ||
    !validTimestamp(profile.createdAt) ||
    !validTimestamp(profile.updatedAt) ||
    (profile.updatedAt as number) < (profile.createdAt as number)
  ) {
    throw invalidProfile();
  }
  try {
    if (
      validatedRelayConnection(
        profile.relayEndpoint,
        profile.useTls,
        profile.serverId,
      ).endpoint !== profile.relayEndpoint
    )
      throw invalidProfile();
  } catch {
    throw invalidProfile();
  }
  return profile as StoredHostProfile;
}

export function hostStatus(state: PaseoConnectionState): HostConnectionStatus {
  switch (state.status) {
    case "connected":
      return "online";
    case "connecting":
      return "connecting";
    case "idle":
    case "disconnected":
    case "disposed":
      return "offline";
  }
}

export function profileFromAcceptedHost(
  candidate: PairingCandidate,
  host: PaseoHostInfo,
  now: number,
): StoredHostProfile {
  return {
    schemaVersion: HOST_PROFILE_VERSION,
    serverId: candidate.serverId,
    relayEndpoint: candidate.relayEndpoint,
    useTls: candidate.useTls,
    daemonPublicKey: candidate.daemonPublicKey,
    hostname: host.hostname?.trim() || null,
    createdAt: now,
    updatedAt: now,
  };
}

function canonicalNonEmpty(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function invalidProfile(): HostError {
  return new HostError("storage_error", "Stored host profile is invalid");
}
