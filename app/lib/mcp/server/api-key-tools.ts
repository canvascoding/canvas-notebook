import 'server-only';

import { ProtocolError, ProtocolErrorCode, type CallToolResult } from '@modelcontextprotocol/server';
import type { ApiKeyCredential } from '../../api-keys/authentication';
import { ApiKeyAccessError } from '../../api-keys/contracts';
import { assertApiKeyMcpToolEnabled } from '../../api-keys/mcp-runtime';
import { DocumentReadError } from '../../documents/contracts';
import { DocumentSearchError } from '../../documents/search-contract';
import { readDocumentForApiKeyMcp, searchDocumentsForApiKeyMcp } from '../../documents/service';
import type { DirectMcpToolId } from './config';
import { decodeDirectMcpDocumentReadSelection } from './document-read-tool-contract';
import { decodeDirectMcpDocumentSearchSelection } from './document-search-tool-contract';

export async function executeApiKeyMcpTool(tool: DirectMcpToolId, args: unknown, credential: ApiKeyCredential): Promise<CallToolResult> {
  try {
    await assertApiKeyMcpToolEnabled(tool);
    let page: unknown;
    if (tool === 'read_knowledge_source') {
      const selection = decodeDirectMcpDocumentReadSelection(args);
      if (!selection) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Use a stable document_id for API-key native reads.');
      const read = await readDocumentForApiKeyMcp(credential, selection);
      if (read.document.path.replaceAll('\\', '/').split('/').some(segment => !segment || segment.startsWith('.'))) {
        throw new DocumentReadError('ACCESS_DENIED');
      }
      page = read;
    } else if (tool === 'search_knowledge') {
      const selection = decodeDirectMcpDocumentSearchSelection(args);
      if (!selection) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Use api_version:1 for API-key native search.');
      page = await searchDocumentsForApiKeyMcp(credential, selection);
    } else throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'The requested API-key adapter is not available.');
    return { content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: page as Record<string, unknown> };
  } catch (error) {
    if (error instanceof ApiKeyAccessError || error instanceof DocumentReadError || error instanceof DocumentSearchError) {
      const failure = { apiVersion: 1, success: false, code: error.code };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure };
    }
    if (error instanceof ProtocolError) throw error;
    const failure = { apiVersion: 1, success: false, code: 'DOCUMENT_READ_UNAVAILABLE' };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure };
  }
}
