import 'server-only';

import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { AgentBlockEditRequest } from '../collaboration/agent-block-edits';

type TextEdit = Readonly<{ oldText: string; newText: string; expectedOccurrences?: number }>;
type DecodedTextEdit = Readonly<{ oldText: string; newText: string; expectedOccurrences: number }>;
export type DocumentEditPatchV1 = Readonly<
  { kind: 'native_text_replace'; edits: readonly TextEdit[]; blockId?: string }
  | { kind: 'native_blocks'; operations: readonly AgentBlockEditRequest[] }
>;
type DecodedPatch = Readonly<
  { kind: 'native_text_replace'; edits: readonly DecodedTextEdit[]; blockId?: string }
  | { kind: 'native_blocks'; operations: readonly AgentBlockEditRequest[] }
>;
export type DocumentEditRequestV1 = Readonly<{
  apiVersion: 1;
  workspaceId: string;
  documentId: string;
  expectedVersion: string;
  idempotencyKey: string;
  patch: DocumentEditPatchV1;
}>;
export type DecodedDocumentEditRequestV1 = Readonly<Omit<DocumentEditRequestV1, 'patch'> & { patch: DecodedPatch }>;

const statuses = {
  INVALID_REQUEST: 400, AUTHENTICATION_REQUIRED: 401, ACCESS_DENIED: 403, DOCUMENT_NOT_FOUND: 404,
  DOCUMENT_VERSION_CONFLICT: 409, DOCUMENT_SCOPE_CHANGED: 409, DOCUMENT_STATE_MISSING: 409,
  DOCUMENT_STATE_INVALID: 409, DOCUMENT_BUSY: 409, DOCUMENT_IDEMPOTENCY_CONFLICT: 409,
  DOCUMENT_EDIT_CONFLICT: 409, DOCUMENT_EDIT_UNSUPPORTED: 422, DOCUMENT_TOO_LARGE: 413,
  EDIT_OUTCOME_UNCONFIRMED: 503, DOCUMENT_EDIT_UNAVAILABLE: 503,
} as const;
export class DocumentEditError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof statuses) {
    super(code); this.name = 'DocumentEditError'; this.status = statuses[code];
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Budget = { bytes: number; nodes: number; ancestors: WeakSet<object> };
const MAX_BYTES = 512 * 1024, MAX_DEPTH = 32, MAX_NODES = 16_384;
const MAX_EDITS = 32, MAX_TARGETS = 32, MAX_OPERATIONS = 32, MAX_INSERTED_ROOTS = 256;
function invalid(): never { throw new DocumentEditError('INVALID_REQUEST'); }
function large(): never { throw new DocumentEditError('DOCUMENT_TOO_LARGE'); }
function add(budget: Budget, bytes: number): void {
  budget.bytes += bytes; if (budget.bytes > MAX_BYTES) large();
}
/** Exact UTF-8 JSON string size, rejecting lone surrogates before allocation. */
function stringBytes(value: string, budget: Budget): void {
  if (value.length > MAX_BYTES) large();
  add(budget, 2);
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
      add(budget, 4);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
    else if (unit === 0x22 || unit === 0x5c || [8, 9, 10, 12, 13].includes(unit)) add(budget, 2);
    else add(budget, unit < 0x20 ? 6 : unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3);
  }
}
/** Copies only bounded JSON data. No input getter, toJSON or Proxy trap runs. */
function capture(value: unknown, budget: Budget, depth = 0): Json {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) large();
  if (value === null) { add(budget, 4); return null; }
  if (typeof value === 'string') { stringBytes(value, budget); return value; }
  if (typeof value === 'boolean') { add(budget, value ? 4 : 5); return value; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    add(budget, String(value).length); return value === 0 ? 0 : value;
  }
  if (!value || typeof value !== 'object' || types.isProxy(value)) invalid();
  if (budget.ancestors.has(value)) invalid();
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
  // Large sparse arrays are rejected before obtaining all their descriptors.
  const length = array ? Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown : undefined;
  if (array && (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)) invalid();
  if (typeof length === 'number' && length > MAX_NODES) large();
  const properties = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(properties);
  if (names.length > MAX_NODES) large();
  if (names.some(name => typeof name !== 'string') || array && names.length !== Number(length) + 1) invalid();
  budget.ancestors.add(value);
  try {
    add(budget, 2);
    if (array) {
      const result: Json[] = [];
      for (let index = 0; index < Number(length); index++) {
        const descriptor = properties[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
        if (index) add(budget, 1);
        result.push(capture(descriptor.value as unknown, budget, depth + 1));
      }
      return result;
    }
    const result: { [key: string]: Json } = {};
    for (const [index, key] of (names as string[]).sort().entries()) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid();
      const descriptor = properties[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      if (index) add(budget, 1); stringBytes(key, budget); add(budget, 1);
      Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true,
        value: capture(descriptor.value as unknown, budget, depth + 1) });
    }
    return result;
  } finally { budget.ancestors.delete(value); }
}
function copied(value: unknown): Json { return capture(value, { bytes: 0, nodes: 0, ancestors: new WeakSet() }); }
function record(value: Json, required: readonly string[], optional: readonly string[] = []): { [key: string]: Json } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return value;
}
function text(value: Json | undefined, maximum: number, nonempty = true): string {
  if (typeof value !== 'string' || value.length > maximum || nonempty && !value.length) invalid(); return value;
}
function id(value: Json | undefined, maximum = 512): string {
  const selected = text(value, maximum);
  if (selected !== selected.trim() || /[\u0000-\u001f\u007f]/u.test(selected)) invalid(); return selected;
}
function integer(value: Json | undefined, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid();
  if (value > maximum) large(); return value;
}
function array(value: Json | undefined, maximum: number): Json[] {
  if (!Array.isArray(value) || !value.length) invalid(); if (value.length > maximum) large(); return value;
}
function pointer(value: Json | undefined): void { if (value !== null) id(value); }
function hash(value: Json | undefined): void { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid(); }
function attributes(value: Json): { [key: string]: Json } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value;
}
function node(value: Json, root: boolean): void {
  const selected = record(value, ['type'], root ? ['attrs', 'content'] : ['attrs', 'content', 'marks', 'text']);
  id(selected.type, 256);
  if (Object.hasOwn(selected, 'attrs')) attributes(selected.attrs);
  if (Object.hasOwn(selected, 'text')) text(selected.text, MAX_BYTES, false);
  if (Object.hasOwn(selected, 'content')) {
    if (!Array.isArray(selected.content)) invalid();
    for (const child of selected.content) node(child, false);
  }
  if (Object.hasOwn(selected, 'marks')) {
    if (!Array.isArray(selected.marks)) invalid();
    for (const value of selected.marks) {
      const mark = record(value, ['type'], ['attrs']); id(mark.type, 256);
      if (Object.hasOwn(mark, 'attrs')) attributes(mark.attrs);
    }
  }
}
function formatAttrs(value: Json): string {
  const selected = attributes(value), keys = Object.keys(selected);
  if (keys.length !== 1) invalid(); const key = keys[0];
  if (typeof key !== 'string') invalid(); const attribute = selected[key];
  if (key === 'level') { if (integer(attribute, 1) > 6) invalid(); }
  else if (key === 'checked') { if (typeof attribute !== 'boolean') invalid(); }
  else if (key === 'start') integer(attribute, 1);
  else if (key === 'language') {
    if (attribute !== null && (typeof attribute !== 'string' || attribute.length > 64 || !/^[\w+-]*$/u.test(attribute))) invalid();
  } else invalid();
  return key;
}
const tableActions = ['addRowBefore', 'addRowAfter', 'deleteRow', 'addColumnBefore', 'addColumnAfter',
  'deleteColumn', 'deleteTable', 'alignLeft', 'alignCenter', 'alignRight', 'alignNone',
  'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight'];
function operation(value: Json, inserted: { roots: number }): AgentBlockEditRequest {
  const initial = attributes(value), kind = initial.kind;
  if (kind === 'move_block') {
    const row = record(value, ['kind', 'blockId', 'placementHash', 'parentId', 'beforeId']);
    id(row.blockId); hash(row.placementHash); pointer(row.parentId); pointer(row.beforeId);
    if (row.beforeId === row.blockId) invalid();
  } else if (kind === 'delete_block') {
    const row = record(value, ['kind', 'blockId', 'subtreeHash']); id(row.blockId); hash(row.subtreeHash);
  } else if (kind === 'insert_blocks') {
    const row = record(value, ['kind', 'parentId', 'beforeId', 'blocks']); pointer(row.parentId); pointer(row.beforeId);
    const blocks = array(row.blocks, MAX_INSERTED_ROOTS); inserted.roots += blocks.length;
    if (inserted.roots > MAX_INSERTED_ROOTS) large();
    for (const block of blocks) node(block, true);
  } else if (kind === 'format_block') {
    const row = record(value, ['kind', 'blockId', 'beforeAttrs', 'afterAttrs']); id(row.blockId);
    if (formatAttrs(row.beforeAttrs) !== formatAttrs(row.afterAttrs)) invalid();
  } else if (kind === 'format_text') {
    const row = record(value, ['kind', 'blockId', 'subtreeHash', 'from', 'to', 'mark', 'enabled'], ['href']);
    id(row.blockId); hash(row.subtreeHash); const from = integer(row.from, 0), to = integer(row.to, 1);
    if (to <= from || typeof row.enabled !== 'boolean' || typeof row.mark !== 'string'
      || !['bold', 'italic', 'strike', 'code', 'link'].includes(row.mark)) invalid();
    if (row.mark === 'link' && row.enabled) id(row.href, 2048);
    else if (Object.hasOwn(row, 'href')) invalid();
  } else if (kind === 'table_operation') {
    const row = record(value, ['kind', 'cellId', 'subtreeHash', 'action']); id(row.cellId); hash(row.subtreeHash);
    if (typeof row.action !== 'string' || !tableActions.includes(row.action)) invalid();
  } else invalid();
  // Wire shape only. Native schema, URI, placement, grapheme and document
  // semantics are still checked by the actual native block preparer.
  return value as unknown as AgentBlockEditRequest;
}
function patch(value: Json): DecodedPatch {
  const selected = attributes(value);
  if (selected.kind === 'native_text_replace') {
    const row = record(value, ['kind', 'edits'], ['blockId']); let targets = 0;
    const edits = array(row.edits, MAX_EDITS).map(value => {
      const edit = record(value, ['oldText', 'newText'], ['expectedOccurrences']);
      const expectedOccurrences = Object.hasOwn(edit, 'expectedOccurrences') ? integer(edit.expectedOccurrences, 1, MAX_TARGETS) : 1;
      targets += expectedOccurrences; if (targets > MAX_TARGETS) large();
      return { oldText: text(edit.oldText, MAX_BYTES), newText: text(edit.newText, MAX_BYTES, false), expectedOccurrences };
    });
    return { kind: 'native_text_replace', edits, ...(Object.hasOwn(row, 'blockId') ? { blockId: id(row.blockId) } : {}) };
  }
  const row = record(value, ['kind', 'operations']);
  if (row.kind !== 'native_blocks') invalid();
  const inserted = { roots: 0 };
  return { kind: 'native_blocks', operations: array(row.operations, MAX_OPERATIONS).map(value => operation(value, inserted)) };
}
/** No toJSON calls; object keys are canonical, array/operation order remains. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value); if (typeof encoded !== 'string') invalid(); return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function finish<T>(value: T): T {
  if (Buffer.byteLength(canonical(value), 'utf8') > MAX_BYTES) large(); return freeze(value);
}

/** Comparison/request data only. Decoding never acquires mutation authority. */
export function decodeDocumentEditPatchV1(value: unknown): DecodedPatch { return finish(patch(copied(value))); }
export function decodeDocumentEditRequestV1(value: unknown): DecodedDocumentEditRequestV1 {
  const row = record(copied(value), ['apiVersion', 'workspaceId', 'documentId', 'expectedVersion', 'idempotencyKey', 'patch']);
  if (row.apiVersion !== 1 || typeof row.expectedVersion !== 'string' || !/^canvas-document-v1:[a-f0-9]{64}$/u.test(row.expectedVersion)
    || typeof row.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(row.idempotencyKey)) invalid();
  return finish({ apiVersion: 1, workspaceId: id(row.workspaceId, 256), documentId: id(row.documentId, 256),
    expectedVersion: row.expectedVersion, idempotencyKey: row.idempotencyKey, patch: patch(row.patch) });
}
/** Full canonical request comparison; current actor/SID and retry key are not
 * request content. The real owner separately binds the private actual origin. */
export function documentEditRequestFingerprintV1(value: unknown): string {
  const request = decodeDocumentEditRequestV1(value);
  return createHash('sha256').update('canvas-document-edit-request:1\n', 'utf8').update(canonical({
    apiVersion: request.apiVersion, workspaceId: request.workspaceId, documentId: request.documentId,
    expectedVersion: request.expectedVersion, patch: request.patch,
  }), 'utf8').digest('hex');
}
