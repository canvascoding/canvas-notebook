import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { compileWorkspaceNativeMixedBatch, type NativeMixedBatchRequest } from '../app/lib/markdown/workspace-native-mixed-batch-compiler';
import type { NativeNamespaceEntry, NativeWorkspaceLinkSnapshot } from '../app/lib/markdown/workspace-link-contract-v2';

const workspaceId = 'mixed-workspace';
function native(markdown: string, filePath: string, representation: PersistedCollaborationState['representation'] = 'tiptap_blocks',
  workspace = workspaceId, mutate?: (doc: Y.Doc) => void): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(markdown) : createRichMarkdownYDoc(markdown, representation);
  try {
    mutate?.(doc);
    return { documentId: `document:${workspace}:${filePath}`, workspaceId: workspace, organizationId: null, path: filePath,
      lifecycleGeneration: 1, representation, schemaVersion: 1, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
      documentSequence: 7, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null,
      serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
  } finally { doc.destroy(); }
}
function snapshot(states: PersistedCollaborationState[], extra: Array<{ path: string; kind?: NativeNamespaceEntry['kind'] }> = [],
  workspace = workspaceId): NativeWorkspaceLinkSnapshot {
  const documents = states.filter((state) => state.workspaceId === workspace).map(inspectPersistedDocumentLinks);
  const namespace: NativeNamespaceEntry[] = documents.map(({ document }) => ({ workspaceId: workspace, path: document.path, kind: 'file',
    identity: `native:${document.documentId}:${document.lifecycleGeneration}`, documentId: document.documentId,
    lifecycleGeneration: document.lifecycleGeneration, filesystemIdentity: null }));
  for (const entry of extra) namespace.push({ workspaceId: workspace, path: entry.path, kind: entry.kind ?? 'directory',
    identity: `physical:${workspace}:${entry.path}`, documentId: null, lifecycleGeneration: null, filesystemIdentity: `observed:${entry.path}` });
  const gaps = documents.flatMap((document) => document.coverage.gaps);
  const body = { contractVersion: 2 as const, workspaceId: workspace, namespace, documents, coverage: { complete: !gaps.length, gaps } };
  return { ...body, snapshotProof: nativeLinkJsonProof(body) };
}
function request(kind: NativeMixedBatchRequest['kind'], sourcePath: string, destinationPath?: string,
  destinationWorkspaceId = workspaceId, sourceWorkspaceId = workspaceId): NativeMixedBatchRequest {
  return { kind, sourceWorkspaceId, destinationWorkspaceId, selections: [{ sourcePath, ...(destinationPath ? { destinationPath } : {}) }] };
}
function compile(states: PersistedCollaborationState[], requests: NativeMixedBatchRequest[], extra: Array<{ path: string; kind?: NativeNamespaceEntry['kind'] }> = []) {
  return compileWorkspaceNativeMixedBatch({ states, snapshots: [snapshot(states, extra)], requests });
}

test('ordered rename, move and delete use evolving identity and backlink targets, with a reversible rich chain', () => {
  const states = [native('[**Target**](target.md)\n\nIndependent', 'note.md'), native('# Target', 'target.md')];
  const frozen = structuredClone(states);
  const plan = compile(states, [request('rename', 'target.md', 'new.md'), request('move', 'new.md', 'folder/new.md'), request('delete', 'folder/new.md')], [{ path: 'folder' }]);
  assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues)); assert.equal(plan.executionReady, false);
  assert.equal(plan.steps.length, 3); assert.equal(plan.steps[1].beforeGraphProof, plan.steps[0].afterGraphProof);
  assert.equal(plan.steps[2].beforeGraphProof, plan.steps[1].afterGraphProof);
  assert.deepEqual(plan.steps.map((step) => step.linkIntents[0].expectedValue), ['target.md', 'new.md', 'folder/new.md']);
  assert.deepEqual(plan.steps.map((step) => step.linkIntents[0].nextValue), ['new.md', 'folder/new.md', null]);
  assert.deepEqual(plan.finalNamespace.map((entity) => entity.path).sort(), ['folder', 'note.md']); assert.equal(plan.finalEdges.length, 0);
  assert.deepEqual(states, frozen); assert.equal(plan.planId, compile(states, plan.steps.map((step) => step.request), [{ path: 'folder' }]).planId);
  assert.equal(JSON.stringify(plan).includes('mixed-batch-rehearsal'), false);
});

test('one shared namespace permits vacate then occupy and rejects an original-path request after rename', () => {
  const states = [native('# A', 'a.md'), native('# B', 'b.md')];
  const good = compile(states, [request('rename', 'a.md', 'free.md'), request('rename', 'b.md', 'a.md')]);
  assert.equal(good.readiness, 'ready'); assert.deepEqual(good.finalNamespace.map((entry) => entry.path).sort(), ['a.md', 'free.md']);
  const bad = compile(states, [request('rename', 'a.md', 'free.md'), request('delete', 'a.md')]);
  assert.equal(bad.readiness, 'blocked'); assert(bad.issues.some((issue) => issue.code === 'missing-source' && issue.requestIndex === 1));
});

test('move, copy, then rename a copied target keeps originals and copies distinct without fabricated native IDs', () => {
  const states = [native('[Target](target.md)', 'folder/note.md'), native('# Target', 'folder/target.md')];
  const plan = compile(states, [request('move', 'folder', 'moved'), request('copy', 'moved', 'copied'), request('rename', 'copied/target.md', 'copied/new.md')], [{ path: 'folder' }]);
  assert.equal(plan.readiness, 'requires-clone-rebinding', JSON.stringify(plan.issues)); assert.equal(plan.executionReady, false);
  assert.equal(plan.cloneRequirements.filter((entry) => entry.sourceContentBasisProof !== null).length, 2);
  const copied = plan.finalNamespace.filter((entity) => entity.binding.kind === 'unbound-copy');
  assert(copied.length >= 2); assert(copied.every((entry) => !('documentId' in entry) && !('documentId' in entry.binding)));
  assert(copied.every((entry) => !('stateVector' in entry) && !('documentSequence' in entry)));
  const originalNote = plan.finalNamespace.find((entry) => entry.path === 'moved/note.md')!;
  const copiedNote = plan.finalNamespace.find((entry) => entry.path === 'copied/note.md')!;
  const originalTarget = plan.finalNamespace.find((entry) => entry.path === 'moved/target.md')!;
  const copiedTarget = plan.finalNamespace.find((entry) => entry.path === 'copied/new.md')!;
  assert.equal(plan.finalEdges.find((edge) => edge.sourceEntityKey === originalNote.entityKey)!.resolution.targetEntityKey, originalTarget.entityKey);
  assert.equal(plan.finalEdges.find((edge) => edge.sourceEntityKey === copiedNote.entityKey)!.resolution.targetEntityKey, copiedTarget.entityKey);
  const intent = plan.steps[2].linkIntents[0]; assert.equal(intent.entityKey, copiedNote.entityKey); assert.equal(intent.nextValue, 'new.md');
  assert.equal('reference' in intent, false); assert.equal('sourceVersion' in intent, false);
  assert(plan.cloneRequirements.every((entry) => entry.applicability === 'requires-fresh-clone-receipt-and-inventory'));
});

test('copy observes earlier native unlinks and a copy of a copy retains explicit receipt dependencies', () => {
  const states = [native('[Target](target.md)', 'note.md'), native('# Target', 'target.md')];
  const plan = compile(states, [request('delete', 'target.md'), request('copy', 'note.md', 'copy.md'), request('copy', 'copy.md', 'copy2.md')]);
  assert.equal(plan.readiness, 'requires-clone-rebinding', JSON.stringify(plan.issues)); assert.equal(plan.finalEdges.length, 0);
  assert.equal(plan.cloneRequirements.length, 2);
  assert.equal(plan.cloneRequirements[1].sourceEntityKey, plan.cloneRequirements[0].entityKey);
  assert.deepEqual(plan.cloneRequirements.map((entry) => entry.linkBindings), [[], []]);
  assert.equal(plan.cloneRequirements[0].sourceContentBasisProof, plan.cloneRequirements[1].sourceContentBasisProof);
});

test('alias and basename capture are checked against untouched backlinks after each transition', () => {
  const aliases = [native('[[Shared]]', 'note.md'), native('---\naliases: [Shared]\n---\n\n# Target', 'folder/target.md')];
  const copied = compile(aliases, [request('copy', 'folder', 'copy')], [{ path: 'folder' }]);
  assert.equal(copied.readiness, 'blocked'); assert(copied.issues.some((issue) => issue.code === 'resolution-changed'));
  const states = [native('[[Target]]', 'note.md'), native('# Target', 'one/Target.md'), native('# Another', 'other.md')];
  const capture = compile(states, [request('rename', 'other.md', 'two/Target.md')], [{ path: 'one' }, { path: 'two' }]);
  assert.equal(capture.readiness, 'blocked'); assert(capture.issues.some((issue) => issue.code === 'resolution-changed'));
});

test('frontmatter aliases, display aliases and fragments remain resolved across ordered rich attribute mutations', () => {
  const states = [native('[[Shared#Heading|Visible]]', 'note.md'), native('---\naliases: [Shared]\ntitle: Pinned\n---\n\n# Heading', 'target.md')];
  const plan = compile(states, [request('rename', 'target.md', 'new.md'), request('move', 'new.md', 'folder/new.md')], [{ path: 'folder' }]);
  assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues));
  assert.deepEqual(plan.steps.map((step) => step.linkIntents[0].nextValue), ['/new#Heading|Visible', '/folder/new#Heading|Visible']);
  assert.equal(plan.finalEdges[0].literal, '/folder/new#Heading');
  assert.equal(plan.documentEvidence.find((entry) => entry.inventory.document.path === 'target.md')!.inventory.metadata.title, 'Pinned');
});

test('cross-workspace copying resolves copied targets and refuses coincidental or uncopied targets', () => {
  const states = [native('[Target](target.md)', 'folder/note.md'), native('# Target', 'folder/target.md'), native('# Coincidence', 'target.md', 'tiptap_blocks', 'other')];
  const snapshots = [snapshot(states, [{ path: 'folder' }]), snapshot(states, [], 'other')];
  const good = compileWorkspaceNativeMixedBatch({ states, snapshots, requests: [request('copy', 'folder', 'copied', 'other')] });
  assert.equal(good.readiness, 'requires-clone-rebinding', JSON.stringify(good.issues));
  const bad = compileWorkspaceNativeMixedBatch({ states, snapshots, requests: [request('copy', 'folder/note.md', 'note.md', 'other')] });
  assert.equal(bad.readiness, 'blocked'); assert(bad.issues.some((issue) => issue.code === 'uncopied-cross-workspace-target'));
});

test('real plain UTF-16 edits on distinct targets preserve evolving anchors and detect unsupported chained Undo', () => {
  const states = [native('😀 [First](a.md) and [Second](b.md)\r\n', 'note.md', 'plain_text'), native('# A', 'a.md'), native('# B', 'b.md')];
  const separate = compile(states, [request('rename', 'a.md', 'long%name.md'), request('rename', 'b.md', 'second.md')]);
  assert.equal(separate.readiness, 'ready', JSON.stringify(separate.issues)); assert.equal(separate.finalEdges.length, 2);
  assert(separate.finalEdges.some((edge) => edge.literal === 'long%25name.md'));
  const same = compile(states, [request('rename', 'a.md', 'first.md'), request('rename', 'first.md', 'again.md')]);
  assert.equal(same.readiness, 'blocked'); assert(same.issues.some((issue) => issue.code === 'batch-inverse-unavailable'));
});

test('native unsupported unlink and reference-style inverse are rejected before plan readiness', () => {
  const image = [native('![Only](img.png)', 'note.md')];
  const sole = compile(image, [request('delete', 'img.png')], [{ path: 'img.png', kind: 'file' }]);
  assert.equal(sole.readiness, 'blocked'); assert(sole.issues.some((issue) => issue.code === 'native-adapter-or-inverse-unavailable'));
  const reference = [native('[Label][ref]\n\n[ref]: target.md', 'note.md', 'plain_text'), native('# Target', 'target.md')];
  const ref = compile(reference, [request('delete', 'target.md')]); assert.equal(ref.readiness, 'blocked');
  assert(ref.issues.some((issue) => issue.code === 'unsupported-target-format' || issue.code === 'incomplete-coverage'));
});

test('a valid rich native source with an unstable Markdown export is fully planned without export', () => {
  const state = native('| Keep |\n| --- |\n| [Target](target.md) |\n\nIndependent', 'note.md', 'tiptap_blocks', workspaceId, (doc) => {
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
    for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) (record.get('attributes') as Y.Map<unknown>).set('colwidth', [120]);
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
  });
  const states = [state, native('# Target', 'target.md')];
  const plan = compile(states, [request('rename', 'target.md', 'new.md')]);
  assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues)); assert.equal(plan.steps[0].linkIntents.length, 1);
  assert.equal(plan.documentEvidence[0].inventory.version.documentSequence, 7);
});

test('missing, stale, duplicate, orphan and unknown native evidence never produce readiness', () => {
  const states = [native('[Target](target.md)', 'note.md'), native('# Target', 'target.md')]; const snapshots = [snapshot(states)];
  const missing = compileWorkspaceNativeMixedBatch({ snapshots, states: states.slice(1), requests: [request('delete', 'target.md')] });
  assert(missing.issues.some((issue) => issue.code === 'missing-native-state'));
  const stale = compileWorkspaceNativeMixedBatch({ snapshots, states: [{ ...states[0], documentSequence: 8 }, states[1]], requests: [request('delete', 'target.md')] });
  assert(stale.issues.some((issue) => issue.code === 'native-state-mismatch'));
  const duplicate = compileWorkspaceNativeMixedBatch({ snapshots, states: [...states, states[0]], requests: [request('delete', 'target.md')] });
  assert(duplicate.issues.some((issue) => issue.code === 'duplicate-native-state'));
  const pristine = compile([], [request('delete', 'pristine.md')], [{ path: 'pristine.md', kind: 'file' }]);
  assert(pristine.issues.some((issue) => issue.code === 'uninspected-source'));
  const mdx = compile([], [request('delete', 'source.mdx')], [{ path: 'source.mdx', kind: 'file' }]);
  assert(mdx.issues.some((issue) => issue.code === 'unsupported-source'));
  const unknown = native('Text', 'unknown.md', 'tiptap_blocks', workspaceId, (doc) => doc.getMap('unrecognized').set('href', 'target.md'));
  const unknownPlan = compile([unknown], [request('delete', 'unknown.md')]);
  assert.equal(unknownPlan.readiness, 'blocked'); assert(unknownPlan.issues.some((issue) => issue.code === 'incomplete-coverage'));
  for (const plan of [missing, stale, duplicate, pristine, mdx, unknownPlan]) { assert.equal(plan.readiness, 'blocked'); assert.equal(plan.executionReady, false); assert.equal(plan.steps.length, 0); }
});

test('each intermediate transition must be safe even if a later request would remove the conflict', () => {
  const states = [native('[[Target]]', 'note.md'), native('# Target', 'one/Target.md'), native('# B', 'b.md')];
  const plan = compile(states, [request('rename', 'b.md', 'two/Target.md'), request('delete', 'two/Target.md')], [{ path: 'one' }, { path: 'two' }]);
  assert.equal(plan.readiness, 'blocked'); assert(plan.issues.some((issue) => issue.requestIndex === 0 && issue.code === 'resolution-changed'));
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.finalGraphProof, null); assert.deepEqual(plan.finalNamespace, []); assert.deepEqual(plan.finalEdges, []);
});

test('virtual metadata updates filename titles and preserves explicit frontmatter titles after rename', () => {
  const states = [native('Body without a heading', 'old.md'), native('---\ntitle: Explicit\n---\n\nBody', 'pinned.md')];
  const plan = compile(states, [request('rename', 'old.md', 'new.md'), request('rename', 'pinned.md', 'renamed.md')]);
  assert.equal(plan.readiness, 'ready');
  assert.equal(plan.finalNamespace.find((entry) => entry.path === 'new.md')!.metadata!.title, 'new');
  assert.equal(plan.finalNamespace.find((entry) => entry.path === 'renamed.md')!.metadata!.title, 'Explicit');
});

test('XML rich atom adapters are rehearsed natively, and unknown HTML sources remain explicit gaps', () => {
  const states = [native('[[target#Heading|Alias]]', 'note.md', 'tiptap_xml'), native('# Heading', 'target.md', 'tiptap_xml')];
  const plan = compile(states, [request('rename', 'target.md', 'new.md'), request('rename', 'new.md', 'again.md')]);
  assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues));
  assert.equal(plan.steps[0].linkIntents[0].nextValue, '/new#Heading|Alias'); assert.equal(plan.finalEdges.length, 1);
  const removedAtom = compile(states, [request('rename', 'target.md', 'new.md'), request('delete', 'new.md')]);
  assert.equal(removedAtom.readiness, 'blocked'); assert(removedAtom.issues.some((issue) => issue.code === 'batch-inverse-unavailable'));
  const html = compile([], [request('delete', 'target.md')], [{ path: 'page.html', kind: 'file' }, { path: 'target.md', kind: 'file' }]);
  assert.equal(html.readiness, 'blocked'); assert(html.issues.some((issue) => issue.code === 'uninspected-html'));
});

test('a blocked plan still binds every ordered request, including an unvisited tail', () => {
  const states = [native('# A', 'a.md')];
  const first = compile(states, [request('delete', 'missing.md'), request('delete', 'a.md')]);
  const second = compile(states, [request('delete', 'missing.md'), request('rename', 'a.md', 'new.md')]);
  assert.equal(first.readiness, 'blocked'); assert.notEqual(first.planId, second.planId); assert.equal(first.requests.length, 2);
});

test('registry-only file evidence has no invented filesystem proof and invalid Unicode destinations block cleanly', () => {
  const states = [native('# Native without projection', 'native.md')];
  const good = compile(states, [request('rename', 'native.md', 'renamed.md')]);
  const binding = good.finalNamespace[0].binding;
  assert.equal(binding.kind, 'existing');
  if (binding.kind === 'existing') {
    assert.equal(binding.namespaceEvidence.filesystemIdentity, null);
    assert.equal(binding.namespaceEvidence.documentId, states[0].documentId);
    assert.equal(binding.namespaceEvidence.lifecycleGeneration, 1);
    assert.equal('sha256' in binding.namespaceEvidence, false); assert.equal('inode' in binding.namespaceEvidence, false);
  }
  assert.equal(good.executionReady, false);
  const invalid = compile(states, [request('rename', 'native.md', 'invalid\ud800.md')]);
  assert.equal(invalid.readiness, 'blocked'); assert(invalid.issues.some((issue) => issue.code === 'invalid-path'));
  const badSnapshot = snapshot([]); badSnapshot.namespace.push({ workspaceId, path: '/invalid.png', kind: 'file',
    identity: 'invalid', documentId: null, lifecycleGeneration: null, filesystemIdentity: null });
  const { snapshotProof: _before, ...body } = badSnapshot; badSnapshot.snapshotProof = nativeLinkJsonProof(body);
  const badInitial = compileWorkspaceNativeMixedBatch({ snapshots: [badSnapshot], states: [], requests: [request('delete', '/invalid.png')] });
  assert.equal(badInitial.readiness, 'blocked'); assert(badInitial.issues.some((issue) => issue.code === 'identity-conflict'));
});

test('a large physical target namespace preserves native backlink resolution and file-parent conflicts remain blocking', () => {
  const states = [native('[Asset](asset-2499.png)', 'note.md')];
  const extra = Array.from({ length: 2500 }, (_, index) => ({ path: `asset-${index}.png`, kind: 'file' as const }));
  const plan = compile(states, [request('rename', 'asset-2499.png', 'renamed.png')], extra);
  assert.equal(plan.readiness, 'ready', JSON.stringify(plan.issues)); assert.equal(plan.finalNamespace.length, 2501);
  assert.equal(plan.finalEdges[0].literal, 'renamed.png');
  const conflict = compile(states, [request('rename', 'asset-2499.png', 'note.md/renamed.png')], extra);
  assert.equal(conflict.readiness, 'blocked'); assert(conflict.issues.some((issue) => issue.code === 'destination-parent-is-file'));
});
