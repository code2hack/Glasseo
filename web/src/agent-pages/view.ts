import type { GlobalAgentDirectorySnapshot } from "../directory/types";
import type { DirectoryCoordinator } from "../directory/coordinator";
import type { AgentPagerController, AgentPagerState } from "./pager";
import type { AgentRuntimeMetadata } from "./header";
import type { AgentHeaderMetadataController } from "./headerMetadata";
import { projectAgentHeader } from "./header";
import {
  DestinationHost,
  PlaceholderDestinationBody,
  type DestinationBodyFactories,
} from "../app/destinationHost";
import type { TimelineCoordinator } from "../timeline/coordinator";
import {
  TimelineDestinationBody,
  type TimelineDiagnostics,
} from "../timeline/view";
import { diagnosticHash } from "../app/hash";
import type { ConfigDiagnostics } from "../config/view";

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
      rendererLossCount: number;
      timeline: TimelineDiagnostics | null;
      config: ConfigDiagnostics | null;
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
  private readonly destinationHost: DestinationHost;
  private timelineBody: TimelineDestinationBody | null = null;
  private renderRevision = 0;
  private stableDom = true;

  constructor(
    private readonly root: HTMLElement,
    pager: AgentPagerController,
    directory: DirectoryViewSource,
    metadata: HeaderMetadataSource,
    private readonly timeline: TimelineCoordinator,
    factories: Partial<DestinationBodyFactories> = {},
  ) {
    this.pagerState = pager.snapshot();
    this.directoryState = directory.snapshot();
    this.metadataState = metadata.snapshot();
    this.headerElement.id = "agent-header";
    this.first.id = "agent-header-line-1";
    this.second.id = "agent-header-line-2";
    this.headerElement.append(this.first, this.second);
    this.body.id = "agent-body";
    const viewports = new Map();
    this.destinationHost = new DestinationHost(this.body, {
      timeline:
        factories.timeline ??
        (() => {
          this.timelineBody = new TimelineDestinationBody(timeline, viewports);
          return this.timelineBody;
        }),
      draft: factories.draft ?? (() => new PlaceholderDestinationBody()),
      config: factories.config ?? (() => new PlaceholderDestinationBody()),
    });
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
      timeline.subscribe(() => this.render()),
    ];
  }

  dispose(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.destinationHost.dispose();
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
    this.headerElement.dataset.status = header?.status ?? "ready";
    this.headerElement.setAttribute(
      "aria-label",
      [line1, line2].filter(Boolean).join(". "),
    );
    this.first.textContent = line1;
    this.first.title = line1;
    this.second.textContent = line2;
    this.second.title = line2;
    this.body.dataset.destination =
      destination.kind === "config" ? "config" : destination.pane;
    this.destinationHost.update({
      destination,
      timeline:
        destination.kind === "agent"
          ? this.timeline.snapshotFor(destination.key)
          : null,
    });

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
        ? diagnosticHash(`${current.serverId}\0${current.agentId}`)
        : null,
      returnKeyHash: returnTo
        ? diagnosticHash(`${returnTo.serverId}\0${returnTo.agentId}`)
        : null,
      headerLine1: line1,
      headerLine2: line2,
      lastCommand: this.pagerState.lastCommand,
      directory: directoryStatus(this.directoryState),
      directorySources: [...this.directoryState.hosts.values()].map((host) => ({
        serverIdHash: diagnosticHash(host.serverId),
        revision: host.revision,
        status: host.status,
        stale: host.stale,
      })),
      metadataSource: this.metadataState
        ? {
            serverIdHash: diagnosticHash(
              this.metadataState.sourceToken.serverId,
            ),
            slotGeneration: this.metadataState.sourceToken.slotGeneration,
            connectionEpoch: this.metadataState.sourceToken.connectionEpoch,
            revision: this.metadataState.revision,
          }
        : null,
      renderRevision: ++this.renderRevision,
      stableDom: this.stableDom,
      rendererLossCount: this.destinationHost.rendererLossCount,
      timeline:
        destination.kind === "agent" && destination.pane === "timeline"
          ? (this.timelineBody?.diagnostics() ?? null)
          : null,
      config:
        destination.kind === "config"
          ? (this.destinationHost.diagnostics() as ConfigDiagnostics | null)
          : null,
    };
  }

  handleInput(input: import("../native/semanticInput").SemanticInput): boolean {
    const handled = this.destinationHost.handleInput(input);
    if (handled) this.render();
    return handled;
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
