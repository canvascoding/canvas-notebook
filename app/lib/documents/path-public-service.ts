import 'server-only';
import type { ApiKeyCredential } from '../api-keys/authentication';
import { apiKeyDocumentFailureV1, type ApiKeyDocumentFailureV1 } from '../api-keys/error-result';
import { workspacePathFailureV1, type DirectMcpWorkspacePathFailureV1 } from '../mcp/server/workspace-path-tool-contract';
import { runApiKeyWorkspaceMoveService, runApiKeyWorkspaceDeleteService } from '../files/workspace-file-operation-service';
import { decodeApiKeyWorkspaceMoveRequest, decodeApiKeyWorkspaceDeleteRequest, selectApiKeyPathOperationId } from './path-contract';

export function apiKeyWorkspacePathFailure(error: unknown, value: unknown, source: 'request' | 'mcp'): Readonly<{
  body: DirectMcpWorkspacePathFailureV1 | (ApiKeyDocumentFailureV1 & Readonly<{ operationId?: string }>); status: number; retryAfter?: string;
}> {
  const operationId = selectApiKeyPathOperationId(value, source), credential = apiKeyDocumentFailureV1(error);
  if (credential) return Object.freeze({ ...credential, body: Object.freeze({ ...credential.body,
    ...(operationId === undefined ? {} : { operationId }) }) });
  return workspacePathFailureV1(error, operationId);
}

/** Genuine credential and fixed action enter the existing shared native owner.
 * Neither HTTP nor MCP constructs a Session, OAuth grant or import principal. */
export function moveWorkspaceForApiKey(credential: ApiKeyCredential, value: unknown, source: 'request' | 'mcp', signal?: AbortSignal) {
  return runApiKeyWorkspaceMoveService(decodeApiKeyWorkspaceMoveRequest(value, source), credential, source, signal);
}
export function deleteWorkspaceForApiKey(credential: ApiKeyCredential, value: unknown, source: 'request' | 'mcp', signal?: AbortSignal) {
  return runApiKeyWorkspaceDeleteService(decodeApiKeyWorkspaceDeleteRequest(value, source), credential, source, signal);
}
