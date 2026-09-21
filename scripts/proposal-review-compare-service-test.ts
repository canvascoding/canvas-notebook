import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { PROPOSAL_GRAPH_ERROR_CODES as Codes, ProposalGraphContractError, type ProposalCurrentProofV1, type ProposalEvaluationV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { createProposalReviewCompareService } from '../app/lib/file-version-center/proposal-review-compare-service';
import type { ProposalReviewEvaluationResult } from '../app/lib/file-version-center/proposal-review-evaluation';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const proof = (content: string): ProposalCurrentProofV1 => ({ revisionId: null, contentHash: digest(content), structureHash: digest(`s:${content}`),
  stateVectorHash: digest(`v:${content}`), deleteSetHash: digest(`d:${content}`), fullStateHash: digest(`f:${content}`) });
const selectionHash = digest('selection');

function material(input: { selected?: string[]; current?: string; candidate?: string | null; status?: ProposalEvaluationV1['status']; graphRevision?: number; currentGraphRevision?: number; evaluationId?: string }) {
  const current = input.current ?? 'base\n'; const selected = input.selected ?? ['p1']; const status = input.status ?? 'clean';
  const evaluation: ProposalEvaluationV1 = { contractVersion: 1, evaluationId: input.evaluationId ?? 'eval-1', proposalId: selected[0]!,
    scope: { workspaceId: 'w', lineageId: 'l', documentId: 'd', lifecycleGeneration: 1, schemaVersion: 1 }, current: proof(current),
    graphRevision: input.graphRevision ?? 7, status, reasonCode: null,
    effectiveCandidate: status === 'empty_effect' ? null : { ref: 'candidate', sha256: digest('candidate'), sizeBytes: 1, encoding: 'yjs_full_update_v1' },
    anchorMap: status === 'empty_effect' ? null : { ref: 'anchor', sha256: digest('anchor'), sizeBytes: 1 },
    effectPreconditions: status === 'empty_effect' ? null : { ref: 'effect', sha256: digest('effect'), sizeBytes: 1 },
    selectionHash, evaluatedAt: 1, expiresAt: Date.now() + 60_000 };
  return { evaluation, selectionHash, selectedProposalIds: selected, graphRevision: input.graphRevision ?? 7,
    currentGraphRevision: input.currentGraphRevision ?? input.graphRevision ?? 7,
    candidateContent: input.candidate === undefined ? 'base\nchanged\n' : input.candidate, status,
    nullEffectProven: status === 'empty_effect' || status === 'satisfied_elsewhere' };
}

function freshResult(value: ReturnType<typeof material>): ProposalReviewEvaluationResult {
  return { status: value.status, reasonCode: null, current: value.evaluation.current, graphRevision: value.graphRevision,
    selectedProposalIds: value.selectedProposalIds, dependencyProposalIds: [], applyProposalIds: value.selectedProposalIds,
    prerequisiteProposalIds: [], closureProposalIds: value.selectedProposalIds, selectionHash: value.selectionHash,
    actionability: value.status === 'empty_effect' ? 'complete_satisfied' : 'accept', evaluation: value.evaluation,
    effectiveCandidate: value.evaluation.effectiveCandidate, candidateContent: value.candidateContent,
    candidateProof: value.status === 'empty_effect' || value.status === 'satisfied_elsewhere' ? value.evaluation.current : null,
    appliedProposalIds: [], satisfiedProposalIds: [] };
}

function service(value: ReturnType<typeof material>, options: { current?: string; load?: typeof value | null; error?: ProposalGraphContractError } = {}) {
  return createProposalReviewCompareService({
    evaluateSelection: async () => { if (options.error) throw options.error; return freshResult(value); },
    loadEvaluation: async () => { if (options.error) throw options.error; return options.load === null ? null : (options.load ?? value); },
    loadCurrent: async () => ({ content: options.current ?? 'base\n', proof: proof(options.current ?? 'base\n') }),
  });
}

test('cumulative child can be reviewed before parent acceptance and remaining proposals still form a batch later', async () => {
  const child = material({ selected: ['parent', 'child'], candidate: 'base\nparent\nchild\n' });
  const first = await service(child).compare({ selectedProposalIds: ['parent', 'child'] });
  assert.equal(first.diagnosis.availability, 'available');
  assert.equal(first.summary.additions, 2);

  const remaining = material({ selected: ['r1', 'r2', 'r3'], candidate: 'base\nr1\nr2\nr3\n' });
  const later = await service(remaining).compare({ selectedProposalIds: ['r1', 'r2', 'r3'] });
  assert.equal(later.diagnosis.availability, 'available');
  assert.deepEqual(later.binding?.selectedProposalIds, ['r1', 'r2', 'r3']);
});

test('separate edits keep unchanged anchors instead of collapsing the whole middle into one replacement', async () => {
  const value = material({ current: 'a\nb\nc\nd\ne\n', candidate: 'a\nB\nc\nd\nE\n' });
  const response = await service(value, { current: 'a\nb\nc\nd\ne\n' }).compare({ selectedProposalIds: ['p1'] });
  assert.equal(response.diagnosis.availability, 'available');
  assert.deepEqual(response.summary, { additions: 2, deletions: 2, unchanged: 3 });
  assert.equal(response.hunks.flatMap((hunk) => hunk.lines)
    .some((line) => line.kind === 'context' && line.text === 'c'), true);
});

test('follow-up pages are bound to evaluation, exact selection, current proof and graph revision', async () => {
  const value = material({ candidate: Array.from({ length: 501 }, (_, i) => `line-${i}`).join('\n') });
  const initial = await service(value).compare({ selectedProposalIds: ['p1'], limit: 1 });
  assert.equal(initial.page.hasMore, true);
  const next = await service(value).compare({ selectedProposalIds: ['p1'], binding: initial.binding!, cursor: initial.page.nextCursor, limit: 1 });
  assert.equal(next.diagnosis.availability, 'available');
  const bad = await service(value).compare({ selectedProposalIds: ['p1'], binding: { ...initial.binding!, graphRevision: 8 } });
  assert.equal(bad.diagnosis.reasonCode, Codes.candidateChanged);
});

test('authoritative current and graph changes fail closed with stable diagnostics', async () => {
  const value = material({ candidate: 'base\nchange\n' });
  const initial = await service(value).compare({ selectedProposalIds: ['p1'] });
  assert.equal((await service(value, { current: 'new current\n' }).compare({ selectedProposalIds: ['p1'], binding: initial.binding! })).diagnosis.reasonCode, Codes.currentChanged);
  assert.equal((await service(material({ candidate: 'base\nchange\n', currentGraphRevision: 8 })).compare({ selectedProposalIds: ['p1'], binding: initial.binding! })).diagnosis.reasonCode, Codes.graphChanged);
});

test('hidden closure, foreign non-manager and cross-workspace loaders expose no candidate', async () => {
  const value = material({ candidate: 'secret\n' });
  for (const code of [Codes.accessDenied, Codes.scopeMismatch] as const) {
    const response = await service(value, { error: new ProposalGraphContractError(code, 'denied') }).compare({ selectedProposalIds: ['p1'] });
    assert.equal(response.diagnosis.reasonCode, code);
    assert.equal(response.candidate.contentAvailable, false);
  }
  const hidden = await service(value, { load: null }).compare({ selectedProposalIds: ['p1'], binding: {
    evaluationId: value.evaluation.evaluationId, selectionHash, selectedProposalIds: ['p1'], current: value.evaluation.current, graphRevision: 7,
  } });
  assert.equal(hidden.diagnosis.reasonCode, Codes.contentUnavailable);
});

test('a null candidate is successful only for an explicitly proven null-effect evaluation', async () => {
  const noEffect = material({ status: 'empty_effect', candidate: null });
  const response = await service(noEffect).compare({ selectedProposalIds: ['p1'] });
  assert.equal(response.diagnosis.availability, 'available');
  assert.equal(response.candidate.noEffect, true);
  assert.equal(response.hunks.length, 0);
  const satisfiedElsewhere = await service(material({ status: 'satisfied_elsewhere', candidate: null }))
    .compare({ selectedProposalIds: ['p1'] });
  assert.equal(satisfiedElsewhere.diagnosis.availability, 'available');
  assert.equal(satisfiedElsewhere.candidate.noEffect, true);
  const bad = material({ candidate: null });
  assert.equal((await service(bad).compare({ selectedProposalIds: ['p1'] })).diagnosis.reasonCode, Codes.contentUnavailable);
});
