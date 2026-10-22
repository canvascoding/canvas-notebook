import { decodeWorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import { workspaceOperationBatchTotalActions } from '../app/lib/files/workspace-operation-native-delete-effects';
import {createWorkspaceOperationCohortDeletePlan,decodeWorkspaceOperationCohortDeletePlan,captureWorkspaceOperationCohortDeleteCurrent,getWorkspaceOperationCohortDeleteRecipes} from '../app/lib/files/workspace-operation-cohort-delete-plan';
import {createWorkspacePathCohortDeletePreparation} from '../app/lib/files/workspace-path-cohort-delete-preparation';
import {workspaceOperationCohortDeleteEffects,workspaceOperationMcpCohortDeletePreview} from '../app/lib/files/workspace-operation-cohort-delete-public';
import assert from 'node:assert/strict';
import { WorkspaceOperationNativeSourceEvidenceError } from '../app/lib/files/workspace-operation-native-source-evidence';
import { createWorkspaceOperationPhysicalDeleteBatchPlanV5, decodeWorkspaceOperationPhysicalDeleteBatchPlanV5,
  computeWorkspaceOperationPhysicalDeleteBatchPlanIdV5, computeWorkspaceOperationPhysicalDeleteBatchPlanIntegrityProofV5,
  captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5, getWorkspaceOperationPhysicalDeleteLinkRecipesV5 } from '../app/lib/files/workspace-operation-physical-delete-html-plan-v5';
import { createWorkspacePathPhysicalDeletePreparationPlanV5 } from '../app/lib/files/workspace-path-physical-delete-preparation-v5';
import { createHash } from 'node:crypto';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { getNativeInspectionSchema, withNativeInspectionSchema } from '../app/lib/collaboration/native-inspection-schema';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { createWorkspaceOperationNativeDeleteBatchPlanV4, decodeWorkspaceOperationNativeDeleteBatchPlanV4,
  computeWorkspaceOperationNativeDeleteBatchPlanIdV4, computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProofV4,
  captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitnessV4, assertWorkspaceOperationNativeDeleteBatchPlanCurrentV4,
  getWorkspaceOperationNativeDeleteLinkRecipesV4, WorkspaceOperationNativeDeleteHtmlPlanError }
  from '../app/lib/files/workspace-operation-native-delete-html-plan';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinksV3, workspaceSourceAuthorityStageProof } from '../app/lib/markdown/workspace-physical-link-inventory';
import { workspaceOperationMixedSourceEvidenceV5Fixture } from './workspace-operation-mixed-source-evidence-v5-test';
import { decodeWorkspaceOperationMixedSourceEvidenceV5, workspaceOperationMixedSourceSnapshotV5,
  captureWorkspaceOperationMixedSourceEvidenceV5, assertWorkspaceOperationMixedSourceEvidenceV5Current }
  from '../app/lib/files/workspace-operation-mixed-source-evidence-v5';
import { decodeWorkspaceOperationNativeDeleteBatchPlan, captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness,
  assertWorkspaceOperationNativeDeleteBatchPlanCurrent, getWorkspaceOperationNativeDeleteLinkRecipes }
  from '../app/lib/files/workspace-operation-native-delete-plan';
import { prepareOriginalDeleteNativeHtmlLinksV4, decodeOriginalDeleteNativeHtmlLinkIntentsV4 }
  from '../app/lib/files/workspace-operation-original-delete-html-links';
import { assertOriginalDeleteNativeLinkPlan, type OriginalDeleteNativeLinkContext }
  from '../app/lib/files/workspace-operation-original-delete-links';
import { assertOriginalDeleteNativeLinkRecipeIntents }
  from '../app/lib/files/workspace-operation-original-delete-link-recipe-intents';

type Mutable<T> = T extends Uint8Array ? Uint8Array : T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(options: Parameters<typeof workspaceOperationMixedSourceEvidenceV5Fixture>[0] = {}) {
  const actual = workspaceOperationMixedSourceEvidenceV5Fixture({ native: [['note.md', '[Target](target.md)'], ['target.md', '# Target']],
    raw: [['raw.md', '[Self](raw.md)'], ['page.html', '<a href="stable.png">Image</a>']],
    extra: [{ path: 'stable.png', kind: 'file' }], ...options });
  const workspace: WorkspaceOperationBatchScope['workspace'] = { ...actual.scope,
    rootRelativePath: actual.scope.rootRelativePath ?? undefined, legacy: false, status: 'active', permissions: {
      canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } };
  return { actual, input: { scope: { workspace, fileOptions: {} } satisfies WorkspaceOperationBatchScope,
    actions: [{ reviewId: 'delete-html-v4-fixture', kind: 'delete' as const, selections: [{ sourcePath: 'target.md' }] }],
    observation: actual.observation }, jobScope: captureWorkspaceOperationJobScope(workspace) };
}
function refresh(actual: ReturnType<typeof fixture>['actual']): void {
  const observation = actual.observation;
  observation.stage.catalogueProof = proof(observation.privateCatalogue);
  observation.stage.sources = observation.stage.sources.map(source => source.kind === 'native' ? source : ({ kind: 'physical',
    inventory: inspectOriginalPhysicalLinksV3({ workspaceId: source.inventory.workspaceId, organizationId: source.inventory.organizationId,
      path: source.inventory.path, bytes: source.inventory.originalBytes, filesystemIdentity: source.inventory.physical.filesystemIdentity,
      authority: { ...source.inventory.authority, catalogueProof: observation.stage.catalogueProof! } }) }));
  const gaps = observation.stage.sources.flatMap(source => source.kind === 'native'
    ? source.inventory.coverage.gaps.map(gap => ({ code: gap.code, path: gap.path })) : source.inventory.coverage.gaps);
  observation.stage.coverage = { complete: !gaps.length, gaps };
  observation.stage.readiness = gaps.length ? 'blocked' : observation.stage.sources.some(source => source.kind === 'physical')
    ? 'requires-import-and-rebinding' : 'native-coordinator-required';
  observation.stage.stageProof = workspaceSourceAuthorityStageProof(observation.stage);
}
function richFixture(representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks') {
  const value = fixture();
  if (representation === 'plain_text') return value;
  const state = value.actual.observation.privateNativeStates.find(row => row.path === 'note.md')!;
  const doc = createRichMarkdownYDoc('[**Target**](target.md)\n\nUnchanged', representation);
  try { state.representation = representation; state.yjsState = Y.encodeStateAsUpdate(doc); state.stateVector = Y.encodeStateVector(doc); }
  finally { doc.destroy(); }
  const inventory = inspectPersistedDocumentLinks(state);
  const binding = value.actual.observation.nativeBindings.find(row => row.expected.documentId === state.documentId)!;
  binding.expected.representation = representation; binding.expected.binaryHash = sha(state.yjsState);
  binding.expected.vectorHash = sha(state.stateVector); binding.expected.stateProof = inventory.version.stateProof; binding.inventoryProof = proof(inventory);
  value.actual.observation.stage.sources = value.actual.observation.stage.sources.map(source => source.kind === 'native'
    && source.inventory.document.documentId === state.documentId ? { kind: 'native', inventory } : source);
  refresh(value.actual); return value;
}
function unsupported(operation: () => unknown): void {
  assert.throws(operation, error => error instanceof WorkspaceOperationNativeDeleteHtmlPlanError && error.code === 'NATIVE_DELETE_PLAN_UNSUPPORTED');
}

function freezeHtmlPlanFixture<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeHtmlPlanFixture(child);
    Object.freeze(value);
  }
  return value;
}
function htmlPlanFailureFacts(operation: () => unknown) {
  let failure: unknown;
  try { operation(); } catch (error) { failure = error; }
  assert(failure instanceof Error, 'The actual plan operation must reject.');
  assert(!(failure instanceof assert.AssertionError), 'An assertion failure is not a product rejection.');
  return { constructor: failure.constructor, name: failure.name, code: Reflect.get(failure, 'code') };
}

/** Actual E5/parser4/Yjs/planner5/compiler5 over declared pure observations.
 * No DB/FS/current actor/lease/Owner/COMMIT or production acceptance is claimed. */
export async function workspaceOperationNativeDeleteHtmlPlanV4Test(): Promise<void> {
  let families = 0;
  const family = (name: string, run: () => void) => { run(); families++; process.stdout.write(`ok native-delete-html4 ${families}: ${name}\n`); };
  const asyncFamily = async (name: string, run: () => Promise<void>) => { await run(); families++; process.stdout.write(`ok native-delete-html4 ${families}: ${name}\n`); };
  family('native unlink in three genuine representations retains unrelated HTML and original gaps', () => {
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
      const actual = richFixture(representation), before = structuredClone(actual.input.observation);
      const plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
      assert.equal(plan.version, 2); assert.equal(plan.planIdentityVersion, 4); assert.equal(plan.sourceEvidence.evidenceVersion, 5);
      assert.equal(plan.nativeGraphPlan.contractVersion, 5); assert.equal(plan.nativeGraphPlan.executionReady, false);
      assert.equal(plan.coverage.complete, false); assert.deepEqual(plan.sourceEvidence.coverage, before.stage.coverage);
      assert(plan.sourceEvidence.coverage.gaps.some(gap => gap.path === 'page.html' && gap.code === 'uninspected-html'));
      assert.equal(plan.linkAssessment.complete, true); assert.equal(plan.linkAssessment.blockers.length, 0);
      assert(plan.linkAssessment.warnings.some(warning => warning.sourcePath === 'page.html'));
      assert.deepEqual(plan.nativeGraphPlan.htmlAssessment, plan.linkAssessment);
      assert(plan.nativeGraphPlan.documentEvidence.every(row => row.inventory.parserVersion === 4));
      assert(plan.sourceEvidence.nativeComponent.stage.sources.every(row => row.inventory.parserVersion === 2));
      assert(plan.nativeGraphPlan.finalNamespace.some(row => row.path === 'page.html' && row.metadata === null));
      assert(plan.nativeGraphPlan.finalNamespace.some(row => row.path === 'raw.md' && row.physicalReadSource));
      assert.equal(plan.nativeGraphPlan.finalEdges.filter(row => row.physicalReadSource).length, 1);
      const recipes = getWorkspaceOperationNativeDeleteLinkRecipesV4(plan);
      assert.equal(recipes.length, 1); assert.equal(recipes[0].source.path, 'note.md'); assert.equal(recipes[0].action, 'unlink');
      assert.equal(recipes[0].source.representation, representation); assert.equal(recipes[0].nextValue, null);
      assert.deepEqual(decodeWorkspaceOperationNativeDeleteBatchPlanV4(JSON.parse(JSON.stringify(plan))), plan);
      assertWorkspaceOperationNativeDeleteBatchPlanCurrentV4(plan, actual.input.observation, actual.jobScope);
      assert.deepEqual(captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitnessV4(plan, actual.input.observation, actual.jobScope), plan.sourceEvidence);
      assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.sourceEvidence)); assert.deepEqual(actual.input.observation, before);
    }
  });
  family('native markdown extension remains supported', () => {
    const actual = fixture({ native: [['note.md', '[Target](target.markdown)'], ['target.markdown', '# Target']] });
    actual.input.actions[0].selections[0].sourcePath = 'target.markdown';
    const plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
    assert.equal(plan.nativeTarget.path, 'target.markdown'); assert.equal(getWorkspaceOperationNativeDeleteLinkRecipesV4(plan).length, 1);
  });
  family('unrelated native HTML and an ordinary backlink share genuine parser4 facts', () => {
    const actual = fixture({ native: [['note.md', '[Target](target.md)\n\n<img src="stable.png">'], ['target.md', '# Target']], raw: [] });
    const plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
    assert.equal(plan.coverage.complete, false); assert.equal(plan.linkAssessment.complete, true);
    assert.equal(getWorkspaceOperationNativeDeleteLinkRecipesV4(plan).length, 1);
    assertWorkspaceOperationNativeDeleteBatchPlanCurrentV4(plan, actual.input.observation, actual.jobScope);
  });
  family('affected native, raw Markdown and whole-file HTML are rejected explicitly', () => {
    for (const location of ['native', 'raw', 'whole'] as const) {
      const actual = fixture({ native: [['target.md', '# Target'], ['note.md', location === 'native' ? '<img src="target.md">' : '# Note']],
        raw: location === 'raw' ? [['raw.md', '<a href="target.md">Target</a>']] : location === 'whole' ? [['page.html', '<img src="target.md">']] : [] });
      unsupported(() => createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input));
    }
  });
  family('opaque HTML and unrelated non-HTML parse gaps never become complete', () => {
    for (const raw of [[['page.html', '<unknown value="stable.png">Hidden</unknown>']], [['raw.md', '---\ntitle: [\n---\nBroken']]] as const) {
      const actual = fixture({ raw }); assert.throws(() => createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input));
    }
  });
  family('selected raw, necessary raw unlink, folders, scenes and multiple selections remain outside this arm', () => {
    const selectedRaw = fixture(); selectedRaw.input.actions[0].selections[0].sourcePath = 'raw.md';
    unsupported(() => createWorkspaceOperationNativeDeleteBatchPlanV4(selectedRaw.input));
    const incomingRaw = fixture({ raw: [['raw.md', '[Target](target.md)'], ['page.html', '<p>Page</p>']] });
    unsupported(() => createWorkspaceOperationNativeDeleteBatchPlanV4(incomingRaw.input));
    const directory = fixture({ extra: [{ path: 'directory.md', kind: 'directory' }] });
    directory.input.actions[0].selections[0].sourcePath = 'directory.md'; unsupported(() => createWorkspaceOperationNativeDeleteBatchPlanV4(directory.input));
    const scene = fixture({ extra: [{ path: 'scene.excalidraw', kind: 'file' }] });
    scene.input.actions[0].selections[0].sourcePath = 'scene.excalidraw'; unsupported(() => createWorkspaceOperationNativeDeleteBatchPlanV4(scene.input));
    const multiple = fixture(); multiple.input.actions[0].selections.push({ sourcePath: 'note.md' });
    unsupported(() => createWorkspaceOperationNativeDeleteBatchPlanV4(multiple.input));
  });
  family('semantic identity and full historical integrity use independent explicit new formulas', () => {
    const actual = fixture(), plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
    assert.equal(plan.planId, proof({ version: 2, kind: plan.kind, planIdentityVersion: 4, workspaceId: plan.workspaceId,
      readiness: plan.readiness, actions: plan.actions, workspaceScope: plan.sourceEvidence.workspaceScope,
      sourceSemanticProof: plan.sourceEvidence.semanticProof, htmlAssessmentProof: proof(plan.linkAssessment) }));
    const { integrityProof: _integrity, ...body } = plan;
    assert.equal(plan.integrityProof, proof({ integrityVersion: 4, plan: body }));
    assert.equal(computeWorkspaceOperationNativeDeleteBatchPlanIdV4(plan), plan.planId);
    assert.equal(computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProofV4(plan), plan.integrityProof);
  });
  family('rehashed missing sources, false coverage, wrong graph versions or HTML facts fail historical validation', () => {
    for (const change of ['drop-html', 'drop-raw', 'complete-coverage', 'contract', 'assessment', 'source-coverage'] as const) {
      const plan = createWorkspaceOperationNativeDeleteBatchPlanV4(fixture().input), forged = structuredClone(plan) as unknown as Mutable<typeof plan>;
      if (change === 'drop-html') forged.nativeGraphPlan.finalNamespace = forged.nativeGraphPlan.finalNamespace.filter(row => row.path !== 'page.html');
      if (change === 'drop-raw') forged.nativeGraphPlan.finalNamespace = forged.nativeGraphPlan.finalNamespace.filter(row => row.path !== 'raw.md');
      if (change === 'complete-coverage') forged.coverage.complete = true;
      if (change === 'contract') Reflect.set(forged.nativeGraphPlan, 'contractVersion', 3);
      if (change === 'assessment') { forged.linkAssessment.warnings = []; forged.nativeGraphPlan.htmlAssessment = forged.linkAssessment; }
      if (change === 'source-coverage') forged.nativeGraphPlan.sourceCoverage[0].coverage = { complete: true, gaps: [] };
      forged.nativeGraphPlan.finalGraphProof = proof({ namespace: forged.nativeGraphPlan.finalNamespace, edges: forged.nativeGraphPlan.finalEdges });
      forged.nativeGraphPlan.steps[0].afterGraphProof = forged.nativeGraphPlan.finalGraphProof;
      const { planId: _graphId, ...graphBody } = forged.nativeGraphPlan; forged.nativeGraphPlan.planId = proof(graphBody);
      forged.planId = computeWorkspaceOperationNativeDeleteBatchPlanIdV4(forged);
      forged.integrityProof = computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProofV4(forged);
      assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlanV4(forged));
    }
  });
  family('opaque compiler byte assertions require complete Current replay', () => {
    for (const change of ['before-proof', 'content-proof'] as const) {
      const actual = fixture(), plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input), forged = structuredClone(plan) as unknown as Mutable<typeof plan>;
      if (change === 'before-proof') forged.nativeGraphPlan.steps[0].beforeGraphProof = 'f'.repeat(64);
      else forged.nativeGraphPlan.finalNamespace.find(row => row.path === 'note.md')!.contentBasisProof = 'f'.repeat(64);
      forged.nativeGraphPlan.finalGraphProof = proof({ namespace: forged.nativeGraphPlan.finalNamespace, edges: forged.nativeGraphPlan.finalEdges });
      forged.nativeGraphPlan.steps[0].afterGraphProof = forged.nativeGraphPlan.finalGraphProof;
      const { planId: _graphId, ...graphBody } = forged.nativeGraphPlan; forged.nativeGraphPlan.planId = proof(graphBody);
      forged.integrityProof = computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProofV4(forged);
      const historical = decodeWorkspaceOperationNativeDeleteBatchPlanV4(forged);
      assert.throws(() => assertWorkspaceOperationNativeDeleteBatchPlanCurrentV4(historical, actual.input.observation, actual.jobScope), error =>
        error instanceof WorkspaceOperationNativeDeleteHtmlPlanError && error.code === 'NATIVE_DELETE_PLAN_CHANGED');
    }
  });
  family('changed native clocks, physical bytes or actual workspace scope never become a Current witness', () => {
    for (const change of ['native', 'physical', 'html', 'scope', 'catalogue'] as const) {
      const actual = fixture(), plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
      const currentScope = { ...actual.jobScope };
      if (change === 'native') actual.input.observation.privateNativeStates[0].documentSequence++;
      if (change === 'physical' || change === 'html') {
        const source = actual.input.observation.stage.sources.find(row => row.kind === 'physical' && row.inventory.path === (change === 'html' ? 'page.html' : 'raw.md'))!;
        assert(source.kind === 'physical'); source.inventory.originalBytes[1] ^= 1; refresh(actual.actual);
      }
      if (change === 'scope') currentScope.rootPath = '/different';
      if (change === 'catalogue') Reflect.deleteProperty(actual.input.observation, 'privateCatalogue');
      assert.throws(() => captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitnessV4(plan, actual.input.observation, currentScope),
        `Changed ${change} facts must not satisfy the saved Current witness.`);
    }
  });
  family('fresh registry and replaceable projection clocks keep identity and replay the original E5 graph', () => {
    const actual = fixture({ documentSequence: 2 }), first = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
    for (const binding of actual.input.observation.nativeBindings) {
      assert(binding.expected.registryStateVersion < binding.expected.documentSequence);
      binding.expected.registryStateVersion++; binding.registry.stateVersion++;
      actual.actual.observation.privateCatalogue.find(row => row.id === binding.expected.documentId)!.state_version = binding.expected.registryStateVersion;
      actual.input.observation.stage.namespace.find(row => row.documentId === binding.expected.documentId)!.filesystemIdentity = '8:80:123:300:301';
    }
    refresh(actual.actual);
    const fresh = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
    assert.equal(fresh.planId, first.planId); assert.notEqual(fresh.integrityProof, first.integrityProof);
    assert.notEqual(fresh.sourceEvidence.evidenceProof, first.sourceEvidence.evidenceProof);
    assert.deepEqual(captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitnessV4(first, actual.input.observation, actual.jobScope), fresh.sourceEvidence);
    assertWorkspaceOperationNativeDeleteBatchPlanCurrentV4(first, actual.input.observation, actual.jobScope);
  });
  family('getter and proxy inputs are rejected without executing hostile code', () => {
    const actual = fixture(), plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input); let callbacks = 0;
    const hostileInput = { ...actual.input };
    Object.defineProperty(hostileInput, 'observation', { enumerable: true, get() { callbacks++; return actual.input.observation; } });
    assert.throws(() => createWorkspaceOperationNativeDeleteBatchPlanV4(hostileInput));
    const hostilePlan = { ...plan };
    Object.defineProperty(hostilePlan, 'sourceEvidence', { enumerable: true, get() { callbacks++; return plan.sourceEvidence; } });
    assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlanV4(hostilePlan));
    const proxy = new Proxy(plan, { ownKeys() { callbacks++; throw Error('trap'); },
      getPrototypeOf() { callbacks++; throw Error('trap'); }, getOwnPropertyDescriptor() { callbacks++; throw Error('trap'); } });
    assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlanV4(proxy)); assert.equal(callbacks, 0);
    const nonArray = { ...actual.input, actions: structuredClone(actual.input.actions) };
    Reflect.set(nonArray.actions[0], 'selections', { 0: { sourcePath: 'target.md' }, length: 1 });
    unsupported(() => createWorkspaceOperationNativeDeleteBatchPlanV4(nonArray));
  });
  family('generic HTML dispatch retains strict direct parity, isolated recipes and rejection before hostile observations', () => {
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
      const actual = richFixture(representation), plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
      const generic = decodeWorkspaceOperationNativeDeleteBatchPlan(plan);
      assert.deepEqual(generic, plan); assert.notEqual(generic, plan); assert(Object.isFrozen(generic));
      assert.deepEqual(captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(plan, actual.input.observation, actual.jobScope),
        captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitnessV4(plan, actual.input.observation, actual.jobScope));
      assertWorkspaceOperationNativeDeleteBatchPlanCurrent(plan, actual.input.observation, actual.jobScope);
      const direct = getWorkspaceOperationNativeDeleteLinkRecipesV4(plan), dispatched = getWorkspaceOperationNativeDeleteLinkRecipes(plan);
      assert.deepEqual(dispatched, direct); assert.notEqual(dispatched, direct); assert.notEqual(dispatched[0], direct[0]);
      Reflect.set(dispatched[0], 'nextValue', 'changed isolated copy');
      assert.deepEqual(getWorkspaceOperationNativeDeleteLinkRecipes(plan), direct);
      let observationReads = 0;
      const observation = { ...actual.input.observation };
      Object.defineProperty(observation, 'stage', { enumerable: true, get() { observationReads++; throw Error('hostile observation'); } });
      const forged = { ...plan, integrityProof: 'f'.repeat(64) };
      assert.throws(() => captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(forged, observation, actual.jobScope));
      assert.throws(() => assertWorkspaceOperationNativeDeleteBatchPlanCurrent(forged, observation, actual.jobScope));
      assert.throws(() => getWorkspaceOperationNativeDeleteLinkRecipes(forged));
      assert.equal(observationReads, 0);
      let getterCalls = 0;
      const hostile = { ...plan };
      Object.defineProperty(hostile, 'sourceEvidence', { enumerable: true, get() { getterCalls++; return plan.sourceEvidence; } });
      for (const operation of [() => computeWorkspaceOperationNativeDeleteBatchPlanIdV4(hostile),
        () => computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProofV4(hostile),
        () => captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(hostile, observation, actual.jobScope),
        () => assertWorkspaceOperationNativeDeleteBatchPlanCurrent(hostile, observation, actual.jobScope),
        () => getWorkspaceOperationNativeDeleteLinkRecipes(hostile)]) assert.throws(operation);
      const proxy = new Proxy(plan, { getOwnPropertyDescriptor() { getterCalls++; throw Error('proxy trap'); },
        getPrototypeOf() { getterCalls++; throw Error('proxy trap'); }, ownKeys() { getterCalls++; throw Error('proxy trap'); } });
      assert.throws(() => captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitness(proxy, observation, actual.jobScope));
      assert.throws(() => assertWorkspaceOperationNativeDeleteBatchPlanCurrent(proxy, observation, actual.jobScope));
      assert.throws(() => getWorkspaceOperationNativeDeleteLinkRecipes(proxy));
      assert.equal(getterCalls, 0); assert.equal(observationReads, 0);
    }
  });
  family('HTML preparation compares the same strict recipes and rejects changed source, before, inverse or profile facts', () => {
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
      const actual = richFixture(representation), plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
      const recipes = getWorkspaceOperationNativeDeleteLinkRecipes(plan), originalRecipes = structuredClone(recipes);
      const context: OriginalDeleteNativeLinkContext = { batchId: 'a'.repeat(64), workspaceId: plan.workspaceId,
        sourcePath: plan.nativeTarget.path, requestHash: 'b'.repeat(64),
        actor: { userId: 'fixture-user', actorId: 'fixture-actor', actorType: 'user', actorSessionId: 'fixture-session' } };
      const intents = prepareOriginalDeleteNativeHtmlLinksV4(recipes, actual.input.observation, context);
      const originalIntents = structuredClone(intents);
      assert(intents.length); assert(intents.every(item => item.prepared.contractVersion === 4));
      assertOriginalDeleteNativeLinkPlan(plan, intents); assertOriginalDeleteNativeLinkRecipeIntents(recipes, intents);
      assert.deepEqual(recipes, originalRecipes);
      for (const change of ['missing', 'source', 'before', 'inverse'] as const) {
        const changed = structuredClone(intents);
        if (change === 'missing') changed.pop();
        if (change === 'source') Reflect.set(changed[0].prepared.source, 'path', 'different.md');
        if (change === 'before') Reflect.set(changed[0].prepared.before, 'stateProof', 'yjs-snapshot-sha256-v1:' + 'f'.repeat(64));
        if (change === 'inverse') Reflect.set(changed[0].prepared.inverseRecipes[0], 'authorizedForwardRecipeProof', 'f'.repeat(64));
        assert.throws(() => assertOriginalDeleteNativeLinkPlan(plan, changed));
        assert.throws(() => assertOriginalDeleteNativeLinkRecipeIntents(recipes, changed));
      }
      const wrongProfile = structuredClone(intents); Reflect.set(wrongProfile[0].prepared, 'contractVersion', 2);
      assert.throws(() => decodeOriginalDeleteNativeHtmlLinkIntentsV4(wrongProfile, context));
      assert.throws(() => assertOriginalDeleteNativeLinkPlan(plan, wrongProfile));
      assert.deepEqual(intents, originalIntents); assert.deepEqual(recipes, originalRecipes);
    }
  });
  family('warm historical plans and recipes stay detached while mutable and foreign frozen inputs retain strict validation', () => {
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
      const actual = richFixture(representation), plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
      const evidence = plan.sourceEvidence;
      const firstEvidence = decodeWorkspaceOperationMixedSourceEvidenceV5(evidence);
      const secondEvidence = decodeWorkspaceOperationMixedSourceEvidenceV5(evidence);
      assert.deepEqual(firstEvidence, evidence); assert.deepEqual(secondEvidence, evidence);
      assert.notEqual(firstEvidence, secondEvidence); assert.notEqual(firstEvidence, evidence);
      assert.notEqual(firstEvidence.nativeComponent, secondEvidence.nativeComponent);
      assert.notEqual(firstEvidence.nativeOrdinarySources4, secondEvidence.nativeOrdinarySources4);
      assert(Object.isFrozen(firstEvidence)); assert(Object.isFrozen(firstEvidence.nativeComponent));
      const firstSnapshot = workspaceOperationMixedSourceSnapshotV5(evidence);
      const secondSnapshot = workspaceOperationMixedSourceSnapshotV5(evidence);
      assert.deepEqual(firstSnapshot, secondSnapshot); assert.notEqual(firstSnapshot, secondSnapshot);
      assert.notEqual(firstSnapshot.documents, secondSnapshot.documents); assert(Object.isFrozen(firstSnapshot));
      const mutableEvidence = structuredClone(evidence);
      assert.deepEqual(decodeWorkspaceOperationMixedSourceEvidenceV5(mutableEvidence), evidence);
      Reflect.set(mutableEvidence, 'semanticProof', 'f'.repeat(64));
      Reflect.set(mutableEvidence, 'evidenceProof', proof(Object.fromEntries(
        Object.entries(mutableEvidence).filter(([key]) => key !== 'evidenceProof'))));
      const mutableEvidenceFailure = htmlPlanFailureFacts(() => decodeWorkspaceOperationMixedSourceEvidenceV5(mutableEvidence));
      const foreignEvidence = freezeHtmlPlanFixture(structuredClone(mutableEvidence));
      assert.deepEqual(htmlPlanFailureFacts(() => decodeWorkspaceOperationMixedSourceEvidenceV5(foreignEvidence)), mutableEvidenceFailure);
      assert.deepEqual(htmlPlanFailureFacts(() => workspaceOperationMixedSourceSnapshotV5(foreignEvidence)), mutableEvidenceFailure);
      const first = decodeWorkspaceOperationNativeDeleteBatchPlanV4(plan), second = decodeWorkspaceOperationNativeDeleteBatchPlanV4(plan);
      assert.deepEqual(first, plan); assert.deepEqual(second, plan); assert.notEqual(first, second); assert.notEqual(first, plan);
      assert.notEqual(first.sourceEvidence, second.sourceEvidence); assert.notEqual(first.nativeGraphPlan, second.nativeGraphPlan);
      assert(Object.isFrozen(first)); assert(Object.isFrozen(first.sourceEvidence)); assert(Object.isFrozen(first.nativeGraphPlan));
      const recipes = getWorkspaceOperationNativeDeleteLinkRecipesV4(plan), originalRecipes = structuredClone(recipes);
      const otherRecipes = getWorkspaceOperationNativeDeleteLinkRecipesV4(plan);
      assert.deepEqual(otherRecipes, recipes); assert.notEqual(otherRecipes, recipes); assert.notEqual(otherRecipes[0], recipes[0]);
      Reflect.set(otherRecipes[0], 'nextValue', 'caller-owned changed copy');
      assert.deepEqual(getWorkspaceOperationNativeDeleteLinkRecipesV4(plan), originalRecipes);
      const mutable = structuredClone(plan);
      assert.deepEqual(decodeWorkspaceOperationNativeDeleteBatchPlanV4(mutable), plan);
      Reflect.set(mutable.coverage, 'complete', true);
      Reflect.set(mutable, 'integrityProof', computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProofV4(mutable));
      const mutableFailure = htmlPlanFailureFacts(() => decodeWorkspaceOperationNativeDeleteBatchPlanV4(mutable));
      const foreignFrozen = freezeHtmlPlanFixture(structuredClone(mutable));
      assert.deepEqual(htmlPlanFailureFacts(() => decodeWorkspaceOperationNativeDeleteBatchPlanV4(foreignFrozen)), mutableFailure);
      assert.deepEqual(htmlPlanFailureFacts(() => getWorkspaceOperationNativeDeleteLinkRecipesV4(foreignFrozen)), mutableFailure);
      const validForeignFrozen = freezeHtmlPlanFixture(structuredClone(plan));
      const decodedForeign = decodeWorkspaceOperationNativeDeleteBatchPlanV4(validForeignFrozen);
      assert.deepEqual(decodedForeign, plan); assert.notEqual(decodedForeign, validForeignFrozen);
      assert.deepEqual(decodeWorkspaceOperationNativeDeleteBatchPlanV4(plan), plan);
    }
  });
  family('a warmed historical plan still rejects changed actual private Yjs bytes and accepts the restored original', () => {
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
      const actual = richFixture(representation), before = structuredClone(actual.input.observation);
      const plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
      decodeWorkspaceOperationNativeDeleteBatchPlanV4(plan); getWorkspaceOperationNativeDeleteLinkRecipesV4(plan);
      decodeWorkspaceOperationMixedSourceEvidenceV5(plan.sourceEvidence);
      workspaceOperationMixedSourceSnapshotV5(plan.sourceEvidence);
      assertWorkspaceOperationMixedSourceEvidenceV5Current(plan.sourceEvidence, actual.input.observation, actual.jobScope);
      assertWorkspaceOperationNativeDeleteBatchPlanCurrentV4(plan, actual.input.observation, actual.jobScope);
      const source = actual.input.observation.privateNativeStates.find(state => state.path === 'note.md')!;
      assert(source.yjsState.byteLength > 0); const originalBytes = source.yjsState.slice();
      try {
        source.yjsState[0] ^= 0xff;
        const warmFailure = htmlPlanFailureFacts(() => captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitnessV4(
          plan, actual.input.observation, actual.jobScope));
        const cold = freezeHtmlPlanFixture(structuredClone(plan));
        assert.deepEqual(htmlPlanFailureFacts(() => captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitnessV4(
          cold, actual.input.observation, actual.jobScope)), warmFailure);
        const sourceFailure = htmlPlanFailureFacts(() => assertWorkspaceOperationMixedSourceEvidenceV5Current(
          plan.sourceEvidence, actual.input.observation, actual.jobScope));
        assert.deepEqual(htmlPlanFailureFacts(() => assertWorkspaceOperationMixedSourceEvidenceV5Current(
          freezeHtmlPlanFixture(structuredClone(plan.sourceEvidence)), actual.input.observation, actual.jobScope)), sourceFailure);
        assert.throws(() => captureWorkspaceOperationMixedSourceEvidenceV5(actual.jobScope, actual.input.observation));
        assert.throws(() => assertWorkspaceOperationNativeDeleteBatchPlanCurrentV4(plan, actual.input.observation, actual.jobScope));
      } finally { source.yjsState.set(originalBytes); }
      assert.deepEqual(actual.input.observation, before);
      assertWorkspaceOperationMixedSourceEvidenceV5Current(plan.sourceEvidence, actual.input.observation, actual.jobScope);
      assertWorkspaceOperationNativeDeleteBatchPlanCurrentV4(plan, actual.input.observation, actual.jobScope);
      assert.deepEqual(captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitnessV4(plan, actual.input.observation, actual.jobScope), plan.sourceEvidence);
    }
  });
  family('warmed plan entry points reject root and nested getters and proxies without executing any traps', () => {
    const actual = richFixture('tiptap_xml'), plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
    decodeWorkspaceOperationNativeDeleteBatchPlanV4(plan); getWorkspaceOperationNativeDeleteLinkRecipesV4(plan);
    let traps = 0;
    const handler: ProxyHandler<object> = {
      get() { traps++; throw new Error('Hostile plan get trap.'); },
      ownKeys() { traps++; throw new Error('Hostile plan keys trap.'); },
      getPrototypeOf() { traps++; throw new Error('Hostile plan prototype trap.'); },
      getOwnPropertyDescriptor() { traps++; throw new Error('Hostile plan descriptor trap.'); },
    };
    decodeWorkspaceOperationMixedSourceEvidenceV5(plan.sourceEvidence);
    const evidenceGetter = { ...plan.sourceEvidence };
    Object.defineProperty(evidenceGetter, 'nativeComponent', { enumerable: true,
      get() { traps++; throw new Error('Hostile evidence getter.'); } });
    Object.freeze(evidenceGetter);
    const evidenceProxy = new Proxy(plan.sourceEvidence, handler);
    const nestedEvidenceGetter = structuredClone(plan.sourceEvidence);
    Object.defineProperty(nestedEvidenceGetter.nativeOrdinarySources4[0], 'inventory', { enumerable: true,
      get() { traps++; throw new Error('Hostile evidence inventory getter.'); } });
    Object.freeze(nestedEvidenceGetter.nativeOrdinarySources4[0]); Object.freeze(nestedEvidenceGetter);
    for (const hostile of [evidenceGetter, evidenceProxy, nestedEvidenceGetter]) {
      assert.throws(() => decodeWorkspaceOperationMixedSourceEvidenceV5(hostile));
      assert.throws(() => workspaceOperationMixedSourceSnapshotV5(hostile as typeof plan.sourceEvidence));
    }
    const rootGetter = { ...plan };
    Object.defineProperty(rootGetter, 'sourceEvidence', { enumerable: true, get() { traps++; return plan.sourceEvidence; } });
    Object.freeze(rootGetter);
    const rootProxy = new Proxy(plan, handler);
    const nestedGetter = structuredClone(plan);
    Object.defineProperty(nestedGetter.sourceEvidence, 'nativeOrdinarySources4', {
      enumerable: true, get() { traps++; throw new Error('Hostile nested evidence getter.'); },
    });
    Object.freeze(nestedGetter.sourceEvidence); Object.freeze(nestedGetter);
    const nestedProxy = structuredClone(plan);
    Reflect.set(nestedProxy.sourceEvidence.nativeComponent.stage, 'sources',
      new Proxy(nestedProxy.sourceEvidence.nativeComponent.stage.sources, handler));
    Object.freeze(nestedProxy.sourceEvidence.nativeComponent.stage); Object.freeze(nestedProxy);
    for (const hostile of [rootGetter, rootProxy, nestedGetter, nestedProxy]) {
      assert.throws(() => decodeWorkspaceOperationNativeDeleteBatchPlanV4(hostile));
      assert.throws(() => getWorkspaceOperationNativeDeleteLinkRecipesV4(hostile as typeof plan));
      assert.throws(() => computeWorkspaceOperationNativeDeleteBatchPlanIntegrityProofV4(hostile));
      assert.throws(() => captureWorkspaceOperationNativeDeleteBatchPlanCurrentWitnessV4(hostile as typeof plan, actual.input.observation, actual.jobScope));
    }
    assert.equal(traps, 0);
    assert.deepEqual(decodeWorkspaceOperationNativeDeleteBatchPlanV4(plan), plan);
    assertWorkspaceOperationNativeDeleteBatchPlanCurrentV4(plan, actual.input.observation, actual.jobScope);
  });
  await asyncFamily('warm rich plans preserve actual schema changes and expired async frame errors while plain plans retain cold parity', async () => {
    const plain = fixture(), plainPlan = createWorkspaceOperationNativeDeleteBatchPlanV4(plain.input);
    decodeWorkspaceOperationNativeDeleteBatchPlanV4(plainPlan); getWorkspaceOperationNativeDeleteLinkRecipesV4(plainPlan);
    for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) for (const outcome of ['success', 'throw'] as const) {
      const actual = richFixture(representation), plan = createWorkspaceOperationNativeDeleteBatchPlanV4(actual.input);
      decodeWorkspaceOperationNativeDeleteBatchPlanV4(plan); getWorkspaceOperationNativeDeleteLinkRecipesV4(plan);
      const reads = [decodeWorkspaceOperationNativeDeleteBatchPlanV4, getWorkspaceOperationNativeDeleteLinkRecipesV4,
        (value: typeof plan) => decodeWorkspaceOperationMixedSourceEvidenceV5(value.sourceEvidence),
        (value: typeof plan) => workspaceOperationMixedSourceSnapshotV5(value.sourceEvidence)] as const;
      let release!: () => void, child: Promise<void> | undefined;
      const gate = new Promise<void>(resolve => { release = resolve; }), primary = new Error('Original schema callback failure.');
      const operation = withNativeInspectionSchema(async () => {
        const schema = getNativeInspectionSchema();
        assert.deepEqual(decodeWorkspaceOperationNativeDeleteBatchPlanV4(plan), plan);
        const attributes = schema.marks.link.spec.attrs;
        assert(attributes); const href = Object.getOwnPropertyDescriptor(attributes, 'href'); assert(href);
        assert(Reflect.deleteProperty(attributes, 'href'), 'This owned frame must exercise an actual removed schema attribute.');
        try {
          for (const read of reads) {
            const warmFailure = htmlPlanFailureFacts(() => read(plan));
            const cold = freezeHtmlPlanFixture(structuredClone(plan));
            assert.deepEqual(htmlPlanFailureFacts(() => read(cold)), warmFailure);
          }
        } finally { Object.defineProperty(attributes, 'href', href); }
        assert.deepEqual(decodeWorkspaceOperationNativeDeleteBatchPlanV4(plan), plan);
        child = gate.then(() => {
          for (const read of reads) {
            const warmFailure = htmlPlanFailureFacts(() => read(plan));
            const cold = freezeHtmlPlanFixture(structuredClone(plan));
            assert.deepEqual(htmlPlanFailureFacts(() => read(cold)), warmFailure);
          }
          // These plain-only plans have no rich link attributes. An ended
          // inherited frame must not introduce a new rich-schema dependency.
          const plainCold = freezeHtmlPlanFixture(structuredClone(plainPlan));
          assert.deepEqual(decodeWorkspaceOperationNativeDeleteBatchPlanV4(plainPlan), plainPlan);
          assert.deepEqual(decodeWorkspaceOperationNativeDeleteBatchPlanV4(plainCold), plainPlan);
          assert.deepEqual(decodeWorkspaceOperationMixedSourceEvidenceV5(plainPlan.sourceEvidence), plainPlan.sourceEvidence);
          assert.deepEqual(decodeWorkspaceOperationMixedSourceEvidenceV5(plainCold.sourceEvidence), plainPlan.sourceEvidence);
          assert.deepEqual(workspaceOperationMixedSourceSnapshotV5(plainPlan.sourceEvidence),
            workspaceOperationMixedSourceSnapshotV5(plainCold.sourceEvidence));
          assert.deepEqual(getWorkspaceOperationNativeDeleteLinkRecipesV4(plainPlan),
            getWorkspaceOperationNativeDeleteLinkRecipesV4(freezeHtmlPlanFixture(structuredClone(plainPlan))));
        });
        await Promise.resolve(); assert.equal(getNativeInspectionSchema(), schema);
        if (outcome === 'throw') throw primary;
      });
      try {
        if (outcome === 'throw') await assert.rejects(operation, error => error === primary);
        else await operation;
      } finally { release(); }
      assert(child); await child;
      assert.deepEqual(decodeWorkspaceOperationNativeDeleteBatchPlanV4(plan), plan);
      assertWorkspaceOperationNativeDeleteBatchPlanCurrentV4(plan, actual.input.observation, actual.jobScope);
    }
  });
  // New physical arm uses these existing real Yjs/UTF8 pure fixtures only.
  // No filesystem capability, SQL, principal or successful execution is implied.
  const physicalFixture = (name: string, native = true) => {
    const value = fixture({ native: native ? [['note.md', '[Asset](' + name + ')\n\n<p>Unchanged native HTML</p>']] : [],
      raw: [['page.html','<p>Unchanged whole-file HTML</p>']],extra:[{path:name,kind:'file'}] });
    value.input.actions[0].selections[0].sourcePath = name; return value;
  };
  family('Physical5 PNG/PDF/ordinary files retain genuine native unlink and unaffected HTML', () => {
    for (const name of ['picture.png','report.pdf','ordinary.asset']) {
      const value = physicalFixture(name), before = structuredClone(value.input.observation);
      const plan = createWorkspaceOperationPhysicalDeleteBatchPlanV5(value.input);
      assert.equal(plan.version,5); assert.equal(plan.kind,'physical-original-delete'); assert.equal(plan.targetAuthority,'filesystem');
      assert.equal(plan.physicalTarget.path,name); assert.equal(plan.physicalTarget.documentId,null);
      assert.equal(plan.physicalTarget.lifecycleGeneration,null); assert.equal(Object.hasOwn(plan,'nativeTarget'),false);
      assert.equal(plan.coverage.complete,false); assert.equal(plan.linkAssessment.complete,true);
      assert.deepEqual(plan.sourceEvidence.coverage,before.stage.coverage);
      assert.equal(getWorkspaceOperationPhysicalDeleteLinkRecipesV5(plan).length,1);
      assert.equal(getWorkspaceOperationPhysicalDeleteLinkRecipesV5(plan)[0].source.path,'note.md');
      assert.equal(plan.nativeGraphPlan.finalNamespace.some(entry=>entry.path===name),false);
      assert.equal(plan.nativeGraphPlan.finalNamespace.some(entry=>entry.path==='page.html'),true);
      assert.deepEqual(decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(JSON.parse(JSON.stringify(plan))),plan);
      assert.deepEqual(captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5(plan,value.input.observation,value.jobScope),plan.sourceEvidence);
      assert.deepEqual(value.input.observation,before);
    }
  });
  family('Physical5 asset-only and pristine IDs are filesystem facts without a native target', () => {
    for (const pristine of [false,true]) {
      const value = physicalFixture('pristine.pdf',false);
      if (pristine) {
        value.actual.observation.privateCatalogue.push({id:'pristine-physical-d1',lineage_id:'pristine-physical-l1',path:'pristine.pdf',
          workspace_id:value.jobScope.workspaceId,organization_id:null,status:'active',state_version:0,yjs_state_lifecycle:'never_initialized',
          has_persisted_state:false,has_state_history:false,lifecycle_generation:null,authority:'pristine',state_status:null,state_path:null,
          state_workspace_id:null,state_organization_id:null});
        refresh(value.actual);
      }
      const plan = createWorkspaceOperationPhysicalDeleteBatchPlanV5(value.input);
      assert.equal(plan.sourceEvidence.nativeComponent.nativeBindings.length,0); assert.deepEqual(plan.nativeGraphPlan.documentEvidence,[]);
      assert.deepEqual(getWorkspaceOperationPhysicalDeleteLinkRecipesV5(plan),[]); assert.equal(plan.physicalTarget.documentId,null);
      assert.deepEqual(captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5(plan,value.input.observation,value.jobScope),plan.sourceEvidence);
    }
  });
  family('Physical5 and native A4 identities cannot be retagged or erase false coverage', () => {
    const value=physicalFixture('picture.png'),plan=createWorkspaceOperationPhysicalDeleteBatchPlanV5(value.input);
    assert.equal(computeWorkspaceOperationPhysicalDeleteBatchPlanIdV5(plan),plan.planId);
    assert.equal(computeWorkspaceOperationPhysicalDeleteBatchPlanIntegrityProofV5(plan),plan.integrityProof);
    assert.throws(()=>decodeWorkspaceOperationNativeDeleteBatchPlan(plan));
    for(const mode of ['native-retag','wrong-authority','false-complete','omit-html','drop-unlink'] as const){
      const forged=structuredClone(plan) as unknown as Mutable<typeof plan>;
      if(mode==='native-retag'){Reflect.set(forged,'version',2);Reflect.set(forged,'planIdentityVersion',4);Reflect.set(forged,'kind','native-original-delete');}
      if(mode==='wrong-authority')Reflect.set(forged,'targetAuthority','native');
      if(mode==='false-complete')forged.coverage.complete=true;
      if(mode==='omit-html')forged.nativeGraphPlan.finalNamespace=forged.nativeGraphPlan.finalNamespace.filter(entry=>entry.path!=='page.html');
      if(mode==='drop-unlink')forged.nativeGraphPlan.steps[0].linkIntents=[];
      try{forged.planId=computeWorkspaceOperationPhysicalDeleteBatchPlanIdV5(forged);forged.integrityProof=computeWorkspaceOperationPhysicalDeleteBatchPlanIntegrityProofV5(forged);}catch{}
      assert.throws(()=>decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(forged));
    }
  });
  family('Physical5 affected or opaque HTML and unimported incoming raw are fail-closed without changing facts', () => {
    for(const location of ['native','raw','whole','opaque','raw-ordinary'] as const){
      const value=fixture({native:[['note.md',location==='native'?'<img src="asset.png">':'# Native']],
        raw:location==='raw'?[['raw.md','<img src="asset.png">']]:location==='whole'?[['page.html','<img src="asset.png">']]
          :location==='opaque'?[['page.html','<unknown value="asset.png">Opaque</unknown>']]
          :location==='raw-ordinary'?[['raw.md','[Asset](asset.png)']]:[],extra:[{path:'asset.png',kind:'file'}]});
      value.input.actions[0].selections[0].sourcePath='asset.png';const before=structuredClone(value.input.observation);
      assert.throws(()=>createWorkspaceOperationPhysicalDeleteBatchPlanV5(value.input));
      const preparation=createWorkspacePathPhysicalDeletePreparationPlanV5({scope:value.jobScope,kind:'delete',selections:[{sourcePath:'asset.png'}],observation:value.input.observation});
      assert.equal(preparation.readiness,'blocked');assert.equal(preparation.executionReady,false);
      assert.deepEqual(value.input.observation,before);
    }
  });
  family('Physical5 SOURCE-PRESENT Current rejects changed target, workspace and unselected namespace', () => {
    for(const changed of ['target','other','workspace'] as const){
      const value=physicalFixture('picture.png'),plan=createWorkspaceOperationPhysicalDeleteBatchPlanV5(value.input);
      if(changed==='workspace'){
        assert.throws(()=>captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5(plan,value.input.observation,{...value.jobScope,workspaceId:'foreign-workspace'}));continue;
      }
      const entry=value.input.observation.stage.namespace.find(entry=>entry.path===(changed==='target'?'picture.png':'page.html'))!;
      entry.filesystemIdentity='9:9:0:200:200';entry.identity=entry.filesystemIdentity;
      if(changed==='other')value.input.observation.stage.sources=value.input.observation.stage.sources.map(source=>source.kind==='physical'&&source.inventory.path===entry.path
        ?{kind:'physical',inventory:inspectOriginalPhysicalLinksV3({workspaceId:source.inventory.workspaceId,organizationId:source.inventory.organizationId,
          path:source.inventory.path,bytes:source.inventory.originalBytes,filesystemIdentity:entry.filesystemIdentity!,authority:source.inventory.authority})}:source);
      refresh(value.actual);
      assert.throws(()=>captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5(plan,value.input.observation,value.jobScope));
    }
  });
  family('Physical5 raw/native/folder exclusions and hostile plan fields retain strict dispatch', () => {
    for(const name of ['note.md','page.html']){
      const value=physicalFixture('picture.png');value.input.actions[0].selections[0].sourcePath=name;
      assert.throws(()=>createWorkspaceOperationPhysicalDeleteBatchPlanV5(value.input));
    }
    const value=physicalFixture('picture.png'),plan=createWorkspaceOperationPhysicalDeleteBatchPlanV5(value.input);
    let reads=0;const hostile={...plan};Object.defineProperty(hostile,'sourceEvidence',{enumerable:true,get(){reads++;throw Error('getter must not run');}});
    assert.throws(()=>decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(hostile));assert.equal(reads,0);
    assert.throws(()=>decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(new Proxy(plan,{ownKeys(){reads++;throw Error('proxy must not run');}})));assert.equal(reads,0);
    const folder=fixture({extra:[{path:'folder',kind:'directory'}]});folder.input.actions[0].selections[0].sourcePath='folder';
    assert.throws(()=>createWorkspaceOperationPhysicalDeleteBatchPlanV5(folder.input));
  });

  await asyncFamily('Physical5 immutable historical details retain cold, detached, hostile, Current and grammar parity', async () => {
    const make = (representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks') => {
      const value = physicalFixture('historical.png');
      if (representation === 'plain_text') return value;
      const state = value.input.observation.privateNativeStates.find(row => row.path === 'note.md')!;
      const doc = createRichMarkdownYDoc('[**Asset**](historical.png)\n\n<p>Unchanged native HTML</p>', representation);
      try { state.representation = representation; state.yjsState = Y.encodeStateAsUpdate(doc); state.stateVector = Y.encodeStateVector(doc); }
      finally { doc.destroy(); }
      const inventory = inspectPersistedDocumentLinks(state);
      const binding = value.input.observation.nativeBindings.find(row => row.expected.documentId === state.documentId)!;
      binding.expected.representation = representation; binding.expected.binaryHash = sha(state.yjsState);
      binding.expected.vectorHash = sha(state.stateVector); binding.expected.stateProof = inventory.version.stateProof;
      binding.inventoryProof = proof(inventory);
      value.input.observation.stage.sources = value.input.observation.stage.sources.map(source => source.kind === 'native'
        && source.inventory.document.documentId === state.documentId ? { kind: 'native', inventory } : source);
      refresh(value.actual); return value;
    };
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
      const actual = make(representation), observation = structuredClone(actual.input.observation);
      const plan = createWorkspaceOperationPhysicalDeleteBatchPlanV5(actual.input);
      const first = decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(plan), second = decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(plan);
      assert.deepEqual(first, plan); assert.deepEqual(second, plan); assert.notEqual(first, plan); assert.notEqual(first, second);
      assert.notEqual(first.sourceEvidence, second.sourceEvidence); assert.notEqual(first.nativeGraphPlan, second.nativeGraphPlan);
      assert(Object.isFrozen(first)); assert(Object.isFrozen(first.sourceEvidence)); assert(Object.isFrozen(first.nativeGraphPlan));
      assert.equal(Reflect.set(first.coverage, 'complete', true), false);
      const foreign = freezeHtmlPlanFixture(structuredClone(plan)), cold = decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(foreign);
      assert.deepEqual(cold, plan); assert.notEqual(cold, foreign);
      const recipes = getWorkspaceOperationPhysicalDeleteLinkRecipesV5(plan), expectedRecipes = structuredClone(recipes);
      const copiedRecipes = getWorkspaceOperationPhysicalDeleteLinkRecipesV5(plan);
      assert.equal(recipes.length, 1); assert.deepEqual(copiedRecipes, recipes); assert.notEqual(copiedRecipes, recipes);
      assert.notEqual(copiedRecipes[0], recipes[0]); Reflect.set(copiedRecipes[0], 'nextValue', 'caller-owned changed copy');
      assert.deepEqual(getWorkspaceOperationPhysicalDeleteLinkRecipesV5(plan), expectedRecipes);
      assert.deepEqual(getWorkspaceOperationPhysicalDeleteLinkRecipesV5(foreign), expectedRecipes);
      const mutable = structuredClone(plan); assert.deepEqual(decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(mutable), plan);
      Reflect.set(mutable.coverage, 'complete', true);
      Reflect.set(mutable, 'integrityProof', computeWorkspaceOperationPhysicalDeleteBatchPlanIntegrityProofV5(mutable));
      const failure = htmlPlanFailureFacts(() => decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(mutable));
      const frozenForgery = freezeHtmlPlanFixture(structuredClone(mutable));
      assert.deepEqual(htmlPlanFailureFacts(() => decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(frozenForgery)), failure);
      assert.deepEqual(htmlPlanFailureFacts(() => getWorkspaceOperationPhysicalDeleteLinkRecipesV5(frozenForgery)), failure);
      let traps = 0;
      const handler: ProxyHandler<object> = {
        get() { traps++; throw new Error('Hostile Physical5 get trap.'); },
        ownKeys() { traps++; throw new Error('Hostile Physical5 keys trap.'); },
        getPrototypeOf() { traps++; throw new Error('Hostile Physical5 prototype trap.'); },
        getOwnPropertyDescriptor() { traps++; throw new Error('Hostile Physical5 descriptor trap.'); },
      };
      const getter = { ...plan };
      Object.defineProperty(getter, 'sourceEvidence', { enumerable: true, get() { traps++; return plan.sourceEvidence; } });
      Object.freeze(getter);
      const nestedGetter = structuredClone(plan);
      Object.defineProperty(nestedGetter.sourceEvidence, 'nativeOrdinarySources4', { enumerable: true,
        get() { traps++; throw new Error('Hostile Physical5 nested getter.'); } });
      Object.freeze(nestedGetter.sourceEvidence); Object.freeze(nestedGetter);
      const nestedProxy = structuredClone(plan);
      Reflect.set(nestedProxy.sourceEvidence.nativeComponent.stage, 'sources', new Proxy(nestedProxy.sourceEvidence.nativeComponent.stage.sources, handler));
      Object.freeze(nestedProxy.sourceEvidence.nativeComponent.stage); Object.freeze(nestedProxy);
      for (const hostile of [getter, new Proxy(plan, handler), nestedGetter, nestedProxy]) {
        assert.throws(() => decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(hostile));
        assert.throws(() => getWorkspaceOperationPhysicalDeleteLinkRecipesV5(hostile as typeof plan));
        assert.throws(() => captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5(hostile as typeof plan, actual.input.observation, actual.jobScope));
      }
      assert.equal(traps, 0);
      const state = actual.input.observation.privateNativeStates.find(row => row.path === 'note.md')!, bytes = state.yjsState.slice();
      try {
        state.yjsState[0] ^= 0xff;
        const currentFailure = htmlPlanFailureFacts(() => captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5(plan, actual.input.observation, actual.jobScope));
        assert.deepEqual(htmlPlanFailureFacts(() => captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5(
          freezeHtmlPlanFixture(structuredClone(plan)), actual.input.observation, actual.jobScope)), currentFailure);
      } finally { state.yjsState.set(bytes); }
      assert.deepEqual(actual.input.observation, observation);
      assert.deepEqual(captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5(plan, actual.input.observation, actual.jobScope), plan.sourceEvidence);
      if (representation === 'plain_text') {
        const oversized = structuredClone(plan); Reflect.set(oversized, 'oversized', 'x'.repeat(16 * 1024 * 1024));
        const tooLarge = htmlPlanFailureFacts(() => decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(oversized));
        assert.equal(tooLarge.code, 'PHYSICAL_DELETE_PLAN_TOO_LARGE');
        assert.deepEqual(htmlPlanFailureFacts(() => decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(freezeHtmlPlanFixture(oversized))), tooLarge);
      }
    }
    const plain = make('plain_text'), plainPlan = createWorkspaceOperationPhysicalDeleteBatchPlanV5(plain.input);
    for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) for (const outcome of ['success', 'throw'] as const) {
      const actual = make(representation), plan = createWorkspaceOperationPhysicalDeleteBatchPlanV5(actual.input);
      decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(plan); getWorkspaceOperationPhysicalDeleteLinkRecipesV5(plan);
      const reads = [decodeWorkspaceOperationPhysicalDeleteBatchPlanV5, getWorkspaceOperationPhysicalDeleteLinkRecipesV5] as const;
      let release!: () => void, child: Promise<void> | undefined;
      const gate = new Promise<void>(resolve => { release = resolve; }), primary = new Error('Original Physical5 schema callback failure.');
      const operation = withNativeInspectionSchema(async () => {
        const schema = getNativeInspectionSchema(); assert.deepEqual(decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(plan), plan);
        const attributes = schema.marks.link.spec.attrs; assert(attributes);
        const href = Object.getOwnPropertyDescriptor(attributes, 'href'); assert(href);
        assert(Reflect.deleteProperty(attributes, 'href'));
        try {
          for (const read of reads) {
            const warmFailure = htmlPlanFailureFacts(() => read(plan));
            assert.deepEqual(htmlPlanFailureFacts(() => read(freezeHtmlPlanFixture(structuredClone(plan)))), warmFailure);
          }
        } finally { Object.defineProperty(attributes, 'href', href); }
        assert.deepEqual(decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(plan), plan);
        child = gate.then(() => {
          for (const read of reads) {
            const warmFailure = htmlPlanFailureFacts(() => read(plan));
            assert.deepEqual(htmlPlanFailureFacts(() => read(freezeHtmlPlanFixture(structuredClone(plan)))), warmFailure);
            assert.deepEqual(read(plainPlan), read(freezeHtmlPlanFixture(structuredClone(plainPlan))));
          }
        });
        await Promise.resolve(); assert.equal(getNativeInspectionSchema(), schema);
        if (outcome === 'throw') throw primary;
      });
      try { if (outcome === 'throw') await assert.rejects(operation, error => error === primary); else await operation; }
      finally { release(); }
      assert(child); await child;
      assert.deepEqual(decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(plan), plan);
      assert.deepEqual(captureWorkspaceOperationPhysicalDeleteCurrentWitnessV5(plan, actual.input.observation, actual.jobScope), plan.sourceEvidence);
    }
  });
  family('Cohort6 native folder and PNG/PDF compile one recursive Delete over genuine V5 evidence',()=>{
    const value=fixture({native:[['folder/a.md','[Other](sub/b.md)'],['folder/sub/b.md','# B'],['incoming.md','[A](folder/a.md) [B](folder/sub/b.md) ![PNG](folder/picture.png) [PDF](folder/report.pdf)']],
      raw:[['page.html','<p>Unaffected HTML</p>']],extra:[{path:'folder/picture.png',kind:'file'},{path:'folder/report.pdf',kind:'file'}]});
    value.input.actions[0].selections=[{sourcePath:'folder'}];
    const plan=createWorkspaceOperationCohortDeletePlan(value.input);assert.equal(plan.version,6);assert.equal(plan.kind,'native-cohort-delete');assert.equal(plan.sourceEvidence.evidenceVersion,5);
    assert.equal(plan.nativeGraphPlan.contractVersion,5);assert.equal(plan.pathSteps.length,1);assert.equal(plan.targets.filter(target=>target.documentId).length,2);
    assert(plan.targets.some(target=>target.path==='folder/sub'&&target.kind==='directory'));
    assert.deepEqual(workspaceOperationCohortDeleteEffects(plan),[{documentId:value.input.observation.nativeBindings.find(binding=>binding.expected.path==='incoming.md')!.expected.documentId,path:'incoming.md',updatedLinks:4}]);
    assert(plan.nativeGraphPlan.finalNamespace.every(entity=>!entity.path.startsWith('folder/')));
    assert.deepEqual(decodeWorkspaceOperationCohortDeletePlan(structuredClone(plan)),plan);
    assert.throws(()=>decodeWorkspaceOperationNativeDeleteBatchPlan(plan));assert.throws(()=>decodeWorkspaceOperationPhysicalDeleteBatchPlanV5(plan));
    const preview=workspaceOperationMcpCohortDeletePreview(plan);assert.equal(preview.version,3);assert.equal(preview.linkChanges.unlinks,4);
    assert.equal(preview.linkChanges.affectedDocuments,1);assert.equal(Object.hasOwn(preview,'targets'),false);assert.equal(Object.hasOwn(preview,'sourceEvidence'),false);
  });
  family('Cohort6 multiple roots, Current evidence and graph tampering preserve exact original target membership',()=>{
    const value=fixture({native:[['a/note.md','# A'],['b/note.md','# B'],['incoming.md','[A](a/note.md) [B](b/note.md)']],raw:[],extra:[]});
    value.input.actions[0].selections=[{sourcePath:'b'},{sourcePath:'a'}];const plan=createWorkspaceOperationCohortDeletePlan(value.input);
    assert.deepEqual(plan.pathSteps.map(step=>step.sourcePath),['b','a']);assert.equal(workspaceOperationCohortDeleteEffects(plan)[0].updatedLinks,2);
    assert.equal(captureWorkspaceOperationCohortDeleteCurrent(plan,value.input.observation,value.jobScope).semanticProof,plan.sourceEvidence.semanticProof);
    const forged=structuredClone(plan);forged.targets.pop();assert.throws(()=>decodeWorkspaceOperationCohortDeletePlan(forged));
    const wrongScope={...value.jobScope,workspaceId:'foreign'};assert.throws(()=>captureWorkspaceOperationCohortDeleteCurrent(plan,value.input.observation,wrongScope));
    const overlapping=structuredClone(value.input);overlapping.actions[0].selections=[{sourcePath:'a'},{sourcePath:'a/note.md'}];assert.throws(()=>createWorkspaceOperationCohortDeletePlan(overlapping));
  });
  await asyncFamily('Cohort6 raw/MDX/HTML/custom selections are precisely blocked and hostile or retagged envelopes reject',async()=>{
    for(const [path,raw]of [['folder/raw.md','# Raw'],['folder/page.html','<p>HTML</p>']] as const){
      const value=fixture({native:[['folder/note.md','# Native']],raw:[[path,raw]],extra:[]});value.input.actions[0].selections=[{sourcePath:'folder'}];
      const preparation=createWorkspacePathCohortDeletePreparation({workspace:value.input.scope.workspace,selections:value.input.actions[0].selections,observation:value.input.observation});
      assert.equal(preparation.readiness,'blocked');assert(preparation.issues.some(issue=>issue.path===path&&issue.code==='unsupported-cohort-delete-source'));
      assert.throws(()=>createWorkspaceOperationCohortDeletePlan(value.input));}
    assert.throws(()=>fixture({native:[['folder/note.md','# Native']],raw:[],extra:[{path:'folder/custom.mdx',kind:'file'}]}),error=>{
      assert(error instanceof WorkspaceOperationNativeSourceEvidenceError);
      assert.equal(error.code,'NATIVE_SOURCE_IMPORT_REQUIRED');assert.equal(error.status,409);return true;
    });
    for(const path of ['folder/scene.excalidraw']){const value=fixture({native:[['folder/note.md','# Native']],raw:[],extra:[{path,kind:'file'}]});
      value.input.actions[0].selections=[{sourcePath:'folder'}];assert.throws(()=>createWorkspaceOperationCohortDeletePlan(value.input));}
    const value=fixture({native:[['folder/note.md','# Native']],raw:[],extra:[]});value.input.actions[0].selections=[{sourcePath:'folder'}];const plan=createWorkspaceOperationCohortDeletePlan(value.input);
    let reads=0;const hostile={...plan};Object.defineProperty(hostile,'sourceEvidence',{enumerable:true,get(){reads++;throw Error('must not invoke');}});
    assert.throws(()=>decodeWorkspaceOperationCohortDeletePlan(hostile));assert.equal(reads,0);
    for(const version of [1,2,3,5])assert.throws(()=>decodeWorkspaceOperationCohortDeletePlan({...plan,version}));
    // Additive historical-details regression; all original negative assertions above remain.
    const make = (representation: 'plain_text' | 'tiptap_xml' | 'tiptap_blocks') => {
      const actual = fixture({ native: [['folder/note.md', '# Original'], ['incoming.md', '[**Target**](folder/note.md)\n\nUnchanged']], raw: [], extra: [] });
      actual.input.actions[0].selections = [{ sourcePath: 'folder' }];
      if (representation !== 'plain_text') {
        const state = actual.input.observation.privateNativeStates.find(row => row.path === 'incoming.md')!;
        const doc = createRichMarkdownYDoc('[**Target**](folder/note.md)\n\nUnchanged', representation);
        try { state.representation = representation; state.yjsState = Y.encodeStateAsUpdate(doc); state.stateVector = Y.encodeStateVector(doc); }
        finally { doc.destroy(); }
        const inventory = inspectPersistedDocumentLinks(state);
        const binding = actual.input.observation.nativeBindings.find(row => row.expected.documentId === state.documentId)!;
        binding.expected.representation = representation; binding.expected.binaryHash = sha(state.yjsState);
        binding.expected.vectorHash = sha(state.stateVector); binding.expected.stateProof = inventory.version.stateProof; binding.inventoryProof = proof(inventory);
        actual.input.observation.stage.sources = actual.input.observation.stage.sources.map(source => source.kind === 'native'
          && source.inventory.document.documentId === state.documentId ? { kind: 'native', inventory } : source);
        refresh(actual.actual);
      }
      return actual;
    };
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
      const actual = make(representation), originalObservation = structuredClone(actual.input.observation);
      const original = createWorkspaceOperationCohortDeletePlan(actual.input);
      const first = decodeWorkspaceOperationCohortDeletePlan(original), second = decodeWorkspaceOperationCohortDeletePlan(original);
      assert.deepEqual(first, original); assert.deepEqual(second, original); assert.notEqual(first, original); assert.notEqual(first, second);
      assert.notEqual(first.sourceEvidence, second.sourceEvidence); assert.notEqual(first.nativeGraphPlan, second.nativeGraphPlan);
      assert(Object.isFrozen(first)); assert(Object.isFrozen(first.sourceEvidence)); assert(Object.isFrozen(first.nativeGraphPlan));
      assert.equal(Reflect.set(first.coverage, 'complete', false), false);
      const foreign = freezeHtmlPlanFixture(structuredClone(original)); assert.deepEqual(decodeWorkspaceOperationCohortDeletePlan(foreign), original);
      const recipes = getWorkspaceOperationCohortDeleteRecipes(original), expectedRecipes = structuredClone(recipes);
      assert.equal(recipes.length, 1); const copiedRecipes = getWorkspaceOperationCohortDeleteRecipes(original);
      assert.deepEqual(copiedRecipes, expectedRecipes); assert.notEqual(copiedRecipes, recipes); assert.notEqual(copiedRecipes[0], recipes[0]);
      Reflect.set(copiedRecipes[0], 'nextValue', 'caller-owned mutation');
      assert.deepEqual(getWorkspaceOperationCohortDeleteRecipes(original), expectedRecipes); assert.deepEqual(getWorkspaceOperationCohortDeleteRecipes(foreign), expectedRecipes);
      const mutable = structuredClone(original); assert.deepEqual(decodeWorkspaceOperationCohortDeletePlan(mutable), original);
      mutable.targets.pop(); mutable.integrityProof = proof({ kind: 'native-cohort-delete-integrity',
        plan: Object.fromEntries(Object.entries(mutable).filter(([key]) => key !== 'integrityProof')) });
      const failure = htmlPlanFailureFacts(() => decodeWorkspaceOperationCohortDeletePlan(mutable));
      const frozenForgery = freezeHtmlPlanFixture(structuredClone(mutable));
      assert.deepEqual(htmlPlanFailureFacts(() => decodeWorkspaceOperationCohortDeletePlan(frozenForgery)), failure);
      assert.deepEqual(htmlPlanFailureFacts(() => getWorkspaceOperationCohortDeleteRecipes(frozenForgery)), failure);
      let traps = 0;
      const handler: ProxyHandler<object> = { get() { traps++; throw Error('Cohort proxy get'); }, ownKeys() { traps++; throw Error('Cohort proxy keys'); },
        getPrototypeOf() { traps++; throw Error('Cohort proxy prototype'); }, getOwnPropertyDescriptor() { traps++; throw Error('Cohort proxy descriptor'); } };
      const getter = { ...original }; Object.defineProperty(getter, 'sourceEvidence', { enumerable: true, get() { traps++; return original.sourceEvidence; } }); Object.freeze(getter);
      const nested = structuredClone(original); Object.defineProperty(nested.sourceEvidence, 'nativeOrdinarySources4', { enumerable: true, get() { traps++; throw Error('Cohort nested getter'); } });
      Object.freeze(nested.sourceEvidence); Object.freeze(nested);
      for (const hostile of [getter, new Proxy(original, handler), nested]) {
        assert.throws(() => decodeWorkspaceOperationCohortDeletePlan(hostile)); assert.throws(() => getWorkspaceOperationCohortDeleteRecipes(hostile as typeof original));
        assert.throws(() => captureWorkspaceOperationCohortDeleteCurrent(hostile as typeof original, actual.input.observation, actual.jobScope));
      }
      assert.equal(traps, 0);
      const state = actual.input.observation.privateNativeStates.find(row => row.path === 'incoming.md')!, bytes = state.yjsState.slice();
      try {
        state.yjsState[0] ^= 0xff;
        const currentFailure = htmlPlanFailureFacts(() => captureWorkspaceOperationCohortDeleteCurrent(original, actual.input.observation, actual.jobScope));
        assert.deepEqual(htmlPlanFailureFacts(() => captureWorkspaceOperationCohortDeleteCurrent(
          freezeHtmlPlanFixture(structuredClone(original)), actual.input.observation, actual.jobScope)), currentFailure);
      } finally { state.yjsState.set(bytes); }
      assert.deepEqual(actual.input.observation, originalObservation);
      assert.deepEqual(captureWorkspaceOperationCohortDeleteCurrent(original, actual.input.observation, actual.jobScope), original.sourceEvidence);
      if (representation === 'plain_text') {
        const oversized = structuredClone(original); Reflect.set(oversized, 'oversized', 'x'.repeat(16 * 1024 * 1024));
        const tooLarge = htmlPlanFailureFacts(() => decodeWorkspaceOperationCohortDeletePlan(oversized)); assert.equal(tooLarge.code, 'COHORT_DELETE_TOO_LARGE');
        assert.deepEqual(htmlPlanFailureFacts(() => decodeWorkspaceOperationCohortDeletePlan(freezeHtmlPlanFixture(oversized))), tooLarge);
      }
    }
    // Pure stored-row decoding must keep every current row field outside the
    // exact-text historical Plan6 reuse. This supplies no Claim or actor rights.
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) await withNativeInspectionSchema(async () => {
      const actual = make(representation), original = createWorkspaceOperationCohortDeletePlan(actual.input);
      const planText = JSON.stringify(original);
      const actor = { mode: 'direct', actorType: 'user', actorUserId: 'stored-fixture-user', actorId: 'stored-fixture-user',
        actorDisplayName: 'Stored fixture', requestHash: proof({ planId: original.planId }), jobScope: actual.jobScope };
      const row: Record<string, unknown> = { batch_id: proof({ storedPlan: original.planId }), plan_id: original.planId,
        workspace_id: original.workspaceId, plan_json: planText, authorization_json: JSON.stringify(actor),
        review_ids_json: '[]', review_refs_json: '[]', reviewer_user_id: null, reviewer_display_name: null,
        status: 'queued', action_mode: 'apply', completed_actions: 0, total_actions: workspaceOperationBatchTotalActions(original),
        phase: 'preparing', error_code: null, trash_entry_ids_json: '[]', lease_owner: null, created_at: 100, updated_at: 100 };
      const firstRecord = decodeWorkspaceOperationBatchRecord(row), secondRecord = decodeWorkspaceOperationBatchRecord(row);
      assert(firstRecord.plan.version === 6 && secondRecord.plan.version === 6);
      assert.deepEqual(firstRecord.plan, original); assert.deepEqual(secondRecord.plan, original);
      assert.notEqual(firstRecord.plan, secondRecord.plan); assert.notEqual(firstRecord.plan.sourceEvidence, secondRecord.plan.sourceEvidence);
      assert(Object.isFrozen(firstRecord.plan)); assert(Object.isFrozen(secondRecord.plan));
      assert(Object.isFrozen(secondRecord.plan.sourceEvidence));
      assert.equal(Reflect.set(secondRecord.plan.coverage, 'complete', false), false);
      assert.equal(firstRecord.status, 'queued');
      const freshActor = { ...actor, actorUserId: 'fresh-row-user', actorId: 'fresh-row-user', actorDisplayName: 'Fresh row' };
      const fresh = decodeWorkspaceOperationBatchRecord({ ...row, status: 'applied', authorization_json: JSON.stringify(freshActor),
        completed_actions: row.total_actions, phase: 'complete', updated_at: 200, error_code: 'FRESH_ROW_CODE',
        trash_entry_ids_json: '["fresh-trash"]', lease_owner: 'fresh-lease' });
      assert.equal(fresh.status, 'applied'); assert.deepEqual(fresh.authorization, freshActor);
      assert.equal(fresh.completedActions, row.total_actions); assert.equal(fresh.phase, 'complete'); assert.equal(fresh.updatedAt, 200);
      assert.equal(fresh.errorCode, 'FRESH_ROW_CODE'); assert.deepEqual(fresh.trashEntryIds, ['fresh-trash']); assert.equal(fresh.leaseOwner, 'fresh-lease');
      assert.deepEqual(fresh.plan, original); assert.notEqual(fresh.plan, firstRecord.plan);
      for (const change of [{ plan_id: 'f'.repeat(64) }, { workspace_id: 'foreign-workspace' },
        { authorization_json: JSON.stringify({ ...actor, requestHash: 'invalid' }) },
        { authorization_json: JSON.stringify({ ...actor, jobScope: { ...actor.jobScope, workspaceId: 'foreign-workspace' } }) }]) {
        const failure = htmlPlanFailureFacts(() => decodeWorkspaceOperationBatchRecord({ ...row, ...change }));
        assert(['BATCH_INVALID_PLAN', 'BATCH_INVALID_AUTHORIZATION'].includes(String(failure.code)));
      }
      const whitespace = decodeWorkspaceOperationBatchRecord({ ...row, plan_json: planText + ' ' });
      assert.deepEqual(whitespace.plan, original, 'A different valid JSON encoding remains valid; it cannot reuse a mismatching text key.');
      const changedProof = JSON.stringify({ ...original, integrityProof: (original.integrityProof[0] === 'a' ? 'b' : 'a') + original.integrityProof.slice(1) });
      const originalBytes = Buffer.from(planText), corruptBytes = Buffer.from(changedProof);
      assert.equal(corruptBytes.byteLength, originalBytes.byteLength);
      assert.equal(corruptBytes.filter((byte, index) => byte !== originalBytes[index]).length, 1);
      htmlPlanFailureFacts(() => decodeWorkspaceOperationBatchRecord({ ...row, plan_json: changedProof }));
      htmlPlanFailureFacts(() => decodeWorkspaceOperationBatchRecord({ ...row, plan_json: planText.slice(0, -1) }));
      assert.deepEqual(decodeWorkspaceOperationBatchRecord(row).plan, original, 'Invalid text must not contaminate the original successful entry.');
      const parseDescriptor = Object.getOwnPropertyDescriptor(JSON, 'parse'); assert(parseDescriptor && typeof parseDescriptor.value === 'function');
      const originalParse = JSON.parse; let lookups = 0;
      try {
        Object.defineProperty(JSON, 'parse', { configurable: true, enumerable: parseDescriptor.enumerable,
          get() { lookups++; return originalParse; } });
        assert.deepEqual(decodeWorkspaceOperationBatchRecord(row).plan, original);
        assert.equal(lookups, 5, 'Preserve one original JSON.parse lookup for each stored JSON field.');
      } finally { Object.defineProperty(JSON, 'parse', parseDescriptor); }
      let replacements = 0;
      try {
        JSON.parse = (text, reviver) => {
          replacements++;
          const value = originalParse(text, reviver);
          return text === planText ? { ...value, integrityProof: '0'.repeat(64) } : value;
        };
        htmlPlanFailureFacts(() => decodeWorkspaceOperationBatchRecord(row));
        assert.equal(replacements, 1, 'A foreign parser must execute for the warm plan text before its actual result is validated.');
      } finally { Object.defineProperty(JSON, 'parse', parseDescriptor); }
      assert.deepEqual(decodeWorkspaceOperationBatchRecord(row).plan, original);
      if (representation === 'plain_text') {
        const legacyPlan = { version: 1, linkPlan: { contractVersion: 1, status: 'planned', kind: 'delete',
          planId: '1'.repeat(64), readiness: 'ready', recoveryReady: false,
          pathMappings: [], linkEdits: [], expectedPathState: [], collisions: [], issues: [], previewContents: [],
          coverage: { complete: true, omittedSources: [], unresolvedLinks: [] } } };
        const legacyText = JSON.stringify(legacyPlan); let legacyVersionReads = 0;
        const legacyProxy = new Proxy(legacyPlan, { get(target, key, receiver) {
          if (key === 'version') legacyVersionReads++;
          return Reflect.get(target, key, receiver);
        } });
        try {
          JSON.parse = (text, reviver) => text === legacyText ? legacyProxy : originalParse(text, reviver);
          const legacyRecord = decodeWorkspaceOperationBatchRecord({ ...row, plan_json: legacyText });
          assert.equal(legacyVersionReads, 2, 'A foreign parser returning LegacyV1 must retain exactly the two original record version reads.');
          assert.equal(Object.getOwnPropertyDescriptor(legacyRecord.plan, 'version')?.value, 1);
          assert.equal(legacyRecord.plan, legacyProxy);
        } finally { Object.defineProperty(JSON, 'parse', parseDescriptor); }
      }
      if (representation !== 'plain_text') {
        const schema = getNativeInspectionSchema(), attributes = schema.marks.link.spec.attrs; assert(attributes);
        const href = Object.getOwnPropertyDescriptor(attributes, 'href'); assert(href); assert(Reflect.deleteProperty(attributes, 'href'));
        try {
          const warmFailure = htmlPlanFailureFacts(() => decodeWorkspaceOperationBatchRecord(row));
          const coldFailure = htmlPlanFailureFacts(() => decodeWorkspaceOperationBatchRecord({ ...row, plan_json: planText + '\n' }));
          assert.deepEqual(warmFailure, coldFailure, 'A warm exact Plan6 text must still reject the currently missing used rich-link attribute.');
        } finally { Object.defineProperty(attributes, 'href', href); }
        assert.deepEqual(decodeWorkspaceOperationBatchRecord(row).plan, original);
      }
    });
    const plain = make('plain_text'), plainPlan = createWorkspaceOperationCohortDeletePlan(plain.input);
    for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
      const actual = make(representation), original = createWorkspaceOperationCohortDeletePlan(actual.input);
      decodeWorkspaceOperationCohortDeletePlan(original); getWorkspaceOperationCohortDeleteRecipes(original);
      const reads = [decodeWorkspaceOperationCohortDeletePlan, getWorkspaceOperationCohortDeleteRecipes] as const;
      let release!: () => void, child: Promise<void> | undefined; const gate = new Promise<void>(resolve => { release = resolve; });
      const operation = withNativeInspectionSchema(async () => {
        const schema = getNativeInspectionSchema(), attributes = schema.marks.link.spec.attrs; assert(attributes);
        const href = Object.getOwnPropertyDescriptor(attributes, 'href'); assert(href); assert(Reflect.deleteProperty(attributes, 'href'));
        try { for (const read of reads) { const failure = htmlPlanFailureFacts(() => read(original));
          assert.deepEqual(htmlPlanFailureFacts(() => read(freezeHtmlPlanFixture(structuredClone(original)))), failure); } }
        finally { Object.defineProperty(attributes, 'href', href); }
        assert.deepEqual(decodeWorkspaceOperationCohortDeletePlan(original), original);
        child = gate.then(() => { for (const read of reads) { const failure = htmlPlanFailureFacts(() => read(original));
          assert.deepEqual(htmlPlanFailureFacts(() => read(freezeHtmlPlanFixture(structuredClone(original)))), failure);
          assert.deepEqual(read(plainPlan), read(freezeHtmlPlanFixture(structuredClone(plainPlan)))); } });
        await Promise.resolve(); assert.equal(getNativeInspectionSchema(), schema);
      });
      try { await operation; } finally { release(); }
      assert(child); await child;
      assert.deepEqual(decodeWorkspaceOperationCohortDeletePlan(original), original);
      assert.deepEqual(captureWorkspaceOperationCohortDeleteCurrent(original, actual.input.observation, actual.jobScope), original.sourceEvidence);
    }
  });
  assert.equal(families, 28);
  console.log(JSON.stringify({ suite: 'native-delete-html-plan-v4', families, pureFactsOnly: true, executionAuthority: false }));
}
