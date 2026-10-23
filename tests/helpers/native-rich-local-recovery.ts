import type { Page } from '@playwright/test';
import { getSchema, type JSONContent } from '@tiptap/core';
import { createDecoder, hasContent } from 'lib0/decoding';
import * as Y from 'yjs';

import { assertNativeDocumentSchema } from '../../app/lib/collaboration/native-document-schema';
import { readRichDocumentJson } from '../../app/lib/collaboration/rich-document';
import { collaborationStateProof } from '../../app/lib/collaboration/state-proof';
import { richMarkdownCodecExtensions } from '../../app/lib/markdown/rich-markdown-codec';

type RecoveryIdentity = { documentId: string; lifecycleGeneration: number; representation: string };

/** Read an existing committed log only; never create, flush or repair its DB. */
async function readCommittedUpdates(databaseName: string): Promise<number[][] | null> {
  const maxUpdates = 512, maxBytes = 4 * 1024 * 1024;
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    throw new Error('Native rich local recovery: database enumeration is unavailable.');
  }
  if (!(await indexedDB.databases()).some(database => database.name === databaseName)) return null;
  return new Promise<number[][]>((resolve, reject) => {
    let db: IDBDatabase | undefined, transaction: IDBTransaction | undefined;
    let settled = false, cursorEnded = false, totalBytes = 0;
    const updates: number[][] = [];
    const timer = setTimeout(() => fail('read timed out'), 5_000);
    function close(): void {
      const current = db; db = undefined;
      current?.close();
    }
    function fail(reason: string): void {
      if (settled) { try { close(); } catch { /* Already rejected. */ } return; }
      settled = true; clearTimeout(timer);
      try { transaction?.abort(); } catch { /* It may already be inactive. */ }
      try { close(); } catch { /* Preserve the read failure. */ }
      reject(new Error(`Native rich local recovery: ${reason}.`));
    }
    let open: IDBOpenDBRequest;
    try { open = indexedDB.open(databaseName); }
    catch { fail('database open failed'); return; }
    open.onblocked = () => fail('database open was blocked');
    open.onerror = () => fail('database open failed');
    open.onupgradeneeded = () => {
      // databases() and open() are separate operations. A deletion between
      // them must not let this observer create a replacement database.
      db = open.result;
      try { open.transaction?.abort(); } catch { /* Still reject and close. */ }
      fail('database was missing or required an upgrade');
    };
    open.onsuccess = () => {
      db = open.result;
      if (settled) { close(); return; }
      db.onversionchange = () => fail('database version changed');
      try {
        if (db.name !== databaseName || !db.objectStoreNames.contains('updates')) {
          fail('updates store is unavailable'); return;
        }
        transaction = db.transaction('updates', 'readonly');
        transaction.onerror = () => fail('readonly transaction failed');
        transaction.onabort = () => fail('readonly transaction aborted');
        transaction.oncomplete = () => {
          if (settled) return;
          if (!cursorEnded) { fail('transaction completed before the cursor ended'); return; }
          try { close(); } catch { fail('database close failed'); return; }
          settled = true; clearTimeout(timer); resolve(updates);
        };
        const request = transaction.objectStore('updates').openCursor();
        request.onerror = () => fail('updates cursor failed');
        request.onsuccess = () => {
          if (settled) return;
          try {
            const cursor = request.result;
            if (!cursor) { cursorEnded = true; return; }
            if (updates.length >= maxUpdates) { fail('update count bound exceeded'); return; }
            const value: unknown = cursor.value;
            const bytes = value instanceof Uint8Array && value.buffer instanceof ArrayBuffer
              ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
            if (!bytes || bytes.byteLength === 0) { fail('stored update is not binary'); return; }
            if (bytes.byteLength > maxBytes - totalBytes) { fail('update byte bound exceeded'); return; }
            totalBytes += bytes.byteLength;
            updates.push(Array.from(bytes));
            cursor.continue();
          } catch { fail('updates cursor failed'); }
        };
      } catch { fail('readonly transaction could not start'); }
    };
  });
}

/** Local recovery evidence only; this never certifies or requests remote persistence. */
export async function readNativeRichLocalRecovery(page: Page, identity: RecoveryIdentity): Promise<{
  document: JSONContent; stateProof: string; stateVector: string;
} | null> {
  if (typeof identity.documentId !== 'string' || !identity.documentId
    || identity.documentId.trim() !== identity.documentId || identity.documentId.includes('\0')
    || identity.documentId.length > 512 || !Number.isSafeInteger(identity.lifecycleGeneration)
    || identity.lifecycleGeneration <= 0 || identity.representation !== 'tiptap_blocks') {
    throw new Error('Native rich local recovery: invalid document identity or representation.');
  }
  const databaseName = `canvas:${identity.documentId}:${identity.lifecycleGeneration}:${identity.representation}`;
  const updates = await page.evaluate(readCommittedUpdates, databaseName);
  if (!updates?.length) return null;
  const doc = new Y.Doc({ gc: false });
  try {
    for (const update of updates) {
      const decoder = createDecoder(Uint8Array.from(update));
      // The public decoder form is applyUpdate's implementation, while also
      // allowing rejection of trailing bytes that applyUpdate alone ignores.
      Y.readUpdate(decoder, doc);
      if (hasContent(decoder)) throw new Error('Native rich local recovery: trailing update bytes.');
    }
    const stateProof = collaborationStateProof(doc, Y);
    if (!stateProof) throw new Error('Native rich local recovery: committed log is incomplete.');
    if (!doc.share.has('canvas-block-tree-v1') || doc.share.has('body')) {
      throw new Error('Native rich local recovery: committed log has a different native representation.');
    }
    const schema = getSchema(richMarkdownCodecExtensions());
    assertNativeDocumentSchema(doc, 'tiptap_blocks', schema);
    const document = JSON.parse(JSON.stringify(readRichDocumentJson(doc, schema))) as JSONContent;
    return { document, stateProof, stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64') };
  } finally { doc.destroy(); }
}
