import 'server-only';

import {
  captureCollaborationAdmissionDrainTicket,
  type CollaborationAdmissionDrainTicket,
} from './room-admission-drain';
import { CollaborationRoomOwnerError, type CollaborationRoomOwnerScope } from './room-owner';

type LocalRoomDrainer = Readonly<{
  drain: (ticket: CollaborationAdmissionDrainTicket) => Promise<void>;
  drainLegacy?: (scope: CollaborationRoomOwnerScope) => Promise<void>;
}>;
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
export async function drainLocalCollaborationRoom(input: CollaborationAdmissionDrainTicket): Promise<void> {
  const drainer = registry.__canvasLocalRoomDrainer;
  if (!drainer) throw new CollaborationRoomOwnerError('ROOM_OWNER_UNAVAILABLE');
  await drainer.drain(captureCollaborationAdmissionDrainTicket(input));
}

/** Inactive compatibility path for existing single-process diagnostics only. */
export async function drainLocalCollaborationRoomLegacy(scope: CollaborationRoomOwnerScope): Promise<void> {
  const drainer = registry.__canvasLocalRoomDrainer;
  if (!drainer?.drainLegacy) throw new CollaborationRoomOwnerError('ROOM_OWNER_UNAVAILABLE');
  await drainer.drainLegacy(Object.freeze({ ...scope }));
}
