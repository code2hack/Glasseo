import type { TimelineCoordinator } from "./coordinator";

export type TimelineAcceptanceStatus = Readonly<{
  keyHash: string | null;
  subscriptionTargetHash: string | null;
  epochHash: string | null;
  rowCount: number;
  range: { startSeq: number; endSeq: number } | null;
  hasOlder: boolean;
  hasNewer: boolean;
  stale: boolean;
  error: string | null;
  duplicateCount: number;
  gapCount: number;
}>;

export function timelineAcceptanceStatus(
  coordinator: TimelineCoordinator,
): TimelineAcceptanceStatus {
  const snapshot = coordinator.currentSnapshot();
  const subscription = coordinator.currentSubscriptionTarget();
  return {
    keyHash: snapshot
      ? hash(`${snapshot.key.serverId}\0${snapshot.key.agentId}`)
      : null,
    subscriptionTargetHash: subscription
      ? hash(`${subscription.serverId}\0${subscription.agentId}`)
      : null,
    epochHash: snapshot?.range ? hash(snapshot.range.epoch) : null,
    rowCount: snapshot?.rows.length ?? 0,
    range: snapshot?.range
      ? { startSeq: snapshot.range.startSeq, endSeq: snapshot.range.endSeq }
      : null,
    hasOlder: snapshot?.hasOlder ?? false,
    hasNewer: snapshot?.hasNewer ?? false,
    stale: snapshot?.stale ?? true,
    error: snapshot?.error ?? null,
    duplicateCount: snapshot?.duplicateCount ?? 0,
    gapCount: snapshot?.gapCount ?? 0,
  };
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
