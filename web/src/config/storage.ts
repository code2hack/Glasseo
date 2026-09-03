import {
  CONFIG_UI_VERSION,
  type ConfigStorage,
  type StoredConfigUi,
} from "./types";

const DATABASE = "glasseo-config-ui";
const VERSION = 1;
const STORE = "state";
const KEY = "config";

export class IndexedDbConfigStorage implements ConfigStorage {
  constructor(private readonly indexedDb: IDBFactory = indexedDB) {}

  async load(): Promise<unknown | null> {
    const db = await this.open();
    try {
      return (
        (await request(db.transaction(STORE).objectStore(STORE).get(KEY))) ??
        null
      );
    } finally {
      db.close();
    }
  }

  async put(value: StoredConfigUi): Promise<void> {
    const db = await this.open();
    try {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const present = await request<StoredConfigUi | undefined>(store.get(KEY));
      if (
        !present ||
        present.revision < value.revision ||
        (present.revision === value.revision &&
          present.updatedAt <= value.updatedAt)
      )
        store.put(value, KEY);
      await completion(transaction);
    } finally {
      db.close();
    }
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const open = this.indexedDb.open(DATABASE, VERSION);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE))
          open.result.createObjectStore(STORE);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () =>
        reject(open.error ?? new Error("IndexedDB open failed"));
    });
  }
}

export function validateStoredConfigUi(value: unknown): StoredConfigUi {
  if (!record(value)) throw new Error("Stored Config state is invalid");
  const expanded = value.expandedRowIds;
  if (
    Object.keys(value).length !== 5 ||
    value.schemaVersion !== CONFIG_UI_VERSION ||
    !nonnegativeInteger(value.revision) ||
    !nonnegativeInteger(value.updatedAt) ||
    !Array.isArray(expanded) ||
    !expanded.every((id) => typeof id === "string") ||
    new Set(expanded).size !== expanded.length ||
    !(value.focusedRowId === null || typeof value.focusedRowId === "string")
  )
    throw new Error("Stored Config state is invalid");
  return value as unknown as StoredConfigUi;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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
