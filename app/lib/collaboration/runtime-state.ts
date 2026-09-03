import 'server-only';

import { withKeyedOperationLock } from '@/app/lib/concurrency/keyed-operation-lock';

type RoomInspector = (documentId: string) => number;

// Next route bundles and the custom WebSocket server load separate module graphs.
// Keep their room occupancy and pending admissions in the same process registry.
const processState = globalThis as typeof globalThis & {
  __canvasCollaborationRooms?: { inspector: RoomInspector | null; admissions: Map<string, number> };
};
const rooms = processState.__canvasCollaborationRooms ??= { inspector: null, admissions: new Map() };

const ROOM_ADMISSION_TIMEOUT_MS = 30_000;

export function installCollaborationRoomInspector(inspector: RoomInspector): () => void {
  rooms.inspector = inspector;
  return () => {
    if (rooms.inspector === inspector) rooms.inspector = null;
  };
}

export function getCollaborationRoomConnectionCount(documentId: string): number {
  return (rooms.inspector?.(documentId) ?? 0) + (rooms.admissions.get(documentId) ?? 0);
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
  rooms.admissions.set(documentId, (rooms.admissions.get(documentId) ?? 0) + 1);
  let released = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (released) return;
    released = true;
    if (timeout) clearTimeout(timeout);
    const next = (rooms.admissions.get(documentId) ?? 1) - 1;
    if (next > 0) rooms.admissions.set(documentId, next);
    else rooms.admissions.delete(documentId);
  };
  timeout = setTimeout(release, ROOM_ADMISSION_TIMEOUT_MS);
  timeout.unref?.();
  return release;
}
