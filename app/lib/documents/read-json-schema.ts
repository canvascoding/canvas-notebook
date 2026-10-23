/** Pure public DocumentReadPageV1 schema. It grants no access or decoder authority. */
import type { DocumentReadErrorCodeV1 } from './contracts';

function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

export const DOCUMENT_READ_PAGE_JSON_SCHEMA_V1 = frozen({
  type: 'object', additionalProperties: false,
  required: ['apiVersion', 'document', 'currency', 'projection', 'format', 'mediaType', 'encoding',
    'fragment', 'byteOffset', 'byteLength', 'totalBytes', 'nextCursor', 'complete'],
  properties: {
    apiVersion: { type: 'integer', const: 1 },
    document: {
      type: 'object', additionalProperties: false,
      required: ['kind', 'workspaceId', 'organizationId', 'documentId', 'lineageId', 'lifecycleGeneration',
        'representation', 'schemaVersion', 'path', 'title', 'version', 'metadataVersion'],
      properties: {
        kind: { type: 'string', const: 'native_document' }, workspaceId: { type: 'string' },
        organizationId: { type: ['string', 'null'] }, documentId: { type: 'string' }, lineageId: { type: 'string' },
        lifecycleGeneration: { type: 'integer', minimum: 1 },
        representation: { type: 'string', enum: ['plain_text', 'tiptap_xml', 'tiptap_blocks'] },
        schemaVersion: { type: 'integer', minimum: 1 }, path: { type: 'string' }, title: { type: 'string' },
        version: { type: 'string', pattern: '^canvas-document-v1:[a-f0-9]{64}$' },
        metadataVersion: { type: 'string', pattern: '^canvas-document-metadata-v1:[a-f0-9]{64}$' },
      },
    },
    currency: {
      type: 'object', additionalProperties: false,
      required: ['source', 'observedVersion', 'observedDurable', 'durableVersion', 'durableSequence', 'persistedAt'],
      properties: {
        source: { type: 'string', enum: ['persisted_yjs', 'live_yjs'] },
        observedVersion: { type: 'string', pattern: '^canvas-document-v1:[a-f0-9]{64}$' },
        observedDurable: { type: 'boolean' }, durableVersion: { type: 'string', pattern: '^canvas-document-v1:[a-f0-9]{64}$' },
        durableSequence: { type: 'integer', minimum: 0 }, persistedAt: { type: 'number', minimum: 0 },
      },
    },
    projection: {
      type: 'object', additionalProperties: false, required: ['checkpointSequence', 'checkpointedAt', 'status'],
      properties: {
        checkpointSequence: { type: 'integer', minimum: 0 }, checkpointedAt: { type: ['number', 'null'] },
        status: { type: 'string', enum: ['current', 'pending', 'unavailable'] }, errorCode: { type: 'string' },
      },
    },
    format: { type: 'string', enum: ['native', 'text', 'markdown'] },
    mediaType: { type: 'string', enum: ['application/vnd.canvas.native-document+json', 'text/plain', 'text/markdown'] },
    encoding: { type: 'string', const: 'utf-8' }, fragment: { type: 'string' }, byteOffset: { type: 'integer', minimum: 0 },
    byteLength: { type: 'integer', minimum: 0 }, totalBytes: { type: 'integer', minimum: 0 },
    nextCursor: { type: ['string', 'null'] }, complete: { type: 'boolean' },
  },
});

const errorCodes: Record<DocumentReadErrorCodeV1, true> = {
  INVALID_REQUEST: true, AUTHENTICATION_REQUIRED: true, ACCESS_DENIED: true, DOCUMENT_NOT_FOUND: true,
  DOCUMENT_SCOPE_CHANGED: true, DOCUMENT_VERSION_CONFLICT: true, DOCUMENT_STATE_MISSING: true,
  DOCUMENT_STATE_INVALID: true, DOCUMENT_QUARANTINED: true, DOCUMENT_BUSY: true,
  DOCUMENT_FORMAT_UNAVAILABLE: true, DOCUMENT_TOO_LARGE: true, READ_OUTCOME_UNCONFIRMED: true,
  DOCUMENT_READ_UNAVAILABLE: true,
};
export const DOCUMENT_READ_ERROR_JSON_SCHEMA_V1 = frozen({
  type: 'object', additionalProperties: false, required: ['apiVersion', 'success', 'code'],
  properties: {
    apiVersion: { type: 'integer', const: 1 }, success: { type: 'boolean', const: false },
    code: { type: 'string', enum: Object.keys(errorCodes) },
  },
});
