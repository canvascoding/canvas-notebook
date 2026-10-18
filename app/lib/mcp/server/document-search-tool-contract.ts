import { types } from 'node:util';
import { decodeDocumentSearchRequestV1, DocumentSearchError, type DecodedDocumentSearchRequestV1 } from '../../documents/search-contract';

const nativeKeys = ['api_version', 'cursor'] as const;
const keys = new Set(['api_version', 'workspace_id', 'query', 'path', 'max_results', 'cursor']);

/** Null is the unchanged legacy path search. Any native-only key selects strict
 * decoding, including undefined; a failed V1 request never falls back to disk. */
export function decodeDirectMcpDocumentSearchSelection(input: unknown): DecodedDocumentSearchRequestV1 | null {
  if (!input || typeof input !== 'object') return null;
  if (types.isProxy(input)) throw new DocumentSearchError('INVALID_SEARCH_REQUEST');
  if (!nativeKeys.some(key => Object.prototype.hasOwnProperty.call(input, key))) return null;
  if (Object.getPrototypeOf(input) !== Object.prototype) throw new DocumentSearchError('INVALID_SEARCH_REQUEST');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !keys.has(key)) throw new DocumentSearchError('INVALID_SEARCH_REQUEST');
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new DocumentSearchError('INVALID_SEARCH_REQUEST');
  }
  const own = (key: string) => Object.prototype.hasOwnProperty.call(descriptors, key);
  const value = (key: string): unknown => descriptors[key]?.value;
  return decodeDocumentSearchRequestV1({ apiVersion: value('api_version'), workspaceId: value('workspace_id'), query: value('query'),
    ...(own('path') ? { scopePath: value('path') } : {}),
    ...(own('max_results') ? { limit: value('max_results') } : {}),
    ...(own('cursor') ? { cursor: value('cursor') } : {}) });
}

export const DIRECT_MCP_NATIVE_DOCUMENT_SEARCH_PROPERTIES = {
  api_version: { type: 'integer', const: 1, description: 'Select native document search V1. Physical files, Scenes and PDF bodies are outside its declared corpus.' },
  cursor: { type: 'string', minLength: 1, maxLength: 4096,
    description: 'Exact native V1 nextCursor. Keep query/path; each call rechecks current search permission and corpus. It never grants full-read access.' },
};
