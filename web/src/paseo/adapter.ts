import {
  DaemonClient,
  type ConnectionState,
  type DaemonClientConfig,
  type DaemonEvent,
  type DaemonTransportFactory,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { isRelayClientWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { ConnectionOfferSchema } from "@getpaseo/protocol/connection-offer";
import type {
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { exportPublicKey, generateKeyPair } from "@getpaseo/relay/e2ee";

const DISABLED_DAEMON_DEFAULT_CAPABILITIES = {
  [CLIENT_CAPS.compactProviderSnapshots]: false,
  [CLIENT_CAPS.customModeIcons]: false,
  [CLIENT_CAPS.projectUpdates]: false,
  [CLIENT_CAPS.providerSubagents]: false,
  [CLIENT_CAPS.reasoningMergeEnum]: false,
  [CLIENT_CAPS.terminalReflowableSnapshot]: false,
};
const PASEO_EVENT_TYPES = [
  "agent_update",
  "workspace_update",
  "project.update",
  "agent_stream",
  "status",
  "agent_deleted",
  "agent_permission_request",
  "agent_permission_resolved",
  "error",
] as const;
const DICTATION_EVENT_TYPES = [
  "dictation_stream_ack",
  "dictation_stream_finish_accepted",
  "dictation_stream_partial",
  "dictation_stream_final",
  "dictation_stream_error",
] as const;

export type PaseoConnectionState = ConnectionState;
export type PaseoEvent = Extract<
  DaemonEvent,
  { type: (typeof PASEO_EVENT_TYPES)[number] }
>;
type Inbound<T extends SessionInboundMessage["type"]> = Extract<
  SessionInboundMessage,
  { type: T }
>;
type Outbound<T extends SessionOutboundMessage["type"]> =
  Extract<SessionOutboundMessage, { type: T }> extends {
    payload: infer Payload;
  }
    ? Payload
    : never;
export type PaseoProjects = Outbound<"project.list.response">;
export type PaseoWorkspaces = Outbound<"fetch_workspaces_response">;
export type PaseoAgents = Outbound<"fetch_agents_response">;
type PaseoAgentResponse = Outbound<"fetch_agent_response">;
export type PaseoAgent = {
  agent: NonNullable<PaseoAgentResponse["agent"]>;
  project: PaseoAgentResponse["project"];
} | null;
export type PaseoTimeline = Outbound<"fetch_agent_timeline_response">;
export type PaseoUsage = Outbound<"provider.usage.list.response">;
export type PaseoWorkspacesOptions = Omit<
  Inbound<"fetch_workspaces_request">,
  "type" | "requestId"
> & { requestId?: string };
export type PaseoAgentsOptions = Omit<
  Inbound<"fetch_agents_request">,
  "type" | "requestId"
> & { requestId?: string; timeout?: number };
export type PaseoTimelineOptions = Omit<
  Inbound<"fetch_agent_timeline_request">,
  "type" | "agentId" | "requestId"
> & { requestId?: string; timeout?: number };
export interface PaseoSendOptions {
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
}
export type PaseoDictationEvent = Extract<
  SessionOutboundMessage,
  { type: (typeof DICTATION_EVENT_TYPES)[number] }
>;

export interface PaseoHostInfo {
  serverId: string;
  hostname: string | null;
  version: string;
  capabilities: Readonly<Record<string, unknown>>;
  features: Readonly<Record<string, boolean | undefined>>;
}

export interface PaseoRuntimeOptions {
  relayUrl: string;
  expectedServerId: string;
  daemonPublicKey: string;
  clientId: string;
  reconnect?: DaemonClientConfig["reconnect"];
  connectTimeoutMs?: number;
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  /** Deterministic real-DaemonClient test seam; production Relay always enables E2EE. */
  testTransportFactory?: DaemonTransportFactory;
}

export interface PaseoRuntime {
  connect(): Promise<PaseoHostInfo>;
  close(): Promise<void>;
  getHost(): PaseoHostInfo | null;
  subscribeConnection(
    listener: (state: PaseoConnectionState) => void,
  ): () => void;
  subscribeEvents(listener: (event: PaseoEvent) => void): () => void;
  listProjects(): Promise<PaseoProjects>;
  listWorkspaces(options?: PaseoWorkspacesOptions): Promise<PaseoWorkspaces>;
  listAgents(options?: PaseoAgentsOptions): Promise<PaseoAgents>;
  getAgent(agentId: string): Promise<PaseoAgent>;
  getTimeline(
    agentId: string,
    options?: PaseoTimelineOptions,
  ): Promise<PaseoTimeline>;
  setTimelineSubscription(agentIds: string[]): Promise<void>;
  send(
    agentId: string,
    text: string,
    options?: PaseoSendOptions,
  ): Promise<void>;
  steer(
    agentId: string,
    text: string,
    options?: PaseoSendOptions,
  ): Promise<void>;
  interrupt(agentId: string): Promise<void>;
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void>;
  listUsage(): Promise<PaseoUsage>;
  startDictation(dictationId: string, format: string): Promise<void>;
  sendDictationChunk(
    dictationId: string,
    seq: number,
    audio: string,
    format: string,
  ): void;
  finishDictation(
    dictationId: string,
    finalSeq: number,
  ): ReturnType<DaemonClient["finishDictationStream"]>;
  cancelDictation(dictationId: string): void;
  subscribeDictation(
    dictationId: string,
    listener: (event: PaseoDictationEvent) => void,
  ): () => void;
}

export class PaseoRuntimeError extends Error {
  constructor(
    public readonly code:
      | "invalid_connection"
      | "wrong_daemon"
      | "unverified_version"
      | "unsupported_daemon"
      | "protocol_error",
    message: string,
  ) {
    super(message);
    this.name = "PaseoRuntimeError";
  }
}

export function createPaseoRuntime(options: PaseoRuntimeOptions): PaseoRuntime {
  validateOptions(options);
  const subscriptions = new Set<() => void>();
  const connectionListeners = new Set<(state: PaseoConnectionState) => void>();
  let host: PaseoHostInfo | null = null;
  let disposed = false;
  let compatibilityError: PaseoRuntimeError | null = null;
  const log =
    (level: "debug" | "info" | "warn" | "error") =>
    (_details: object, message = "Paseo client event") =>
      options.log?.(level, message);
  const logger: NonNullable<DaemonClientConfig["logger"]> = {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
  const client = new DaemonClient({
    url: options.relayUrl,
    clientId: options.clientId,
    clientType: "mobile",
    capabilities: {
      ...DISABLED_DAEMON_DEFAULT_CAPABILITIES,
      [CLIENT_CAPS.selectiveAgentTimeline]: true,
    },
    e2ee: {
      enabled: options.testTransportFactory === undefined,
      daemonPublicKeyB64: options.daemonPublicKey,
    },
    logger,
    connectTimeoutMs: options.connectTimeoutMs,
    reconnect: options.reconnect,
    transportFactory: options.testTransportFactory,
  });

  function notifyConnectionListener(
    listener: (state: PaseoConnectionState) => void,
    state: PaseoConnectionState,
  ): void {
    try {
      listener(state);
    } catch {
      try {
        options.log?.("warn", "Paseo connection subscriber failed");
      } catch {
        // Subscriber and logging failures never affect connection ownership.
      }
    }
  }

  function notifyConnectionListeners(state: PaseoConnectionState): void {
    for (const listener of connectionListeners)
      notifyConnectionListener(listener, state);
  }

  subscriptions.add(
    client.subscribeConnectionStatus((state) => {
      if (state.status === "disconnected") host = null;
      if (state.status === "connected" && host === null) return;
      notifyConnectionListeners(state);
    }),
  );

  async function closeRuntime(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await client.close();
    for (const unsubscribe of subscriptions) unsubscribe();
    subscriptions.clear();
    connectionListeners.clear();
    host = null;
  }

  function requireAcceptedHost(): void {
    if (!host || disposed)
      throw new PaseoRuntimeError(
        "invalid_connection",
        "Paseo host has not been accepted",
      );
  }

  async function call<T>(operation: () => Promise<T>): Promise<T> {
    requireAcceptedHost();
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "DaemonProtocolError" ||
          ("code" in error && error.code === "invalid_response"))
      ) {
        throw new PaseoRuntimeError("protocol_error", error.message);
      }
      throw error;
    }
  }

  subscriptions.add(
    client.on("status", () => {
      if (host !== null || client.getConnectionState().status !== "connected")
        return;
      let acceptedHost: PaseoHostInfo;
      try {
        acceptedHost = normalizeHost(
          client.getLastServerInfoMessage(),
          options.expectedServerId,
        );
      } catch (error) {
        compatibilityError = error as PaseoRuntimeError;
        void closeRuntime();
        return;
      }
      host = acceptedHost;
      notifyConnectionListeners({ status: "connected" });
    }),
  );

  const runtime: PaseoRuntime = {
    async connect() {
      if (disposed) throw new Error("Paseo runtime is disposed");
      await client.connect();
      if (compatibilityError) throw compatibilityError;
      if (!host)
        throw new PaseoRuntimeError(
          "invalid_connection",
          "Daemon connection closed before host acceptance",
        );
      return host;
    },
    close: closeRuntime,
    getHost: () => host,
    subscribeConnection(listener) {
      if (disposed) {
        notifyConnectionListener(listener, { status: "disposed" });
        return () => {};
      }
      connectionListeners.add(listener);
      const state = client.getConnectionState();
      notifyConnectionListener(
        listener,
        state.status === "connected" && host === null
          ? { status: "connecting", attempt: 0 }
          : state,
      );
      return () => connectionListeners.delete(listener);
    },
    subscribeEvents(listener) {
      if (disposed) return () => {};
      const unsubscribe = client.subscribe((event) => {
        if (host && isPaseoEvent(event)) listener(event);
      });
      subscriptions.add(unsubscribe);
      return () => {
        subscriptions.delete(unsubscribe);
        unsubscribe();
      };
    },
    listProjects: () => call(() => client.listProjects()),
    listWorkspaces: (readOptions) =>
      call(() => client.fetchWorkspaces(readOptions)),
    listAgents: (readOptions) => call(() => client.fetchAgents(readOptions)),
    getAgent: (agentId) => call(() => client.fetchAgent({ agentId })),
    getTimeline: (agentId, timelineOptions) =>
      call(() => client.fetchAgentTimeline(agentId, timelineOptions)),
    setTimelineSubscription: (agentIds) =>
      call(() => client.setAgentTimelineSubscription(agentIds)),
    send: (agentId, text, sendOptions) =>
      call(() => client.sendAgentMessage(agentId, text, sendOptions)),
    steer: (agentId, text, sendOptions) =>
      call(() =>
        client.sendAgentMessage(agentId, text, {
          ...sendOptions,
          activeTurnBehavior: "steer",
        }),
      ),
    interrupt: (agentId) => call(() => client.cancelAgent(agentId)),
    respondToPermission: (agentId, requestId, response) =>
      call(() => client.respondToPermission(agentId, requestId, response)),
    listUsage: () => call(() => client.listProviderUsage()),
    startDictation: (dictationId, format) =>
      call(() => client.startDictationStream(dictationId, format)),
    sendDictationChunk: (dictationId, seq, audio, format) => {
      requireAcceptedHost();
      client.sendDictationStreamChunk(dictationId, seq, audio, format);
    },
    finishDictation: (dictationId, finalSeq) =>
      call(() => client.finishDictationStream(dictationId, finalSeq)),
    cancelDictation: (dictationId) => {
      requireAcceptedHost();
      client.cancelDictationStream(dictationId);
    },
    subscribeDictation(dictationId, listener) {
      if (disposed) return () => {};
      const unsubscribe = client.subscribeRawMessages((message) => {
        if (
          host &&
          isDictationEvent(message) &&
          message.payload.dictationId === dictationId
        )
          listener(message);
      });
      subscriptions.add(unsubscribe);
      return () => {
        subscriptions.delete(unsubscribe);
        unsubscribe();
      };
    },
  };
  return runtime;
}

function validateOptions(options: PaseoRuntimeOptions): void {
  if (
    !options.expectedServerId.trim() ||
    !options.clientId.trim() ||
    !options.daemonPublicKey.trim()
  ) {
    throw new PaseoRuntimeError(
      "invalid_connection",
      "Paseo connection fields must be non-empty",
    );
  }
  if (!isRelayClientWebSocketUrl(options.relayUrl)) {
    throw new PaseoRuntimeError(
      "invalid_connection",
      "Expected a Paseo Relay client WebSocket URL",
    );
  }
  if (
    new URL(options.relayUrl).searchParams.get("serverId") !==
    options.expectedServerId
  ) {
    throw new PaseoRuntimeError(
      "invalid_connection",
      "Relay URL serverId does not match the expected host",
    );
  }
}

function normalizeHost(
  info: ReturnType<DaemonClient["getLastServerInfoMessage"]>,
  expectedServerId: string,
): PaseoHostInfo {
  if (!info?.serverId || info.serverId !== expectedServerId) {
    throw new PaseoRuntimeError(
      "wrong_daemon",
      "Daemon serverId does not match the paired host",
    );
  }
  if (!info.version) {
    throw new PaseoRuntimeError(
      "unverified_version",
      "Daemon did not report a version",
    );
  }
  if (!/^0\.7(?:\.|$)/.test(info.version)) {
    throw new PaseoRuntimeError(
      "unsupported_daemon",
      `Unsupported Paseo daemon version: ${info.version}`,
    );
  }
  return {
    serverId: info.serverId,
    hostname: info.hostname,
    version: info.version,
    capabilities: info.capabilities ?? {},
    features: info.features ?? {},
  };
}

function isDictationEvent(
  message: SessionOutboundMessage,
): message is PaseoDictationEvent {
  return DICTATION_EVENT_TYPES.includes(
    message.type as (typeof DICTATION_EVENT_TYPES)[number],
  );
}

function isPaseoEvent(event: DaemonEvent): event is PaseoEvent {
  return PASEO_EVENT_TYPES.includes(
    event.type as (typeof PASEO_EVENT_TYPES)[number],
  );
}

export function probePaseoBundleAndCrypto(): boolean {
  const first = generateKeyPair();
  const second = generateKeyPair();
  return (
    typeof DaemonClient === "function" &&
    !ConnectionOfferSchema.safeParse({}).success &&
    first.publicKey.byteLength === 32 &&
    first.secretKey.byteLength === 32 &&
    exportPublicKey(first.publicKey) !== exportPublicKey(second.publicKey)
  );
}
