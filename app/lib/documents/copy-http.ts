import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '../api/route-helpers';
import { authenticateApiKeyRequest } from '../api-keys/authentication';
import { WORKSPACE_COPY_REQUEST_MAX_BYTES, WorkspaceCopyToolError } from '../mcp/server/workspace-copy-tool-contract';
import { apiKeyWorkspaceCopyFailure, copyWorkspaceForApiKey } from './copy-public-service';

const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
async function readBody(request: NextRequest): Promise<unknown> {
  const reader = request.body?.getReader(); if (!reader) throw new WorkspaceCopyToolError('INVALID_REQUEST');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > WORKSPACE_COPY_REQUEST_MAX_BYTES) {
        void reader.cancel().catch(() => undefined); throw new WorkspaceCopyToolError('COPY_TOO_LARGE');
      }
      chunks.push(item.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
    catch { throw new WorkspaceCopyToolError('INVALID_REQUEST'); }
  } finally { reader.releaseLock(); }
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
    const credential = await authenticateApiKeyRequest(request);
    value = await readBody(request);
    const result = await copyWorkspaceForApiKey(credential, value, 'request', request.signal);
    return NextResponse.json(result, { headers });
  } catch (error) {
    const failure = apiKeyWorkspaceCopyFailure(error, value, 'request');
    return NextResponse.json(failure.body, { status: failure.status, headers: { ...headers,
      ...(failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {}) } });
  }
}
