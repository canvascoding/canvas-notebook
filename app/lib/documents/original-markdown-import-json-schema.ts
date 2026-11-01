import type { Tool } from '@modelcontextprotocol/server';

const operationId = { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$' };
const workspaceId = { type: 'string', minLength: 1, maxLength: 256 };
const path = { type: 'string', minLength: 1, maxLength: 4096, description: 'Existing visible workspace-relative .md or .markdown file. Obtain its exact physical file_version from get_knowledge_manifest; a content revision is not a file version.' };
const shared = { api_version: { type: 'integer', const: 1 }, workspace_id: workspaceId, operation_id: operationId };
const applyProperties = { ...shared, action: { type: 'string', const: 'import_existing' }, path,
  expected_file_version: { type: 'string', minLength: 1, maxLength: 1024,
    pattern: '^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+([.][0-9]+)?:-?[0-9]+([.][0-9]+)?$' },
  initial_representation: { type: 'string', enum: ['auto', 'plain_text', 'tiptap_xml', 'tiptap_blocks'], default: 'auto' } };
const statusProperties = { ...shared, action: { type: 'string', const: 'status_existing' } };
const confirmed = { type: 'object', additionalProperties: false,
  required: ['apiVersion', 'operationId', 'status', 'outcome', 'documentAtImport', 'source', 'requiresFreshFileActionPreview'],
  properties: { apiVersion: { type: 'integer', const: 1 }, operationId, status: { type: 'string', const: 'confirmed' },
    outcome: { type: 'string', enum: ['imported', 'already_imported'] }, requiresFreshFileActionPreview: { type: 'boolean', const: true },
    documentAtImport: { type: 'object', additionalProperties: false,
      required: ['workspaceId', 'organizationId', 'documentId', 'lineageId', 'path', 'representation', 'lifecycleGeneration', 'schemaVersion', 'documentSequence', 'stateProof', 'persistedAt'],
      properties: { workspaceId, organizationId: { type: ['string', 'null'] }, documentId: { type: 'string', minLength: 1, maxLength: 256 },
        lineageId: { type: 'string', minLength: 1, maxLength: 256 }, path,
        representation: { type: 'string', enum: ['plain_text', 'tiptap_xml', 'tiptap_blocks'] }, lifecycleGeneration: { type: 'integer', minimum: 1 },
        schemaVersion: { type: 'integer', const: 1 }, documentSequence: { type: 'integer', const: 0 },
        stateProof: { type: 'string', pattern: '^yjs-snapshot-sha256-v1:[a-f0-9]{64}$' }, persistedAt: { type: 'integer', minimum: 0 } } },
    source: { type: 'object', additionalProperties: false, required: ['sha256', 'bytes'],
      properties: { sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, bytes: { type: 'integer', minimum: 0, maximum: 5 * 1024 * 1024 } } } } };
const notFound = { type: 'object', additionalProperties: false,
  required: ['apiVersion', 'operationId', 'status', 'requiresFreshFileActionPreview'],
  properties: { apiVersion: { type: 'integer', const: 1 }, operationId, status: { type: 'string', const: 'not_found' },
    requiresFreshFileActionPreview: { type: 'boolean', const: true } } };
const failure = { type: 'object', additionalProperties: false, required: ['apiVersion', 'success', 'code'],
  properties: { apiVersion: { type: 'integer', const: 1 }, success: { type: 'boolean', const: false },
    code: { type: 'string', minLength: 1, maxLength: 96, pattern: '^[A-Z][A-Z0-9_]+$' } } };

/** Pure discovery metadata. Schema publication creates no key, Session,
 * workspace grant, importer or database connection. Each branch is exact. */
export function apiKeyOriginalMarkdownImportSchemas(upload: { input: Tool['inputSchema']; output: Record<string, unknown> }) {
  const apply = { type: 'object', additionalProperties: false, properties: applyProperties,
    required: ['api_version', 'action', 'workspace_id', 'path', 'operation_id', 'expected_file_version'] };
  const status = { type: 'object', additionalProperties: false, properties: statusProperties,
    required: ['api_version', 'action', 'workspace_id', 'operation_id'] };
  return { input: { type: 'object' as const, additionalProperties: false, required: ['api_version', 'workspace_id'],
    properties: { ...upload.input.properties, ...applyProperties,
      action: { type: 'string', enum: ['import_existing', 'status_existing'] } },
    oneOf: [upload.input, apply, status] },
  output: { type: 'object' as const, anyOf: [upload.output, confirmed, notFound, failure] } };
}
