import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '../api/route-helpers';
import { authenticateApiKeyRequest } from '../api-keys/authentication';
import { WORKSPACE_PATH_REQUEST_MAX_BYTES, WorkspacePathToolError } from '../mcp/server/workspace-path-tool-contract';
import { apiKeyWorkspacePathFailure, moveWorkspaceForApiKey, deleteWorkspaceForApiKey } from './path-public-service';
import { readNativeDocumentRequestJson } from './request-json';

const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
async function handleApiKeyWorkspacePathHttp(request: NextRequest, kind: 'move' | 'delete'): Promise<NextResponse> {
  const limited = applyRateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: `documents-${kind}-v1` });
  if (limited) {
    const raw = Number(limited.headers.get('retry-after'));
    const retry = Number.isFinite(raw) && raw > 0 ? String(Math.min(60, Math.max(1, Math.ceil(raw)))) : '60';
    return NextResponse.json({ apiVersion: 1, success: false, code: 'API_KEY_RATE_LIMITED' }, { status: 429, headers: { ...headers, 'Retry-After': retry } });
  }
  let value: unknown;
  try {
    const credential = await authenticateApiKeyRequest(request);
    value = await readNativeDocumentRequestJson(request, { maxBytes: WORKSPACE_PATH_REQUEST_MAX_BYTES,
      invalidRequest: () => new WorkspacePathToolError('INVALID_REQUEST'), tooLarge: () => new WorkspacePathToolError('PATH_TOO_LARGE') });
    const result = await (kind === 'move' ? moveWorkspaceForApiKey : deleteWorkspaceForApiKey)(credential, value, 'request', request.signal);
    return NextResponse.json(result, { headers });
  } catch (error) {
    const failure = apiKeyWorkspacePathFailure(error, value, 'request');
    return NextResponse.json(failure.body, { status: failure.status, headers: { ...headers,
      ...(failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {}) } });
  }
}

export function handleApiKeyWorkspaceMoveHttp(request: NextRequest): Promise<NextResponse> { return handleApiKeyWorkspacePathHttp(request, 'move'); }
export function handleApiKeyWorkspaceDeleteHttp(request: NextRequest): Promise<NextResponse> { return handleApiKeyWorkspacePathHttp(request, 'delete'); }
