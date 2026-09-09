import { NextRequest } from 'next/server';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { listFileGuestVersions, readFileGuestVersion, restoreFileGuestVersion } from '@/app/lib/file-guests/versions';
import { FileGuestError } from '@/app/lib/file-guests/service';
import { assertFileGuestOrigin, fileGuestErrorResponse, fileGuestJson, readFileGuestBody } from '@/app/lib/file-guests/http';

export async function GET(request: NextRequest) {
  const access = await requireRequestWorkspace(request, { permissions: ['canRead', 'canWrite', 'canCreatePublicLinks'] });
  if (access.response) return access.response;
  try {
    const path = request.nextUrl.searchParams.get('path');
    if (!path) throw new FileGuestError('Dateipfad fehlt.', 400);
    const versionId = request.nextUrl.searchParams.get('versionId');
    if (versionId) return fileGuestJson({ success: true, version: await readFileGuestVersion(access.workspace, path, versionId) });
    return fileGuestJson({ success: true, ...await listFileGuestVersions(access.workspace, path) });
  } catch (error) { return fileGuestErrorResponse(error); }
}

export async function POST(request: NextRequest) {
  const access = await requireRequestWorkspace(request, { permissions: ['canRead', 'canWrite', 'canCreatePublicLinks'] });
  if (access.response) return access.response;
  try {
    assertFileGuestOrigin(request);
    const body = await readFileGuestBody(request);
    if (typeof body.path !== 'string' || typeof body.versionId !== 'string' || typeof body.stateFingerprint !== 'string') throw new FileGuestError('Datei, Version und aktueller Stand sind erforderlich.', 400);
    await restoreFileGuestVersion({ workspace: access.workspace, path: body.path, versionId: body.versionId,
      stateFingerprint: body.stateFingerprint, sessionId: access.session.session.id });
    return fileGuestJson({ success: true });
  } catch (error) { return fileGuestErrorResponse(error); }
}
