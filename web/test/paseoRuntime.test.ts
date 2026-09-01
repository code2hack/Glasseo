import assert from "node:assert/strict";
import test from "node:test";

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

test("hello uses mobile identity and only Glasseo's implemented capability", async () => {
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
    ["selective_agent_timeline"],
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
  assert.deepEqual(events, []);
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
