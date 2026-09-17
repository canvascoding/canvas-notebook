import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import {
  ProposalGraphContractError, type ProposalSourceProofV1,
} from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import {
  parseOptionalProposalToolEditV1, parseProposalToolCreationResultV1,
  parseProposalToolEditV1, parseProposalToolReadRequestV1, parseProposalToolReadResultV1,
  type ProposalToolEditV1, type ProposalToolCreationResultV1,
} from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { agentEditFileParameters, formatAgentEditFileValidationError } from '../app/lib/pi/agent-file-tool-schemas';

const hash = (character: string) => character.repeat(64);
const scope = { workspaceId: 'workspace', lineageId: 'lineage', documentId: 'document', lifecycleGeneration: 1, schemaVersion: 1 };
const authoritative: ProposalSourceProofV1 = {
  kind: 'authoritative', scope,
  current: { revisionId: 'revision', contentHash: hash('a'), structureHash: hash('b'), stateVectorHash: hash('c'), deleteSetHash: hash('d'), fullStateHash: hash('e') },
  snapshot: { ref: 'snapshot', sha256: hash('e'), sizeBytes: 100, encoding: 'yjs_full_update_v1' },
  anchorMap: { ref: 'anchor-map', sha256: hash('f'), sizeBytes: 100 },
};
const parent: ProposalSourceProofV1 = {
  ...authoritative, kind: 'proposal', proposalId: 'parent', proposalCasVersion: 2,
  authoredCandidateHash: hash('a'), candidateHash: hash('b'), evaluationId: 'evaluation',
  snapshot: { ...authoritative.snapshot, sha256: hash('b') },
};
const independent = (): ProposalToolEditV1 => ({
  contractVersion: 1, creationKind: 'independent', source: structuredClone(authoritative),
  expectedParentCandidateHash: null, expectedParentCasVersion: null, replaces: null, choice: null,
});
const extension = (): ProposalToolEditV1 => ({
  ...independent(), creationKind: 'extends', source: structuredClone(parent),
  expectedParentCandidateHash: parent.kind === 'proposal' ? parent.candidateHash : '', expectedParentCasVersion: 2,
});
const result = (): ProposalToolCreationResultV1 => ({
  contractVersion: 1, proposalId: 'child', operationId: 'operation', scope: { ...scope },
  creationKind: 'extends', casVersion: 1, candidateHash: hash('c'), source: structuredClone(parent),
  relationships: { dependency: { proposalId: 'parent', candidateHash: hash('a') }, replacesProposalId: null, choiceGroupId: null },
  reviewRequired: true,
});
function rejects(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof ProposalGraphContractError && error.code === code);
}
let count = 0;
function test(name: string, run: () => void): void {
  run(); count++; console.log(`ok ${count} - ${name}`);
}

test('authoritative first read resolves path scope server-side; reread can fence expected scope', () => {
  assert.deepEqual(parseProposalToolReadRequestV1({ contractVersion: 1, proposalId: null }), { contractVersion: 1, proposalId: null });
  assert.deepEqual(parseProposalToolReadRequestV1({ contractVersion: 1, proposalId: 'parent', expectedScope: scope }).expectedScope, scope);
  rejects(() => parseProposalToolReadRequestV1({ contractVersion: 1 }), 'PROPOSAL_INVALID_REQUEST');
  rejects(() => parseProposalToolReadRequestV1({ contractVersion: 1, proposalId: '' }), 'PROPOSAL_INVALID_REQUEST');
  rejects(() => parseProposalToolReadRequestV1({ contractVersion: 1, proposalId: 'latest', snapshot: 'bytes' }), 'PROPOSAL_INVALID_REQUEST');
});
test('read metadata binds complete candidate identities separately from its text hash', () => {
  const value = { contractVersion: 1, source: parent, contentSha256: hash('d'), graphRevision: 3 };
  assert.equal(parseProposalToolReadResultV1(value).contentSha256, hash('d'));
  rejects(() => parseProposalToolReadResultV1({ ...value, source: { ...parent, snapshot: { ...parent.snapshot, sha256: hash('f') } } }), 'PROPOSAL_SOURCE_INVALID');
});
test('only absent proposal preserves the ordinary legacy route', () => {
  assert.equal(parseOptionalProposalToolEditV1({ path: 'notes.md' }), undefined);
  for (const proposal of [undefined, null, false, '', {}, { contractVersion: 1 }]) {
    rejects(() => parseOptionalProposalToolEditV1({ path: 'notes.md', proposal }), 'PROPOSAL_INVALID_REQUEST');
  }
});
test('explicit independent and parent-extension contracts remain distinct', () => {
  assert.equal(parseProposalToolEditV1(independent()).creationKind, 'independent');
  assert.equal(parseProposalToolEditV1(extension()).source.kind, 'proposal');
  rejects(() => parseProposalToolEditV1({ ...extension(), creationKind: 'independent' }), 'PROPOSAL_SOURCE_INVALID');
  rejects(() => parseProposalToolEditV1({ ...independent(), creationKind: 'extends' }), 'PROPOSAL_SOURCE_INVALID');
});
test('stale explicit parent CAS or hash never falls back to independent', () => {
  rejects(() => parseProposalToolEditV1({ ...extension(), expectedParentCasVersion: 1 }), 'PROPOSAL_PARENT_CHANGED');
  rejects(() => parseProposalToolEditV1({ ...extension(), expectedParentCandidateHash: hash('a') }), 'PROPOSAL_PARENT_CHANGED');
  rejects(() => parseProposalToolEditV1({ ...extension(), expectedParentCasVersion: null }), 'PROPOSAL_PARENT_CHANGED');
  rejects(() => parseProposalToolEditV1({ ...independent(), expectedParentCasVersion: 1 }), 'PROPOSAL_SOURCE_INVALID');
});
test('rebased effective candidate requires an evaluation and exact source snapshot', () => {
  const request = extension();
  assert.equal(parseProposalToolEditV1(request).source.kind, 'proposal');
  rejects(() => parseProposalToolEditV1({ ...request, source: { ...request.source, evaluationId: null } }), 'PROPOSAL_SOURCE_INVALID');
  rejects(() => parseProposalToolEditV1({ ...request, source: { ...request.source, snapshot: { ...request.source.snapshot, sha256: hash('a') } } }), 'PROPOSAL_SOURCE_INVALID');
});
test('replacement retains shared parent and independent alternative relationship', () => {
  const request: ProposalToolEditV1 = { ...extension(), creationKind: 'replacement',
    replaces: { proposalId: 'old-child', expectedCasVersion: 4, expectedCandidateHash: hash('c') },
    choice: { kind: 'existing', groupId: 'choice', expectedGroupRevision: 2 } };
  assert.deepEqual(parseProposalToolEditV1(request), request);
  assert.equal(parseProposalToolEditV1({ ...request, ...independent(), creationKind: 'replacement', replaces: request.replaces }).source.kind, 'authoritative');
  rejects(() => parseProposalToolEditV1({ ...request, replaces: { ...request.replaces!, proposalId: 'parent' } }), 'PROPOSAL_SOURCE_INVALID');
  rejects(() => parseProposalToolEditV1({ ...request, replaces: null }), 'PROPOSAL_SOURCE_INVALID');
  rejects(() => parseProposalToolEditV1({ ...request, creationKind: 'extends' }), 'PROPOSAL_SOURCE_INVALID');
});
test('choice can join existing group or explicitly identify a competing same-basis proposal', () => {
  for (const choice of [
    { kind: 'existing' as const, groupId: 'choice', expectedGroupRevision: 0 },
    { kind: 'alternative_to' as const, proposalId: 'other-child', expectedCasVersion: 1, expectedCandidateHash: hash('f') },
  ]) assert.deepEqual(parseProposalToolEditV1({ ...extension(), choice }).choice, choice);
  rejects(() => parseProposalToolEditV1({ ...extension(), choice: { kind: 'alternative_to', proposalId: 'parent', expectedCasVersion: 2, expectedCandidateHash: hash('b') } }), 'PROPOSAL_SOURCE_INVALID');
});
test('contracts reject raw updates, weakened review policy, unknown versions and unsafe counters', () => {
  for (const field of ['deltaBase64', 'yjsUpdate', 'reviewRequired', 'allowDirect']) {
    rejects(() => parseProposalToolEditV1({ ...independent(), [field]: false }), 'PROPOSAL_INVALID_REQUEST');
  }
  rejects(() => parseProposalToolEditV1({ ...independent(), contractVersion: 2 }), 'PROPOSAL_UNSUPPORTED_VERSION');
  rejects(() => parseProposalToolEditV1({ ...extension(), expectedParentCasVersion: Number.MAX_SAFE_INTEGER + 1 }), 'PROPOSAL_INVALID_REQUEST');
  rejects(() => parseProposalToolEditV1({ ...extension(), source: { ...parent, deltaBase64: 'AA==' } }), 'PROPOSAL_INVALID_REQUEST');
});
test('creation result exposes authored base while candidate identifies the new proposal', () => {
  const value = parseProposalToolCreationResultV1(result());
  assert.equal(value.proposalId, 'child');
  assert.equal(value.source.kind === 'proposal' && value.source.proposalId, 'parent');
  assert.notEqual(value.candidateHash, value.source.snapshot.sha256);
  assert.equal(value.reviewRequired, true);
});
test('creation result rejects self dependency, forged scope and inconsistent relationship hashes', () => {
  rejects(() => parseProposalToolCreationResultV1({ ...result(), proposalId: 'parent' }), 'PROPOSAL_CYCLE');
  rejects(() => parseProposalToolCreationResultV1({ ...result(), scope: { ...scope, workspaceId: 'other' } }), 'PROPOSAL_SCOPE_MISMATCH');
  rejects(() => parseProposalToolCreationResultV1({ ...result(), relationships: { ...result().relationships, dependency: { proposalId: 'parent', candidateHash: hash('b') } } }), 'PROPOSAL_SOURCE_INVALID');
  rejects(() => parseProposalToolCreationResultV1({ ...result(), reviewRequired: false }), 'PROPOSAL_INVALID_REQUEST');
});
test('existing exact/Markdown/structured edit schemas accept optional explicit proposal', () => {
  const variants = [
    { path: 'notes.md', oldText: 'old', newText: 'new' },
    { path: 'notes.md', mode: 'append', content: 'new' },
    { path: 'notes.md', document: { documentId: 'document', lifecycleGeneration: 1, schemaVersion: 1 },
      operations: [{ kind: 'delete_block', blockId: 'block', subtreeHash: hash('a') }] },
  ];
  for (const variant of variants) {
    assert.equal(Value.Check(agentEditFileParameters, variant), true);
    assert.equal(Value.Check(agentEditFileParameters, { ...variant, proposal: extension() }), true);
    assert.equal(Value.Check(agentEditFileParameters, { ...variant, proposal: null }), false);
  }
});
test('validation guidance preserves declared provenance instead of suggesting bypass', () => {
  const message = formatAgentEditFileValidationError({ path: 'notes.md', oldText: 'a', newText: 'b', proposal: null });
  assert.match(message, /proposal.*explicit valid source/u);
  assert.match(message, /do not remove the reference/u);
  assert.match(formatAgentEditFileValidationError({ path: 'notes.md', unexpected: true }), /not an allowed field/u);
});
console.log(`Proposal tool contracts: ${count} groups passed.`);
