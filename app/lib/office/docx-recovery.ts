import type { DocxBaseline, DocxIdentity, DocxSaveRequest } from './docx-client';

export interface DocxRecoveryRecord<T> {
  version: 1;
  identity: DocxIdentity;
  baseline: DocxBaseline;
  originalBytes: Uint8Array;
  document: T;
  generation: number;
  savedGeneration: number;
  pendingRequest: (DocxSaveRequest & { generation: number }) | null;
  updatedAt: number;
}

export interface DocxRecoveryStore<T> {
  load(identity: DocxIdentity): Promise<DocxRecoveryRecord<T> | null>;
  save(record: DocxRecoveryRecord<T>): Promise<void>;
  discard?(record: DocxRecoveryRecord<T>): Promise<void>;
}

/** Session stays in the record, so reopening never silently borrows another tab's lease. */
export function docxRecoveryKey(identity: DocxIdentity): string {
  return JSON.stringify([identity.accountId, identity.workspaceId, identity.lineageId, identity.path]);
}

export function createDocxRecoveryStore<T>(factory?: IDBFactory): DocxRecoveryStore<T> & { discard(record: DocxRecoveryRecord<T>): Promise<void> } {
  let database: Promise<IDBDatabase> | null = null;
  function open(): Promise<IDBDatabase> {
    if (!database) {
      database = new Promise<IDBDatabase>((resolve, reject) => {
        const provider = factory ?? globalThis.indexedDB;
        if (!provider) { reject(new Error('Local document recovery is unavailable in this browser.')); return; }
        const request = provider.open('canvas-docx-recovery', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('documents').createIndex('scope', 'scope');
        request.onsuccess = () => {
          request.result.onversionchange = () => { request.result.close(); database = null; };
          resolve(request.result);
        };
        request.onerror = () => reject(request.error ?? new Error('Could not open local document recovery.'));
        request.onblocked = () => reject(new Error('Local document recovery is blocked by another browser tab.'));
      }).catch((error) => { database = null; throw error; });
    }
    return database;
  }
  return {
    async load(identity) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('documents', 'readonly');
        const request = transaction.objectStore('documents').index('scope').getAll(docxRecoveryKey(identity));
        transaction.oncomplete = () => {
          const records = (request.result as Array<{ record: DocxRecoveryRecord<T> }>).map((entry) => entry.record)
            .filter((record) => record.generation > record.savedGeneration || record.pendingRequest)
            .sort((left, right) => right.updatedAt - left.updatedAt);
          resolve(records.find((record) => record.identity.sessionId === identity.sessionId) ?? records[0] ?? null);
        };
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Could not read local document recovery.'));
      });
    },
    async save(record) {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('documents', 'readwrite');
        // put() uses structured cloning, preserving the editor model and original ZIP bytes.
        const scope = docxRecoveryKey(record.identity);
        // Separate keys prevent a second tab's clean state from replacing another tab's draft.
        transaction.objectStore('documents').put({ scope, record }, JSON.stringify([scope, record.identity.sessionId]));
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Could not save local document recovery.'));
      });
    },
    async discard(record) {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('documents', 'readwrite');
        const store = transaction.objectStore('documents');
        const key = JSON.stringify([docxRecoveryKey(record.identity), record.identity.sessionId]);
        const request = store.get(key);
        let conflict = false;
        request.onsuccess = () => {
          const current: DocxRecoveryRecord<T> | undefined = request.result?.record;
          if (!current) return;
          if (current.updatedAt !== record.updatedAt || current.generation !== record.generation || current.savedGeneration !== record.savedGeneration || current.pendingRequest?.idempotencyKey !== record.pendingRequest?.idempotencyKey) {
            conflict = true;
            transaction.abort();
            return;
          }
          store.delete(key);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(conflict
          ? new Error('This recovery changed in another tab. Review the newer draft before discarding it.')
          : (transaction.error ?? new Error('Could not discard local document recovery.')));
      });
    },
  };
}
