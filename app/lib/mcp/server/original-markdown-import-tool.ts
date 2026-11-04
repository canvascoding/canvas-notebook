import 'server-only';

import { ProtocolError, ProtocolErrorCode, type CallToolResult } from '@modelcontextprotocol/server';
import type { ApiKeyCredential } from '../../api-keys/authentication';
import { captureWorkspaceOperationNativePlanData } from '../../files/workspace-operation-native-plan-data';
import { decodeMarkdownOriginalImportSelectionV1, type MarkdownOriginalImportSelectionV1 } from '../../collaboration/markdown-original-import-contract';
import { apiKeyOriginalMarkdownImportPathVisible } from '../../collaboration/api-key-original-markdown-import-contract';
import { persistApiKeyOriginalMarkdownFileForWrite, readApiKeyOriginalMarkdownImportStatusForWrite } from '../../collaboration/markdown-file-import-persistence';
import { decodeMarkdownOriginalImportStatusV1, encodeMarkdownOriginalImportResultV1,
  markdownOriginalImportFailureV1 } from '../../documents/original-markdown-import-http';

type Selection = Readonly<{ action: 'import_existing'; request: MarkdownOriginalImportSelectionV1 }
  | { action: 'status_existing'; request: ReturnType<typeof decodeMarkdownOriginalImportStatusV1> }>;
function invalid(): never {
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Use api_version:1 and exact import_existing or status_existing arguments; upload arguments cannot be mixed with an existing-file import.');
}

/** Only detached finite argument data is inspected. A normal upload has no
 * existing-file action and retains its original decoder and grant. */
export function decodeApiKeyOriginalMarkdownImportMcpSelection(raw: unknown): Selection | null {
  const value = captureWorkspaceOperationNativePlanData(raw, invalid, 65_536);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>, action = row.action;
  if (action !== 'import_existing' && action !== 'status_existing') return null;
  const required = ['api_version', 'action', 'workspace_id', 'operation_id', ...(action === 'import_existing' ? ['path', 'expected_file_version'] : [])];
  const optional = action === 'import_existing' ? ['initial_representation'] : [];
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  try {
    if (action === 'status_existing') {
      const request = decodeMarkdownOriginalImportStatusV1({ apiVersion: row.api_version, workspaceId: row.workspace_id, operationId: row.operation_id });
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u.test(request.operationId)) return invalid();
      return Object.freeze({ action, request });
    }
    const request = decodeMarkdownOriginalImportSelectionV1({ apiVersion: row.api_version, workspaceId: row.workspace_id,
      operationId: row.operation_id, path: row.path, expectedFileVersion: row.expected_file_version,
      ...(Object.hasOwn(row, 'initial_representation') ? { initialRepresentation: row.initial_representation } : {}) });
    if (!apiKeyOriginalMarkdownImportPathVisible(request.path)) return invalid();
    return Object.freeze({ action, request });
  } catch { return invalid(); }
}

/** A real key phase is established by the original-file owner on every call.
 * No origin, request, Session or permission is reconstructed from arguments. */
export async function executeApiKeyOriginalMarkdownImportMcp(credential: ApiKeyCredential, selection: Selection,
  signal?: AbortSignal): Promise<CallToolResult> {
  try {
    signal?.throwIfAborted();
    let result;
    if (selection.action === 'import_existing') {
      const applied = await persistApiKeyOriginalMarkdownFileForWrite(credential, selection.request, 'mcp');
      result = encodeMarkdownOriginalImportResultV1(selection.request.operationId, applied.receipt,
        applied.disposition === 'applied' ? 'imported' : 'already_imported');
    } else {
      const receipt = await readApiKeyOriginalMarkdownImportStatusForWrite(credential, selection.request, 'mcp');
      result = encodeMarkdownOriginalImportResultV1(selection.request.operationId, receipt);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    const failure = markdownOriginalImportFailureV1(error);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure.body) }], structuredContent: failure.body };
  }
}
