import type { Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { digest } from 'lib0/hash/sha256';
import * as Y from 'yjs';

type NativeSnapshotInput = {
  document: JSONContent;
  localClient: number;
  guid: string;
  clients: Array<{ client: number; clock: number; deleted: Array<{ clock: number; len: number }> }>;
};

type BrowserStruct = { id: { client: number; clock: number }; length: number; deleted: boolean };
type BrowserDoc = {
  isDestroyed: boolean;
  clientID: number;
  guid: string;
  share: Map<string, unknown>;
  store: { clients: Map<number, BrowserStruct[]>; pendingStructs: unknown; pendingDs: unknown };
};
type ExistingMap = { get(key: string): unknown };
type BrowserBinding = {
  ready: boolean;
  destroyed: boolean;
  lastError: string | null;
  composing: boolean;
  compositionTree: unknown;
  options: { document: BrowserDoc };
  tree: { doc: BrowserDoc; root: ExistingMap; records: unknown } | null;
};

/** Serialized by Playwright: keep every runtime dependency inside this callback. */
function readBoundSnapshot(element: HTMLElement | SVGElement): NativeSnapshotInput {
  const maxClients = 64, maxStructs = 16_384, maxDeletedRanges = 16_384, maxDocumentCharacters = 1_048_576;
  function fail(reason: string): never { throw new Error(`Native rich candidate: ${reason}.`); }
  const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const editor = (element as unknown as { editor?: {
    isDestroyed: boolean;
    getJSON(): JSONContent;
    storage?: { canvasBlockTreeCollaboration?: { binding?: BrowserBinding | null } };
  } }).editor;
  const binding = editor?.storage?.canvasBlockTreeCollaboration?.binding;
  const doc = binding?.options?.document;
  if (!editor || editor.isDestroyed !== false || typeof editor.getJSON !== 'function'
    || !binding || binding.ready !== true || binding.destroyed !== false || binding.lastError !== null
    || binding.composing !== false || binding.compositionTree !== null || !doc || doc.isDestroyed !== false
    || !binding.tree || binding.tree.doc !== doc) fail('binding is not a ready live document');
  if (!(doc.share instanceof Map) || !(doc.store?.clients instanceof Map)
    || doc.store.pendingStructs !== null || doc.store.pendingDs !== null) fail('document is incomplete');
  const root = doc.share.get('canvas-block-tree-v1') as ExistingMap | undefined;
  if (!root || root !== binding.tree.root || typeof root.get !== 'function'
    || root.get('version') !== 1 || root.get('records') !== binding.tree.records || doc.share.has('body')) {
    fail('binding retains a different native tree');
  }
  if (!integer(doc.clientID) || typeof doc.guid !== 'string' || !doc.guid || doc.guid.length > 256) {
    fail('document identity is invalid');
  }
  if (doc.store.clients.size > maxClients) fail('client bound exceeded');

  const serialized = JSON.stringify(editor.getJSON());
  if (typeof serialized !== 'string' || serialized.length > maxDocumentCharacters) fail('document bound exceeded');
  const document = JSON.parse(serialized) as JSONContent;
  if (!document || document.type !== 'doc') fail('editor has no document projection');
  const clients: NativeSnapshotInput['clients'] = [];
  let structCount = 0, deletedRangeCount = 0;
  for (const [client, structs] of doc.store.clients) {
    if (!integer(client) || !Array.isArray(structs) || structs.length === 0) fail('invalid native client store');
    structCount += structs.length;
    if (structCount > maxStructs) fail('struct bound exceeded');
    const deleted: Array<{ clock: number; len: number }> = [];
    let clock = 0;
    for (const struct of structs) {
      if (!struct || struct.id?.client !== client || !integer(struct.id.clock) || struct.id.clock !== clock
        || !Number.isSafeInteger(struct.length) || struct.length <= 0 || !integer(clock + struct.length)
        || typeof struct.deleted !== 'boolean') fail('invalid native struct range');
      // Read the getter on every struct, including GC. Do not filter by Y type,
      // visible record, payload or constructor from either JavaScript realm.
      if (struct.deleted) {
        if (++deletedRangeCount > maxDeletedRanges) fail('deleted range bound exceeded');
        deleted.push({ clock: struct.id.clock, len: struct.length });
      }
      clock += struct.length;
    }
    clients.push({ client, clock, deleted });
  }
  // This entire read is synchronous. No Yjs transaction, conversion or mutation
  // runs here, and only bounded JSON/numeric metadata leaves the browser realm.
  return { document, clients, localClient: doc.clientID, guid: doc.guid };
}

/** Exact candidate state, not a persistence receipt or a notebook document ID. */
export async function readNativeRichCandidate(page: Page, selector: string): Promise<{
  document: JSONContent;
  stateProof: string;
  stateVector: string;
  localClient: number;
  guid: string;
}> {
  const input = await page.locator(selector).evaluate(readBoundSnapshot);
  const vector = new Map<number, number>();
  const deletes = Y.createDeleteSet();
  for (const client of input.clients) {
    vector.set(client.client, client.clock);
    // Empty DeleteSet client entries are not emitted by Y.snapshot(doc).
    if (client.deleted.length) deletes.clients.set(client.client, client.deleted);
  }
  const snapshot = Y.createSnapshot(Y.mergeDeleteSets([deletes]), vector);
  const hash = digest(Y.encodeSnapshot(snapshot));
  return {
    document: input.document,
    stateProof: `yjs-snapshot-sha256-v1:${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`,
    stateVector: Buffer.from(Y.encodeStateVector(vector)).toString('base64'),
    localClient: input.localClient,
    guid: input.guid,
  };
}
