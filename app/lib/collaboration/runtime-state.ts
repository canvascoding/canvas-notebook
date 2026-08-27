import 'server-only';

import { withKeyedOperationLock } from '@/app/lib/concurrency/keyed-operation-lock';

type RoomInspector = (documentId: string) => number;

let roomInspector: RoomInspector | null = null;
const pendingRoomAdmissions = new Map<string, number>();

const ROOM_ADMISSION_TIMEOUT_MS = 30_000;

export function installCollaborationRoomInspector(inspector: RoomInspector): () => void {
  roomInspector = inspector;
  return () => {
    if (roomInspector === inspector) roomInspector = null;
  };
}

export function getCollaborationRoomConnectionCount(documentId: string): number {
  return (roomInspector?.(documentId) ?? 0) + (pendingRoomAdmissions.get(documentId) ?? 0);
}

export function withCollaborationRoomLifecycleLock<T>(
  documentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withKeyedOperationLock('collaboration-room-lifecycle', documentId, operation);
}

/**
 * Reserves room occupancy after a ticket is validated but before Hocuspocus
 * registers the connection. Representation changes hold the same lifecycle
 * lock, so they either finish first or observe this admission as active.
 */
export function reserveCollaborationRoomAdmission(documentId: string): () => void {
  pendingRoomAdmissions.set(documentId, (pendingRoomAdmissions.get(documentId) ?? 0) + 1);
  let released = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (released) return;
    released = true;
    if (timeout) clearTimeout(timeout);
    const next = (pendingRoomAdmissions.get(documentId) ?? 1) - 1;
    if (next > 0) pendingRoomAdmissions.set(documentId, next);
    else pendingRoomAdmissions.delete(documentId);
  };
  timeout = setTimeout(release, ROOM_ADMISSION_TIMEOUT_MS);
  timeout.unref?.();
  return release;
}
