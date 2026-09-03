import assert from "node:assert/strict";
import test from "node:test";
import { FetchAgentTimelineResponseMessageSchema } from "@getpaseo/protocol/messages";
import type { AgentKey } from "../src/directory/types";
import type { GlobalAgentDirectorySnapshot } from "../src/directory/types";
import type {
  HostRuntimeLease,
  HostRuntimeLeaseListener,
} from "../src/hosts/types";
import { bindTimeline } from "../src/timeline/binding";
import {
  TimelineCoordinator,
  mergeTimelineRows,
} from "../src/timeline/coordinator";
import { timelineAcceptanceStatus } from "../src/timeline/acceptance";
import {
  normalizePage,
  rowId,
  timelineKey,
  validateCachedTimeline,
} from "../src/timeline/normalize";
import {
  MAX_TIMELINE_BYTES,
  MAX_TIMELINE_ROWS,
  boundTimelineCache,
} from "../src/timeline/storage";
import type {
  CachedAgentTimeline,
  PaseoTimeline,
  PaseoTimelineEvent,
  PaseoTimelineOptions,
  TimelineRuntime,
  TimelineStorage,
} from "../src/timeline/types";

test("tail, live catch-up, duplicates, older anchors, and host identity stay canonical", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(
    page("agent", "tail", 3, 4, { hasOlder: true }),
    page("agent", "after", 5, 5, { hasNewer: true }),
    page("agent", "after", 6, 6),
    page("agent", "before", 1, 3, { hasNewer: true }),
  );
  const storage = new MemoryStorage();
  const coordinator = new TimelineCoordinator(storage, () => 123);
  const key = { serverId: "alpha", agentId: "agent" };
  await coordinator.activate(activation(key, runtime));

  assert.deepEqual(runtime.subscriptions[0], ["agent"]);
  assert.deepEqual(coordinator.currentSnapshot()?.range, {
    epoch: "epoch-1",
    startSeq: 3,
    endSeq: 4,
  });
  coordinator.setFollowing(false);
  runtime.emit(stream("agent", 5));
  await settle();
  assert.deepEqual(coordinator.currentSnapshot()?.range, {
    epoch: "epoch-1",
    startSeq: 3,
    endSeq: 6,
  });
  assert.equal(coordinator.currentSnapshot()?.rows.length, 4);
  assert.equal(coordinator.currentSnapshot()?.unseenLiveCount, 1);

  runtime.emit(stream("agent", 6));
  assert.equal(coordinator.currentSnapshot()?.duplicateCount, 1);
  const anchor = await coordinator.loadOlder(key);
  assert.equal(anchor.anchorRowId, rowId("epoch-1", item(3), "turn", 3));
  assert.equal(anchor.prependedRowIds.length, 2);
  assert.equal(coordinator.currentSnapshot()?.rows.length, 6);
  assert.deepEqual(coordinator.currentSnapshot()?.range, {
    epoch: "epoch-1",
    startSeq: 1,
    endSeq: 6,
  });

  const betaRuntime = new FakeRuntime();
  betaRuntime.responses.push(page("agent", "tail", 10, 10));
  await coordinator.activate(
    activation({ serverId: "beta", agentId: "agent" }, betaRuntime),
  );
  assert.equal(coordinator.currentSnapshot()?.rows[0]?.seqStart, 10);
  assert.equal(coordinator.snapshotFor(key)?.rows.length, 6);
  assert.deepEqual(runtime.subscriptions.at(-1), []);
  assert.notEqual(
    timelineKey(key),
    timelineKey({ serverId: "beta", agentId: "agent" }),
  );
});

test("binding reapplies selective delivery for a reconnected runtime epoch", async () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const runtime = leaseRuntime(key.agentId);
  runtime.responses.push(
    page(key.agentId, "tail", 1, 1),
    page(key.agentId, "after", 2, 2),
  );
  const directory = new FakeDirectorySource(directorySnapshot([key], key));
  const leases = new FakeLeaseSource([hostLease(key.serverId, runtime)]);
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  const dispose = bindTimeline(coordinator, directory, leases);
  await settle();
  assert.deepEqual(coordinator.currentSubscriptionTarget(), key);

  const staleClear = deferred<void>();
  const epochTwoSubscription = deferred<void>();
  runtime.subscriptionImpl = (agentIds) =>
    agentIds.length === 0 ? staleClear.promise : epochTwoSubscription.promise;
  leases.emit([{ ...hostLease(key.serverId, runtime), status: "offline" }]);
  leases.emit([{ ...hostLease(key.serverId, runtime), connectionEpoch: 2 }]);
  await settle();
  assert.equal(coordinator.currentSubscriptionTarget(), null);

  staleClear.reject(new Error("disconnected before clear"));
  await settle();
  assert.deepEqual(runtime.subscriptionRequests, [
    [key.agentId],
    [],
    [key.agentId],
  ]);
  assert.equal(coordinator.currentSubscriptionTarget(), null);

  epochTwoSubscription.resolve();
  await settle();
  assert.deepEqual(coordinator.currentSubscriptionTarget(), key);
  runtime.emit(stream(key.agentId, 2));
  await settle();
  assert.equal(coordinator.currentSnapshot()?.range?.endSeq, 2);
  assert.equal(coordinator.currentSnapshot()?.rows.at(-1)?.provisional, false);
  dispose();
});

test("a stale successful subscription cannot satisfy a newer runtime epoch", async () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const runtime = leaseRuntime(key.agentId);
  runtime.responses.push(page(key.agentId, "tail", 1, 1));
  const staleEpochOne = deferred<void>();
  const epochTwoSubscription = deferred<void>();
  let agentAttempt = 0;
  runtime.subscriptionImpl = (agentIds) => {
    if (agentIds.length === 0) return Promise.resolve();
    return ++agentAttempt === 1
      ? staleEpochOne.promise
      : epochTwoSubscription.promise;
  };
  const directory = new FakeDirectorySource(directorySnapshot([key], key));
  const leases = new FakeLeaseSource([hostLease(key.serverId, runtime)]);
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  const dispose = bindTimeline(coordinator, directory, leases);
  await settle();

  leases.emit([{ ...hostLease(key.serverId, runtime), status: "offline" }]);
  leases.emit([{ ...hostLease(key.serverId, runtime), connectionEpoch: 2 }]);
  staleEpochOne.resolve();
  await settle();
  assert.deepEqual(runtime.subscriptionRequests, [
    [key.agentId],
    [key.agentId],
  ]);
  assert.equal(coordinator.currentSubscriptionTarget(), null);

  epochTwoSubscription.resolve();
  await settle();
  assert.deepEqual(coordinator.currentSubscriptionTarget(), key);
  dispose();
});

test("cache is display-only, buffered live wins, and stale completions cannot cross activation", async () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const storage = new MemoryStorage();
  storage.records.set(
    timelineKey(key),
    cache(key, page("agent", "tail", 1, 1)),
  );
  const runtime = new FakeRuntime();
  const tail = deferred<PaseoTimeline>();
  const after = deferred<PaseoTimeline>();
  runtime.impl = (options) =>
    options.direction === "tail" ? tail.promise : after.promise;
  const coordinator = new TimelineCoordinator(storage);
  const activating = coordinator.activate(activation(key, runtime));
  await settle();
  assert.equal(coordinator.currentSnapshot()?.stale, true);
  assert.equal(coordinator.currentSnapshot()?.rows.length, 1);

  runtime.emit(stream("agent", 3));
  tail.resolve(page("agent", "tail", 1, 2));
  await settle();
  assert.equal(coordinator.currentSnapshot()?.rows.at(-1)?.provisional, true);
  assert.equal(
    storage.records.get(timelineKey(key))?.rows.some((row) => row.provisional),
    false,
  );
  after.resolve(page("agent", "after", 3, 3));
  await activating;
  await settle();
  assert.equal(coordinator.currentSnapshot()?.rows.at(-1)?.provisional, false);

  const staleRuntime = new FakeRuntime();
  const staleTail = deferred<PaseoTimeline>();
  staleRuntime.impl = () => staleTail.promise;
  const staleActivation = coordinator.activate(
    activation({ serverId: "stale", agentId: "same" }, staleRuntime),
  );
  await settle();
  const currentRuntime = new FakeRuntime();
  currentRuntime.responses.push(
    page("same", "tail", 8, 8, { epoch: "epoch-current" }),
  );
  await coordinator.activate(
    activation({ serverId: "current", agentId: "same" }, currentRuntime, {
      connectionEpoch: 2,
    }),
  );
  staleTail.resolve(page("same", "tail", 99, 99, { epoch: "epoch-stale" }));
  await staleActivation;
  assert.equal(coordinator.currentSnapshot()?.rows[0]?.seqStart, 8);
});

test("replacement, malformed pages, and subscription order recover without poisoning siblings", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(
    page("one", "tail", 1, 1),
    page("one", "tail", 10, 10, { epoch: "epoch-2" }),
    page("two", "tail", 20, 20, { epoch: "epoch-2" }),
  );
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  const one = { serverId: "alpha", agentId: "one" };
  await coordinator.activate(activation(one, runtime));
  runtime.emit({
    type: "agent.timeline.replacement",
    agentId: "one",
    epoch: "epoch-2",
  });
  await settle();
  assert.equal(coordinator.currentSnapshot()?.range?.epoch, "epoch-2");
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "two" }, runtime),
  );
  assert.deepEqual(runtime.subscriptions, [["one"], [], ["two"]]);
  assert.equal(coordinator.currentSnapshot()?.rows[0]?.seqStart, 20);
  assert.equal(coordinator.snapshotFor(one)?.rows[0]?.seqStart, 10);

  const broken = new FakeRuntime();
  broken.responses.push({ ...page("bad", "tail", 1, 1), agentId: "wrong" });
  await coordinator.activate(
    activation({ serverId: "broken", agentId: "bad" }, broken),
  );
  assert.equal(coordinator.currentSnapshot()?.error, "sync_error");
  assert.equal(coordinator.snapshotFor(one)?.error, null);
});

test("an empty v0.7 timeline window is an authoritative bootstrap", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push({
    ...page("agent", "tail", 1, 1),
    window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
    startCursor: null,
    endCursor: null,
    entries: [],
  });
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  assert.equal(coordinator.currentSnapshot()?.rows.length, 0);
  assert.equal(coordinator.currentSnapshot()?.range, null);
  assert.equal(coordinator.currentSnapshot()?.stale, false);
  assert.equal(coordinator.currentSnapshot()?.error, null);
});

test("a rejected selective subscription retries and cannot be masked by tail success", async () => {
  const runtime = new FakeRuntime();
  runtime.subscriptionFailures = 1;
  runtime.responses.push(page("agent", "tail", 1, 1));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  await settle();
  assert.equal(runtime.subscriptionAttempts, 2);
  assert.deepEqual(runtime.subscriptions, [["agent"]]);
  assert.equal(coordinator.currentSnapshot()?.stale, false);
  assert.equal(coordinator.currentSnapshot()?.error, null);
});

test("older loading cannot hide an exhausted subscription failure", async () => {
  const runtime = new FakeRuntime();
  runtime.subscriptionFailures = 3;
  runtime.responses.push(page("agent", "tail", 1, 1, { hasOlder: true }));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  await settle();
  assert.equal(coordinator.currentSnapshot()?.error, "sync_error");
  const older = deferred<PaseoTimeline>();
  runtime.impl = () => older.promise;
  const loading = coordinator.loadOlder();
  assert.equal(coordinator.currentSnapshot()?.olderLoading, true);
  assert.equal(coordinator.currentSnapshot()?.error, "sync_error");
  older.resolve({
    ...page("agent", "before", 1, 1),
    window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
    startCursor: null,
    endCursor: null,
    entries: [],
  });
  await loading;
  assert.equal(coordinator.currentSnapshot()?.error, "sync_error");
});

test("a new source token for the same Agent fences its unresolved tail", async () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const staleRuntime = new FakeRuntime();
  const staleTail = deferred<PaseoTimeline>();
  staleRuntime.impl = () => staleTail.promise;
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  const staleActivation = coordinator.activate(activation(key, staleRuntime));
  await settle();

  const currentRuntime = new FakeRuntime();
  currentRuntime.responses.push(
    page("agent", "tail", 7, 7, { epoch: "epoch-current" }),
  );
  await coordinator.activate(
    activation(key, currentRuntime, { connectionEpoch: 2 }),
  );
  staleTail.resolve(page("agent", "tail", 99, 99, { epoch: "epoch-stale" }));
  await staleActivation;

  assert.equal(coordinator.currentSnapshot()?.range?.epoch, "epoch-current");
  assert.equal(coordinator.currentSnapshot()?.rows[0]?.seqStart, 7);
  assert.deepEqual(staleRuntime.subscriptions.at(-1), []);
});

test("tail refresh fences old catch-up and reconciles live events buffered during refresh", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(page("agent", "tail", 1, 1));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  const key = { serverId: "alpha", agentId: "agent" };
  await coordinator.activate(activation(key, runtime));

  const staleAfter = deferred<PaseoTimeline>();
  const refreshedTail = deferred<PaseoTimeline>();
  runtime.impl = (options) =>
    options.direction === "after" ? staleAfter.promise : refreshedTail.promise;
  runtime.emit(stream("agent", 2));
  const refreshing = coordinator.refresh();
  refreshedTail.resolve(page("agent", "tail", 1, 3));
  await refreshing;
  staleAfter.resolve(page("agent", "after", 2, 2));
  await settle();
  assert.equal(coordinator.currentSnapshot()?.range?.endSeq, 3);

  const liveTail = deferred<PaseoTimeline>();
  const published: number[][] = [];
  coordinator.subscribe(({ replicas }) => {
    published.push(
      (replicas.get(timelineKey(key))?.rows ?? [])
        .filter(({ provisional }) => provisional)
        .map(({ seqStart }) => seqStart),
    );
  });
  runtime.impl = (options) =>
    options.direction === "after"
      ? Promise.resolve(page("agent", "after", 4, 5))
      : liveTail.promise;
  const liveRefresh = coordinator.refresh();
  runtime.emit(stream("agent", 4));
  runtime.emit(stream("agent", 5));
  liveTail.resolve(page("agent", "tail", 1, 3));
  await liveRefresh;
  await settle();
  assert.equal(coordinator.currentSnapshot()?.range?.endSeq, 5);
  assert.equal(coordinator.currentSnapshot()?.rows.at(-1)?.provisional, false);
  assert.equal(
    published.some((seqs) => seqs.includes(4) && !seqs.includes(5)),
    false,
  );
});

test("a failed tail keeps buffered live rows visible and reports a recoverable error", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(page("agent", "tail", 1, 1));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  const tail = deferred<PaseoTimeline>();
  runtime.impl = () => tail.promise;
  const refresh = coordinator.refresh();
  runtime.emit(stream("agent", 2));
  tail.reject(new Error("fixture failure"));
  await refresh;
  assert.equal(coordinator.currentSnapshot()?.rows.at(-1)?.seqStart, 2);
  assert.equal(coordinator.currentSnapshot()?.rows.at(-1)?.provisional, true);
  assert.equal(coordinator.currentSnapshot()?.error, "sync_error");
});

test("unsequenced live rows stay provisional until authoritative projection replaces them", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(page("agent", "tail", 1, 1));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  const tail = deferred<PaseoTimeline>();
  runtime.impl = () => tail.promise;
  runtime.emit(stream("agent"));
  await settle();
  assert.equal(coordinator.currentSnapshot()?.rows.at(-1)?.provisional, true);
  const projected = page("agent", "after", 2, 2);
  tail.resolve({
    ...projected,
    entries: projected.entries.map((entry) => ({ ...entry, item: item(99) })),
  });
  await settle();
  assert.equal(
    coordinator.currentSnapshot()?.rows.some(({ provisional }) => provisional),
    false,
  );
  assert.equal(coordinator.currentSnapshot()?.range?.endSeq, 2);
});

test("stale cursor catch-up replaces from an authoritative tail", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(
    page("agent", "tail", 1, 1),
    { ...page("agent", "after", 2, 2), staleCursor: true },
    page("agent", "tail", 10, 10, { epoch: "epoch-2" }),
  );
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  runtime.emit(stream("agent", 3));
  await settle();
  assert.deepEqual(
    runtime.requests.map(({ direction }) => direction),
    ["tail", "after", "tail"],
  );
  assert.equal(coordinator.currentSnapshot()?.range?.epoch, "epoch-2");
  assert.equal(coordinator.currentSnapshot()?.error, null);
});

test("live input arriving during multi-page catch-up remains canonical", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(page("agent", "tail", 1, 1));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  const firstAfter = deferred<PaseoTimeline>();
  runtime.impl = () => firstAfter.promise;
  runtime.emit(stream("agent", 4));
  runtime.emit(stream("agent", 5));
  runtime.impl = () =>
    Promise.resolve(page("agent", "after", 4, 5, { hasNewer: false }));
  firstAfter.resolve(page("agent", "after", 2, 3, { hasNewer: true }));
  await settle();
  assert.equal(coordinator.currentSnapshot()?.range?.endSeq, 5);
  assert.equal(coordinator.currentSnapshot()?.rows.length, 5);
  assert.equal(
    coordinator.currentSnapshot()?.rows.some(({ provisional }) => provisional),
    false,
  );
});

test("a refreshed authority starts catch-up while its invalidated job is unresolved", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(page("agent", "tail", 1, 1));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );

  const oldAfter = deferred<PaseoTimeline>();
  const refreshedTail = deferred<PaseoTimeline>();
  const currentAfter = deferred<PaseoTimeline>();
  runtime.impl = (options) => {
    if (options.direction === "tail") return refreshedTail.promise;
    if (options.cursor?.seq === 1) return oldAfter.promise;
    return currentAfter.promise;
  };
  runtime.emit(stream("agent", 3));
  await settle();
  const refresh = coordinator.refresh();
  runtime.emit(stream("agent", 5));
  refreshedTail.resolve(page("agent", "tail", 1, 3));
  await refresh;
  await settle();
  assert.equal(
    runtime.requests.some(
      ({ direction, cursor }) => direction === "after" && cursor?.seq === 3,
    ),
    true,
  );

  oldAfter.resolve(page("agent", "after", 2, 3));
  await settle();
  assert.equal(coordinator.currentSnapshot()?.range?.endSeq, 3);
  assert.equal(coordinator.currentSnapshot()?.catchingUp, true);

  currentAfter.resolve(page("agent", "after", 4, 5));
  await settle();
  assert.equal(coordinator.currentSnapshot()?.range?.endSeq, 5);
  assert.equal(
    coordinator.currentSnapshot()?.rows.some(({ provisional }) => provisional),
    false,
  );
  assert.equal(coordinator.currentSnapshot()?.catchingUp, false);
});

test("concurrent older requests coalesce by the certified start cursor", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(page("agent", "tail", 3, 4, { hasOlder: true }));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  const older = deferred<PaseoTimeline>();
  runtime.impl = () => older.promise;
  const first = coordinator.loadOlder();
  const second = coordinator.loadOlder();
  assert.equal(first, second);
  assert.equal(
    runtime.requests.filter(({ direction }) => direction === "before").length,
    1,
  );
  older.resolve(page("agent", "before", 1, 3));
  await first;
  assert.equal(coordinator.currentSnapshot()?.range?.startSeq, 1);
});

test("binding deletes confirmed Agent and host removals but retains transient offline cache", async () => {
  const alpha = { serverId: "alpha", agentId: "one" };
  const alphaOther = { serverId: "alpha", agentId: "other" };
  const beta = { serverId: "beta", agentId: "two" };
  const storage = new MemoryStorage();
  for (const key of [alpha, alphaOther, beta])
    storage.records.set(
      timelineKey(key),
      cache(key, page(key.agentId, "tail", 1, 1)),
    );
  const alphaRuntime = leaseRuntime(alpha.agentId);
  const betaRuntime = leaseRuntime(beta.agentId);
  const directory = new FakeDirectorySource(
    directorySnapshot([alpha, beta], alpha),
  );
  const leases = new FakeLeaseSource([
    hostLease("alpha", alphaRuntime),
    hostLease("beta", betaRuntime),
  ]);
  const coordinator = new TimelineCoordinator(storage);
  const dispose = bindTimeline(coordinator, directory, leases);
  await settle();

  leases.emit([
    { ...hostLease("alpha", alphaRuntime), status: "offline" },
    hostLease("beta", betaRuntime),
  ]);
  await settle();
  assert.equal(storage.records.has(timelineKey(alpha)), true);
  assert.equal(storage.records.has(timelineKey(alphaOther)), true);

  directory.emit(directorySnapshot([beta], beta));
  await settle();
  assert.equal(storage.records.has(timelineKey(alpha)), false);
  assert.equal(storage.records.has(timelineKey(alphaOther)), true);

  leases.emit([hostLease("beta", betaRuntime)]);
  await settle();
  assert.equal(storage.records.has(timelineKey(alphaOther)), false);
  assert.equal(storage.records.has(timelineKey(beta)), true);
  dispose();
});

test("binding cleans startup removals and retries failed storage deletion", async () => {
  const removed = { serverId: "alpha", agentId: "removed" };
  const storage = new MemoryStorage();
  storage.records.set(
    timelineKey(removed),
    cache(removed, page(removed.agentId, "tail", 1, 1)),
  );
  const directory = new FakeDirectorySource({
    ...directorySnapshot([removed], removed),
    restoring: true,
  });
  const coordinator = new TimelineCoordinator(storage);
  const dispose = bindTimeline(coordinator, directory, new FakeLeaseSource([]));

  storage.failAgentDeletes = true;
  directory.emit(directorySnapshot([], null));
  await settle();
  assert.equal(storage.records.has(timelineKey(removed)), true);

  storage.failAgentDeletes = false;
  directory.emit(directorySnapshot([], null));
  await settle();
  assert.equal(storage.records.has(timelineKey(removed)), false);
  dispose();
});

test("binding cancels a failed cleanup when the identity reappears", async () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const storage = new MemoryStorage();
  storage.records.set(
    timelineKey(key),
    cache(key, page(key.agentId, "tail", 1, 1)),
  );
  const directory = new FakeDirectorySource(directorySnapshot([key], key));
  const coordinator = new TimelineCoordinator(storage);
  const dispose = bindTimeline(coordinator, directory, new FakeLeaseSource([]));

  storage.failAgentDeletes = true;
  directory.emit(directorySnapshot([], null));
  await settle();
  storage.failAgentDeletes = false;
  directory.emit(directorySnapshot([key], key));
  directory.emit(directorySnapshot([key], key));
  await settle();
  assert.equal(storage.records.has(timelineKey(key)), true);
  dispose();

  const hostStorage = new MemoryStorage();
  hostStorage.records.set(
    timelineKey(key),
    cache(key, page(key.agentId, "tail", 1, 1)),
  );
  const runtime = leaseRuntime(key.agentId);
  const hostLeases = new FakeLeaseSource([hostLease(key.serverId, runtime)]);
  const hostDispose = bindTimeline(
    new TimelineCoordinator(hostStorage),
    new FakeDirectorySource(directorySnapshot([], null)),
    hostLeases,
  );
  hostStorage.failHostDeletes = true;
  hostLeases.emit([]);
  await settle();
  hostStorage.failHostDeletes = false;
  hostLeases.emit([hostLease(key.serverId, runtime)]);
  hostLeases.emit([hostLease(key.serverId, runtime)]);
  await settle();
  assert.equal(hostStorage.records.has(timelineKey(key)), true);
  hostDispose();
});

test("delayed host cleanup preserves a replacement Timeline", async () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const storage = new MemoryStorage();
  storage.records.set(
    timelineKey(key),
    cache(key, page(key.agentId, "tail", 1, 1)),
  );
  const gate = deferred<void>();
  storage.hostDeleteBarrier = gate.promise;
  let absent = true;
  const deleting = new TimelineCoordinator(storage).deleteHost(
    key.serverId,
    () => absent,
  );
  await settle();
  absent = false;
  const replacement = cache(key, page(key.agentId, "tail", 2, 1));
  storage.records.set(timelineKey(key), replacement);
  gate.resolve();

  await assert.rejects(deleting, /stale/);
  assert.equal(storage.records.get(timelineKey(key)), replacement);
});

test("cache validation and explicit row/byte bounds preserve only certified rows", () => {
  const key = { serverId: "alpha", agentId: "agent" };
  const source = cache(key, page("agent", "tail", 1, MAX_TIMELINE_ROWS + 5));
  const bounded = boundTimelineCache(source);
  assert.equal(bounded.rows.length, MAX_TIMELINE_ROWS);
  assert.equal(bounded.hasOlder, true);
  assert.equal(bounded.range?.startSeq, 6);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(bounded)).byteLength <=
      MAX_TIMELINE_BYTES,
  );
  assert.equal(validateCachedTimeline(bounded, key), bounded);
  assert.throws(() =>
    validateCachedTimeline(
      { ...bounded, rows: [{ ...bounded.rows[0], provisional: true }] },
      key,
    ),
  );
  assert.notEqual(
    rowId("epoch", { type: "reasoning", text: "same" }, "turn", 1),
    rowId("epoch", { type: "reasoning", text: "same" }, "turn", 2),
  );

  const disjoint = boundTimelineCache({
    ...source,
    range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
    rows: [
      {
        ...source.rows[0]!,
        item: {
          ...item(1),
          text: "x".repeat(MAX_TIMELINE_BYTES),
        },
      },
      {
        ...source.rows[1]!,
        seqStart: 2,
        seqEnd: 4,
        sourceSeqRanges: [
          { startSeq: 2, endSeq: 2 },
          { startSeq: 4, endSeq: 4 },
        ],
      },
    ],
  });
  assert.equal(disjoint.range, null);
  assert.equal(disjoint.rows.length, 0);
});

test("projected envelopes cannot erase uncovered live rows or certify source gaps", () => {
  const live = {
    ...cache(
      { serverId: "alpha", agentId: "agent" },
      page("agent", "tail", 3, 3),
    ).rows[0]!,
    provisional: true,
  };
  const collapsed = {
    ...live,
    id: "tool:call-1",
    item: {
      type: "tool_call" as const,
      callId: "call-1",
      name: "fixture",
      detail: { type: "plain_text" as const, text: "redacted" },
      status: "completed" as const,
      error: null,
    },
    seqStart: 2,
    seqEnd: 4,
    sourceSeqRanges: [
      { startSeq: 2, endSeq: 2 },
      { startSeq: 4, endSeq: 4 },
    ],
    collapsed: ["tool_lifecycle" as const],
    provisional: false,
  };
  assert.equal(mergeTimelineRows([live], [collapsed]).length, 2);
  assert.throws(() =>
    normalizePage(
      { serverId: "alpha", agentId: "agent" },
      { ...page("agent", "after", 2, 4), entries: [collapsed] },
    ),
  );
  assert.throws(() =>
    normalizePage(
      { serverId: "alpha", agentId: "agent" },
      { ...page("agent", "tail", 1, 1), error: "fixture error" },
    ),
  );
  const outsideWindow = page("agent", "tail", 1, 2);
  assert.throws(() =>
    normalizePage(
      { serverId: "alpha", agentId: "agent" },
      {
        ...outsideWindow,
        window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
      },
    ),
  );
});

test("acceptance status hashes identities and never returns timeline content", async () => {
  const runtime = new FakeRuntime();
  runtime.responses.push(page("agent", "tail", 1, 1));
  const coordinator = new TimelineCoordinator(new MemoryStorage());
  await coordinator.activate(
    activation({ serverId: "alpha", agentId: "agent" }, runtime),
  );
  const status = timelineAcceptanceStatus(coordinator);
  assert.equal(status.rowCount, 1);
  assert.equal(status.range?.endSeq, 1);
  assert.equal(JSON.stringify(status).includes("text-1"), false);
  assert.equal(status.keyHash?.length, 8);
  assert.equal(status.subscriptionTargetHash, status.keyHash);
});

class FakeRuntime implements TimelineRuntime {
  readonly listeners = new Set<(event: PaseoTimelineEvent) => void>();
  readonly subscriptions: string[][] = [];
  readonly subscriptionRequests: string[][] = [];
  readonly requests: PaseoTimelineOptions[] = [];
  readonly responses: PaseoTimeline[] = [];
  subscriptionFailures = 0;
  subscriptionAttempts = 0;
  subscriptionImpl: ((agentIds: string[]) => Promise<void>) | null = null;
  impl: ((options: PaseoTimelineOptions) => Promise<PaseoTimeline>) | null =
    null;

  async getTimeline(
    _agentId: string,
    options: PaseoTimelineOptions = {},
  ): Promise<PaseoTimeline> {
    this.requests.push(options);
    if (this.impl) return this.impl(options);
    const response = this.responses.shift();
    if (!response) throw new Error("Missing timeline fixture response");
    return response;
  }

  async setTimelineSubscription(agentIds: string[]): Promise<void> {
    this.subscriptionAttempts++;
    this.subscriptionRequests.push(agentIds);
    if (this.subscriptionImpl) await this.subscriptionImpl(agentIds);
    if (this.subscriptionFailures-- > 0)
      throw new Error("Fixture subscription failure");
    this.subscriptions.push(agentIds);
  }

  subscribeTimeline(listener: (event: PaseoTimelineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: PaseoTimelineEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class MemoryStorage implements TimelineStorage {
  readonly records = new Map<string, CachedAgentTimeline>();
  failAgentDeletes = false;
  failHostDeletes = false;
  hostDeleteBarrier: Promise<void> | null = null;

  async loadAgent(key: AgentKey): Promise<unknown | null> {
    return this.records.get(timelineKey(key)) ?? null;
  }
  async putAgent(record: CachedAgentTimeline): Promise<void> {
    const key = timelineKey(record.key);
    const present = this.records.get(key);
    if (!present || present.revision < record.revision)
      this.records.set(key, record);
  }
  async deleteAgent(key: AgentKey): Promise<void> {
    if (this.failAgentDeletes) throw new Error("fixture delete failure");
    this.records.delete(timelineKey(key));
  }
  async deleteHost(
    serverId: string,
    stillRemoved: () => boolean = () => true,
  ): Promise<void> {
    if (this.failHostDeletes) throw new Error("fixture delete failure");
    await this.hostDeleteBarrier;
    if (!stillRemoved()) throw new Error("Host cleanup is stale");
    for (const [key, record] of this.records)
      if (record.key.serverId === serverId) this.records.delete(key);
  }
}

class FakeDirectorySource {
  private listener: (snapshot: GlobalAgentDirectorySnapshot) => void = () => {};

  constructor(private value: GlobalAgentDirectorySnapshot) {}

  snapshot(): GlobalAgentDirectorySnapshot {
    return this.value;
  }

  subscribe(listener: (snapshot: GlobalAgentDirectorySnapshot) => void) {
    this.listener = listener;
    listener(this.value);
    return () => {
      this.listener = () => {};
    };
  }

  emit(value: GlobalAgentDirectorySnapshot): void {
    this.value = value;
    this.listener(value);
  }
}

class FakeLeaseSource {
  private listener: HostRuntimeLeaseListener = () => {};

  constructor(private value: readonly HostRuntimeLease[]) {}

  subscribeRuntimeLeases(listener: HostRuntimeLeaseListener) {
    this.listener = listener;
    listener(this.value);
    return () => {
      this.listener = () => {};
    };
  }

  emit(value: readonly HostRuntimeLease[]): void {
    this.value = value;
    this.listener(value);
  }
}

function directorySnapshot(
  keys: readonly AgentKey[],
  current: AgentKey | null,
): GlobalAgentDirectorySnapshot {
  return {
    hosts: new Map(),
    orderedAgents: keys.map(({ serverId, agentId }) => ({
      serverId,
      agentId,
      workspaceId: null,
      projectId: null,
      projectKey: "fixture",
      projectName: "fixture",
      workspaceName: null,
      title: null,
      provider: "codex",
      model: null,
      thinkingOptionId: null,
      currentModeId: null,
      availableModes: [],
      status: "idle",
      activeTurn: null,
      createdAt: "2026-09-03T00:00:00Z",
      updatedAt: "2026-09-03T00:00:00Z",
      lastUserMessageAt: null,
      cwd: "/fixture",
      labels: {},
      archivedAt: null,
      pendingPermissions: [],
      syncSeq: 1,
    })),
    current,
    destination: current ? "agent" : "config",
    restoring: false,
  };
}

function leaseRuntime(agentId: string) {
  const timeline = new FakeRuntime();
  timeline.responses.push(page(agentId, "tail", 1, 1));
  return Object.assign(timeline, {
    getHost: () => null,
    listProjects: async () => ({ requestId: "projects", projects: [] }),
    listWorkspaces: async () => ({
      requestId: "workspaces",
      entries: [],
      emptyProjects: [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    }),
    listAgents: async () => ({
      requestId: "agents",
      entries: [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    }),
    getAgent: async () => null,
    listUsage: async () => ({
      requestId: "usage",
      fetchedAt: "2026-09-03T00:00:00Z",
      providers: [],
    }),
    subscribeDirectory: () => () => {},
  });
}

function hostLease(
  serverId: string,
  runtime: ReturnType<typeof leaseRuntime>,
): HostRuntimeLease {
  return {
    serverId,
    slotGeneration: 1,
    connectionEpoch: 1,
    status: "online",
    profile: {
      schemaVersion: 1,
      serverId,
      relayEndpoint: "relay.example:443",
      useTls: true,
      daemonPublicKey: "fixture-public-key",
      hostname: "fixture-host",
      createdAt: 1,
      updatedAt: 1,
    },
    runtime,
  };
}

function activation(
  key: AgentKey,
  runtime: TimelineRuntime,
  source: Partial<{ slotGeneration: number; connectionEpoch: number }> = {},
) {
  return {
    key,
    runtime,
    sourceToken: {
      serverId: key.serverId,
      slotGeneration: source.slotGeneration ?? 1,
      connectionEpoch: source.connectionEpoch ?? 1,
    },
  };
}

function stream(agentId: string, seq?: number): PaseoTimelineEvent {
  return {
    type: "agent_stream",
    agentId,
    event: {
      type: "timeline",
      provider: "codex",
      turnId: "turn",
      item: item(seq ?? 99),
    },
    timestamp: "2026-09-03T00:00:00Z",
    ...(seq === undefined ? {} : { seq, epoch: "epoch-1" }),
  };
}

function item(seq: number) {
  return {
    type: "assistant_message" as const,
    text: `text-${seq}`,
    messageId: `message-${seq}`,
  };
}

function page(
  agentId: string,
  direction: "tail" | "before" | "after",
  start: number,
  end: number,
  options: Partial<{
    epoch: string;
    hasOlder: boolean;
    hasNewer: boolean;
  }> = {},
): PaseoTimeline {
  const epoch = options.epoch ?? "epoch-1";
  return FetchAgentTimelineResponseMessageSchema.parse({
    type: "fetch_agent_timeline_response",
    payload: {
      requestId: `request-${direction}-${start}`,
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
      hasNewer: options.hasNewer ?? false,
      entries: Array.from({ length: end - start + 1 }, (_, offset) => {
        const seq = start + offset;
        return {
          provider: "codex",
          item: item(seq),
          turnId: "turn",
          timestamp: "2026-09-03T00:00:00Z",
          seqStart: seq,
          seqEnd: seq,
          sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
          collapsed: [],
        };
      }),
      error: null,
    },
  }).payload;
}

function cache(key: AgentKey, source: PaseoTimeline): CachedAgentTimeline {
  return {
    schemaVersion: 1,
    key,
    revision: 1,
    lastAuthoritativeSyncAt: 1,
    sourceToken: {
      serverId: key.serverId,
      slotGeneration: 1,
      connectionEpoch: 1,
    },
    range:
      source.startCursor && source.endCursor
        ? {
            epoch: source.epoch,
            startSeq: source.startCursor.seq,
            endSeq: source.endCursor.seq,
          }
        : null,
    hasOlder: source.hasOlder,
    hasNewer: source.hasNewer,
    rows: source.entries.map((entry) => ({
      ...entry,
      id: rowId(source.epoch, entry.item, entry.turnId, entry.seqStart),
      provisional: false,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let count = 0; count < 5; count++)
    await new Promise((resolve) => setImmediate(resolve));
}
