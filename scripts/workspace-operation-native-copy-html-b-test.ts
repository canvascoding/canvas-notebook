import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { cloneNativeCollaborationDocument } from '../app/lib/collaboration/native-document-recovery';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { captureAgentStateSnapshot } from '../app/lib/collaboration/agent-durability';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { NativeCopyDocumentReceipt } from '../app/lib/collaboration/native-copy-persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import { workspaceOperationMixedSourceEvidenceV5Fixture as fixture } from './workspace-operation-mixed-source-evidence-v5-test';
import { createWorkspaceOperationManagedCopyPlanV6, decodeWorkspaceOperationManagedCopyPlanV6,
  assertWorkspaceOperationManagedCopyPlanV6Current } from '../app/lib/files/workspace-operation-managed-copy-plan-v6';
import { createWorkspaceOperationManagedCopyPlanV7, decodeWorkspaceOperationManagedCopyPlanV7,
  WorkspaceOperationManagedCopyPlanV7Error } from '../app/lib/files/workspace-operation-managed-copy-plan-v7';
import { createWorkspaceOperationManagedCopyPlanV8, decodeWorkspaceOperationManagedCopyPlanV8, WorkspaceOperationManagedCopyPlanV8Error }
  from '../app/lib/files/workspace-operation-managed-copy-plan-v8';
import { compileWorkspaceMixedSelectedHtmlImportCopyBatchV6 } from '../app/lib/markdown/workspace-native-mixed-batch-compiler';
import { prepareHtmlCopyStage, decodeHtmlCopyStage, replayHtmlCopyStageCompiler, assertHtmlCopyStageManifestDigest }
  from '../app/lib/files/workspace-operation-html-copy-stage';
import { captureWorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import { decodeNativeCopyMetadataSnapshot } from '../app/lib/files/workspace-operation-native-copy-metadata';
import { prepareNativeCopyLinkUpdatesV4 } from '../app/lib/markdown/workspace-native-copy-link-updates-v4';
import { workspaceOperationNativeCopyPublicPreview } from '../app/lib/files/workspace-operation-native-copy-public';
import { nativeCopyPhaseStepCount }
  from '../app/lib/files/workspace-operation-native-copy-phase-contract';
import { formatDirectMcpWorkspaceCopyResult } from '../app/lib/mcp/server/workspace-copy-tool-contract';
import { nativeLinkPreparedIntentProof, type NativeLinkMutationReceipt } from '../app/lib/markdown/native-link-mutation-persistence';
import { nativeCopyHtmlLinkResultEvidenceV4 } from '../app/lib/files/workspace-operation-native-copy-html-link-receipt';

// Actual Yjs, independent clone producer, native4 rehearsal and versioned codecs.
// Namespace/FS/catalogue/receipt objects are explicit pure data fixtures. They
// prove no current SQL principal, FD ownership, persisted birth or COMMIT.
const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const scope = (value: ReturnType<typeof fixture>): WorkspaceContext => ({ ...value.scope,
  rootRelativePath: value.scope.rootRelativePath ?? undefined,
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true } });
function observation(representation: PersistedCollaborationState['representation'] = 'plain_text') {
  const value = fixture({ native: [['note.md', '[Self](note.md)\n\n[Keep](keep.md)' + (representation === 'plain_text' ? '\n\n<span>Safe</span>' : '')], ['keep.md', '# Keep'],
    ['incoming.md', '[Original](note.md)']], raw: [['page.html', '<a href="stable.png">Stable</a>']], extra: [{ path: 'stable.png', kind: 'file' }] });
  if (representation !== 'plain_text') {
    for (const state of value.observation.privateNativeStates) {
      const text = authoritativeNativeCollaborationSnapshot(state).content;
      assert.equal(text.kind, 'plain_text');
      const doc = createRichMarkdownYDoc(text.kind === 'plain_text' ? text.text : '', representation);
      try { state.representation = representation; state.yjsState = Y.encodeStateAsUpdate(doc); state.stateVector = Y.encodeStateVector(doc); }
      finally { doc.destroy(); }
      const inventory = inspectPersistedDocumentLinks(state), binding = value.observation.nativeBindings.find(item => item.expected.documentId === state.documentId)!;
      binding.expected.representation = representation; binding.expected.binaryHash = sha(state.yjsState);
      binding.expected.vectorHash = sha(state.stateVector); binding.expected.stateProof = inventory.version.stateProof; binding.inventoryProof = proof(inventory);
      value.observation.stage.sources = value.observation.stage.sources.map(item => item.kind === 'native' && item.inventory.document.documentId === state.documentId
        ? { kind: 'native', inventory } : item);
    }
    const gaps = value.observation.stage.sources.flatMap(source => source.kind === 'native'
      ? source.inventory.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path })) : source.inventory.coverage.gaps);
    value.observation.stage.coverage = { complete: !gaps.length, gaps };
    value.observation.stage.readiness = gaps.length ? 'blocked' : value.observation.stage.sources.some(source => source.kind === 'physical')
      ? 'requires-import-and-rebinding' : 'native-coordinator-required';
    value.observation.stage.stageProof = workspaceSourceAuthorityStageProof(value.observation.stage);
  }
  return value;
}
const selections = [{ sourcePath: 'note.md', destinationPath: 'note-copy.md' }, { sourcePath: 'keep.md', destinationPath: 'keep-copy.md' }];
function build(value: ReturnType<typeof fixture>, destination = value) {
  return createWorkspaceOperationManagedCopyPlanV6({ sourceScope: { workspace: scope(value), fileOptions: {} },
    destinationScope: { workspace: scope(destination), fileOptions: {} }, selections,
    sourceObservation: value.observation, destinationObservation: destination.observation });
}
function stage(value: ReturnType<typeof fixture>) {
  const plan = build(value), workspace = scope(value), origin = captureWorkspaceOperationCopyOrigin({
    actor: { type: 'user', userId: 'fixture-owner', actorId: 'fixture-owner', sessionId: 'original-html-session' },
    sourceWorkspace: workspace, destinationWorkspace: workspace });
  const identity = { device: '1', inode: '2', mode: 0o40700, uid: 501, gid: 20, linkCount: '2', size: '0', birthtimeNs: '1', mtimeNs: '1', ctimeNs: '1' };
  const physical = selections.map(({ sourcePath, destinationPath }, selectionIndex) => ({ selectionIndex, original: {
    version: 3 as const, sourceProjectionPolicy: 'provider-derived-files-v3' as const, derivedFiles: [],
    sourceWorkspace: plan.sourceScope, destinationWorkspace: plan.destinationScope, sourcePath, destinationPath, projectionPaths: [sourcePath],
    budget: { maxDepth: 32, maxEntries: 10_000, maxHashBytes: 4 * 1024 ** 3 },
    filesystem: { sourceRoot: { resolvedPath: workspace.rootPath, identity }, destinationRoot: { resolvedPath: workspace.rootPath, identity },
      sourceParents: { directories: [], missingPrefix: null }, destinationParents: { directories: [], missingPrefix: null } },
    source: { kind: 'projection_absent' as const }, staging: null } }));
  const mappings = plan.nativePathPlan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath }));
  const metadata = decodeNativeCopyMetadataSnapshot({ version: 1, kind: 'shared-title-copy', planId: plan.planId,
    sourceWorkspaceId: plan.sourceScope.workspaceId, destinationWorkspaceId: plan.destinationScope.workspaceId,
    mappingsProof: proof({ version: 1, kind: 'native-copy-title-mappings', planId: plan.planId, mappings }),
    vacancyScopes: selections.map(row => row.destinationPath).sort(), exactVacancyPaths: [], sourceRows: [] }, { plan, physical });
  const nativeRecords = value.observation.nativeBindings.map(binding => ({ lineageId: binding.expected.lineageId,
    state: value.observation.privateNativeStates.find(state => state.documentId === binding.expected.documentId)! }));
  const prepared = prepareHtmlCopyStage({ operationId: 'html-copy-stage-fixture', request: { kind: 'copy', origin, selections }, plan, physical, nativeRecords, metadata });
  return { prepared, stage: decodeHtmlCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity) };
}
function clonePair(value: ReturnType<typeof fixture>) {
  const source = value.observation.privateNativeStates.find(state => state.path === 'note.md')!, original = authoritativeNativeCollaborationSnapshot(source);
  const produced = cloneNativeCollaborationDocument(source);
  try {
    const clone: PersistedCollaborationState = { ...source, documentId: crypto.randomUUID(), path: 'note-copy.md', documentSequence: 0,
      persistedAt: 200, yjsState: Y.encodeStateAsUpdate(produced.doc), stateVector: Y.encodeStateVector(produced.doc) };
    const copied = authoritativeNativeCollaborationSnapshot(clone), sourceLineage = value.observation.nativeBindings.find(row => row.expected.documentId === source.documentId)!.expected.lineageId;
    const lineageId = crypto.randomUUID(), receipt: NativeCopyDocumentReceipt = { version: 1,
      source: { documentId: source.documentId, lifecycleGeneration: 1, stateProof: original.version.stateProof, documentSequence: source.documentSequence },
      clone: { documentId: clone.documentId, lineageId, path: clone.path, lifecycleGeneration: 1, stateProof: copied.version.stateProof, initialSequence: 0 },
      blockIdMapping: produced.blockIdMapping };
    return { source: { lineageId: sourceLineage, state: source }, clone: { lineageId, state: clone }, receipt };
  } finally { produced.doc.destroy(); }
}
export function workspaceOperationNativeCopyHtmlBTest(): void {
  let groups = 0;
  const family = (name: string, run: () => void) => { run(); groups++; console.log(`PASS native-copy-html-b ${groups}: ${name}`); };
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    family(`${representation}: E5/Graph5 plan preserves gaps and original incoming links`, () => {
      const value = observation(representation), before = structuredClone(value.observation), plan = build(value);
      assert.equal(plan.version, 6); assert.equal(plan.sourceEvidence.evidenceVersion, 5); assert.equal(plan.nativePathPlan.contractVersion, 5);
      assert.equal(plan.sourceEvidence.coverage.complete, false); assert.equal(plan.nativePathPlan.htmlAssessment.complete, true);
      assert.equal(plan.sceneCopyRequirements.length, 0); assert.equal(plan.cloneRequirements.length, 2);
      assert(plan.nativePathPlan.mutations.every(recipe => recipe.source.path !== 'incoming.md'));
      assert.deepEqual(new Set(plan.nativePathPlan.mutations.map(recipe => recipe.nextValue)), new Set(['note-copy.md', 'keep-copy.md']));
      assert.deepEqual(decodeWorkspaceOperationManagedCopyPlanV6(JSON.parse(JSON.stringify(plan))), plan);
      assertWorkspaceOperationManagedCopyPlanV6Current(plan, { sourceScope: plan.sourceScope, destinationScope: plan.destinationScope,
        sourceObservation: value.observation, destinationObservation: value.observation });
      assert.deepEqual(value.observation, before);
    });
    family(`${representation}: Stage7 strict original replay and completion version`, () => {
      const value = observation(representation), result = stage(value), saved = result.stage;
      assert.equal(saved.version, 7); assert.equal(saved.plan.version, 6); assert(saved.physical.every(row => row.original.version === 3));
      assert.equal(replayHtmlCopyStageCompiler(saved.plan, saved.nativeRecords).contractVersion, 5);
      assert.equal(nativeCopyPhaseStepCount(saved), 4); // two paths, one changed clone, completion
      const altered = Buffer.from(result.prepared.recordsBytes); altered[altered.length - 1] ^= 1;
      assert.throws(() => decodeHtmlCopyStage(result.prepared.manifest, altered, saved.identity));
      const wrong = { ...result.prepared.manifest, version: 6 }; assert.throws(() => assertHtmlCopyStageManifestDigest(wrong));
      assert(Object.isFrozen(saved)); assert(Object.isFrozen(saved.plan.sourceEvidence));
    });
    family(`${representation}: fresh clone IDs and native4 rebinding never reuse source anchors`, () => {
      const value = observation(representation), plan = build(value), pair = clonePair(value), before = structuredClone(pair.source);
      const result = prepareNativeCopyLinkUpdatesV4({ sourceScope: plan.sourceScope, destinationScope: plan.destinationScope,
        ...pair, recipes: plan.nativePathPlan.mutations.filter(recipe => recipe.source.path === 'note.md'), operationId: 'html-pure-link' });
      assert(result.prepared); assert.equal(result.prepared.contractVersion, 4); assert.equal(result.prepared.parserVersion, 4);
      assert.equal(result.linkBindings.length, 2); assert(result.linkBindings.every(row => row.sourceLinkId !== row.cloneLinkId));
      assert.notEqual(pair.source.state.documentId, pair.clone.state.documentId); assert.notEqual(pair.source.lineageId, pair.clone.lineageId);
      assert.deepEqual(pair.source, before); assert.deepEqual(result.recipes.map(recipe => recipe.source.documentId), [pair.clone.state.documentId, pair.clone.state.documentId]);
      assert(result.recipes.every(recipe => recipe.cloneSelection === null));
      if (representation !== 'plain_text') { assert(Object.keys(pair.receipt.blockIdMapping).length); assert(Object.entries(pair.receipt.blockIdMapping).every(([old, fresh]) => old !== fresh)); }
      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, pair.clone.state.yjsState); Y.applyUpdate(candidate, result.prepared.update);
        const snapshot = captureAgentStateSnapshot(candidate, Y); assert(snapshot);
        const receipt: NativeLinkMutationReceipt = { contractVersion: 2, operationId: result.prepared.operationId,
          source: result.prepared.source, before: result.prepared.before,
          after: { ...result.prepared.after, documentSequence: 1, persistedAt: 300 },
          afterStateSnapshot: snapshot, inverseRecipes: result.prepared.inverseRecipes,
          binding: { actorUserId: 'fixture-owner', actorId: 'fixture-owner', actorType: 'user', actorSessionId: 'original-html-session',
            requestId: result.prepared.operationId, requestHash: '1'.repeat(64), authorizedPreparedProof: nativeLinkPreparedIntentProof(result.prepared) } };
        const evidence = nativeCopyHtmlLinkResultEvidenceV4(pair.source, receipt);
        assert.equal(evidence.evidence.afterBinaryHash, sha(snapshot));
        assert.equal(evidence.evidence.afterVectorHash, sha(Y.encodeStateVector(candidate)));
        const extended = Buffer.concat([snapshot, Buffer.from([0])]);
        assert.throws(() => nativeCopyHtmlLinkResultEvidenceV4(pair.source, { ...receipt, afterStateSnapshot: extended,
          after: { ...receipt.after, stateProof: `yjs-snapshot-sha256-v1:${sha(extended)}` } }));
        assert.throws(() => nativeCopyHtmlLinkResultEvidenceV4(pair.source, { ...receipt, afterStateSnapshot: Uint8Array.from([255]) }));
        assert.throws(() => nativeCopyHtmlLinkResultEvidenceV4(pair.source, { ...receipt,
          after: { ...receipt.after, stateVector: Buffer.from(pair.clone.state.stateVector).toString('base64') } }));
        const update = Y.encodeStateAsUpdate(candidate);
        assert.throws(() => nativeCopyHtmlLinkResultEvidenceV4(pair.source, { ...receipt, afterStateSnapshot: update,
          after: { ...receipt.after, stateProof: `yjs-snapshot-sha256-v1:${sha(update)}` } }));
      } finally { candidate.destroy(); }
    });
  }
  family('cross-workspace E5 destination stays independently bound', () => {
    const value = observation(), destination = fixture({ workspaceId: 'html-destination', native: [], raw: [['other.html', '<p>Other</p>']] });
    const plan = build(value, destination); assert.notEqual(plan.sourceScope.workspaceId, plan.destinationScope.workspaceId);
    assert.equal(plan.destinationEvidence.physicalHtmlSources4.length, 1); assert.equal(plan.cloneRequirements.length, 2);
    // Request order is semantic even when the two workspace IDs sort the
    // other way round. Exercise genuine V7 raw-import planning in both orders.
    for (const [sourceId, destinationId] of [['raw-order-a', 'raw-order-z'], ['raw-order-z', 'raw-order-a']] as const) {
      const source = fixture({ workspaceId: sourceId, native: [],
        raw: [['folder/note.md', '# Raw\n\n[Self](note.md) [Asset](picture.png)\n'], ['unrelated.html', '<p>Unrelated source HTML</p>']],
        extra: [{ path: 'folder/picture.png', kind: 'file' }] });
      const target = fixture({ workspaceId: destinationId, native: [], raw: [['other.html', '<p>Unrelated destination HTML</p>']] });
      const original = structuredClone([source.observation, target.observation]);
      const rawPlan = createWorkspaceOperationManagedCopyPlanV7({ sourceScope: { workspace: scope(source), fileOptions: {} },
        destinationScope: { workspace: scope(target), fileOptions: {} },
        selections: [{ sourcePath: 'folder', destinationPath: 'folder-copy' }],
        sourceObservation: source.observation, destinationObservation: target.observation });
      assert.equal(rawPlan.version, 7); assert.equal(rawPlan.compilation.contractVersion, 6);
      assert.deepEqual(rawPlan.rawImportRequirements.map(requirement => requirement.sourcePath), ['folder/note.md']);
      assert.equal(rawPlan.sourceEvidence.coverage.complete, false); assert.equal(rawPlan.nativePathPlan.htmlAssessment.complete, true);
      const expectedCoverage = [{ workspaceId: sourceId, coverage: rawPlan.sourceEvidence.coverage },
        { workspaceId: destinationId, coverage: rawPlan.destinationEvidence.coverage }];
      assert.deepEqual(rawPlan.compilation.sourceCoverage, expectedCoverage);
      assert.deepEqual(rawPlan.nativePathPlan.sourceCoverage, expectedCoverage);
      assert.deepEqual(decodeWorkspaceOperationManagedCopyPlanV7(JSON.parse(JSON.stringify(rawPlan))), rawPlan);
      // Re-sign every affected transport proof. Reordered coverage must still
      // disagree with the original source/destination request and evidence.
      const { planId: _compilerProof, ...compilerBody } = rawPlan.compilation;
      const swappedBody = { ...compilerBody, sourceCoverage: [...expectedCoverage].reverse() };
      const compilation = { ...swappedBody, planId: proof(swappedBody) };
      const { planId: _pathProof, ...pathBody } = rawPlan.nativePathPlan;
      const swappedPath = { ...pathBody, sourceCoverage: compilation.sourceCoverage };
      const nativePathPlan = { ...swappedPath, planId: proof(swappedPath) };
      const { integrityProof: _integrity, ...planBody } = rawPlan;
      const forgedBody = { ...planBody, compilation, compilerPlanProof: compilation.planId, nativePathPlan };
      const forged = { ...forgedBody, integrityProof: proof(forgedBody) };
      assert.equal(forged.planId, rawPlan.planId);
      assert.throws(() => decodeWorkspaceOperationManagedCopyPlanV7(forged), error => error instanceof WorkspaceOperationManagedCopyPlanV7Error
        && error.code === 'MANAGED_COPY_PLAN_INVALID' && error.status === 409);
      assert.deepEqual([source.observation, target.observation], original);
    }
  });
  family('opaque HTML blocks; missing target newly occupied by Copy blocks', () => {
    for (const html of ['<unknown value="hidden.md">x</unknown>', '<a href="note-copy.md">future</a>']) {
      const value = fixture({ native: [['note.md', '# Note'], ['keep.md', '# Keep']], raw: [['page.html', html]] });
      assert.throws(() => build(value));
    }
  });
  family('selected raw and Scene namespace never downgrade into new cohort', () => {
    const raw = fixture({ native: [['keep.md', '# Keep']], raw: [['note.md', '# Raw'], ['page.html', '<p>Unrelated</p>']] });
    assert.throws(() => build(raw));
    const scene = observation(); scene.observation.stage.namespace.push({ workspaceId: scene.scope.workspaceId, path: 'canvas.excalidraw', kind: 'file',
      provider: 'excalidraw', documentId: null, lifecycleGeneration: null, filesystemIdentity: null, identity: 'scene:fixture:1:content' });
    scene.observation.stage.stageProof = workspaceSourceAuthorityStageProof(scene.observation.stage); assert.throws(() => build(scene));
    // External-only own HTML compiles as C2 even without a legacy Parser3 gap.
    // The unchanged central assessor still rejects selected local HTML links.
    for (const htmlMode of ['external-only', 'local-and-external'] as const) {
      const externalHtml = '<p><a href="https://example.com">Unchanged C2 HTML Ω</a></p>';
      const html = htmlMode === 'external-only' ? externalHtml
        : externalHtml.replace('</p>', ' <a href="stable.png">Unchanged C2 local asset</a></p>');
      const ownHtml = fixture({ native: [], raw: [['own.md', `# C2\n\n[Self](own.md) [Asset](stable.png)\n\n${html}\n`]],
        extra: [{ path: 'stable.png', kind: 'file' }] });
      const original = structuredClone(ownHtml.observation);
      const compiled = compileWorkspaceMixedSelectedHtmlImportCopyBatchV6({ sourceEvidence: ownHtml.evidence,
        states: ownHtml.observation.privateNativeStates, requests: [{ kind: 'copy', sourceWorkspaceId: ownHtml.scope.workspaceId,
          destinationWorkspaceId: ownHtml.scope.workspaceId, selections: [{ sourcePath: 'own.md', destinationPath: 'own-copy.md' }] }] });
      if (htmlMode === 'local-and-external') {
        assert(compiled.issues.some(issue => issue.code === 'affected-html-link'));
        assert.throws(() => createWorkspaceOperationManagedCopyPlanV8({ sourceScope: { workspace: scope(ownHtml), fileOptions: {} },
          destinationScope: { workspace: scope(ownHtml), fileOptions: {} },
          selections: [{ sourcePath: 'own.md', destinationPath: 'own-copy.md' }],
          sourceObservation: ownHtml.observation, destinationObservation: ownHtml.observation }),
        error => error instanceof WorkspaceOperationManagedCopyPlanV8Error && error.code === 'MANAGED_COPY_PLAN_UNSUPPORTED' && error.status === 409);
        assert.deepEqual(ownHtml.observation, original); continue;
      }
      assert.deepEqual(compiled.issues, []);
      const plan8 = createWorkspaceOperationManagedCopyPlanV8({ sourceScope: { workspace: scope(ownHtml), fileOptions: {} },
        destinationScope: { workspace: scope(ownHtml), fileOptions: {} },
        selections: [{ sourcePath: 'own.md', destinationPath: 'own-copy.md' }],
        sourceObservation: ownHtml.observation, destinationObservation: ownHtml.observation });
      assert.equal(plan8.version, 8); assert.equal(plan8.compilation.contractVersion, 6);
      assert.equal(plan8.sourceEvidence.coverage.complete, htmlMode === 'external-only');
      assert.equal(plan8.rawImportRequirements.length, 1); assert.equal(plan8.rawImportRequirements[0].sourcePath, 'own.md');
      assert.equal(plan8.rawImportRequirements[0].sourceBinding.original4.parserVersion, 4);
      const inspection = plan8.sourceEvidence.physicalSources4[0].htmlInspection;
      assert.equal(inspection.occurrences.length, 1); assert(inspection.occurrences[0].fullyInspected);
      assert(inspection.occurrences[0].raw.includes(html));
      assert.deepEqual(plan8.compilation.sourceCoverage,
        [{ workspaceId: ownHtml.scope.workspaceId, coverage: ownHtml.evidence.coverage }]);
      assert.deepEqual(decodeWorkspaceOperationManagedCopyPlanV8(JSON.parse(JSON.stringify(plan8))), plan8);
      const public8 = workspaceOperationNativeCopyPublicPreview(plan8);
      assert.equal(public8.version, 6); assert.equal(public8.coverage.complete, htmlMode === 'external-only');
      assert.equal(public8.linkAssessment?.complete, true); assert.equal(public8.linkAssessment?.blockers.length, 0);
      assert.deepEqual(ownHtml.observation, original);
    }
  });
  family('public V5 and MCP output retain original incompleteness without leaking private facts', () => {
    const value = observation(), publicPlan = workspaceOperationNativeCopyPublicPreview(build(value));
    assert.equal(publicPlan.version, 5); assert.equal(publicPlan.coverage.complete, false); assert.equal(publicPlan.linkAssessment?.complete, true);
    assert(publicPlan.linkAssessment?.warnings.some(warning => warning.reason === 'unaffected-explicit-html-link' && warning.htmlTargets?.includes('stable.png')));
    const result = formatDirectMcpWorkspaceCopyResult({ apiVersion: 1, action: 'preview', preview: publicPlan });
    assert(result.structuredContent); const json = JSON.stringify(result);
    for (const name of ['nativeBindings', 'nativeComponent', 'yjsState', 'integrityProof', 'htmlAssessmentProof']) assert(!json.includes(`"${name}"`));
  });
  family('new entry proxies/accessors reject without running traps', () => {
    const value = observation(); let traps = 0;
    const input = { sourceScope: { workspace: scope(value), fileOptions: {} }, destinationScope: { workspace: scope(value), fileOptions: {} },
      selections, sourceObservation: value.observation, destinationObservation: value.observation };
    assert.throws(() => createWorkspaceOperationManagedCopyPlanV6(new Proxy(input, { get() { traps++; throw new Error('trap'); }, getPrototypeOf() { traps++; throw new Error('trap'); } })));
    const getter = { ...input }; Object.defineProperty(getter, 'sourceObservation', { enumerable: true, get() { traps++; return value.observation; } });
    assert.throws(() => createWorkspaceOperationManagedCopyPlanV6(getter)); assert.equal(traps, 0);
  });
  family('same opaque compiler claim cannot hide changed actual original native bytes', () => {
    const value = observation(), result = stage(value), altered = result.stage.nativeRecords.map(record => ({ ...record, state: { ...record.state, yjsState: new Uint8Array(record.state.yjsState) } }));
    altered[0].state.yjsState[altered[0].state.yjsState.length - 1] ^= 1;
    assert.throws(() => replayHtmlCopyStageCompiler(result.stage.plan, altered));
    const changed = { ...result.stage.plan, integrityProof: '0'.repeat(64) }; assert.throws(() => decodeWorkspaceOperationManagedCopyPlanV6(changed));
  });
  assert.equal(groups, 15);
  console.log(JSON.stringify({ suite: 'native-copy-html-b', groups, passed: true, factsOnly: true, executionAuthority: false }));
}
workspaceOperationNativeCopyHtmlBTest();
