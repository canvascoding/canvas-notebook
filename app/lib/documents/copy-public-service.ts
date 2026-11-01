import 'server-only';
import type { ApiKeyCredential } from '../api-keys/authentication';
import { apiKeyDocumentFailureV1, type ApiKeyDocumentFailureV1 } from '../api-keys/error-result';
import { workspaceCopyFailureV1, type DirectMcpWorkspaceCopyFailureV1 } from '../mcp/server/workspace-copy-tool-contract';
import { runApiKeyWorkspaceCopyService } from '../files/workspace-file-operation-service';
import { decodeApiKeyWorkspaceCopyRequest, selectApiKeyCopyOperationId } from './copy-contract';

export function apiKeyWorkspaceCopyFailure(error: unknown, value: unknown, source: 'request' | 'mcp'): Readonly<{
  body: DirectMcpWorkspaceCopyFailureV1 | (ApiKeyDocumentFailureV1 & Readonly<{ operationId?: string }>); status: number; retryAfter?: string;
}> {
  const operationId = selectApiKeyCopyOperationId(value, source), credential = apiKeyDocumentFailureV1(error);
  if (credential) return Object.freeze({ ...credential, body: Object.freeze({ ...credential.body,
    ...(operationId === undefined ? {} : { operationId }) }) });
  return workspaceCopyFailureV1(error, operationId);
}

/** Genuine credential -> bounded native request -> existing shared Copy service.
 * Raw errors, filesystem roots and authorization material never enter replies. */
export function copyWorkspaceForApiKey(credential: ApiKeyCredential, value: unknown, source: 'request' | 'mcp', signal?: AbortSignal) {
  return runApiKeyWorkspaceCopyService(decodeApiKeyWorkspaceCopyRequest(value, source), credential, source, signal);
}
