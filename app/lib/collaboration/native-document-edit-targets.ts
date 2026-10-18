import 'server-only';

import { types } from 'node:util';
import type { Doc } from 'yjs';
import { DocumentReadError } from '../documents/contracts';
import { readAgentBlockStructure } from './agent-block-structure';
import { BLOCK_TREE_KEY } from './block-tree';
import type { NativeCollaborationContent } from './document-snapshot';
import { captureNativeDocumentReadBudget, type NativeDocumentReadBudget } from './native-search-budget';
import { collaborationStateProof } from './state-proof';
import { Y } from './yjs-runtime';

export type NativeDocumentEditTargetV1 = Readonly<{
  id: string; type: string; parentId: string | null; beforeId: string | null;
  attrs: Readonly<Record<string, unknown>>; subtreeHash: string; placementHash: string;
  tableOperationTarget?: Readonly<{ cellId: string; subtreeHash: string }>;
}>;

export const MAX_NATIVE_DOCUMENT_EDIT_TARGETS = 512;
export const MAX_NATIVE_DOCUMENT_EDIT_TARGET_BYTES = 64 * 1024;
const MAX_PRIVATE_ENTRIES = 2048;
const MAX_JSON_NODES = 8192;
const MAX_JSON_DEPTH = 64;
const sourceBudget: NativeDocumentReadBudget = Object.freeze({
  maxStateBytes: 2 * 1024 * 1024, maxVectorBytes: 128 * 1024, maxClients: 1024,
  maxStructs: 16_384, maxNodes: 32_768, maxDepth: 32,
  maxStringBytes: 64 * 1024, maxBinaryBytes: 2 * 1024 * 1024,
});
function tooLarge(): never { throw new DocumentReadError('DOCUMENT_TOO_LARGE'); }
function invalid(): never { throw new DocumentReadError('DOCUMENT_STATE_INVALID'); }
function unavailable(): never { throw new DocumentReadError('DOCUMENT_FORMAT_UNAVAILABLE'); }

/** Opt-in only; a caller's existing smaller limits are never raised. Bounds
 * the original binary before decode and the actual live Yjs store before PM
 * extraction. The ordinary read and search defaults remain unchanged. */
export function nativeDocumentEditTargetsReadBudget(requested?: NativeDocumentReadBudget): NativeDocumentReadBudget {
  const selected = requested === undefined ? sourceBudget : captureNativeDocumentReadBudget(requested);
  const minimum = (key: keyof NativeDocumentReadBudget) => Math.min(sourceBudget[key], selected[key]);
  return Object.freeze({ maxStateBytes: minimum('maxStateBytes'), maxVectorBytes: minimum('maxVectorBytes'),
    maxClients: minimum('maxClients'), maxStructs: minimum('maxStructs'), maxNodes: minimum('maxNodes'),
    maxDepth: minimum('maxDepth'), maxStringBytes: minimum('maxStringBytes'), maxBinaryBytes: minimum('maxBinaryBytes') });
}

/** The reader has already selected a tiptap_blocks header. Never create a
 * missing root. Typed hydration uses the existing declared root only. */
export function assertNativeDocumentEditTargetStorageBudget(doc: Doc): void {
  if (!doc.share.has(BLOCK_TREE_KEY) || doc.share.has('body')) invalid();
  const root = doc.getMap(BLOCK_TREE_KEY);
  const records = root.get('records'), operations = root.get('operations'), receipts = root.get('receipts');
  if (!(records instanceof Y.Map) || !(operations instanceof Y.Map) || !(receipts instanceof Y.Map)) invalid();
  // Count retained records and active placement operations, not just visible
  // PM nodes. Durable receipts are excluded from placement hashes but bounded
  // separately so old history cannot bypass this opt-in's source limits.
  if (records.size + operations.size > MAX_PRIVATE_ENTRIES || receipts.size > MAX_PRIVATE_ENTRIES) tooLarge();
}

/** Exact encoded JSON byte measurement before JSON.stringify or UTF-8 copy.
 * Inputs are already inspected native JSON; no getter/toJSON is called. This
 * is a bounded traversal, not a V8 heap or execution-time guarantee. */
function assertJsonBudget(initial: unknown): void {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const add = (count: number) => { bytes += count; if (bytes > MAX_NATIVE_DOCUMENT_EDIT_TARGET_BYTES) tooLarge(); };
  const string = (value: string) => {
    if (value.length > MAX_NATIVE_DOCUMENT_EDIT_TARGET_BYTES - bytes) tooLarge();
    add(2);
    for (let index = 0; index < value.length; index++) {
      const unit = value.charCodeAt(index);
      if (unit === 0x22 || unit === 0x5c || [8, 9, 10, 12, 13].includes(unit)) add(2);
      else if (unit < 0x20) add(6);
      else if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { add(4); index++; } else add(6);
      } else if (unit >= 0xdc00 && unit <= 0xdfff) add(6);
      else add(unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3);
    }
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) tooLarge();
    if (value === null) { add(4); return; }
    if (typeof value === 'string') { string(value); return; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); add(String(value).length); return; }
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) invalid();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    if (array && value.length > MAX_JSON_NODES - nodes) tooLarge();
    ancestors.add(value);
    try {
      add(2);
      if (array) {
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
          if (index) add(1); visit(descriptor.value as unknown, depth + 1);
        }
      } else {
        let children = 0;
        for (const key in value) {
          if (!Object.hasOwn(value, key)) invalid();
          if (++children > MAX_JSON_NODES - nodes) tooLarge();
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
          if (children > 1) add(1); string(key); add(1); visit(descriptor.value as unknown, depth + 1);
        }
      }
    } finally { ancestors.delete(value); }
  };
  visit(initial, 0);
}

function assertVisibleNodeBudget(content: NativeCollaborationContent): void {
  if (content.kind !== 'rich_text') unavailable();
  assertJsonBudget(content);
  let nodes = 0;
  const pending = [content.document];
  while (pending.length) {
    const node = pending.pop()!;
    if (++nodes > MAX_NATIVE_DOCUMENT_EDIT_TARGETS) tooLarge();
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) invalid();
      if (node.content.length > MAX_NATIVE_DOCUMENT_EDIT_TARGETS - nodes - pending.length) tooLarge();
      for (const child of node.content) pending.push(child);
    }
  }
}

function identifier(value: unknown, maximum = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Called synchronously inside the native ID reader's actual observed-doc
 * callback. It reuses the existing guard algorithm, then drops duplicated
 * block text and all private initial/operation/receipt data. */
export function captureNativeDocumentEditTargets(doc: Doc, content: NativeCollaborationContent,
  observedStateProof: string): readonly NativeDocumentEditTargetV1[] {
  assertNativeDocumentEditTargetStorageBudget(doc);
  assertVisibleNodeBudget(content);
  const blocks = readAgentBlockStructure(doc);
  if (blocks.length > MAX_NATIVE_DOCUMENT_EDIT_TARGETS) tooLarge();
  const targets: NativeDocumentEditTargetV1[] = blocks.map(block => {
    if (!identifier(block.id) || !identifier(block.type, 256)
      || block.parentId !== null && !identifier(block.parentId)
      || block.beforeId !== null && !identifier(block.beforeId)
      || !hash(block.subtreeHash) || !hash(block.placementHash)) unavailable();
    const table = block.tableOperationTarget;
    if (table && (table.cellId !== block.id || !hash(table.subtreeHash))) unavailable();
    return { id: block.id, type: block.type, parentId: block.parentId, beforeId: block.beforeId,
      attrs: block.attrs, subtreeHash: block.subtreeHash, placementHash: block.placementHash,
      ...(table ? { tableOperationTarget: { cellId: table.cellId, subtreeHash: table.subtreeHash } } : {}) };
  });
  assertJsonBudget(targets);
  if (collaborationStateProof(doc, Y) !== observedStateProof) invalid();
  return freeze(targets);
}
