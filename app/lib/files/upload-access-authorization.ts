import 'server-only';

import { isBootstrapAdminEmail } from '@/app/lib/bootstrap-admin';
import { getUploadAccessGrant } from '@/app/lib/files/upload-access-store';
import { claimLegacyUploadAccess } from '@/app/lib/filesystem/upload-handler';
import {
  requireSessionWorkspace,
  type RequestWorkspaceSession,
} from '@/app/lib/workspaces/request';

export async function canSessionReadUpload(
  session: RequestWorkspaceSession,
  fileId: string,
): Promise<boolean> {
  let grant = await getUploadAccessGrant(fileId);
  if (!grant && isBootstrapAdminEmail(session.user.email)) {
    if (await claimLegacyUploadAccess(fileId, session.user.id)) {
      grant = await getUploadAccessGrant(fileId);
    }
  }
  if (!grant) return false;
  if (grant.ownerUserId === session.user.id) return true;
  if (!grant.workspaceId) return false;

  const workspaceResult = await requireSessionWorkspace(session, {
    workspaceId: grant.workspaceId,
    permissions: 'canRead',
  });
  return !workspaceResult.response;
}
