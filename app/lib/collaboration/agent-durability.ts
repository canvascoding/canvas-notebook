import type * as Y from 'yjs';

/** A content-free receipt includes deletions, which a state vector alone omits. */
export function captureAgentStateSnapshot(doc: Y.Doc, runtime: typeof Y): Uint8Array | null {
  if (doc.store.pendingStructs || doc.store.pendingDs) return null;
  return runtime.encodeSnapshot(runtime.snapshot(doc));
}

/** Confirm the operation against persisted bytes, allowing later independent
 * edits. This temporary document is never attached to a room or written back. */
export function persistedUpdateIncludesAgentSnapshot(
  persistedUpdate: Uint8Array,
  expectedSnapshot: Uint8Array | null,
  runtime: typeof Y,
): boolean {
  if (!expectedSnapshot?.byteLength || !persistedUpdate?.byteLength) return false;
  let doc: Y.Doc | undefined;
  try {
    const expected = runtime.decodeSnapshot(expectedSnapshot);
    if (expected.sv.size === 0 && expected.ds.clients.size === 0) return false;
    // The decoder permits trailing bytes. Only accept the exact snapshot
    // encoding produced by captureAgentStateSnapshot, never a truncated or
    // extended payload that happens to contain a readable snapshot prefix.
    const encoded = runtime.encodeSnapshot(expected);
    if (encoded.byteLength !== expectedSnapshot.byteLength
      || !encoded.every((byte, index) => byte === expectedSnapshot[index])) return false;
    doc = new runtime.Doc();
    runtime.applyUpdate(doc, persistedUpdate);
    if (doc.store.pendingStructs || doc.store.pendingDs) return false;
    const actual = runtime.snapshot(doc);
    for (const [clientId, clock] of expected.sv) {
      if ((actual.sv.get(clientId) ?? 0) < clock) return false;
    }
    return runtime.equalDeleteSets(actual.ds, runtime.mergeDeleteSets([actual.ds, expected.ds]));
  } catch {
    return false;
  } finally {
    doc?.destroy();
  }
}
