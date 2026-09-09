import { NextRequest } from 'next/server';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { fileGuestService, parseFileGuestPermission, FileGuestError } from '@/app/lib/file-guests/service';
import { assertFileGuestOrigin, fileGuestErrorResponse, fileGuestJson, readFileGuestBody } from '@/app/lib/file-guests/http';
import { parsePublicSharePolicy } from '@/app/lib/public-sharing/share-policy-input';

export async function GET(request: NextRequest) {
  const access = await requireRequestWorkspace(request, { permissions: ['canRead', 'canCreatePublicLinks'] });
  if (access.response) return access.response;
  try {
    const path = request.nextUrl.searchParams.get('path');
    if (!path) throw new FileGuestError('Dateipfad fehlt.', 400);
    return fileGuestJson({ success: true, invitations: await fileGuestService.list(access.workspace, path) });
  } catch (error) { return fileGuestErrorResponse(error); }
}

export async function POST(request: NextRequest) {
  const access = await requireRequestWorkspace(request, { permissions: ['canRead', 'canCreatePublicLinks'] });
  if (access.response) return access.response;
  try {
    assertFileGuestOrigin(request);
    const body = await readFileGuestBody(request);
    if (typeof body.path !== 'string' || typeof body.email !== 'string') throw new FileGuestError('Dateipfad und E-Mail-Adresse sind erforderlich.', 400);
    let expiresAt: Date | null | undefined;
    try { expiresAt = parsePublicSharePolicy(body).expiresAt; } catch (error) { throw new FileGuestError(error instanceof Error ? error.message : 'Ungültiger Ablauf.', 400); }
    const invitation = await fileGuestService.create({ workspace: access.workspace, path: body.path, email: body.email,
      permission: parseFileGuestPermission(body.permission), expiresAt: expiresAt === undefined ? new Date(Date.now() + 30 * 86_400_000) : expiresAt });
    return fileGuestJson({ success: true, invitation });
  } catch (error) { return fileGuestErrorResponse(error); }
}
