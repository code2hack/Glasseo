import { compositeKey } from "../directory/normalize";
import type { AgentKey } from "../directory/types";
import { validateDraftRecord } from "./model";
import type { DraftRecord, DraftStorage } from "./types";

const DATABASE = "glasseo-drafts";
const VERSION = 1;
const DRAFTS = "drafts";

type StoredDraft = {
  id: string;
  serverId: string;
  record: DraftRecord;
};

export function draftKey(key: AgentKey): string {
  return compositeKey(key.serverId, key.agentId);
}

export class IndexedDbDraftStorage implements DraftStorage {
  // ponytail: serialize low-volume Draft mutations globally; shard per Agent if throughput matters.
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly indexedDb: IDBFactory = indexedDB) {}

  async loadAgent(key: AgentKey): Promise<unknown | null> {
    const db = await this.open();
    try {
      const value = await request<StoredDraft | undefined>(
        db.transaction(DRAFTS).objectStore(DRAFTS).get(draftKey(key)),
      );
      return value?.record ?? null;
    } finally {
      db.close();
    }
  }

  async loadHost(serverId: string): Promise<unknown[]> {
    const db = await this.open();
    try {
      return (
        await request<StoredDraft[]>(
          db.transaction(DRAFTS).objectStore(DRAFTS).getAll(),
        )
      )
        .filter((value) => value.serverId === serverId)
        .map(({ record }) => record);
    } finally {
      db.close();
    }
  }

  async putAgent(record: DraftRecord): Promise<boolean> {
    let written = false;
    await this.enqueue(async () => {
      const db = await this.open();
      try {
        const transaction = db.transaction(DRAFTS, "readwrite");
        const store = transaction.objectStore(DRAFTS);
        const id = draftKey(record.key);
        const present = await request<StoredDraft | undefined>(store.get(id));
        let presentRevision = -1;
        if (present)
          try {
            presentRevision = validateDraftRecord(
              present.record,
              record.key,
            ).revision;
          } catch {
            // A corrupt row must not block a valid replacement.
          }
        if (presentRevision < record.revision) {
          store.put({ id, serverId: record.key.serverId, record });
          written = true;
        }
        await completion(transaction);
      } finally {
        db.close();
      }
    });
    return written;
  }

  deleteAgent(key: AgentKey): Promise<void> {
    return this.enqueue(() =>
      this.write((store) => store.delete(draftKey(key))),
    );
  }

  deleteHost(serverId: string): Promise<void> {
    return this.enqueue(async () => {
      const db = await this.open();
      try {
        const transaction = db.transaction(DRAFTS, "readwrite");
        const store = transaction.objectStore(DRAFTS);
        const values = await request<StoredDraft[]>(store.getAll());
        values
          .filter((value) => value.serverId === serverId)
          .forEach(({ id }) => store.delete(id));
        await completion(transaction);
      } finally {
        db.close();
      }
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => {});
    return result;
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const open = this.indexedDb.open(DATABASE, VERSION);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(DRAFTS))
          open.result.createObjectStore(DRAFTS, { keyPath: "id" });
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
      const transaction = db.transaction(DRAFTS, "readwrite");
      operation(transaction.objectStore(DRAFTS));
      await completion(transaction);
    } finally {
      db.close();
    }
  }
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
