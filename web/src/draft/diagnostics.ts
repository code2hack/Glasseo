import { availableDraftAreas } from "./model";
import type { DraftSnapshot } from "./types";

export async function draftDiagnostics(snapshot: DraftSnapshot) {
  const session = snapshot.session;
  const [keyHash, requestCursorHash, imageCursorHash] = await Promise.all([
    snapshot.current
      ? hash(`${snapshot.current.serverId}\0${snapshot.current.agentId}`)
      : null,
    session?.record.cursors.requestId
      ? hash(session.record.cursors.requestId)
      : null,
    session?.record.cursors.imageId
      ? hash(session.record.cursors.imageId)
      : null,
  ]);
  return {
    keyHash,
    revision: session?.record.revision ?? 0,
    storageStatus: snapshot.storageStatus,
    activeArea: session?.record.activeArea ?? null,
    availableAreas: session ? availableDraftAreas(session) : [],
    requestCount: session?.requestIds.length ?? 0,
    imageCount: session?.record.images.length ?? 0,
    textLength: session?.record.text.length ?? 0,
    requestCursorHash,
    imageCursorHash,
    textOffset: session?.record.cursors.textOffset ?? 0,
  };
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
