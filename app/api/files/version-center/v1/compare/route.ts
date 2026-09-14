import { NextRequest, NextResponse } from 'next/server';

import { fileVersionCompareService } from '@/app/lib/file-version-center/compare-service';
import { parseFileVersionCompareRequestV1 } from '@/app/lib/file-version-center/contracts/v1';
import { observeFileVersionCenter } from '@/app/lib/file-version-center/observability';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1 } from '@/app/lib/file-version-center/policy-v1';
import {
  applyFileVersionCenterRateLimit,
  authorizeFileVersionCenterRequest,
  FILE_VERSION_CENTER_PRIVATE_HEADERS,
  fileVersionCenterCaughtError,
  readFileVersionCenterJson,
} from '@/app/lib/file-version-center/route-adapter';

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = parseFileVersionCompareRequestV1(
      await readFileVersionCenterJson(request),
    );
    const authorization = await authorizeFileVersionCenterRequest(
      request,
      body.target.workspaceId,
      'canRead',
    );
    if (!authorization.authorized) {
      observeFileVersionCenter({ operation: 'compare', outcome: 'denied', startedAt });
      return authorization.response;
    }
    const limited = applyFileVersionCenterRateLimit(request, {
      operation: 'compare',
      rate: FILE_VERSION_CENTER_RATE_LIMITS_V1.compare,
      verifiedUserId: authorization.session.user.id,
      startedAt,
    });
    if (limited) return limited;
    const comparison = await fileVersionCompareService.compareWithPreview({
      request: body,
      access: authorization.access,
      workspace: authorization.workspace,
    });
    observeFileVersionCenter({
      operation: 'compare',
      outcome: comparison.response.truncated ? 'truncated' : 'success',
      startedAt,
      hunkCount: comparison.response.hunks.length,
      truncated: comparison.response.truncated,
    });
    return NextResponse.json(comparison, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return fileVersionCenterCaughtError(error, { operation: 'compare', startedAt });
  }
}
