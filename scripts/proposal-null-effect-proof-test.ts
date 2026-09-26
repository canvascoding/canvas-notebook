import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type * as YTypes from 'yjs';

import { Y } from '../app/lib/collaboration/server-runtime';
import { createAgentTextTarget, createRichAgentTextTargets } from '../app/lib/collaboration/agent-operations';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { hasProposalNullEffectProof } from '../app/lib/file-version-center/proposal-null-effect-proof';
import { createProposalReviewCompareService } from '../app/lib/file-version-center/proposal-review-compare-service';
import { PROPOSAL_GRAPH_ERROR_CODES as Codes } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import {
  authorProposalYjsCandidate, composeProposalYjsCandidate, proposalYjsCurrentProof,
  type AuthoredProposalYjsCandidate, type ProposalYjsRepresentation,
} from '../app/lib/file-version-center/proposal-yjs-candidate';
import type { ProposalReviewEvaluationResult } from '../app/lib/file-version-center/proposal-review-evaluation';

const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const encode = (doc: YTypes.Doc) => Y.encodeStateAsUpdate(doc);

function reopen(update: Uint8Array): YTypes.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, update);
  return doc;
}

function authorEdit(sourceUpdate: Uint8Array, search: string, replacement: string,
  representation: ProposalYjsRepresentation): AuthoredProposalYjsCandidate {
  const doc = reopen(sourceUpdate);
  try {
    const targets = representation === 'plain_text'
      ? (() => {
        const source = doc.getText('content').toString();
        const from = source.indexOf(search);
        assert.notEqual(from, -1, `fixture is missing ${search}`);
        return [createAgentTextTarget({ text: doc.getText('content'), from, to: from + search.length, replacement })];
      })()
      : createRichAgentTextTargets({ doc, search, replacement });
    return authorProposalYjsCandidate({ sourceUpdate, representation, targets });
  } finally {
    doc.destroy();
  }
}

function emptyChain(representation: ProposalYjsRepresentation) {
  const doc = representation === 'plain_text'
    ? createPlainTextYDoc('Plan: 100 USD.')
    : createRichMarkdownYDoc('Plan: 100 USD.', 'tiptap_blocks');
  const baseUpdate = encode(doc);
  const parent = authorEdit(baseUpdate, '100', '120', representation);
  const child = authorEdit(parent.cumulativeCandidate, '120', '100', representation);
  const composition = composeProposalYjsCandidate({
    representation,
    currentUpdate: baseUpdate,
    revisionId: 'revision-current',
    ordered: [
      { proposalId: 'parent', dependencyProposalId: null, mode: 'apply', sourceUpdate: baseUpdate, artifacts: parent },
      { proposalId: 'child', dependencyProposalId: 'parent', mode: 'apply', sourceUpdate: parent.cumulativeCandidate, artifacts: child },
    ],
  });
  doc.destroy();
  assert.ok('candidateUpdate' in composition, `composition failed: ${JSON.stringify(composition)}`);
  return { baseUpdate, composition };
}

function evaluationResult(composition: Extract<ReturnType<typeof composeProposalYjsCandidate>, { candidateUpdate: Uint8Array }>): ProposalReviewEvaluationResult {
  const selectionHash = digest('parent+child selection');
  const current = composition.current;
  const effectiveCandidate = { ref: 'candidate-artifact', sha256: digest('candidate-artifact'), sizeBytes: 1,
    encoding: 'yjs_full_update_v1' as const };
  const artifact = (name: string) => ({ ref: `${name}-artifact`, sha256: digest(`${name}-artifact`), sizeBytes: 1 });
  const evaluation = {
    contractVersion: 1 as const,
    evaluationId: 'evaluation-null-effect',
    proposalId: 'child',
    scope: { workspaceId: 'workspace', lineageId: 'lineage', documentId: 'document', lifecycleGeneration: 1, schemaVersion: 1 },
    current,
    graphRevision: 9,
    status: composition.status,
    reasonCode: null,
    effectiveCandidate,
    anchorMap: artifact('anchor'),
    effectPreconditions: artifact('effect'),
    selectionHash,
    evaluatedAt: 1,
    expiresAt: Date.now() + 60_000,
  };
  return {
    status: composition.status,
    reasonCode: null,
    current,
    graphRevision: 9,
    selectedProposalIds: ['child'],
    dependencyProposalIds: ['parent'],
    applyProposalIds: ['parent', 'child'],
    prerequisiteProposalIds: [],
    closureProposalIds: ['parent', 'child'],
    selectionHash,
    actionability: 'complete_satisfied',
    evaluation,
    effectiveCandidate,
    candidateContent: composition.content,
    candidateProof: composition.candidate,
    appliedProposalIds: [...composition.appliedProposalIds],
    satisfiedProposalIds: [...composition.satisfiedProposalIds],
  };
}

test('real A→B→A composer proves semantic null effect while retaining changed CRDT identity', async (t) => {
  for (const representation of ['plain_text', 'tiptap_blocks'] as const) {
    await t.test(representation, async () => {
      const { baseUpdate, composition } = emptyChain(representation);
      assert.equal(composition.status, 'empty_effect');
      assert.equal(composition.content, 'Plan: 100 USD.');
      assert.equal(composition.current.contentHash, composition.candidate.contentHash);
      assert.equal(composition.current.structureHash, composition.candidate.structureHash);
      assert.notEqual(composition.current.fullStateHash, composition.candidate.fullStateHash,
        'the cancellation must retain its distinct authored CRDT state');
      assert.deepEqual(composition.appliedProposalIds, ['parent', 'child']);
      assert.equal(hasProposalNullEffectProof('empty_effect', composition.current, composition.candidate), true);

      const result = evaluationResult(composition);
      const service = createProposalReviewCompareService({
        evaluateSelection: async () => result,
        loadEvaluation: async () => ({
          evaluation: result.evaluation!,
          selectionHash: result.selectionHash!,
          selectedProposalIds: result.selectedProposalIds,
          graphRevision: result.graphRevision!,
          currentGraphRevision: result.graphRevision!,
          candidateContent: result.candidateContent,
          status: result.status,
          nullEffectProven: hasProposalNullEffectProof(result.status, result.current, result.candidateProof),
        }),
        loadCurrent: async () => ({ content: composition.content, proof: composition.current }),
      });
      const compared = await service.compare({ selectedProposalIds: ['child'] });
      assert.equal(compared.status, 'empty_effect');
      assert.equal(compared.diagnosis.availability, 'available');
      assert.equal(compared.candidate.noEffect, true);
      assert.deepEqual(compared.summary, { additions: 0, deletions: 0, unchanged: 0 });
      assert.equal(compared.binding?.current.fullStateHash, composition.current.fullStateHash);

      // A semantic no-op does not weaken current-state freshness. Author and
      // apply a transient edit then its inverse: visible structure returns to
      // base, but Yjs state-vector/full-state proof changes.
      const drift = reopen(baseUpdate);
      try {
        const addTransient = authorEdit(encode(drift), 'USD.', 'USD.x', representation);
        Y.applyUpdate(drift, addTransient.cumulativeCandidate);
        const removeTransient = authorEdit(encode(drift), 'USD.x', 'USD.', representation);
        Y.applyUpdate(drift, removeTransient.cumulativeCandidate);
        const driftUpdate = encode(drift);
        const driftProof = proposalYjsCurrentProof({ update: driftUpdate, representation, revisionId: 'revision-current' });
        assert.equal(driftProof.contentHash, composition.current.contentHash);
        assert.equal(driftProof.structureHash, composition.current.structureHash);
        assert.notEqual(driftProof.fullStateHash, composition.current.fullStateHash);
        const staleCurrentService = createProposalReviewCompareService({
          evaluateSelection: async () => result,
          loadEvaluation: async () => ({
            evaluation: result.evaluation!, selectionHash: result.selectionHash!, selectedProposalIds: result.selectedProposalIds,
            graphRevision: result.graphRevision!, currentGraphRevision: result.graphRevision!, candidateContent: result.candidateContent,
            status: result.status, nullEffectProven: hasProposalNullEffectProof(result.status, result.current, result.candidateProof),
          }),
          loadCurrent: async () => ({ content: composition.content, proof: driftProof }),
        });
        const stale = await staleCurrentService.compare({ selectedProposalIds: ['child'], binding: compared.binding! });
        assert.equal(stale.diagnosis.availability, 'unavailable');
        assert.equal(stale.diagnosis.reasonCode, Codes.currentChanged);
      } finally {
        drift.destroy();
      }
    });
  }
});

test('null-effect proof is status-specific and requires matching content and stable structure', () => {
  const { composition } = emptyChain('plain_text');
  const { current, candidate } = composition;
  assert.equal(hasProposalNullEffectProof('satisfied_elsewhere', current, candidate), false,
    'satisfied_elsewhere requires exact full Yjs equality');
  assert.equal(hasProposalNullEffectProof('clean', current, current), false,
    'a clean candidate is not a null-effect status');
  assert.equal(hasProposalNullEffectProof('empty_effect', null, candidate), false);
  assert.equal(hasProposalNullEffectProof('empty_effect', current, null), false);
  assert.equal(hasProposalNullEffectProof('empty_effect', current, { ...candidate, contentHash: digest('different content') }), false);
  assert.equal(hasProposalNullEffectProof('empty_effect', current, { ...candidate, structureHash: digest('different structure') }), false);
});

test('equal Markdown with newly authored block identities is not a proven null effect', () => {
  const first = createRichMarkdownYDoc('Same paragraph.', 'tiptap_blocks');
  const second = createRichMarkdownYDoc('Same paragraph.', 'tiptap_blocks');
  try {
    const firstUpdate = encode(first);
    const secondUpdate = encode(second);
    const firstProof = proposalYjsCurrentProof({ update: firstUpdate, representation: 'tiptap_blocks', revisionId: 'revision-current' });
    const secondProof = proposalYjsCurrentProof({ update: secondUpdate, representation: 'tiptap_blocks', revisionId: null });
    assert.equal(firstProof.contentHash, secondProof.contentHash);
    assert.notEqual(firstProof.structureHash, secondProof.structureHash,
      'new rich-block identities must remain visible in the semantic structure proof');
    assert.equal(hasProposalNullEffectProof('empty_effect', firstProof, secondProof), false);
    assert.equal(hasProposalNullEffectProof('satisfied_elsewhere', firstProof, secondProof), false);
  } finally {
    first.destroy();
    second.destroy();
  }
});
