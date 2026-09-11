import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { FileGuestError } from './service';
import { FileGuestVersionError } from './versions';
import { FileGuestCheckpointRequestError } from './checkpoint-error';
import { isConfiguredTrustedOrigin } from '@/app/lib/security/trusted-origins';
import { rateLimit } from '@/app/lib/utils/rate-limit';
import { fileGuestCookieName } from './types';
import { LicenseEntitlementError } from '@/app/lib/license/entitlements';

export const FILE_GUEST_HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer',
};
export const fileGuestJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: FILE_GUEST_HEADERS });
export const guestRequestToken = (request: NextRequest, id: string) => request.cookies.get(fileGuestCookieName(id))?.value || '';

export function fileGuestErrorResponse(error: unknown) {
  if (error instanceof FileGuestCheckpointRequestError) return fileGuestJson(error.payload, error.status);
  if (error instanceof FileGuestError || error instanceof FileGuestVersionError) return fileGuestJson({ success: false, error: error.message }, error.status);
  if (error instanceof SyntaxError) return fileGuestJson({ success: false, error: 'Ungültiges JSON.' }, 400);
  const status = error instanceof LicenseEntitlementError ? error.statusCode : error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500;
  if (status === 402 || status === 403) return fileGuestJson({ success: false, error: 'Ein aktiver Team-Tarif mit PostgreSQL ist für Gastkollaboration erforderlich.' }, status);
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return fileGuestJson({ success: false, error: 'Datei nicht gefunden.' }, 404);
  console.error('[FileGuests] Request failed', { name: error instanceof Error ? error.name : typeof error });
  return fileGuestJson({ success: false, error: 'Der Dateizugang ist momentan nicht verfügbar.' }, 500);
}

export function assertFileGuestOrigin(request: NextRequest) {
  if (!isConfiguredTrustedOrigin(request.headers.get('origin') ?? undefined)) throw new FileGuestError('Diese Anfrage stammt nicht von der Notebook-Instanz.');
}

export function fileGuestRateLimit(request: NextRequest, action: string) {
  // Opaque auth cookies and forwarded addresses are not trusted identities.
  return rateLimit(new NextRequest(request.url), { keyPrefix: `file-guest-${action}`, limit: action === 'challenge' ? 30 : 240, windowMs: 60_000 });
}

export async function readFileGuestBody(request: NextRequest): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new FileGuestError('JSON ist erforderlich.', 415);
  if (Number(request.headers.get('content-length') || 0) > 8192) throw new FileGuestError('Die Anfrage ist zu groß.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new FileGuestError('Eine Anfrage ist erforderlich.', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) { await reader.cancel(); throw new FileGuestError('Die Anfrage ist zu groß.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FileGuestError('Ein JSON-Objekt ist erforderlich.', 400);
  return body as Record<string, unknown>;
}
