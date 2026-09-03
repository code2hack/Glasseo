import type {
  NormalizedRequest,
  RequestAnswer,
  RequestAnswerStorage,
  RequestKey,
  RequestSession,
} from "./types";
import { createRequestSession, validateRequestAnswer } from "./model";

const DATABASE = "glasseo-request-answers";
const VERSION = 1;
const ANSWERS = "answers";

type StoredAnswer = {
  id: string;
  serverId: string;
  record: RequestAnswer;
};

export function requestAnswerKey(key: RequestKey): string {
  return JSON.stringify([key.serverId, key.agentId, key.requestId]);
}

export class IndexedDbRequestAnswerStorage implements RequestAnswerStorage {
  // ponytail: request answers are low volume; one queue prevents stale write/delete races.
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly indexedDb: IDBFactory = indexedDB) {}

  async load(key: RequestKey): Promise<unknown | null> {
    await this.writes;
    const db = await this.open();
    try {
      const value = await request<StoredAnswer | undefined>(
        db.transaction(ANSWERS).objectStore(ANSWERS).get(requestAnswerKey(key)),
      );
      return value?.record ?? null;
    } finally {
      db.close();
    }
  }

  async put(answer: RequestAnswer): Promise<boolean> {
    let written = false;
    await this.enqueue(async () => {
      const db = await this.open();
      try {
        const transaction = db.transaction(ANSWERS, "readwrite");
        const store = transaction.objectStore(ANSWERS);
        const id = requestAnswerKey(answer.key);
        const present = await request<StoredAnswer | undefined>(store.get(id));
        if (
          !present ||
          present.record.fingerprint !== answer.fingerprint ||
          present.record.revision < answer.revision
        ) {
          store.put({ id, serverId: answer.key.serverId, record: answer });
          written = true;
        }
        await completion(transaction);
      } finally {
        db.close();
      }
    });
    return written;
  }

  delete(key: RequestKey): Promise<void> {
    return this.enqueue(() =>
      this.mutate((store) => store.delete(requestAnswerKey(key))),
    );
  }

  deleteHost(serverId: string): Promise<void> {
    return this.enqueue(async () => {
      const db = await this.open();
      try {
        const transaction = db.transaction(ANSWERS, "readwrite");
        const store = transaction.objectStore(ANSWERS);
        const values = await request<StoredAnswer[]>(store.getAll());
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
        if (!open.result.objectStoreNames.contains(ANSWERS))
          open.result.createObjectStore(ANSWERS, { keyPath: "id" });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () =>
        reject(open.error ?? new Error("IndexedDB open failed"));
    });
  }

  private async mutate(
    operation: (store: IDBObjectStore) => IDBRequest,
  ): Promise<void> {
    const db = await this.open();
    try {
      const transaction = db.transaction(ANSWERS, "readwrite");
      operation(transaction.objectStore(ANSWERS));
      await completion(transaction);
    } finally {
      db.close();
    }
  }
}

export class RequestAnswerController {
  private readonly active = new Map<string, string>();

  constructor(private readonly storage: RequestAnswerStorage) {}

  async hydrate(
    model: NormalizedRequest,
    authoritative = true,
  ): Promise<RequestSession> {
    const id = requestAnswerKey(model.key);
    this.active.set(id, model.fingerprint);
    let answer: RequestAnswer | undefined;
    try {
      const raw = await this.storage.load(model.key);
      if (raw !== null) answer = validateRequestAnswer(raw, model);
    } catch {
      // One corrupt or stale row cannot affect its siblings.
    }
    if (this.active.get(id) !== model.fingerprint)
      return createRequestSession(model, undefined, false);
    return createRequestSession(model, answer, authoritative);
  }

  persist(session: RequestSession): Promise<boolean> {
    const id = requestAnswerKey(session.model.key);
    return this.active.get(id) === session.model.fingerprint &&
      session.answer.fingerprint === session.model.fingerprint
      ? this.storage.put(session.answer)
      : Promise.resolve(false);
  }

  async discard(key: RequestKey): Promise<void> {
    this.active.delete(requestAnswerKey(key));
    await this.storage.delete(key);
  }

  async discardHost(serverId: string): Promise<void> {
    for (const id of this.active.keys()) {
      const parsed: unknown = JSON.parse(id);
      if (Array.isArray(parsed) && parsed[0] === serverId)
        this.active.delete(id);
    }
    await this.storage.deleteHost(serverId);
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
