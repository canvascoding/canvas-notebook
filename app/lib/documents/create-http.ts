import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { applyRateLimit } from '../api/route-helpers';
import { authenticateApiKeyRequest } from '../api-keys/authentication';
import { DocumentCreateError, type DocumentCreateAction } from './create-contract';
import { createDocumentForApiKey, documentCreateFailureV1 } from './create-public-service';

const responseHeaders = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
async function readCreateBody(request: NextRequest, action: DocumentCreateAction): Promise<unknown> {
  // JSON can escape each code unit using six bytes; actual text is separately
  // capped at 512 KiB of valid UTF-8 before reaching the existing native writer.
  const maximum = action === 'create' ? 6 * 512 * 1024 + 32 * 1024 : 32 * 1024;
  const reader = request.body?.getReader();
  if (!reader) throw new DocumentCreateError('INVALID_REQUEST');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) { void reader.cancel().catch(() => undefined); throw new DocumentCreateError('DOCUMENT_TOO_LARGE'); }
      chunks.push(next.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new DocumentCreateError('INVALID_REQUEST'); }
  } finally { reader.releaseLock(); }
}

/** New native programmatic routes require an explicit real API key. Browser
 * Session creation and uploads retain their existing /api/files entry points. */
export async function handleDocumentCreateHttp(request: NextRequest, action: DocumentCreateAction): Promise<NextResponse> {
  const limited = applyRateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: `documents-${action}-v1` });
  if (limited) {
    const raw = Number(limited.headers.get('retry-after'));
    const retryAfter = Number.isFinite(raw) && raw > 0 ? String(Math.min(60, Math.max(1, Math.ceil(raw)))) : '60';
    return NextResponse.json({ apiVersion: 1, success: false, code: 'API_KEY_RATE_LIMITED' },
      { status: 429, headers: { ...responseHeaders, 'Retry-After': retryAfter } });
  }
  try {
    const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers), signal: request.signal });
    const credential = await authenticateApiKeyRequest(original);
    const value = await readCreateBody(request, action);
    const result = await createDocumentForApiKey(credential, value, action, 'request', request.signal);
    return NextResponse.json(result, { headers: responseHeaders });
  } catch (error) {
    const failure = documentCreateFailureV1(error);
    return NextResponse.json(failure.body, { status: failure.status, headers: { ...responseHeaders,
      ...('retryAfter' in failure && failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {}) } });
  }
}
