import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '../api/route-helpers';
import { authenticateApiKeyRequest } from '../api-keys/authentication';
import { WORKSPACE_COPY_REQUEST_MAX_BYTES, WorkspaceCopyToolError } from '../mcp/server/workspace-copy-tool-contract';
import { apiKeyWorkspaceCopyFailure, copyWorkspaceForApiKey } from './copy-public-service';
import { readNativeDocumentRequestJson } from './request-json';

const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
async function readBody(request: NextRequest): Promise<unknown> {
  return readNativeDocumentRequestJson(request, { maxBytes: WORKSPACE_COPY_REQUEST_MAX_BYTES,
    invalidRequest: () => new WorkspaceCopyToolError('INVALID_REQUEST'),
    tooLarge: () => new WorkspaceCopyToolError('COPY_TOO_LARGE') });
}

/** Independent native programmatic route. Authentication precedes body reads;
 * legacy browser /api/files/copy retains its genuine Session contract. */
export async function handleApiKeyWorkspaceCopyHttp(request: NextRequest): Promise<NextResponse> {
  const limited = applyRateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'documents-copy-v1' });
  if (limited) {
    const raw = Number(limited.headers.get('retry-after'));
    const retry = Number.isFinite(raw) && raw > 0 ? String(Math.min(60, Math.max(1, Math.ceil(raw)))) : '60';
    return NextResponse.json({ apiVersion: 1, success: false, code: 'API_KEY_RATE_LIMITED' }, { status: 429, headers: { ...headers, 'Retry-After': retry } });
  }
  let value: unknown;
  try {
    const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers), signal: request.signal });
    const credential = await authenticateApiKeyRequest(original);
    value = await readBody(request);
    const result = await copyWorkspaceForApiKey(credential, value, 'request', request.signal);
    return NextResponse.json(result, { headers });
  } catch (error) {
    const failure = apiKeyWorkspaceCopyFailure(error, value, 'request');
    return NextResponse.json(failure.body, { status: failure.status, headers: { ...headers,
      ...(failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {}) } });
  }
}
