import { createPaseoRuntime, PaseoRuntimeError } from "../paseo/adapter";
import { buildPairingCandidate, parsePairingOffer } from "./offer";
import {
  HostError,
  hostStatus,
  isHostDirectoryRuntime,
  profileFromAcceptedHost,
  validateStoredHostProfile,
  type HostClock,
  type HostRegistryListener,
  type HostRegistrySnapshot,
  type HostRuntime,
  type HostRuntimeLease,
  type HostRuntimeLeaseListener,
  type HostRuntimeFactory,
  type HostRuntimeSnapshot,
  type HostStorage,
  type PairingCandidate,
  type StoredHostProfile,
} from "./types";

type Slot = HostRuntimeSnapshot & {
  generation: number;
  connectionEpoch: number;
  runtime: HostRuntime;
  unsubscribe: () => void;
};

export class HostRegistry {
  private readonly slots = new Map<string, Slot>();
  private readonly pending = new Map<string, PairingCandidate>();
  private readonly listeners = new Set<HostRegistryListener>();
  private readonly runtimeListeners = new Set<HostRuntimeLeaseListener>();
  private clientId: string | null = null;
  private clientIdPromise: Promise<string> | null = null;
  private storageErrors = 0;
  private generation = 0;
  private loading: Promise<StoredHostProfile[]> | null = null;
  private restoring: Promise<void> | null = null;
  private loadFailed = false;

  constructor(
    private readonly storage: HostStorage,
    private readonly runtimeFactory: HostRuntimeFactory = createPaseoRuntime,
    private readonly clock: HostClock = Date.now,
  ) {}

  snapshot(): HostRegistrySnapshot {
    return {
      hosts: [...this.slots.values()]
        .map(({ profile, status, error }) => ({ profile, status, error }))
        .sort((a, b) => a.profile.serverId.localeCompare(b.profile.serverId)),
      storageErrors: this.storageErrors,
    };
  }

  subscribe(listener: HostRegistryListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.snapshot());
    } catch {
      // Subscribers cannot affect registry control flow.
    }
    return () => this.listeners.delete(listener);
  }

  subscribeRuntimeLeases(listener: HostRuntimeLeaseListener): () => void {
    this.runtimeListeners.add(listener);
    this.notifyRuntimeListener(listener);
    return () => this.runtimeListeners.delete(listener);
  }

  restore(): Promise<void> {
    if (!this.restoring) {
      this.restoring = this.restoreOnce();
    }
    return this.restoring;
  }

  private async restoreOnce(): Promise<void> {
    const installed = await this.ensureLoaded();
    await Promise.allSettled(
      installed.map((profile) => this.connectInstalled(profile.serverId)),
    );
  }

  private ensureLoaded(): Promise<StoredHostProfile[]> {
    if (!this.loading) this.loading = this.loadProfiles();
    return this.loading;
  }

  private async loadProfiles(): Promise<StoredHostProfile[]> {
    let records: unknown[];
    try {
      [records] = await Promise.all([
        this.storage.loadProfiles(),
        this.ensureClientId(),
      ]);
    } catch {
      this.loadFailed = true;
      this.storageErrors++;
      this.publish();
      return [];
    }
    const profiles: StoredHostProfile[] = [];
    for (const record of records) {
      try {
        profiles.push(validateStoredHostProfile(record));
      } catch {
        this.storageErrors++;
      }
    }
    const installed: StoredHostProfile[] = [];
    for (const profile of profiles) {
      try {
        this.install(profile, "restoring");
        installed.push(profile);
      } catch {
        this.storageErrors++;
      }
    }
    this.publish();
    return installed;
  }

  async add(scannedValue: string): Promise<StoredHostProfile> {
    return this.addCandidate(parsePairingOffer(scannedValue));
  }

  async addCandidate(candidate: PairingCandidate): Promise<StoredHostProfile> {
    await this.ensureLoaded();
    if (this.loadFailed)
      throw new HostError("storage_error", "Saved hosts could not be loaded");
    this.rejectDuplicate(candidate);
    this.pending.set(candidate.serverId, candidate);
    let runtime: HostRuntime | null = null;
    try {
      runtime = this.createRuntime(candidate);
      const host = await runtime.connect();
      const profile = profileFromAcceptedHost(candidate, host, this.clock());
      try {
        await this.storage.putProfile(profile);
      } catch {
        throw new HostError("storage_error", "Could not save host profile");
      }
      this.install(profile, "online", runtime);
      this.publish();
      return profile;
    } catch (error) {
      await runtime?.close().catch(() => undefined);
      throw mapRuntimeError(error);
    } finally {
      this.pending.delete(candidate.serverId);
    }
  }

  async remove(serverId: string): Promise<void> {
    const slot = this.slots.get(serverId);
    if (!slot) return;
    slot.status = "removing";
    slot.error = null;
    this.publish();
    try {
      await this.storage.deleteProfile(serverId);
    } catch {
      slot.status = "error";
      slot.error = "storage_error";
      this.publish();
      throw new HostError("storage_error", "Could not remove saved host");
    }
    slot.generation = ++this.generation;
    this.slots.delete(serverId);
    slot.unsubscribe();
    await slot.runtime.close().catch(() => undefined);
    this.publish();
  }

  private async ensureClientId(): Promise<string> {
    if (this.clientId) return this.clientId;
    if (this.clientIdPromise) return this.clientIdPromise;
    this.clientIdPromise = this.loadOrCreateClientId();
    try {
      return await this.clientIdPromise;
    } finally {
      this.clientIdPromise = null;
    }
  }

  private async loadOrCreateClientId(): Promise<string> {
    const stored = await this.storage.getClientId();
    if (stored) return (this.clientId = stored);
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const created = [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await this.storage.putClientId(created);
    return (this.clientId = created);
  }

  private createRuntime(candidate: PairingCandidate): HostRuntime {
    if (!this.clientId)
      throw new HostError("storage_error", "Host registry is not restored");
    return this.runtimeFactory({
      relayUrl: candidate.relayUrl,
      expectedServerId: candidate.serverId,
      daemonPublicKey: candidate.daemonPublicKey,
      clientId: this.clientId,
    });
  }

  private install(
    profile: StoredHostProfile,
    status: HostRuntimeSnapshot["status"],
    acceptedRuntime?: HostRuntime,
  ): Slot {
    const candidate = candidateFromProfile(profile);
    const runtime = acceptedRuntime ?? this.createRuntime(candidate);
    const generation = ++this.generation;
    const slot: Slot = {
      profile,
      status,
      error: null,
      generation,
      connectionEpoch: status === "online" ? 1 : 0,
      runtime,
      unsubscribe: () => {},
    };
    slot.unsubscribe = runtime.subscribeConnection((state) => {
      if (this.slots.get(profile.serverId)?.generation !== generation) return;
      const nextStatus = hostStatus(state);
      if (nextStatus === "online" && slot.status !== "online")
        slot.connectionEpoch++;
      slot.status = nextStatus;
      slot.error = null;
      this.publish();
    });
    this.slots.set(profile.serverId, slot);
    return slot;
  }

  private async connectInstalled(serverId: string): Promise<void> {
    const slot = this.slots.get(serverId);
    if (!slot) return;
    slot.status = "connecting";
    this.publish();
    try {
      await slot.runtime.connect();
      if (this.slots.get(serverId)?.generation === slot.generation) {
        slot.status = "online";
        this.publish();
      }
    } catch (error) {
      if (this.slots.get(serverId)?.generation === slot.generation) {
        slot.status = "error";
        slot.error = mapRuntimeError(error).code;
        this.publish();
      }
    }
  }

  private rejectDuplicate(candidate: PairingCandidate): void {
    const pending = this.pending.get(candidate.serverId);
    const existing = this.slots.get(candidate.serverId)?.profile ?? pending;
    if (!existing) return;
    const identical =
      existing.relayEndpoint === candidate.relayEndpoint &&
      existing.useTls === candidate.useTls &&
      existing.daemonPublicKey === candidate.daemonPublicKey;
    throw new HostError(
      identical ? "duplicate_host" : "conflicting_profile",
      identical
        ? "Host is already paired"
        : "Host pairing conflicts with the saved profile",
    );
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Subscribers cannot affect registry control flow.
      }
    }
    for (const listener of this.runtimeListeners)
      this.notifyRuntimeListener(listener);
  }

  private notifyRuntimeListener(listener: HostRuntimeLeaseListener): void {
    const leases: HostRuntimeLease[] = [];
    for (const [serverId, slot] of this.slots) {
      if (!isHostDirectoryRuntime(slot.runtime)) continue;
      leases.push({
        serverId,
        slotGeneration: slot.generation,
        connectionEpoch: slot.connectionEpoch,
        status: slot.status,
        profile: slot.profile,
        runtime: slot.runtime,
      });
    }
    leases.sort((a, b) => a.serverId.localeCompare(b.serverId));
    try {
      listener(leases);
    } catch {
      // Trusted runtime consumers remain isolated from registry ownership.
    }
  }
}

function candidateFromProfile(profile: StoredHostProfile): PairingCandidate {
  return buildPairingCandidate({
    serverId: profile.serverId,
    relayEndpoint: profile.relayEndpoint,
    useTls: profile.useTls,
    daemonPublicKey: profile.daemonPublicKey,
  });
}

function mapRuntimeError(error: unknown): HostError {
  if (error instanceof HostError) return error;
  if (error instanceof PaseoRuntimeError) {
    if (error.code === "wrong_daemon")
      return new HostError("identity_mismatch", error.message);
    if (
      error.code === "unsupported_daemon" ||
      error.code === "unverified_version"
    )
      return new HostError("unsupported_daemon", error.message);
  }
  return new HostError("connection_failure", "Could not connect to Paseo host");
}
