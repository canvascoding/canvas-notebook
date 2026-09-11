import { encodeStateAsUpdate, type Doc } from 'yjs';
import type { IndexeddbPersistence } from 'y-indexeddb';

const exportedSnapshots = new WeakMap<Doc, Uint8Array>();
const equalBytes = (left: Uint8Array, right: Uint8Array) => left.length === right.length
  && left.every((value, index) => value === right[index]);

export function recordExportedCollaborationRecovery(doc: Doc, snapshot: Uint8Array): void {
  exportedSnapshots.set(doc, snapshot.slice());
}

export function hasExportedCollaborationRecovery(doc: Doc): boolean {
  const exported = exportedSnapshots.get(doc);
  return Boolean(exported && equalBytes(exported, encodeStateAsUpdate(doc)));
}

/** Resolve only after IndexedDB commits the full document, including its delete set. */
export async function preserveLocalCollaborationRecovery(persistence: IndexeddbPersistence, doc: Doc): Promise<Uint8Array> {
  if (doc.isDestroyed) throw new Error('Collaboration document was closed.');
  if (!persistence.synced) throw new Error('Local collaboration storage is not ready.');
  const database = persistence.db;
  if (!database) throw new Error('Local collaboration storage is unavailable.');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = encodeStateAsUpdate(doc);
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('updates', 'readwrite');
      const timeout = setTimeout(() => {
        try { transaction.abort(); } catch { /* The transaction may already have completed. */ }
        reject(new Error('Local collaboration backup timed out.'));
      }, 5_000);
      transaction.oncomplete = () => { clearTimeout(timeout); resolve(); };
      transaction.onabort = transaction.onerror = () => {
        clearTimeout(timeout);
        reject(transaction.error ?? new Error('Local collaboration backup failed.'));
      };
      try { transaction.objectStore('updates').add(snapshot); }
      catch (error) {
        clearTimeout(timeout);
        try { transaction.abort(); } catch { /* The transaction may already have aborted. */ }
        reject(error);
      }
    });
    if (doc.isDestroyed) throw new Error('Collaboration document was closed.');
    if (equalBytes(snapshot, encodeStateAsUpdate(doc))) return snapshot;
  }
  throw new Error('The document changed while its local backup was being saved.');
}

export async function prepareRecoverableCollaborationTransition(input: {
  doc: Doc;
  isPersistedCurrent: () => boolean;
  preserveLocalSnapshot: () => Promise<void>;
}): Promise<void> {
  // A view lifetime is independent of the asynchronous Markdown projection.
  if (input.isPersistedCurrent() || hasExportedCollaborationRecovery(input.doc)) return;
  await input.preserveLocalSnapshot();
}
