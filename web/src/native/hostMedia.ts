import { postNative } from "./bridge";

type HostMediaCleanupResult = Readonly<{
  type: "host-media-cleanup-result";
  requestId: number;
  deleted: number;
}>;

let nextRequestId = 0;

export function cleanupHostMedia(serverId: string): Promise<void> {
  const requestId = ++nextRequestId;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => finish(new Error("Media cleanup timed out")),
      5_000,
    );
    const receive = (event: MessageEvent<unknown>) => {
      try {
        const result = decodeHostMediaCleanupResult(event.data);
        if (result.requestId === requestId) finish();
      } catch {
        // Unrelated native messages are ignored.
      }
    };
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
      if (error) reject(error);
      else resolve();
    };
    window.addEventListener("message", receive);
    try {
      postNative({ type: "host-media-cleanup", requestId, serverId });
    } catch (error) {
      finish(
        error instanceof Error ? error : new Error("Media cleanup failed"),
      );
    }
  });
}

export function decodeHostMediaCleanupResult(
  value: unknown,
): HostMediaCleanupResult {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object")
    throw new Error("Invalid media cleanup result");
  const result = parsed as Record<string, unknown>;
  if (
    Object.keys(result).length === 3 &&
    result.type === "host-media-cleanup-result" &&
    Number.isSafeInteger(result.requestId) &&
    (result.requestId as number) > 0 &&
    Number.isSafeInteger(result.deleted) &&
    (result.deleted as number) >= 0
  )
    return result as HostMediaCleanupResult;
  throw new Error("Unknown or malformed media cleanup result");
}
