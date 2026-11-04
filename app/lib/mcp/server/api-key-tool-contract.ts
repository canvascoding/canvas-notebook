import 'server-only';

import type { Tool } from '@modelcontextprotocol/server';
import type { DirectMcpToolId } from './config';
import { DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES } from './document-read-tool-contract';
import { DIRECT_MCP_NATIVE_DOCUMENT_SEARCH_PROPERTIES } from './document-search-tool-contract';
import type { DirectMcpToolDescriptor } from './tool-descriptor';
import { DOCUMENT_READ_ERROR_JSON_SCHEMA_V1 } from '../../documents/read-json-schema';
import { apiKeyDocumentCreateSchemas } from '../../documents/create-json-schema';
import { apiKeyOriginalMarkdownImportSchemas } from '../../documents/original-markdown-import-json-schema';

/** Pure advertised transport contract. Loading an OAuth server must not
 * initialize the separate API-key document adapter or its authorization code. */
export const API_KEY_MCP_TOOLS: readonly DirectMcpToolId[] = Object.freeze(['list_workspaces', 'get_workspace_overview',
  'list_knowledge_tree', 'get_knowledge_manifest', 'read_knowledge_source', 'search_knowledge', 'edit_knowledge_source',
  'create_knowledge_source', 'import_knowledge_file', 'copy_knowledge_source', 'move_knowledge_source', 'delete_knowledge_source']);
type KeyScheme = { type: 'apiKey'; in: 'header'; name: 'X-Canvas-API-Key' };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** Reuse the canonical descriptor's native fields. This pure metadata module
 * must not import the runtime edit service merely to advertise its schema. */
function nativeEditSchemas(descriptor: DirectMcpToolDescriptor) {
  const input = descriptor.inputSchema, output = descriptor.outputSchema;
  const outputs = output && Array.isArray(output.oneOf) ? output.oneOf.filter(branch =>
    record(record(record(branch)?.properties)?.apiVersion)?.const === 1) : [];
  if (outputs.length !== 2) throw new Error('Native edit descriptor branches are unavailable.');
  const keys = ['api_version', 'action', 'workspace_id', 'document_id', 'expected_version', 'idempotency_key', 'patch', 'operation_id'];
  const properties: NonNullable<Tool['inputSchema']['properties']> = {};
  for (const key of keys) {
    const property = input.properties?.[key];
    if (property === undefined) throw new Error('Native edit descriptor properties are unavailable.');
    properties[key] = property;
  }
  return { input: { type: 'object' as const, additionalProperties: false, properties,
    required: ['api_version', 'action', 'workspace_id'], $defs: input.$defs, examples: input.examples,
    description: 'Native edit requires api_version=1, action=edit, workspace_id, document_id, expected_version, idempotency_key and patch. Native status requires api_version=1, action=status, workspace_id and operation_id. Mixing shapes is rejected.' },
    output: { ...output, oneOf: outputs } };
}

function nativePathOutputSchema(descriptor: DirectMcpToolDescriptor) {
  const schema = descriptor.outputSchema, branches = schema?.oneOf;
  if (!Array.isArray(branches)) throw new Error('Native path descriptor branches are unavailable.');
  const native = branches.filter(branch => {
    const preview = record(record(branch)?.properties)?.preview;
    return record(record(record(preview)?.properties)?.kind)?.const !== 'native-path-import-preparation';
  });
  if (branches.length - native.length !== 2) throw new Error('Native path import descriptor branches are unavailable.');
  return { ...schema, oneOf: native };
}

export function apiKeyMcpToolDescriptor(descriptor: DirectMcpToolDescriptor): Tool & { securitySchemes: KeyScheme[] } {
  const securitySchemes: KeyScheme[] = [{ type: 'apiKey', in: 'header', name: 'X-Canvas-API-Key' }];
  const credentialFailure = { type: 'object', additionalProperties: false, required: ['apiVersion', 'success', 'code'],
    properties: { apiVersion: { type: 'integer', const: 1 }, success: { type: 'boolean', const: false },
      code: { type: 'string', pattern: '^API_KEY_[A-Z_]+$' },
      operationId: { type: 'string', maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' } } };
  const edit = descriptor.name === 'edit_knowledge_source' ? nativeEditSchemas(descriptor) : null;
  const create = descriptor.name === 'create_knowledge_source' || descriptor.name === 'import_knowledge_file'
    ? apiKeyDocumentCreateSchemas(descriptor.inputSchema) : null;
  const originalImport = descriptor.name === 'import_knowledge_file' && create ? apiKeyOriginalMarkdownImportSchemas(create) : null;
  const workspace_id = { type: 'string', minLength: 1, maxLength: 256 };
  const copy = descriptor.name === 'copy_knowledge_source';
  const path = descriptor.name === 'move_knowledge_source' || descriptor.name === 'delete_knowledge_source';
  const inputSchema = originalImport?.input ?? (copy || path ? descriptor.inputSchema : create ? create.input : edit ? edit.input : descriptor.name === 'list_workspaces'
    ? { type: 'object' as const, additionalProperties: false, properties: {} }
    : ['get_workspace_overview', 'list_knowledge_tree', 'get_knowledge_manifest'].includes(descriptor.name)
    ? { ...descriptor.inputSchema, properties: { ...descriptor.inputSchema.properties, workspace_id } }
    : descriptor.name === 'read_knowledge_source'
    ? { type: 'object' as const, additionalProperties: false, required: ['workspace_id', 'document_id'],
      properties: { workspace_id, ...DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES } }
    : { type: 'object' as const, additionalProperties: false, required: ['api_version', 'workspace_id', 'query'],
      properties: { workspace_id, ...DIRECT_MCP_NATIVE_DOCUMENT_SEARCH_PROPERTIES,
        query: { type: 'string', minLength: 2, maxLength: 200 }, path: { type: 'string', maxLength: 4096, default: '.' },
        max_results: { type: 'integer', minimum: 1, maximum: 25 } } });
  const outputSchema = originalImport?.output ?? (path ? nativePathOutputSchema(descriptor) : null) ?? create?.output ?? edit?.output ?? descriptor.outputSchema ?? (descriptor.name === 'get_knowledge_manifest' ? {
    type: 'object', additionalProperties: false, required: ['workspace_id', 'path', 'entries', 'directories', 'next_cursor', 'has_more', 'truncated_by_depth', 'coverage'],
    properties: { workspace_id: { type: 'string' }, path: { type: 'string' }, entries: { type: 'array', items: { type: 'object' } },
      directories: { type: 'array', items: { type: 'object' } }, next_cursor: { type: ['string', 'null'] }, has_more: { type: 'boolean' },
      truncated_by_depth: { type: 'boolean' }, coverage: { type: 'object' } },
  } : undefined);
  const browseFailure = { type: 'object', additionalProperties: false, required: ['apiVersion', 'success', 'code'], properties: {
    apiVersion: { type: 'integer', const: 1 }, success: { type: 'boolean', const: false },
    code: { type: 'string', enum: ['INVALID_BROWSE_REQUEST', 'INVALID_TREE_REQUEST', 'WORKSPACE_TREE_CHANGED'] } } };
  return { ...descriptor, inputSchema, securitySchemes, _meta: { ...descriptor._meta, securitySchemes },
    ...(path ? { description: 'Native Move/Delete V1 preview/apply/status/recover in one explicitly allowed workspace. Requires the key move or delete grant and current native workspace permissions; Status additionally requires status, Recover additionally requires recover. Delete supports native documents, physical files and mixed folder cohorts. Existing originals must be imported through a separately granted operation; these tools never implicitly import. Retain the exact caller operation_id, preview plan_id and original paths after uncertainty. Inspect status, then explicitly recover the same operation; never automatically replay or generate a replacement ID. Native mutations must be enabled for Preview/Apply/Recover; historical Status retains current authorization checks.' } : {}),
    ...(copy ? { description: 'Native Copy V1 preview/apply/status/recover with explicit source and destination workspace IDs. Requires the key copy grant, current source Read and destination Write/Agent rights; Status additionally requires status, Recover additionally requires recover. Apply retains the caller operation_id, exact preview plan_id and resolved root selections. Inspect status after an uncertain result; explicit recover never changes the operation or automatically replays it.' } : {}),
    ...(create ? { description: originalImport
      ? 'Import a genuine uploaded HTTPS file as a new document with api_version:1, file, path, workspace_id and idempotency_key; omit action for uploads. For a file already in the workspace use action:import_existing with api_version:1, workspace_id, path, a stable operation_id and exact expected_file_version from get_knowledge_manifest (file_version, not revision). Optional initial_representation is auto/plain_text/tiptap_xml/tiptap_blocks. Existing originals are preserved. Use action:status_existing with only api_version, workspace_id and operation_id after uncertainty; never automatically replay or invent a new ID. Existing-file results are original import facts, not current path/version or projection. Read the document by documentId before editing; obtain a fresh action preview before Move/Delete. Requires the key import grant and current Write/Agent rights; status_existing additionally requires status. Hidden workspace paths are unavailable.'
      : 'Create a new native Markdown document with api_version:1, content, path, workspace_id and a stable idempotency_key. Never overwrites an existing file. Retain the caller key after an uncertain outcome; explicitly repeat only the identical operation. Requires the separate create grant and current workspace rights. Success includes the stable documentId and confirmed durable version.' } : {}),
    ...(edit ? { description: 'Native documentId/full-version Edit V1 or read-only operation Status V1. Supply a stable idempotency_key. Only state:confirmed proves persistence. Retain the returned operationId after an uncertain outcome; inspect action:status with operation_id without replay. Edit requires the key edit grant; Status additionally requires status. Each call checks current user/workspace rights.' } : {}),
    ...(descriptor.name === 'get_workspace_overview' ? { description: 'Shows an explicitly allowed workspace, bounded top-level contents and read-adapter limits. API keys require current read rights; each call rechecks access.' } : {}),
    ...(outputSchema ? { outputSchema: { type: 'object', anyOf: [outputSchema, credentialFailure, DOCUMENT_READ_ERROR_JSON_SCHEMA_V1, browseFailure] } } : {}) };
}
