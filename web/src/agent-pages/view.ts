import type { GlobalAgentDirectorySnapshot } from "../directory/types";
import type { DirectoryCoordinator } from "../directory/coordinator";
import type { AgentPagerController, AgentPagerState } from "./pager";
import type { AgentRuntimeMetadata } from "./header";
import type { AgentHeaderMetadataController } from "./headerMetadata";
import { projectAgentHeader } from "./header";

export type HeaderMetadataSource = Pick<
  AgentHeaderMetadataController,
  "snapshot" | "subscribe"
>;
export type DirectoryViewSource = Pick<
  DirectoryCoordinator,
  "snapshot" | "subscribe"
>;

declare global {
  interface Window {
    glasseoDiagnostics?: Readonly<{
      destination: "timeline" | "draft" | "config";
      agentCount: number;
      currentKeyHash: string | null;
      returnKeyHash: string | null;
      headerLine1: string;
      headerLine2: string;
      lastCommand: AgentPagerState["lastCommand"];
      directory: string;
      directorySources: readonly Readonly<{
        serverIdHash: string;
        revision: number;
        status: string;
        stale: boolean;
      }>[];
      metadataSource: Readonly<{
        serverIdHash: string;
        slotGeneration: number;
        connectionEpoch: number;
        revision: number;
      }> | null;
      renderRevision: number;
      stableDom: boolean;
    }>;
  }
}

export class AgentShellView {
  private pagerState: AgentPagerState;
  private directoryState: GlobalAgentDirectorySnapshot;
  private metadataState: AgentRuntimeMetadata | null;
  private readonly unsubscribers: (() => void)[];
  private readonly headerElement = document.createElement("header");
  private readonly first = document.createElement("div");
  private readonly second = document.createElement("div");
  private readonly body = document.createElement("main");
  private readonly heading = document.createElement("h1");
  private readonly placeholder = document.createElement("p");
  private renderRevision = 0;
  private stableDom = true;

  constructor(
    private readonly root: HTMLElement,
    pager: AgentPagerController,
    directory: DirectoryViewSource,
    metadata: HeaderMetadataSource,
  ) {
    this.pagerState = pager.snapshot();
    this.directoryState = directory.snapshot();
    this.metadataState = metadata.snapshot();
    this.headerElement.id = "agent-header";
    this.first.id = "agent-header-line-1";
    this.second.id = "agent-header-line-2";
    this.headerElement.append(this.first, this.second);
    this.body.id = "agent-body";
    this.body.append(this.heading, this.placeholder);
    root.replaceChildren(this.headerElement, this.body);
    this.unsubscribers = [
      pager.subscribe((state) => {
        this.pagerState = state;
        this.render();
      }),
      directory.subscribe((state) => {
        this.directoryState = state;
        this.render();
      }),
      metadata.subscribe((state) => {
        this.metadataState = state;
        this.render();
      }),
    ];
  }

  dispose(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
  }

  render(): void {
    const destination = this.pagerState.destination;
    const header =
      destination.kind === "agent"
        ? projectAgentHeader(
            this.directoryState,
            destination.key,
            this.metadataState,
          )
        : null;
    const line1 = header?.line1 ?? "Glasseo · Config";
    const line2 = header?.line2 ?? directoryStatus(this.directoryState);
    const title =
      destination.kind === "config"
        ? "Config"
        : destination.pane === "draft"
          ? "Draft"
          : "Timeline";
    this.headerElement.dataset.status = header?.status ?? "ready";
    this.headerElement.setAttribute(
      "aria-label",
      [line1, line2].filter(Boolean).join(". "),
    );
    this.first.textContent = line1;
    this.first.title = line1;
    this.second.textContent = line2;
    this.second.title = line2;
    this.body.dataset.destination = title.toLowerCase();
    this.heading.textContent = title;
    this.placeholder.textContent = `${title} content arrives in a later milestone.`;

    const current = this.directoryState.current;
    const returnTo =
      destination.kind === "config" ? destination.returnTo : null;
    this.stableDom &&=
      this.root.firstElementChild === this.headerElement &&
      this.root.lastElementChild === this.body;
    window.glasseoDiagnostics = {
      destination: destination.kind === "config" ? "config" : destination.pane,
      agentCount: this.directoryState.orderedAgents.length,
      currentKeyHash: current
        ? shortHash(`${current.serverId}\0${current.agentId}`)
        : null,
      returnKeyHash: returnTo
        ? shortHash(`${returnTo.serverId}\0${returnTo.agentId}`)
        : null,
      headerLine1: line1,
      headerLine2: line2,
      lastCommand: this.pagerState.lastCommand,
      directory: directoryStatus(this.directoryState),
      directorySources: [...this.directoryState.hosts.values()].map((host) => ({
        serverIdHash: shortHash(host.serverId),
        revision: host.revision,
        status: host.status,
        stale: host.stale,
      })),
      metadataSource: this.metadataState
        ? {
            serverIdHash: shortHash(this.metadataState.sourceToken.serverId),
            slotGeneration: this.metadataState.sourceToken.slotGeneration,
            connectionEpoch: this.metadataState.sourceToken.connectionEpoch,
            revision: this.metadataState.revision,
          }
        : null,
      renderRevision: ++this.renderRevision,
      stableDom: this.stableDom,
    };
  }
}

function directoryStatus(directory: GlobalAgentDirectorySnapshot): string {
  if (directory.hosts.size === 0) return "No paired hosts";
  if ([...directory.hosts.values()].some((host) => host.error))
    return "Directory error";
  if ([...directory.hosts.values()].some((host) => host.stale))
    return "Directory stale";
  return "Directory ready";
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
