import assert from 'node:assert/strict';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createRichMarkdownYDoc, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { prepareMarkdownFileImport } from '../app/lib/collaboration/markdown-file-import';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinks } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { NativeWorkspaceLinkSnapshot } from '../app/lib/markdown/workspace-link-contract-v2';
import type { PhysicalReadLinkInventory, WorkspaceMixedReadLinkSnapshotV3 } from '../app/lib/markdown/workspace-link-contract-v3';
import { compileWorkspaceMixedImportCopyBatchV4, compileWorkspaceMixedReadBatchV3, compileWorkspaceNativeMixedBatch,
  type NativeMixedBatchRequest } from '../app/lib/markdown/workspace-native-mixed-batch-compiler';

const sourceWorkspace = 'block-guard-source', destinationWorkspace = 'block-guard-destination';
const guardCode = 'unsupported-import-native-block-fragment';
type RichRepresentation = 'tiptap_xml' | 'tiptap_blocks';

/** Genuine native bytes, never a native identity fabricated for the Raw file. */
function rawBlockGuardTarget(representation: PersistedCollaborationState['representation']) {
  const markdown = representation === 'plain_text' ? '# Target\n\nParagraph ^literal-marker\n' : '# Target\n\nParagraph\n';
  let yjsState: Uint8Array, stateVector: Uint8Array;
  if (representation === 'plain_text') {
    const imported = prepareMarkdownFileImport(Buffer.from(markdown), { representation: 'plain_text' });
    assert.equal(imported.representation, 'plain_text'); assert.equal(imported.canonical, markdown);
    yjsState = imported.yjsState; stateVector = imported.stateVector;
  } else {
    const doc = createRichMarkdownYDoc(markdown, representation);
    try {
      assert.equal(validateRichMarkdownYDoc(doc).valid, true);
      yjsState = Y.encodeStateAsUpdate(doc); stateVector = Y.encodeStateVector(doc);
    } finally { doc.destroy(); }
  }
  const state: PersistedCollaborationState = { documentId: `real-native-target:${representation}`, workspaceId: sourceWorkspace,
    organizationId: null, path: 'target.md', lifecycleGeneration: 1, representation, schemaVersion: 1,
    yjsState, stateVector, documentSequence: 7, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null,
    canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
  const snapshot = authoritativeNativeCollaborationSnapshot(state);
  let blockId: string;
  if (snapshot.content.kind === 'plain_text') {
    assert(snapshot.content.text.includes('^literal-marker')); blockId = 'literal-marker';
  } else {
    const paragraph = snapshot.content.document.content?.find(node => node.type === 'paragraph');
    assert.equal(typeof paragraph?.attrs?.id, 'string'); assert(paragraph!.attrs!.id.length > 0);
    blockId = paragraph!.attrs!.id as string;
  }
  return { state, blockId };
}

function rawBlockGuardSnapshot(workspaceId: string, states: PersistedCollaborationState[], physicalSources: PhysicalReadLinkInventory[]): WorkspaceMixedReadLinkSnapshotV3 {
  const documents = states.map(inspectPersistedDocumentLinks);
  for (const inventory of documents) { assert.equal(inventory.parserVersion, 2); assert.deepEqual(inventory.coverage, { complete: true, gaps: [] }); }
  const namespace = [...documents.map(({ document }) => ({ workspaceId, path: document.path, kind: 'file' as const,
    identity: `registry:${document.documentId}:1`, documentId: document.documentId, lifecycleGeneration: 1, filesystemIdentity: null })),
  ...physicalSources.map(inventory => ({ workspaceId, path: inventory.path, kind: 'file' as const,
    identity: inventory.physical.filesystemIdentity, documentId: null, lifecycleGeneration: null,
    filesystemIdentity: inventory.physical.filesystemIdentity }))];
  const body = { contractVersion: 3 as const, workspaceId, namespace, documents, physicalSources, coverage: { complete: true, gaps: [] } };
  return { ...body, snapshotProof: proof(body) };
}

function rawBlockGuardFixture(representation: PersistedCollaborationState['representation'],
  fragmentKind: 'block' | 'heading', sameSpelling: boolean, syntax: 'wiki' | 'markdown') {
  const target = rawBlockGuardTarget(representation), fragment = fragmentKind === 'block' ? `^${target.blockId}` : 'Target';
  const markdown = syntax === 'wiki' ? `[[/target#${fragment}]]\n` : `[Target](target.md#${fragment})\n`;
  const rawOriginal = inspectOriginalPhysicalLinks({ workspaceId: sourceWorkspace, organizationId: null, path: 'raw.md',
    bytes: Buffer.from(markdown), authority: { kind: 'unregistered', catalogueProof: proof([]) },
    filesystemIdentity: `1:101:${Buffer.byteLength(markdown)}:100:100` });
  assert.deepEqual(rawOriginal.coverage, { complete: true, gaps: [] }); assert.equal(rawOriginal.links.length, 1);
  assert.equal(rawOriginal.links[0].fragment, fragment); assert.equal(rawOriginal.links[0].kind, syntax);
  const { originalBytes: _private, ...raw } = rawOriginal;
  const snapshots = [rawBlockGuardSnapshot(sourceWorkspace, [target.state], [raw]), rawBlockGuardSnapshot(destinationWorkspace, [], [])];
  const requests: NativeMixedBatchRequest[] = [{ kind: 'copy', sourceWorkspaceId: sourceWorkspace, destinationWorkspaceId: destinationWorkspace,
    selections: [{ sourcePath: 'raw.md', destinationPath: sameSpelling ? 'raw.md' : 'raw-copy.md' },
      { sourcePath: 'target.md', destinationPath: sameSpelling ? 'target.md' : 'target-copy.md' }] }];
  assert(snapshots[0].namespace.find(entry => entry.path === 'raw.md')?.documentId === null);
  if (sameSpelling) assert(requests[0].selections.every(selection => selection.sourcePath === selection.destinationPath));
  return { states: [target.state], snapshots, requests, rawOriginal };
}

/** Every case checks binary/vector, original Raw bytes and all input facts,
 * including when a primary planning assertion fails. No DB/FD write is used. */
function assertRawBlockGuardInputPreserved<T>(fixture: ReturnType<typeof rawBlockGuardFixture>, operation: () => T): T {
  const before = structuredClone(fixture);
  try { return operation(); }
  finally { assert.deepEqual(fixture, before, 'compiler must preserve original Yjs bytes/vector, physical source and request/snapshot facts'); }
}

export function testRawCopyNativeBlockFragmentGuard(): void {
  let blocked = 0, permitted = 0, historical = 0;
  const richRepresentations: RichRepresentation[] = ['tiptap_xml', 'tiptap_blocks'];
  for (const representation of richRepresentations) for (const syntax of ['wiki', 'markdown'] as const) for (const sameSpelling of [false, true]) {
    const fixture = rawBlockGuardFixture(representation, 'block', sameSpelling, syntax);
    assertRawBlockGuardInputPreserved(fixture, () => {
      const plan = compileWorkspaceMixedImportCopyBatchV4(fixture);
      assert.equal(plan.contractVersion, 4); assert.equal(plan.readiness, 'blocked'); assert.equal(plan.executionReady, false);
      assert.deepEqual(plan.issues, [{ code: guardCode, requestIndex: 0, workspaceId: sourceWorkspace, path: 'raw.md',
        linkId: fixture.rawOriginal.links[0].physicalLinkId }]);
      assert.deepEqual(plan.steps, []); assert.deepEqual(plan.finalNamespace, []);
    }); blocked++;
  }

  for (const syntax of ['wiki', 'markdown'] as const) {
    const fixture = rawBlockGuardFixture('plain_text', 'block', false, syntax);
    assertRawBlockGuardInputPreserved(fixture, () => {
      const plan = compileWorkspaceMixedImportCopyBatchV4(fixture);
      assert.equal(plan.readiness, 'requires-import-rebinding', JSON.stringify(plan.issues)); assert.deepEqual(plan.issues, []);
      assert.equal(plan.rawImportRequirements.length, 1); assert.equal(plan.cloneRequirements.length, 1);
      assert.equal(plan.steps[0].physicalLinkIntents[0].fragment, '^literal-marker');
      const imported = plan.finalNamespace.find(entity => entity.path === 'raw-copy.md');
      const target = plan.finalNamespace.find(entity => entity.path === 'target-copy.md'); assert(imported); assert(target);
      assert.equal(imported.binding.kind, 'unbound-import'); assert.equal(target.binding.kind, 'unbound-copy');
      assert.equal(plan.finalEdges.find(edge => edge.sourceEntityKey === imported.entityKey)?.resolution.targetEntityKey, target.entityKey);
    }); permitted++;
  }
  for (const representation of richRepresentations) for (const syntax of ['wiki', 'markdown'] as const) {
    const fixture = rawBlockGuardFixture(representation, 'heading', false, syntax);
    assertRawBlockGuardInputPreserved(fixture, () => {
      const plan = compileWorkspaceMixedImportCopyBatchV4(fixture);
      assert.equal(plan.readiness, 'requires-import-rebinding', JSON.stringify(plan.issues)); assert.deepEqual(plan.issues, []);
      assert.equal(plan.rawImportRequirements.length, 1); assert.equal(plan.cloneRequirements.length, 1);
      assert.equal(plan.steps[0].physicalLinkIntents[0].fragment, 'Target');
    }); permitted++;
  }

  for (const representation of richRepresentations) {
    const fixture = rawBlockGuardFixture(representation, 'block', true, 'markdown');
    assertRawBlockGuardInputPreserved(fixture, () => {
      const v3 = compileWorkspaceMixedReadBatchV3(fixture);
      assert.equal(v3.contractVersion, 3); assert.equal(v3.readiness, 'blocked');
      assert.deepEqual(v3.issues.map(issue => issue.code), ['physical-source-import-required']);
      assert.equal(Object.hasOwn(v3, 'rawImportRequirements'), false);
      assert.equal(Object.hasOwn(v3.steps[0] ?? {}, 'physicalLinkIntents'), false);
      // V2 receives a genuine native-only V2 snapshot. No physical inventory is
      // relabelled as native or as a new-contract source.
      const snapshots: NativeWorkspaceLinkSnapshot[] = fixture.snapshots.map(snapshot => {
        assert.equal(snapshot.coverage.complete, true); assert.deepEqual(snapshot.coverage.gaps, []);
        const body = { contractVersion: 2 as const, workspaceId: snapshot.workspaceId,
          namespace: snapshot.namespace.filter(entry => entry.documentId !== null), documents: snapshot.documents,
          coverage: { complete: true, gaps: [] } };
        return { ...body, snapshotProof: proof(body) };
      });
      const input = { states: fixture.states, snapshots, requests: [{ ...fixture.requests[0], selections: [fixture.requests[0].selections[1]] }] };
      const before = structuredClone(input);
      try {
        const v2 = compileWorkspaceNativeMixedBatch(input);
        assert.equal(v2.contractVersion, 2); assert.equal(v2.readiness, 'requires-clone-rebinding'); assert.deepEqual(v2.issues, []);
        assert.equal(Object.hasOwn(v2, 'rawImportRequirements'), false); assert.equal(Object.hasOwn(v2.steps[0], 'physicalLinkIntents'), false);
      } finally { assert.deepEqual(input, before); }
    }); historical += 2;
  }
  assert.equal(blocked, 8); assert.equal(permitted, 6); assert.equal(historical, 4);
  console.log(JSON.stringify({ suite: 'workspace-raw-copy-native-block-fragment', blocked, permitted, historical,
    pureOnly: true, executionAdmission: false, databaseOrFilesystemAcceptance: false }));
}
