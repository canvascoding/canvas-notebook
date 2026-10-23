import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureCollaborationAdmissionRequest } from '../app/lib/collaboration/room-admission-contract';
import { createWorkspaceOperationNativeMoveBatchPlanV4, captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness }
  from '../app/lib/files/workspace-operation-native-move-plan';
import { createWorkspaceOperationOriginalMovePreparation, decodeWorkspaceOperationOriginalMovePreparation }
  from '../app/lib/files/workspace-operation-original-move-preparation';
import { createWorkspaceOperationOriginalMoveAdmissionRequestFromBundle }
  from '../app/lib/files/workspace-operation-original-move-admission';
import { prepareWorkspaceOperationOriginalMoveNativeBundleData, serializeWorkspaceOperationOriginalMoveData,
  type WorkspaceOperationOriginalMoveContext } from '../app/lib/files/workspace-operation-original-move';
import { deriveWorkspacePathPhysicalParserVersion } from '../app/lib/files/workspace-operation-path-source-parser';
import { workspaceOperationMixedSourceEvidenceV5Fixture } from './workspace-operation-mixed-source-evidence-v5-test';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);

/** Real Yjs, parser4, compiler5 and preparation codecs over declared source
 * observations. No test autoruns on import; no SQL/FD/principal authority or
 * genuine admission reservation is represented by these pure facts. */
export function workspaceOperationOriginalMoveHtmlPreparationTest(): void {
  let groups = 0;
  const fixture = workspaceOperationMixedSourceEvidenceV5Fixture({ raw: [],
    native: [['Move.md', '# Move\n'], ['Incoming.md', '[Move](Move.md)\n'], ['HTML.md', '# HTML\n\n<img src="stable.png">\n']],
    extra: [{ path: 'stable.png', kind: 'file' }, { path: 'Doc.pdf', kind: 'file' }, { path: 'Dest', kind: 'directory' }] });
  const scope = { workspace: { ...fixture.scope, status: 'active' as const,
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
      canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
  const make = (sourcePath: string, destinationPath: string) => {
    const plan = createWorkspaceOperationNativeMoveBatchPlanV4({ scope,
      actions: [{ kind: 'move', reviewId: 'html-move-p0-request', selections: [{ sourcePath, destinationPath }] }],
      observation: fixture.observation });
    const context: WorkspaceOperationOriginalMoveContext = { batchId: hash(`batch:${sourcePath}`), requestHash: hash(`request:${sourcePath}`),
      actor: { userId: fixture.scope.ownerUserId!, actorId: 'html-p0-actor', actorType: 'user', actorSessionId: 'html-p0-session' }, plan };
    const currentWitness = captureWorkspaceOperationNativeMoveBatchPlanCurrentWitness(plan, fixture.observation, fixture.scope);
    const nativeBundleData = prepareWorkspaceOperationOriginalMoveNativeBundleData(context, fixture.observation, currentWitness);
    return { plan, context, currentWitness, nativeBundleData };
  };

  // Identity4 has an explicit Preparation3/Evidence5 pair, retaining its
  // original incomplete HTML coverage and fixed collector3 read profile.
  const physical = make('Doc.pdf', 'Dest/Doc.pdf');
  assert.equal(physical.plan.planIdentityVersion, 4); assert.equal(physical.currentWitness.evidenceVersion, 5);
  assert.equal(deriveWorkspacePathPhysicalParserVersion(physical.currentWitness), 3);
  assert.equal(physical.currentWitness.coverage.complete, false); assert.equal(physical.nativeBundleData, null);
  const p0 = createWorkspaceOperationOriginalMovePreparation(physical.context,
    { currentWitness: physical.currentWitness, nativeBundleData: null });
  assert.equal(p0.preparation.version, 3); assert.equal(p0.preparation.currentWitness.evidenceVersion, 5);
  assert.deepEqual(p0.preparation.currentWitness.coverage, fixture.observation.stage.coverage);
  assert.equal(p0.preparation.nativeBundle, null); assert.equal(p0.preparationDigest, hash(p0.preparationText));
  assert(Object.isFrozen(p0.preparation.currentWitness));
  groups++;

  // Exact canonical round-trip and repeated creation preserve the same saved
  // admission request. This is not a current read or renewed reservation.
  assert.deepEqual(decodeWorkspaceOperationOriginalMovePreparation(p0.preparationText, physical.context, null), p0);
  assert.deepEqual(createWorkspaceOperationOriginalMovePreparation(physical.context,
    { currentWitness: physical.currentWitness, nativeBundleData: null }), p0);
  const request = createWorkspaceOperationOriginalMoveAdmissionRequestFromBundle(physical.context, null, physical.currentWitness);
  assert.deepEqual(captureCollaborationAdmissionRequest(request), captureCollaborationAdmissionRequest(p0.request));
  assert.deepEqual(JSON.parse(p0.preparation.actionPayloadText), { version: 1, batchId: physical.context.batchId,
    planId: physical.plan.planId, requestHash: physical.context.requestHash });
  assert.equal(p0.request.expectedDocuments.length, fixture.observation.nativeBindings.length);
  groups++;

  // A native move and an incoming native rewrite require the real prepared
  // bundle. HTML readiness never permits replacing that bundle with null.
  const native = make('Move.md', 'Dest/Moved.md');
  assert(native.nativeBundleData); assert(native.plan.nativePathPlan.mutations.length > 0);
  const nativeP0 = createWorkspaceOperationOriginalMovePreparation(native.context,
    { currentWitness: native.currentWitness, nativeBundleData: native.nativeBundleData });
  assert.equal(nativeP0.preparation.version, 3); assert(nativeP0.preparation.nativeBundle);
  assert.deepEqual(decodeWorkspaceOperationOriginalMovePreparation(nativeP0.preparationText, native.context, native.nativeBundleData), nativeP0);
  assert.throws(() => createWorkspaceOperationOriginalMovePreparation(native.context,
    { currentWitness: native.currentWitness, nativeBundleData: null }));
  groups++;

  // Recanonicalizing changed saved facts cannot turn Preparation3 into an old
  // version, substitute its exact request, or drop the HTML coverage witness.
  for (const patch of [
    { version: 1 }, { version: 2 }, { version: 4 }, { requestId: '00000000-0000-0000-0000-000000000000' },
    { requestDigest: hash('foreign') }, { actionPayloadText: '{}' }, { unexpected: true },
    { currentWitness: { ...clone(p0.preparation.currentWitness), coverage: { complete: true, gaps: [] } } },
  ]) {
    const changed = serializeWorkspaceOperationOriginalMoveData({ ...clone(p0.preparation), ...patch });
    assert.throws(() => decodeWorkspaceOperationOriginalMovePreparation(changed, physical.context, null));
  }
  groups++;

  // A prior native-only or differently scoped witness cannot be paired with
  // this new identity, even where its native state bytes happen to coincide.
  type PreparationInput = Parameters<typeof createWorkspaceOperationOriginalMovePreparation>[1];
  for (const currentWitness of [physical.currentWitness.nativeComponent,
    { ...clone(physical.currentWitness), workspaceScope: { ...fixture.scope, workspaceId: 'foreign-workspace' } },
    { ...clone(physical.currentWitness), evidenceProof: hash('foreign-evidence') }]) {
    assert.throws(() => createWorkspaceOperationOriginalMovePreparation(physical.context,
      { currentWitness, nativeBundleData: null } as unknown as PreparationInput));
  }
  groups++;

  // Original context/request/actor bindings remain exact on historical reads.
  for (const context of [
    { ...physical.context, batchId: hash('another-batch') },
    { ...physical.context, requestHash: hash('another-request') },
    { ...physical.context, actor: { ...physical.context.actor, actorSessionId: 'another-session' } },
  ]) assert.throws(() => decodeWorkspaceOperationOriginalMovePreparation(p0.preparationText, context, null));
  groups++;

  // Descriptor capture precedes witness/bundle reads; callers keep their own
  // detached data and cannot pass a getter, proxy or malformed UTF8 history.
  let getters = 0;
  const getterInput = Object.defineProperty({ nativeBundleData: null }, 'currentWitness',
    { enumerable: true, get: () => { getters++; return physical.currentWitness; } });
  assert.throws(() => createWorkspaceOperationOriginalMovePreparation(physical.context, getterInput as PreparationInput));
  assert.equal(getters, 0);
  assert.throws(() => createWorkspaceOperationOriginalMovePreparation(physical.context,
    new Proxy({ currentWitness: physical.currentWitness, nativeBundleData: null }, {})));
  assert.throws(() => decodeWorkspaceOperationOriginalMovePreparation(p0.preparationText + '\n', physical.context, null));
  assert.throws(() => decodeWorkspaceOperationOriginalMovePreparation('\ud800', physical.context, null));
  groups++;

  console.log(`workspace original Move HTML preparation: ${groups} families passed`);
}
