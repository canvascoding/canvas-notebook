import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { groupWorkspaceLinkWrites } from '../app/lib/markdown/workspace-link-write-groups';
import { isWorkspaceFileOperationLinkSafe } from '../app/lib/markdown/workspace-file-operation-link-safety';
import * as policy from '../app/lib/files/workspace-file-undo-policy';
import type { WorkspaceOperationWithSteps } from '../app/lib/files/workspace-operation-journal';
import type { WorkspaceOperationStage } from '../app/lib/files/workspace-operation-staging';
import type { WorkspaceFileOperationPreview } from '../app/lib/markdown/workspace-file-operation-planner';

type Factory = typeof import('../app/lib/files/workspace-file-operation-executor');
type Identity = Parameters<ReturnType<Factory['createWorkspaceFileOperationExecutor']>['recover']>[0];
const require = createRequire(path.resolve('package.json'));
// Run the exact saved pre-fix source or the current product body. Boundary
// ports below are explicit JS controls, never proof of SQL/ACL/FS authority.
const filename = process.env.CANVAS_SINGLE_UNDO_EXECUTOR_SOURCE || path.resolve('app/lib/files/workspace-file-operation-executor.ts');
const bytes = readFileSync(filename), sourceSha256 = createHash('sha256').update(bytes).digest('hex');
const javascript = ts.transpileModule(bytes.toString(), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;
const loaded = { exports: {} };
const dependencies: Record<string, unknown> = {
  'server-only': {},
  '@/app/lib/markdown/workspace-file-operation-link-safety': { isWorkspaceFileOperationLinkSafe },
  '@/app/lib/markdown/workspace-link-write-groups': { groupWorkspaceLinkWrites },
  './workspace-file-undo-policy': policy,
  './workspace-operation-journal': { serializeWorkspaceOperationRequest: () => assert.fail('Recovery must not serialize a new request.') },
};
new Function('require', 'module', 'exports', javascript)((name: string) => {
  if (Object.hasOwn(dependencies, name)) return dependencies[name];
  if (name.startsWith('node:')) return require(name);
  return assert.fail(`Unexpected product dependency: ${name}`);
}, loaded, loaded.exports);
const { createWorkspaceFileOperationExecutor } = loaded.exports as Factory;
console.log(JSON.stringify({ fixture: 'single-undo-identity', sourceSha256 }));

function singleUndoIdentityFixture(sameScope = false) {
  const original: Identity = { operationId: 'a'.repeat(64), planId: 'b'.repeat(64), sourceWorkspaceId: 'ordinary-source', destinationWorkspaceId: 'ordinary-destination' };
  const unchecked: Identity = { operationId: createHash('sha256').update(JSON.stringify(['workspace-operation-undo-v1', 'original-operation-123456'])).digest('hex'),
    planId: sameScope ? original.planId : 'c'.repeat(64), sourceWorkspaceId: sameScope ? original.sourceWorkspaceId : 'inverse-source',
    destinationWorkspaceId: sameScope ? original.destinationWorkspaceId : 'inverse-destination' };
  const events: Array<{ action: string; operationId: string }> = [], loadedIdentities: Identity[] = [];
  const request = { kind: 'rename' as const, selections: [{ sourcePath: 'before.txt', destinationPath: 'after.txt' }] };
  const record = (identity: Identity): WorkspaceOperationWithSteps => ({ ...identity, actor: { type: 'user', id: 'owner' },
    requestHash: 'd'.repeat(64), requestJson: JSON.stringify(request), expectedStepCount: 1, status: 'prepared', phase: 'prepared',
    revision: 1, errorCode: null, createdAt: 1, updatedAt: 1, steps: [] });
  const records = new Map([original, unchecked].map(identity => [identity.operationId, record(identity)]));
  const states = new Map([original, unchecked].map(identity => [identity.operationId, 'before' as 'before' | 'after']));
  let signalLookup!: () => void, releaseLookup!: () => void;
  const lookupStarted = new Promise<void>(resolve => { signalLookup = resolve; });
  const lookupRelease = new Promise<void>(resolve => { releaseLookup = resolve; });
  const preview = (identity: Identity): WorkspaceFileOperationPreview => ({ contractVersion: 1, planId: identity.planId, kind: 'rename', status: 'planned',
    readiness: 'ready', issues: [], recoveryReady: true, collisions: [], pathMappings: [], linkEdits: [], previewContents: [],
    expectedPathState: [], coverage: { complete: true, omittedSources: [], unresolvedLinks: [] } });
  const journal: Parameters<Factory['createWorkspaceFileOperationExecutor']>[0]['journal'] = {
    get: async operationId => { events.push({ action: 'get', operationId }); return records.get(operationId) ?? null; },
    isSingleUndoOperation: async operationId => {
      events.push({ action: 'lookup', operationId }); signalLookup(); await lookupRelease; return operationId === unchecked.operationId;
    },
    prepare: async () => assert.fail('Unexpected prepare.'),
    beginStep: async input => {
      const value = records.get(input.operationId); assert(value);
      const step = { ...input, status: 'intent' as const, backupRef: input.backupRef ?? null, receiptJson: null, createdAt: 1, updatedAt: 1 };
      value.steps.push(step); events.push({ action: 'begin', operationId: input.operationId }); return step;
    },
    finishStep: async input => {
      const value = records.get(input.operationId), step = value?.steps.find(item => item.stepKey === input.stepKey); assert(step);
      step.status = 'applied'; step.receiptJson = JSON.stringify(input.receipt); events.push({ action: 'finish', operationId: input.operationId }); return step;
    },
    complete: async operationId => { const value = records.get(operationId); assert(value); value.status = 'completed'; value.phase = 'completed'; return value; },
    fail: async () => assert.fail('Unexpected fail.'), resume: async () => assert.fail('Unexpected resume.'),
  };
  const executor = createWorkspaceFileOperationExecutor({ journal,
    staging: { stage: async () => assert.fail('Unexpected new stage.'),
      load: async identity => { loadedIdentities.push({ ...identity }); return { identity, preview: preview(identity), originalDocuments: [], payloadSha256: 'e'.repeat(64), linkPreflight: null }; },
      removeCompleted: async identity => { assert.equal(records.get(identity.operationId)?.status, 'completed'); events.push({ action: 'remove', operationId: identity.operationId }); } },
    adapters: { rebuildPlan: async () => assert.fail('Unexpected replan.'),
      path: { probe: async stage => states.get(stage.identity.operationId)!, apply: async (stage: WorkspaceOperationStage) => {
        events.push({ action: 'apply', operationId: stage.identity.operationId }); states.set(stage.identity.operationId, 'after'); return { kind: 'rename' };
      } },
      links: { preflight: async () => assert.fail('Unexpected new preflight.'), probe: async () => assert.fail('Unexpected link probe.'), apply: async () => assert.fail('Unexpected link write.') } },
  });
  return { original, unchecked, events, loadedIdentities, executor, lookupStarted, releaseLookup };
}

for (const fields of ['operationId', 'all-fields'] as const) test(`lookup barrier: ${fields} mutation cannot redirect a checked ordinary ID to unchecked saved Undo`, async () => {
  const fixture = singleUndoIdentityFixture(fields === 'operationId'), caller = { ...fixture.original };
  // Same-plan/scopes variant demonstrates the original redirect all the way to
  // a path write. The all-fields variant also binds the entire recovery tuple.
  // The record catalogue is independent data: the inverse header may happen
  // to have the same plan/scope as another record. Check every actual use.
  const pending = fixture.executor.recover(caller);
  await fixture.lookupStarted;
  if (fields === 'all-fields') Object.assign(caller, fixture.unchecked); else caller.operationId = fixture.unchecked.operationId;
  fixture.releaseLookup();
  const result = await pending;
  assert.equal(result.status, 'complete'); assert.equal(result.operationId, fixture.original.operationId);
  assert(fixture.events.some(event => event.action === 'apply' && event.operationId === fixture.original.operationId));
  assert(fixture.events.every(event => event.operationId === fixture.original.operationId), JSON.stringify(fixture.events));
  assert.deepEqual(fixture.loadedIdentities, [fixture.original]);
});

for (const field of ['operationId', 'planId', 'sourceWorkspaceId', 'destinationWorkspaceId'] as const) test(`accessor ${field} is rejected before getter execution, lookup, stage or mutation`, async () => {
  const fixture = singleUndoIdentityFixture(), caller = { ...fixture.original }; let reads = 0;
  Object.defineProperty(caller, field, { enumerable: true, get() { reads++; return fixture.original[field]; } });
  // Resolving the barrier prevents a pre-fix accessor case from hanging, while
  // the corrected entry must reject before ever reaching the lookup.
  fixture.releaseLookup();
  await assert.rejects(fixture.executor.recover(caller), error => error instanceof Error && Reflect.get(error, 'code') === 'OPERATION_ID_CONFLICT');
  assert.equal(reads, 0); assert.deepEqual(fixture.events, []); assert.deepEqual(fixture.loadedIdentities, []);
});
