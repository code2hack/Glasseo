import { diagnosticHash } from "../../app/hash";
import type { PairingController, PairingState } from "../../hosts/pairing";
import type { HostRegistry } from "../../hosts/registry";
import type { HostRegistrySnapshot } from "../../hosts/types";
import { HOSTS_SECTION_ID } from "../project";
import type {
  ConfigActionResult,
  ConfigRowAction,
  ConfigRowId,
  ConfigSectionProvider,
} from "../types";
import { HostCleanupCoordinator, HostCleanupError } from "./cleanup";
import {
  ADD_HOST_ROW_ID,
  hostCancelRemovalRowId,
  hostRowId,
  mapHostError,
  projectHosts,
} from "./project";
import type { HostsConfigState } from "./types";

type RegistryPort = Pick<
  HostRegistry,
  "snapshot" | "subscribe" | "remove" | "isCleanupCurrent" | "completeCleanup"
>;
type PairingPort = Pick<
  PairingController,
  "snapshot" | "subscribe" | "start" | "cancel"
>;

export class HostsConfigController implements ConfigSectionProvider {
  readonly sectionId = HOSTS_SECTION_ID;
  private registryValue: HostRegistrySnapshot;
  private pairingValue: PairingState;
  private state: HostsConfigState = {
    confirmingServerId: null,
    removingServerId: null,
    notice: null,
    operationRevision: 0,
    cleanup: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly handled = new Set<number>();
  private readonly unsubscribeRegistry: () => void;
  private readonly unsubscribePairing: () => void;
  private pendingPairing: ((result: ConfigActionResult) => void) | null = null;

  constructor(
    private readonly registry: RegistryPort,
    private readonly pairing: PairingPort,
    private readonly cleanup: HostCleanupCoordinator,
  ) {
    this.registryValue = registry.snapshot();
    this.pairingValue = pairing.snapshot();
    this.unsubscribeRegistry = registry.subscribe((snapshot) => {
      this.registryValue = snapshot;
      if (
        this.state.confirmingServerId &&
        !hasHost(snapshot, this.state.confirmingServerId)
      )
        this.state = { ...this.state, confirmingServerId: null };
      this.publish();
    });
    this.unsubscribePairing = pairing.subscribe((state) => {
      this.pairingValue = state;
      if (state.status === "paired") {
        this.notice(
          `Paired ${displayName(this.registryValue, state.serverId)}`,
        );
        this.finishPairing({
          focusRowId: hostRowId(state.serverId),
          expandRowIds: [HOSTS_SECTION_ID],
        });
      } else if (state.status === "error") {
        this.notice("Pairing failed", mapHostError(state.code));
        this.finishPairing();
      } else if (state.status === "cancelled") {
        this.finishPairing();
      }
      if (state.status !== "paired" && state.status !== "error") this.publish();
    });
  }

  rows(expanded: ReadonlySet<ConfigRowId>) {
    if (
      this.state.confirmingServerId &&
      !expanded.has(hostRowId(this.state.confirmingServerId))
    )
      this.state = { ...this.state, confirmingServerId: null };
    return projectHosts(
      this.registryValue,
      this.pairingValue,
      this.state,
      expanded,
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activate(
    action: ConfigRowAction,
    interactionId: number,
  ): ConfigActionResult | Promise<ConfigActionResult> {
    if (
      action.sectionId !== HOSTS_SECTION_ID ||
      this.handled.has(interactionId)
    )
      return;
    this.handled.add(interactionId);
    if (this.handled.size > 64)
      this.handled.delete(this.handled.values().next().value!);
    switch (action.type) {
      case "add":
        return this.add();
      case "remove":
        return this.confirm(action.targetId);
      case "cancel-removal":
        return this.cancelRemoval(action.targetId);
      case "confirm-removal":
        return this.remove(action.targetId);
      case "retry-cleanup":
        return this.retryCleanup(action.targetId);
      default:
        return;
    }
  }

  deactivate(): void {
    this.pairing.cancel();
    this.finishPairing();
    if (this.state.confirmingServerId) {
      this.state = { ...this.state, confirmingServerId: null };
      this.publish();
    }
  }

  dispose(): void {
    this.deactivate();
    this.unsubscribeRegistry();
    this.unsubscribePairing();
    this.listeners.clear();
  }

  diagnostics() {
    const states = Object.fromEntries(
      [
        "restoring",
        "connecting",
        "online",
        "reconnecting",
        "offline",
        "removing",
        "error",
      ].map((status) => [
        status,
        this.registryValue.hosts.filter((host) => host.status === status)
          .length,
      ]),
    );
    return {
      hostStates: states,
      hostPairingPhase: this.pairingValue.status,
      hostOperationRevision: this.state.operationRevision,
      hostTargetHash: this.state.removingServerId
        ? diagnosticHash(this.state.removingServerId)
        : null,
      hostCleanupCompleted: this.state.cleanup?.completed.length ?? 0,
      hostCleanupFailed: this.state.cleanup?.failed.length ?? 0,
    };
  }

  private add(): Promise<ConfigActionResult> {
    if (this.pendingPairing || this.state.removingServerId)
      return Promise.resolve();
    this.state = { ...this.state, notice: null };
    this.publish();
    const result = new Promise<ConfigActionResult>(
      (resolve) => (this.pendingPairing = resolve),
    );
    this.pairing.start();
    return result;
  }

  private confirm(serverId: string | null): ConfigActionResult {
    if (
      !serverId ||
      this.state.removingServerId ||
      !canRemove(this.registryValue, serverId)
    )
      return;
    this.state = {
      ...this.state,
      confirmingServerId: serverId,
      notice: null,
      operationRevision: this.state.operationRevision + 1,
    };
    this.publish();
    return {
      focusRowId: hostCancelRemovalRowId(serverId),
      expandRowIds: [HOSTS_SECTION_ID, hostRowId(serverId)],
    };
  }

  private cancelRemoval(serverId: string | null): ConfigActionResult {
    if (!serverId || this.state.confirmingServerId !== serverId) return;
    this.state = { ...this.state, confirmingServerId: null };
    this.publish();
    return { focusRowId: hostRowId(serverId) };
  }

  private async remove(serverId: string | null): Promise<ConfigActionResult> {
    if (
      !serverId ||
      this.state.removingServerId ||
      this.state.confirmingServerId !== serverId
    )
      return;
    const revision = this.state.operationRevision + 1;
    this.state = {
      ...this.state,
      confirmingServerId: null,
      removingServerId: serverId,
      notice: null,
      operationRevision: revision,
    };
    this.publish();
    try {
      await this.registry.remove(serverId, revision);
    } catch {
      this.state = { ...this.state, removingServerId: null };
      this.notice("Removal failed", "storage_error");
      return { focusRowId: hostRowId(serverId) };
    }
    if (hasHost(this.registryValue, serverId)) {
      this.state = { ...this.state, removingServerId: null };
      this.notice("Removal failed", "Host is still present");
      return { focusRowId: hostRowId(serverId) };
    }
    return this.finishCleanup(serverId, revision);
  }

  private retryCleanup(serverId: string | null): Promise<ConfigActionResult> {
    if (
      !serverId ||
      this.state.removingServerId !== serverId ||
      this.state.notice?.retryServerId !== serverId ||
      hasHost(this.registryValue, serverId)
    )
      return Promise.resolve();
    const revision = this.state.operationRevision;
    this.state = {
      ...this.state,
      removingServerId: serverId,
      notice: null,
      operationRevision: revision,
    };
    this.publish();
    return this.finishCleanup(serverId, revision);
  }

  private async finishCleanup(
    serverId: string,
    revision: number,
  ): Promise<ConfigActionResult> {
    try {
      const operation = {
        serverId,
        token: revision,
        assertActive: () => {
          if (
            this.state.operationRevision !== revision ||
            this.state.removingServerId !== serverId ||
            !this.registry.isCleanupCurrent(serverId, revision)
          )
            throw new Error("Host cleanup operation is stale");
        },
      };
      const result = await this.cleanup.cleanup(operation);
      if (this.state.operationRevision !== revision) return;
      operation.assertActive();
      if (!this.registry.completeCleanup(serverId, revision))
        throw new Error("Host cleanup operation is stale");
      this.state = { ...this.state, removingServerId: null, cleanup: result };
      this.notice("Host removed");
    } catch (error) {
      if (this.state.operationRevision !== revision) return;
      const result = error instanceof HostCleanupError ? error.result : null;
      this.state = { ...this.state, cleanup: result };
      this.notice(
        "Cleanup failed — retry",
        result?.failed.join(", ") ?? "unknown",
        serverId,
      );
    }
    return { focusRowId: ADD_HOST_ROW_ID, expandRowIds: [HOSTS_SECTION_ID] };
  }

  private notice(
    label: string,
    detail: string | null = null,
    retryServerId: string | null = null,
  ): void {
    this.state = {
      ...this.state,
      notice: {
        revision: this.state.operationRevision,
        label,
        detail,
        retryServerId,
      },
    };
    this.publish();
  }

  private finishPairing(result?: ConfigActionResult): void {
    const finish = this.pendingPairing;
    this.pendingPairing = null;
    finish?.(result);
  }

  private publish(): void {
    for (const listener of this.listeners)
      try {
        listener();
      } catch {
        // Section observers cannot affect host operations.
      }
  }
}

function hasHost(snapshot: HostRegistrySnapshot, serverId: string): boolean {
  return snapshot.hosts.some((host) => host.profile.serverId === serverId);
}

function canRemove(snapshot: HostRegistrySnapshot, serverId: string): boolean {
  const host = snapshot.hosts.find(
    (value) => value.profile.serverId === serverId,
  );
  return !!host && host.status !== "removing";
}

function displayName(snapshot: HostRegistrySnapshot, serverId: string): string {
  const host = snapshot.hosts.find(
    (value) => value.profile.serverId === serverId,
  );
  return host?.profile.hostname ?? "host";
}
