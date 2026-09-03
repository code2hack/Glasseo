import type { GlobalAgentDirectorySnapshot } from "../../directory/types";
import type { PairingState } from "../../hosts/pairing";
import type {
  HostRegistrySnapshot,
  HostRuntimeSnapshot,
} from "../../hosts/types";
import type { SemanticInput } from "../../native/semanticInput";
import { ConfigController } from "../controller";
import { ConfigDestinationBody } from "../view";
import { HostCleanupCoordinator } from "./cleanup";
import { HostsConfigController } from "./controller";

declare global {
  interface Window {
    __glasseoConfigHostsAcceptance?: {
      run(): Promise<Readonly<Record<string, unknown>>>;
    };
  }
}

window.__glasseoConfigHostsAcceptance = {
  async run() {
    const root = document.querySelector<HTMLElement>("#agent-body");
    const header = document.querySelector<HTMLElement>("#agent-header");
    if (!root || !header) throw new Error("Application shell missing");
    const registry = new AcceptanceRegistry([
      host("acceptance-alpha", "Alpha"),
      host("acceptance-beta", "Beta"),
    ]);
    const pairing = new AcceptancePairing();
    const cleaned: string[] = [];
    const hosts = new HostsConfigController(
      registry,
      pairing,
      new HostCleanupCoordinator([
        {
          name: "acceptance",
          cleanup: async (operation) => void cleaned.push(operation.serverId),
        },
      ]),
    );
    const directory = new AcceptanceDirectory();
    const controller = new ConfigController(
      directory,
      { load: async () => null, put: async () => {} },
      () => false,
      Date.now,
      [hosts],
    );
    const view = new ConfigDestinationBody(controller);
    root.replaceChildren();
    root.dataset.destination = "config";
    view.mount(root);
    view.update({
      destination: { kind: "config", returnTo: null },
      timeline: null,
    });

    let id = 1;
    const press = async (control: "PRIMARY" | "DOWN") => {
      view.handleInput(input(control, id++));
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    await press("PRIMARY");
    await press("DOWN");
    await press("PRIMARY");
    await press("DOWN");
    await press("PRIMARY");
    await press("DOWN");
    await press("DOWN");
    await press("DOWN");
    const betaBefore = root.querySelector<HTMLElement>(
      '[data-row-hash="' + hashFor(root, "Beta") + '"]',
    );
    await press("PRIMARY");
    const confirmationDefault = root.querySelector(
      ".config-row.focused .config-label",
    )?.textContent;
    await press("DOWN");
    await press("PRIMARY");

    const viewport = root.querySelector<HTMLElement>(".config-viewport")!;
    const body = root.getBoundingClientRect();
    const diagnostics = view.diagnostics();
    const result = {
      width: innerWidth,
      height: innerHeight,
      headerBottom: header.getBoundingClientRect().bottom,
      bodyTop: body.top,
      bodyBottom: body.bottom,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportScrollWidth: viewport.scrollWidth,
      viewportClientWidth: viewport.clientWidth,
      confirmationDefault,
      alphaPresent: root.textContent?.includes("Alpha") ?? true,
      betaUsable:
        root.textContent?.includes("Beta") &&
        betaBefore ===
          root.querySelector<HTMLElement>(
            '[data-row-hash="' + hashFor(root, "Beta") + '"]',
          ),
      cleaned,
      diagnostics,
    };
    view.dispose();
    controller.dispose();
    return result;
  },
};

function hashFor(root: HTMLElement, label: string): string {
  return (
    Array.from(root.querySelectorAll<HTMLElement>(".config-row")).find(
      (row) => row.querySelector(".config-label")?.textContent === label,
    )?.dataset.rowHash ?? "missing"
  );
}

class AcceptanceDirectory {
  private readonly value: GlobalAgentDirectorySnapshot = {
    hosts: new Map(),
    orderedAgents: [],
    current: null,
    destination: "config",
    restoring: false,
  };
  snapshot() {
    return this.value;
  }
  subscribe(listener: (value: GlobalAgentDirectorySnapshot) => void) {
    listener(this.value);
    return () => {};
  }
}

class AcceptanceRegistry {
  private value: HostRegistrySnapshot;
  private cleanupToken: number | null = null;
  private readonly listeners = new Set<(value: HostRegistrySnapshot) => void>();
  constructor(hosts: HostRuntimeSnapshot[]) {
    this.value = { hosts, storageErrors: 0 };
  }
  snapshot() {
    return this.value;
  }
  subscribe(listener: (value: HostRegistrySnapshot) => void) {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }
  async remove(serverId: string, cleanupToken?: number) {
    this.value = {
      ...this.value,
      hosts: this.value.hosts.filter(
        (host) => host.profile.serverId !== serverId,
      ),
    };
    this.cleanupToken = cleanupToken ?? null;
    for (const listener of this.listeners) listener(this.value);
  }
  isCleanupCurrent(serverId: string, token: number) {
    return (
      this.cleanupToken === token &&
      !this.value.hosts.some((host) => host.profile.serverId === serverId)
    );
  }
  completeCleanup(serverId: string, token: number) {
    if (!this.isCleanupCurrent(serverId, token)) return false;
    this.cleanupToken = null;
    return true;
  }
}

class AcceptancePairing {
  snapshot(): PairingState {
    return { status: "idle" };
  }
  subscribe(listener: (state: PairingState) => void) {
    listener(this.snapshot());
    return () => {};
  }
  start() {}
  cancel() {}
}

function host(serverId: string, hostname: string): HostRuntimeSnapshot {
  return {
    profile: {
      schemaVersion: 1,
      serverId,
      relayEndpoint: "redacted.invalid:443",
      useTls: true,
      daemonPublicKey: "redacted",
      hostname,
      createdAt: 1,
      updatedAt: 1,
    },
    status: "online",
    error: null,
  };
}

function input(
  control: "PRIMARY" | "DOWN",
  interactionId: number,
): SemanticInput {
  return {
    type: "semantic-input",
    control,
    action: control === "DOWN" ? "BEGIN" : "SHORT",
    interactionId,
    timeMillis: interactionId,
  };
}
