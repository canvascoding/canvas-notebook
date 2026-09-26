import { NextRequest, NextResponse } from 'next/server';

import { parseProposalReviewActionStatusRequestV1 } from '@/app/lib/file-version-center/contracts/proposal-review-session-v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError } from '@/app/lib/file-version-center/contracts/proposal-graph-v1';
import { observeFileVersionCenter } from '@/app/lib/file-version-center/observability';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1, resolveFileVersionRolloutV1 } from '@/app/lib/file-version-center/policy-v1';
import { proposalReviewActionErrorResponse } from '@/app/lib/file-version-center/proposal-review-action-route-error';
import { proposalReviewWritesEnabled } from '@/app/lib/file-version-center/proposal-review-capability';
import { createRuntimeProposalReviewActionService } from '@/app/lib/file-version-center/proposal-review-action-runtime';
import { fileVersionCenterQueryService } from '@/app/lib/file-version-center/query-service';
import { applyFileVersionCenterRateLimit, authorizeFileVersionCenterRequest, FILE_VERSION_CENTER_PRIVATE_HEADERS,
  readFileVersionCenterJson } from '@/app/lib/file-version-center/route-adapter';

/** Resolve only an existing scoped receipt; pending content uses durable evidence recovery. */
export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = parseProposalReviewActionStatusRequestV1(await readFileVersionCenterJson(request));
    const authorization = await authorizeFileVersionCenterRequest(request, body.target.workspaceId, 'canWrite');
    if (!authorization.authorized) return authorization.response;
    const limited = applyFileVersionCenterRateLimit(request, { operation: 'accept', rate: FILE_VERSION_CENTER_RATE_LIMITS_V1.reviewMutation,
      verifiedUserId: authorization.session.user.id, startedAt });
    if (limited) return limited;
    if (!proposalReviewWritesEnabled() || !resolveFileVersionRolloutV1(process.env.FILE_VERSION_CENTER_MODE).restore) {
      throw new ProposalGraphContractError(Codes.upgradeRequired, 'Proposal review actions are not enabled yet.');
    }
    const target = await fileVersionCenterQueryService.resolve({ target: body.target, access: authorization.access });
    const actionService = await createRuntimeProposalReviewActionService({ target, workspace: authorization.workspace,
      access: authorization.access, reviewerSessionId: authorization.session.session.id });
    // A lower bound captured before the locked lookup prevents an absent read
    // just before expiry from being mistaken for proof after expiry.
    const checkedAt = Date.now();
    const receipt = await actionService.status({ idempotencyKey: body.idempotencyKey, requestDigest: body.requestDigest });
    observeFileVersionCenter({ operation: 'accept', outcome: 'success', startedAt });
    return NextResponse.json({ receipt, checkedAt }, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return proposalReviewActionErrorResponse(error, 'accept', startedAt);
  }
}
