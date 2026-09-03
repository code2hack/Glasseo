import type { AgentKey } from "../directory/types";
import { timelineKey } from "./normalize";
import type { CachedAgentTimeline, TimelineStorage } from "./types";

const DATABASE = "glasseo-timeline";
const VERSION = 1;
const TIMELINES = "timelines";
export const MAX_TIMELINE_ROWS = 500;
export const MAX_TIMELINE_BYTES = 1_000_000;
export const MAX_TIMELINE_AGENTS = 32;
// ponytail: serialize low-volume cache mutations globally; shard by Agent if write throughput matters.
let writes: Promise<void> = Promise.resolve();

type StoredRecord = {
  id: string;
  serverId: string;
  record: CachedAgentTimeline;
};

export class IndexedDbTimelineStorage implements TimelineStorage {
  constructor(private readonly indexedDb: IDBFactory = indexedDB) {}

  async loadAgent(key: AgentKey): Promise<unknown | null> {
    const db = await this.open();
    try {
      const stored = await request<StoredRecord | undefined>(
        db.transaction(TIMELINES).objectStore(TIMELINES).get(timelineKey(key)),
      );
      return stored?.record ?? null;
    } finally {
      db.close();
    }
  }

  putAgent(input: CachedAgentTimeline): Promise<void> {
    return this.enqueue(() => this.writeAgent(input));
  }

  private async writeAgent(input: CachedAgentTimeline): Promise<void> {
    const record = boundTimelineCache(input);
    const db = await this.open();
    try {
      const transaction = db.transaction(TIMELINES, "readwrite");
      const store = transaction.objectStore(TIMELINES);
      const id = timelineKey(record.key);
      const present = await request<StoredRecord | undefined>(store.get(id));
      if (!present || present.record.revision < record.revision)
        store.put({ id, serverId: record.key.serverId, record });
      const records = await request<StoredRecord[]>(store.getAll());
      records
        .filter(({ id: candidate }) => candidate !== id)
        .sort(
          (a, b) =>
            b.record.lastAuthoritativeSyncAt - a.record.lastAuthoritativeSyncAt,
        )
        .slice(MAX_TIMELINE_AGENTS - 1)
        .forEach(({ id: expired }) => store.delete(expired));
      await completion(transaction);
    } finally {
      db.close();
    }
  }

  deleteAgent(key: AgentKey): Promise<void> {
    return this.enqueue(() =>
      this.write((store) => store.delete(timelineKey(key))),
    );
  }

  deleteHost(serverId: string): Promise<void> {
    return this.enqueue(() => this.writeHostDeletion(serverId));
  }

  private async writeHostDeletion(serverId: string): Promise<void> {
    const db = await this.open();
    try {
      const transaction = db.transaction(TIMELINES, "readwrite");
      const store = transaction.objectStore(TIMELINES);
      const records = await request<StoredRecord[]>(store.getAll());
      records
        .filter((record) => record.serverId === serverId)
        .forEach(({ id }) => store.delete(id));
      await completion(transaction);
    } finally {
      db.close();
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = writes.then(operation);
    writes = result.catch(() => {});
    return result;
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const open = this.indexedDb.open(DATABASE, VERSION);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(TIMELINES))
          open.result.createObjectStore(TIMELINES, { keyPath: "id" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () =>
        reject(open.error ?? new Error("IndexedDB open failed"));
    });
  }

  private async write(
    operation: (store: IDBObjectStore) => IDBRequest,
  ): Promise<void> {
    const db = await this.open();
    try {
      const transaction = db.transaction(TIMELINES, "readwrite");
      operation(transaction.objectStore(TIMELINES));
      await completion(transaction);
    } finally {
      db.close();
    }
  }
}

export function boundTimelineCache(
  input: CachedAgentTimeline,
): CachedAgentTimeline {
  let rows = input.rows.slice(-MAX_TIMELINE_ROWS);
  // ponytail: O(n²) serialization is capped at 500 rows; track byte deltas if this bound grows.
  while (
    rows.length > 0 &&
    encodedBytes({ ...input, rows }) > MAX_TIMELINE_BYTES
  )
    rows = rows.slice(1);
  let range = retainedRange(rows, input.range);
  while (rows.length > 0 && range === null) {
    rows = rows.slice(1);
    range = retainedRange(rows, input.range);
  }
  if (rows.length === input.rows.length) return input;
  return {
    ...input,
    rows,
    range,
    hasOlder: input.hasOlder || input.rows.length > rows.length,
  };
}

function retainedRange(
  rows: CachedAgentTimeline["rows"],
  original: CachedAgentTimeline["range"],
): CachedAgentTimeline["range"] {
  if (!original || rows.length === 0) return null;
  const ranges = rows
    .flatMap(({ sourceSeqRanges }) => sourceSeqRanges)
    .sort(
      (left, right) =>
        left.startSeq - right.startSeq || left.endSeq - right.endSeq,
    );
  const first = ranges[0];
  if (!first) return null;
  let coveredThrough = first.endSeq;
  for (const range of ranges.slice(1)) {
    if (range.startSeq > coveredThrough + 1) return null;
    coveredThrough = Math.max(coveredThrough, range.endSeq);
  }
  return coveredThrough === original.endSeq
    ? { ...original, startSeq: first.startSeq }
    : null;
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () =>
      reject(value.error ?? new Error("IndexedDB request failed"));
  });
}

function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}
