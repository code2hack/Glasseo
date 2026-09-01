import { probePaseoBundleAndCrypto } from "../paseo/adapter";

export type ProbeSummary = {
  passed: boolean;
  checks: Record<string, boolean>;
  details: Record<string, string>;
};

const expectedOrigin = "https://appassets.androidplatform.net";

export async function runWebViewProbe(): Promise<ProbeSummary> {
  const checks: Record<string, boolean> = {};
  const details: Record<string, string> = {};

  await check("localHttpsOrigin", () => location.origin === expectedOrigin);
  await check("textCodec", () => {
    const value = "Glasseo 眼鏡";
    return new TextDecoder().decode(new TextEncoder().encode(value)) === value;
  });
  await check("promiseScheduling", async () => {
    const order: number[] = [];
    order.push(1);
    const value = await Promise.resolve().then(() => {
      order.push(2);
      return 3;
    });
    order.push(value);
    return order.join(",") === "1,2,3";
  });
  await check("structuredStorageReopen", probeIndexedDb);
  await check("secureRandom", () => {
    const a = new Uint8Array(32);
    const b = new Uint8Array(32);
    crypto.getRandomValues(a);
    crypto.getRandomValues(b);
    return (
      a.some((byte) => byte !== 0) && a.some((byte, index) => byte !== b[index])
    );
  });
  await check("paseoRelayCrypto", probePaseoBundleAndCrypto);
  await check("binaryWss", probeWebSocket);
  await check("untrustedBridgeRejected", probeUntrustedFrame);
  await check("remoteNavigationRejected", probeRemoteNavigation);

  return { passed: Object.values(checks).every(Boolean), checks, details };

  async function check(name: string, probe: () => boolean | Promise<boolean>) {
    try {
      checks[name] = (await probe()) === true;
      details[name] = checks[name] ? "PASS" : "returned false";
    } catch (error) {
      checks[name] = false;
      details[name] = error instanceof Error ? error.message : String(error);
    }
  }
}

async function probeIndexedDb(): Promise<boolean> {
  const name = "glasseo-compat-probe";
  const token = `persisted-${Date.now()}`;
  const first = await openDatabase(name, 1, true);
  await transact(first, "readwrite", (store) =>
    store.put({ id: "probe", token }),
  );
  first.close();

  const reopened = await openDatabase(name, 1, false);
  const record = (await transact(reopened, "readonly", (store) =>
    store.get("probe"),
  )) as { token?: string } | undefined;
  reopened.close();
  indexedDB.deleteDatabase(name);
  return record?.token === token;
}

function openDatabase(
  name: string,
  version: number,
  create: boolean,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      if (create && !request.result.objectStoreNames.contains("records")) {
        request.result.createObjectStore("records", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  requestFactory: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = requestFactory(
      database.transaction("records", mode).objectStore("records"),
    );
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function probeWebSocket(): Promise<boolean> {
  const override = new URLSearchParams(location.search).get("wss");
  const endpoints = override
    ? [override]
    : ["wss://echo.websocket.org", "wss://ws.postman-echo.com/raw"];
  for (const endpoint of endpoints) {
    if (await probeWebSocketEndpoint(endpoint).catch(() => false)) return true;
  }
  return false;
}

function probeWebSocketEndpoint(endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const text = `glasseo-${Date.now()}`;
    const binary = new Uint8Array([0, 17, 128, 255]);
    let textPassed = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("WSS probe timed out"));
    }, 12_000);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => socket.send(text);
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        if (event.data !== text) return;
        textPassed = true;
        socket.send(binary.buffer);
        return;
      }
      const actual = new Uint8Array(event.data as ArrayBuffer);
      clearTimeout(timeout);
      socket.close();
      resolve(
        textPassed &&
          actual.length === binary.length &&
          actual.every((v, i) => v === binary[i]),
      );
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("WSS connection failed"));
    };
  });
}

function probeUntrustedFrame(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.src =
      "data:text/html," +
      encodeURIComponent(
        "<script>parent.postMessage({type:'glasseo-untrusted',present:typeof glasseoNative!=='undefined'},'*')</script>",
      );
    const timeout = setTimeout(
      () => reject(new Error("Untrusted frame probe timed out")),
      5_000,
    );
    window.addEventListener(
      "message",
      (event) => {
        if (
          event.source !== iframe.contentWindow ||
          event.data?.type !== "glasseo-untrusted"
        )
          return;
        clearTimeout(timeout);
        iframe.remove();
        resolve(event.data.present === false);
      },
      { once: false },
    );
    document.body.append(iframe);
  });
}

async function probeRemoteNavigation(): Promise<boolean> {
  const anchor = document.createElement("a");
  anchor.href = "https://example.com/glasseo-navigation-probe";
  anchor.textContent = "navigation probe";
  anchor.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  return location.origin === expectedOrigin;
}
