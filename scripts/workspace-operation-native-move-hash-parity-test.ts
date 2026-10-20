import assert from 'node:assert/strict';
import { nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { computeWorkspaceOperationNativeMoveBatchPlanId, computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof,
  decodeWorkspaceOperationNativeMoveBatchPlan, type WorkspaceOperationNativeMoveBatchPlan }
  from '../app/lib/files/workspace-operation-native-move-plan';
import { workspaceOperationOriginalMovePristineSourcesFixture } from './workspace-operation-original-move-pristine-sources-test';

// Frozen pre-refactor formulas are an independent wire-hash oracle. The fixture
// supplies real pure native/parser data; this proves no SQL or owner authority.
function originalPlanId(plan: WorkspaceOperationNativeMoveBatchPlan): string {
  const { planId: _id, ...body } = structuredClone(plan);
  if (body.planIdentityVersion === 4) return proof({ version: 3, planIdentityVersion: 4,
    kind: body.kind, workspaceId: body.workspaceId, readiness: body.readiness, executionReady: body.executionReady,
    actions: body.actions, workspaceScope: body.sourceEvidence.workspaceScope, sourceSemanticProof: body.sourceEvidence.semanticProof,
    htmlAssessmentProof: proof(body.linkAssessment) });
  if (body.planIdentityVersion === 3 || body.planIdentityVersion === 2) return proof({ version: 3,
    planIdentityVersion: body.planIdentityVersion, kind: body.kind, workspaceId: body.workspaceId,
    readiness: body.readiness, executionReady: body.executionReady, actions: body.actions,
    workspaceScope: body.sourceEvidence.workspaceScope, sourceSemanticProof: body.sourceEvidence.semanticProof });
  return proof(body);
}
function originalIntegrity(plan: Exclude<WorkspaceOperationNativeMoveBatchPlan, { planIdentityVersion?: never }>): string {
  const { integrityProof: _integrity, ...body } = structuredClone(plan);
  return proof({ integrityVersion: body.planIdentityVersion, plan: body });
}

/** Export only. Root may register this in its existing finite pure runner. */
export function workspaceOperationNativeMoveHashParityTest(): void {
  const v2 = workspaceOperationOriginalMovePristineSourcesFixture(2).context.plan;
  assert(v2.planIdentityVersion === 2);
  const { planIdentityVersion: _version, integrityProof: _integrity, planId: _id, ...legacyBody } = v2;
  const legacy = decodeWorkspaceOperationNativeMoveBatchPlan({ ...legacyBody, planId: proof(legacyBody) });
  const plans = [legacy, v2, workspaceOperationOriginalMovePristineSourcesFixture(3).context.plan,
    workspaceOperationOriginalMovePristineSourcesFixture(4).context.plan];

  for (const plan of plans) {
    const before = JSON.stringify(plan), input = JSON.parse(before);
    assert.equal(computeWorkspaceOperationNativeMoveBatchPlanId(plan), originalPlanId(plan));
    assert.equal(plan.planId, originalPlanId(plan));
    if (plan.planIdentityVersion !== undefined) {
      assert.equal(computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof(plan), originalIntegrity(plan));
      assert.equal(plan.integrityProof, originalIntegrity(plan));
    }
    const decoded = decodeWorkspaceOperationNativeMoveBatchPlan(input);
    assert.deepEqual(decoded, plan); assert.equal(JSON.stringify(decoded), before);
    assert.equal(JSON.stringify(input), before); assert(Object.isFrozen(decoded));
  }

  // Public hash APIs retain their own strict capture, including code-free rejection.
  const modern = plans[3]; assert(modern.planIdentityVersion === 4);
  let accesses = 0;
  const accessor = { ...modern };
  Object.defineProperty(accessor, 'sourceEvidence', { enumerable: true, get() { accesses++; return modern.sourceEvidence; } });
  const proxy = new Proxy(modern, { getPrototypeOf() { accesses++; throw new Error('Proxy trap'); },
    ownKeys() { accesses++; throw new Error('Proxy trap'); } });
  for (const input of [accessor, proxy]) {
    assert.throws(() => computeWorkspaceOperationNativeMoveBatchPlanId(input));
    assert.throws(() => computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof(input));
    assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan(input));
  }
  assert.equal(accesses, 0);

  // Rehashing an altered recipe cannot bypass the unchanged independent planner replay.
  for (const plan of plans) {
    const forged = structuredClone(plan);
    Reflect.set(forged.nativePathPlan.pathMappings[0], 'destinationPath', 'forged/destination.txt');
    Reflect.set(forged, 'planId', computeWorkspaceOperationNativeMoveBatchPlanId(forged));
    if (forged.planIdentityVersion !== undefined) {
      Reflect.set(forged, 'integrityProof', computeWorkspaceOperationNativeMoveBatchPlanIntegrityProof(forged));
    }
    assert.throws(() => decodeWorkspaceOperationNativeMoveBatchPlan(forged));
  }
}
