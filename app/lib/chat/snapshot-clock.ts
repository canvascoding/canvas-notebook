let lastSnapshotTimestamp = 0;

/** Epoch-based for persisted TTLs, strictly ordered even within one millisecond. */
export function nextChatSnapshotTimestamp(): number {
  lastSnapshotTimestamp = Math.max(Date.now(), lastSnapshotTimestamp + 0.001);
  return lastSnapshotTimestamp;
}
