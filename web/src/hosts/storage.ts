import type { HostStorage, StoredHostProfile } from "./types";

const DATABASE = "glasseo-hosts";
const VERSION = 1;
const PROFILES = "profiles";
const META = "meta";
const CLIENT_ID = "clientId";

export class IndexedDbHostStorage implements HostStorage {
  constructor(private readonly indexedDb: IDBFactory = indexedDB) {}

  async loadProfiles(): Promise<unknown[]> {
    const db = await this.open();
    try {
      return await request(
        db.transaction(PROFILES).objectStore(PROFILES).getAll(),
      );
    } finally {
      db.close();
    }
  }

  putProfile(profile: StoredHostProfile): Promise<void> {
    return this.write(PROFILES, (store) => store.put(profile));
  }

  deleteProfile(serverId: string): Promise<void> {
    return this.write(PROFILES, (store) => store.delete(serverId));
  }

  async getClientId(): Promise<string | null> {
    const db = await this.open();
    try {
      const value: unknown = await request(
        db.transaction(META).objectStore(META).get(CLIENT_ID),
      );
      return typeof value === "string" && /^[0-9a-f]{32}$/.test(value)
        ? value
        : null;
    } finally {
      db.close();
    }
  }

  putClientId(clientId: string): Promise<void> {
    return this.write(META, (store) => store.put(clientId, CLIENT_ID));
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const open = this.indexedDb.open(DATABASE, VERSION);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(PROFILES))
          open.result.createObjectStore(PROFILES, { keyPath: "serverId" });
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
  ): Promise<void> {
    const db = await this.open();
    try {
      const transaction = db.transaction(storeName, "readwrite");
      operation(transaction.objectStore(storeName));
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
