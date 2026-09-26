import { NextRequest, NextResponse } from 'next/server';

import { parseProposalReviewTransformRequestV1 } from '@/app/lib/file-version-center/contracts/proposal-review-transform-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError } from '@/app/lib/file-version-center/contracts/proposal-graph-v1';
import { observeFileVersionCenter } from '@/app/lib/file-version-center/observability';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1, resolveFileVersionRolloutV1 } from '@/app/lib/file-version-center/policy-v1';
import { proposalReviewActionErrorResponse } from '@/app/lib/file-version-center/proposal-review-action-route-error';
import { proposalReviewWritesEnabled } from '@/app/lib/file-version-center/proposal-review-capability';
import { createRuntimeProposalReviewActionService } from '@/app/lib/file-version-center/proposal-review-action-runtime';
import { fileVersionCenterQueryService } from '@/app/lib/file-version-center/query-service';
import { applyFileVersionCenterRateLimit, authorizeFileVersionCenterRequest, FILE_VERSION_CENTER_PRIVATE_HEADERS,
  readFileVersionCenterJson } from '@/app/lib/file-version-center/route-adapter';

/** Server-owned original-intent replay. It stores only immutable preview artifacts, never document content. */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = parseProposalReviewTransformRequestV1(await readFileVersionCenterJson(request));
    const authorization = await authorizeFileVersionCenterRequest(request, body.target.workspaceId, 'canWrite');
    if (!authorization.authorized) return authorization.response;
    const limited = applyFileVersionCenterRateLimit(request, { operation: 'accept', rate: FILE_VERSION_CENTER_RATE_LIMITS_V1.reviewMutation,
      verifiedUserId: authorization.session.user.id, startedAt });
    if (limited) return limited;
    if (!proposalReviewWritesEnabled({ workspaceId: authorization.workspace.workspaceId })
      || !resolveFileVersionRolloutV1(process.env.FILE_VERSION_CENTER_MODE).restore) {
      throw new ProposalGraphContractError(Codes.upgradeRequired, 'Proposal transformations are not enabled yet.');
    }
    const target = await fileVersionCenterQueryService.resolve({ target: body.target, access: authorization.access });
    const service = await createRuntimeProposalReviewActionService({ target, workspace: authorization.workspace,
      access: authorization.access });
    const preview = await service.prepareTransform({ kind: body.kind, sourceProposalId: body.sourceProposalId,
      expectedGraphRevision: body.expectedGraphRevision });
    observeFileVersionCenter({ operation: 'accept', outcome: 'success', startedAt });
    return NextResponse.json(preview, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return proposalReviewActionErrorResponse(error, 'accept', startedAt);
  }
}
