import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import { fileVersionCompareService } from '@/app/lib/file-version-center/compare-service';
import {
  parseFileVersionCompareRequestV1,
  type FileVersionCompareRequestV1,
} from '@/app/lib/file-version-center/contracts/v1';
import {
  authorizeFileVersionCenterRequest,
  FILE_VERSION_CENTER_PRIVATE_HEADERS,
  fileVersionCenterCaughtError,
} from '@/app/lib/file-version-center/route-adapter';

export async function POST(request: NextRequest) {
  try {
    const body = parseFileVersionCompareRequestV1(
      await readJsonBody<FileVersionCompareRequestV1>(request),
    );
    const authorization = await authorizeFileVersionCenterRequest(
      request,
      body.target.workspaceId,
      'canRead',
    );
    if (!authorization.authorized) return authorization.response;
    const limited = applyRateLimit(request, {
      limit: 90,
      windowMs: 60_000,
      keyPrefix: `file-version-center-compare:${authorization.session.user.id}`,
    });
    if (limited) {
      for (const [name, value] of Object.entries(FILE_VERSION_CENTER_PRIVATE_HEADERS)) {
        limited.headers.set(name, value);
      }
      return limited;
    }
    const comparison = await fileVersionCompareService.compareWithPreview({
      request: body,
      access: authorization.access,
      workspace: authorization.workspace,
    });
    return NextResponse.json(comparison, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return fileVersionCenterCaughtError(error);
  }
}
