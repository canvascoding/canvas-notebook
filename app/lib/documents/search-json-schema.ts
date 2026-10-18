import { DOCUMENT_READ_ERROR_JSON_SCHEMA_V1, DOCUMENT_READ_PAGE_JSON_SCHEMA_V1 } from './read-json-schema';

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
const count = { type: 'integer', minimum: 0 };

/** Public comparison/output schema only; no native or SQL authority. */
export const DOCUMENT_SEARCH_PAGE_JSON_SCHEMA_V1 = frozen({
  type: 'object', additionalProperties: false,
  required: ['apiVersion', 'workspaceId', 'query', 'scopePath', 'hits', 'nextCursor', 'coverage'],
  properties: {
    apiVersion: { type: 'integer', const: 1 }, workspaceId: { type: 'string' },
    query: { type: 'string' }, scopePath: { type: 'string' }, nextCursor: { type: ['string', 'null'] },
    hits: { type: 'array', maxItems: 25, items: {
      type: 'object', additionalProperties: false, required: ['document', 'currency', 'matchedIn', 'snippet'],
      properties: { document: DOCUMENT_READ_PAGE_JSON_SCHEMA_V1.properties.document,
        currency: DOCUMENT_READ_PAGE_JSON_SCHEMA_V1.properties.currency,
        matchedIn: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
          items: { type: 'string', enum: ['title', 'path', 'content'] } },
        snippet: { type: 'string', maxLength: 512 } },
    } },
    coverage: { type: 'object', additionalProperties: false,
      required: ['corpus', 'candidateOrder', 'ranking', 'membershipCheckedBeforeAndAfter', 'candidateCount',
        'windowStart', 'windowEnd', 'inspected', 'matched', 'returned', 'excludedInWindow', 'pristineExcluded',
        'localLive', 'remoteLive', 'globalCurrentContent', 'moreWindowHits', 'moreCandidates'],
      properties: { corpus: { type: 'string', const: 'visible_initialized_native_yjs' },
        candidateOrder: { type: 'string', const: 'metadata_priority_path_id_v1' },
        ranking: { type: 'string', const: 'within_scan_window' },
        membershipCheckedBeforeAndAfter: { type: 'boolean', const: true },
        candidateCount: count, windowStart: count, windowEnd: count, inspected: count, matched: count, returned: count,
        pristineExcluded: count,
        excludedInWindow: { type: 'object', additionalProperties: false,
          required: ['tooLarge', 'unavailableOwner', 'unsupportedRepresentation'],
          properties: { tooLarge: count, unavailableOwner: count, unsupportedRepresentation: count } },
        localLive: { type: 'string', enum: ['verified', 'unknown'] }, remoteLive: { type: 'string', const: 'unknown' },
        globalCurrentContent: { type: 'string', const: 'not_certified' },
        moreWindowHits: { type: 'boolean' }, moreCandidates: { type: 'boolean' } },
    },
  },
});

export const DOCUMENT_SEARCH_ERROR_JSON_SCHEMA_V1 = frozen({
  type: 'object', additionalProperties: false, required: ['apiVersion', 'success', 'code'],
  properties: { apiVersion: { type: 'integer', const: 1 }, success: { type: 'boolean', const: false },
    code: { type: 'string', enum: [...DOCUMENT_READ_ERROR_JSON_SCHEMA_V1.properties.code.enum,
      'INVALID_SEARCH_REQUEST', 'SEARCH_CURSOR_INVALID', 'SEARCH_CORPUS_CHANGED', 'SEARCH_CORPUS_TOO_LARGE', 'SEARCH_OUTPUT_TOO_LARGE'] } },
});
