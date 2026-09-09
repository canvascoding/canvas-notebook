import { NextRequest } from 'next/server';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { fileGuestService, FileGuestError, parseFileGuestPermission } from '@/app/lib/file-guests/service';
import { assertFileGuestOrigin, fileGuestErrorResponse, fileGuestJson, readFileGuestBody } from '@/app/lib/file-guests/http';
import { parsePublicSharePolicy } from '@/app/lib/public-sharing/share-policy-input';

async function update(request: NextRequest, context: { params: Promise<{ id: string }> }, revoke: boolean) {
  const access = await requireRequestWorkspace(request, { permissions: ['canRead', 'canCreatePublicLinks'] });
  if (access.response) return access.response;
  try {
    assertFileGuestOrigin(request);
    const { id } = await context.params;
    const body = await readFileGuestBody(request);
    let expiresAt: Date | null | undefined;
    try { expiresAt = parsePublicSharePolicy(body).expiresAt; } catch (error) { throw new FileGuestError(error instanceof Error ? error.message : 'Ungültiger Ablauf.', 400); }
    return fileGuestJson({ success: true, invitation: await fileGuestService.manage(access.workspace, id, {
      policyRevision: typeof body.policyRevision === 'number' ? body.policyRevision : 0,
      ...(body.permission !== undefined ? { permission: parseFileGuestPermission(body.permission) } : {}), expiresAt, revoke,
    }) });
  } catch (error) { return fileGuestErrorResponse(error); }
}

export const PATCH = (request: NextRequest, context: { params: Promise<{ id: string }> }) => update(request, context, false);
export const DELETE = (request: NextRequest, context: { params: Promise<{ id: string }> }) => update(request, context, true);
