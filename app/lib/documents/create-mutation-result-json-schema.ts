import { DOCUMENT_READ_PAGE_JSON_SCHEMA_V1 } from './read-json-schema';

/** Comparison data only. Schema validation never confirms a mutation or grants
 * access; the real caller owns current authority, COMMIT/recovery and cleanup. */
export const DOCUMENT_CREATE_MUTATION_RESULT_JSON_SCHEMA_V1 = Object.freeze({
  type: 'object', additionalProperties: false,
  required: Object.freeze(['apiVersion', 'operationId', 'outcome', 'document', 'currency', 'projection']),
  properties: Object.freeze({
    apiVersion: Object.freeze({ type: 'integer', const: 1 }),
    operationId: Object.freeze({ type: 'string', minLength: 1, maxLength: 256 }),
    outcome: Object.freeze({ type: 'string', enum: Object.freeze(['created', 'already_created']) }),
    document: DOCUMENT_READ_PAGE_JSON_SCHEMA_V1.properties.document,
    currency: Object.freeze({ ...DOCUMENT_READ_PAGE_JSON_SCHEMA_V1.properties.currency,
      properties: Object.freeze({ ...DOCUMENT_READ_PAGE_JSON_SCHEMA_V1.properties.currency.properties,
        source: Object.freeze({ type: 'string', const: 'persisted_yjs' }),
        observedDurable: Object.freeze({ type: 'boolean', const: true }),
      }),
    }),
    projection: Object.freeze({ type: 'object', additionalProperties: false,
      required: Object.freeze(['checkpointSequence', 'checkpointedAt', 'status']),
      properties: Object.freeze({ checkpointSequence: Object.freeze({ type: 'integer', minimum: 0 }),
        checkpointedAt: Object.freeze({ type: 'number', minimum: 0 }), status: Object.freeze({ type: 'string', const: 'current' }),
      }),
    }),
  }),
});
