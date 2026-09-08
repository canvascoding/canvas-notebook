import { digest } from 'lib0/hash/sha256';
import type * as Y from 'yjs';

const prefix = 'yjs-snapshot-sha256-v1:';

export function isCollaborationStateProof(value: unknown): value is string {
  return typeof value === 'string' && /^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u.test(value);
}

/** State vectors omit deletions. A canonical Yjs snapshot includes both the
 * vector and merged delete ranges, independently of GC and update ordering.
 * This digest identifies state; it is not a recoverable document backup. */
export function collaborationStateProof(doc: Y.Doc, runtime: typeof Y): string | null {
  // An out-of-order update may contain unapplied structures/deletions. Never
  // certify only its already integrated subset as the complete document.
  if (doc.store.pendingStructs || doc.store.pendingDs) return null;
  const hash = digest(runtime.encodeSnapshot(runtime.snapshot(doc)));
  return prefix + Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Derive the proof from the persisted binary, never from a mutable live room. */
export function collaborationUpdateStateProof(update: Uint8Array, runtime: typeof Y): string | null {
  const doc = new runtime.Doc();
  try {
    runtime.applyUpdate(doc, update);
    return collaborationStateProof(doc, runtime);
  } finally { doc.destroy(); }
}
