import assert from 'node:assert/strict';
import test from 'node:test';
import * as Y from 'yjs';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { cloneNativeCollaborationDocument } from '../app/lib/collaboration/native-document-recovery';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { NativeNamespaceEntry, NativeWorkspaceLinkSnapshot } from '../app/lib/markdown/workspace-link-contract-v2';
import { prepareNativeCopyLinkUpdates } from '../app/lib/markdown/workspace-native-copy-link-updates';
import { createWorkspaceNativeFileOperationPlan } from '../app/lib/markdown/workspace-native-file-operation-planner';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { compileWorkspaceNativeMixedBatch } from '../app/lib/markdown/workspace-native-mixed-batch-compiler';
import { assertNativeCopyFinalGraph, NativeCopyFinalGraphError } from '../app/lib/files/workspace-operation-native-copy-graph';

// Real Yjs cloning, planner, compiler and mutation adapters. Namespace/FS facts
// here are declared observations, not actual FD receipts, authority or COMMIT.
type Input = Parameters<typeof assertNativeCopyFinalGraph>[0];
type Representation = PersistedCollaborationState['representation'];
function state(filePath: string, text: string, representation: Representation, workspaceId = 'workspace'): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
  try { return { documentId: `source:${workspaceId}:${filePath}`, workspaceId, organizationId: null, path: filePath, representation,
    lifecycleGeneration: 1, schemaVersion: 1, documentSequence: 7, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null,
    canonicalHash: null, serializedHash: null, newlineStyle: 'crlf', hasBom: true, degraded: false, status: 'active',
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) }; }
  finally { doc.destroy(); }
}
function entry(value: PersistedCollaborationState): NativeNamespaceEntry {
  return { workspaceId: value.workspaceId, path: value.path, kind: 'file', identity: `registry:${value.documentId}:${value.lifecycleGeneration}`,
    documentId: value.documentId, lifecycleGeneration: value.lifecycleGeneration, filesystemIdentity: null };
}
function physical(workspaceId: string, filePath: string, kind: 'file' | 'directory', id: number): NativeNamespaceEntry {
  return { workspaceId, path: filePath, kind, identity: `1:${id}:0:100:100`, documentId: null, lifecycleGeneration: null,
    filesystemIdentity: `1:${id}:0:100:100` };
}
function snapshot(workspaceId: string, states: readonly PersistedCollaborationState[], extras: readonly NativeNamespaceEntry[] = []): NativeWorkspaceLinkSnapshot {
  const documents = states.filter(value => value.workspaceId === workspaceId).map(inspectPersistedDocumentLinks);
  const namespace = [...states.filter(value => value.workspaceId === workspaceId).map(entry), ...extras];
  for (const value of [...namespace]) {
    const parts = value.path.split('/'); parts.pop();
    while (parts.length) {
      const filePath = parts.join('/');
      if (!namespace.some(item => item.path === filePath)) namespace.push({ workspaceId, path: filePath, kind: 'directory',
        identity: `registry-directory:${proof({ workspaceId, path: filePath })}`, documentId: null, lifecycleGeneration: null, filesystemIdentity: null });
      parts.pop();
    }
  }
  const body: Omit<NativeWorkspaceLinkSnapshot, 'snapshotProof'> = { contractVersion: 2, workspaceId, namespace, documents,
    coverage: { complete: true, gaps: [] } };
  return { ...body, snapshotProof: proof(body) };
}
function fixture(representation: Representation = 'tiptap_blocks', cross = false, withAssets = false,
  changeSource?: (source: PersistedCollaborationState) => void,
  options: { destinationPath?: string; noteText?: string } = {}): Input {
  const sourceId = 'workspace', targetId = cross ? 'destination' : sourceId;
  const destinationPath = options.destinationPath ?? 'new/copied';
  const originalStates = [state('folder/note.md', options.noteText ?? '[Target](target.md#Heading) [[target#Heading|Alias]] [Web](https://example.test)\n\nIndependent', representation),
    state('folder/target.md', '# Heading\n\nTarget', representation),
    state('observer.md', '[Original](folder/target.md) [[/folder/target#Heading]]', representation)];
  if (cross) originalStates.push(state('existing.md', 'Destination stays intact', representation, targetId));
  changeSource?.(originalStates[0]);
  const originalPhysical = withAssets ? [physical(sourceId, 'folder', 'directory', 10), physical(sourceId, 'folder/image.png', 'file', 11),
    physical(sourceId, 'folder/empty', 'directory', 12)] : [];
  const originals = [snapshot(sourceId, originalStates, originalPhysical), ...(cross ? [snapshot(targetId, originalStates)] : [])];
  const request = { kind: 'copy' as const, sourceWorkspaceId: sourceId, destinationWorkspaceId: targetId,
    selections: [{ sourcePath: 'folder', destinationPath }] };
  const compiled = compileWorkspaceNativeMixedBatch({ snapshots: originals, states: originalStates, requests: [request] });
  assert.equal(compiled.issues.length, 0, JSON.stringify(compiled.issues));
  const pathPlan = createWorkspaceNativeFileOperationPlan({ ...request, snapshots: originals });
  assert.equal(pathPlan.issues.length, 0, JSON.stringify(pathPlan.issues));
  const receipt: Input['receipt'] = { version: 1, operationId: 'copy-operation', workspaceId: targetId,
    requestFingerprint: 'a'.repeat(64), documents: [], publicationStatus: 'native_committed' };
  const clones: PersistedCollaborationState[] = [];
  for (const source of originalStates.filter(value => value.path.startsWith('folder/'))) {
    const copied = cloneNativeCollaborationDocument(source);
    try {
      const cloneState = { ...structuredClone(source), documentId: `clone:${source.documentId}`, workspaceId: targetId,
        path: source.path.replace('folder/', `${destinationPath}/`), documentSequence: 0,
        yjsState: Y.encodeStateAsUpdate(copied.doc), stateVector: Y.encodeStateVector(copied.doc) };
      const before = authoritativeNativeCollaborationSnapshot(source), initial = authoritativeNativeCollaborationSnapshot(cloneState);
      const document: Input['receipt']['documents'][number] = { version: 1, source: { documentId: source.documentId,
        lifecycleGeneration: source.lifecycleGeneration, documentSequence: source.documentSequence, stateProof: before.version.stateProof },
      clone: { documentId: cloneState.documentId, path: cloneState.path, lifecycleGeneration: 1, initialSequence: 0,
        lineageId: `clone-lineage:${source.documentId}`, stateProof: initial.version.stateProof }, blockIdMapping: { ...copied.blockIdMapping } };
      const result = prepareNativeCopyLinkUpdates({ sourceScope: { workspaceId: sourceId, organizationId: null },
        destinationScope: { workspaceId: targetId, organizationId: null }, source: { lineageId: `original-lineage:${source.documentId}`, state: source },
        clone: { lineageId: document.clone.lineageId, state: cloneState }, receipt: document,
        recipes: pathPlan.mutations.filter(recipe => recipe.source.documentId === source.documentId), operationId: `links:${source.documentId}` });
      if (result.prepared) {
        Y.applyUpdate(copied.doc, result.prepared.update);
        cloneState.yjsState = Y.encodeStateAsUpdate(copied.doc); cloneState.stateVector = Y.encodeStateVector(copied.doc);
        cloneState.documentSequence = 1;
      }
      clones.push(cloneState); receipt.documents.push(document);
    } finally { copied.doc.destroy(); }
  }
  const states = [...originalStates, ...clones];
  const originalEntries = new Map(originals.flatMap(original => original.namespace).map(value =>
    [proof({ workspaceId: value.workspaceId, identity: value.identity }), value]));
  const physicalCopies: Input['physicalCopies'][number][] = compiled.finalNamespace.filter(entity => entity.binding.kind === 'unbound-copy'
    && entity.contentBasisProof === null && originalEntries.get(entity.binding.sourceEntityKey)?.filesystemIdentity !== null).map((entity, index) => ({ entityKey: entity.entityKey,
    entry: physical(entity.workspaceId, entity.path, entity.kind, 100 + index) }));
  // Registry-only implicit folders are logical views, rather than physical copies.
  // A real folder copy is supplied as an independently checked physical fact.
  const final = originals.map(original => snapshot(original.workspaceId, states,
    [...originalPhysical.filter(value => value.workspaceId === original.workspaceId),
      ...physicalCopies.filter(value => value.entry.workspaceId === original.workspaceId).map(value => value.entry)]));
  return { compiled, originals, receipt, final, states, physicalCopies, createdParents: [] };
}
const conflict = (error: unknown) => error instanceof NativeCopyFinalGraphError && error.code === 'NATIVE_COPY_FINAL_GRAPH_CHANGED';
function refreshed(input: Input): void {
  input.final = input.final.map(before => snapshot(before.workspaceId, input.states,
    before.namespace.filter(value => !value.documentId && value.filesystemIdentity !== null)));
}
function replace(input: Input, documentId: string, text: string): void {
  const before = input.states.find(value => value.documentId === documentId)!;
  const next = state(before.path, text, before.representation, before.workspaceId);
  Object.assign(before, next, { documentId, documentSequence: before.documentSequence }); refreshed(input);
}
for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  for (const cross of [false, true]) test(`${representation}: complete ${cross ? 'cross' : 'same'} workspace copy checks rewritten clones and untouched graph`, () => {
    const input = fixture(representation, cross, true), before = structuredClone(input);
    assertNativeCopyFinalGraph(input); assert.deepEqual(input, before);
  });
  test(`${representation}: native-only copy supports inferred parents and original receipts survive link deltas`, () => {
    const input = fixture(representation), receipt = structuredClone(input.receipt);
    assert.deepEqual(input.physicalCopies, []);
    assert(input.final[0].namespace.some(value => value.path === 'new/copied' && value.filesystemIdentity === null
      && value.identity === `registry-directory:${proof({ workspaceId: 'workspace', path: 'new/copied' })}`));
    assertNativeCopyFinalGraph(input); assert.deepEqual(input.receipt, receipt);
    const clone = input.states.find(value => value.documentId.startsWith('clone:') && value.path.endsWith('note.md'))!;
    assert.equal(clone.documentSequence, 1);
    assert.notEqual(inspectPersistedDocumentLinks(clone).version.stateProof, receipt.documents.find(value => value.clone.documentId === clone.documentId)!.clone.stateProof);
  });
  test(`${representation}: unrelated original content and destination changes fail despite coherent re-inventory`, () => {
    for (const cross of [false, true]) {
      const input = fixture(representation, cross), original = input.states.find(value => value.path === (cross ? 'existing.md' : 'observer.md'))!;
      replace(input, original.documentId, 'Changed independently'); assert.throws(() => assertNativeCopyFinalGraph(input), conflict);
    }
  });
  test(`${representation}: clone changes outside links and reversed link order fail full semantic comparison`, () => {
    for (const text of ['[Target](../../folder/target.md#Heading)\n\nDifferent independent paragraph',
      '[Web](https://example.test) [Target](../../folder/target.md#Heading)']) {
      const input = fixture(representation), clone = input.states.find(value => value.documentId.startsWith('clone:') && value.path.endsWith('note.md'))!;
      replace(input, clone.documentId, text); assert.throws(() => assertNativeCopyFinalGraph(input), conflict);
    }
  });
}
test('receipt membership, source clocks, map keys and physical clone identities are exact', () => {
  const mutations: Array<(input: Input) => void> = [
    input => { input.receipt.documents.pop(); }, input => { input.receipt.documents.push(structuredClone(input.receipt.documents[0])); },
    input => { input.receipt.documents[0].source.documentId = 'foreign'; }, input => { input.receipt.documents[0].source.documentSequence++; },
    input => { input.receipt.documents[0].source.stateProof = 'foreign'; }, input => { input.receipt.documents[0].clone.path = 'elsewhere.md'; },
    input => { input.receipt.documents[0].clone.initialSequence = 1 as 0; },
    input => { input.receipt.documents[0].blockIdMapping.extra = 'unused-clone-id'; },
    input => { input.physicalCopies[0].entry.identity = 'foreign-physical'; },
    input => { input.physicalCopies = [...input.physicalCopies, structuredClone(input.physicalCopies[0])]; }, input => { input.physicalCopies = []; },
  ];
  for (const mutate of mutations) { const input = fixture('tiptap_blocks', false, true); mutate(input);
    assert.throws(() => assertNativeCopyFinalGraph(input), conflict); }
});
test('complete snapshot and binary proof rejects omitted, duplicate, stale or invented inventories and states', () => {
  const mutations: Array<(input: Input) => void> = [
    input => { input.final[0].coverage.complete = false; }, input => { input.final[0].snapshotProof = 'foreign'; },
    input => { input.final = [...input.final, structuredClone(input.final[0])]; }, input => { input.final[0].namespace.pop(); },
    input => { input.final[0].documents.pop(); }, input => { input.states = input.states.slice(1); },
    input => { input.states = [...input.states, structuredClone(input.states[0])]; },
    input => { input.final[0].documents[0].version.stateProof = 'foreign'; },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => assertNativeCopyFinalGraph(input), conflict); }
});
test('resolution checks bind every original/clone edge and candidate to compiler entities', () => {
  const mutations: Array<(input: Input) => void> = [
    input => { input.compiled.finalEdges.pop(); },
    input => { input.compiled.finalEdges[0].resolution.targetEntityKey = 'foreign'; },
    input => { input.compiled.finalEdges[0].resolution.candidateEntityKeys = ['foreign']; },
    input => { input.compiled.finalEdges[0].originEvidenceLinkId = 'foreign'; },
    input => { input.compiled.finalEdges[0].literal = 'foreign'; },
    input => { input.compiled.finalEdges[0].targetPathText = 'foreign'; },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); assert.throws(() => assertNativeCopyFinalGraph(input), conflict); }
});

test('reserved and long original block IDs survive exact inverse normalization without reading mapping accessors', () => {
  for (const id of ['constructor', 'prototype', '__proto__', 'x'.repeat(300)]) {
    const input = fixture('tiptap_xml', false, false, source => {
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, source.yjsState); (doc.getXmlFragment('body').toArray()[0] as Y.XmlElement).setAttribute('id', id);
        source.yjsState = Y.encodeStateAsUpdate(doc); source.stateVector = Y.encodeStateVector(doc);
      } finally { doc.destroy(); }
    });
    input.receipt = JSON.parse(JSON.stringify(input.receipt));
    assert(Object.hasOwn(input.receipt.documents[0].blockIdMapping, id)); assertNativeCopyFinalGraph(input);
    let reads = 0;
    Object.defineProperty(input.receipt.documents[0].blockIdMapping, id, { enumerable: true, get() { reads++; return 'bad'; } });
    assert.throws(() => assertNativeCopyFinalGraph(input), conflict); assert.equal(reads, 0);
  }
});

test('clone byte profile and initial publication sequence cannot drift with unchanged semantic content', () => {
  for (const change of [{ hasBom: false }, { newlineStyle: 'lf' as const }, { documentSequence: 2 }, { schemaVersion: 9 }]) {
    const input = fixture('tiptap_blocks');
    Object.assign(input.states.find(value => value.documentId.startsWith('clone:') && value.path.endsWith('note.md'))!, change);
    if (!('schemaVersion' in change)) refreshed(input);
    assert.throws(() => assertNativeCopyFinalGraph(input), conflict);
  }
  const input = fixture('plain_text'), linkless = input.states.find(value => value.documentId.startsWith('clone:') && value.path.endsWith('target.md'))!;
  linkless.documentSequence = 1; refreshed(input); assert.throws(() => assertNativeCopyFinalGraph(input), conflict);
});

test('planner blocks a copy that makes an untouched basename Wiki reference ambiguous', () => {
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const states = [state('folder/note.md', 'Independent', representation), state('folder/target.md', '# Heading', representation),
      state('observer.md', '[[target#Heading]]', representation)];
    const before = snapshot('workspace', states);
    const compiled = compileWorkspaceNativeMixedBatch({ snapshots: [before], states, requests: [{ kind: 'copy',
      sourceWorkspaceId: 'workspace', destinationWorkspaceId: 'workspace', selections: [{ sourcePath: 'folder', destinationPath: 'copied' }] }] });
    assert.equal(compiled.readiness, 'blocked');
    assert(compiled.issues.some(issue => issue.code === 'resolution-changed' && issue.path === 'observer.md'));
    assert.equal(compiled.finalGraphProof, null); assert.equal(compiled.executionReady, false);
  }
});

test('cross-workspace same-spelling paths preserve unchanged links without a native no-op delta', () => {
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    const input = fixture(representation, true, false, undefined,
      { destinationPath: 'folder', noteText: '[Target](/folder/target.md#Heading) [[/folder/target#Heading|Alias]]' });
    assert.deepEqual(input.compiled.steps[0].linkIntents, []);
    assertNativeCopyFinalGraph(input);
    for (const clone of input.states.filter(value => value.documentId.startsWith('clone:'))) {
      assert.equal(clone.documentSequence, 0);
      assert.equal(inspectPersistedDocumentLinks(clone).version.stateProof,
        input.receipt.documents.find(value => value.clone.documentId === clone.documentId)!.clone.stateProof);
    }
  }
});
