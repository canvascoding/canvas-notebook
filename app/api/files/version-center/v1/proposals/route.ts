import { NextRequest, NextResponse } from 'next/server';
import { parseProposalReviewProjectionRequestV1 } from '@/app/lib/file-version-center/contracts/proposal-review-api-v1';
import { fileVersionCenterQueryService } from '@/app/lib/file-version-center/query-service';
import { readProposalReviewProjection } from '@/app/lib/file-version-center/proposal-review-read-service';
import { applyFileVersionCenterRateLimit, authorizeFileVersionCenterRequest, FILE_VERSION_CENTER_PRIVATE_HEADERS, fileVersionCenterCaughtError, readFileVersionCenterJson } from '@/app/lib/file-version-center/route-adapter';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1 } from '@/app/lib/file-version-center/policy-v1';
import { observeFileVersionCenter } from '@/app/lib/file-version-center/observability';
import { toProposalReviewRouteError } from '@/app/lib/file-version-center/proposal-review-route-error';

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = parseProposalReviewProjectionRequestV1(await readFileVersionCenterJson(request));
    const authorization = await authorizeFileVersionCenterRequest(request, body.target.workspaceId, 'canRead');
    if (!authorization.authorized) return authorization.response;
    const limited = applyFileVersionCenterRateLimit(request, { operation: 'timeline', rate: FILE_VERSION_CENTER_RATE_LIMITS_V1.timeline,
      verifiedUserId: authorization.session.user.id, startedAt });
    if (limited) return limited;
    const target = await fileVersionCenterQueryService.resolve({ target: body.target, access: authorization.access });
    const projection = await readProposalReviewProjection({ request: body, target, workspace: authorization.workspace, access: authorization.access });
    observeFileVersionCenter({ operation: 'timeline', outcome: 'success', startedAt, itemCount: projection.items.length });
    return NextResponse.json(projection, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return fileVersionCenterCaughtError(toProposalReviewRouteError(error), { operation: 'timeline', startedAt });
  }
}
