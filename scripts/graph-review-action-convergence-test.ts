import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { readGraphReviewActionResolution } from '../app/components/file-version-center/graph-review-action-convergence';
import { executeProposalReviewAction, ProposalReviewClientError } from '../app/lib/file-version-center/proposal-review-client';
import type { ProposalActionReceiptV1, ProposalActionFenceV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewActionApiRequestV1, ProposalReviewActionStatusRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { currentProofFixture, proposalScopeFixture, rootProposalFixture } from './fixtures/proposal-graph-contract-v1';

const target = { kind: 'document' as const, workspaceId: proposalScopeFixture.workspaceId,
  documentId: proposalScopeFixture.documentId };
const requestDigest = 'e'.repeat(64);
const actionKey = 'convergence-action-key-0001';
const now = 1_800_000_010_000;
const proposalProjection = { proposalId: 'p1', operationId: rootProposalFixture.operationId, rootProposalId: 'p1',
  parentProposalId: null, relation: 'root', relationships: rootProposalFixture.relationships, lifecycle: 'open',
  createdAt: rootProposalFixture.createdAt, createdByActorId: rootProposalFixture.createdByActorId };

function actionRequest(overrides: { target?: ProposalReviewActionApiRequestV1['target']; idempotencyKey?: string;
  requestDigest?: string; graphRevision?: number } = {}): ProposalReviewActionApiRequestV1 {
  const digest = overrides.requestDigest ?? requestDigest;
  const fence: ProposalActionFenceV1 = {
    contractVersion: 1, fenceId: 'fence-race-1', scope: proposalScopeFixture,
    actor: { userId: 'reviewer', actorId: 'reviewer', authorizationRevision: 'auth-1' }, actionType: 'accept',
    current: currentProofFixture, graphRevision: overrides.graphRevision ?? 7,
    evaluationId: 'evaluation-1', effectiveCandidateHash: '8'.repeat(64),
    closure: [{ proposalId: 'p1', casVersion: 1, candidateHash: '8'.repeat(64) }],
    closureHash: 'c'.repeat(64), selectedProposalIds: ['p1'], applyProposalIds: ['p1'], batchHash: 'd'.repeat(64),
    choiceResolutions: [], requestDigest: digest, issuedAt: now - 1000, expiresAt: now + 60_000,
  };
  return { contractVersion: 1, target: overrides.target ?? target,
    action: { contractVersion: 1, fence, fenceToken: `pg1.${'A'.repeat(43)}`,
      idempotencyKey: overrides.idempotencyKey ?? actionKey, creation: null } };
}

function statusIdentity(action: ProposalReviewActionApiRequestV1): ProposalReviewActionStatusRequestV1 {
  return { contractVersion: 1, target: action.target, idempotencyKey: action.action.idempotencyKey,
    requestDigest: action.action.fence.requestDigest, approvalExpiresAt: action.action.fence.expiresAt };
}

function freshSession(overrides: { graphRevision?: number; scope?: Record<string, unknown> | null; malformed?: boolean } = {}) {
  const scope = overrides.scope === null ? undefined : { ...proposalScopeFixture, ...overrides.scope };
  if (overrides.malformed) return { contractVersion: 1, mode: 'graph', target: {
    kind: 'document', workspaceId: target.workspaceId, lineageId: proposalScopeFixture.lineageId,
    documentId: target.documentId,
  }, selectedProposalIds: ['p1'], status: 'clean', reasonCode: null,
  context: { graphRevision: overrides.graphRevision ?? 8, ...(scope ? { scope } : {}), proposals: [proposalProjection],
    selectedProposalIds: ['p1'], dependencyProposalIds: [], applyProposalIds: ['p1'],
    closingAlternativeProposalIds: [], reasonCode: null }, compare: null, actions: {}, capability: { write: false },
  diagnosis: { reasonCode: null, phase: 'review', correlationId: 'review-convergence-1', timestamp: now, buildMarker: 'fvrc-test' },
  unexpected: true };
  return { contractVersion: 1, mode: 'graph', target: {
    kind: 'document', workspaceId: target.workspaceId, lineageId: proposalScopeFixture.lineageId,
    documentId: target.documentId,
  }, selectedProposalIds: ['p1'], status: 'clean', reasonCode: null,
  context: { graphRevision: overrides.graphRevision ?? 8, ...(scope ? { scope } : {}), proposals: [proposalProjection],
    selectedProposalIds: ['p1'], dependencyProposalIds: [], applyProposalIds: ['p1'],
    closingAlternativeProposalIds: [], reasonCode: null }, compare: null, actions: {}, capability: { write: false },
  diagnosis: { reasonCode: null, phase: 'review', correlationId: 'review-convergence-1', timestamp: now, buildMarker: 'fvrc-test' } };
}

function receiptFor(action: ProposalReviewActionApiRequestV1): ProposalActionReceiptV1 {
  return { contractVersion: 1, actionId: 'action-race-1', scope: action.action.fence.scope,
    actorId: action.action.fence.actor.userId, actionType: action.action.fence.actionType,
    requestDigest: action.action.fence.requestDigest,
    idempotencyKeyHash: createHash('sha256').update(action.action.idempotencyKey).digest('hex'),
    affectedProposalIds: ['p1'], operationId: 'action-race-1', createdAt: now - 1000, updatedAt: now,
    phase: 'applying', result: null, errorCode: null };
}

type MockCall = { path: string; method: string; body: unknown };
async function withMockFetch<T>(
  respond: (call: MockCall, index: number, signal: AbortSignal | null) => Response | Promise<Response>,
  action: (calls: MockCall[]) => Promise<T>,
): Promise<{ value: T; calls: MockCall[] }> {
  const previous = globalThis.fetch;
  const calls: MockCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const call = { path: url.pathname, method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) as unknown : null };
    calls.push(call);
    return respond(call, calls.length - 1, init?.signal as AbortSignal | null ?? null);
  }) as typeof fetch;
  try { return { value: await action(calls), calls }; }
  finally { globalThis.fetch = previous; }
}

function actionConflict(code = 'PROPOSAL_RECOVERY_REQUIRED') {
  return Response.json({ contractVersion: 1, success: false,
    error: { code, correlationId: 'race-conflict-1', timestamp: now, buildMarker: 'fvrc-test' } }, { status: 409 });
}

async function getParsedActionError(action: ProposalReviewActionApiRequestV1,
  conflictCode = 'PROPOSAL_RECOVERY_REQUIRED'): Promise<ProposalReviewClientError> {
  let parsed: ProposalReviewClientError | null = null;
  await withMockFetch(() => actionConflict(conflictCode), async () => {
    await assert.rejects(executeProposalReviewAction(action), (error: unknown) => {
      if (!(error instanceof ProposalReviewClientError)) return false;
      parsed = error;
      return true;
    });
  });
  assert.ok(parsed);
  return parsed;
}

async function resolveWith(action: ProposalReviewActionApiRequestV1, error: unknown,
  review: (call: MockCall) => Response | Promise<Response>, status: (call: MockCall) => Response | Promise<Response> = () =>
    Response.json({ receipt: null, checkedAt: now })) {
  const identity = statusIdentity(action);
  return withMockFetch(call => {
    if (call.path.endsWith('/proposals/review')) return review(call);
    if (call.path.endsWith('/proposals/actions/status')) return status(call);
    return Response.json({ error: { code: 'unexpected route' } }, { status: 500 });
  }, () => readGraphReviewActionResolution(identity, action, error, new AbortController().signal));
}

test('a known action 409 plus a newer exact-scope review and null status proves the action was superseded', async () => {
  const action = actionRequest();
  const actionError = await getParsedActionError(action);
  assert.equal(actionError.status, 409);
  assert.equal(actionError.code, 'PROPOSAL_RECOVERY_REQUIRED');
  const result = await resolveWith(action, actionError, () => Response.json(freshSession()));
  assert.equal(result.value.supersededWithoutReservation, true);
  assert.equal(result.value.receipt, null);
  assert.deepEqual(result.calls.map(call => call.path), [
    '/api/files/version-center/v1/proposals/review',
    '/api/files/version-center/v1/proposals/actions/status',
  ]);
  assert.equal(result.calls.filter(call => call.path.endsWith('/proposals/actions')).length, 0);
  assert.deepEqual(result.calls.map(call => call.body), [
    { contractVersion: 1, target, selection: { kind: 'proposals', proposalIds: ['p1'] } },
    statusIdentity(action),
  ]);
});

test('same or lower graph revisions never prove that the fence was superseded', async () => {
  const action = actionRequest();
  const actionError = await getParsedActionError(action);
  for (const graphRevision of [7, 6]) {
    const result = await resolveWith(action, actionError, () => Response.json(freshSession({ graphRevision })));
    assert.equal(result.value.supersededWithoutReservation, false);
    assert.deepEqual(result.calls.map(call => call.path), [
      '/api/files/version-center/v1/proposals/review', '/api/files/version-center/v1/proposals/actions/status',
    ]);
  }
});

test('missing or different full graph scope cannot prove supersession', async () => {
  const action = actionRequest();
  const actionError = await getParsedActionError(action);
  const cases = [
    freshSession({ scope: null }),
    freshSession({ scope: { lifecycleGeneration: proposalScopeFixture.lifecycleGeneration + 1 } }),
    freshSession({ scope: { schemaVersion: proposalScopeFixture.schemaVersion + 1 } }),
    freshSession({ scope: { lineageId: 'lineage-other' } }),
    freshSession({ scope: { documentId: 'document-other' } }),
    freshSession({ scope: { workspaceId: 'workspace-other' } }),
  ];
  for (const response of cases) {
    const result = await resolveWith(action, actionError, () => Response.json(response));
    assert.equal(result.value.supersededWithoutReservation, false);
  }
});

test('review transport and contract failures fall back only to status and do not prove supersession', async () => {
  const action = actionRequest();
  const actionError = await getParsedActionError(action);
  const responses = [
    () => new Response('not-json', { status: 503 }),
    () => Response.json(freshSession({ malformed: true })),
    () => Response.json({ contractVersion: 1, mode: 'legacy' }),
  ];
  for (const review of responses) {
    const result = await resolveWith(action, actionError, review);
    assert.equal(result.value.supersededWithoutReservation, false);
    assert.deepEqual(result.calls.map(call => call.path), [
      '/api/files/version-center/v1/proposals/review', '/api/files/version-center/v1/proposals/actions/status',
    ]);
  }
});

test('other 409 reasons and mismatched key, digest, or target skip the fresh-review proof', async () => {
  const action = actionRequest();
  const otherError = await getParsedActionError(action, 'PROPOSAL_CURRENT_CHANGED');
  const noReview = await resolveWith(action, otherError, () => Response.json(freshSession()));
  assert.equal(noReview.value.supersededWithoutReservation, false);
  assert.deepEqual(noReview.calls.map(call => call.path), ['/api/files/version-center/v1/proposals/actions/status']);

  const concurrentError = await getParsedActionError(action);
  const mismatches = [
    statusIdentity(actionRequest({ idempotencyKey: 'different-action-key-0001' })),
    statusIdentity(actionRequest({ requestDigest: 'f'.repeat(64) })),
    statusIdentity(actionRequest({ target: { ...target, documentId: 'document-other' } })),
  ];
  for (const identity of mismatches) {
    const result = await withMockFetch(call => call.path.endsWith('/proposals/actions/status')
      ? Response.json({ receipt: null, checkedAt: now })
      : Response.json(freshSession()), () => readGraphReviewActionResolution(identity, action, concurrentError,
        new AbortController().signal));
    assert.equal(result.value.supersededWithoutReservation, false);
    assert.deepEqual(result.calls.map(call => call.path), ['/api/files/version-center/v1/proposals/actions/status']);
  }
});

test('malformed or failed status and a non-null owned receipt never claim superseded-without-reservation', async () => {
  const action = actionRequest();
  const actionError = await getParsedActionError(action);
  for (const status of [
    () => new Response('not-json', { status: 503 }),
    () => Response.json({ receipt: { phase: 'nonsense' }, checkedAt: now }),
  ]) {
    await assert.rejects(resolveWith(action, actionError, () => Response.json(freshSession()), status),
      (error: unknown) => error instanceof ProposalReviewClientError && error.diagnosis.phase === 'action');
  }
  const ownedReceipt = receiptFor(action);
  const owned = await resolveWith(action, actionError, () => Response.json(freshSession()),
    () => Response.json({ receipt: ownedReceipt, checkedAt: now }));
  assert.equal(owned.value.receipt?.actionId, ownedReceipt.actionId);
  assert.equal(owned.value.supersededWithoutReservation, false);
});

test('abort during the fresh review never proceeds to the status request', async () => {
  const action = actionRequest();
  const actionError = await getParsedActionError(action);
  const controller = new AbortController();
  const result = await withMockFetch(call => {
    if (call.path.endsWith('/proposals/review')) {
      controller.abort();
      return Response.json(freshSession());
    }
    return Response.json({ receipt: null, checkedAt: now });
  }, async calls => {
    await assert.rejects(readGraphReviewActionResolution(statusIdentity(action), action, actionError, controller.signal));
    return calls;
  });
  assert.deepEqual(result.value.map(call => call.path), ['/api/files/version-center/v1/proposals/review']);
  assert.equal(result.value.some(call => call.path.endsWith('/proposals/actions/status')), false);
});
