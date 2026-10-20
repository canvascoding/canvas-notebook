import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { createWorkspaceOperationNativeMoveBatchPlanV4, assertWorkspaceOperationNativeMoveBatchPlanCurrent }
  from '../app/lib/files/workspace-operation-native-move-plan';
import { createWorkspaceOperationOriginalMoveIntent, serializeWorkspaceOperationOriginalMoveData,
  workspaceOperationOriginalMoveNamespaceEffects, type WorkspaceOperationOriginalMoveContext }
  from '../app/lib/files/workspace-operation-original-move';
import { assertOriginalMoveFinalSourceGraph, deriveOriginalMoveSourceNamespaceFacts, readOriginalMoveCollectorOverlay,
  restoreOriginalMoveSourceCoverageOrder }
  from '../app/lib/files/workspace-operation-original-move-sources';
import type { PreparedPathMoveIdentity, PreparedWorkspacePathMoveOriginal, PreparedWorkspacePathMoveReceipt }
  from '../app/lib/filesystem/prepared-workspace-path-move-contract';
import { inspectOriginalPhysicalLinksV3, workspaceSourceAuthorityStageProof }
  from '../app/lib/markdown/workspace-physical-link-inventory';
import { nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceOperationMixedSourceEvidenceV5Fixture } from './workspace-operation-mixed-source-evidence-v5-test';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function identity(kind: 'file' | 'directory', inode: string, size: string): PreparedPathMoveIdentity {
  return { device: '1', inode, mode: kind === 'file' ? 0o100644 : 0o040755, uid: 1000, gid: 1000,
    linkCount: kind === 'file' ? '1' : '2', size, birthtimeNs: '10', mtimeNs: '100000000', ctimeNs: '100000000' };
}
function fixture() {
  const input = workspaceOperationMixedSourceEvidenceV5Fixture({ native: [],
    raw: [['page.html', '<div>Static <a href="https://example.com">external</a></div>'], ['links.md', '[Stable](stable.pdf)']],
    extra: [{ path: 'stable.pdf', kind: 'file' }] });
  const workspace: WorkspaceContext = { workspaceId: input.scope.workspaceId, workspaceType: 'personal', organizationId: null,
    rootPath: input.scope.rootPath, rootRelativePath: input.scope.rootRelativePath!, ownerUserId: input.scope.ownerUserId!, legacy: false,
    status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } };
  const plan = createWorkspaceOperationNativeMoveBatchPlanV4({ scope: { workspace, fileOptions: {} },
    actions: [{ kind: 'move', reviewId: 'direct_move', selections: [{ sourcePath: 'page.html', destinationPath: 'renamed.html' }] }],
    observation: input.observation });
  const context: WorkspaceOperationOriginalMoveContext = { batchId: 'move-html-source-fixture', requestHash: sha('request'),
    actor: { userId: 'owner', actorId: 'actor', actorType: 'user', actorSessionId: null }, plan };
  const source = input.observation.stage.sources.find(item => item.kind === 'physical' && item.inventory.path === 'page.html')!;
  assert.equal(source.kind, 'physical');
  const parts = source.inventory.physical.filesystemIdentity.split(':');
  const original: PreparedWorkspacePathMoveOriginal = { version: 1,
    workspace: { workspaceId: workspace.workspaceId, workspaceType: 'personal', organizationId: null, rootPath: workspace.rootPath },
    sourcePath: 'page.html', destinationPath: 'renamed.html', budget: { maxDepth: 32, maxEntries: 10_000, maxHashBytes: 4 * 1024 ** 3 }, caseOnlyAlias: false,
    filesystem: { root: { resolvedPath: workspace.rootPath, identity: identity('directory', '1', '4096') },
      sourceParents: { directories: [], missingPrefix: null }, destinationParents: { directories: [], missingPrefix: null } },
    source: { kind: 'regular_file', identity: identity('file', parts[1], parts[2]), sha256: source.inventory.physical.byteHash } };
  const physicalReceipt: PreparedWorkspacePathMoveReceipt = { version: 1, original, createdParents: [],
    observation: { kind: 'moved', method: 'rename-no-replace', source: { ...original.source, kind: 'regular_file',
      identity: { ...identity('file', parts[1], parts[2]), ctimeNs: '200000000' }, sha256: source.inventory.physical.byteHash } } };
  const effects = workspaceOperationOriginalMoveNamespaceEffects(context);
  const stageText = serializeWorkspaceOperationOriginalMoveData({ version: 1, batchId: context.batchId, planId: plan.planId,
    workspaceId: workspace.workspaceId, organizationId: null, requestHash: context.requestHash, actor: context.actor,
    schema: 'declared_fixture', effectsProof: nativeLinkJsonProof(effects), beforeRows: { metadata: effects.map(effect => ({
      workspaceId: workspace.workspaceId, path: effect.sourcePath, title: 'Declared title', createdAt: 1, updatedAt: 2 })),
      userStates: [], guests: [], publicShares: [], locks: [] }, lineages: [] });
  const intent = createWorkspaceOperationOriginalMoveIntent({ physical: [original], nativeBundle: null,
    namespaceState: effects.length ? { stageText, stageDigest: sha(stageText) } : null, currentWitness: input.evidence }, context);
  const compiled = assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan, input.observation, input.scope);
  const facts = deriveOriginalMoveSourceNamespaceFacts(context, [original], [physicalReceipt], []);
  const final = structuredClone(input.observation);
  final.stage.namespace.find(item => item.path === 'page.html')!.path = 'renamed.html';
  const physical = final.stage.sources.find(item => item.kind === 'physical' && item.inventory.path === 'page.html')!;
  assert.equal(physical.kind, 'physical');
  physical.inventory = inspectOriginalPhysicalLinksV3({ workspaceId: workspace.workspaceId, organizationId: null,
    path: 'renamed.html', bytes: physical.inventory.originalBytes, authority: physical.inventory.authority,
    filesystemIdentity: physical.inventory.physical.filesystemIdentity });
  final.stage.coverage.gaps = final.stage.sources.flatMap(item => item.kind === 'physical' ? item.inventory.coverage.gaps
    : item.inventory.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path })));
  final.stage.coverage.complete = final.stage.coverage.gaps.length === 0;
  final.stage.namespace.sort((a, b) => a.path.localeCompare(b.path)); final.stage.stageProof = workspaceSourceAuthorityStageProof(final.stage);
  return { workspace, original, physicalReceipt, input: { context, intent, compiled, facts, observation: final,
    nativeReceipts: [], catalogueOriginalOrder: [] } };
}

/** Actual parser/compiler/E5 and immutable original-intent codecs. All FS
 * identities and path receipts are declared data, never FD/PG/ACL authority. */
export function workspaceOperationOriginalMoveHtmlSourcesTest(): void {
  let groups = 0;
  const value = fixture(); assertOriginalMoveFinalSourceGraph(value.input);
  assert.equal(value.input.compiled.contractVersion, 5); assert.equal(value.input.observation.stage.coverage.complete, false);
  assert.equal(value.input.facts.moved[0].physicalRead?.byteHash, value.physicalReceipt.observation.kind === 'moved'
    && value.physicalReceipt.observation.source.kind === 'regular_file' ? value.physicalReceipt.observation.source.sha256 : null);
  groups++;

  const changed = fixture(); const source = changed.input.observation.stage.sources.find(item => item.kind === 'physical' && item.inventory.path === 'renamed.html')!;
  assert.equal(source.kind, 'physical');
  source.inventory = inspectOriginalPhysicalLinksV3({ workspaceId: changed.workspace.workspaceId, organizationId: null,
    path: source.inventory.path, authority: source.inventory.authority, filesystemIdentity: source.inventory.physical.filesystemIdentity,
    bytes: Buffer.from('<div>Changed <a href="https://example.com">external</a></div>') });
  changed.input.observation.stage.stageProof = workspaceSourceAuthorityStageProof(changed.input.observation.stage);
  assert.throws(() => assertOriginalMoveFinalSourceGraph(changed.input));
  groups++;

  for (const name of ['page.html', 'renamed.html.foreign']) {
    const extra = fixture(); extra.input.observation.stage.namespace.push({ workspaceId: extra.workspace.workspaceId,
      path: name, kind: 'file', identity: '1:999:0:100:100', filesystemIdentity: '1:999:0:100:100', documentId: null, lifecycleGeneration: null });
    extra.input.observation.stage.stageProof = workspaceSourceAuthorityStageProof(extra.input.observation.stage);
    assert.throws(() => assertOriginalMoveFinalSourceGraph(extra.input));
  }
  groups++;

  const mismatch = fixture(); assert.equal(mismatch.physicalReceipt.observation.kind, 'moved');
  if (mismatch.physicalReceipt.observation.kind === 'moved' && mismatch.physicalReceipt.observation.source.kind === 'regular_file') {
    const badReceipt = { ...mismatch.physicalReceipt, observation: { ...mismatch.physicalReceipt.observation,
      source: { ...mismatch.physicalReceipt.observation.source, sha256: '0'.repeat(64) } } };
    assert.throws(() => deriveOriginalMoveSourceNamespaceFacts(mismatch.input.context, [mismatch.original], [badReceipt], []),
      { code: 'ORIGINAL_MOVE_SOURCES_CHANGED' });
  } else assert.fail('Expected a real regular-file DTO in the fixture.');
  assert.equal(readOriginalMoveCollectorOverlay({} as SqlConnection, mismatch.workspace), undefined);
  groups++;

  // Genuine collection reads root files before descendants. Its original-path
  // view may therefore have identical gaps in another order after an FS move.
  // This tests the pure comparison only; no test can install the private frame.
  const ordered = workspaceOperationMixedSourceEvidenceV5Fixture({ native: [], raw: [
    ['a.html', '<div>First static source</div>'], ['z.html', '<span>Second static source</span>'],
  ] });
  const plan = createWorkspaceOperationNativeMoveBatchPlanV4({ scope: { workspace: value.workspace, fileOptions: {} },
    actions: [{ kind: 'move', reviewId: 'direct_move', selections: [{ sourcePath: 'a.html', destinationPath: 'nested/new.html' }] }],
    observation: ordered.observation });
  const fresh = structuredClone(ordered.observation);
  fresh.stage.sources.reverse(); fresh.stage.coverage.gaps.reverse();
  fresh.stage.stageProof = workspaceSourceAuthorityStageProof(fresh.stage);
  assert.throws(() => assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan, fresh, ordered.scope), { code: 'NATIVE_MOVE_PLAN_CHANGED' });
  const freshGaps = [...fresh.stage.coverage.gaps], originalGaps = ordered.observation.stage.coverage.gaps;
  const restored = restoreOriginalMoveSourceCoverageOrder(plan.sourceEvidence.coverage, fresh.stage.coverage);
  assert.deepEqual(restored, plan.sourceEvidence.coverage); assert.equal(restored.complete, false);
  assert.equal(restored.gaps[0], freshGaps[1]); assert.equal(restored.gaps[1], freshGaps[0]);
  assert.notEqual(restored.gaps[0], originalGaps[0]);
  assert.deepEqual(fresh.stage.coverage.gaps, freshGaps, 'Pure order comparison must not mutate the input.');
  fresh.stage.coverage = restored; fresh.stage.stageProof = workspaceSourceAuthorityStageProof(fresh.stage);
  const replay = assertWorkspaceOperationNativeMoveBatchPlanCurrent(plan, fresh, ordered.scope);
  assert.equal(replay.planId, plan.compilerPlanProof); assert.equal(replay.finalGraphProof, plan.finalGraphProof);
  const [first, second] = freshGaps;
  const invalid = [
    { complete: false, gaps: [first] },
    { complete: false, gaps: [first, second, { code: 'uninspected-html', path: 'extra.html' }] },
    { complete: false, gaps: [first, { ...second, code: 'unreadable-source' }] },
    { complete: false, gaps: [first, { ...second, path: 'different.html' }] },
    { complete: false, gaps: [first, { ...second, htmlTargets: ['changed.png'] }] },
    { complete: true, gaps: freshGaps },
  ];
  for (const coverage of invalid) assert.throws(() => restoreOriginalMoveSourceCoverageOrder(plan.sourceEvidence.coverage, coverage),
    { code: 'ORIGINAL_MOVE_SOURCES_CHANGED' });
  const duplicate = { complete: false, gaps: [first, first, second] };
  const duplicateFresh = { complete: false, gaps: [{ ...second }, { ...first }, { ...first }] };
  const duplicateRestored = restoreOriginalMoveSourceCoverageOrder(duplicate, duplicateFresh);
  assert.deepEqual(duplicateRestored, duplicate);
  assert.equal(duplicateRestored.gaps[0], duplicateFresh.gaps[1]); assert.equal(duplicateRestored.gaps[1], duplicateFresh.gaps[2]);
  assert.throws(() => restoreOriginalMoveSourceCoverageOrder(duplicate,
    { complete: false, gaps: [{ ...first }, { ...second }, { ...second }] }), { code: 'ORIGINAL_MOVE_SOURCES_CHANGED' });
  groups++;
  assert.equal(groups, 5);
  console.log(JSON.stringify({ suite: 'original-move-html-sources', groups, actualYjsCompiler: true, executionAuthority: false }));
}
