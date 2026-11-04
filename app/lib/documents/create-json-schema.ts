import type { Tool } from '@modelcontextprotocol/server';
import { DOCUMENT_CREATE_MUTATION_RESULT_JSON_SCHEMA_V1 } from './create-mutation-result-json-schema';

export const DOCUMENT_CREATE_ERROR_CODES_V1 = [
  'INVALID_REQUEST', 'DOCUMENT_TOO_LARGE', 'DOCUMENT_CREATE_UNSUPPORTED', 'DOCUMENT_CREATE_CONFLICT',
  'DOCUMENT_BUSY', 'DOCUMENT_IMPORT_URL_REJECTED', 'DOCUMENT_IMPORT_FAILED',
  'CREATE_OUTCOME_UNCONFIRMED', 'DOCUMENT_CREATE_UNAVAILABLE',
] as const;

export const DOCUMENT_CREATE_FAILURE_JSON_SCHEMA_V1 = {
  type: 'object', additionalProperties: false, required: ['apiVersion', 'success', 'code'],
  properties: { apiVersion: { type: 'integer', const: 1 }, success: { type: 'boolean', const: false },
    code: { type: 'string', enum: DOCUMENT_CREATE_ERROR_CODES_V1 } },
};

/** Pure advertised native contract; importing it cannot initialize authority. */
export function apiKeyDocumentCreateSchemas(input: Tool['inputSchema']) {
  const properties = Object.fromEntries(Object.entries(input.properties ?? {}).filter(([name]) => name !== 'action'));
  const payload = Object.hasOwn(properties, 'file') ? 'file' : 'content';
  return {
    input: { type: 'object' as const, additionalProperties: false,
      properties: { ...properties, api_version: { type: 'integer', const: 1 } },
      required: [...new Set([...(input.required ?? []), 'api_version', payload])] },
    output: { type: 'object' as const, anyOf: [DOCUMENT_CREATE_MUTATION_RESULT_JSON_SCHEMA_V1, DOCUMENT_CREATE_FAILURE_JSON_SCHEMA_V1] },
  };
}
