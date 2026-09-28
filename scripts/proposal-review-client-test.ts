import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { executeProposalReviewAction, ProposalReviewClientError, compareProposalReviewSelection,
  readProposalReviewSession, readProposalReviewActionStatus, previewProposalReviewTransform,
  readProposalReviewSummary } from '../app/lib/file-version-center/proposal-review-client';
import type { ProposalReviewCompareResponseV1 } from '../app/lib/file-version-center/contracts/proposal-review-compare-v1';
import type { ProposalReviewActionApiRequestV1, ProposalReviewActionStatusRequestV1,
  ProposalReviewSessionRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { currentProofFixture, proposalScopeFixture, rootProposalFixture } from './fixtures/proposal-graph-contract-v1';

const target = { kind: 'document' as const, workspaceId: proposalScopeFixture.workspaceId,
  documentId: proposalScopeFixture.documentId };
const compareTarget = { ...target, lineageId: proposalScopeFixture.lineageId };
const selectedProposalIds = ['p1'];
const binding = { evaluationId: 'evaluation-1', selectionHash: 'a'.repeat(64), selectedProposalIds,
  current: currentProofFixture, graphRevision: 7 };

function cleanCompare(overrides: Record<string, unknown> = {}): ProposalReviewCompareResponseV1 {
  return { contractVersion: 1, binding, status: 'clean', candidate: { contentAvailable: true, noEffect: false },
    summary: { additions: 1, deletions: 0, unchanged: 1 }, hunks: [{ id: 'h1', oldStart: 1, oldLines: 1, newStart: 1, newLines: 2,
      lines: [{ kind: 'context', oldLineNumber: 1, newLineNumber: 1, text: 'base' },
        { kind: 'addition', oldLineNumber: null, newLineNumber: 2, text: 'candidate' }] }],
    page: { hasMore: false, nextCursor: null }, diagnosis: { availability: 'available', reasonCode: null },
    ...overrides } as ProposalReviewCompareResponseV1;
}

function rejectRequest(): ProposalReviewActionApiRequestV1 {
  const fence = { contractVersion: 1 as const, fenceId: 'fence-1', scope: proposalScopeFixture,
    actor: { userId: 'reviewer', actorId: 'reviewer', authorizationRevision: 'auth-1' }, actionType: 'reject' as const,
    current: null, graphRevision: 7, evaluationId: null, effectiveCandidateHash: null,
    closure: [{ proposalId: 'p1', casVersion: 2, candidateHash: '8'.repeat(64) }],
    closureHash: 'c'.repeat(64), selectedProposalIds, applyProposalIds: [], batchHash: 'd'.repeat(64),
    choiceResolutions: [], requestDigest: 'e'.repeat(64), issuedAt: 1_800_000_000_000, expiresAt: 1_800_000_060_000 };
  return { contractVersion: 1, target, action: { contractVersion: 1, fence,
    fenceToken: `pg1.${'A'.repeat(43)}`, idempotencyKey: 'client-test-idempotency-0001', creation: null } };
}

function failedReceipt(action: ProposalReviewActionApiRequestV1['action'], requestDigest = action.fence.requestDigest) {
  return { contractVersion: 1, actionId: 'action-1', scope: action.fence.scope, actorId: action.fence.actor.userId,
    actionType: action.fence.actionType, requestDigest, idempotencyKeyHash: 'b'.repeat(64), affectedProposalIds: selectedProposalIds,
    operationId: null, createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
    phase: 'failed', result: null, errorCode: 'PROPOSAL_INVALID_REQUEST' };
}

const projectedProposal = { proposalId: 'p1', operationId: 'operation-p1', rootProposalId: 'p1', parentProposalId: null,
  relation: 'root', relationships: rootProposalFixture.relationships, lifecycle: 'open',
  createdAt: 1_800_000_000_000, createdByActorId: 'reviewer' };
function graphSession(overrides: Record<string, unknown> = {}) {
  return { contractVersion: 1, mode: 'graph', target: { kind: 'document', workspaceId: target.workspaceId,
    lineageId: proposalScopeFixture.lineageId, documentId: target.documentId }, selectedProposalIds: ['p1'], status: 'clean',
  reasonCode: null, context: { graphRevision: 7, scope: proposalScopeFixture,
    proposals: [projectedProposal], selectedProposalIds: ['p1'],
    dependencyProposalIds: [], applyProposalIds: ['p1'], closingAlternativeProposalIds: [], reasonCode: null },
  compare: cleanCompare(), actions: {}, capability: { write: false },
  diagnosis: { reasonCode: null, phase: 'review', correlationId: 'review-1', timestamp: 1_800_000_000_000,
    buildMarker: 'fvrc-test' }, ...overrides };
}

const statusRequest: ProposalReviewActionStatusRequestV1 = { contractVersion: 1, target,
  idempotencyKey: 'client-status-idempotency-0001', requestDigest: 'f'.repeat(64), approvalExpiresAt: 1_800_000_060_000 };
function statusPayload(request: ProposalReviewActionStatusRequestV1, overrides: Record<string, unknown> = {}) {
  const action = rejectRequest().action;
  const receipt = { ...failedReceipt(action, request.requestDigest), idempotencyKeyHash: createHash('sha256')
    .update(request.idempotencyKey).digest('hex'), ...overrides };
  return { receipt, checkedAt: 1_800_000_010_000 };
}

const sessionRequest: ProposalReviewSessionRequestV1 = { contractVersion: 1, target,
  selection: { kind: 'operation', operationId: 'operation-p1' } };

async function withFetch<T>(responseFor: (url: string, body: unknown) => Response, action: () => Promise<T>): Promise<{
  value: T; calls: Array<{ url: string; body: unknown }>;
}> {
  const previous = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? 'null')) as unknown;
    calls.push({ url, body });
    return responseFor(url, body);
  }) as typeof fetch;
  try { return await action().then((value) => ({ value, calls })); }
  finally { globalThis.fetch = previous; }
}

test('review transport errors never fall back to a legacy operation action endpoint', async () => {
  const result = await withFetch(() => Response.json({ error: { code: 'PROPOSAL_CONTENT_UNAVAILABLE',
    message: 'private proposal content must not escape' } }, { status: 503 }), async () => {
    await assert.rejects(readProposalReviewSession(sessionRequest), (error: unknown) => error instanceof ProposalReviewClientError
      && error.code === 'PROPOSAL_CONTENT_UNAVAILABLE' && error.diagnosis.phase === 'review');
  });
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0]!.url, /\/proposals\/review$/u);
  assert.doesNotMatch(result.calls[0]!.url, /collaboration\/operations/u);
});

test('a typed current-changed diagnosis stays distinct from an unclassified transport failure', async () => {
  const result = await withFetch(() => Response.json({ error: { code: 'PROPOSAL_CURRENT_CHANGED',
    message: 'stale document proof', correlationId: 'current-change-1', timestamp: 1_800_000_000_000,
    buildMarker: 'fvrc-1006' } }, { status: 409 }), async () => {
    await assert.rejects(readProposalReviewSession(sessionRequest), (error: unknown) => error instanceof ProposalReviewClientError
      && error.code === 'PROPOSAL_CURRENT_CHANGED' && error.diagnosis.reasonCode === 'PROPOSAL_CURRENT_CHANGED'
      && error.diagnosis.phase === 'review');
  });
  assert.equal(result.calls.length, 1);
});

test('client contract failures are transport errors and do not trigger legacy fallback', async () => {
  const result = await withFetch(() => Response.json({ contractVersion: 1, mode: 'legacy', unexpected: 'bad schema' }), async () => {
    await assert.rejects(readProposalReviewSession(sessionRequest), (error: unknown) => error instanceof ProposalReviewClientError
      && error.code === 'FVRC_TRANSPORT_ERROR' && error.diagnosis.phase === 'review');
  });
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0]!.url, /\/proposals\/review$/u);
});

test('review session binds stable target and explicit proposal selection', async () => {
  const explicit = { ...sessionRequest, selection: { kind: 'proposals' as const, proposalIds: ['p1'] } };
  const passed = await withFetch(() => Response.json(graphSession()), () => readProposalReviewSession(sessionRequest));
  assert.equal(passed.value.mode, 'graph');

  const badSessions = [
    graphSession({ target: { kind: 'document', workspaceId: 'foreign-workspace', lineageId: proposalScopeFixture.lineageId,
      documentId: target.documentId } }),
    graphSession({ target: { kind: 'document', workspaceId: target.workspaceId, lineageId: proposalScopeFixture.lineageId,
      documentId: 'foreign-document' } }),
    graphSession({ target: { kind: 'document', workspaceId: target.workspaceId, lineageId: 'foreign-lineage',
      documentId: target.documentId } }),
  ];
  for (const bad of badSessions.slice(0, 2)) await withFetch(() => Response.json(bad), () => assert.rejects(readProposalReviewSession(sessionRequest),
    (error: unknown) => error instanceof ProposalReviewClientError && error.code === 'FVRC_TRANSPORT_ERROR'));
  const lineageRequest: ProposalReviewSessionRequestV1 = { ...sessionRequest,
    target: { kind: 'lineage', workspaceId: target.workspaceId, lineageId: proposalScopeFixture.lineageId } };
  await withFetch(() => Response.json(badSessions[2]), () => assert.rejects(readProposalReviewSession(lineageRequest),
    (error: unknown) => error instanceof ProposalReviewClientError && error.code === 'FVRC_TRANSPORT_ERROR'));

  const wrongSelection = graphSession({ selectedProposalIds: ['p2'], context: { ...graphSession().context,
    selectedProposalIds: ['p2'], proposals: [{ ...projectedProposal, proposalId: 'p2' }], applyProposalIds: ['p2'] },
    compare: cleanCompare({ binding: { ...binding, selectedProposalIds: ['p2'] } }) });
  await withFetch(() => Response.json(wrongSelection), () => assert.rejects(readProposalReviewSession(explicit),
    (error: unknown) => error instanceof ProposalReviewClientError && error.code === 'FVRC_TRANSPORT_ERROR'));
});

test('review context accepts an older missing scope but rejects malformed or mismatched full scope', async () => {
  const current = graphSession();
  const accepted = await withFetch(() => Response.json(current), () => readProposalReviewSession(sessionRequest));
  assert.equal(accepted.value.mode, 'graph');
  if (accepted.value.mode === 'graph') assert.deepEqual(accepted.value.context?.scope, proposalScopeFixture);

  const legacyContext = { ...current.context };
  delete (legacyContext as { scope?: unknown }).scope;
  const older = await withFetch(() => Response.json(graphSession({ context: legacyContext })),
    () => readProposalReviewSession(sessionRequest));
  assert.equal(older.value.mode, 'graph');
  if (older.value.mode === 'graph') assert.equal(older.value.context?.scope, undefined);

  for (const scope of [
    { ...proposalScopeFixture, workspaceId: 'foreign-workspace' },
    { ...proposalScopeFixture, lineageId: 'foreign-lineage' },
    { ...proposalScopeFixture, documentId: 'foreign-document' },
    { ...proposalScopeFixture, lifecycleGeneration: 0 },
    { ...proposalScopeFixture, schemaVersion: 'not-a-generation' },
  ]) {
    const bad = graphSession({ context: { ...current.context, scope } });
    await withFetch(() => Response.json(bad), () => assert.rejects(readProposalReviewSession(sessionRequest),
      (error: unknown) => error instanceof ProposalReviewClientError && error.code === 'FVRC_TRANSPORT_ERROR'));
  }
});

test('operation review binds its selected proposal context but allows a redacted unavailable context', async () => {
  const wrongContext = graphSession({ context: { ...graphSession().context,
    proposals: [{ ...projectedProposal, operationId: 'foreign-operation' }] } });
  await withFetch(() => Response.json(wrongContext), () => assert.rejects(readProposalReviewSession(sessionRequest),
    (error: unknown) => error instanceof ProposalReviewClientError && error.code === 'FVRC_TRANSPORT_ERROR'));

  const redacted = graphSession({ context: { graphRevision: 7, proposals: [], selectedProposalIds: ['p1'],
    dependencyProposalIds: [], applyProposalIds: [], closingAlternativeProposalIds: [], reasonCode: 'PROPOSAL_ACCESS_DENIED' } });
  const allowed = await withFetch(() => Response.json(redacted), () => readProposalReviewSession(sessionRequest));
  assert.equal(allowed.value.mode, 'graph');
  if (allowed.value.mode === 'graph') assert.equal(allowed.value.context?.reasonCode, 'PROPOSAL_ACCESS_DENIED');
});

test('legacy review mode is accepted only for one explicitly selected operation', async () => {
  const explicit = await withFetch(() => Response.json({ contractVersion: 1, mode: 'legacy' }),
    () => readProposalReviewSession(sessionRequest));
  assert.equal(explicit.value.mode, 'legacy');
  for (const selection of [{ kind: 'all' as const }, { kind: 'proposals' as const, proposalIds: ['p1'] }]) {
    await withFetch(() => Response.json({ contractVersion: 1, mode: 'legacy' }), () => assert.rejects(
      readProposalReviewSession({ contractVersion: 1, target, selection }),
      (error: unknown) => error instanceof ProposalReviewClientError && error.code === 'FVRC_TRANSPORT_ERROR'));
  }
});

test('client error diagnostics expose only allowlisted, redacted fields', async () => {
  const result = await withFetch(() => Response.json({ error: {
    code: 'PROPOSAL_ACCESS_DENIED', message: 'private text from the document', correlationId: 'corr-safe:1',
    timestamp: 1_800_000_000_000, buildMarker: 'build.safe-1', proposalContent: 'secret content',
    storageRef: '/private/path', token: 'do-not-copy',
  } }, { status: 403 }), async () => {
    await assert.rejects(readProposalReviewSession(sessionRequest), (error: unknown) => {
      if (!(error instanceof ProposalReviewClientError)) return false;
      assert.equal(error.message, 'The proposal review request could not be completed.');
      assert.deepEqual(Object.keys(error.diagnosis).sort(), ['buildMarker', 'correlationId', 'phase', 'reasonCode', 'timestamp']);
      assert.deepEqual(error.diagnosis, { reasonCode: 'PROPOSAL_ACCESS_DENIED', phase: 'review',
        correlationId: 'corr-safe:1', timestamp: 1_800_000_000_000, buildMarker: 'build.safe-1' });
      assert.doesNotMatch(JSON.stringify(error), /private text|secret content|private\/path|do-not-copy/u);
      return true;
    });
  });
  assert.equal(result.calls.length, 1);
});

test('diagnostic copy has an explicit allowlist and excludes proposal or document content', () => {
  const component = readFileSync(fileURLToPath(new URL('../app/components/file-version-center/GraphReviewComparison.tsx', import.meta.url)), 'utf8');
  const copyExpression = component.match(/const safeDiagnostic = JSON\.stringify\(\{([\s\S]*?)\}, null, 2\);/u)?.[1];
  assert.ok(copyExpression);
  assert.deepEqual([...copyExpression.matchAll(/^\s+(\w+):/gmu)].map(match => match[1]),
    ['reasonCode', 'phase', 'evaluationId', 'selectedProposalIds', 'currentProof', 'targetKind', 'availableActions',
      'checkedAt', 'correlationId', 'timestamp', 'buildMarker']);
  assert.doesNotMatch(copyExpression, /\.content\b|documentId|fenceToken|beforeContent|proposedContent|\.path\b|\.\.\./u);
});

test('transform preview binds the displayed text to its scope, selection, graph and signed creation', async () => {
  const request = { contractVersion: 1 as const, target, sourceProposalId: 'p1', kind: 'detach' as const, expectedGraphRevision: 7 };
  const response = { contractVersion: 1, kind: 'detach', sourceProposalId: 'p1',
    beforeContent: 'before', proposedContent: 'after',
    beforeSha256: createHash('sha256').update('before').digest('hex'),
    proposedSha256: createHash('sha256').update('after').digest('hex'),
    prepared: { fence: { ...rejectRequest().action.fence, actionType: 'detach', current: currentProofFixture },
      fenceToken: `pg1.${'A'.repeat(43)}`,
      creation: { contractVersion: 1, proposalId: 'detached-p1', operationId: 'detached-operation', scope: proposalScopeFixture,
        source: rootProposalFixture.source, relationships: rootProposalFixture.relationships,
        authoredCandidate: rootProposalFixture.authoredCandidate, creationKind: 'detached', detachedFromProposalId: 'p1', reviewRequired: true } } };
  const success = await withFetch(() => Response.json(response), () => previewProposalReviewTransform(request));
  assert.equal(success.value.proposedContent, 'after');
  assert.match(success.calls[0]!.url, /\/transform\/preview$/u);
  for (const wrong of [
    { ...response, sourceProposalId: 'foreign-proposal' },
    { ...response, proposedContent: 'unapproved' },
    { ...response, prepared: { ...response.prepared, fence: { ...response.prepared.fence, graphRevision: 8 } } },
    { ...response, prepared: { ...response.prepared, creation: { ...response.prepared.creation, detachedFromProposalId: 'foreign-proposal' } } },
  ]) {
    await withFetch(() => Response.json(wrong), () => assert.rejects(previewProposalReviewTransform(request),
      (error: unknown) => error instanceof ProposalReviewClientError && error.code === 'FVRC_TRANSPORT_ERROR'));
  }
});

test('a no-effect compare is a successful zero-diff preview', async () => {
  const noEffect = cleanCompare({ status: 'empty_effect', candidate: { contentAvailable: false, noEffect: true },
    summary: { additions: 0, deletions: 0, unchanged: 0 }, hunks: [] });
  const result = await withFetch(() => Response.json(noEffect), async () => compareProposalReviewSelection({
    contractVersion: 1, target: compareTarget, selectedProposalIds,
  }));
  assert.equal(result.value.diagnosis.availability, 'available');
  assert.equal(result.value.candidate.noEffect, true);
  assert.deepEqual(result.value.summary, { additions: 0, deletions: 0, unchanged: 0 });
});

test('compare pagination rejects a response bound to a different selection', async () => {
  const mismatched = cleanCompare({ binding: { ...binding, evaluationId: 'other-evaluation' } });
  const result = await withFetch(() => Response.json(mismatched), async () => {
    await assert.rejects(compareProposalReviewSelection({ contractVersion: 1, target: compareTarget, selectedProposalIds,
      binding, cursor: 'cursor-1', limit: 10 }), (error: unknown) => error instanceof ProposalReviewClientError
        && error.code === 'FVRC_TRANSPORT_ERROR' && error.diagnosis.phase === 'compare');
  });
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0]!.url, /\/proposals\/compare$/u);
});

test('action receipt must bind request digest, actor, action type and complete reviewed scope', async () => {
  const request = rejectRequest();
  const action = request.action;
  const badReceipts = [
    failedReceipt(action, 'f'.repeat(64)),
    { ...failedReceipt(action), actorId: 'foreign-actor' },
    { ...failedReceipt(action), actionType: 'accept' },
    { ...failedReceipt(action), scope: { ...action.fence.scope, lineageId: 'foreign-lineage' } },
    { ...failedReceipt(action), scope: { ...action.fence.scope, documentId: 'foreign-document' } },
    { ...failedReceipt(action), scope: { ...action.fence.scope, lifecycleGeneration: action.fence.scope.lifecycleGeneration + 1 } },
    { ...failedReceipt(action), scope: { ...action.fence.scope, schemaVersion: action.fence.scope.schemaVersion + 1 } },
  ];
  for (const bad of badReceipts) {
    const result = await withFetch(() => Response.json(bad), async () => {
      await assert.rejects(executeProposalReviewAction(request), (error: unknown) => error instanceof ProposalReviewClientError
        && error.code === 'FVRC_TRANSPORT_ERROR' && error.diagnosis.phase === 'action');
    });
    assert.equal(result.calls.length, 1);
    assert.match(result.calls[0]!.url, /\/proposals\/actions$/u);
  }
});

test('a matching action receipt is accepted only after its contract and request binding validate', async () => {
  const request = rejectRequest();
  const result = await withFetch((_url, body) => Response.json(failedReceipt((body as ProposalReviewActionApiRequestV1).action)),
    () => executeProposalReviewAction(request));
  assert.equal(result.value.requestDigest, request.action.fence.requestDigest);
  assert.equal(result.value.actionType, 'reject');
});

test('action status receipt binds target scope, request digest and idempotency key', async () => {
  const valid = await withFetch(() => Response.json(statusPayload(statusRequest)),
    () => readProposalReviewActionStatus(statusRequest));
  assert.equal(valid.value.receipt?.requestDigest, statusRequest.requestDigest);

  const wrongKey = await statusPayload(statusRequest, { idempotencyKeyHash: 'c'.repeat(64) });
  const wrongDocument = await statusPayload(statusRequest, { scope: { ...proposalScopeFixture, documentId: 'foreign-document' } });
  const wrongWorkspace = await statusPayload(statusRequest, { scope: { ...proposalScopeFixture, workspaceId: 'foreign-workspace' } });
  for (const payload of [wrongKey, wrongDocument, wrongWorkspace,
    await statusPayload(statusRequest, { requestDigest: '0'.repeat(64) })]) {
    await withFetch(() => Response.json(payload), () => assert.rejects(readProposalReviewActionStatus(statusRequest),
      (error: unknown) => error instanceof ProposalReviewClientError && error.code === 'FVRC_TRANSPORT_ERROR'));
  }

  const lineageRequest: ProposalReviewActionStatusRequestV1 = { ...statusRequest,
    target: { kind: 'lineage', workspaceId: target.workspaceId, lineageId: proposalScopeFixture.lineageId } };
  const wrongLineage = await statusPayload(lineageRequest, { scope: { ...proposalScopeFixture, lineageId: 'foreign-lineage' } });
  await withFetch(() => Response.json(wrongLineage), () => assert.rejects(readProposalReviewActionStatus(lineageRequest),
    (error: unknown) => error instanceof ProposalReviewClientError && error.code === 'FVRC_TRANSPORT_ERROR'));
});

test('review summaries bind exact visible operation IDs and target without granting action authority', async () => {
  const request = { contractVersion: 1 as const, target, operationIds: ['operation-p1', 'legacy-op'] };
  const result = { contractVersion: 1, target: { workspaceId: target.workspaceId, documentId: target.documentId,
    lineageId: proposalScopeFixture.lineageId }, current: currentProofFixture, graphRevision: 7, checkedAt: 1_800_000_000_000,
  items: [{ mode: 'graph', operationId: 'operation-p1', status: 'conflicted', reasonCode: 'PROPOSAL_BATCH_CONFLICT',
    proposal: { proposalId: 'p1', operationId: 'operation-p1', rootProposalId: 'p1', parentProposalId: null,
      relation: 'root', relationships: rootProposalFixture.relationships, lifecycle: 'open',
      createdAt: 1_800_000_000_000, createdByActorId: 'reviewer' } }, { mode: 'legacy', operationId: 'legacy-op' }] };
  const passed = await withFetch(() => Response.json(result), () => readProposalReviewSummary(request));
  assert.equal(passed.value.items[0]?.mode, 'graph');
  assert.match(passed.calls[0]!.url, /\/proposals\/summary$/u);
  for (const bad of [
    { ...result, target: { ...result.target, workspaceId: 'foreign' } },
    { ...result, target: { ...result.target, documentId: 'foreign' } },
    { ...result, items: result.items.slice().reverse() },
    { ...result, items: [result.items[0]] },
    { ...result, actions: { accept: true } },
    { ...result, content: 'private document text' },
    { ...result, current: null, items: [{ ...result.items[0], status: 'clean', reasonCode: null }, result.items[1]] },
  ]) await withFetch(() => Response.json(bad), () => assert.rejects(readProposalReviewSummary(request),
    (error: unknown) => error instanceof ProposalReviewClientError && error.code === 'FVRC_TRANSPORT_ERROR'));
});
