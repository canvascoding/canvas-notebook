import { NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { DocumentReadError } from '@/app/lib/documents/contracts';
import { DocumentSearchError } from '@/app/lib/documents/search-contract';
import { searchDocumentsForRequest } from '@/app/lib/documents/service';

export const runtime = 'nodejs';
const MAX_SELECTION_BYTES = 32 * 1024;
const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };

async function selection(request: NextRequest): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new DocumentSearchError('INVALID_SEARCH_REQUEST');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_SELECTION_BYTES) { await reader.cancel(); throw new DocumentSearchError('INVALID_SEARCH_REQUEST'); }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch { throw new DocumentSearchError('INVALID_SEARCH_REQUEST'); }
  } finally { reader.releaseLock(); }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const limited = applyRateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'documents-search-v1' });
  if (limited) { for (const [key, value] of Object.entries(headers)) limited.headers.set(key, value); return limited; }
  try { return NextResponse.json(await searchDocumentsForRequest(original, await selection(request)), { headers }); }
  catch (error) {
    const failure = error instanceof DocumentSearchError || error instanceof DocumentReadError
      ? error : new DocumentReadError('DOCUMENT_READ_UNAVAILABLE');
    return NextResponse.json({ apiVersion: 1, success: false, code: failure.code }, { status: failure.status, headers });
  }
}
