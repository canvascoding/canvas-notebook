import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import type { SqlConnection } from '../app/lib/db';
import { captureCollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { captureAgentStateSnapshot } from '../app/lib/collaboration/agent-durability';
import { inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { prepareNativeFileArchiveTransition } from '../app/lib/collaboration/native-file-archive-transition';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import type { PreparedSingleFileTrashIdentity, PreparedSingleFileTrashOriginalFacts,
  PreparedSingleFileTrashReceipt } from '../app/lib/filesystem/prepared-single-file-trash';
import { trashRelativePathFor } from '../app/lib/filesystem/workspace-trash-layout';
import type { WorkspaceOperationBatchScope, WorkspaceOperationNativeDeleteBatchPlanLegacy,
  WorkspaceOperationNativeDeleteBatchPlanV2 } from '../app/lib/files/workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { createWorkspaceOperationNativeDeleteBatchPlanLegacy, createWorkspaceOperationNativeDeleteBatchPlanV2,
  captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness } from '../app/lib/files/workspace-operation-native-delete-plan';
import { assertOriginalDeleteIntentPlan, captureOriginalDeleteAdmissionBinding, completed, parseIntent, type Completion, type OriginalIntent,
  type WorkspaceOperationOriginalDeleteEvidenceContext } from '../app/lib/files/workspace-operation-original-delete-evidence';
import { createWorkspaceOperationOriginalDeleteAdmissionRequest, readWorkspaceOperationOriginalDeleteAdmissionOnConnection,
  workspaceOperationOriginalDeleteAdmissionResult } from '../app/lib/files/workspace-operation-original-delete-admission';
import type { WorkspaceOperationBatchClaimBinding } from '../app/lib/files/workspace-operation-batch-store';
import { workspaceOperationBatchTotalActions } from '../app/lib/files/workspace-operation-native-delete-effects';
import { prepareOriginalDeleteNativeLinks, type OriginalDeleteNativeLinkContext,
  type OriginalDeleteNativeLinkReceipt } from '../app/lib/files/workspace-operation-original-delete-links';
import type { WorkspaceOperationOriginalDeleteIntent, WorkspaceOperationOriginalDeleteReceipt } from '../app/lib/files/workspace-operation-original-delete-repository';
import { inspectNativeDocumentLinks, nativeLinkJsonProof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';

// Actual Yjs, native compiler, V2 witness and historical codecs. Registry,
// filesystem, journal rows and provisional completion below are declared data.
// No SQL, current ACL, FD capability, Owner, mutation or COMMIT is proven here.
type Mutable<T> = T extends Uint8Array ? Uint8Array : T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
const clone = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const dataRoot = '/fixture/data';
const scope: WorkspaceOperationBatchScope = { workspace: {
  workspaceId: 'delete-v3-workspace', workspaceType: 'personal', organizationId: null, ownerUserId: 'fixture-user',
  rootRelativePath: 'users/fixture/delete-v3-workspace/files', rootPath: `${dataRoot}/users/fixture/delete-v3-workspace/files`,
  legacy: false, status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
    canManageWorkspace: true, canCreatePublicLinks: false },
}, fileOptions: {} };
const sourcePath = 'victim.md', batchId = 'delete-v3-factual-fixture', requestHash = sha('declared direct request');
const actor = { userId: 'fixture-user', actorId: 'fixture-user', actorType: 'user' as const, actorSessionId: 'fixture-session' };
const actions = [{ reviewId: 'delete-v3-action', kind: 'delete' as const, selections: [{ sourcePath }] }];
const trashEntryId = 'trash-11111111-1111-4111-8111-111111111111';
const identity: PreparedSingleFileTrashIdentity = { device: 1, inode: 9, size: 11, mode: 0o100600, uid: 501, gid: 20,
  linkCount: 1, birthtimeMs: 50, mtimeMs: 100, ctimeMs: 100 };
const fingerprint = (value: PreparedSingleFileTrashIdentity) => `${value.device}:${value.inode}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
type Observation = Mutable<WorkspaceLinkSourceAuthorityObservation> & { privateCatalogue: WorkspaceDocumentCatalogueEntry[] };

function native(path: string, representation: PersistedCollaborationState['representation'], content: string): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc(content) : createRichMarkdownYDoc(content, representation);
  try { return { documentId: `document:${path}`, workspaceId: scope.workspace.workspaceId, organizationId: null, path,
    representation, schemaVersion: 1, lifecycleGeneration: 1, documentSequence: 7, persistedAt: 100,
    checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false,
    degraded: false, status: 'active', yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) }; }
  finally { doc.destroy(); }
}
function observation(states: PersistedCollaborationState[], projected: boolean): Observation {
  const inventories = states.map(state => inspectPersistedNativeCollaborationSnapshot(state, inspectNativeDocumentLinks));
  const nativeBindings: WorkspaceNativeSourceBinding[] = states.map((state, index) => {
    const lineageId = `lineage:${state.path}`, registryStateVersion = projected ? 7 : 6;
    return { expected: { documentId: state.documentId, lineageId, workspaceId: state.workspaceId, organizationId: null, path: state.path,
      representation: state.representation, schemaVersion: state.schemaVersion, lifecycleGeneration: state.lifecycleGeneration,
      registryStateVersion, documentSequence: state.documentSequence, persistedAt: state.persistedAt,
      stateProof: inventories[index].version.stateProof, binaryHash: sha(state.yjsState), vectorHash: sha(state.stateVector) },
    registry: { documentId: state.documentId, lineageId, workspaceId: state.workspaceId, workspaceType: 'personal', organizationId: null,
      customerId: null, projectId: null, path: state.path, provider: 'yjs', stateLifecycle: 'initialized', stateVersion: registryStateVersion, status: 'active' },
    lineage: { lineageId, workspaceId: state.workspaceId, workspaceType: 'personal', organizationId: null, customerId: null,
      projectId: null, path: state.path, status: 'active', archivedAt: null, trashEntryId: null },
    byteProfile: { newlineStyle: state.newlineStyle, hasBom: state.hasBom }, inventoryProof: nativeLinkJsonProof(inventories[index]) };
  });
  const privateCatalogue: WorkspaceDocumentCatalogueEntry[] = nativeBindings.map(({ expected }) => ({ id: expected.documentId,
    lineage_id: expected.lineageId, workspace_id: expected.workspaceId, organization_id: null, path: expected.path, status: 'active',
    state_version: expected.registryStateVersion, yjs_state_lifecycle: 'initialized', has_persisted_state: true, has_state_history: true,
    lifecycle_generation: expected.lifecycleGeneration, authority: 'initialized', state_status: 'active', state_path: expected.path,
    state_workspace_id: expected.workspaceId, state_organization_id: null }));
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: scope.workspace.workspaceId,
    organizationId: null, catalogueProof: nativeLinkJsonProof(privateCatalogue),
    namespace: states.map(state => ({ workspaceId: state.workspaceId, path: state.path, kind: 'file',
      identity: `registry:${state.documentId}:${state.lifecycleGeneration}`, documentId: state.documentId, lifecycleGeneration: state.lifecycleGeneration,
      filesystemIdentity: fingerprint({ ...identity, inode: projected ? 9 : 8 }) })),
    sources: inventories.map(inventory => ({ kind: 'native', inventory })), scope: { kind: 'visible-workspace', excludedPaths: [] },
    coverage: { complete: true, gaps: [] }, readiness: 'native-coordinator-required', executionReady: false };
  return clone({ stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) }, nativeBindings,
    privateNativeStates: states, privateCatalogue });
}
function physical(): PreparedSingleFileTrashOriginalFacts {
  const directory = { ...identity, mode: 0o40700, size: 0, linkCount: 2 };
  const trashRelativePath = trashRelativePathFor(scope.workspace, trashEntryId, sourcePath);
  return { version: 1, workspace: { workspaceId: scope.workspace.workspaceId, workspaceType: 'personal', organizationId: null,
    rootPath: scope.workspace.rootPath, dataRoot }, canonicalPath: sourcePath, trashEntryId,
  trashRelativePath, deletedAtMs: 200, retentionDays: 30,
  expiresAtMs: 200 + 30 * 86400000,
  filesystem: { workspaceRoot: { resolvedPath: scope.workspace.rootPath, identity: { ...directory, inode: 3 } },
    dataRoot: { resolvedPath: dataRoot, identity: { ...directory, inode: 2 } }, sourceDirectories: [],
    trashDirectories: trashRelativePath.split('/').slice(0, -1).map((segment, index) => ({ segment, identity: { ...directory, inode: 20 + index } })),
    missingSourcePrefix: null },
  source: { kind: 'regular_file', identity, sha256: sha('projection\n') } };
}
function row(intent: OriginalIntent, workspaceId = scope.workspace.workspaceId): WorkspaceOperationOriginalDeleteIntent {
  const intentText = JSON.stringify(intent);
  return { batchId: intent.batchId, planId: intent.planId, workspaceId, requestHash: intent.requestHash,
    intentText, intentDigest: sha(intentText), createdAt: 201 };
}
function receipt(intentDigest: string, value: unknown): WorkspaceOperationOriginalDeleteReceipt {
  const receiptText = JSON.stringify(value);
  return { batchId, intentDigest, receiptText, receiptDigest: sha(receiptText), createdAt: 202 };
}
function context(plan: WorkspaceOperationNativeDeleteBatchPlanV2 | WorkspaceOperationNativeDeleteBatchPlanLegacy): WorkspaceOperationOriginalDeleteEvidenceContext {
  return { batchId, planId: plan.planId, workspaceId: scope.workspace.workspaceId, sourcePath,
    authorization: { mode: 'direct', actorUserId: actor.userId, actorId: actor.actorId, actorType: actor.actorType,
      actorDisplayName: 'Factual fixture', actorSessionId: actor.actorSessionId, requestHash,
      jobScope: captureWorkspaceOperationJobScope(scope.workspace) } };
}
function fixture(representation: PersistedCollaborationState['representation'] = 'tiptap_blocks', links = false) {
  const states = [native(sourcePath, representation, '# Victim'), native('keep.md', representation, '# Keep')];
  if (links) states.push(native('incoming.md', representation, '[Victim](victim.md) and [Keep](keep.md)\n\nUnchanged paragraph.'));
  const before = observation(states, false), current = observation(states.map(state => ({ ...state,
    checkpointSequence: 7, checkpointedAt: 150, canonicalHash: 'a'.repeat(64), serializedHash: 'b'.repeat(64) })), true);
  const plan = createWorkspaceOperationNativeDeleteBatchPlanV2({ scope, actions, observation: before });
  const currentWitness = captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(plan, current, captureWorkspaceOperationJobScope(scope.workspace));
  const linkContext: OriginalDeleteNativeLinkContext = { batchId, workspaceId: scope.workspace.workspaceId, sourcePath, requestHash, actor };
  const nativeLinks = prepareOriginalDeleteNativeLinks(plan, current, linkContext);
  const intent: OriginalIntent = { version: 3, batchId, planId: plan.planId, requestHash, actor,
    jobScope: captureWorkspaceOperationJobScope(scope.workspace), physical: physical(), native: currentWitness.nativeBindings[0].expected,
    publicShare: null, currentWitness, nativeLinks };
  return { plan, before, current, intent, context: context(plan) };
}
type Fixture = ReturnType<typeof fixture>;
function parseAndBind(f: Fixture, intent: OriginalIntent = f.intent): OriginalIntent {
  const parsed = parseIntent(row(intent), f.context, scope.workspace, dataRoot);
  assertOriginalDeleteIntentPlan(parsed, f.plan); return parsed;
}
function linkReceipts(f: Fixture, intent: OriginalIntent): OriginalDeleteNativeLinkReceipt[] {
  return (intent.nativeLinks ?? []).map(item => {
    const state = f.current.privateNativeStates.find(value => value.documentId === item.prepared.source.documentId)!;
    return inspectPersistedNativeCollaborationSnapshot(state, before => {
      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(before)); Y.applyUpdate(candidate, Buffer.from(item.prepared.updateBase64, 'base64'));
        const snapshot = captureAgentStateSnapshot(candidate, Y); assert(snapshot);
        const fullUpdate = Y.encodeStateAsUpdate(candidate), vector = Y.encodeStateVector(candidate);
        assert.equal(`yjs-snapshot-sha256-v1:${sha(snapshot)}`, item.prepared.after.stateProof);
        assert.equal(Buffer.from(vector).toString('base64'), item.prepared.after.stateVector);
        return { contractVersion: 2, operationId: item.prepared.operationId, source: item.prepared.source, binding: item.binding,
          before: item.prepared.before, after: { ...item.prepared.after, documentSequence: item.prepared.before.documentSequence + 1, persistedAt: 201 },
          inverseRecipes: item.prepared.inverseRecipes, afterStateSnapshotBase64: Buffer.from(snapshot).toString('base64'),
          ...(intent.version === 3 || intent.version === 4 ? { resultEvidenceVersion: 3 as const, afterBinaryHash: sha(fullUpdate), afterVectorHash: sha(vector) } : {}) };
      } finally { candidate.destroy(); }
    });
  });
}
function completion(f: Fixture, intent: OriginalIntent = f.intent) {
  const durable = row(intent), physicalReceipt: PreparedSingleFileTrashReceipt = { version: 1, original: intent.physical,
    observation: { kind: 'moved', method: 'rename', identity: { ...identity, ctimeMs: 200 }, sha256: sha('projection\n') } };
  assert(intent.native);
  const transition = prepareNativeFileArchiveTransition(f.current.privateNativeStates[0], intent.native,
    { trashEntryId, archivedAt: intent.physical.deletedAtMs });
  const trash = receipt(durable.intentDigest, physicalReceipt);
  const value: Completion = { version: intent.version, batchId, intentDigest: durable.intentDigest, trashEntryId,
    physical: physicalReceipt, native: transition, publicShare: { kind: 'none' }, trashReceiptDigest: trash.receiptDigest,
    ...(intent.version !== 1 ? { nativeLinks: linkReceipts(f, intent) } : {}) };
  return { durable, trash, value, completed: receipt(durable.intentDigest, value) };
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  test(`Original Delete V3 ${representation}: genuine V2 plan/current witness admits no-link historical intent and completion`, () => {
    const f = fixture(representation), before = clone(f);
    const parsed = parseAndBind(f); assert.equal(parsed.version, 3); assert.deepEqual(parsed.nativeLinks, []);
    assert.equal(parsed.native!.registryStateVersion, 7); assert.equal(f.plan.nativeTarget.registryStateVersion, 6);
    const result = completion(f, parsed), actual = completed(result.completed, result.trash, result.durable, parsed);
    assert.deepEqual(actual, { ...result.value, receiptDigest: result.completed.receiptDigest });
    assert(Object.isFrozen(parsed)); assert(Object.isFrozen(actual.native!.before.clock)); assert.deepEqual(f, before);
  });
  test(`Original Delete V3 ${representation}: real native link deltas carry separate full-update and vector evidence`, () => {
    const f = fixture(representation, true), parsed = parseAndBind(f), result = completion(f, parsed);
    const actual = completed(result.completed, result.trash, result.durable, parsed), link = actual.nativeLinks![0];
    assert.equal(actual.nativeLinks!.length, 1); assert.equal(link.resultEvidenceVersion, 3);
    assert.equal(link.afterVectorHash, sha(Buffer.from(link.after.stateVector, 'base64')));
    assert.notEqual(link.afterBinaryHash, sha(Buffer.from(link.afterStateSnapshotBase64, 'base64')),
      'A content-free SV/DeleteSet snapshot is never the complete native update.');
    assert.deepEqual(parseAndBind(f), parsed);
  });
}

test('Original Delete V3: old V1/V2 intent/completion exact shapes remain distinct and decode without new fields', () => {
  for (const links of [false, true]) {
    const f = fixture('tiptap_blocks', links), legacyPlan = createWorkspaceOperationNativeDeleteBatchPlanLegacy({ scope, actions, observation: f.current });
    const { currentWitness: _witness, nativeLinks, ...fields } = clone(f.intent);
    const legacy: OriginalIntent = { ...fields, version: links ? 2 : 1, planId: legacyPlan.planId, ...(links ? { nativeLinks } : {}) };
    const parsed = parseIntent(row(legacy), context(legacyPlan), scope.workspace, dataRoot); assertOriginalDeleteIntentPlan(parsed, legacyPlan);
    assert.deepEqual(parsed, legacy); assert(!Object.hasOwn(parsed, 'currentWitness'));
    const result = completion(f, parsed), actual = completed(result.completed, result.trash, result.durable, parsed);
    assert.equal(actual.version, links ? 2 : 1);
    assert.deepEqual(Object.keys(parsed).sort(), ['version', 'batchId', 'planId', 'requestHash', 'actor', 'jobScope', 'physical', 'native', 'publicShare',
      ...(links ? ['nativeLinks'] : [])].sort());
    assert.throws(() => parseIntent(row({ ...legacy, currentWitness: f.intent.currentWitness } as never), context(legacyPlan), scope.workspace, dataRoot));
    assert.throws(() => assertOriginalDeleteIntentPlan(f.intent, legacyPlan));
    assert.throws(() => assertOriginalDeleteIntentPlan(parsed, f.plan));
    if (links) assert.equal(Object.hasOwn(actual.nativeLinks![0], 'resultEvidenceVersion'), false);
  }
});

test('Original Delete V3: renewed outer digests cannot hide physical original, witness, target or recipe contradictions', () => {
  const f = fixture('tiptap_blocks', true);
  const attacks: Array<(intent: Mutable<OriginalIntent>) => void> = [
    value => { assert.equal(value.physical.source.kind, 'regular_file'); if (value.physical.source.kind === 'regular_file') value.physical.source.identity.inode++; },
    value => { value.physical.source = { kind: 'projection_absent' }; },
    value => { value.physical.canonicalPath = 'other.md'; },
    value => { value.native = null; },
    value => { value.native!.binaryHash = '0'.repeat(64); },
    value => { value.native!.registryStateVersion = 6; },
    value => { assert.equal(value.version, 3); if (value.version === 3) value.currentWitness.semanticProof = '0'.repeat(64); },
    value => { value.nativeLinks = []; },
    value => { value.nativeLinks![0].binding.requestHash = '0'.repeat(64); },
    value => { value.nativeLinks![0].prepared.inverseRecipes[0].authorizedForwardRecipeProof = '0'.repeat(64); },
  ];
  for (const attack of attacks) {
    const changed = clone(f.intent); attack(changed); assert.notEqual(row(changed).intentDigest, row(f.intent).intentDigest);
    assert.throws(() => parseAndBind(f, changed));
  }
  const other = fixture('tiptap_blocks', true), foreignWitness = clone(f.intent);
  assert.equal(foreignWitness.version, 3); assert.equal(other.intent.version, 3);
  if (foreignWitness.version === 3 && other.intent.version === 3) {
    foreignWitness.currentWitness = clone(other.intent.currentWitness); foreignWitness.native = clone(other.intent.native);
    assert.throws(() => parseAndBind(f, foreignWitness), /ORIGINAL_DELETE_UNPROVEN/u);
  }
  const foreignRecipes = clone(f.intent); foreignRecipes.nativeLinks = clone(other.intent.nativeLinks);
  assert.throws(() => parseAndBind(f, foreignRecipes));
});

test('Original Delete V3: no-link fields and exact version discrimination reject incomplete or mixed historical payloads', () => {
  const f = fixture(), original = row(f.intent), value = clone(f.intent) as Record<string, unknown>;
  for (const key of ['nativeLinks', 'currentWitness']) {
    const changed = { ...value }; delete changed[key];
    assert.throws(() => parseIntent(row(changed as OriginalIntent), f.context, scope.workspace, dataRoot));
  }
  for (const change of [{ version: 2 }, { version: 1 }, { version: 4 }, { unknown: true }]) {
    assert.throws(() => parseIntent(row({ ...value, ...change } as OriginalIntent), f.context, scope.workspace, dataRoot));
  }
  assert.equal(row(f.intent).intentDigest, original.intentDigest);
});

const beforeAttacks: Array<[string, (value: Mutable<Completion>) => void]> = [
  ['document id', value => { value.native!.before.identity.documentId = 'other'; }],
  ['lineage id', value => { value.native!.before.identity.lineageId = 'other'; }],
  ['workspace id', value => { value.native!.before.identity.workspaceId = 'other'; }],
  ['organization id', value => { value.native!.before.identity.organizationId = 'other'; }],
  ['path', value => { value.native!.before.identity.path = 'other.md'; }],
  ['representation', value => { value.native!.before.identity.representation = 'plain_text'; }],
  ['schema', value => { value.native!.before.identity.schemaVersion++; }],
  ['generation', value => { value.native!.before.identity.lifecycleGeneration++; }],
  ['registry version', value => { value.native!.before.registryStateVersion--; }],
  ['full binary hash', value => { value.native!.before.clock.binaryHash = '0'.repeat(64); }],
  ['vector hash', value => { value.native!.before.clock.vectorHash = '0'.repeat(64); }],
  ['document sequence', value => { value.native!.before.clock.documentSequence++; }],
  ['persisted time', value => { value.native!.before.clock.persistedAt++; }],
];
for (const [label, attack] of beforeAttacks) test(`Original Delete V3: renewed receipt digest cannot forge Archive before ${label}`, () => {
  const f = fixture(), parsed = parseAndBind(f), result = completion(f, parsed), changed = clone(result.value);
  attack(changed); const forged = receipt(result.durable.intentDigest, changed);
  assert.notEqual(forged.receiptDigest, result.completed.receiptDigest);
  assert.throws(() => completed(forged, result.trash, result.durable, parsed), /ORIGINAL_DELETE_UNPROVEN/u);
});

test('Original Delete V3: Archive after generation, clocks, registry state and terminal status remain bound', () => {
  const f = fixture(), parsed = parseAndBind(f), result = completion(f, parsed);
  for (const attack of [
    (value: Mutable<Completion>) => { value.native!.after.identity.lifecycleGeneration++; },
    (value: Mutable<Completion>) => { value.native!.after.clock.binaryHash = '0'.repeat(64); },
    (value: Mutable<Completion>) => { value.native!.after.clock.vectorHash = '0'.repeat(64); },
    (value: Mutable<Completion>) => { value.native!.after.clock.documentSequence++; },
    (value: Mutable<Completion>) => { value.native!.after.clock.persistedAt++; },
    (value: Mutable<Completion>) => { Object.assign(value.native!.after, { registryStateVersion: 1 }); },
    (value: Mutable<Completion>) => { Object.assign(value.native!.after, { status: 'active' }); },
  ]) {
    const changed = clone(result.value); attack(changed);
    assert.throws(() => completed(receipt(result.durable.intentDigest, changed), result.trash, result.durable, parsed), /ORIGINAL_DELETE_UNPROVEN/u);
  }
});

test('Original Delete V3: full-update result fields are mandatory and snapshots cannot replace either vector or containment evidence', () => {
  const f = fixture('tiptap_blocks', true), parsed = parseAndBind(f), result = completion(f, parsed);
  for (const attack of [
    (link: Mutable<OriginalDeleteNativeLinkReceipt>) => { delete link.resultEvidenceVersion; },
    (link: Mutable<OriginalDeleteNativeLinkReceipt>) => { delete link.afterBinaryHash; },
    (link: Mutable<OriginalDeleteNativeLinkReceipt>) => { delete link.afterVectorHash; },
    (link: Mutable<OriginalDeleteNativeLinkReceipt>) => { Object.assign(link, { resultEvidenceVersion: 2 }); },
    (link: Mutable<OriginalDeleteNativeLinkReceipt>) => { link.afterBinaryHash = 'not-a-full-update-sha256'; },
    (link: Mutable<OriginalDeleteNativeLinkReceipt>) => { link.afterVectorHash = sha(Buffer.from(link.afterStateSnapshotBase64, 'base64')); },
    (link: Mutable<OriginalDeleteNativeLinkReceipt>) => { link.afterStateSnapshotBase64 = link.after.stateVector; },
  ]) {
    const changed = clone(result.value); attack(changed.nativeLinks![0]);
    assert.throws(() => completed(receipt(result.durable.intentDigest, changed), result.trash, result.durable, parsed), /ORIGINAL_DELETE_UNPROVEN/u);
  }
  // Historical decoding has no current complete source bytes with which to
  // recompute afterBinaryHash. The real B2 replay/readback/final-graph gate must
  // prove that value; a well-formed private hash alone grants no authority.
});

/** Declared data only. The pure factory accepts this factual DTO; it is never
 * passed to a Store or represented as a genuine Claim, ACL, B or SQL receipt. */
function fixtureV4(representation: PersistedCollaborationState['representation'] = 'tiptap_blocks', links = false) {
  const base = fixture(representation, links);
  assert(base.intent.version === 3); assert(base.context.authorization.mode === 'direct');
  const binding: WorkspaceOperationBatchClaimBinding = { batchId, planId: base.plan.planId,
    workspaceId: scope.workspace.workspaceId, plan: base.plan, authorization: base.context.authorization,
    actionMode: 'apply', totalActions: workspaceOperationBatchTotalActions(base.plan), createdAt: 199,
    reviewIds: [], reviewRefs: [], reviewerUserId: null, reviewerDisplayName: null,
    source: { databaseOid: 1, schemaOid: 2, schemaName: 'declared_fixture', tableOid: 3, searchPath: 'declared_fixture' } };
  const request = createWorkspaceOperationOriginalDeleteAdmissionRequest(binding), captured = captureCollaborationAdmissionRequest(request);
  const intent: Extract<OriginalIntent, { version: 4 }> = { ...base.intent, version: 4,
    admission: { requestId: captured.request.requestId, requestDigest: captured.requestDigest } };
  return { base, binding, intent, captured };
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
  for (const links of [false, true]) test(`Original Delete V4 ${representation}: factual P0 binding, ${links ? 'linked' : 'unlinked'} intent and genuine-Yjs completion`, () => {
    const f = fixtureV4(representation, links), before = clone(f);
    const parsed = parseAndBind(f.base, f.intent); assert(parsed.version === 4);
    assert.deepEqual(parsed.admission, { requestId: f.captured.request.requestId, requestDigest: f.captured.requestDigest });
    assert.equal(Reflect.ownKeys(parsed).length, 12); assert(Object.isFrozen(parsed.admission));
    assert.deepEqual(parsed.currentWitness, f.intent.currentWitness);
    const result = completion(f.base, parsed), actual = completed(result.completed, result.trash, result.durable, parsed);
    assert.equal(actual.version, 4); assert.deepEqual(actual, { ...result.value, receiptDigest: result.completed.receiptDigest });
    assert.equal(actual.nativeLinks!.length, links ? 1 : 0);
    assert.deepEqual(actual.native!.before.clock, { stateProof: parsed.native!.stateProof, binaryHash: parsed.native!.binaryHash,
      vectorHash: parsed.native!.vectorHash, documentSequence: parsed.native!.documentSequence, persistedAt: parsed.native!.persistedAt });
    if (links) {
      const link = actual.nativeLinks![0]; assert.equal(link.resultEvidenceVersion, 3);
      assert.equal(link.afterVectorHash, sha(Buffer.from(link.after.stateVector, 'base64')));
      assert.notEqual(link.afterBinaryHash, sha(Buffer.from(link.afterStateSnapshotBase64, 'base64')));
      for (const key of ['resultEvidenceVersion', 'afterBinaryHash', 'afterVectorHash'] as const) {
        const changed = clone(result.value); delete changed.nativeLinks![0][key];
        assert.throws(() => completed(receipt(result.durable.intentDigest, changed), result.trash, result.durable, parsed), /ORIGINAL_DELETE_UNPROVEN/u);
      }
    }
    assert(Object.isFrozen(actual)); assert.deepEqual(f, before);
  });
}

test('Original Delete V4: Admission binding requires exactly two own bounded primitive data fields without running hostile accessors', () => {
  const { intent } = fixtureV4(), valid = intent.admission, before = clone(valid);
  const captured = captureOriginalDeleteAdmissionBinding(valid);
  assert.deepEqual(captured, valid); assert.notEqual(captured, valid); assert(Object.isFrozen(captured));
  let observed = 0;
  const getter = Object.defineProperty({ requestDigest: valid.requestDigest }, 'requestId',
    { enumerable: true, get() { observed++; throw new Error('Admission getter must never run.'); } });
  const proxy = new Proxy({ ...valid }, { get() { observed++; throw new Error('Admission proxy must never run.'); },
    ownKeys() { observed++; throw new Error('Admission proxy keys must never run.'); } });
  const hidden = Object.defineProperty({ requestDigest: valid.requestDigest }, 'requestId', { value: valid.requestId, enumerable: false });
  const inherited = Object.create(valid);
  const attacks: unknown[] = [null, [], Object.assign(Object.create(null), valid), getter, proxy, hidden, inherited,
    { requestId: valid.requestId }, { requestDigest: valid.requestDigest }, { ...valid, extra: true },
    { ...valid, [Symbol('extra')]: true }, { ...valid, requestId: `${valid.requestId}\n` },
    { ...valid, requestId: 'not-an-admission-id' }, { ...valid, requestId: 'G'.repeat(36) },
    { ...valid, requestId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA' },
    { ...valid, requestId: 123 }, { ...valid, requestDigest: `${valid.requestDigest}\n` },
    { ...valid, requestDigest: 'g'.repeat(64) }, { ...valid, requestDigest: 'A'.repeat(64) }, { ...valid, requestDigest: 'a'.repeat(63) },
    { ...valid, requestDigest: 'a'.repeat(65) }, { ...valid, requestDigest: 123 }];
  for (const attack of attacks) assert.throws(() => captureOriginalDeleteAdmissionBinding(attack), /ORIGINAL_DELETE_UNPROVEN/u);
  assert.equal(observed, 0); assert.deepEqual(valid, before);
});

test('Original Delete V4: well-formed foreign Admission ID or SHA fails the actual reader preflight before every SQL method', async () => {
  const f = fixtureV4(), parsed = parseAndBind(f.base, f.intent); assert(parsed.version === 4);
  let calls = 0;
  // A negative mechanical boundary only: no returned SQL rows, fake authority,
  // transaction, current ACL or positive reader acceptance is supplied here.
  const forbidden: SqlConnection = { get() { calls++; assert.fail('V4 negative preflight attempted SQL get.'); },
    all() { calls++; assert.fail('V4 negative preflight attempted SQL all.'); },
    run() { calls++; assert.fail('V4 negative preflight attempted SQL run.'); },
    close() { calls++; assert.fail('V4 negative preflight attempted SQL close.'); } };
  const wrongId = parsed.admission.requestId === '00000000-0000-0000-0000-000000000000'
    ? '11111111-1111-1111-1111-111111111111' : '00000000-0000-0000-0000-000000000000';
  const wrongSha = parsed.admission.requestDigest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  for (const reference of [{ ...parsed.admission, requestId: wrongId }, { ...parsed.admission, requestDigest: wrongSha }]) {
    assert.deepEqual(captureOriginalDeleteAdmissionBinding(reference), reference, 'Format alone conveys no original-request binding.');
    const changed = { ...parsed, admission: reference };
    await assert.rejects(readWorkspaceOperationOriginalDeleteAdmissionOnConnection(forbidden,
      { schema: 'declared_fixture', intent: changed }), /ORIGINAL_DELETE_UNPROVEN/u);
    assert.equal(calls, 0);
  }
});

test('Original Delete V4: V3/V4 intent shapes, receipt versions, original digest and witness cannot be mixed after renewing envelopes', () => {
  const f = fixtureV4('tiptap_blocks', true), v3 = parseAndBind(f.base), v4 = parseAndBind(f.base, f.intent);
  assert(v3.version === 3); assert(v4.version === 4);
  const third = completion(f.base, v3), fourth = completion(f.base, v4);
  assert.notEqual(third.durable.intentDigest, fourth.durable.intentDigest);
  assert.throws(() => parseAndBind(f.base, { ...v3, version: 4 } as OriginalIntent), /ORIGINAL_DELETE_UNPROVEN/u);
  assert.throws(() => parseAndBind(f.base, { ...v4, version: 3 } as OriginalIntent), /ORIGINAL_DELETE_UNPROVEN/u);
  assert.throws(() => completed(third.completed, third.trash, fourth.durable, v4), /ORIGINAL_DELETE_UNPROVEN/u);
  assert.throws(() => completed(fourth.completed, fourth.trash, third.durable, v3), /ORIGINAL_DELETE_UNPROVEN/u);
  for (const [intent, result, wrongVersion] of [[v3, third, 4], [v4, fourth, 3]] as const) {
    assert.throws(() => completed(receipt(result.durable.intentDigest, { ...result.value, version: wrongVersion }),
      result.trash, result.durable, intent), /ORIGINAL_DELETE_UNPROVEN/u);
    const badWitness = clone(intent); badWitness.currentWitness = clone(f.base.plan.sourceEvidence);
    assert.throws(() => parseAndBind(f.base, badWitness), /ORIGINAL_DELETE_UNPROVEN/u);
    const noWitness = clone(intent) as unknown as Record<string, unknown>; delete noWitness.currentWitness;
    assert.throws(() => parseAndBind(f.base, noWitness as unknown as OriginalIntent), /ORIGINAL_DELETE_UNPROVEN/u);
  }
});

test('Original Delete V4: fixed null-prototype result map and original actor/session/namespace attribution stay separate from current authority', () => {
  const f = fixtureV4('tiptap_blocks', true), parsed = parseAndBind(f.base, f.intent); assert(parsed.version === 4);
  const result = completion(f.base, parsed), actual = completed(result.completed, result.trash, result.durable, parsed), before = clone(actual);
  const map = workspaceOperationOriginalDeleteAdmissionResult(actual);
  assert.equal(Object.getPrototypeOf(map), null); assert(Object.isFrozen(map));
  assert.deepEqual(map, Object.assign(Object.create(null), { originalDeleteIntentDigest: result.durable.intentDigest,
    originalDeleteReceiptDigest: result.completed.receiptDigest, originalDeleteTrashReceiptDigest: result.trash.receiptDigest, trashEntryId }));
  assert.deepEqual(Object.keys(map).sort(), ['originalDeleteIntentDigest', 'originalDeleteReceiptDigest', 'originalDeleteTrashReceiptDigest', 'trashEntryId']);
  const payload = JSON.parse(f.captured.request.actionPayloadText!) as Record<string, unknown>;
  assert.deepEqual(payload.originalActor, actor); assert.deepEqual(payload.jobScope, parsed.jobScope);
  assert.equal(payload.batchId, batchId); assert.equal(payload.planId, f.base.plan.planId); assert.equal(payload.requestHash, requestHash);
  for (const [key, value] of [['userId', 'foreign-user'], ['actorId', 'foreign-actor'], ['actorType', 'agent'],
    ['actorSessionId', 'declared-new-session']] as const) {
    const changed = clone(parsed); Object.assign(changed.actor, { [key]: value });
    assert.throws(() => parseAndBind(f.base, changed), /ORIGINAL_DELETE_UNPROVEN/u);
  }
  let observed = 0;
  const getter = Object.defineProperty({ ...actual }, 'receiptDigest', { enumerable: true,
    get() { observed++; throw new Error('Result getter must never run.'); } });
  assert.throws(() => workspaceOperationOriginalDeleteAdmissionResult(getter), /ORIGINAL_DELETE_UNPROVEN/u);
  assert.throws(() => workspaceOperationOriginalDeleteAdmissionResult(new Proxy(actual, {})), /ORIGINAL_DELETE_UNPROVEN/u);
  assert.throws(() => workspaceOperationOriginalDeleteAdmissionResult({ ...actual, receiptDigest: `${actual.receiptDigest}\n` }), /ORIGINAL_DELETE_UNPROVEN/u);
  assert.throws(() => workspaceOperationOriginalDeleteAdmissionResult(Object.assign(Object.create(null), actual)), /ORIGINAL_DELETE_UNPROVEN/u);
  assert.equal(observed, 0); assert.deepEqual(actual, before);
});
