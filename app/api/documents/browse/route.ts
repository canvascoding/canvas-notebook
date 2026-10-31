import { NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { DocumentReadError } from '@/app/lib/documents/contracts';
import { WorkspaceBrowseError } from '@/app/lib/documents/browse-contract';
import { browseWorkspaceForRequest } from '@/app/lib/documents/service';
import { apiKeyDocumentErrorResponse } from '@/app/lib/api-keys/http';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };

async function selection(request: NextRequest): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new WorkspaceBrowseError('INVALID_BROWSE_REQUEST');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 32 * 1024) { await reader.cancel(); throw new DocumentReadError('DOCUMENT_TOO_LARGE'); }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch { throw new WorkspaceBrowseError('INVALID_BROWSE_REQUEST'); }
  } finally { reader.releaseLock(); }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const limited = applyRateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'documents-browse-v1' });
  if (limited) { for (const [key, value] of Object.entries(headers)) limited.headers.set(key, value); return limited; }
  try { return NextResponse.json({ apiVersion: 1, ...await browseWorkspaceForRequest(original, await selection(request)) }, { headers }); }
  catch (error) {
    const credentialFailure = apiKeyDocumentErrorResponse(error, headers);
    if (credentialFailure) return credentialFailure;
    const failure = error instanceof WorkspaceBrowseError || error instanceof DocumentReadError
      ? error : new DocumentReadError('DOCUMENT_READ_UNAVAILABLE');
    return NextResponse.json({ apiVersion: 1, success: false, code: failure.code }, { status: failure.status, headers });
  }
}
