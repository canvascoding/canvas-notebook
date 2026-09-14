import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import {
  parseFileVersionRestoreRequestV1,
  type FileVersionRestoreRequestV1,
} from '@/app/lib/file-version-center/contracts/v1';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1 } from '@/app/lib/file-version-center/policy-v1';
import {
  authorizeFileVersionCenterRequest,
  FILE_VERSION_CENTER_PRIVATE_HEADERS,
  fileVersionCenterCaughtError,
} from '@/app/lib/file-version-center/route-adapter';
import { fileVersionRestoreService } from '@/app/lib/file-version-center/restore-service';

export async function POST(request: NextRequest) {
  try {
    const body = parseFileVersionRestoreRequestV1(
      await readJsonBody<FileVersionRestoreRequestV1>(request),
    );
    const authorization = await authorizeFileVersionCenterRequest(
      request,
      body.target.workspaceId,
      'canWrite',
    );
    if (!authorization.authorized) return authorization.response;
    const limited = applyRateLimit(request, {
      limit: FILE_VERSION_CENTER_RATE_LIMITS_V1.restore.perUserPerMinute,
      windowMs: 60_000,
      keyPrefix: `file-version-center-restore:${authorization.session.user.id}`,
    });
    if (limited) {
      for (const [name, value] of Object.entries(FILE_VERSION_CENTER_PRIVATE_HEADERS)) {
        limited.headers.set(name, value);
      }
      return limited;
    }
    const restored = await fileVersionRestoreService.restore({
      request: body,
      access: authorization.access,
      workspace: authorization.workspace,
    });
    return NextResponse.json(restored, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return fileVersionCenterCaughtError(error);
  }
}
