import { NextRequest, NextResponse } from 'next/server';

import { parseProposalReviewActionApiRequestV1 } from '@/app/lib/file-version-center/contracts/proposal-review-session-v1';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1, resolveFileVersionRolloutV1 } from '@/app/lib/file-version-center/policy-v1';
import { observeFileVersionCenter } from '@/app/lib/file-version-center/observability';
import { proposalReviewWritesEnabled } from '@/app/lib/file-version-center/proposal-review-capability';
import { createRuntimeProposalReviewActionService } from '@/app/lib/file-version-center/proposal-review-action-runtime';
import { proposalReviewActionErrorResponse } from '@/app/lib/file-version-center/proposal-review-action-route-error';
import { fileVersionCenterQueryService } from '@/app/lib/file-version-center/query-service';
import { applyFileVersionCenterRateLimit, authorizeFileVersionCenterRequest, FILE_VERSION_CENTER_PRIVATE_HEADERS,
  readFileVersionCenterJson } from '@/app/lib/file-version-center/route-adapter';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError } from '@/app/lib/file-version-center/contracts/proposal-graph-v1';

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = parseProposalReviewActionApiRequestV1(await readFileVersionCenterJson(request));
    const authorization = await authorizeFileVersionCenterRequest(request, body.target.workspaceId, 'canWrite');
    if (!authorization.authorized) return authorization.response;
    const operation = ['reject', 'branch_reject'].includes(body.action.fence.actionType) ? 'reject' : 'accept';
    const limited = applyFileVersionCenterRateLimit(request, { operation, rate: FILE_VERSION_CENTER_RATE_LIMITS_V1.reviewMutation,
      verifiedUserId: authorization.session.user.id, startedAt });
    if (limited) return limited;
    if (!proposalReviewWritesEnabled() || !resolveFileVersionRolloutV1(process.env.FILE_VERSION_CENTER_MODE).restore) {
      throw new ProposalGraphContractError(Codes.upgradeRequired, 'Proposal review actions are not enabled yet.');
    }
    const target = await fileVersionCenterQueryService.resolve({ target: body.target, access: authorization.access });
    const actionService = await createRuntimeProposalReviewActionService({ target, workspace: authorization.workspace,
      access: authorization.access, reviewerSessionId: authorization.session.session.id });
    const receipt = await actionService.execute(body.action);
    observeFileVersionCenter({ operation, outcome: 'success', startedAt });
    return NextResponse.json(receipt, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return proposalReviewActionErrorResponse(error, 'accept', startedAt);
  }
}
