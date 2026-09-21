import { NextRequest, NextResponse } from 'next/server';

import { parseProposalReviewCompareApiRequestV1 } from '@/app/lib/file-version-center/contracts/proposal-review-compare-api-v1';
import { observeFileVersionCenter } from '@/app/lib/file-version-center/observability';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1 } from '@/app/lib/file-version-center/policy-v1';
import { toProposalReviewRouteError } from '@/app/lib/file-version-center/proposal-review-route-error';
import { createRuntimeProposalReviewService } from '@/app/lib/file-version-center/proposal-review-runtime';
import { fileVersionCenterQueryService } from '@/app/lib/file-version-center/query-service';
import { applyFileVersionCenterRateLimit, authorizeFileVersionCenterRequest, FILE_VERSION_CENTER_PRIVATE_HEADERS, fileVersionCenterCaughtError, readFileVersionCenterJson } from '@/app/lib/file-version-center/route-adapter';

/** Read-only graph-aware proposal compare. It has no action/fence mutation route. */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = parseProposalReviewCompareApiRequestV1(await readFileVersionCenterJson(request));
    const authorization = await authorizeFileVersionCenterRequest(request, body.target.workspaceId, 'canRead');
    if (!authorization.authorized) return authorization.response;
    const limited = applyFileVersionCenterRateLimit(request, { operation: 'compare', rate: FILE_VERSION_CENTER_RATE_LIMITS_V1.compare,
      verifiedUserId: authorization.session.user.id, startedAt });
    if (limited) return limited;
    const target = await fileVersionCenterQueryService.resolve({ target: body.target, access: authorization.access });
    const review = await createRuntimeProposalReviewService({ target, workspace: authorization.workspace, access: authorization.access });
    const comparison = await review.createCompareService().compare({ selectedProposalIds: body.selectedProposalIds,
      binding: body.binding, cursor: body.cursor, limit: body.limit });
    observeFileVersionCenter({ operation: 'compare', outcome: comparison.diagnosis.availability === 'available' ? 'success' : 'denied', startedAt,
      itemCount: comparison.hunks.length });
    return NextResponse.json(comparison, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return fileVersionCenterCaughtError(toProposalReviewRouteError(error), { operation: 'compare', startedAt });
  }
}
