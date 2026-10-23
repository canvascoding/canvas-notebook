import { types } from 'node:util';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { DocumentReadError } from '../documents/contracts';
import { decodeDocumentSearchRequestV1, DocumentSearchError, DOCUMENT_SEARCH_ENVELOPE_BYTES,
  type DecodedDocumentSearchRequestV1, type DocumentSearchPageV1 } from '../documents/search-contract';

export const piDocumentSearchParameters = Type.Object({
  workspaceId: Type.String({ minLength: 1, maxLength: 256, description: 'Current authenticated session workspace.' }),
  query: Type.String({ minLength: 2, maxLength: 200, description: 'Literal Unicode text, not a regex. At least two codepoints and at most 200 UTF-8 bytes.' }),
  scopePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: 'Canonical workspace-relative scope, default ".". Hidden segments are excluded.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, default: 8, description: 'Maximum whole hits; a bounded scan window or output budget may return fewer.' })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: 'Exact nextCursor with the same query/scope. An empty hit page can still have a cursor.' })),
}, { additionalProperties: false });
const keys = new Set(['workspaceId', 'query', 'scopePath', 'limit', 'cursor']);

export function decodePiDocumentSearchSelection(input: unknown): DecodedDocumentSearchRequestV1 {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new DocumentSearchError('INVALID_SEARCH_REQUEST');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input), selected: Record<string, unknown> = { apiVersion: 1 };
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !keys.has(key)) throw new DocumentSearchError('INVALID_SEARCH_REQUEST');
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new DocumentSearchError('INVALID_SEARCH_REQUEST');
    selected[key] = descriptor.value as unknown;
  }
  return decodeDocumentSearchRequestV1(selected);
}

type Result = AgentToolResult<unknown> & { isError?: boolean };
export function formatPiDocumentSearchError(error: unknown): Result {
  const code = error instanceof DocumentSearchError || error instanceof DocumentReadError ? error.code : 'DOCUMENT_READ_UNAVAILABLE';
  const details = { apiVersion: 1, success: false, code, error: code, safeToAutoRetry: false };
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details, isError: true };
}

/** The service packs whole hits. This transport preserves the exact page or
 * returns a terminal error without a page/cursor; it never trims again. */
export function formatPiDocumentSearchPage(page: DocumentSearchPageV1): Result {
  try {
    const text = JSON.stringify(page);
    if (Buffer.byteLength(text, 'utf8') > DOCUMENT_SEARCH_ENVELOPE_BYTES) throw new DocumentSearchError('SEARCH_OUTPUT_TOO_LARGE');
    return { content: [{ type: 'text', text }], details: page };
  } catch (error) { return formatPiDocumentSearchError(error); }
}
