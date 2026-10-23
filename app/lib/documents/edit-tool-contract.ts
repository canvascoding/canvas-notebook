import { types } from 'node:util';
import type { Tool } from '@modelcontextprotocol/server';
import { decodeDocumentEditRequestV1, DocumentEditError, type DecodedDocumentEditRequestV1 } from './edit-contracts';
import { decodeDocumentEditStatusRequestV1, type DocumentEditStatusRequestV1 } from './edit-result-contract';
import { encodeDocumentEditOperationResultV1, type DocumentEditOperationResultV1 } from './edit-result-contract';
import { DOCUMENT_EDIT_ERROR_CODES_V1 } from './edit-error-result';
import { NativeDocumentEditOperationError } from '../collaboration/native-document-edit-operation-contract';

export type NativeDocumentEditToolSelection = Readonly<
  { action: 'edit'; request: DecodedDocumentEditRequestV1 }
  | { action: 'status'; request: DocumentEditStatusRequestV1 }
>;
type LegacySchema = { type: 'object'; properties: Record<string, unknown> };
type Flavor = 'mcp' | 'pi';
const names = {
  mcp: { api: 'api_version', workspace: 'workspace_id', document: 'document_id', expected: 'expected_version', key: 'idempotency_key', operation: 'operation_id' },
  pi: { api: 'apiVersion', workspace: 'workspaceId', document: 'documentId', expected: 'expectedVersion', key: 'idempotencyKey', operation: 'operationId' },
} as const;
const markers = ['api_version', 'apiVersion', 'action', 'document_id', 'documentId', 'expected_version',
  'expectedVersion', 'patch', 'operation_id', 'operationId', 'workspaceId', 'idempotencyKey'];
function invalid(): never { throw new DocumentEditError('INVALID_REQUEST'); }
function selection(input: unknown, flavor: Flavor): NativeDocumentEditToolSelection | null {
  if (!input || typeof input !== 'object') return null;
  if (types.isProxy(input)) invalid();
  // Only own-property presence chooses a versioned branch. Never evaluate an
  // input getter, and never let a malformed native key reach legacy I/O.
  if (!markers.some(key => Object.hasOwn(input, key))) return null;
  if (Object.getPrototypeOf(input) !== Object.prototype) invalid();
  const n = names[flavor], keys = Reflect.ownKeys(input);
  const value = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    return descriptor.value as unknown;
  };
  if (value(n.api) !== 1) invalid();
  const action = value('action');
  const allowed: readonly string[] = action === 'edit' ? [n.api, 'action', n.workspace, n.document, n.expected, n.key, 'patch']
    : action === 'status' ? [n.api, 'action', n.workspace, n.operation] : invalid();
  if (keys.length !== allowed.length || keys.some(key => typeof key !== 'string' || !allowed.includes(key))) invalid();
  if (action === 'status') return Object.freeze({ action,
    request: decodeDocumentEditStatusRequestV1({ apiVersion: 1, workspaceId: value(n.workspace), operationId: value(n.operation) }) });
  return Object.freeze({ action: 'edit', request: decodeDocumentEditRequestV1({ apiVersion: 1,
    workspaceId: value(n.workspace), documentId: value(n.document), expectedVersion: value(n.expected),
    idempotencyKey: value(n.key), patch: value('patch') }) });
}
export function decodeDirectMcpNativeDocumentEditSelection(input: unknown): NativeDocumentEditToolSelection | null {
  return selection(input, 'mcp');
}
export function decodePiNativeDocumentEditSelection(input: unknown): NativeDocumentEditToolSelection | null {
  return selection(input, 'pi');
}
/** Keep the action for a second strict decode in execute after preparation. */
export function nativePiDocumentEditWire(selection: NativeDocumentEditToolSelection): Record<string, unknown> {
  return Object.freeze({ ...selection.request, action: selection.action });
}
/** Public services return a real recorded operation. If final response
 * validation fails, keep that bounded recovery reference rather than losing
 * it after an already-observed mutation. This never grants operation access. */
export function encodeNativeDocumentEditToolResult(value: DocumentEditOperationResultV1): DocumentEditOperationResultV1 {
  const descriptor = value && typeof value === 'object' && !types.isProxy(value)
    ? Object.getOwnPropertyDescriptor(value, 'operationId') : undefined;
  const actualId: unknown = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value as unknown : undefined;
  try { return encodeDocumentEditOperationResultV1(value); }
  catch (error) {
    if (typeof actualId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(actualId)) {
      throw new NativeDocumentEditOperationError('EDIT_OUTCOME_UNCONFIRMED', actualId);
    }
    throw error;
  }
}

const id = { type: 'string', minLength: 1, maxLength: 256 } as const;
const blockId = { type: 'string', minLength: 1, maxLength: 512 } as const;
const pointer = { anyOf: [blockId, { type: 'null' }] } as const;
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const operationId = { type: 'string', maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' } as const;
const version = { type: 'string', pattern: '^canvas-document-v1:[a-f0-9]{64}$' } as const;
const attributes = { type: 'object' } as const;
const inlineMark = { type: 'object', additionalProperties: false, properties: {
  type: { type: 'string', minLength: 1, maxLength: 256 }, attrs: attributes,
}, required: ['type'] } as const;
const editNode = { type: 'object', additionalProperties: false, properties: {
  type: { type: 'string', minLength: 1, maxLength: 256 }, attrs: attributes,
  text: { type: 'string', maxLength: 512 * 1024 }, marks: { type: 'array', items: inlineMark },
  content: { type: 'array', items: { $ref: '#/$defs/nativeEditNode' } },
}, required: ['type'] } as const;
const insertedRoot = { type: 'object', additionalProperties: false, properties: {
  type: { type: 'string', minLength: 1, maxLength: 256 }, attrs: attributes,
  content: { type: 'array', items: { $ref: '#/$defs/nativeEditNode' } },
}, required: ['type'] } as const;
const editableAttributes = { oneOf: [
  { type: 'object', additionalProperties: false, properties: { level: { type: 'integer', minimum: 1, maximum: 6 } }, required: ['level'] },
  { type: 'object', additionalProperties: false, properties: { checked: { type: 'boolean' } }, required: ['checked'] },
  { type: 'object', additionalProperties: false, properties: { start: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, required: ['start'] },
  { type: 'object', additionalProperties: false, properties: { language: { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 64, pattern: '^[\\w+-]*$' }] } }, required: ['language'] },
] } as const;
const structuredOperation = { oneOf: [
  { type: 'object', additionalProperties: false, properties: { kind: { const: 'move_block' }, blockId, placementHash: hash, parentId: pointer, beforeId: pointer },
    required: ['kind', 'blockId', 'placementHash', 'parentId', 'beforeId'] },
  { type: 'object', additionalProperties: false, properties: { kind: { const: 'delete_block' }, blockId, subtreeHash: hash }, required: ['kind', 'blockId', 'subtreeHash'] },
  { type: 'object', additionalProperties: false, properties: { kind: { const: 'insert_blocks' }, parentId: pointer, beforeId: pointer,
    blocks: { type: 'array', minItems: 1, maxItems: 256, items: insertedRoot } }, required: ['kind', 'parentId', 'beforeId', 'blocks'] },
  { type: 'object', additionalProperties: false, properties: { kind: { const: 'format_block' }, blockId, beforeAttrs: editableAttributes, afterAttrs: editableAttributes },
    required: ['kind', 'blockId', 'beforeAttrs', 'afterAttrs'], anyOf: ['level', 'checked', 'start', 'language'].map(key => ({
      properties: { beforeAttrs: { required: [key] }, afterAttrs: { required: [key] } },
    })) },
  { type: 'object', additionalProperties: false, properties: { kind: { const: 'format_text' }, blockId, subtreeHash: hash,
    from: integer, to: { ...integer, minimum: 1 }, mark: { enum: ['bold', 'italic', 'strike', 'code', 'link'] }, enabled: { type: 'boolean' },
    href: { type: 'string', minLength: 1, maxLength: 2048 } }, required: ['kind', 'blockId', 'subtreeHash', 'from', 'to', 'mark', 'enabled'], anyOf: [
      { properties: { mark: { const: 'link' }, enabled: { const: true } }, required: ['href'] },
      { properties: { enabled: { const: false } }, not: { required: ['href'] } },
      { properties: { mark: { not: { const: 'link' } } }, not: { required: ['href'] } },
    ] },
  { type: 'object', additionalProperties: false, properties: { kind: { const: 'table_operation' }, cellId: blockId, subtreeHash: hash,
    action: { enum: ['addRowBefore', 'addRowAfter', 'deleteRow', 'addColumnBefore', 'addColumnAfter', 'deleteColumn',
      'deleteTable', 'alignLeft', 'alignCenter', 'alignRight', 'alignNone', 'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight'] } },
    required: ['kind', 'cellId', 'subtreeHash', 'action'] },
] } as const;
export const DOCUMENT_EDIT_PATCH_JSON_SCHEMA_V1 = { oneOf: [
  { type: 'object', additionalProperties: false, properties: { kind: { const: 'native_text_replace' }, blockId,
    edits: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, properties: {
      oldText: { type: 'string', minLength: 1, maxLength: 512 * 1024 }, newText: { type: 'string', maxLength: 512 * 1024 },
      expectedOccurrences: { type: 'integer', minimum: 1, maximum: 32, default: 1 },
    }, required: ['oldText', 'newText'] } } }, required: ['kind', 'edits'] },
  { type: 'object', additionalProperties: false, properties: { kind: { const: 'native_blocks' },
    operations: { type: 'array', minItems: 1, maxItems: 32, items: structuredOperation } }, required: ['kind', 'operations'] },
] } as const;

function inputSchema<Schema extends LegacySchema>(legacy: Schema, flavor: Flavor): Tool['inputSchema'] {
  const n = names[flavor];
  const nativeProperties: Record<string, unknown> = {
    [n.api]: { type: 'integer', const: 1, description: 'Strict native ID/full-version edit or read-only operation status. Invalid supplied versions never select legacy path editing.' },
    action: { type: 'string', enum: ['edit', 'status'] },
    [n.workspace]: id, [n.document]: id, [n.expected]: version,
    [n.key]: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$',
      description: 'Stable caller retry key for this exact native patch. Reuse it across tool calls; never use a new key to recover uncertainty.' },
    [n.operation]: operationId, patch: DOCUMENT_EDIT_PATCH_JSON_SCHEMA_V1,
  };
  return { type: 'object' as const, properties: { ...legacy.properties, ...nativeProperties }, additionalProperties: false,
    $defs: { nativeEditNode: editNode }, oneOf: [legacy,
      { type: 'object', additionalProperties: false,
        properties: Object.fromEntries([n.api, 'action', n.workspace, n.document, n.expected, n.key, 'patch']
          .map(key => [key, key === 'action' ? { const: 'edit' } : nativeProperties[key]])),
        required: [n.api, 'action', n.workspace, n.document, n.expected, n.key, 'patch'] },
      { type: 'object', additionalProperties: false, properties: {
        [n.api]: nativeProperties[n.api], action: { const: 'status' }, [n.workspace]: id, [n.operation]: operationId,
      }, required: [n.api, 'action', n.workspace, n.operation] },
    ] } as Tool['inputSchema'];
}
export function directMcpDocumentEditInputSchema<Schema extends LegacySchema>(legacy: Schema) { return inputSchema(legacy, 'mcp'); }
export function piDocumentEditInputSchema<Schema extends LegacySchema>(legacy: Schema) { return inputSchema(legacy, 'pi'); }

export const DOCUMENT_EDIT_FAILURE_JSON_SCHEMA_V1 = { type: 'object', additionalProperties: false,
  properties: { apiVersion: { const: 1 }, success: { const: false }, code: { type: 'string', enum: [...DOCUMENT_EDIT_ERROR_CODES_V1] }, operationId },
  required: ['apiVersion', 'success', 'code'],
} as const;
