import { NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { DocumentReadError, type DocumentReadErrorV1 } from '@/app/lib/documents/contracts';
import { readDocumentForRequest } from '@/app/lib/documents/service';

export const runtime = 'nodejs';
const MAX_SELECTION_BYTES = 32 * 1024;

async function selection(request: NextRequest): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new DocumentReadError('INVALID_REQUEST');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_SELECTION_BYTES) {
        await reader.cancel(); throw new DocumentReadError('DOCUMENT_TOO_LARGE');
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch { throw new DocumentReadError('INVALID_REQUEST'); }
  } finally { reader.releaseLock(); }
}

/** Complete version-bound pages. The central service owns real authorization
 * and does not resolve a native document through its physical Markdown path. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const limited = applyRateLimit(request, { limit: 120, windowMs: 60_000, keyPrefix: 'documents-read-v1' });
  if (limited) return limited;
  try {
    const page = await readDocumentForRequest(original, await selection(request));
    return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  } catch (error) {
    const failure = error instanceof DocumentReadError ? error : new DocumentReadError('DOCUMENT_READ_UNAVAILABLE');
    const body: DocumentReadErrorV1 = { apiVersion: 1, success: false, code: failure.code };
    return NextResponse.json(body, { status: failure.status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
  }
}
