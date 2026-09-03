import { DirectoryCoordinator } from "../directory/coordinator";
import { IndexedDbDirectoryStorage } from "../directory/storage";
import { HostRegistry } from "../hosts/registry";
import { IndexedDbHostStorage } from "../hosts/storage";
import { bindTimeline } from "./binding";
import { TimelineCoordinator } from "./coordinator";
import { timelineAcceptanceStatus } from "./acceptance";
import { IndexedDbTimelineStorage } from "./storage";
import type {
  PaseoTimeline,
  PaseoTimelineEvent,
  PaseoTimelineOptions,
  TimelineActivation,
  TimelineRuntime,
} from "./types";

const registry = new HostRegistry(new IndexedDbHostStorage());
const directory = new DirectoryCoordinator(
  registry,
  new IndexedDbDirectoryStorage(),
);
const coordinator = new TimelineCoordinator(new IndexedDbTimelineStorage());
bindTimeline(coordinator, directory, registry);
void directory.restore();

Object.defineProperty(window, "__glasseoTimelineAcceptance", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({
    activate: (activation: TimelineActivation) =>
      coordinator.activate(activation),
    refresh: () => coordinator.refresh(),
    loadOlder: () => coordinator.loadOlder(),
    selectAgent: (index: number) => {
      const agent = directory.snapshot().orderedAgents[index];
      return agent
        ? directory.selectAgent({
            serverId: agent.serverId,
            agentId: agent.agentId,
          })
        : false;
    },
    status: () => timelineAcceptanceStatus(coordinator),
    runDeterministic: runDeterministicAcceptance,
    directoryStatus: () => ({
      hostCount: directory.snapshot().hosts.size,
      agentCount: directory.snapshot().orderedAgents.length,
      hasSelection: directory.snapshot().current !== null,
    }),
  }),
});

document.body.dataset.timelineAcceptance = "ready";

async function runDeterministicAcceptance() {
  const key = {
    serverId: "acceptance-fixture-server",
    agentId: "acceptance-fixture-agent",
  };
  const sibling = { ...key, agentId: "acceptance-fixture-sibling" };
  const storage = new IndexedDbTimelineStorage();
  const runtime = new AcceptanceRuntime();
  await storage.deleteAgent(key);
  await storage.deleteAgent(sibling);
  const testCoordinator = new TimelineCoordinator(storage, () => 1);
  try {
    runtime.enqueue(
      pageFixture(key.agentId, "tail", 2, 3, { hasOlder: true }),
      pageFixture(key.agentId, "after", 4, 4),
      pageFixture(key.agentId, "before", 1, 2),
      pageFixture(key.agentId, "after", 5, 6),
      pageFixture(key.agentId, "tail", 7, 7, {
        epoch: "acceptance-epoch-2",
      }),
    );
    await testCoordinator.activate({
      key,
      runtime,
      sourceToken: sourceToken(key.serverId, 1),
    });
    ensure(runtime.subscriptions[0]?.join() === key.agentId, "subscription");
    runtime.emit(streamFixture(key.agentId, 4));
    await settled(testCoordinator);
    runtime.emit(streamFixture(key.agentId, 4));
    await testCoordinator.loadOlder();
    runtime.emit(streamFixture(key.agentId, 6));
    await settled(testCoordinator);
    runtime.emit({
      type: "agent.timeline.replacement",
      agentId: key.agentId,
      epoch: "acceptance-epoch-2",
    });
    await waitFor(
      () =>
        testCoordinator.currentSnapshot()?.range?.epoch ===
        "acceptance-epoch-2",
    );
    const status = timelineAcceptanceStatus(testCoordinator);
    ensure(status.duplicateCount === 1 && status.gapCount === 2, "live repair");

    await waitFor(async () => {
      const record = (await storage.loadAgent(key)) as {
        range?: { epoch?: unknown };
      } | null;
      return record?.range?.epoch === "acceptance-epoch-2";
    });
    const restoredRuntime = new AcceptanceRuntime();
    const restoredTail = deferred<PaseoTimeline>();
    restoredRuntime.enqueue(restoredTail.promise);
    const restored = new TimelineCoordinator(storage, () => 2);
    const restoring = restored.activate({
      key,
      runtime: restoredRuntime,
      sourceToken: sourceToken(key.serverId, 2),
    });
    await waitFor(() => {
      const snapshot = restored.currentSnapshot();
      return snapshot?.stale === true && snapshot.rows.length === 1;
    });
    restoredTail.resolve(
      pageFixture(key.agentId, "tail", 8, 8, {
        epoch: "acceptance-epoch-2",
      }),
    );
    await restoring;

    restoredRuntime.enqueue(pageFixture(sibling.agentId, "tail", 20, 20));
    await restored.activate({
      key: sibling,
      runtime: restoredRuntime,
      sourceToken: sourceToken(sibling.serverId, 2),
    });
    ensure(
      restored.currentSnapshot()?.key.agentId === sibling.agentId,
      "switch",
    );
    ensure(
      restored.snapshotFor(key)?.range?.startSeq === 8,
      "switch isolation",
    );
    ensure(restored.currentSnapshot()?.range?.startSeq === 20, "sibling rows");
    ensure(
      restoredRuntime.subscriptions.some((value) => value.length === 0) &&
        restoredRuntime.subscriptions.at(-1)?.join() === sibling.agentId,
      "switch subscription",
    );

    const staleRuntime = new AcceptanceRuntime();
    const staleTail = deferred<PaseoTimeline>();
    staleRuntime.enqueue(staleTail.promise);
    const staleActivation = restored.activate({
      key,
      runtime: staleRuntime,
      sourceToken: sourceToken(key.serverId, 3),
    });
    await waitFor(() => restored.currentSnapshot()?.loading === true);
    const currentRuntime = new AcceptanceRuntime();
    currentRuntime.enqueue(
      pageFixture(key.agentId, "tail", 30, 30, {
        epoch: "acceptance-epoch-3",
      }),
    );
    await restored.activate({
      key,
      runtime: currentRuntime,
      sourceToken: sourceToken(key.serverId, 4),
    });
    staleTail.resolve(
      pageFixture(key.agentId, "tail", 99, 99, {
        epoch: "acceptance-stale",
      }),
    );
    await staleActivation;
    ensure(restored.currentSnapshot()?.range?.startSeq === 30, "source fence");
    restored.dispose();
    await storage.deleteAgent(key);
    await storage.deleteAgent(sibling);
    ensure((await storage.loadAgent(key)) === null, "Agent cache deletion");
    ensure(
      (await storage.loadAgent(sibling)) === null,
      "sibling cache deletion",
    );
    return status;
  } finally {
    testCoordinator.dispose();
    await storage.deleteAgent(key);
    await storage.deleteAgent(sibling);
  }
}

class AcceptanceRuntime implements TimelineRuntime {
  private readonly listeners = new Set<(event: PaseoTimelineEvent) => void>();
  private readonly responses: Array<PaseoTimeline | Promise<PaseoTimeline>> =
    [];
  readonly subscriptions: string[][] = [];

  enqueue(...responses: Array<PaseoTimeline | Promise<PaseoTimeline>>): void {
    this.responses.push(...responses);
  }

  getTimeline(
    agentId: string,
    options: PaseoTimelineOptions = {},
  ): Promise<PaseoTimeline> {
    const response = this.responses.shift();
    if (!response)
      return Promise.reject(new Error("Missing acceptance fixture"));
    return Promise.resolve(response).then((page) => {
      ensure(page.agentId === agentId, "fixture Agent");
      ensure(
        page.direction === (options.direction ?? "tail"),
        "fixture direction",
      );
      return page;
    });
  }

  setTimelineSubscription(agentIds: string[]): Promise<void> {
    this.subscriptions.push(agentIds);
    return Promise.resolve();
  }

  subscribeTimeline(listener: (event: PaseoTimelineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: PaseoTimelineEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function pageFixture(
  agentId: string,
  direction: "tail" | "before" | "after",
  start: number,
  end: number,
  options: { hasOlder?: boolean; epoch?: string } = {},
): PaseoTimeline {
  const epoch = options.epoch ?? "acceptance-epoch";
  return {
    requestId: `acceptance-${direction}`,
    agentId,
    agent: null,
    direction,
    projection: "projected",
    epoch,
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: end, nextSeq: end + 1 },
    startCursor: { epoch, seq: start },
    endCursor: { epoch, seq: end },
    hasOlder: options.hasOlder ?? false,
    hasNewer: false,
    entries: Array.from({ length: end - start + 1 }, (_, offset) => {
      const seq = start + offset;
      return {
        provider: "codex",
        item: {
          type: "assistant_message" as const,
          text: "redacted",
          messageId: `acceptance-${seq}`,
        },
        turnId: "acceptance-turn",
        timestamp: "2026-09-03T00:00:00Z",
        seqStart: seq,
        seqEnd: seq,
        sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
        collapsed: [],
      };
    }),
    error: null,
  };
}

function streamFixture(agentId: string, seq: number): PaseoTimelineEvent {
  return {
    type: "agent_stream",
    agentId,
    event: {
      type: "timeline",
      provider: "codex",
      turnId: "acceptance-turn",
      item: {
        type: "assistant_message",
        text: "redacted",
        messageId: `acceptance-${seq}`,
      },
    },
    timestamp: "2026-09-03T00:00:00Z",
    seq,
    epoch: "acceptance-epoch",
  };
}

async function settled(value: TimelineCoordinator): Promise<void> {
  await waitFor(() => {
    const snapshot = value.currentSnapshot();
    return snapshot?.loading === false && snapshot.catchingUp === false;
  });
}

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let count = 0; count < 100; count++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve));
  }
  throw new Error("Timeline acceptance did not settle");
}

function sourceToken(serverId: string, connectionEpoch: number) {
  return { serverId, slotGeneration: 1, connectionEpoch };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function ensure(value: boolean, step: string): asserts value {
  if (!value) throw new Error(`Timeline acceptance failed: ${step}`);
}
