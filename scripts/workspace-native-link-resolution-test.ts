import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { COLLABORATION_SCHEMA_VERSION } from '../app/lib/collaboration/types';
import { Y } from '../app/lib/collaboration/server-runtime';
import { getCanvasNotebookExactLinkTarget, getCanvasNotebookMarkdownLinkTarget, resolveObsidianWikiLink } from '../app/lib/markdown/obsidian-link-resolver';
import { resolveWorkspaceWikiFileLink } from '../app/lib/markdown/workspace-link-index-core';
import { parseWorkspaceLocalLinks, parseWorkspaceMarkdownHref } from '../app/lib/markdown/workspace-local-link-parser';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { buildWorkspaceNativeLinkGraph } from '../app/lib/markdown/workspace-native-link-graph';
import { createWorkspaceNativeFileOperationPlan } from '../app/lib/markdown/workspace-native-file-operation-planner';
import { compileWorkspaceNativeMixedBatch } from '../app/lib/markdown/workspace-native-mixed-batch-compiler';
import { inspectOriginalPhysicalLinks, originalPhysicalSourceProof, previewStagedWorkspaceLinkEffects, workspaceSourceAuthorityStageProof,
  type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { NativeWorkspaceLinkSnapshot } from '../app/lib/markdown/workspace-link-contract-v2';

const workspaceId = 'native-resolution';
const representations = ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const;
function state(text: string, filePath: string, representation: PersistedCollaborationState['representation'] = 'tiptap_blocks'): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try {
    return { documentId: `document:${filePath}`, workspaceId, organizationId: null, path: filePath, representation,
      lifecycleGeneration: 1, schemaVersion: COLLABORATION_SCHEMA_VERSION, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
      documentSequence: 2, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null,
      serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
  } finally { doc.destroy(); }
}
function snapshot(states: PersistedCollaborationState[]): NativeWorkspaceLinkSnapshot {
  const documents = states.map(inspectPersistedDocumentLinks);
  const body = { contractVersion: 2 as const, workspaceId, documents, namespace: documents.map(({ document }) => ({
    workspaceId, path: document.path, kind: 'file' as const, identity: `native:${document.documentId}:${document.lifecycleGeneration}`,
    documentId: document.documentId, lifecycleGeneration: document.lifecycleGeneration, filesystemIdentity: null })),
  coverage: { complete: documents.every(document => document.coverage.complete), gaps: documents.flatMap(document => document.coverage.gaps) } };
  return { ...body, snapshotProof: nativeLinkJsonProof(body) };
}
function deletion(states: PersistedCollaborationState[], sourcePath: string) {
  return compileWorkspaceNativeMixedBatch({ states, snapshots: [snapshot(states)], requests: [{ kind: 'delete',
    sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId, selections: [{ sourcePath }] }] });
}
function stage(states: PersistedCollaborationState[], physicalText: string): WorkspaceSourceAuthorityStage {
  const native = snapshot(states);
  const physical = inspectOriginalPhysicalLinks({ workspaceId, organizationId: null, path: 'physical.md',
    authority: { kind: 'unregistered', catalogueProof: '0'.repeat(64) }, bytes: Buffer.from(physicalText), filesystemIdentity: 'physical-fixture' });
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId, organizationId: null,
    catalogueProof: '0'.repeat(64), namespace: [...native.namespace, { workspaceId, path: physical.path, kind: 'file',
      identity: physical.physical.filesystemIdentity, documentId: null, lifecycleGeneration: null, filesystemIdentity: physical.physical.filesystemIdentity }],
    sources: [...native.documents.map(inventory => ({ kind: 'native' as const, inventory })), { kind: 'physical', inventory: physical }],
    scope: { kind: 'visible-workspace', excludedPaths: [] }, coverage: { complete: native.coverage.complete && physical.coverage.complete,
      gaps: [...native.coverage.gaps, ...physical.coverage.gaps] }, readiness: 'requires-import-and-rebinding', executionReady: false };
  return { ...body, stageProof: workspaceSourceAuthorityStageProof(body) };
}

test('legacy Markdown eligibility stays unchanged; only explicit native inventory paths add .bin/.docx alias targets', () => {
  const candidates = [{ path: 'native.bin', extension: 'bin', type: 'file' as const, aliases: ['Shared'] },
    { path: 'native.docx', extension: 'docx', type: 'file' as const, aliases: ['Office'] },
    { path: 'legacy.md', extension: 'md', type: 'file' as const, aliases: ['Markdown'] }];
  assert.equal(resolveObsidianWikiLink('Shared', candidates)?.status, 'missing');
  assert.equal(resolveObsidianWikiLink('Office', candidates)?.status, 'missing');
  assert.equal(resolveObsidianWikiLink('Markdown', candidates)?.path, 'legacy.md');
  const options = { nativeTargetPaths: new Set(['native.bin', 'native.docx']) };
  assert.equal(resolveObsidianWikiLink('Shared', candidates, 'source.md', options)?.path, 'native.bin');
  assert.equal(resolveObsidianWikiLink('Office', candidates, 'source.md', options)?.path, 'native.docx');
  assert.equal(resolveObsidianWikiLink('Shared', candidates, 'source.md', { nativeTargetPaths: new Set() })?.status, 'missing');
});

test('native alias ambiguity includes both true native targets and the unchanged Markdown candidates', () => {
  const candidates = ['one.bin', 'two.docx', 'legacy.md'].map(filePath => ({ path: filePath, type: 'file' as const,
    extension: filePath.split('.').at(-1), aliases: ['Shared'] }));
  assert.deepEqual(resolveObsidianWikiLink('Shared', candidates)?.candidates, ['legacy.md']);
  assert.deepEqual(resolveObsidianWikiLink('Shared', candidates, null, { nativeTargetPaths: new Set(['one.bin', 'two.docx']) })?.candidates,
    ['legacy.md', 'one.bin', 'two.docx']);
});

test('explicit native non-Markdown paths retain literal precedence over inferred Markdown variants', () => {
  const candidates = ['target.bin', 'target.bin.md'].map(filePath => ({ path: filePath, type: 'file' as const, extension: filePath.split('.').at(-1) }));
  for (const options of [undefined, { nativeTargetPaths: new Set(candidates.map(candidate => candidate.path)) }]) {
    assert.equal(resolveWorkspaceWikiFileLink({ targetLiteral: 'target.bin', targetPathText: 'target.bin' }, 'source.md',
      new Set(candidates.map(candidate => candidate.path)), candidates, options).path, 'target.bin');
  }
  const physicalOnly = [candidates[1]];
  assert.equal(resolveWorkspaceWikiFileLink({ targetLiteral: 'target.bin', targetPathText: 'target.bin' }, 'source.md',
    new Set(['target.bin.md']), physicalOnly, { nativeTargetPaths: new Set() }).status, 'missing');
});

const encoded = [
  ['%20note.md', ' note.md', null], ['note.md%20', 'note.md ', null], ['A+B.md', 'A B.md', null], ['A%2BB.md', 'A+B.md', null],
  ['A%2520B.md', 'A%20B.md', null], ['hash%23name.md#Part%2520', 'hash#name.md', 'Part%20'],
  ['hash%2523name.md#Part%23x', 'hash%23name.md', 'Part#x'], ['%20note.md%20#Part+Name', ' note.md ', 'Part+Name'],
] as const;
test('exact Canvas query paths and fragments are decoded once and kept separate', () => {
  for (const [query, filePath, fragment] of encoded) {
    assert.deepEqual(getCanvasNotebookExactLinkTarget(`/notebook?path=${query}`), { path: filePath, fragment });
  }
  assert.deepEqual(getCanvasNotebookExactLinkTarget('/notebook?path=%20'), { path: ' ', fragment: null });
  assert.equal(getCanvasNotebookExactLinkTarget('/other?path=target.md'), null);
});

test('legacy Canvas string helper and default Markdown parser retain their historical trim and decode behavior', () => {
  assert.equal(getCanvasNotebookMarkdownLinkTarget('/notebook?path=%20note.md%20'), 'note.md');
  assert.equal(getCanvasNotebookMarkdownLinkTarget('/notebook?path=A%2520B.md'), 'A B.md');
  assert.equal(getCanvasNotebookMarkdownLinkTarget('/notebook?path=hash%23name.md#Part%2520'), 'hash#name.md#Part ');
  const text = '[x](/notebook?path=%20note.md%20)';
  assert.equal(parseWorkspaceLocalLinks(text, 'source.md').links[0].targetPathText, '/note.md');
  assert.deepEqual(parseWorkspaceMarkdownHref('/notebook?path=%20note.md%20'), { path: '/note.md', fragment: null });
  assert.equal(parseWorkspaceLocalLinks(text, 'source.md', { notebookPaths: 'exact' }).links[0].targetPathText, '/ note.md ');
});

test('all real native representations retain exact Canvas targets including literal encoded hash and percent names', () => {
  for (const representation of representations) for (const [query, filePath, fragment] of encoded) {
    const inventory = inspectPersistedDocumentLinks(state(`[x](/notebook?path=${query})`, 'source.md', representation));
    assert.equal(inventory.coverage.complete, true, JSON.stringify(inventory.coverage)); assert.equal(inventory.links.length, 1);
    assert.equal(inventory.links[0].targetPathText, `/${filePath}`); assert.equal(inventory.links[0].fragment, fragment);
  }
});

test('native graph and both planners detect actual .bin/.docx alias backlinks rather than an empty complete graph', () => {
  for (const representation of representations) for (const targetPath of ['target.bin', 'target.docx']) {
    const states = [state('[[Shared]]', 'source.md', representation), state('---\naliases: [Shared]\n---\n\nNative target', targetPath, representation)];
    const snap = snapshot(states), graph = buildWorkspaceNativeLinkGraph(snap);
    assert.equal(graph.coverage.complete, true); assert.equal(graph.edges[0].resolution.target?.path, targetPath);
    const single = createWorkspaceNativeFileOperationPlan({ kind: 'delete', sourceWorkspaceId: workspaceId,
      destinationWorkspaceId: workspaceId, selections: [{ sourcePath: targetPath }], snapshots: [snap] });
    assert.equal(single.readiness, 'ready', JSON.stringify(single.issues)); assert.equal(single.mutations.length, 1);
    assert.equal(single.mutations[0].action, 'unlink');
    const mixed = deletion(states, targetPath);
    assert.equal(mixed.readiness, 'ready', JSON.stringify(mixed.issues)); assert.equal(mixed.steps[0].linkIntents.length, 1);
    assert.equal(mixed.steps[0].linkIntents[0].action, 'unlink'); assert.equal(mixed.finalEdges.length, 0); assert.equal(mixed.executionReady, false);
  }
});

test('duplicated native aliases remain ambiguous and block deleting an affected candidate', () => {
  const states = [state('[[Shared]]', 'source.md'), state('---\naliases: [Shared]\n---\n\nOne', 'one.bin'),
    state('---\naliases: [Shared]\n---\n\nTwo', 'two.docx')];
  const graph = buildWorkspaceNativeLinkGraph(snapshot(states));
  assert.equal(graph.edges[0].resolution.status, 'ambiguous'); assert.deepEqual(graph.edges[0].resolution.candidates.map(candidate => candidate.path), ['one.bin', 'two.docx']);
  assert.equal(deletion(states, 'one.bin').readiness, 'blocked');
});

test('native Canvas backlinks distinguish the exact whitespace/hash/percent target from its real neighbor when deleting', () => {
  for (const representation of representations) for (const [query, filePath] of encoded) {
    const neighbor = filePath.trim().replace(/%20/gu, ' ').replace(/%23/gu, '#');
    const states = [state(`[x](/notebook?path=${query})`, 'source.md', representation), state('Target', filePath, representation)];
    if (neighbor !== filePath) states.push(state('Neighbor', neighbor, representation));
    const graph = buildWorkspaceNativeLinkGraph(snapshot(states));
    assert.equal(graph.edges[0].resolution.target?.path, filePath);
    const compiled = deletion(states, filePath);
    assert.equal(compiled.readiness, 'ready', JSON.stringify(compiled.issues)); assert.equal(compiled.steps[0].linkIntents.length, 1);
    if (neighbor !== filePath) {
      assert.equal(compiled.finalNamespace.some(entry => entry.path === neighbor), true);
      assert.equal(deletion(states, neighbor).steps[0].linkIntents.length, 0);
    }
  }
});

test('combined physical/native preview uses native aliases and exact physical Canvas spans in one namespace', () => {
  const states = [state('---\naliases: [Shared]\n---\n\nNative', 'target.bin'), state('Target', ' note.md'), state('Neighbor', 'note.md')];
  const staged = stage(states, '[[Shared]] [exact](/notebook?path=%20note.md)');
  const alias = previewStagedWorkspaceLinkEffects(staged, { kind: 'delete', sourcePath: 'target.bin' });
  assert.equal(alias.coverage.complete, true, JSON.stringify(alias.coverage)); assert.equal(alias.effects.length, 1);
  assert.equal(alias.effects[0].sourceEvidence.kind, 'physical'); assert.equal(alias.effects[0].targetPath, 'target.bin');
  const exact = previewStagedWorkspaceLinkEffects(staged, { kind: 'delete', sourcePath: ' note.md' });
  assert.equal(exact.coverage.complete, true); assert.equal(exact.effects.length, 1); assert.equal(exact.effects[0].targetPath, ' note.md');
  assert.equal(previewStagedWorkspaceLinkEffects(staged, { kind: 'delete', sourcePath: 'note.md' }).effects.length, 0);
  assert.equal(exact.executionReady, false);
});

test('combined preview blocks duplicate native aliases and retains exact encoded hash/percent physical paths', () => {
  const ambiguous = stage([state('---\naliases: [Shared]\n---\nOne', 'one.bin'), state('---\naliases: [Shared]\n---\nTwo', 'two.docx')], '[[Shared]]');
  const blocked = previewStagedWorkspaceLinkEffects(ambiguous, { kind: 'delete', sourcePath: 'one.bin' });
  assert.equal(blocked.readiness, 'blocked'); assert.equal(blocked.coverage.complete, false);
  for (const [query, filePath] of encoded) {
    const staged = stage([state('Native target', filePath)], `[x](/notebook?path=${query})`);
    const preview = previewStagedWorkspaceLinkEffects(staged, { kind: 'delete', sourcePath: filePath });
    assert.equal(preview.coverage.complete, true, JSON.stringify(preview.coverage)); assert.equal(preview.effects.length, 1);
    assert.equal(preview.effects[0].targetPath, filePath);
  }
});

test('historical native parser1 facts remain unchanged but fresh graph/planner/compiler reject them as stale', () => {
  const states = [state('[[Shared]]', 'source.md'), state('---\naliases: [Shared]\n---\nTarget', 'target.bin')];
  const historical = snapshot(states);
  historical.documents = historical.documents.map(inventory => ({ ...inventory, parserVersion: 1 }));
  const { snapshotProof: _proof, ...body } = historical; historical.snapshotProof = nativeLinkJsonProof(body);
  const frozen = JSON.stringify(historical), graph = buildWorkspaceNativeLinkGraph(historical);
  assert.equal(graph.coverage.complete, false); assert(graph.coverage.gaps.some(gap => gap.attribute === 'parserVersion'));
  const plan = createWorkspaceNativeFileOperationPlan({ kind: 'delete', sourceWorkspaceId: workspaceId,
    destinationWorkspaceId: workspaceId, selections: [{ sourcePath: 'target.bin' }], snapshots: [historical] });
  assert.equal(plan.readiness, 'blocked'); assert(plan.issues.some(issue => issue.code === 'stale-source-parser'));
  const mixed = compileWorkspaceNativeMixedBatch({ states, snapshots: [historical], requests: [{ kind: 'delete',
    sourceWorkspaceId: workspaceId, destinationWorkspaceId: workspaceId, selections: [{ sourcePath: 'target.bin' }] }] });
  assert.equal(mixed.readiness, 'blocked'); assert(mixed.issues.some(issue => issue.code === 'native-state-mismatch'));
  assert.equal(JSON.stringify(historical), frozen); assert(states.every(source => inspectPersistedDocumentLinks(source).parserVersion === 2));
});

test('historical physical proofs retain the legacy parser contract without granting execution authority', () => {
  const historical = stage([state('Target', 'target.bin')], '[[target.bin]]');
  const physical = historical.sources.find(source => source.kind === 'physical')!;
  assert.equal(physical.kind, 'physical'); if (physical.kind !== 'physical') assert.fail('physical inventory expected');
  assert.equal(physical.inventory.physicalSourceVersion, 1); assert.equal(physical.inventory.parserVersion, 2);
  delete physical.inventory.parserVersion;
  physical.inventory.physicalSourceProof = originalPhysicalSourceProof(physical.inventory);
  historical.stageProof = workspaceSourceAuthorityStageProof(historical);
  const proof = physical.inventory.physicalSourceProof, stageProof = historical.stageProof;
  assert.equal(originalPhysicalSourceProof(physical.inventory), proof);
  const preview = previewStagedWorkspaceLinkEffects(historical, { kind: 'delete', sourcePath: 'target.bin' });
  // Parser-3 support explicitly retained omitted historical parser-2 tags.
  // Their verified preview still requires fresh import/rebinding before write.
  assert.equal(preview.coverage.complete, true); assert.equal(preview.readiness, 'requires-import-and-rebinding');
  assert.equal(preview.executionReady, false); assert.equal(preview.effects.length, 1);
  assert.equal(preview.effects[0].sourceEvidence.kind, 'physical');
  for (const parserVersion of [1, 4, null] as const) {
    const unsupported = structuredClone(historical), source = unsupported.sources.find(source => source.kind === 'physical')!;
    assert.equal(source.kind, 'physical'); if (source.kind !== 'physical') assert.fail('physical source expected');
    assert.equal(Reflect.set(source.inventory, 'parserVersion', parserVersion), true);
    source.inventory.physicalSourceProof = originalPhysicalSourceProof(source.inventory);
    unsupported.stageProof = workspaceSourceAuthorityStageProof(unsupported);
    const blocked = previewStagedWorkspaceLinkEffects(unsupported, { kind: 'delete', sourcePath: 'target.bin' });
    assert.equal(blocked.coverage.complete, false); assert.equal(blocked.readiness, 'blocked');
    assert.equal(blocked.executionReady, false);
    assert(blocked.coverage.gaps.some(gap => gap.code === 'stale-source-parser'));
  }
  assert.equal(physical.inventory.parserVersion, undefined); assert.equal(physical.inventory.physicalSourceProof, proof); assert.equal(historical.stageProof, stageProof);
});
