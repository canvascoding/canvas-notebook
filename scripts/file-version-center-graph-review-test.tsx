import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import type { FileVersionCenterRequestV1 } from '../app/lib/file-version-center/contracts/v1';
import type { ProposalReviewActionApiRequestV1 } from '../app/lib/file-version-center/contracts/proposal-review-session-v1';
import { rootProposalFixture } from './fixtures/proposal-graph-contract-v1';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://canvas.test/en/notebook',
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver',
  'CustomEvent', 'Event', 'MouseEvent', 'DOMException', 'SVGElement', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window
    : key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: dom.window.sessionStorage });

const request: FileVersionCenterRequestV1 = {
  contractVersion: 1,
  target: { kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-one' },
  source: 'editor',
  initialView: 'reviews',
};
const target = { kind: 'document' as const, workspaceId: 'workspace-one', lineageId: 'lineage-one', documentId: 'document-one' };
const diagnosis = { reasonCode: 'PROPOSAL_CHOICE_CONFLICT', phase: 'review' as const, correlationId: 'review-one', timestamp: 10, buildMarker: 'test-build' };
const hashes = {
  revisionId: 'revision-one', contentHash: 'a'.repeat(64), structureHash: 'b'.repeat(64), stateVectorHash: 'c'.repeat(64),
  deleteSetHash: 'd'.repeat(64), fullStateHash: 'e'.repeat(64),
};
const conflict = {
  contractVersion: 1, mode: 'graph' as const, target, selectedProposalIds: ['proposal-one'],
  status: 'conflicted', reasonCode: 'PROPOSAL_CHOICE_CONFLICT', compare: null, actions: {},
  capability: { write: false }, diagnosis,
};
const proposal = (proposalId: string, parentProposalId: string | null,
  relation: 'root' | 'dependency' | 'alternative' | 'replacement' | 'detached') => ({
  proposalId, operationId: `operation-${proposalId}`, rootProposalId: relation === 'detached' ? proposalId : 'proposal-one', parentProposalId, relation,
  relationships: { dependency: null, replacesProposalId: relation === 'replacement' ? 'proposal-one' : null, choiceGroupId: null },
  lifecycle: 'open', createdAt: 10, createdByActorId: 'actor-one',
});
const cleanAll = {
  contractVersion: 1, mode: 'graph' as const, target, selectedProposalIds: ['proposal-one', 'proposal-two'],
  status: 'clean', reasonCode: null,
  compare: {
    contractVersion: 1, binding: { evaluationId: 'evaluation-one', selectionHash: 'f'.repeat(64),
      selectedProposalIds: ['proposal-one', 'proposal-two'], current: hashes, graphRevision: 2 },
    status: 'clean', candidate: { contentAvailable: true, noEffect: false },
    summary: { additions: 2, deletions: 1, unchanged: 3 },
    hunks: [{ id: 'hunk-one', oldStart: 1, oldLines: 1, newStart: 1, newLines: 2,
      lines: [{ kind: 'deletion', oldLineNumber: 1, newLineNumber: null, text: 'Old' },
        { kind: 'addition', oldLineNumber: null, newLineNumber: 1, text: 'New' }] }],
    page: { hasMore: false, nextCursor: null }, diagnosis: { availability: 'available', reasonCode: null },
  },
  actions: {}, capability: { write: false }, diagnosis: { ...diagnosis, reasonCode: null },
  context: { graphRevision: 2,
    proposals: [proposal('proposal-one', null, 'root'), proposal('proposal-two', 'proposal-one', 'dependency'),
      proposal('proposal-prerequisite', 'proposal-one', 'dependency'), proposal('proposal-alternative', 'proposal-one', 'alternative'),
      proposal('proposal-replacement', 'proposal-one', 'replacement'), proposal('proposal-detached', null, 'detached'),
      { ...proposal('proposal-terminal', 'proposal-one', 'replacement'), lifecycle: 'superseded' }],
    selectedProposalIds: ['proposal-one', 'proposal-two'], dependencyProposalIds: ['proposal-prerequisite'],
    applyProposalIds: ['proposal-one', 'proposal-two', 'proposal-prerequisite'],
    closingAlternativeProposalIds: ['proposal-alternative'], reasonCode: null,
  },
};
const scope = { workspaceId: target.workspaceId, lineageId: target.lineageId, documentId: target.documentId,
  lifecycleGeneration: 1, schemaVersion: 1 };
function preparedAction(actionType: 'batch_accept' | 'reject' | 'branch_reject' | 'complete_satisfied', selectedProposalIds: string[]) {
  const applies = actionType === 'batch_accept';
  return { fence: { contractVersion: 1, fenceId: `fence-${actionType}`, scope,
    actor: { userId: 'actor-one', actorId: 'actor-one', authorizationRevision: 'auth-one' }, actionType,
    current: applies || actionType === 'complete_satisfied' ? hashes : null, graphRevision: 2,
    evaluationId: applies || actionType === 'complete_satisfied' ? 'evaluation-one' : null,
    effectiveCandidateHash: applies || actionType === 'complete_satisfied' ? 'f'.repeat(64) : null,
    closure: [...selectedProposalIds, ...(actionType === 'branch_reject' ? ['proposal-two'] : [])]
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .map((proposalId) => ({ proposalId, casVersion: 1, candidateHash: 'f'.repeat(64) })),
    closureHash: 'e'.repeat(64), selectedProposalIds, applyProposalIds: applies ? selectedProposalIds : [],
    batchHash: 'd'.repeat(64), choiceResolutions: [], requestDigest: 'f'.repeat(64),
    issuedAt: Date.now() - 100, expiresAt: Date.now() + 60_000 },
    fenceToken: `pg1.${'A'.repeat(43)}` };
}
function transformResponse(kind: 'detach' | 'replace') {
  const beforeContent = 'Before\n';
  const proposedContent = 'After\n';
  const digest = (content: string) => createHash('sha256').update(content).digest('hex');
  const base = preparedAction('reject', ['proposal-one']);
  return { contractVersion: 1, kind, sourceProposalId: 'proposal-one', beforeContent, proposedContent,
    beforeSha256: digest(beforeContent), proposedSha256: digest(proposedContent),
    prepared: { fence: { ...base.fence, actionType: kind, current: hashes }, fenceToken: base.fenceToken,
      creation: { contractVersion: 1, proposalId: `new-${kind}`, operationId: `operation-new-${kind}`, scope,
        source: { ...rootProposalFixture.source, scope },
        relationships: { dependency: null, replacesProposalId: kind === 'replace' ? 'proposal-one' : null, choiceGroupId: null },
        authoredCandidate: rootProposalFixture.authoredCandidate,
        creationKind: kind === 'detach' ? 'detached' : 'replacement',
        detachedFromProposalId: kind === 'detach' ? 'proposal-one' : null, reviewRequired: true } } };
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function main() {
  const { GraphReviewComparison } = await import('../app/components/file-version-center/GraphReviewComparison');
  const actionState = await import('../app/components/file-version-center/graph-review-action-state');
  const scopedKey = actionState.graphReviewActionStorageKey({ userId: 'user-one', sessionId: 'session-one', epoch: 1 }, target);
  const otherScope = actionState.graphReviewActionStorageKey({ userId: 'user-two', sessionId: 'session-two', epoch: 1 }, target);
  const testExpiry = Date.now() + 60_000;
  const exactAction = { contractVersion: 1, target: request.target, action: {
    idempotencyKey: 'action-identity-one', fence: { requestDigest: 'f'.repeat(64), expiresAt: testExpiry }, fenceToken: 'secret-fence-token',
  } } as unknown as ProposalReviewActionApiRequestV1;
  actionState.rememberGraphReviewAction(scopedKey, exactAction);
  assert.deepEqual(actionState.readGraphReviewActionIdentity(scopedKey), {
    contractVersion: 1, target: request.target, idempotencyKey: 'action-identity-one', requestDigest: 'f'.repeat(64), approvalExpiresAt: testExpiry,
  });
  assert.equal(actionState.readGraphReviewActionIdentity(otherScope), null, 'another auth scope cannot recover this action');
  assert.equal(actionState.exactGraphReviewAction(otherScope), null);
  assert.equal(sessionStorage.getItem(scopedKey)?.includes('secret-fence-token'), false, 'signed fence is never persisted');
  actionState.forgetGraphReviewAction(scopedKey);
  assert.equal(actionState.readGraphReviewActionIdentity(scopedKey), null);

  const calls: Array<{ selection: { kind: string } }> = [];
  let transient = true;
  let transientAll = true;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/proposals\/review$/);
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (body.selection.kind === 'operation' && transient) {
      transient = false;
      return Response.json({ error: { code: 'PROPOSAL_CURRENT_CHANGED' } }, { status: 409 });
    }
    if (body.selection.kind === 'all' && transientAll) {
      transientAll = false;
      return Response.json({ ...cleanAll, status: 'unavailable', reasonCode: 'PROPOSAL_GRAPH_CHANGED', compare: null,
        diagnosis: { ...cleanAll.diagnosis, reasonCode: 'PROPOSAL_GRAPH_CHANGED' } });
    }
    return Response.json(body.selection.kind === 'all'
      || body.selection.kind === 'proposals' && body.selection.proposalIds.length === 2 ? cleanAll
      : body.selection.kind === 'proposals' ? { ...conflict, selectedProposalIds: body.selection.proposalIds } : conflict);
  };
  const root = createRoot(document.getElementById('root')!);
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison request={request} document={target} operationId="operation-one" legacy={<div data-testid="legacy-review">Legacy</div>}
      isRevalidating={false} isStale={false} onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();

  assert.equal(calls.length, 2, 'a transient current change gets exactly one automatic reevaluation');
  assert.ok(document.querySelector('[data-testid="graph-review-blocked"]'), 'conflict is visible');
  assert.match(document.body.textContent ?? '', /alternatives cannot be accepted together/i);
  assert.doesNotMatch(document.body.textContent ?? '', /\+0|−0/);
  assert.equal(document.querySelector('[data-testid="legacy-review"]'), null, 'graph result never mounts legacy actions');
  assert.equal([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Accept change')), false);

  const all = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Review all changes'));
  assert.ok(all);
  await act(async () => { all.focus(); all.click(); });
  await settle();
  const thisChange = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('This change'));
  assert.equal(document.activeElement, thisChange, 'user-selected full review transfers focus to the replacement control');
  assert.equal(calls.at(-2)?.selection.kind, 'all', 'full document selection is resolved by server');
  assert.equal(calls.at(-1)?.selection.kind, 'proposals', 'transient response retry uses the frozen selection');
  assert.match(document.body.textContent ?? '', /2 proposals selected/);
  assert.match(document.body.textContent ?? '', /\+2/);
  assert.ok(document.querySelector('[data-testid="graph-review-hunks"]'));
  assert.ok(document.querySelector('[data-testid="graph-review-context"]'));
  const rootCard = [...document.querySelectorAll('[data-testid="graph-review-context"] li')]
    .find((item) => item.textContent?.includes('proposal-one'));
  assert.ok(rootCard && (rootCard.textContent?.indexOf('Root proposal') ?? -1) >= 0
    && (rootCard.textContent?.indexOf('Root proposal') ?? Infinity) < (rootCard.textContent?.indexOf('proposal-one') ?? -1),
  'a meaningful proposal relationship is the primary card label, with its opaque ID secondary');
  const terminalCard = [...document.querySelectorAll('[data-testid="graph-review-context"] li')]
    .find((item) => item.querySelector('[title="proposal-terminal"]'));
  assert.ok(terminalCard);
  assert.equal([...terminalCard.querySelectorAll('button')].some((button) => button.textContent?.includes('Review this proposal')), false,
    'terminal proposal cards have no active selection action');
  assert.match(document.body.textContent ?? '', /1 prerequisite included/);
  assert.match(document.body.textContent ?? '', /1 alternative closes/);
  assert.equal(document.querySelector('[data-testid="legacy-review"]'), null);
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison request={request} document={target} operationId="operation-one" legacy={<div data-testid="legacy-review">Legacy</div>}
      isRevalidating isStale={false} onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison request={request} document={target} operationId="operation-one" legacy={<div data-testid="legacy-review">Legacy</div>}
      isRevalidating={false} isStale={false} onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  assert.equal(calls.at(-1)?.selection.kind, 'proposals', 'revalidation uses frozen proposal IDs');
  assert.equal(calls.filter((call) => call.selection.kind === 'all').length, 1, 'all is queried only once');
  const diagnostic = document.querySelector('[data-testid="graph-review-diagnostics"]');
  assert.ok(diagnostic);
  const safeDiagnostic = diagnostic.querySelector('pre')?.textContent ?? '';
  assert.match(safeDiagnostic, /"evaluationId": "evaluation-one"/);
  assert.match(safeDiagnostic, /"contentHash": "aaaaaaaaaaaa…"/);
  assert.match(safeDiagnostic, /"availableActions": \[\]/);
  assert.doesNotMatch(safeDiagnostic, /secret-fence-token|Old|New|aaaaaaaaaaaaaaaaaaaaaaaa/);
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
  const copy = [...diagnostic.querySelectorAll('button')].find((button) => button.textContent?.includes('Copy'));
  assert.ok(copy);
  await act(async () => { copy.click(); });
  assert.equal(copied, safeDiagnostic, 'copied diagnostics exactly match the redacted visible payload');
  copy.focus();
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison request={request} document={target} operationId="operation-one" legacy={<div data-testid="legacy-review">Legacy</div>}
      isRevalidating isStale={false} onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison request={request} document={target} operationId="operation-one" legacy={<div data-testid="legacy-review">Legacy</div>}
      isRevalidating={false} isStale={false} onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  assert.equal(document.activeElement, copy, 'background revalidation does not steal focus after selection intent is consumed');

  for (const related of [
    { id: 'proposal-prerequisite', label: 'Review with required parent' },
    { id: 'proposal-replacement', label: 'Review this proposal' },
    { id: 'proposal-detached', label: 'Review this proposal' },
  ]) {
    const card = [...document.querySelectorAll('[data-testid="graph-review-context"] li')]
      .find((item) => item.querySelector(`[title="${related.id}"]`));
    assert.ok(card, `${related.id} has a grouped relationship card`);
    const inspect = [...card.querySelectorAll('button')].find((button) => button.textContent?.includes(related.label));
    assert.ok(inspect);
    await act(async () => { inspect.click(); });
    await settle();
    assert.deepEqual((calls.at(-1)?.selection as { proposalIds?: string[] }).proposalIds, [related.id],
      `${related.id} starts a separate exact server review`);
    const returnButton = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Return to the earlier 2 selected changes'));
    assert.ok(returnButton);
    await act(async () => { returnButton.click(); });
    await settle();
  }
  assert.equal(calls.filter((call) => call.selection.kind === 'all').length, 1,
    'navigating child, replacement and detached cards never re-enumerates all');
  const inspectAlternative = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Review this alternative'));
  assert.ok(inspectAlternative);
  await act(async () => { inspectAlternative.click(); });
  await settle();
  assert.deepEqual((calls.at(-1)?.selection as { proposalIds?: string[] }).proposalIds, ['proposal-alternative'],
    'alternative selection starts its own exact server preview');
  assert.ok(document.querySelector('[data-testid="graph-review-blocked"]'), 'alternative remains unapproved until reviewed');
  const returnFrozenAll = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Return to the earlier 2 selected changes'));
  assert.ok(returnFrozenAll);
  await act(async () => { returnFrozenAll.click(); });
  await settle();
  assert.deepEqual((calls.at(-1)?.selection as { proposalIds?: string[] }).proposalIds, ['proposal-one', 'proposal-two']);
  assert.equal(calls.filter((call) => call.selection.kind === 'all').length, 1, 'returning uses frozen IDs, not a new all query');

  const inspectParent = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Review parent only'));
  assert.ok(inspectParent);
  await act(async () => { inspectParent.click(); });
  await settle();
  assert.equal(calls.at(-1)?.selection.kind, 'proposals', 'parent inspection starts a separate server review');
  assert.deepEqual((calls.at(-1)?.selection as { proposalIds?: string[] }).proposalIds, ['proposal-one']);

  globalThis.fetch = async () => Response.json({ error: { code: 'PROPOSAL_ACCESS_DENIED' } }, { status: 403 });
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison key="denied" request={request} document={target} operationId="operation-two"
      legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
      onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  assert.ok(document.querySelector('[data-testid="graph-review-load-error"]'));
  assert.equal(document.querySelector('[data-testid="legacy-review"]'), null, 'a request error never falls back to legacy');

  globalThis.fetch = async () => Response.json({ contractVersion: 1, mode: 'legacy' });
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison key="legacy" request={request} document={target} operationId="operation-three"
      legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
      onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  assert.ok(document.querySelector('[data-testid="legacy-review"]'), 'explicit server legacy mode mounts the legacy path');

  const { openedDocumentAuthScope } = await import('../app/lib/collaboration/opened-document-registry');
  const pendingKey = actionState.graphReviewActionStorageKey(openedDocumentAuthScope(), target);
  const singleContext = { ...cleanAll.context,
    proposals: cleanAll.context.proposals.map((item) => item.proposalId === 'proposal-one'
      ? { ...item, operationId: 'operation-one' } : item), selectedProposalIds: ['proposal-one'],
    dependencyProposalIds: [], applyProposalIds: ['proposal-one'], closingAlternativeProposalIds: [] };
  const singleCompare = { ...cleanAll.compare, binding: { ...cleanAll.compare.binding,
    selectedProposalIds: ['proposal-one'] } };
  const actionCases = [
    { type: 'batch_accept' as const, button: 'Accept all changes', session: { ...cleanAll,
      actions: { accept: preparedAction('batch_accept', cleanAll.selectedProposalIds) }, capability: { write: true } } },
    { type: 'reject' as const, button: 'Reject', session: { ...conflict, context: singleContext,
      actions: { reject: preparedAction('reject', ['proposal-one']) }, capability: { write: true } } },
    { type: 'branch_reject' as const, button: 'Reject branch', session: { ...conflict, context: singleContext,
      actions: { branchReject: preparedAction('branch_reject', ['proposal-one']) }, capability: { write: true } } },
    { type: 'complete_satisfied' as const, button: 'Mark as already present', session: { ...cleanAll,
      selectedProposalIds: ['proposal-one'], status: 'empty_effect', compare: { ...singleCompare,
        status: 'empty_effect', candidate: { contentAvailable: false, noEffect: true },
        summary: { additions: 0, deletions: 0, unchanged: 0 }, hunks: [] },
      context: singleContext, actions: { completeSatisfied: preparedAction('complete_satisfied', ['proposal-one']) },
      capability: { write: true } } },
    { type: 'complete_satisfied' as const, button: 'Mark as already present', session: { ...cleanAll,
      selectedProposalIds: ['proposal-one'], status: 'satisfied_elsewhere', compare: { ...singleCompare,
        status: 'satisfied_elsewhere', candidate: { contentAvailable: false, noEffect: true },
        summary: { additions: 0, deletions: 0, unchanged: 0 }, hunks: [] },
      context: singleContext, actions: { completeSatisfied: preparedAction('complete_satisfied', ['proposal-one']) },
      capability: { write: true } } },
  ];
  for (const [caseIndex, testCase] of actionCases.entries()) {
    actionState.forgetGraphReviewAction(pendingKey);
    const posted: Array<ProposalReviewActionApiRequestV1> = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path.endsWith('/actions/status')) return Response.json({ receipt: null, checkedAt: Date.now() });
      if (path.endsWith('/actions')) {
        const body = JSON.parse(String(init?.body)) as ProposalReviewActionApiRequestV1;
        posted.push(body);
        return Response.json({ contractVersion: 1, actionId: `action-${testCase.type}`, scope,
          actorId: 'actor-one', actionType: testCase.type, requestDigest: body.action.fence.requestDigest,
          idempotencyKeyHash: 'a'.repeat(64), affectedProposalIds: body.action.fence.selectedProposalIds,
          operationId: null, createdAt: 1, updatedAt: 2, phase: 'prepared', result: null, errorCode: null });
      }
      const reviewRequest = JSON.parse(String(init?.body)) as { selection: { kind: string } };
      return Response.json(testCase.type === 'batch_accept' && reviewRequest.selection.kind === 'operation'
        ? conflict : testCase.session);
    };
    await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <GraphReviewComparison key={`action-${testCase.type}-${caseIndex}`} request={request} document={target} operationId="operation-one"
        legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
        onTimelineInvalidate={() => {}} onContinue={() => {}} />
    </NextIntlClientProvider>); });
    await settle();
    if (testCase.type === 'batch_accept') {
      const reviewAll = [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Review all changes'));
      assert.ok(reviewAll, `batch approval starts with a server-frozen full-document selection: ${document.body.textContent}`);
      await act(async () => { reviewAll.click(); });
      await settle();
    }
    const actionButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(testCase.button));
    assert.ok(actionButton, `${testCase.type} appears only with a prepared signed fence`);
    if (testCase.type === 'complete_satisfied') {
      const noEffect = document.querySelector('[data-testid="graph-review-no-effect"]');
      assert.ok(noEffect, `${testCase.session.status} has an explicit proven no-effect explanation`);
      assert.match(noEffect.textContent ?? '', /without changing document content/i);
      assert.match(document.body.textContent ?? '', /\+0[\s\S]*−0[\s\S]*No changed lines appear in this comparison/iu);
      assert.doesNotMatch(noEffect.textContent ?? '', /Refresh the review to see the current reason/i);
      assert.equal([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Accept change')), false,
        'proven no-effect never presents a content Accept action');
    }
    await act(async () => { actionButton.focus(); actionButton.click(); });
    assert.equal(posted.length, 0, `${testCase.type} requires explicit final confirmation`);
    const confirmation = document.querySelector<HTMLElement>('[data-testid="graph-review-confirmation"]');
    assert.ok(confirmation);
    assert.equal(document.activeElement, confirmation, 'explicit confirmation receives keyboard focus');
    const cancelAction = [...confirmation.querySelectorAll('button')].find((button) => button.textContent?.includes('Cancel'));
    assert.ok(cancelAction);
    await act(async () => { cancelAction.click(); });
    assert.equal(document.activeElement, actionButton, 'cancelling confirmation restores its initiating button');
    assert.equal(posted.length, 0, 'cancelling confirmation never posts an action');
    await act(async () => { actionButton.click(); });
    if (testCase.type === 'batch_accept') assert.match(document.body.textContent ?? '', /1 prerequisite.*1 alternative/i);
    if (testCase.type === 'branch_reject') assert.match(document.body.textContent ?? '', /1 related branch member/i);
    const confirmAction = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Confirm action'));
    assert.ok(confirmAction);
    await act(async () => { confirmAction.click(); });
    await settle();
    assert.equal(posted.length, 1, `${testCase.type} sends one prepared action, never a loop of singles`);
    assert.equal(posted[0].action.fence.actionType, testCase.type);
    assert.deepEqual(posted[0].action.fence.selectedProposalIds, testCase.session.selectedProposalIds);
    assert.ok(document.querySelector('[data-testid="graph-review-pending-action"]'), 'an HTTP 200 prepared receipt is not success');
    assert.equal(document.querySelector('[data-testid="graph-review-action-error"]'), null,
      'a prepared receipt is pending durability, not a failed action');
  }
  actionState.forgetGraphReviewAction(pendingKey);
  let failedPostCount = 0;
  let failedPostInvalidations = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/actions')) {
      failedPostCount += 1;
      const body = JSON.parse(String(init?.body)) as ProposalReviewActionApiRequestV1;
      return Response.json({ contractVersion: 1, actionId: 'action-direct-failed', scope,
        actorId: 'actor-one', actionType: 'reject', requestDigest: body.action.fence.requestDigest,
        idempotencyKeyHash: 'a'.repeat(64), affectedProposalIds: ['proposal-one'],
        operationId: 'operation-one', createdAt: 1, updatedAt: 2, phase: 'failed', result: null,
        errorCode: 'PROPOSAL_GRAPH_CHANGED' });
    }
    return Response.json({ ...conflict, context: singleContext,
      actions: { reject: preparedAction('reject', ['proposal-one']) }, capability: { write: true } });
  };
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison key="direct-failed-action" request={request} document={target} operationId="operation-one"
      legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
      onTimelineInvalidate={() => { failedPostInvalidations += 1; }} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  const directReject = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Reject proposal'));
  assert.ok(directReject);
  await act(async () => { directReject.click(); });
  const directConfirm = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Confirm action'));
  assert.ok(directConfirm);
  await act(async () => { directConfirm.click(); });
  await settle();
  assert.equal(failedPostCount, 1, 'terminal failed POST never retries a mutation automatically');
  assert.equal(failedPostInvalidations, 1, 'terminal failed POST revalidates the timeline before a new decision');
  assert.equal(actionState.readGraphReviewActionIdentity(pendingKey), null, 'failed POST clears only its terminal identity');
  assert.match(document.body.textContent ?? '', /The action could not be completed/);

  for (const kind of ['detach', 'replace'] as const) {
    const posted: Array<ProposalReviewActionApiRequestV1> = [];
    const previewRequests: Array<{ kind: string; sourceProposalId: string; expectedGraphRevision: number }> = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path.endsWith('/transform/preview')) {
        previewRequests.push(JSON.parse(String(init?.body)));
        return Response.json(transformResponse(kind));
      }
      if (path.endsWith('/actions/status')) return Response.json({ receipt: null, checkedAt: Date.now() });
      if (path.endsWith('/actions')) {
        const body = JSON.parse(String(init?.body)) as ProposalReviewActionApiRequestV1;
        posted.push(body);
        return Response.json({ contractVersion: 1, actionId: `action-${kind}`, scope,
          actorId: 'actor-one', actionType: kind, requestDigest: body.action.fence.requestDigest,
          idempotencyKeyHash: 'a'.repeat(64), affectedProposalIds: ['proposal-one'],
          operationId: null, createdAt: 1, updatedAt: 2, phase: 'prepared', result: null, errorCode: null });
      }
      return Response.json({ ...conflict, context: singleContext, capability: { write: true } });
    };
    await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <GraphReviewComparison key={`transform-${kind}`} request={request} document={target} operationId="operation-one"
        legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
        onTimelineInvalidate={() => {}} onContinue={() => {}} />
    </NextIntlClientProvider>); });
    await settle();
    const startLabel = kind === 'detach' ? 'Check a separate proposal' : 'Check a replacement proposal';
    const start = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(startLabel));
    assert.ok(start);
    await act(async () => { start.focus(); start.click(); });
    await settle();
    assert.equal(previewRequests.length, 1);
    assert.deepEqual({ kind: previewRequests[0].kind, sourceProposalId: previewRequests[0].sourceProposalId,
      expectedGraphRevision: previewRequests[0].expectedGraphRevision },
    { kind, sourceProposalId: 'proposal-one', expectedGraphRevision: 2 });
    assert.equal(posted.length, 0, 'preview never writes');
    const preview = document.querySelector('[data-testid="graph-review-transform-preview"]');
    assert.ok(preview);
    assert.equal(document.activeElement, preview, 'user-requested transform preview receives focus after async verification');
    assert.match(preview.textContent ?? '', /Before/);
    assert.match(preview.textContent ?? '', /After/);
    assert.match(preview.textContent ?? '', kind === 'detach' ? /Current document/ : /Verified source or prerequisite basis/);
    assert.ok(preview.querySelector('[data-testid="graph-review-transform-full-content"]'), 'full before/proposed content is visible');
    assert.match(preview.textContent ?? '', kind === 'detach' ? /original proposal remains open/i : /supersedes the original/i);
    if (kind === 'detach') {
      const cancelPreview = [...preview.querySelectorAll('button')].find((button) => button.textContent?.includes('Cancel'));
      assert.ok(cancelPreview);
      await act(async () => { cancelPreview.click(); });
      assert.equal(document.activeElement, start, 'cancelling preview restores its initiating button');
      assert.equal(posted.length, 0, 'cancelling transform never creates a proposal');
      await act(async () => { start.click(); });
      await settle();
    }
    const activePreview = document.querySelector('[data-testid="graph-review-transform-preview"]');
    assert.ok(activePreview);
    const confirmCreate = [...activePreview.querySelectorAll('button')].find((button) => button.textContent?.includes('Create'));
    assert.ok(confirmCreate);
    await act(async () => { confirmCreate.click(); });
    await settle();
    assert.equal(posted.length, 1, 'one signed creation action is sent after explicit confirmation');
    assert.equal(posted[0].action.fence.actionType, kind);
    assert.equal(posted[0].action.creation?.creationKind, kind === 'detach' ? 'detached' : 'replacement');
    assert.ok(document.querySelector('[data-testid="graph-review-pending-action"]'),
      'prepared creation receipt remains pending durability');
    actionState.forgetGraphReviewAction(pendingKey);
  }
  let unexpectedCreationReceipt: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/transform/preview')) return Response.json(transformResponse('detach'));
    if (path.endsWith('/actions/status')) return Response.json({ receipt: unexpectedCreationReceipt, checkedAt: Date.now() });
    if (path.endsWith('/actions')) {
      const body = JSON.parse(String(init?.body)) as ProposalReviewActionApiRequestV1;
      unexpectedCreationReceipt = { contractVersion: 1, actionId: 'action-mismatch', scope,
        actorId: 'actor-one', actionType: 'detach', requestDigest: body.action.fence.requestDigest,
        idempotencyKeyHash: 'a'.repeat(64), affectedProposalIds: ['proposal-one'],
        operationId: null, createdAt: 1, updatedAt: 2, phase: 'succeeded', errorCode: null,
        result: { kind: 'metadata_only', revisionId: null, current: hashes,
          createdProposalIds: ['unexpected-creation'], resolutions: [] } };
      return Response.json(unexpectedCreationReceipt);
    }
    return Response.json({ ...conflict, context: singleContext, capability: { write: true } });
  };
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison key="transform-receipt-mismatch" request={request} document={target} operationId="operation-one"
      legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
      onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  const mismatchStart = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Check a separate proposal'));
  assert.ok(mismatchStart);
  await act(async () => { mismatchStart.click(); });
  await settle();
  const mismatchConfirm = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="graph-review-transform-preview"] button')]
    .find((button) => button.textContent?.includes('Create separate proposal'));
  assert.ok(mismatchConfirm);
  await act(async () => { mismatchConfirm.click(); });
  await settle();
  assert.ok(actionState.readGraphReviewActionIdentity(pendingKey), 'unexpected created proposal keeps the exact action locked');
  assert.ok(document.querySelector('[data-testid="graph-review-pending-action"]'));
  assert.match(document.body.textContent ?? '', /does not match the approved new proposal/);
  actionState.forgetGraphReviewAction(pendingKey);

  globalThis.fetch = async (input) => String(input).endsWith('/transform/preview')
    ? Response.json({ error: { code: 'PROPOSAL_CURRENT_CHANGED' } }, { status: 409 })
    : Response.json({ ...conflict, context: singleContext, capability: { write: true } });
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison key="transform-failed" request={request} document={target} operationId="operation-one"
      legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
      onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  const failedStart = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Check a separate proposal'));
  assert.ok(failedStart);
  await act(async () => { failedStart.click(); });
  await settle();
  assert.ok(document.querySelector('[data-testid="graph-review-transform-error"]'));
  assert.equal(document.querySelector('[data-testid="graph-review-transform-preview"]'), null, 'failed replay has no confirmable action');
  actionState.forgetGraphReviewAction(pendingKey);

  let releaseReview: ((response: Response) => void) | null = null;
  let holdRevalidation = false;
  const writableConflict = { ...conflict, context: singleContext,
    actions: { reject: preparedAction('reject', ['proposal-one']) }, capability: { write: true } };
  globalThis.fetch = async () => holdRevalidation
    ? new Promise<Response>((resolve) => { releaseReview = resolve; }) : Response.json(writableConflict);
  const renderRefresh = async (isRevalidating: boolean) => act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <GraphReviewComparison key="host-refresh-test" request={request} document={target} operationId="operation-one"
        legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={isRevalidating} isStale={false}
        onTimelineInvalidate={() => {}} onContinue={() => {}} />
    </NextIntlClientProvider>);
  });
  await renderRefresh(false);
  await settle();
  let rejectButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Reject proposal'));
  assert.ok(rejectButton && !rejectButton.disabled);
  await renderRefresh(true);
  rejectButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Reject proposal'));
  assert.ok(rejectButton?.disabled, 'host revalidation immediately blocks old actions');
  holdRevalidation = true;
  await renderRefresh(false);
  await settle();
  assert.ok(releaseReview, 'falling host invalidation starts an exact new review');
  rejectButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Reject proposal'));
  assert.ok(rejectButton?.disabled, 'old action remains blocked after host loading flag falls');
  await act(async () => { releaseReview!(Response.json(writableConflict)); });
  await settle();
  rejectButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Reject proposal'));
  assert.ok(rejectButton && !rejectButton.disabled, 'fresh review restores actionability');

  let releaseLegacyReview: ((response: Response) => void) | null = null;
  let holdLegacyReview = false;
  globalThis.fetch = async () => holdLegacyReview
    ? new Promise<Response>((resolve) => { releaseLegacyReview = resolve; })
    : Response.json({ contractVersion: 1, mode: 'legacy' });
  const renderLegacyRefresh = async (isRevalidating: boolean) => act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <GraphReviewComparison key="legacy-host-refresh-test" request={request} document={target} operationId="operation-one"
        legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={isRevalidating} isStale={false}
        onTimelineInvalidate={() => {}} onContinue={() => {}} />
    </NextIntlClientProvider>);
  });
  await renderLegacyRefresh(false);
  await settle();
  assert.ok(document.querySelector('[data-testid="legacy-review"]'));
  await renderLegacyRefresh(true);
  assert.equal(document.querySelector('[data-testid="legacy-review"]'), null,
    'stale legacy actions are not mounted during host revalidation');
  holdLegacyReview = true;
  await renderLegacyRefresh(false);
  await settle();
  assert.ok(releaseLegacyReview);
  assert.equal(document.querySelector('[data-testid="legacy-review"]'), null,
    'legacy actions remain hidden after host loading falls until an explicit fresh legacy response');
  await act(async () => { releaseLegacyReview!(Response.json({ contractVersion: 1, mode: 'legacy' })); });
  await settle();
  assert.ok(document.querySelector('[data-testid="legacy-review"]'));

  let reviewAccessRevoked = false;
  globalThis.fetch = async () => reviewAccessRevoked
    ? Response.json({ error: { code: 'PROPOSAL_ACCESS_DENIED' } }, { status: 403 })
    : Response.json(writableConflict);
  const renderRevocation = async (isRevalidating: boolean) => act(async () => {
    root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <GraphReviewComparison key="review-revocation-test" request={request} document={target} operationId="operation-one"
        legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={isRevalidating} isStale={false}
        onTimelineInvalidate={() => {}} onContinue={() => {}} />
    </NextIntlClientProvider>);
  });
  await renderRevocation(false);
  await settle();
  assert.ok(document.querySelector('[data-testid="graph-review-context"]'));
  reviewAccessRevoked = true;
  await renderRevocation(true);
  await renderRevocation(false);
  await settle();
  assert.ok(document.querySelector('[data-testid="graph-review-load-error"]'));
  assert.equal(document.querySelector('[data-testid="graph-review-comparison"]'), null,
    'access revocation removes the cached graph comparison, not just its actions');
  assert.equal(document.querySelector('[data-testid="graph-review-context"]'), null,
    'previously authorized proposal relationships are purged after revocation');
  assert.equal(document.querySelector('[data-testid="legacy-review"]'), null,
    'review denial never mounts a legacy fallback');

  actionState.rememberGraphReviewAction(pendingKey, exactAction);
  let failedStatusReads = 0;
  let failedReviewReads = 0;
  let releaseFailedInvalidation: (() => void) | null = null;
  let failedInvalidations = 0;
  const failedInvalidate = () => {
    failedInvalidations += 1;
    return new Promise<void>((resolve) => { releaseFailedInvalidation = resolve; });
  };
  const failedReceipt = { contractVersion: 1, actionId: 'action-failed', scope, actorId: 'actor-one',
    actionType: 'accept', requestDigest: 'f'.repeat(64),
    idempotencyKeyHash: createHash('sha256').update('action-identity-one').digest('hex'),
    affectedProposalIds: ['proposal-one'], operationId: 'operation-one', createdAt: 1, updatedAt: 2,
    phase: 'failed', result: null, errorCode: 'PROPOSAL_CURRENT_CHANGED' };
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/actions/status')) {
      failedStatusReads += 1;
      return Response.json({ receipt: failedReceipt, checkedAt: Date.now() });
    }
    failedReviewReads += 1;
    return Response.json(writableConflict);
  };
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison key="failed-receipt-test" request={request} document={target} operationId="operation-one"
      legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
      onTimelineInvalidate={failedInvalidate} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  assert.equal(failedStatusReads, 1);
  assert.equal(failedInvalidations, 1, 'terminal failed receipt triggers a timeline refresh');
  assert.equal(actionState.readGraphReviewActionIdentity(pendingKey), null, 'terminal failed identity is cleared');
  rejectButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Reject proposal'));
  assert.ok(!rejectButton || rejectButton.disabled, 'a failed receipt cannot expose the old signed action before refresh');
  assert.match(document.body.textContent ?? '', /The action could not be completed/);
  await act(async () => { releaseFailedInvalidation!(); });
  await settle();
  assert.ok(failedReviewReads >= 2, 'a failed receipt is followed by a fresh review evaluation');
  assert.equal(failedStatusReads, 1, 'no automatic status or action retry loop follows a terminal failure');

  actionState.rememberGraphReviewAction(pendingKey, exactAction);
  let releaseSucceededInvalidation: (() => void) | null = null;
  let succeededInvalidations = 0;
  let succeededActionPosts = 0;
  const succeededReceipt = { ...failedReceipt, actionId: 'action-succeeded', actionType: 'reject',
    operationId: null, phase: 'succeeded', errorCode: null,
    result: { kind: 'metadata_only', revisionId: null, current: hashes, createdProposalIds: [],
      resolutions: [{ proposalId: 'proposal-one', lifecycle: 'rejected' }] } };
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/actions/status')) return Response.json({ receipt: succeededReceipt, checkedAt: Date.now() });
    if (String(input).endsWith('/actions')) succeededActionPosts += 1;
    return Response.json(writableConflict);
  };
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison key="succeeded-receipt-test" request={request} document={target} operationId="operation-one"
      legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
      onTimelineInvalidate={() => {
        succeededInvalidations += 1;
        return new Promise<void>((resolve) => { releaseSucceededInvalidation = resolve; });
      }} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  assert.equal(succeededInvalidations, 1, 'recovered success starts an authoritative timeline refresh');
  rejectButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Reject proposal'));
  assert.ok(!rejectButton || rejectButton.disabled,
    'recovered success cannot expose the old decision while timeline invalidation is in flight');
  assert.equal(succeededActionPosts, 0);
  await act(async () => { releaseSucceededInvalidation!(); });
  await settle();
  assert.equal(actionState.readGraphReviewActionIdentity(pendingKey), null);

  globalThis.fetch = async () => Response.json({ ...conflict,
    reasonCode: 'PROPOSAL_BATCH_CONFLICT',
    diagnosis: { ...diagnosis, reasonCode: 'PROPOSAL_BATCH_CONFLICT' } });
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison key="single-current-conflict" request={request} document={target} operationId="operation-one"
      legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
      onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  const singleConflict = document.querySelector('[data-testid="graph-review-blocked"]');
  assert.match(singleConflict?.textContent ?? '', /overlaps changes in the current document.*automatic merge is unsafe/i);
  assert.doesNotMatch(singleConflict?.textContent ?? '', /selected proposals cannot be applied together/i);

  const assertVisibleBlockedDiagnosis = async (input: {
    key: string;
    payload: Record<string, unknown>;
    expectedReason: RegExp;
    loadError?: boolean;
    transportFailure?: boolean;
    batch?: boolean;
  }) => {
    globalThis.fetch = input.transportFailure
      ? async () => { throw new TypeError('private document content private-content-hash secret-fence-token private error detail'); }
      : async (_request, init) => {
        if (input.batch) {
          const body = JSON.parse(String(init?.body)) as { selection: { kind: string } };
          return Response.json(body.selection.kind === 'all' ? input.payload : conflict);
        }
        return Response.json(input.payload);
      };
    await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <GraphReviewComparison key={input.key} request={request} document={target} operationId="operation-diagnostic"
        legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
        onTimelineInvalidate={() => {}} onContinue={() => {}} />
    </NextIntlClientProvider>); });
    await settle();
    if (input.batch) {
      const reviewAll = [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Review all changes'));
      assert.ok(reviewAll, 'the batch fixture starts from the exact single-operation view');
      await act(async () => { reviewAll.click(); });
      await settle();
    }

    if (input.loadError) {
      const loadError = document.querySelector('[data-testid="graph-review-load-error"]');
      assert.ok(loadError, 'network failure has its own load-error presentation');
      assert.match(loadError.textContent ?? '', input.expectedReason);
    } else {
      const blocked = document.querySelector('[data-testid="graph-review-blocked"]');
      assert.ok(blocked, `${input.key} is presented as blocked, not as a valid comparison`);
      assert.match(blocked.textContent ?? '', input.expectedReason);
      assert.equal(document.querySelector('[data-testid="graph-review-hunks"]'), null,
        'unproven or conflicting input never renders a diff');
    }
    assert.doesNotMatch(document.body.textContent ?? '', /\+\s*0|−\s*0/u,
      'unavailable or conflicting input never presents zero counts as a valid diff');
    assert.equal([...document.querySelectorAll('button')]
      .some((button) => /accept/i.test(button.textContent ?? '')), false,
    'blocked diagnostics never expose an Accept action');
    assert.equal(document.querySelector('[data-testid="legacy-review"]'), null,
      'graph diagnostics never fall back to legacy review actions');

    const diagnostics = document.querySelector<HTMLDetailsElement>('[data-testid="graph-review-diagnostics"]');
    assert.ok(diagnostics, 'redacted details can be expanded for both session and transport failures');
    const summary = diagnostics.querySelector('summary');
    assert.ok(summary);
    await act(async () => { summary.click(); });
    assert.equal(diagnostics.open, true);
    const safePayload = diagnostics.querySelector('pre')?.textContent ?? '';
    assert.match(safePayload, input.loadError ? /FVRC_TRANSPORT_ERROR/u
      : new RegExp(String(input.payload.reasonCode), 'u'));
    assert.doesNotMatch(safePayload, /private document content|private-content-hash|secret-fence-token|private error detail/iu,
      'expanded diagnostic details omit document content, full hashes, fence tokens and transport error text');

    let copiedDiagnostic = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async (value: string) => { copiedDiagnostic = value; } } });
    const copyDiagnostic = [...diagnostics.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Copy'));
    assert.ok(copyDiagnostic);
    await act(async () => { copyDiagnostic.click(); });
    assert.equal(copiedDiagnostic, safePayload, 'copied diagnostics exactly match the visible redacted details');
    assert.doesNotMatch(copiedDiagnostic, /private document content|private-content-hash|secret-fence-token|private error detail/iu);
  };

  for (const [index, reasonCode, expectedReason] of [
    [0, 'PROPOSAL_CONTENT_UNAVAILABLE', /proposal content is unavailable/i],
    [1, 'PROPOSAL_SOURCE_INVALID', /original basis cannot be verified/i],
  ] as const) {
    // These fixtures represent an unproven legacy source basis. They do not
    // classify distinct, provably disjoint graph bases as incompatible.
    const unavailableBasis = {
      ...conflict,
      status: 'unavailable',
      reasonCode,
      compare: null,
      actions: {},
      capability: { write: true },
      diagnosis: { ...diagnosis, reasonCode },
    };
    await assertVisibleBlockedDiagnosis({
      key: `unavailable-basis-${index}`,
      payload: unavailableBasis,
      expectedReason,
    });
  }

  await assertVisibleBlockedDiagnosis({
    key: 'genuine-batch-conflict',
    payload: {
      ...conflict,
      selectedProposalIds: ['proposal-one', 'proposal-two'],
      status: 'conflicted',
      reasonCode: 'PROPOSAL_BATCH_CONFLICT',
      compare: null,
      actions: {},
      capability: { write: true },
      diagnosis: { ...diagnosis, reasonCode: 'PROPOSAL_BATCH_CONFLICT' },
    },
    expectedReason: /selected proposals cannot be applied together/i,
    batch: true,
  });

  await assertVisibleBlockedDiagnosis({
    key: 'network-failure',
    payload: {},
    expectedReason: /review service could not be reached/i,
    loadError: true,
    transportFailure: true,
  });

  actionState.rememberGraphReviewAction(pendingKey, exactAction);
  const durabilityReceipt = { contractVersion: 1, actionId: 'action-one',
    scope: { workspaceId: target.workspaceId, lineageId: target.lineageId, documentId: target.documentId,
      lifecycleGeneration: 1, schemaVersion: 1 }, actorId: 'actor-one', actionType: 'accept',
    requestDigest: 'f'.repeat(64), idempotencyKeyHash: createHash('sha256').update('action-identity-one').digest('hex'),
    affectedProposalIds: ['proposal-one'],
    operationId: 'operation-one', createdAt: 1, updatedAt: 2, phase: 'awaiting_durability', result: null, errorCode: null };
  globalThis.fetch = async (input) => String(input).endsWith('/actions/status')
    ? Response.json({ receipt: durabilityReceipt, checkedAt: Date.now() }) : Response.json(conflict);
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison key="pending-first" request={request} document={target} operationId="operation-four"
      legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
      onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  assert.ok(document.querySelector('[data-testid="graph-review-pending-action"]'));
  assert.match(document.querySelector('[data-testid="graph-review-pending-action"]')?.textContent ?? '',
    /Saving the applied changes durably/);
  assert.match(document.querySelector('[data-testid="graph-review-pending-action"]')?.textContent ?? '', /Last checked:/);
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison key="pending-reopened" request={request} document={target} operationId="operation-five"
      legacy={<div data-testid="legacy-review">Legacy</div>} isRevalidating={false} isStale={false}
      onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  assert.ok(document.querySelector('[data-testid="graph-review-pending-action"]'), 'reopened panel retains uncertain action');
  assert.equal(actionState.exactGraphReviewAction(pendingKey)?.action.idempotencyKey, exactAction.action.idempotencyKey);
  globalThis.fetch = async (input) => String(input).endsWith('/actions/status')
    ? Response.json({ receipt: null, checkedAt: testExpiry - 1 }) : Response.json(conflict);
  const checkBeforeExpiry = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Check action status'));
  assert.ok(checkBeforeExpiry);
  await act(async () => { checkBeforeExpiry.click(); });
  await settle();
  assert.ok(actionState.readGraphReviewActionIdentity(pendingKey), 'null receipt before approval expiry does not unlock review');
  globalThis.fetch = async (input) => String(input).endsWith('/actions/status')
    ? Response.json({ receipt: null, checkedAt: testExpiry + 1 }) : Response.json(conflict);
  const checkStatus = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Check action status'));
  assert.ok(checkStatus);
  await act(async () => { checkStatus.click(); });
  await settle();
  assert.equal(actionState.readGraphReviewActionIdentity(pendingKey), null, 'server absence after approval expiry unlocks review');

  const branchRequest = { ...request, branchOverview: true as const,
    selectedEntry: { kind: 'agent_operation' as const, id: 'operation-proposal-one' } };
  const branchSession = { ...cleanAll, selectedProposalIds: ['proposal-one'], compare: {
    ...cleanAll.compare, binding: { ...cleanAll.compare.binding, selectedProposalIds: ['proposal-one'] },
  }, capability: { write: true }, actions: { reject: preparedAction('reject', ['proposal-one']) },
  context: { ...cleanAll.context, selectedProposalIds: ['proposal-one'] } };
  const branchReads: Array<{ selection: unknown }> = [];
  const cardStatuses: unknown[] = [];
  const onBranchStatus = (value: unknown) => { cardStatuses.push(value); };
  globalThis.fetch = async (_input, init) => {
    branchReads.push(JSON.parse(String(init?.body)));
    return Response.json(branchSession);
  };
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison key="branch-overview" request={branchRequest} document={target}
      operationId="operation-proposal-one" legacy={<div data-testid="legacy-review">Legacy</div>}
      isRevalidating={false} isStale={false} onTimelineInvalidate={() => {}} onContinue={() => {}}
      onReviewStatus={onBranchStatus} />
  </NextIntlClientProvider>); });
  await settle();
  const overview = document.querySelector('[data-testid="graph-review-branch-overview"]');
  assert.ok(overview, 'group notifications open a branch overview, not an automatically actionable root');
  assert.equal(overview.querySelectorAll('button[data-proposal-id]').length, cleanAll.context.proposals.length);
  assert.doesNotMatch(overview.textContent ?? '', /Reject proposal|Accept proposal|Accept all|Review all changes/);
  assert.deepEqual(cardStatuses.find(value => value !== null), {
    operationId: 'operation-proposal-one', status: 'clean', reasonCode: null,
    branchContext: { rootProposalId: 'proposal-one', graphRevision: 2 },
  }, 'only a resolved authorized graph context can acknowledge a branch notification');
  const branchChoice = overview.querySelector<HTMLButtonElement>('button[data-proposal-id="proposal-two"]');
  assert.ok(branchChoice);
  await act(async () => { branchChoice.click(); });
  await settle();
  assert.equal(document.querySelector('[data-testid="graph-review-branch-overview"]'), null);
  assert.deepEqual(branchReads.at(-1)?.selection, { kind: 'proposals', proposalIds: ['proposal-two'] },
    'the chosen node, not the newest/root node, starts the next separate review');

  globalThis.fetch = async () => Response.json({ contractVersion: 1, mode: 'legacy' });
  await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <GraphReviewComparison key="branch-legacy-fail-closed" request={branchRequest} document={target}
      operationId="operation-proposal-one" legacy={<div data-testid="legacy-review">Legacy</div>}
      isRevalidating={false} isStale={false} onTimelineInvalidate={() => {}} onContinue={() => {}} />
  </NextIntlClientProvider>); });
  await settle();
  assert.equal(document.querySelector('[data-testid="legacy-review"]'), null,
    'a graph group never falls back to a legacy single-proposal action');
  assert.ok(document.querySelector('[data-testid="graph-review-load-error"]'));

  for (const [lifecycle, label] of [
    ['applied', 'Applied'], ['included', 'Included'], ['rejected', 'Rejected'],
    ['superseded', 'Superseded'], ['alternative_not_selected', 'Not selected'],
    ['satisfied_elsewhere', 'Already present'], ['expired', 'Expired'],
  ] as const) {
    const closedStatuses: Array<{ lifecycle?: string } | null> = [];
    const closedSession = { ...conflict, status: 'blocked_by_parent', reasonCode: 'PROPOSAL_INVALID_TRANSITION',
      diagnosis: { ...diagnosis, reasonCode: 'PROPOSAL_INVALID_TRANSITION' }, capability: { write: true },
      context: { graphRevision: 2, proposals: [{ ...proposal('proposal-one', null, 'root'), lifecycle }],
        selectedProposalIds: ['proposal-one'], dependencyProposalIds: [], applyProposalIds: [],
        closingAlternativeProposalIds: [], reasonCode: 'PROPOSAL_INVALID_TRANSITION' } };
    globalThis.fetch = async () => Response.json(closedSession);
    await act(async () => { root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <GraphReviewComparison key={`historical-${lifecycle}`} request={request} document={target}
        operationId="operation-proposal-one" legacy={<div data-testid="legacy-review">Legacy</div>}
        isRevalidating={false} isStale={false} onTimelineInvalidate={() => {}} onContinue={() => {}}
        onReviewStatus={(value) => closedStatuses.push(value)} />
    </NextIntlClientProvider>); });
    await settle();
    const historical = document.querySelector('[data-testid="graph-review-historical-status"]');
    assert.match(historical?.textContent ?? '', new RegExp(label, 'iu'),
      `${lifecycle} is presented as an exact terminal historical state`);
    assert.equal(document.querySelector('[data-testid="graph-review-blocked"]'), null);
    assert.doesNotMatch(document.body.textContent ?? '', /The relationship review is blocked|This decision is no longer allowed/iu);
    assert.ok(document.querySelector('[data-testid="graph-review-diagnostics"]'), 'redacted diagnostics remain inspectable');
    const footer = document.querySelector('[data-testid="graph-review-footer"]');
    assert.doesNotMatch(footer?.textContent ?? '', /Accept change|Reject proposal|Check a separate proposal|replacement proposal/iu,
      'closed exact selections expose no mutation controls, including disabled ones');
    assert.equal(closedStatuses.find((value) => value?.lifecycle === lifecycle)?.lifecycle, lifecycle,
      'the selected exact closed operation forwards its authorized lifecycle to the timeline');
  }
  await act(async () => { root.unmount(); });
  console.log('Graph review comparison component tests passed.');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
