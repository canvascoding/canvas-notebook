import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { PreparedPathCopyIdentity, PreparedWorkspacePathCopyOriginalV3 } from '../app/lib/filesystem/prepared-workspace-path-copy-contract';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceOperationMixedSourceEvidenceV5Fixture as fixture } from './workspace-operation-mixed-source-evidence-v5-test';
import { createWorkspaceOperationManagedCopyPlanV6, decodeWorkspaceOperationManagedCopyPlanV6,
  assertWorkspaceOperationManagedCopyPlanV6Current, WorkspaceOperationManagedCopyPlanV6Error }
  from '../app/lib/files/workspace-operation-managed-copy-plan-v6';
import { prepareHtmlCopyStage, decodeHtmlCopyStage, replayHtmlCopyStageCompiler }
  from '../app/lib/files/workspace-operation-html-copy-stage';
import { captureWorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import { decodeNativeCopyMetadataSnapshot } from '../app/lib/files/workspace-operation-native-copy-metadata';
import { nativeCopyPhaseStepCount } from '../app/lib/files/workspace-operation-native-copy-phase-contract';
import { workspaceOperationNativeCopyPublicPreview } from '../app/lib/files/workspace-operation-native-copy-public';
import { formatDirectMcpWorkspaceCopyResult } from '../app/lib/mcp/server/workspace-copy-tool-contract';

// Pure format/graph/actual original-byte replay only. Empty physical asset
// payloads and detached scope/FS DTOs grant no FD/SQL/publication authority.
const emptySha = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
const workspace = (value: ReturnType<typeof fixture>): WorkspaceContext => ({ ...value.scope,
  rootRelativePath: value.scope.rootRelativePath ?? undefined,
  permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true } });
function identity(inode: string, directory = false): PreparedPathCopyIdentity {
  return { device: '1', inode, mode: directory ? 0o40700 : 0o100600, uid: 501, gid: 20,
    linkCount: directory ? '2' : '1', size: '0', birthtimeNs: '1', mtimeNs: '100000000', ctimeNs: '100000000' };
}
function build(mixed: boolean, cross: boolean) {
  const source = fixture({ workspaceId: 'asset-copy-source', native: mixed ? [['note.md', '[Picture](picture.png)\n\n[PDF](report.pdf)']] : [],
    raw: [['page.html', '<p>Unrelated <a href="picture.png">original asset</a></p>']],
    extra: [{ path: 'picture.png', kind: 'file' }, { path: 'report.pdf', kind: 'file' }] });
  const destination = cross ? fixture({ workspaceId: 'asset-copy-destination', native: [], raw: [['destination.html', '<p>Unrelated destination</p>']] }) : source;
  const selections = [{ sourcePath: 'picture.png', destinationPath: 'picture-copy.png' },
    { sourcePath: 'report.pdf', destinationPath: 'report-copy.pdf' }, ...(mixed ? [{ sourcePath: 'note.md', destinationPath: 'note-copy.md' }] : [])];
  const plan = createWorkspaceOperationManagedCopyPlanV6({ sourceScope: { workspace: workspace(source), fileOptions: {} },
    destinationScope: { workspace: workspace(destination), fileOptions: {} }, selections,
    sourceObservation: source.observation, destinationObservation: destination.observation });
  return { source, destination, selections, plan };
}
function stored(value: ReturnType<typeof build>) {
  const { source, destination, plan, selections } = value;
  const physical = selections.map((selection, selectionIndex) => {
    const entry = plan.sourceEvidence.namespace.find(entry => entry.path === selection.sourcePath)!;
    let observed: PreparedWorkspacePathCopyOriginalV3['source'] = { kind: 'projection_absent' };
    let staging: PreparedWorkspacePathCopyOriginalV3['staging'] = null;
    if (entry.documentId === null) {
      assert(entry.filesystemIdentity);
      const [device, inode, size, mtime, ctime] = entry.filesystemIdentity.split(':');
      const originalIdentity = { ...identity(inode), device, size, mtimeNs: String(BigInt(mtime) * BigInt(1_000_000)), ctimeNs: String(BigInt(ctime) * BigInt(1_000_000)) };
      observed = { kind: 'regular_file', identity: originalIdentity, sha256: emptySha };
      staging = { relativePath: `.canvas-create-${crypto.randomUUID()}.tmp`, identity: identity(String(900 + selectionIndex), true),
        payload: { kind: 'regular_file', identity: identity(String(1000 + selectionIndex)), sha256: emptySha } };
    }
    const original: PreparedWorkspacePathCopyOriginalV3 = { version: 3, sourceProjectionPolicy: 'provider-derived-files-v3', derivedFiles: [],
      sourceWorkspace: plan.sourceScope, destinationWorkspace: plan.destinationScope, ...selection,
      projectionPaths: entry.documentId === null ? [] : [selection.sourcePath],
      budget: { maxDepth: 32, maxEntries: 10_000, maxHashBytes: 4 * 1024 ** 3 },
      filesystem: { sourceRoot: { resolvedPath: source.scope.rootPath, identity: identity('90', true) },
        destinationRoot: { resolvedPath: destination.scope.rootPath, identity: identity(source === destination ? '90' : '91', true) },
        sourceParents: { directories: [], missingPrefix: null }, destinationParents: { directories: [], missingPrefix: null } }, source: observed, staging };
    return { selectionIndex, original };
  });
  const mappings = plan.nativePathPlan.pathMappings.map(mapping => ({ sourcePath: mapping.source.path, destinationPath: mapping.destinationPath }));
  const metadata = decodeNativeCopyMetadataSnapshot({ version: 1, kind: 'shared-title-copy', planId: plan.planId,
    sourceWorkspaceId: plan.sourceScope.workspaceId, destinationWorkspaceId: plan.destinationScope.workspaceId,
    mappingsProof: proof({ version: 1, kind: 'native-copy-title-mappings', planId: plan.planId, mappings }),
    vacancyScopes: selections.map(selection => selection.destinationPath).sort(), exactVacancyPaths: [], sourceRows: [] }, { plan, physical });
  const evidence = source === destination ? [source] : [source, destination];
  const nativeRecords = evidence.flatMap(value => value.observation.nativeBindings.map(binding => ({ lineageId: binding.expected.lineageId,
    state: value.observation.privateNativeStates.find(state => state.documentId === binding.expected.documentId)! })));
  const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'fixture-owner', actorId: 'fixture-owner', sessionId: 'asset-session' },
    sourceWorkspace: workspace(source), destinationWorkspace: workspace(destination) });
  const prepared = prepareHtmlCopyStage({ operationId: `asset-html-${crypto.randomUUID()}`, request: { kind: 'copy', origin, selections }, plan, physical, nativeRecords, metadata });
  return decodeHtmlCopyStage(prepared.manifest, prepared.recordsBytes, prepared.manifest.identity);
}
export function nativeCopyHtmlAssetsTest(): void {
  let groups = 0;
  for (const mixed of [false, true]) for (const cross of [false, true]) {
    const value = build(mixed, cross), before = structuredClone([value.source.observation, value.destination.observation]);
    const { plan } = value;
    assert.equal(plan.version, 6); assert.equal(plan.sourceEvidence.evidenceVersion, 5);
    assert.equal(plan.cloneRequirements.length, mixed ? 1 : 0); assert.equal(plan.sceneCopyRequirements.length, 0);
    assert.equal(plan.readiness, mixed ? 'requires-provider-publication' : 'ready');
    assert.deepEqual(decodeWorkspaceOperationManagedCopyPlanV6(JSON.parse(JSON.stringify(plan))), plan);
    const compiled = assertWorkspaceOperationManagedCopyPlanV6Current(plan, { sourceScope: plan.sourceScope, destinationScope: plan.destinationScope,
      sourceObservation: value.source.observation, destinationObservation: value.destination.observation });
    assert.equal(compiled.contractVersion, 5); assert.equal(compiled.cloneRequirements.length, mixed ? 1 : 0);
    assert.equal(compiled.finalNamespace.filter(entity => entity.binding.kind === 'unbound-copy' && entity.contentBasisProof === null).length, 2);
    const original = stored(value), replay = replayHtmlCopyStageCompiler(original.plan, original.nativeRecords);
    assert.equal(original.version, 7); assert.deepEqual(replay, compiled);
    assert.equal(nativeCopyPhaseStepCount(original), value.selections.length + new Set(compiled.steps[0].linkIntents.map(intent => intent.entityKey)).size + 1);
    if (!mixed) { assert.deepEqual(original.nativeRecords, []); assert.deepEqual(replay.cloneRequirements, []); }
    else assert.deepEqual(new Set(plan.nativePathPlan.mutations.map(recipe => recipe.nextValue)), new Set(['picture-copy.png', 'report-copy.pdf']));
    const page = workspaceOperationNativeCopyPublicPreview(plan); assert.equal(page.version, 5);
    assert.equal(page.coverage.complete, false); assert.equal(page.linkAssessment?.complete, true);
    assert(formatDirectMcpWorkspaceCopyResult({ apiVersion: 1, action: 'preview', preview: page }).structuredContent);
    assert.deepEqual([value.source.observation, value.destination.observation], before);
    // The ordinary-asset exception is never a raw Markdown/HTML import gate.
    for (const selected of ['page.html', 'raw.md']) {
      const rawSource = fixture({ native: [], raw: [['page.html', '<p>Safe</p>'], ['raw.md', '# Still raw']] });
      assert.throws(() => createWorkspaceOperationManagedCopyPlanV6({ sourceScope: { workspace: workspace(rawSource), fileOptions: {} },
        destinationScope: { workspace: workspace(rawSource), fileOptions: {} }, selections: [{ sourcePath: selected, destinationPath: `copy-${selected}` }],
        sourceObservation: rawSource.observation, destinationObservation: rawSource.observation }), error => error instanceof WorkspaceOperationManagedCopyPlanV6Error
          && ['MANAGED_COPY_PLAN_IMPORT_REQUIRED', 'MANAGED_COPY_PLAN_UNSUPPORTED'].includes(error.code));
    }
    groups++; console.log(`PASS native-copy-html-assets ${groups}: ${mixed ? 'native+PNG+PDF' : 'PNG+PDF only'} ${cross ? 'cross-workspace' : 'same-workspace'} beside unchanged HTML`);
  }
  // Descendant mappings must retain ordinary assets inside the native folder,
  // while unrelated HTML stays outside the selected subtree.
  {
    const source = fixture({ workspaceId: 'asset-folder-source', native: [['folder/note.md', '[Picture](picture.png)\n\n[PDF](report.pdf)']],
      raw: [['unrelated.html', '<p>Unrelated</p>']], extra: [{ path: 'folder/picture.png', kind: 'file' }, { path: 'folder/report.pdf', kind: 'file' }] });
    const destination = fixture({ workspaceId: 'asset-folder-destination', native: [], raw: [['other.html', '<p>Other</p>']] });
    const plan = createWorkspaceOperationManagedCopyPlanV6({ sourceScope: { workspace: workspace(source), fileOptions: {} },
      destinationScope: { workspace: workspace(destination), fileOptions: {} }, selections: [{ sourcePath: 'folder', destinationPath: 'folder-copy' }],
      sourceObservation: source.observation, destinationObservation: destination.observation });
    assert.equal(plan.cloneRequirements.length, 1); assert.equal(plan.sceneCopyRequirements.length, 0);
    assert.deepEqual(new Set(plan.nativePathPlan.pathMappings.map(mapping => mapping.destinationPath)),
      new Set(['folder-copy', 'folder-copy/note.md', 'folder-copy/picture.png', 'folder-copy/report.pdf']));
    assert.deepEqual(decodeWorkspaceOperationManagedCopyPlanV6(JSON.parse(JSON.stringify(plan))), plan);
    const compiled = assertWorkspaceOperationManagedCopyPlanV6Current(plan, { sourceScope: plan.sourceScope, destinationScope: plan.destinationScope,
      sourceObservation: source.observation, destinationObservation: destination.observation });
    assert.equal(compiled.steps[0].linkIntents.length, 0, 'Copied relative asset targets already retain their exact spelling.');
    groups++; console.log('PASS native-copy-html-assets 5: native+PNG+PDF folder cross-workspace beside unrelated HTML');
  }
  assert.equal(groups, 5);
  console.log(JSON.stringify({ suite: 'native-copy-html-assets', groups, passed: true, factsOnly: true, executionAuthority: false }));
}
nativeCopyHtmlAssetsTest();
