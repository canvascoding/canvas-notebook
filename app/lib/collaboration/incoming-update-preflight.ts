import type { Doc } from 'yjs';
import { Y } from './server-runtime';

// Match the existing full-state persistence ceiling. This bounds encoded
// scratch inputs, not decoded heap size or synchronous execution time.
const MAX_PREFLIGHT_STATE_BYTES = 64 * 1024 * 1024;

export class CollaborationIncomingUpdatePreflightError extends Error {
  constructor(readonly reason: 'basis_incomplete' | 'state_limit' | 'invalid_update' | 'missing_dependencies') {
    super('The collaboration update requires complete resynchronization.');
    this.name = 'CollaborationIncomingUpdatePreflightError';
  }
}

/** Called under the room mutation lock, before the final fresh authorization.
 * Wire updates may be deltas: completeness belongs to the current basis plus
 * this delta, never to the delta in isolation. No live update is applied here. */
export function assertNativeCollaborationUpdateComplete(document: Doc, update: Uint8Array): void {
  if (document.store.pendingStructs || document.store.pendingDs) {
    throw new CollaborationIncomingUpdatePreflightError('basis_incomplete');
  }
  const basis = Y.encodeStateAsUpdate(document);
  if (basis.byteLength > MAX_PREFLIGHT_STATE_BYTES) throw new CollaborationIncomingUpdatePreflightError('state_limit');
  const incoming = new Uint8Array(update);
  const candidate = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(candidate, basis);
    if (candidate.store.pendingStructs || candidate.store.pendingDs) {
      throw new CollaborationIncomingUpdatePreflightError('basis_incomplete');
    }
    try { Y.applyUpdate(candidate, incoming); }
    catch { throw new CollaborationIncomingUpdatePreflightError('invalid_update'); }
    if (candidate.store.pendingStructs || candidate.store.pendingDs) {
      throw new CollaborationIncomingUpdatePreflightError('missing_dependencies');
    }
    if (Y.encodeStateAsUpdate(candidate).byteLength > MAX_PREFLIGHT_STATE_BYTES) {
      throw new CollaborationIncomingUpdatePreflightError('state_limit');
    }
  } finally { candidate.destroy(); }
}
