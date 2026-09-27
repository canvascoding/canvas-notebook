import 'server-only';

import { CollaborationRoomOwnerError, type CollaborationRoomOwnerScope } from './room-owner';

type LocalRoomDrainer = (scope: CollaborationRoomOwnerScope) => Promise<void>;
const registry = globalThis as typeof globalThis & { __canvasLocalRoomDrainer?: LocalRoomDrainer };

export function installLocalCollaborationRoomDrainer(drainer: LocalRoomDrainer): () => void {
  registry.__canvasLocalRoomDrainer = drainer;
  return () => {
    if (registry.__canvasLocalRoomDrainer === drainer) delete registry.__canvasLocalRoomDrainer;
  };
}

/**
 * Drains one already-loaded local room. Not a distributed lifecycle permit:
 * callers must separately reserve admission across processes and retain the
 * document's database guard through any later lifecycle transaction.
 */
export async function drainLocalCollaborationRoom(scope: CollaborationRoomOwnerScope): Promise<void> {
  const drainer = registry.__canvasLocalRoomDrainer;
  if (!drainer) throw new CollaborationRoomOwnerError('ROOM_OWNER_UNAVAILABLE');
  await drainer(Object.freeze({ ...scope }));
}
