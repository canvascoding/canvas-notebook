import { types } from 'node:util';
import { decodeDocumentReadRequestV1, DocumentReadError, DEFAULT_DOCUMENT_READ_PAGE_BYTES, MAX_DOCUMENT_READ_PAGE_BYTES,
  MIN_DOCUMENT_READ_PAGE_BYTES, type DecodedDocumentReadRequestV1 } from '@/app/lib/documents/contracts';

const nativeKeys = ['document_id', 'format', 'expected_version', 'max_bytes', 'cursor'] as const;
const selectionKeys = new Set<string>(['workspace_id', ...nativeKeys]);

/** Pure transport selection only. A decoded ID/cursor is never authorization.
 * Null preserves the existing path/offset/max_characters branch. Presence of
 * any native-only field selects strict native decoding, including undefined. */
export function decodeDirectMcpDocumentReadSelection(input: unknown): DecodedDocumentReadRequestV1 | null {
  if (!input || typeof input !== 'object') return null;
  if (types.isProxy(input)) throw new DocumentReadError('INVALID_REQUEST');
  if (!nativeKeys.some(key => Object.prototype.hasOwnProperty.call(input, key))) return null;
  if (Object.getPrototypeOf(input) !== Object.prototype) throw new DocumentReadError('INVALID_REQUEST');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !selectionKeys.has(key)) throw new DocumentReadError('INVALID_REQUEST');
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new DocumentReadError('INVALID_REQUEST');
  }
  const value = (key: string): unknown => descriptors[key]?.value;
  const workspaceId = value('workspace_id'), documentId = value('document_id');
  if (typeof workspaceId !== 'string' || workspaceId.length > 256
    || typeof documentId !== 'string' || Buffer.from(workspaceId).toString('utf8') !== workspaceId
    || Buffer.from(documentId).toString('utf8') !== documentId) throw new DocumentReadError('INVALID_REQUEST');
  const own = (key: string) => Object.prototype.hasOwnProperty.call(descriptors, key);
  return decodeDocumentReadRequestV1({ apiVersion: 1, workspaceId, documentId,
    ...(own('format') ? { format: value('format') } : {}),
    ...(own('expected_version') ? { expectedVersion: value('expected_version') } : {}),
    ...(own('max_bytes') ? { maxBytes: value('max_bytes') } : {}),
    ...(own('cursor') ? { cursor: value('cursor') } : {}) });
}

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

export const DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES = frozen({
  document_id: { type: 'string', minLength: 1, maxLength: 256,
    description: 'Stable native document ID. Use either document_id or the legacy path selector, never both.' },
  format: { type: 'string', enum: ['native', 'text', 'markdown'], default: 'native',
    description: 'For document_id only. Native JSON and semantic text do not require a Markdown projection; markdown is an explicit export.' },
  expected_version: { type: 'string', pattern: '^canvas-document-v1:[a-f0-9]{64}$',
    description: 'For document_id only. Full native content version returned by an earlier document read.' },
  max_bytes: { type: 'integer', minimum: MIN_DOCUMENT_READ_PAGE_BYTES, maximum: MAX_DOCUMENT_READ_PAGE_BYTES, default: DEFAULT_DOCUMENT_READ_PAGE_BYTES,
    description: 'For document_id only. Maximum UTF-8 fragment bytes; the JSON envelope is additional. Defaults to 65536.' },
  cursor: { type: 'string', minLength: 1, maxLength: 4096,
    description: 'For document_id only. Exact nextCursor from the preceding page with the same selection and format. Current read permission is always required.' },
});
