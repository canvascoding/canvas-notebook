import 'server-only';

import { ProtocolError, ProtocolErrorCode, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiKeyCredential } from '../../api-keys/authentication';
import { ApiKeyAccessError } from '../../api-keys/contracts';
import { assertApiKeyMcpToolEnabled } from '../../api-keys/mcp-runtime';
import { DocumentReadError } from '../../documents/contracts';
import { DocumentSearchError } from '../../documents/search-contract';
import { decodeMcpWorkspaceBrowseRequest, WorkspaceBrowseError } from '../../documents/browse-contract';
import { browseWorkspaceForApiKeyMcp, listWorkspacesForApiKey, readDocumentForApiKeyMcp, searchDocumentsForApiKeyMcp } from '../../documents/service';
import type { DirectMcpToolId } from './config';
import { decodeDirectMcpDocumentReadSelection } from './document-read-tool-contract';
import { decodeDirectMcpDocumentSearchSelection } from './document-search-tool-contract';
import { decodeDirectMcpNativeDocumentEditSelection, formatDirectMcpNativeDocumentEditResult,
  formatDirectMcpNativeDocumentEditError } from './document-edit-tool-contract';
import { editDocumentForApiKeyMcp, readDocumentEditStatusForApiKeyMcp } from '../../documents/edit-public-service';
import { DocumentCreateError } from '../../documents/create-contract';

export async function executeApiKeyMcpTool(tool: DirectMcpToolId, args: unknown, credential: ApiKeyCredential, signal?: AbortSignal): Promise<CallToolResult> {
  try {
    await assertApiKeyMcpToolEnabled(tool);
    let page: unknown;
    if (tool === 'list_workspaces') {
      if (!z.object({}).strict().safeParse(args === undefined ? {} : args).success) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'list_workspaces does not accept arguments.');
      }
      page = { workspaces: await listWorkspacesForApiKey(credential, 'mcp') };
    } else if (tool === 'list_knowledge_tree' || tool === 'get_workspace_overview' || tool === 'get_knowledge_manifest') {
      let selection;
      try { selection = decodeMcpWorkspaceBrowseRequest(tool, args); }
      catch { throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Use bounded workspace browse arguments and visible relative paths.'); }
      page = await browseWorkspaceForApiKeyMcp(credential, selection);
    } else if (tool === 'create_knowledge_source' || tool === 'import_knowledge_file') {
      const { createDocumentForApiKey } = await import('../../documents/create-public-service');
      page = await createDocumentForApiKey(credential, args, tool === 'create_knowledge_source' ? 'create' : 'import', 'mcp', signal);
    } else if (tool === 'copy_knowledge_source') {
      const [{ copyWorkspaceForApiKey }, { formatDirectMcpWorkspaceCopyResult }] = await Promise.all([
        import('../../documents/copy-public-service'), import('./workspace-copy-tool-contract')]);
      return formatDirectMcpWorkspaceCopyResult(await copyWorkspaceForApiKey(credential, args, 'mcp', signal));
    } else if (tool === 'edit_knowledge_source') {
      const selection = decodeDirectMcpNativeDocumentEditSelection(args);
      if (!selection) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Use api_version:1 and native Edit/Status arguments.');
      const result = selection.action === 'edit' ? await editDocumentForApiKeyMcp(credential, selection.request)
        : await readDocumentEditStatusForApiKeyMcp(credential, selection.request);
      return formatDirectMcpNativeDocumentEditResult(result);
    } else if (tool === 'read_knowledge_source') {
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
    if (error instanceof ProtocolError) throw error;
    if (tool === 'copy_knowledge_source') {
      const { apiKeyWorkspaceCopyFailure } = await import('../../documents/copy-public-service');
      const { body } = apiKeyWorkspaceCopyFailure(error, args, 'mcp');
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
    }
    if (tool === 'create_knowledge_source' || tool === 'import_knowledge_file') {
      if (error instanceof DocumentCreateError && error.code === 'INVALID_REQUEST') {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Use api_version:1 with exact native Markdown Create/Import arguments.');
      }
      const { documentCreateFailureV1 } = await import('../../documents/create-public-service');
      const { body } = documentCreateFailureV1(error);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
    }
    if (tool === 'edit_knowledge_source') return formatDirectMcpNativeDocumentEditError(error);
    if (error instanceof ApiKeyAccessError || error instanceof DocumentReadError || error instanceof DocumentSearchError || error instanceof WorkspaceBrowseError) {
      const failure = { apiVersion: 1, success: false, code: error.code };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure };
    }
    const failure = { apiVersion: 1, success: false, code: 'DOCUMENT_READ_UNAVAILABLE' };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure };
  }
}
