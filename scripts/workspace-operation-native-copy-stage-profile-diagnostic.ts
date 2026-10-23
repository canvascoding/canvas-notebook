import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { withNativeInspectionSchema } from '../app/lib/collaboration/native-inspection-schema';
import { inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { inspectNativeDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';
import { createWorkspaceOperationNativeCopyPlan } from '../app/lib/files/workspace-operation-native-copy-plan';
import { captureWorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import { assertNativeCopyStageManifestDigest, decodeNativeCopyStage, prepareNativeCopyStage,
  type WorkspaceOperationNativeCopyStageInput } from '../app/lib/files/workspace-operation-native-copy-stage';
import { captureNativeCopyPhaseStage, nativeCopyPhaseCompiler, withCapturedNativeCopyPhaseStage,
  withNativeCopyPhaseCompilation } from '../app/lib/files/workspace-operation-native-copy-phase-contract';
import { decodeNativeCopyMetadataSnapshot } from '../app/lib/files/workspace-operation-native-copy-metadata';
import { nativeRichDocumentFixture } from './helpers/rich-markdown-projection-fixtures';

// Pure data/CPU diagnostic, not a SQL/ACL/FD/publication acceptance test. Native
// contents and C1 are built by their real Yjs/inventory/compiler implementations.
// Root/parent facts below are declared data; no native filesystem cap is minted.
type Window = { records: number; name: string; startMicros: string; endMicros: string; elapsedMs: number };
const windows: Window[] = [];
const binarySha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function measure<T>(records: number, name: string, operation: () => T | Promise<T>): Promise<T> {
  const start = process.hrtime.bigint();
  try { return await operation(); }
  finally { const end = process.hrtime.bigint(); windows.push({ records, name, startMicros: (start / BigInt(1000)).toString(),
    endMicros: (end / BigInt(1000)).toString(), elapsedMs: Number(end - start) / 1_000_000 }); }
}
function workspace(): WorkspaceContext {
  return { workspaceId: 'profile-workspace', rootPath: '/pure-profile/workspace', rootRelativePath: 'users/profile/workspace',
    workspaceType: 'personal', organizationId: null, ownerUserId: 'profile-user', legacy: false, status: 'active',
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } };
}
function states(scope: WorkspaceContext, count: number): PersistedCollaborationState[] {
  return Array.from({ length: count }, (_, index) => {
    const filePath = `note-${String(index).padStart(3, '0')}.md`, target = `note-${String((index + 1) % count).padStart(3, '0')}.md`;
    const representation = (['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const)[index % 3];
    const markdown = `# Target\n\nOriginal ${index} 😀 [Next](${target}#Target)\n\n| A | B |\n| --- | --- |\n| One | Two |\n`;
    const doc = representation === 'plain_text' ? createPlainTextYDoc(markdown) : index === 2
      ? nativeRichDocumentFixture({ type: 'doc', content: [{ type: 'table', content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colwidth: [120] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Width' }] }] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colwidth: [120] }, content: [{ type: 'paragraph', content: [
          { type: 'text', text: 'Original table 😀', marks: [{ type: 'link', attrs: { href: `${target}#Target` } }] },
        ] }] }] },
      ] }] }, representation)
      : createRichMarkdownYDoc(markdown, representation);
    try {
      if (representation !== 'plain_text') {
        doc.getText('frontmatter').insert(0, '---\r\ntitle: Profile source\r\n---\r\n');
        doc.getText('bodyFinalLineEnding').insert(0, '\r\n\r\n');
      }
      return { documentId: `profile-document-${index}`, workspaceId: scope.workspaceId, organizationId: null, path: filePath,
        representation, lifecycleGeneration: 1, schemaVersion: 1, documentSequence: 7, persistedAt: 100,
        checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null, newlineStyle: 'crlf', hasBom: true,
        degraded: false, status: 'active', yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
    } finally { doc.destroy(); }
  });
}
function observation(scope: WorkspaceContext, values: PersistedCollaborationState[]): WorkspaceLinkSourceAuthorityObservation {
  const inventories = values.map(state => inspectPersistedNativeCollaborationSnapshot(state, inspectNativeDocumentLinks));
  const nativeBindings: WorkspaceNativeSourceBinding[] = values.map((state, index) => {
    const lineageId = `lineage:${state.documentId}`;
    return { expected: { documentId: state.documentId, lineageId, workspaceId: scope.workspaceId, organizationId: null,
      path: state.path, representation: state.representation, schemaVersion: 1, lifecycleGeneration: 1, registryStateVersion: 7,
      documentSequence: 7, persistedAt: 100, binaryHash: binarySha(state.yjsState), vectorHash: binarySha(state.stateVector),
      stateProof: inventories[index].version.stateProof },
    registry: { documentId: state.documentId, lineageId, workspaceId: scope.workspaceId, workspaceType: 'personal', organizationId: null,
      customerId: null, projectId: null, path: state.path, provider: 'yjs', stateLifecycle: 'initialized', stateVersion: 7, status: 'active' },
    lineage: { lineageId, workspaceId: scope.workspaceId, workspaceType: 'personal', organizationId: null, customerId: null, projectId: null,
      path: state.path, status: 'active', archivedAt: null, trashEntryId: null }, byteProfile: { newlineStyle: 'crlf', hasBom: true },
    inventoryProof: proof(inventories[index]) };
  });
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: scope.workspaceId, organizationId: null,
    catalogueProof: proof(nativeBindings.map(binding => binding.registry)),
    namespace: values.map(state => ({ workspaceId: scope.workspaceId, path: state.path, kind: 'file',
      identity: `registry:${state.documentId}:1`, filesystemIdentity: null, documentId: state.documentId, lifecycleGeneration: 1 })),
    sources: inventories.map(inventory => ({ kind: 'native', inventory })), scope: { kind: 'visible-workspace', excludedPaths: [] },
    coverage: { complete: true, gaps: [] }, readiness: 'native-coordinator-required', executionReady: false };
  return { stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) }, nativeBindings, privateNativeStates: values };
}
async function runCase(count: number): Promise<void> {
  const scope = workspace();
  const originalStates = await measure(count, 'fixture.native-records', () => withNativeInspectionSchema(() => states(scope, count)));
  const originalBytes = originalStates.map(state => [binarySha(state.yjsState), binarySha(state.stateVector)]);
  const observed = await measure(count, 'fixture.inventories', () => withNativeInspectionSchema(() => observation(scope, originalStates)));
  const selections = [{ sourcePath: 'note-000.md', destinationPath: 'copied-000.md' }];
  const plan = await measure(count, 'c1.builder', () => withNativeInspectionSchema(() => createWorkspaceOperationNativeCopyPlan({
    sourceScope: { workspace: scope, fileOptions: {} }, destinationScope: { workspace: scope, fileOptions: {} },
    selections, sourceObservation: observed, destinationObservation: observed })));
  assert.equal(plan.executionReady, false); assert.equal(plan.cloneRequirements.length, 1);
  const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'profile-user', actorId: 'profile-user', sessionId: 'profile-session' },
    sourceWorkspace: scope, destinationWorkspace: scope });
  const identity = { device: '1', inode: '2', mode: 0o40700, uid: 501, gid: 20, linkCount: '2', size: '0', birthtimeNs: '1', mtimeNs: '1', ctimeNs: '1' };
  const physical: WorkspaceOperationNativeCopyStageInput['physical'] = [{ selectionIndex: 0, original: { version: 1,
    sourceWorkspace: plan.sourceScope, destinationWorkspace: plan.destinationScope, sourcePath: selections[0].sourcePath,
    destinationPath: selections[0].destinationPath, projectionPaths: [selections[0].sourcePath],
    budget: { maxDepth: 32, maxEntries: 10_000, maxHashBytes: 4 * 1024 ** 3 },
    filesystem: { sourceRoot: { resolvedPath: scope.rootPath, identity }, destinationRoot: { resolvedPath: scope.rootPath, identity },
      sourceParents: { directories: [], missingPrefix: null }, destinationParents: { directories: [], missingPrefix: null } },
    source: { kind: 'projection_absent' }, staging: null } }];
  const metadata = decodeNativeCopyMetadataSnapshot({ version: 1, kind: 'shared-title-copy', planId: plan.planId,
    sourceWorkspaceId: scope.workspaceId, destinationWorkspaceId: scope.workspaceId,
    mappingsProof: proof({ version: 1, kind: 'native-copy-title-mappings', planId: plan.planId,
      mappings: plan.nativePathPlan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath })) }),
    vacancyScopes: ['copied-000.md'], exactVacancyPaths: [],
    sourceRows: [{ path: 'note-000.md', title: 'Original shared title', createdAt: 10, updatedAt: 11 }] }, { plan, physical });
  const input: WorkspaceOperationNativeCopyStageInput = { operationId: `pure-copy-profile-${count}`, request: { kind: 'copy', selections, origin }, plan, physical,
    nativeRecords: originalStates.map(state => ({ lineageId: `lineage:${state.documentId}`, state })), metadata };
  const prepared = await measure(count, 'stage.prepare-v3', () => prepareNativeCopyStage(input));
  const restored = await measure(count, 'stage.native-load-pure', () => {
    // These are the actual nativeLoad codec calls, excluding its FD reads.
    assertNativeCopyStageManifestDigest(prepared.manifest);
    return decodeNativeCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity);
  });
  assert.equal(restored.version, 3); assert.equal(restored.nativeRecords.length, count);
  await measure(count, 'owner.pre-tx-capture-and-phase-pure', () => withCapturedNativeCopyPhaseStage(restored,
    detached => withNativeInspectionSchema(() => withNativeCopyPhaseCompilation(detached, async () => {
      // copyPhaseTransaction captures before transaction()/schema begins. The
      // genuine phase then pins the captured data and reuses its own compiler.
      await measure(count, 'phase.capture-pinned', () => { assert.equal(captureNativeCopyPhaseStage(detached), detached); });
      await measure(count, 'phase.metadata-guard-pins-16', () => {
        // Four real metadata reads each guard before/after, with two captures
        // per phase assertion: measure their sixteen genuine immutable pins.
        // This does not replace any SQL, phase guard, current ACL or lease.
        for (let index = 0; index < 16; index++) assert.equal(captureNativeCopyPhaseStage(detached), detached);
      });
      const compiled = await measure(count, 'phase.compiler-first', () => nativeCopyPhaseCompiler(detached));
      assert.equal(compiled.executionReady, false); assert.equal(compiled.cloneRequirements.length, 1);
      await measure(count, 'phase.compiler-exact-reuse', () => { assert.equal(nativeCopyPhaseCompiler(detached), compiled); });
      await measure(count, 'phase.stage-ack-pure', () => {
        // The fixture's C3 INSERT-ACK loads the unchanged original Stage while
        // the real phase's schema/data/compiler lifetimes are still active.
        assertNativeCopyStageManifestDigest(prepared.manifest);
        const loaded = decodeNativeCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity);
        assert.equal(loaded.payloadSha256, detached.payloadSha256); assert.equal(loaded.nativeRecords.length, count);
      });
      await measure(count, 'phase.capture-pinned-after-await', () => { assert.equal(captureNativeCopyPhaseStage(detached), detached); });
    }))));
  assert.deepEqual(originalStates.map(state => [binarySha(state.yjsState), binarySha(state.stateVector)]), originalBytes);
  console.log(JSON.stringify({ diagnostic: 'native-copy-stage-profile-case', records: count,
    representations: Object.fromEntries(['plain_text', 'tiptap_xml', 'tiptap_blocks'].map(representation =>
      [representation, originalStates.filter(state => state.representation === representation).length])),
    nativeBinaryBytes: originalStates.reduce((sum, state) => sum + state.yjsState.byteLength + state.stateVector.byteLength, 0),
    manifestBytes: prepared.manifestBytes.length, recordsBytes: prepared.recordsBytes.length,
    fixtureProof: proof({ planId: plan.planId, stageDigest: restored.payloadSha256, binaryHashes: originalBytes }),
    planId: plan.planId, stageDigest: restored.payloadSha256, windows: windows.filter(window => window.records === count) }));
}

let completed = false;
process.on('beforeExit', () => { if (!completed) { console.error('Pure native Copy profile diagnostic ended before completion.'); process.exitCode = 1; } });
async function main(): Promise<void> {
  for (const count of [3, 83]) await runCase(count);
  completed = true;
  console.log(JSON.stringify({ diagnostic: 'native-copy-stage-profile-complete', cases: 2, records: [3, 83], windows: windows.length,
    sqlConnections: 0, currentAuthorityClaim: false, filesystemAuthorityClaim: false, elapsedAssertions: false }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
