import { NextRequest, NextResponse } from 'next/server';

import { parseFileVersionRestoreRequestV1 } from '@/app/lib/file-version-center/contracts/v1';
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
    const restored = await fileVersionRestoreService.restore({
      request: body,
      access: reauthorization.access,
      workspace: reauthorization.workspace,
    });
    observeFileVersionCenter({ operation: 'restore', outcome: 'success', startedAt });
    return NextResponse.json(restored, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return fileVersionCenterCaughtError(error, { operation: 'restore', startedAt });
  }
}
