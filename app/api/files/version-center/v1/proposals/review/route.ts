import { NextRequest, NextResponse } from 'next/server';
import { parseProposalReviewSessionRequestV1 } from '@/app/lib/file-version-center/contracts/proposal-review-session-v1';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1 } from '@/app/lib/file-version-center/policy-v1';
import { readProposalReviewSession } from '@/app/lib/file-version-center/proposal-review-session';
import { fileVersionCenterQueryService } from '@/app/lib/file-version-center/query-service';
import { proposalReviewActionErrorResponse } from '@/app/lib/file-version-center/proposal-review-action-route-error';
import { applyFileVersionCenterRateLimit, authorizeFileVersionCenterRequest, FILE_VERSION_CENTER_PRIVATE_HEADERS,
  readFileVersionCenterJson } from '@/app/lib/file-version-center/route-adapter';

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = parseProposalReviewSessionRequestV1(await readFileVersionCenterJson(request));
    const authorization = await authorizeFileVersionCenterRequest(request, body.target.workspaceId, 'canRead');
    if (!authorization.authorized) return authorization.response;
    const limited = applyFileVersionCenterRateLimit(request, { operation: 'compare', rate: FILE_VERSION_CENTER_RATE_LIMITS_V1.compare,
      verifiedUserId: authorization.session.user.id, startedAt });
    if (limited) return limited;
    const target = await fileVersionCenterQueryService.resolve({ target: body.target, access: authorization.access });
    const result = await readProposalReviewSession({ request: body, target, workspace: authorization.workspace, access: authorization.access });
    return NextResponse.json(result, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return proposalReviewActionErrorResponse(error, 'compare', startedAt);
  }
}
