import type { AgentKey, CachedHostDirectory, DirectoryStorage } from "./types";

const DATABASE = "glasseo-directory";
const VERSION = 1;
const HOSTS = "hosts";
const META = "meta";
const LAST_VIEWED = "lastViewedAgent";

export class IndexedDbDirectoryStorage implements DirectoryStorage {
  constructor(private readonly indexedDb: IDBFactory = indexedDB) {}

  async loadHost(serverId: string): Promise<unknown | null> {
    const db = await this.open();
    try {
      return (
        (await request(
          db.transaction(HOSTS).objectStore(HOSTS).get(serverId),
        )) ?? null
      );
    } finally {
      db.close();
    }
  }

  async listHostIds(): Promise<string[]> {
    const db = await this.open();
    try {
      const keys = await request(
        db.transaction(HOSTS).objectStore(HOSTS).getAllKeys(),
      );
      return keys.filter((key): key is string => typeof key === "string");
    } finally {
      db.close();
    }
  }

  putHost(directory: CachedHostDirectory): Promise<void> {
    return this.write(HOSTS, (store) => store.put(directory));
  }

  deleteHost(
    serverId: string,
    stillRemoved: () => boolean = () => true,
  ): Promise<void> {
    return this.write(HOSTS, (store) => store.delete(serverId), stillRemoved);
  }

  async getLastViewedAgent(): Promise<unknown | null> {
    const db = await this.open();
    try {
      return (
        (await request(
          db.transaction(META).objectStore(META).get(LAST_VIEWED),
        )) ?? null
      );
    } finally {
      db.close();
    }
  }

  putLastViewedAgent(key: AgentKey | null): Promise<void> {
    return this.write(META, (store) =>
      key ? store.put(key, LAST_VIEWED) : store.delete(LAST_VIEWED),
    );
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const open = this.indexedDb.open(DATABASE, VERSION);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(HOSTS))
          open.result.createObjectStore(HOSTS, { keyPath: "serverId" });
        if (!open.result.objectStoreNames.contains(META))
          open.result.createObjectStore(META);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () =>
        reject(open.error ?? new Error("IndexedDB open failed"));
    });
  }

  private async write(
    storeName: string,
    operation: (store: IDBObjectStore) => IDBRequest,
    stillCurrent: () => boolean = () => true,
  ): Promise<void> {
    const db = await this.open();
    try {
      if (!stillCurrent()) throw new Error("Host cleanup is stale");
      const transaction = db.transaction(storeName, "readwrite");
      operation(transaction.objectStore(storeName));
      await completion(transaction);
      if (!stillCurrent()) throw new Error("Host cleanup is stale");
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
