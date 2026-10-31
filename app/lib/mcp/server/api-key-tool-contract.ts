import 'server-only';

import type { Tool } from '@modelcontextprotocol/server';
import type { DirectMcpToolId } from './config';
import { DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES } from './document-read-tool-contract';
import { DIRECT_MCP_NATIVE_DOCUMENT_SEARCH_PROPERTIES } from './document-search-tool-contract';
import type { DirectMcpToolDescriptor } from './tool-descriptor';

/** Pure advertised transport contract. Loading an OAuth server must not
 * initialize the separate API-key document adapter or its authorization code. */
export const API_KEY_MCP_TOOLS: readonly DirectMcpToolId[] = Object.freeze(['read_knowledge_source', 'search_knowledge']);
type KeyScheme = { type: 'apiKey'; in: 'header'; name: 'X-Canvas-API-Key' };

export function apiKeyMcpToolDescriptor(descriptor: DirectMcpToolDescriptor): Tool & { securitySchemes: KeyScheme[] } {
  const securitySchemes: KeyScheme[] = [{ type: 'apiKey', in: 'header', name: 'X-Canvas-API-Key' }];
  const credentialFailure = { type: 'object', additionalProperties: false, required: ['apiVersion', 'success', 'code'],
    properties: { apiVersion: { type: 'integer', const: 1 }, success: { type: 'boolean', const: false },
      code: { type: 'string', pattern: '^API_KEY_[A-Z_]+$' } } };
  const workspace_id = { type: 'string', minLength: 1, maxLength: 256 };
  const inputSchema = descriptor.name === 'read_knowledge_source'
    ? { type: 'object' as const, additionalProperties: false, required: ['workspace_id', 'document_id'],
      properties: { workspace_id, ...DIRECT_MCP_NATIVE_DOCUMENT_READ_PROPERTIES } }
    : { type: 'object' as const, additionalProperties: false, required: ['api_version', 'workspace_id', 'query'],
      properties: { workspace_id, ...DIRECT_MCP_NATIVE_DOCUMENT_SEARCH_PROPERTIES,
        query: { type: 'string', minLength: 2, maxLength: 200 }, path: { type: 'string', maxLength: 4096, default: '.' },
        max_results: { type: 'integer', minimum: 1, maximum: 25 } } };
  return { ...descriptor, inputSchema, securitySchemes, _meta: { ...descriptor._meta, securitySchemes },
    ...(descriptor.outputSchema ? { outputSchema: { type: 'object', anyOf: [descriptor.outputSchema, credentialFailure] } } : {}) };
}
