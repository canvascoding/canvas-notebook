import { NextRequest, NextResponse } from 'next/server';

import { parseFileVersionTimelineRequestV1 } from '@/app/lib/file-version-center/contracts/v1';
import { observeFileVersionCenter } from '@/app/lib/file-version-center/observability';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1 } from '@/app/lib/file-version-center/policy-v1';
import { fileVersionCenterQueryService } from '@/app/lib/file-version-center/query-service';
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
    const body = parseFileVersionTimelineRequestV1(
      await readFileVersionCenterJson(request),
    );
    const authorization = await authorizeFileVersionCenterRequest(
      request,
      body.target.workspaceId,
      'canRead',
    );
    if (!authorization.authorized) {
      observeFileVersionCenter({ operation: 'timeline', outcome: 'denied', startedAt });
      return authorization.response;
    }
    const limited = applyFileVersionCenterRateLimit(request, {
      operation: 'timeline',
      rate: FILE_VERSION_CENTER_RATE_LIMITS_V1.timeline,
      verifiedUserId: authorization.session.user.id,
      startedAt,
    });
    if (limited) return limited;
    const timeline = await fileVersionCenterQueryService.timeline({
      target: body.target,
      access: authorization.access,
      workspace: authorization.workspace,
      ...(body.cursor ? { cursor: body.cursor } : {}),
      limit: body.limit ?? 25,
    });
    observeFileVersionCenter({
      operation: 'timeline',
      outcome: 'success',
      startedAt,
      itemCount: timeline.entries.length,
    });
    return NextResponse.json(timeline, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return fileVersionCenterCaughtError(error, { operation: 'timeline', startedAt });
  }
}
