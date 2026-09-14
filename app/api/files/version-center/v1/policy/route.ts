import { NextRequest, NextResponse } from 'next/server';

import {
  FILE_VERSION_CENTER_ERROR_CODES,
  FileVersionCenterContractError,
  parseFileReviewPolicyUpdateRequestV1,
} from '@/app/lib/file-version-center/contracts/v1';
import { observeFileVersionCenter } from '@/app/lib/file-version-center/observability';
import { FILE_VERSION_CENTER_RATE_LIMITS_V1 } from '@/app/lib/file-version-center/policy-v1';
import { fileVersionCenterQueryService } from '@/app/lib/file-version-center/query-service';
import {
  fileReviewPolicyService,
  FileReviewPolicyServiceError,
} from '@/app/lib/file-version-center/review-policy-service';
import {
  applyFileVersionCenterRateLimit,
  authorizeFileVersionCenterRequest,
  FILE_VERSION_CENTER_PRIVATE_HEADERS,
  fileVersionCenterCaughtError,
  readFileVersionCenterJson,
} from '@/app/lib/file-version-center/route-adapter';

function policyRouteError(error: unknown): unknown {
  if (!(error instanceof FileReviewPolicyServiceError)) return error;
  if (error.code === 'policy_conflict') {
    return new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.policyConflict, error.message);
  }
  if (error.code === 'access_denied') {
    return new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.accessDenied, error.message);
  }
  if (error.code === 'target_invalid') {
    return new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.notFound, error.message);
  }
  if (error.code === 'policy_inconsistent') {
    return new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.persistenceUnavailable, error.message);
  }
  return new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest, error.message);
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const body = parseFileReviewPolicyUpdateRequestV1(
      await readFileVersionCenterJson(request),
    );
    const authorization = await authorizeFileVersionCenterRequest(
      request,
      body.target.workspaceId,
      'canWrite',
    );
    if (!authorization.authorized) {
      observeFileVersionCenter({ operation: 'policy', outcome: 'denied', startedAt });
      return authorization.response;
    }
    const limited = applyFileVersionCenterRateLimit(request, {
      operation: 'policy',
      rate: FILE_VERSION_CENTER_RATE_LIMITS_V1.policyMutation,
      verifiedUserId: authorization.session.user.id,
      startedAt,
    });
    if (limited) return limited;

    const timeline = await fileVersionCenterQueryService.timeline({
      target: body.target,
      access: authorization.access,
      workspace: authorization.workspace,
      limit: 1,
    });
    if (!timeline.capabilities.agentReviewPolicy || !timeline.policy) {
      throw new FileVersionCenterContractError(
        FILE_VERSION_CENTER_ERROR_CODES.capabilityUnavailable,
        'The review policy cannot be changed for this document.',
      );
    }
    const reauthorization = await authorizeFileVersionCenterRequest(
      request,
      body.target.workspaceId,
      'canWrite',
    );
    if (!reauthorization.authorized) {
      observeFileVersionCenter({ operation: 'policy', outcome: 'denied', startedAt });
      return reauthorization.response;
    }
    const policy = await fileReviewPolicyService.writeAuthorized({
      access: reauthorization.access,
      lineageId: timeline.document.lineageId,
      requestedMode: body.requestedMode,
      expectedRevision: body.expectedRevision,
      workspacePolicy: timeline.policy.reason === 'workspace_policy' ? 'force_review' : 'allow_user_choice',
    });
    observeFileVersionCenter({ operation: 'policy', outcome: 'success', startedAt });
    return NextResponse.json(policy, { headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
  } catch (error) {
    return fileVersionCenterCaughtError(policyRouteError(error), { operation: 'policy', startedAt });
  }
}
