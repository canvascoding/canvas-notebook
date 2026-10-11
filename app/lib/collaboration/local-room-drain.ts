import 'server-only';

import {
  captureCollaborationAdmissionDrainTicket,
  type CollaborationAdmissionDrainTicket,
} from './room-admission-drain';
import { CollaborationRoomOwnerError, type CollaborationRoomOwnerScope } from './room-owner';

type LocalRoomDrainer = Readonly<{
  drain: (ticket: CollaborationAdmissionDrainTicket) => Promise<void>;
  drainLegacy?: (scope: CollaborationRoomOwnerScope) => Promise<void>;
  releaseIdle?: (input: CollaborationDocumentIdleReleaseInput) => Promise<void>;
}>;
export type CollaborationDocumentIdleReleaseInput = Readonly<{
  scope: CollaborationRoomOwnerScope;
  operationId: string;
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

/** Private batch boundary: never closes peer connections or grants a lifecycle write. */
export async function ensureCollaborationDocumentIdleReleased(input: CollaborationDocumentIdleReleaseInput): Promise<void> {
  const drainer = registry.__canvasLocalRoomDrainer;
  if (!drainer?.releaseIdle) throw new CollaborationRoomOwnerError('ROOM_OWNER_UNAVAILABLE');
  if (!input.operationId.trim()) throw new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED');
  await drainer.releaseIdle(Object.freeze({ operationId: input.operationId, scope: Object.freeze({ ...input.scope }) }));
}
