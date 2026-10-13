import { NextRequest, NextResponse } from 'next/server';

import { FILE_VERSION_CENTER_ERROR_CODES, FileVersionCenterContractError,
  parseFileVersionRestoreRequestV1 } from '@/app/lib/file-version-center/contracts/v1';
import { observeFileVersionCenter } from '@/app/lib/file-version-center/observability';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1 } from '@/app/lib/file-version-center/policy-v1';
import {
  applyFileVersionCenterRateLimit,
  authorizeFileVersionCenterRequest,
  FILE_VERSION_CENTER_PRIVATE_HEADERS,
  fileVersionCenterCaughtError,
  readFileVersionCenterJson,
} from '@/app/lib/file-version-center/route-adapter';
import { fileVersionRestoreService } from '@/app/lib/file-version-center/restore-service';

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = parseFileVersionRestoreRequestV1(
      await readFileVersionCenterJson(request),
    );
    const authorization = await authorizeFileVersionCenterRequest(
      request,
      body.target.workspaceId,
      'canWrite',
    );
    if (!authorization.authorized) {
      observeFileVersionCenter({ operation: 'restore', outcome: 'denied', startedAt });
      return authorization.response;
    }
    const limited = applyFileVersionCenterRateLimit(request, {
      operation: 'restore',
      rate: FILE_VERSION_CENTER_RATE_LIMITS_V1.restore,
      verifiedUserId: authorization.session.user.id,
      startedAt,
    });
    if (limited) return limited;
    const reauthorization = await authorizeFileVersionCenterRequest(
      request,
      body.target.workspaceId,
      'canWrite',
    );
    if (!reauthorization.authorized) {
      observeFileVersionCenter({ operation: 'restore', outcome: 'denied', startedAt });
      return reauthorization.response;
    }
    if (reauthorization.session.user.id !== authorization.session.user.id
      || reauthorization.session.session.id !== authorization.session.session.id) {
      throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
        'The authenticated restore session changed.');
    }
    const restored = await fileVersionRestoreService.restore({
      request: body,
      access: reauthorization.access,
      workspace: reauthorization.workspace,
      actorSessionId: reauthorization.session.session.id,
      beforeApply: async () => {
        const fresh = await authorizeFileVersionCenterRequest(request, body.target.workspaceId, 'canWrite');
        if (!fresh.authorized || fresh.session.user.id !== authorization.session.user.id
          || fresh.session.session.id !== authorization.session.session.id
          || fresh.workspace.workspaceId !== reauthorization.workspace.workspaceId
          || fresh.workspace.rootPath !== reauthorization.workspace.rootPath
          || (fresh.workspace.organizationId ?? null) !== (reauthorization.workspace.organizationId ?? null)
          || request.signal.aborted) {
          throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.accessDenied,
            'Current authenticated workspace write permission is required for restore.');
        }
        return fresh.workspace;
      },
    });
    observeFileVersionCenter({ operation: 'restore', outcome: 'success', startedAt });
    return NextResponse.json(restored, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return fileVersionCenterCaughtError(error, { operation: 'restore', startedAt });
  }
}
