import 'server-only';

import { NextRequest, NextResponse } from 'next/server';
import { FileGuestError } from './service';
import { FileGuestVersionError } from './versions';
import { FileGuestCheckpointRequestError } from './checkpoint-error';
import { FileGuestWriterCommitError, FileGuestWriterError } from './writer';
import { FileGuestTargetError } from './target';
import { FileGuestPreparationError } from './preparation';
import { FileGuestAssetReadError } from './asset-reader';
import { FileGuestInvitationAuthorityError, WorkspaceRequestPrincipalError } from '@/app/lib/workspaces/request-principal';
import { WorkspaceSideEffectWriterFenceError } from '@/app/lib/files/workspace-side-effect-writer-fence';
import { WorkspaceMutationLockError } from '@/app/lib/files/workspace-mutation-lock';
import { WorkspaceOperationBackupError } from '@/app/lib/files/workspace-operation-backup';
import { WorkspaceFileLifecycleBusyError } from '@/app/lib/files/workspace-file-lifecycle-guard';
import { MarkdownFileImportError } from '@/app/lib/collaboration/markdown-file-import';
import { CollaborationAdmissionError } from '@/app/lib/collaboration/room-admission-contract';
import { CollaborationCheckpointQuarantinedError, CollaborationCheckpointValidationError } from '@/app/lib/collaboration/checkpoint-errors';
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
  const named = (code:string,message:string,status:number) => fileGuestJson({success:false,code,error:message},status);
  if (error instanceof FileGuestWriterCommitError) return named(error.code,error.message,error.status);
  if (error instanceof FileGuestTargetError) return named(error.code,error.message,error.status);
  if (error instanceof FileGuestAssetReadError) return named(error.code,error.message,error.status);
  if (error instanceof FileGuestPreparationError) return named(error.code,
    error.status === 400 ? 'Aktuelle Dateiinformationen und ein gültiges Ziel sind erforderlich.'
      : error.status === 403 ? 'Zum Vorbereiten dieser Einladung fehlen die aktuellen Rechte.'
        : error.status === 413 ? 'Das Dokument oder die eingebetteten Bilder überschreiten das erlaubte Budget.'
          : error.status === 503 ? 'Der Abschluss der Einladungsvorbereitung ist unklar. Bitte den aktuellen Stand prüfen.'
            : 'Dokument oder eingebettete Bilder wurden geändert. Bitte neu laden.',error.status);
  if (error instanceof FileGuestWriterError) return named(error.code,error.code === 'FILE_GUEST_WRITE_INVALID'
    ? 'Eine gültige Gastaktion ist erforderlich.' : error.code === 'FILE_GUEST_WRITE_CHANGED'
      ? 'Die Einladung wurde geändert. Bitte neu laden.' : 'Zum Ändern dieser Einladung fehlen die aktuellen Rechte.',error.status);
  if (error instanceof FileGuestInvitationAuthorityError) return named(error.code,
    error.status === 400 ? 'Eine gültige Einladung ist erforderlich.' : error.status === 410 ? 'Die Einladung ist abgelaufen oder widerrufen.'
      : error.status === 409 ? 'Die ursprüngliche Dokumentbindung ist nicht mehr verfügbar. Bitte eine neue Einladung anlegen.'
        : 'Die Gastaktion ist nicht autorisiert.',error.status);
  if (error instanceof WorkspaceRequestPrincipalError) {
    const status = error.code === 'PRINCIPAL_AUTH_REVOKED' ? 401
      : ['PRINCIPAL_ACCESS_DENIED','PRINCIPAL_REQUIRED'].includes(error.code) ? 403
        : ['PRINCIPAL_BUSY','PRINCIPAL_SCOPE_CHANGED','PRINCIPAL_EXPIRED'].includes(error.code) ? 409 : 503;
    return named(error.code,status === 401 ? 'Die Anmeldung ist nicht mehr gültig.'
      : status === 403 ? 'Die aktuellen Zugriffs- oder Freigaberechte fehlen.'
        : status === 409 ? 'Datei oder Berechtigung wird gerade geändert. Bitte den aktuellen Stand neu laden.'
          : 'Die aktuellen Zugriffsrechte konnten nicht sicher bestätigt werden.',status);
  }
  if (error instanceof WorkspaceSideEffectWriterFenceError || error instanceof CollaborationAdmissionError
    || error instanceof WorkspaceFileLifecycleBusyError) return named(error.code,
    'Für diese Datei läuft eine andere Aktion oder ihre Bindung wurde geändert. Bitte den aktuellen Stand neu laden.',409);
  if (error instanceof WorkspaceMutationLockError) return named(error.code,'Die Dateiaktion ist momentan belegt oder nicht verfügbar.',error.status);
  if (error instanceof MarkdownFileImportError) return named(error.code,
    error.code === 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED' ? 'Der Abschluss des Dokumentimports ist unklar. Bitte den aktuellen Stand prüfen.'
      : 'Die ursprüngliche Datei wurde geändert oder kann noch nicht als Dokument übernommen werden.',
    error.code === 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED' ? 503 : error.status);
  if (error instanceof WorkspaceOperationBackupError) return named(error.code,'Die erforderliche Dokumentensicherung konnte nicht sicher erstellt werden.',409);
  if (error instanceof CollaborationCheckpointQuarantinedError || error instanceof CollaborationCheckpointValidationError) {
    return named('FILE_GUEST_NATIVE_UNAVAILABLE','Der native Dokumentstand ist nicht sicher verfügbar. Bitte den Einladenden kontaktieren.',409);
  }
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
