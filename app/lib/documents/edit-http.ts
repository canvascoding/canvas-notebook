import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '../api/route-helpers';
import { DocumentEditError } from './edit-contracts';
import { documentEditFailureV1 } from './edit-error-result';
import { editDocumentForRequest, readDocumentEditStatusForRequest } from './edit-public-service';

const responseHeaders = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };

/** Bound the incoming byte stream before decoding or retaining any body. */
async function readDocumentEditJsonBody(request: NextRequest, maximumBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new DocumentEditError('INVALID_REQUEST');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new DocumentEditError('DOCUMENT_TOO_LARGE');
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown; }
    catch { throw new DocumentEditError('INVALID_REQUEST'); }
  } finally { reader.releaseLock(); }
}

/** Both routes use the same real Request authority as the shared edit engine.
 * The status route observes stored facts and cannot reconcile or apply them. */
export async function handleDocumentEditHttp(request: NextRequest, action: 'edit' | 'status'): Promise<NextResponse> {
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const limited = applyRateLimit(request, { limit: action === 'edit' ? 60 : 120, windowMs: 60_000,
    keyPrefix: `documents-edit-${action}-v1` });
  if (limited) {
    for (const [name, value] of Object.entries(responseHeaders)) limited.headers.set(name, value);
    return limited;
  }
  try {
    const value = await readDocumentEditJsonBody(request, action === 'edit' ? 512 * 1024 : 32 * 1024);
    const result = action === 'edit' ? await editDocumentForRequest(original, value)
      : await readDocumentEditStatusForRequest(original, value);
    return NextResponse.json(result, { headers: responseHeaders });
  } catch (error) {
    const failure = documentEditFailureV1(error);
    return NextResponse.json(failure.body, { status: failure.status, headers: responseHeaders });
  }
}
