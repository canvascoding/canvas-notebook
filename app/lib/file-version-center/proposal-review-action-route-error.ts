import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { FILE_VERSION_CENTER_ERROR_CODES as FileCodes } from './contracts/v1';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError } from './contracts/proposal-graph-v1';
import { observeFileVersionCenter, type FileVersionCenterOperation } from './observability';
import { toProposalReviewRouteError } from './proposal-review-route-error';
import { FILE_VERSION_CENTER_PRIVATE_HEADERS, fileVersionCenterCaughtError } from './route-adapter';
import { proposalReviewBuildMarker } from './proposal-review-build-marker';

const conflicts = new Set<string>([Codes.graphChanged, Codes.currentChanged, Codes.candidateChanged,
  Codes.parentChanged, Codes.batchConflict, Codes.choiceConflict, Codes.staleLifecycle, Codes.fenceExpired,
  Codes.invalidTransition, Codes.recoveryRequired, Codes.noEffect]);

/** Preserve bounded graph reason codes for refresh/recovery without reflecting private exception text. */
export async function proposalReviewActionErrorResponse(error: unknown, operation: FileVersionCenterOperation, startedAt: number) {
  const reference = { correlationId: randomUUID(), timestamp: Date.now(),
    phase: operation === 'compare' ? 'review' : 'action', buildMarker: proposalReviewBuildMarker() };
  if (!(error instanceof ProposalGraphContractError)) {
    const response = fileVersionCenterCaughtError(toProposalReviewRouteError(error), { operation, startedAt });
    const mapped = await response.json() as { error: { code: string; retryable: boolean } };
    const diagnosis = { reasonCode: mapped.error.code, ...reference };
    // Link server logs to the user-copyable reference without logging exception
    // messages, database queries, document content or request-supplied fields.
    const databaseCode = error && typeof error === 'object' && 'code' in error ? error.code : null;
    console.info(JSON.stringify({ component: 'proposal_review_error', operation, ...diagnosis,
      cause: databaseCode === '40P01' ? 'database_deadlock'
        : databaseCode === '40001' ? 'database_serialization' : 'unclassified' }));
    return NextResponse.json({ contractVersion: 1, success: false,
      error: { code: mapped.error.code, message: 'The proposal review request could not be completed.',
        retryable: mapped.error.retryable, ...diagnosis }, diagnosis }, { status: response.status, headers: response.headers });
  }
  const status = error.code === Codes.accessDenied ? 403 : error.code === Codes.sourceInvalid ? 404
    : conflicts.has(error.code) ? 409 : 400;
  observeFileVersionCenter({ operation, outcome: status === 403 ? 'denied' : status === 409 ? 'conflict' : 'invalid',
    startedAt, errorCode: status === 403 ? FileCodes.accessDenied : status === 404 ? FileCodes.notFound
      : status === 409 ? FileCodes.conflict : FileCodes.invalidRequest });
  const diagnosis = { reasonCode: error.code, ...reference };
  return NextResponse.json({ contractVersion: 1, success: false,
    error: { code: error.code, message: 'The proposal request could not be completed for this document state.', retryable: false, ...diagnosis },
    diagnosis }, { status, headers: FILE_VERSION_CENTER_PRIVATE_HEADERS });
}
