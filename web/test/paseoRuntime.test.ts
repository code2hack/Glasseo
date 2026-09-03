import assert from "node:assert/strict";
import test from "node:test";
import { SessionOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { DirectoryCoordinator } from "../src/directory/coordinator";
import type { DirectoryStorage } from "../src/directory/types";
import type {
  HostRuntimeLeaseListener,
  StoredHostProfile,
} from "../src/hosts/types";

import {
  createPaseoRuntime,
  PaseoRuntimeError,
  type PaseoRuntime,
  type PaseoRuntimeOptions,
} from "../src/paseo/adapter";

type WireMessage = Record<string, unknown> & { type: string };

class FakeTransport {
  readonly sent: Array<string | Uint8Array | ArrayBuffer> = [];
  readonly closes: Array<[number | undefined, string | undefined]> = [];
  private readonly messages = new Set<
    (data: unknown, isBinary: boolean) => void
  >();
  private readonly opens = new Set<() => void>();
  private readonly remoteCloses = new Set<(event?: unknown) => void>();
  private readonly errors = new Set<(event?: unknown) => void>();

  send = (data: string | Uint8Array | ArrayBuffer) => this.sent.push(data);
  close = (code?: number, reason?: string) => this.closes.push([code, reason]);
  onMessage = (handler: (data: unknown, isBinary: boolean) => void) =>
    this.add(this.messages, handler);
  onOpen = (handler: () => void) => this.add(this.opens, handler);
  onClose = (handler: (event?: unknown) => void) =>
    this.add(this.remoteCloses, handler);
  onError = (handler: (event?: unknown) => void) =>
    this.add(this.errors, handler);

  open(): void {
    for (const handler of this.opens) handler();
  }

  receive(message: WireMessage): void {
    const frame = JSON.stringify({ type: "session", message });
    for (const handler of this.messages) handler(frame, false);
  }

  remoteClose(reason = "fixture close"): void {
    for (const handler of this.remoteCloses) handler({ code: 1006, reason });
  }

  messagesSent(): WireMessage[] {
    return this.sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame) as WireMessage)
      .map((frame) =>
        frame.type === "session" ? (frame.message as WireMessage) : frame,
      );
  }

  last(type: string): WireMessage {
    const message = this.messagesSent()
      .reverse()
      .find((candidate) => candidate.type === type);
    assert.ok(message, `Expected outbound ${type}`);
    return message;
  }

  reply(
    request: WireMessage,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.receive({
      type,
      payload: { requestId: request.requestId, ...payload },
    });
  }

  private add<T>(set: Set<T>, handler: T): () => void {
    set.add(handler);
    return () => set.delete(handler);
  }
}

class Harness {
  readonly transports: FakeTransport[] = [];
  readonly factory = () => {
    const transport = new FakeTransport();
    this.transports.push(transport);
    return transport;
  };
}

const relayUrl = "wss://relay.example/ws?serverId=host-1&role=client&v=2";

function options(
  harness: Harness,
  overrides: Partial<PaseoRuntimeOptions> = {},
): PaseoRuntimeOptions {
  return {
    relayUrl,
    expectedServerId: "host-1",
    daemonPublicKey: "fixture-public-key",
    clientId: "stable-glasseo-client",
    reconnect: { enabled: false },
    connectTimeoutMs: 20,
    testTransportFactory: harness.factory,
    ...overrides,
  };
}

async function connect(
  overrides: Partial<PaseoRuntimeOptions> = {},
  serverInfo: Record<string, unknown> = {},
): Promise<{
  runtime: PaseoRuntime;
  harness: Harness;
  transport: FakeTransport;
}> {
  const harness = new Harness();
  const runtime = createPaseoRuntime(options(harness, overrides));
  const connected = runtime.connect();
  const transport = harness.transports[0];
  transport.open();
  transport.receive({
    type: "status",
    payload: {
      status: "server_info",
      serverId: "host-1",
      hostname: "fixture-host",
      version: "0.7.0",
      features: { selectiveAgentTimeline: true, providerUsageList: true },
      ...serverInfo,
    },
  });
  await connected;
  return { runtime, harness, transport };
}

test("hello uses mobile identity and only Glasseo's implemented capabilities", async () => {
  const states: string[] = [];
  const harness = new Harness();
  const runtime = createPaseoRuntime(options(harness));
  runtime.subscribeConnection((state) => states.push(state.status));
  const connected = runtime.connect();
  const transport = harness.transports[0];
  transport.open();

  const hello = transport.last("hello");
  assert.equal(hello.clientType, "mobile");
  assert.notEqual(hello.clientType, "cli");
  assert.deepEqual(
    Object.entries(hello.capabilities as Record<string, unknown>)
      .filter(([, enabled]) => enabled === true)
      .map(([capability]) => capability),
    ["project_updates", "selective_agent_timeline"],
  );
  assert.deepEqual(states, ["idle", "connecting"]);

  transport.receive({
    type: "status",
    payload: {
      status: "server_info",
      serverId: "host-1",
      hostname: "fixture-host",
      version: "0.7.4",
      capabilities: {
        voice: {
          dictation: { enabled: true, reason: "" },
          voice: { enabled: false, reason: "" },
        },
      },
      features: { selectiveAgentTimeline: true },
    },
  });
  assert.deepEqual(await connected, {
    serverId: "host-1",
    hostname: "fixture-host",
    version: "0.7.4",
    capabilities: {
      voice: {
        dictation: { enabled: true, reason: "" },
        voice: { enabled: false, reason: "" },
      },
    },
    features: { selectiveAgentTimeline: true },
  });
  assert.deepEqual(states, ["idle", "connecting", "connected"]);
  await runtime.close();
});

test("connect remains pending after open until valid server_info arrives", async () => {
  const harness = new Harness();
  const runtime = createPaseoRuntime(options(harness));
  let settled = false;
  const connected = runtime.connect().finally(() => {
    settled = true;
  });
  const transport = harness.transports[0];
  transport.open();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);

  transport.receive({
    type: "status",
    payload: {
      status: "server_info",
      serverId: "host-1",
      hostname: "fixture-host",
      version: "0.7.0",
    },
  });
  assert.equal((await connected).serverId, "host-1");
  await runtime.close();
});

test("a throwing connection subscriber cannot close or starve the runtime", async () => {
  const harness = new Harness();
  const runtime = createPaseoRuntime(options(harness));
  const observed: string[] = [];
  runtime.subscribeConnection((state) => {
    if (state.status === "connected") throw new Error("fixture subscriber");
  });
  runtime.subscribeConnection((state) => observed.push(state.status));
  const connected = runtime.connect();
  const transport = harness.transports[0];
  transport.open();
  transport.receive({
    type: "status",
    payload: {
      status: "server_info",
      serverId: "host-1",
      hostname: "fixture-host",
      version: "0.7.0",
    },
  });
  assert.equal((await connected).serverId, "host-1");
  assert.deepEqual(observed, ["idle", "connecting", "connected"]);

  const projects = runtime.listProjects();
  const request = transport.last("project.list.request");
  transport.reply(request, "project.list.response", { projects: [] });
  assert.deepEqual((await projects).projects, []);
  await runtime.close();
});

test("connection fails closed for wrong identity, missing version, or unsupported version", async () => {
  for (const [payload, code] of [
    [{ serverId: "other" }, "wrong_daemon"],
    [{ version: undefined }, "unverified_version"],
    [{ version: "0.8.0" }, "unsupported_daemon"],
  ] as const) {
    const harness = new Harness();
    const runtime = createPaseoRuntime(options(harness));
    const pending = runtime.connect();
    const transport = harness.transports[0];
    transport.open();
    transport.receive({
      type: "status",
      payload: Object.assign(
        {
          status: "server_info",
          serverId: "host-1",
          hostname: null,
          version: "0.7.0",
        },
        payload,
      ),
    });
    await assert.rejects(
      pending,
      (error) => error instanceof PaseoRuntimeError && error.code === code,
    );
    assert.equal(runtime.getHost(), null);
    assert.equal(transport.closes.length, 1);
  }
});

test("malformed server info never connects", async () => {
  const harness = new Harness();
  const runtime = createPaseoRuntime(options(harness));
  const pending = runtime.connect();
  const transport = harness.transports[0];
  transport.open();
  transport.receive({
    type: "status",
    payload: { status: "server_info", version: "0.7.0" },
  });
  transport.remoteClose();
  await assert.rejects(pending);
  assert.equal(runtime.getHost(), null);
});

test("no RPC or event crosses the boundary before host acceptance", async () => {
  const harness = new Harness();
  const runtime = createPaseoRuntime(options(harness));
  const events: string[] = [];
  runtime.subscribeEvents((event) => events.push(event.type));
  const directoryEvents: string[] = [];
  runtime.subscribeDirectory((event) => directoryEvents.push(event.type));
  const timelineEvents: string[] = [];
  runtime.subscribeTimeline((event) => timelineEvents.push(event.type));
  const pending = runtime.connect();
  const transport = harness.transports[0];
  transport.open();
  await assert.rejects(
    runtime.send("agent-1", "must not send"),
    (error) =>
      error instanceof PaseoRuntimeError && error.code === "invalid_connection",
  );
  assert.equal(
    transport
      .messagesSent()
      .some(({ type }) => type === "send_agent_message_request"),
    false,
  );
  transport.receive({
    type: "agent_update",
    payload: { kind: "remove", agentId: "must-not-escape" },
  });
  transport.receive({
    type: "agent_stream",
    payload: {
      agentId: "must-not-escape",
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "redacted" },
      },
      timestamp: "2026-09-03T00:00:00Z",
    },
  });
  assert.deepEqual(events, []);
  assert.deepEqual(directoryEvents, []);
  assert.deepEqual(timelineEvents, []);
  transport.receive({
    type: "status",
    payload: {
      status: "server_info",
      serverId: "wrong-host",
      version: "0.7.0",
    },
  });
  await assert.rejects(pending);
});

test("real DaemonClient owns request correlation, rpc_error, malformed responses, and close rejection", async () => {
  const { runtime, transport } = await connect();
  const projects = runtime.listProjects();
  const request = transport.last("project.list.request");
  let settled = false;
  void projects.finally(() => (settled = true));
  transport.receive({
    type: "project.list.response",
    payload: { requestId: "unrelated", projects: [] },
  });
  await Promise.resolve();
  assert.equal(settled, false);
  transport.reply(request, "project.list.response", { projects: [] });
  assert.deepEqual(await projects, {
    requestId: request.requestId,
    projects: [],
  });

  const failed = runtime.listProjects();
  const failedRequest = transport.last("project.list.request");
  transport.reply(failedRequest, "rpc_error", {
    error: "fixture denied",
    code: "denied",
  });
  await assert.rejects(failed, /fixture denied/);

  const malformed = runtime.listProjects();
  const malformedRequest = transport.last("project.list.request");
  transport.reply(malformedRequest, "project.list.response", {});
  await assert.rejects(
    malformed,
    (error) =>
      error instanceof PaseoRuntimeError && error.code === "protocol_error",
  );

  const interrupted = runtime.listProjects();
  transport.remoteClose();
  await assert.rejects(interrupted, /fixture close/);
  await runtime.close();
});

test("RPC timeout is owned by DaemonClient", async () => {
  const { runtime } = await connect();
  await assert.rejects(
    runtime.listAgents({ timeout: 5 }),
    /Timeout waiting for message/,
  );
  await runtime.close();
});

test("read methods and selective timeline subscription delegate exact v0.7.0 RPCs", async () => {
  const { runtime, transport } = await connect();

  const workspaces = runtime.listWorkspaces();
  const workspaceRequest = transport.last("fetch_workspaces_request");
  transport.reply(workspaceRequest, "fetch_workspaces_response", {
    entries: [],
    pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
  });
  assert.deepEqual((await workspaces).entries, []);

  const agents = runtime.listAgents();
  const agentsRequest = transport.last("fetch_agents_request");
  transport.reply(agentsRequest, "fetch_agents_response", {
    entries: [],
    pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
  });
  assert.deepEqual((await agents).entries, []);

  const agent = runtime.getAgent("agent-1");
  const agentRequest = transport.last("fetch_agent_request");
  assert.equal(agentRequest.agentId, "agent-1");
  transport.reply(agentRequest, "fetch_agent_response", {
    agent: null,
    project: null,
    error: null,
  });
  assert.equal(await agent, null);

  const timeline = runtime.getTimeline("agent-1", {
    direction: "tail",
    projection: "projected",
    limit: 12,
  });
  const timelineRequest = transport.last("fetch_agent_timeline_request");
  assert.deepEqual(
    {
      agentId: timelineRequest.agentId,
      direction: timelineRequest.direction,
      projection: timelineRequest.projection,
      limit: timelineRequest.limit,
    },
    {
      agentId: "agent-1",
      direction: "tail",
      projection: "projected",
      limit: 12,
    },
  );
  transport.reply(timelineRequest, "fetch_agent_timeline_response", {
    agentId: "agent-1",
    agent: null,
    direction: "tail",
    projection: "projected",
    epoch: "epoch-1",
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
    startCursor: null,
    endCursor: null,
    hasOlder: false,
    hasNewer: false,
    entries: [],
    error: null,
  });
  assert.equal((await timeline).agentId, "agent-1");

  const selective = runtime.setTimelineSubscription([
    "agent-b",
    "agent-a",
    "agent-b",
  ]);
  const subscriptionRequest = transport.last(
    "agent.timeline.set_subscription.request",
  );
  assert.deepEqual(subscriptionRequest.agentIds, ["agent-a", "agent-b"]);
  transport.reply(
    subscriptionRequest,
    "agent.timeline.set_subscription.response",
    {
      agentIds: ["agent-a", "agent-b"],
    },
  );
  await selective;

  const usage = runtime.listUsage();
  const usageRequest = transport.last("provider.usage.list.request");
  transport.reply(usageRequest, "provider.usage.list.response", {
    fetchedAt: "2026-09-02T00:00:00Z",
    providers: [],
  });
  assert.deepEqual((await usage).providers, []);
  await runtime.close();

  const legacy = await connect({}, { features: {} });
  const sentBefore = legacy.transport.messagesSent().length;
  await legacy.runtime.setTimelineSubscription(["agent-1"]);
  assert.equal(legacy.transport.messagesSent().length, sentBefore);
  await legacy.runtime.close();
});

test("events are validated, filtered, and stop after dispose", async () => {
  const { runtime, transport } = await connect();
  const received: string[] = [];
  runtime.subscribeEvents((event) => received.push(event.type));
  transport.receive({
    type: "agent_update",
    payload: { kind: "remove", agentId: "agent-1" },
  });
  transport.receive({
    type: "workspace_update",
    payload: { kind: "remove", id: "workspace-1" },
  });
  transport.receive({
    type: "project.update",
    payload: { kind: "remove", projectId: "project-1" },
  });
  transport.receive({
    type: "agent_stream",
    payload: {
      agentId: "agent-1",
      event: { type: "turn_started", provider: "codex", turnId: "turn-1" },
      timestamp: "2026-09-02T00:00:00Z",
      seq: 1,
      epoch: "epoch-1",
    },
  });
  transport.receive({
    type: "agent_permission_request",
    payload: {
      agentId: "agent-1",
      request: {
        id: "permission-1",
        provider: "codex",
        name: "shell",
        kind: "tool",
      },
    },
  });
  transport.receive({
    type: "agent_permission_resolved",
    payload: {
      agentId: "agent-1",
      requestId: "permission-1",
      resolution: { behavior: "deny" },
    },
  });
  transport.receive({ type: "status", payload: { status: "fixture_status" } });
  assert.deepEqual(received, [
    "agent_update",
    "workspace_update",
    "project.update",
    "agent_stream",
    "agent_permission_request",
    "agent_permission_resolved",
    "status",
  ]);
  await runtime.close();
  transport.receive({
    type: "agent_update",
    payload: { kind: "remove", agentId: "stale" },
  });
  assert.equal(received.length, 7);
});

test("directory events include archive, isolate consumers, and unsubscribe", async () => {
  const { runtime, transport } = await connect();
  const received: string[] = [];
  runtime.subscribeDirectory(() => {
    throw new Error("fixture subscriber");
  });
  const unsubscribe = runtime.subscribeDirectory((event) =>
    received.push(event.type),
  );
  transport.receive({
    type: "agent_update",
    payload: { kind: "remove", agentId: "agent-1" },
  });
  transport.receive({
    type: "agent_deleted",
    payload: { agentId: "agent-1", requestId: "delete-1" },
  });
  transport.receive({
    type: "agent_archived",
    payload: {
      agentId: "agent-2",
      archivedAt: "2026-09-03T00:00:00Z",
      requestId: "archive-1",
    },
  });
  transport.receive({
    type: "workspace_update",
    payload: { kind: "remove", id: "workspace-1" },
  });
  transport.receive({
    type: "project.update",
    payload: { kind: "remove", projectId: "project-1" },
  });
  assert.deepEqual(received, [
    "agent_update",
    "agent_deleted",
    "agent_archived",
    "workspace_update",
    "project.update",
  ]);

  unsubscribe();
  transport.receive({
    type: "agent_update",
    payload: { kind: "remove", agentId: "stale" },
  });
  assert.equal(received.length, 5);
  assert.equal(runtime.getHost()?.serverId, "host-1");
  await runtime.close();
});

test("timeline events preserve exact v0.7.0 facts, isolate consumers, and unsubscribe", async () => {
  const { runtime, transport } = await connect();
  const received: unknown[] = [];
  runtime.subscribeTimeline(() => {
    throw new Error("fixture subscriber");
  });
  const unsubscribe = runtime.subscribeTimeline((event) =>
    received.push(event),
  );
  const retainedThroughClose: unknown[] = [];
  runtime.subscribeTimeline((event) => retainedThroughClose.push(event));

  transport.receive({
    type: "agent_stream",
    payload: {
      agentId: "agent-1",
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: {
          type: "assistant_message",
          text: "redacted",
          messageId: "message-1",
        },
      },
      timestamp: "2026-09-03T00:00:00Z",
      seq: 7,
      epoch: "epoch-1",
    },
  });
  transport.receive({
    type: "agent.timeline.replacement",
    payload: { agentId: "agent-1", epoch: "epoch-2" },
  });
  assert.deepEqual(received, [
    {
      type: "agent_stream",
      agentId: "agent-1",
      event: {
        type: "timeline",
        provider: "codex",
        turnId: "turn-1",
        item: {
          type: "assistant_message",
          text: "redacted",
          messageId: "message-1",
        },
      },
      timestamp: "2026-09-03T00:00:00Z",
      seq: 7,
      epoch: "epoch-1",
    },
    {
      type: "agent.timeline.replacement",
      agentId: "agent-1",
      epoch: "epoch-2",
    },
  ]);

  unsubscribe();
  transport.receive({
    type: "agent.timeline.replacement",
    payload: { agentId: "agent-1", epoch: "epoch-3" },
  });
  assert.equal(received.length, 2);
  assert.equal(retainedThroughClose.length, 3);
  assert.equal(runtime.getHost()?.serverId, "host-1");
  await runtime.close();
  transport.receive({
    type: "agent.timeline.replacement",
    payload: { agentId: "agent-1", epoch: "epoch-after-close" },
  });
  assert.equal(received.length, 2);
  assert.equal(retainedThroughClose.length, 3);
});

test("real adapter pages exact directory RPCs into a normalized replica", async () => {
  const { runtime, transport } = await connect();
  const profile: StoredHostProfile = {
    schemaVersion: 1,
    serverId: "host-1",
    relayEndpoint: "relay.example:443",
    useTls: true,
    daemonPublicKey: "fixture-public-key",
    hostname: "fixture-host",
    createdAt: 1,
    updatedAt: 1,
  };
  const source = {
    async restore() {},
    subscribeRuntimeLeases(listener: HostRuntimeLeaseListener) {
      listener([
        {
          serverId: "host-1",
          slotGeneration: 1,
          connectionEpoch: 1,
          status: "online",
          profile,
          runtime,
        },
      ]);
      return () => {};
    },
  };
  const storage: DirectoryStorage = {
    loadHost: async () => null,
    listHostIds: async () => [],
    putHost: async () => {},
    deleteHost: async () => {},
    getLastViewedAgent: async () => null,
    putLastViewedAgent: async () => {},
  };
  const directory = new DirectoryCoordinator(source, storage);
  const restoring = directory.restore();
  await new Promise((resolve) => setImmediate(resolve));

  const projectRequest = transport.last("project.list.request");
  transport.reply(projectRequest, "project.list.response", {
    projects: [projectPayload("host-1")],
  });
  const workspaceRequest = transport.last("fetch_workspaces_request");
  transport.reply(workspaceRequest, "fetch_workspaces_response", {
    entries: [workspacePayload("host-1")],
    pageInfo: { nextCursor: "workspace-next", prevCursor: null, hasMore: true },
  });
  const agentRequest = transport.last("fetch_agents_request");
  const agentResponse = {
    type: "fetch_agents_response" as const,
    payload: {
      requestId: String(agentRequest.requestId),
      entries: [agentPayload("agent-new", "2026-09-03T02:00:00Z")],
      pageInfo: { nextCursor: "agent-next", prevCursor: null, hasMore: true },
    },
  };
  const parsedAgentResponse =
    SessionOutboundMessageSchema.safeParse(agentResponse);
  assert.equal(
    parsedAgentResponse.success,
    true,
    parsedAgentResponse.success ? "" : parsedAgentResponse.error.message,
  );
  transport.reply(agentRequest, "fetch_agents_response", {
    entries: agentResponse.payload.entries,
    pageInfo: agentResponse.payload.pageInfo,
  });
  for (let attempt = 0; attempt < 20; attempt++)
    await new Promise((resolve) => setImmediate(resolve));

  const sentTypes = transport.messagesSent().map(({ type }) => type);
  assert.equal(
    sentTypes.filter((type) => type === "fetch_agents_request").length,
    2,
    sentTypes.join(","),
  );
  assert.equal(
    sentTypes.filter((type) => type === "fetch_workspaces_request").length,
    2,
    sentTypes.join(","),
  );

  const workspaceNext = transport.last("fetch_workspaces_request");
  const agentNext = transport.last("fetch_agents_request");
  assert.equal(
    (workspaceNext.page as { cursor: string }).cursor,
    "workspace-next",
  );
  assert.equal((agentNext.page as { cursor: string }).cursor, "agent-next");
  assert.equal((agentNext.page as { limit: number }).limit, 200);
  assert.deepEqual(agentNext.sort, [{ key: "updated_at", direction: "desc" }]);
  transport.reply(workspaceNext, "fetch_workspaces_response", {
    entries: [],
    pageInfo: {
      nextCursor: null,
      prevCursor: "workspace-prev",
      hasMore: false,
    },
  });
  transport.reply(agentNext, "fetch_agents_response", {
    entries: [agentPayload("agent-old", "2026-09-03T01:00:00Z")],
    pageInfo: { nextCursor: null, prevCursor: "agent-prev", hasMore: false },
  });
  await restoring;

  assert.deepEqual(
    directory.snapshot().orderedAgents.map((agent) => agent.agentId),
    ["agent-new", "agent-old"],
  );
  assert.equal(directory.snapshot().hosts.get("host-1")?.projects.size, 1);
  assert.equal(directory.snapshot().hosts.get("host-1")?.workspaces.size, 1);
  await runtime.close();
});

test("action wrappers preserve exact Send, Steer, Interrupt, and permission semantics", async () => {
  const { runtime, transport } = await connect();

  const send = runtime.send("agent-1", "send text", {
    images: [{ data: "image-data", mimeType: "image/jpeg" }],
  });
  const sendRequest = transport.last("send_agent_message_request");
  assert.equal("activeTurnBehavior" in sendRequest, false);
  assert.equal(sendRequest.text, "send text");
  transport.reply(sendRequest, "send_agent_message_response", {
    agentId: "agent-1",
    accepted: true,
    error: null,
  });
  await send;

  const steer = runtime.steer("agent-1", "steer text");
  const steerRequest = transport.last("send_agent_message_request");
  assert.equal(steerRequest.activeTurnBehavior, "steer");
  transport.reply(steerRequest, "send_agent_message_response", {
    agentId: "agent-1",
    accepted: true,
    error: null,
  });
  await steer;

  const interrupt = runtime.interrupt("agent-1");
  const cancelRequest = transport.last("cancel_agent_request");
  transport.reply(cancelRequest, "cancel_agent_response", {
    agentId: "agent-1",
    agent: null,
    error: null,
  });
  await interrupt;

  await runtime.respondToPermission("agent-1", "permission-1", {
    behavior: "deny",
    selectedActionId: "deny-once",
    message: "No",
    interrupt: true,
  });
  assert.deepEqual(transport.last("agent_permission_response"), {
    type: "agent_permission_response",
    agentId: "agent-1",
    requestId: "permission-1",
    response: {
      behavior: "deny",
      selectedActionId: "deny-once",
      message: "No",
      interrupt: true,
    },
  });
  await runtime.close();
});

test("dictation events and commands are isolated by dictation ID", async () => {
  const { runtime, transport } = await connect();
  const events: string[] = [];
  runtime.subscribeDictation("dictation-1", (event) => events.push(event.type));

  const start = runtime.startDictation(
    "dictation-1",
    "audio/pcm;rate=16000;bits=16",
  );
  assert.equal(
    transport.last("dictation_stream_start").dictationId,
    "dictation-1",
  );
  transport.receive({
    type: "dictation_stream_ack",
    payload: { dictationId: "other", ackSeq: -1 },
  });
  transport.receive({
    type: "dictation_stream_ack",
    payload: { dictationId: "dictation-1", ackSeq: -1 },
  });
  await start;
  runtime.sendDictationChunk(
    "dictation-1",
    0,
    "AA==",
    "audio/pcm;rate=16000;bits=16",
  );
  assert.equal(transport.last("dictation_stream_chunk").seq, 0);
  transport.receive({
    type: "dictation_stream_partial",
    payload: { dictationId: "dictation-1", text: "hel" },
  });

  const finish = runtime.finishDictation("dictation-1", 0);
  assert.equal(transport.last("dictation_stream_finish").finalSeq, 0);
  transport.receive({
    type: "dictation_stream_finish_accepted",
    payload: { dictationId: "dictation-1", timeoutMs: 50 },
  });
  transport.receive({
    type: "dictation_stream_final",
    payload: { dictationId: "dictation-1", text: "hello" },
  });
  assert.equal((await finish).text, "hello");
  runtime.cancelDictation("dictation-1");
  assert.equal(
    transport.last("dictation_stream_cancel").dictationId,
    "dictation-1",
  );
  assert.deepEqual(events, [
    "dictation_stream_ack",
    "dictation_stream_partial",
    "dictation_stream_finish_accepted",
    "dictation_stream_final",
  ]);

  const errors: string[] = [];
  runtime.subscribeDictation("dictation-2", (event) => errors.push(event.type));
  const failedStart = runtime.startDictation("dictation-2", "audio/pcm");
  transport.receive({
    type: "dictation_stream_error",
    payload: {
      dictationId: "dictation-2",
      error: "fixture dictation failure",
      retryable: false,
    },
  });
  await assert.rejects(failedStart, /fixture dictation failure/);
  assert.deepEqual(errors, ["dictation_stream_error"]);
  await runtime.close();
});

test("DaemonClient reconnects without a Glasseo retry loop and dispose stops stale callbacks", async () => {
  const { runtime, harness, transport } = await connect({
    reconnect: { enabled: true, baseDelayMs: 1, maxDelayMs: 1 },
  });
  const states: string[] = [];
  runtime.subscribeConnection((state) => states.push(state.status));
  transport.remoteClose();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(harness.transports.length, 2);
  const replacement = harness.transports[1];
  replacement.open();
  replacement.receive({
    type: "status",
    payload: {
      status: "server_info",
      serverId: "host-1",
      hostname: "fixture-host",
      version: "0.7.0",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(states, [
    "connected",
    "disconnected",
    "connecting",
    "connected",
  ]);
  await runtime.close();
  const count = states.length;
  replacement.remoteClose("stale");
  assert.equal(states.length, count);
});

test("invalid caller connection facts fail before constructing a client", () => {
  const harness = new Harness();
  assert.throws(
    () => createPaseoRuntime(options(harness, { clientId: "" })),
    (error) =>
      error instanceof PaseoRuntimeError && error.code === "invalid_connection",
  );
  assert.throws(
    () =>
      createPaseoRuntime(
        options(harness, { relayUrl: "wss://daemon.example/ws" }),
      ),
    (error) =>
      error instanceof PaseoRuntimeError && error.code === "invalid_connection",
  );
});

function projectPayload(serverId: string) {
  return {
    projectId: `project-${serverId}`,
    projectKey: `key-${serverId}`,
    projectDisplayName: `project ${serverId}`,
    projectRootPath: `/projects/${serverId}`,
    projectKind: "git",
  };
}

function workspacePayload(serverId: string) {
  return {
    id: `workspace-${serverId}`,
    projectId: `project-${serverId}`,
    projectDisplayName: `project ${serverId}`,
    projectRootPath: `/projects/${serverId}`,
    workspaceDirectory: `/projects/${serverId}/workspace`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: `workspace-${serverId}`,
    status: "done",
    activityAt: "2026-09-03T00:00:00Z",
    scripts: [],
    gitRuntime: null,
    githubRuntime: null,
  };
}

function agentPayload(agentId: string, updatedAt: string) {
  return {
    agent: {
      id: agentId,
      provider: "codex",
      cwd: "/workspace",
      workspaceId: "workspace-host-1",
      model: "gpt-fixture",
      createdAt: "2026-09-03T00:00:00Z",
      updatedAt,
      lastUserMessageAt: null,
      status: "idle",
      activeTurn: null,
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: agentId,
      labels: {},
    },
    project: {
      projectKey: "key-host-1",
      projectName: "project host-1",
      workspaceName: "workspace-host-1",
      checkout: {
        cwd: "/projects/host-1",
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}
