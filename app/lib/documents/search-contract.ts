import { types } from 'node:util';
import type { DocumentCurrencyV1, NativeDocumentRefV1 } from './contracts';

export const DOCUMENT_SEARCH_WINDOW_SIZE = 8;
export const DOCUMENT_SEARCH_ENVELOPE_BYTES = 12_000;
export const DOCUMENT_SEARCH_CURSOR_BYTES = 4096;
export const DOCUMENT_SEARCH_SNIPPET_BYTES = 512;

export type DocumentSearchRequestV1 = Readonly<{
  apiVersion: 1;
  workspaceId: string;
  query: string;
  scopePath?: string;
  limit?: number;
  cursor?: string;
}>;
export type DecodedDocumentSearchRequestV1 = Readonly<{
  apiVersion: 1;
  workspaceId: string;
  query: string;
  scopePath: string;
  limit: number;
  cursor?: string;
}>;
export type DocumentSearchHitV1 = Readonly<{
  document: NativeDocumentRefV1;
  currency: DocumentCurrencyV1;
  matchedIn: readonly ('title' | 'path' | 'content')[];
  snippet: string;
}>;
export type DocumentSearchPageV1 = Readonly<{
  apiVersion: 1;
  workspaceId: string;
  query: string;
  scopePath: string;
  hits: readonly DocumentSearchHitV1[];
  nextCursor: string | null;
  coverage: Readonly<{
    corpus: 'visible_initialized_native_yjs';
    candidateOrder: 'metadata_priority_path_id_v1';
    ranking: 'within_scan_window';
    membershipCheckedBeforeAndAfter: true;
    candidateCount: number;
    windowStart: number;
    windowEnd: number;
    inspected: number;
    matched: number;
    returned: number;
    excludedInWindow: Readonly<{ tooLarge: number; unavailableOwner: number; unsupportedRepresentation: number }>;
    pristineExcluded: number;
    localLive: 'verified' | 'unknown';
    remoteLive: 'unknown';
    globalCurrentContent: 'not_certified';
    moreWindowHits: boolean;
    moreCandidates: boolean;
  }>;
}>;

const statuses = { INVALID_SEARCH_REQUEST: 400, SEARCH_CURSOR_INVALID: 400,
  SEARCH_CORPUS_CHANGED: 409, SEARCH_CORPUS_TOO_LARGE: 413, SEARCH_OUTPUT_TOO_LARGE: 413 } as const;
export type DocumentSearchErrorCode = keyof typeof statuses;
export class DocumentSearchError extends Error {
  readonly status: number;
  constructor(readonly code: DocumentSearchErrorCode) {
    super(code); this.name = 'DocumentSearchError'; this.status = statuses[code];
  }
}

const requestKeys = new Set(['apiVersion', 'workspaceId', 'query', 'scopePath', 'limit', 'cursor']);
const wellFormed = (value: string) => Buffer.from(value, 'utf8').toString('utf8') === value;
function invalid(): never { throw new DocumentSearchError('INVALID_SEARCH_REQUEST'); }

/** Public selectors are data, never a Request, invocation or SQL grant. */
export function decodeDocumentSearchRequestV1(value: unknown): DecodedDocumentSearchRequestV1 {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const properties = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(properties)) {
    if (typeof key !== 'string' || !requestKeys.has(key)) invalid();
    const property = properties[key];
    if (!property.enumerable || !Object.prototype.hasOwnProperty.call(property, 'value')) invalid();
  }
  const own = (key: string) => Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : undefined;
  const workspaceId = own('workspaceId')?.value, rawQuery = own('query')?.value;
  if (own('apiVersion')?.value !== 1 || typeof workspaceId !== 'string' || !workspaceId
    || workspaceId.length > 256 || workspaceId !== workspaceId.trim() || !wellFormed(workspaceId)
    || /[\u0000-\u001f\u007f]/u.test(workspaceId) || typeof rawQuery !== 'string'
    || rawQuery.length > 200 || !wellFormed(rawQuery)) invalid();
  const query = rawQuery.trim();
  if ([...query].length < 2 || Buffer.byteLength(query, 'utf8') > 200 || /[\u0000-\u001f\u007f]/u.test(query)) invalid();
  const scopePath = own('scopePath') ? own('scopePath')!.value : '.';
  if (typeof scopePath !== 'string' || !scopePath || scopePath.length > 4096 || !wellFormed(scopePath)
    || Buffer.byteLength(scopePath, 'utf8') > 16384 || scopePath.startsWith('/') || scopePath.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(scopePath)
    || scopePath !== '.' && scopePath.split('/').some(part => !part || part === '.' || part === '..')) invalid();
  const limit = own('limit') ? own('limit')!.value : DOCUMENT_SEARCH_WINDOW_SIZE;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 25) invalid();
  const cursor = own('cursor')?.value;
  if (own('cursor') && (typeof cursor !== 'string' || !cursor || !wellFormed(cursor)
    || Buffer.byteLength(cursor, 'utf8') > DOCUMENT_SEARCH_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/u.test(cursor))) invalid();
  return Object.freeze({ apiVersion: 1, workspaceId, query, scopePath, limit,
    ...(cursor === undefined ? {} : { cursor: cursor as string }) });
}
