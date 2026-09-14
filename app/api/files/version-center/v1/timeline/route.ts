import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import {
  parseFileVersionTimelineRequestV1,
  type FileVersionTimelineRequestV1,
} from '@/app/lib/file-version-center/contracts/v1';
import { fileVersionCenterQueryService } from '@/app/lib/file-version-center/query-service';
import {
  authorizeFileVersionCenterRequest,
  FILE_VERSION_CENTER_PRIVATE_HEADERS,
  fileVersionCenterCaughtError,
} from '@/app/lib/file-version-center/route-adapter';

export async function POST(request: NextRequest) {
  try {
    const body = parseFileVersionTimelineRequestV1(
      await readJsonBody<FileVersionTimelineRequestV1>(request),
    );
    const authorization = await authorizeFileVersionCenterRequest(
      request,
      body.target.workspaceId,
      'canRead',
    );
    if (!authorization.authorized) return authorization.response;
    const limited = applyRateLimit(request, {
      limit: 120,
      windowMs: 60_000,
      keyPrefix: `file-version-center-timeline:${authorization.session.user.id}`,
    });
    if (limited) {
      for (const [name, value] of Object.entries(FILE_VERSION_CENTER_PRIVATE_HEADERS)) {
        limited.headers.set(name, value);
      }
      return limited;
    }
    const timeline = await fileVersionCenterQueryService.timeline({
      target: body.target,
      access: authorization.access,
      workspace: authorization.workspace,
      ...(body.cursor ? { cursor: body.cursor } : {}),
      limit: body.limit ?? 25,
    });
    return NextResponse.json(timeline, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return fileVersionCenterCaughtError(error);
  }
}
