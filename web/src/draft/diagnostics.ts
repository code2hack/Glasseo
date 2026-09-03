import { diagnosticHash } from "../app/hash";
import { availableDraftAreas } from "./model";
import type { DraftSnapshot } from "./types";

export function draftDiagnostics(snapshot: DraftSnapshot) {
  const session = snapshot.session;
  return {
    keyHash: snapshot.current
      ? diagnosticHash(
          `${snapshot.current.serverId}\0${snapshot.current.agentId}`,
        )
      : null,
    revision: session?.record.revision ?? 0,
    storageStatus: snapshot.storageStatus,
    activeArea: session?.record.activeArea ?? null,
    availableAreas: session ? availableDraftAreas(session) : [],
    requestCount: session?.requestIds.length ?? 0,
    imageCount: session?.record.images.length ?? 0,
    textLength: session?.record.text.length ?? 0,
    requestCursorHash: session?.record.cursors.requestId
      ? diagnosticHash(session.record.cursors.requestId)
      : null,
    imageCursorHash: session?.record.cursors.imageId
      ? diagnosticHash(session.record.cursors.imageId)
      : null,
    textOffset: session?.record.cursors.textOffset ?? 0,
  };
}
