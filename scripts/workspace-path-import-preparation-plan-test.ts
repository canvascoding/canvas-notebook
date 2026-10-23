import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceDocumentCatalogueEntry } from '../app/lib/collaboration/workspace-document-catalogue';
import { prepareMarkdownFileImport } from '../app/lib/collaboration/markdown-file-import';
import type { WorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-batch-contract';
import { captureWorkspaceOperationNativePlanData } from '../app/lib/files/workspace-operation-native-plan-data';
import { captureWorkspaceOperationNativeSourceEvidenceV3 } from '../app/lib/files/workspace-operation-native-source-evidence-v3';
import { WorkspaceOperationNativeSourceEvidenceError } from '../app/lib/files/workspace-operation-native-source-evidence';
import { createWorkspacePathImportPreparationPlanV1, decodeWorkspacePathImportPreparationPlanV1,
  assertWorkspacePathImportPreparationPlanV1Current, WorkspacePathImportPreparationPlanError } from '../app/lib/files/workspace-path-import-preparation-plan';
import type { NativeNamespaceEntry } from '../app/lib/markdown/workspace-link-contract-v2';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { inspectOriginalPhysicalLinksV3, workspaceSourceAuthorityStageProof,
  type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceLinkSourceAuthorityObservation, WorkspaceNativeSourceBinding } from '../app/lib/markdown/workspace-source-authority-stage';

type Mutable<T> = T extends Uint8Array ? Uint8Array
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
type Fixture = { scope: WorkspaceOperationJobScope; observation: Mutable<WorkspaceLinkSourceAuthorityObservation>
  & { privateCatalogue: WorkspaceDocumentCatalogueEntry[] } };
type FixtureInput = { raw?: readonly (readonly [string, string])[]; native?: readonly (readonly [string, string])[];
  extra?: readonly Readonly<{ path: string; kind: 'file' | 'directory' }>[] };

/** Pure declared observations: these Yjs bytes, catalogue rows and filesystem
 * fingerprints are actual codec inputs, never SQL/FD/principal evidence. No
 * tests execute when this module is imported. */
export function workspacePathImportPreparationFixture(input: FixtureInput = {}): Fixture {
  const scope: WorkspaceOperationJobScope = { version: 1, workspaceId: 'path-import-fixture', workspaceType: 'personal',
    organizationId: null, customerId: null, projectId: null, ownerUserId: 'fixture-owner',
    rootPath: '/data/users/path-import-fixture/files', rootRelativePath: 'users/path-import-fixture/files', legacy: false };
  const states: PersistedCollaborationState[] = (input.native ?? [['note.md', '# Native\n']]).map(([filePath, text], index) => {
    const doc = createPlainTextYDoc(text);
    try { return { documentId: `native-fixture-${index}`, workspaceId: scope.workspaceId, organizationId: null,
      path: filePath, representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
      yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), documentSequence: 0, persistedAt: 100,
      checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
      newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' }; }
    finally { doc.destroy(); }
  });
  const inventories = states.map(inspectPersistedDocumentLinks);
  const nativeBindings: WorkspaceNativeSourceBinding[] = states.map((state, index) => {
    const lineageId = `lineage-fixture-${index}`;
    return { expected: { documentId: state.documentId, lineageId, workspaceId: scope.workspaceId, organizationId: null,
      path: state.path, representation: state.representation, schemaVersion: state.schemaVersion, lifecycleGeneration: 1,
      registryStateVersion: 0, documentSequence: 0, persistedAt: state.persistedAt, stateProof: inventories[index].version.stateProof,
      binaryHash: createHash('sha256').update(state.yjsState).digest('hex'), vectorHash: createHash('sha256').update(state.stateVector).digest('hex') },
    registry: { documentId: state.documentId, lineageId, workspaceId: scope.workspaceId, workspaceType: 'personal',
      organizationId: null, customerId: null, projectId: null, path: state.path, provider: 'yjs', stateLifecycle: 'initialized', stateVersion: 0, status: 'active' },
    lineage: { lineageId, workspaceId: scope.workspaceId, workspaceType: 'personal', organizationId: null,
      customerId: null, projectId: null, path: state.path, status: 'active', archivedAt: null, trashEntryId: null },
    byteProfile: { newlineStyle: 'lf', hasBom: false }, inventoryProof: proof(inventories[index]) };
  });
  const privateCatalogue: WorkspaceDocumentCatalogueEntry[] = states.map((state, index) => ({ id: state.documentId,
    lineage_id: nativeBindings[index].expected.lineageId, path: state.path, workspace_id: scope.workspaceId, organization_id: null,
    status: 'active', state_version: 0, has_persisted_state: true, has_state_history: false, lifecycle_generation: 1,
    authority: 'initialized', state_status: 'active', state_path: state.path, state_workspace_id: scope.workspaceId,
    state_organization_id: null, yjs_state_lifecycle: 'initialized' }));
  const catalogueProof = proof(privateCatalogue);
  const physical = (input.raw ?? [['raw.md', '# Raw\n']]).map(([filePath, text], index) => inspectOriginalPhysicalLinksV3({
    workspaceId: scope.workspaceId, organizationId: null, path: filePath, bytes: Buffer.from(text),
    authority: { kind: 'unregistered', catalogueProof }, filesystemIdentity: `1:${200 + index}:${Buffer.byteLength(text)}:100:100` }));
  const namespace: NativeNamespaceEntry[] = states.map(state => ({ workspaceId: scope.workspaceId, path: state.path, kind: 'file',
    identity: `registry:${state.documentId}:1`, documentId: state.documentId, lifecycleGeneration: 1, filesystemIdentity: null }));
  namespace.push(...physical.map(inventory => ({ workspaceId: scope.workspaceId, path: inventory.path, kind: 'file' as const,
    identity: inventory.physical.filesystemIdentity, filesystemIdentity: inventory.physical.filesystemIdentity, documentId: null, lifecycleGeneration: null })));
  for (const extra of input.extra ?? []) namespace.push({ workspaceId: scope.workspaceId, path: extra.path, kind: extra.kind,
    identity: `1:${400 + namespace.length}:0:100:100`, filesystemIdentity: `1:${400 + namespace.length}:0:100:100`,
    documentId: null, lifecycleGeneration: null });
  for (const item of [...namespace]) {
    let parent = path.posix.dirname(item.path);
    while (parent !== '.') {
      if (!namespace.some(entry => entry.path === parent)) namespace.push({ workspaceId: scope.workspaceId, path: parent,
        kind: 'directory', identity: `1:${600 + namespace.length}:4096:100:100`, filesystemIdentity: `1:${600 + namespace.length}:4096:100:100`,
        documentId: null, lifecycleGeneration: null });
      parent = path.posix.dirname(parent);
    }
  }
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: scope.workspaceId,
    organizationId: null, catalogueProof, namespace: namespace.sort((a, b) => a.path.localeCompare(b.path)),
    sources: [...inventories.map(inventory => ({ kind: 'native' as const, inventory })),
      ...physical.map(inventory => ({ kind: 'physical' as const, inventory }))],
    scope: { kind: 'visible-workspace', excludedPaths: [] }, coverage: { complete: true, gaps: [] },
    readiness: physical.length ? 'requires-import-and-rebinding' : 'native-coordinator-required', executionReady: false };
  return { scope, observation: { stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) },
    nativeBindings: structuredClone(nativeBindings), privateNativeStates: states, privateCatalogue } as Fixture['observation'] };
}

function workspacePathImportPreparationRefresh(fixture: Fixture): void {
  const { stage } = fixture.observation;
  stage.catalogueProof = proof(fixture.observation.privateCatalogue);
  stage.sources = stage.sources.map(source => {
    if (source.kind === 'native') return source;
    const inventory = source.inventory;
    return { kind: 'physical', inventory: inspectOriginalPhysicalLinksV3({ workspaceId: inventory.workspaceId,
      organizationId: inventory.organizationId, path: inventory.path, bytes: inventory.originalBytes,
      filesystemIdentity: inventory.physical.filesystemIdentity, authority: { ...inventory.authority, catalogueProof: stage.catalogueProof! } }) };
  });
  stage.stageProof = workspaceSourceAuthorityStageProof(stage);
}

function workspacePathImportPreparationAssertRejected(action: () => unknown,
  code?: WorkspacePathImportPreparationPlanError['code']): void {
  assert.throws(action, error => code === undefined
    ? error instanceof WorkspacePathImportPreparationPlanError || error instanceof WorkspaceOperationNativeSourceEvidenceError
    : error instanceof WorkspacePathImportPreparationPlanError && error.code === code);
}

export function workspacePathImportPreparationPlanTest(): void {
  let groups = 0;
  // 1. Actual original bytes/native states are read without being changed;
  // only physical facts and a preparation profile survive into the plan.
  {
    const fixture = workspacePathImportPreparationFixture(), selections = [{ sourcePath: 'raw.md', destinationPath: 'renamed.md' }];
    const input = { ...fixture, kind: 'rename' as const, selections }, before = structuredClone(input);
    const plan = createWorkspacePathImportPreparationPlanV1(input);
    assert.equal(plan.version, 1); assert.equal(plan.kind, 'native-path-import-preparation');
    assert.equal(plan.executionReady, false); assert.equal(plan.readiness, 'requires-import-rebinding');
    assert.equal(plan.sourceEvidence.evidenceVersion, 3); assert.equal(plan.importRequirements.length, 1);
    assert.equal(plan.importRequirements[0].path, 'raw.md'); assert.deepEqual(plan.importRequirements[0].reasons, ['selected']);
    assert.deepEqual(plan.sourceEvidence, captureWorkspaceOperationNativeSourceEvidenceV3(fixture.scope, fixture.observation));
    assert.deepEqual(input, before); assert.deepEqual(decodeWorkspacePathImportPreparationPlanV1(plan), plan);
    assertWorkspacePathImportPreparationPlanV1Current(plan, fixture.observation, fixture.scope);
    assert.equal(plan.graphProofs.version, 1); assert.match(plan.graphProofs.before, /^[a-f0-9]{64}$/u); assert.match(plan.graphProofs.after, /^[a-f0-9]{64}$/u);
    assert.notEqual(plan.graphProofs.before, plan.graphProofs.after, 'A zero-link selected raw move still changes the complete namespace graph.');
    const nativeOnlyEffect = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'move',
      selections: [{ sourcePath: 'note.md', destinationPath: 'native-renamed.md' }] });
    assert.equal(nativeOnlyEffect.readiness, 'native-ready'); assert.deepEqual(nativeOnlyEffect.importRequirements, []);
    assert.equal(nativeOnlyEffect.sourceEvidence.physicalSources.length, 1);
    assert.notEqual(nativeOnlyEffect.graphProofs.before, nativeOnlyEffect.graphProofs.after,
      'A zero-link native move retains the full unselected raw namespace without importing it.');
    for (const item of [...plan.importRequirements, ...plan.physicalLinkIntents]) {
      for (const key of ['documentId', 'lineageId', 'nativeLinkId', 'reference', 'sourceVersion', 'nextValue', 'originalBytes', 'yjsState', 'stateVector']) {
        assert.equal(Object.hasOwn(item, key), false, `Physical preparation must not fabricate ${key}.`);
      }
    }
    const stack: unknown[] = [plan];
    while (stack.length) { const value = stack.pop(); if (value && typeof value === 'object') {
      assert(Object.isFrozen(value)); stack.push(...Object.values(value));
    } }
  }
  groups++;

  // 2. Selecting a directory imports precisely its physical descendants,
  // while the real initialized descendant keeps its existing identity.
  {
    const fixture = workspacePathImportPreparationFixture({ raw: [['folder/a.md', 'A\n'], ['folder/b.md', 'B\n'], ['outside.md', 'Outside\n']],
      native: [['folder/native.md', '# Native\n']] });
    const plan = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'move',
      selections: [{ sourcePath: 'folder', destinationPath: 'moved' }] });
    assert.equal(plan.readiness, 'requires-import-rebinding');
    assert.deepEqual(plan.importRequirements.map(item => item.path), ['folder/a.md', 'folder/b.md']);
    assert(plan.importRequirements.every(item => item.reasons.length === 1 && item.reasons[0] === 'selected'));
    assert(plan.pathMappings.some(item => item.source.path === 'folder/native.md' && item.destinationPath === 'moved/native.md'
      && item.source.documentId === fixture.observation.privateNativeStates[0].documentId));
    assert.equal(plan.importRequirements.some(item => item.path === 'outside.md'), false);
  }
  groups++;

  // 3. Exact incoming occurrences need one source import and separate
  // occurrence intents, even when their literals are duplicates.
  {
    const fixture = workspacePathImportPreparationFixture({ raw: [['incoming.md', '[First](/note.md) and [Second](/note.md)\n']] });
    const plan = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'move', selections: [{ sourcePath: 'note.md', destinationPath: 'renamed.md' }] });
    assert.equal(plan.readiness, 'requires-import-rebinding');
    assert.deepEqual(plan.importRequirements.map(item => ({ path: item.path, reasons: item.reasons })), [{ path: 'incoming.md', reasons: ['link-change'] }]);
    const original = fixture.observation.stage.sources.find(source => source.kind === 'physical'); assert(original?.kind === 'physical');
    assert.equal(plan.physicalLinkIntents.length, 2);
    assert.deepEqual(plan.physicalLinkIntents.map(item => item.physicalLinkId).sort(), original.inventory.links.map(link => link.physicalLinkId).sort());
    assert.equal(new Set(plan.physicalLinkIntents.map(item => item.physicalLinkId)).size, 2);
    assert(plan.physicalLinkIntents.every(item => item.sourcePath === 'incoming.md' && item.sourcePathAfter === 'incoming.md'
      && item.action === 'rewrite' && item.targetPathAfter === 'renamed.md'));
  }
  groups++;

  // 4. A fully resolved stable Wiki alias in an unselected physical source is
  // read-only when the same target identity remains resolved after the move.
  {
    const fixture = workspacePathImportPreparationFixture({ raw: [['alias.md', '[[Stable Alias|Shown]]\n']],
      native: [['note.md', '---\naliases: [Stable Alias]\n---\n# Native\n']] });
    const plan = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'move', selections: [{ sourcePath: 'note.md', destinationPath: 'renamed.md' }] });
    assert.equal(plan.readiness, 'native-ready'); assert.deepEqual(plan.importRequirements, []); assert.deepEqual(plan.physicalLinkIntents, []);
    assert.equal(plan.sourceEvidence.physicalSources.length, 1);
  }
  groups++;

  // 5. Moving a physical source changes relative outgoing links even when the
  // target stays put; the plan promises a target, never a native nextValue.
  {
    const fixture = workspacePathImportPreparationFixture({ raw: [['raw.md', '[Keep](note.md)\n']], extra: [{ path: 'deep', kind: 'directory' }] });
    const plan = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'move', selections: [{ sourcePath: 'raw.md', destinationPath: 'deep/raw.md' }] });
    assert.equal(plan.readiness, 'requires-import-rebinding'); assert.deepEqual(plan.importRequirements[0].reasons, ['selected', 'link-change']);
    assert.equal(plan.physicalLinkIntents.length, 1); const intent = plan.physicalLinkIntents[0];
    assert.equal(intent.sourcePath, 'raw.md'); assert.equal(intent.sourcePathAfter, 'deep/raw.md');
    assert.equal(intent.expectedTargetPath, 'note.md'); assert.equal(intent.targetPathAfter, 'note.md');
    assert.equal(intent.expectedTargetPathText, 'note.md'); assert.equal(Object.hasOwn(intent, 'nextValue'), false);
  }
  groups++;

  // 6. Delete ignores the deleted source's outgoing links, while surviving
  // incoming sources get explicit unlink intentions and their own imports.
  {
    const fixture = workspacePathImportPreparationFixture({ raw: [['raw.md', '[Keep](note.md)\n'], ['incoming.md', '[Raw](raw.md)\n']] });
    const plan = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'delete', selections: [{ sourcePath: 'raw.md' }] });
    assert.equal(plan.readiness, 'requires-import-rebinding');
    assert.deepEqual(plan.importRequirements.map(item => ({ path: item.path, reasons: item.reasons })),
      [{ path: 'incoming.md', reasons: ['link-change'] }, { path: 'raw.md', reasons: ['selected'] }]);
    assert.equal(plan.physicalLinkIntents.length, 1); const intent = plan.physicalLinkIntents[0];
    assert.equal(intent.sourcePath, 'incoming.md'); assert.equal(intent.action, 'unlink'); assert.equal(intent.targetPathAfter, null);
    assert(plan.pathMappings.some(item => item.source.path === 'raw.md' && item.destinationPath === ''));
  }
  groups++;

  // 7. A failed selected-source resolution and incidental capture of a former
  // missing/ambiguous link stay blocked. Import does not repair these conflicts.
  {
    const missing = workspacePathImportPreparationFixture({ raw: [['raw.md', '[Missing](missing.md)\n']] });
    const missingPlan = createWorkspacePathImportPreparationPlanV1({ ...missing, kind: 'move', selections: [{ sourcePath: 'raw.md', destinationPath: 'moved.md' }] });
    assert.equal(missingPlan.readiness, 'blocked'); assert(missingPlan.issues.length > 0);
    const ambiguous = workspacePathImportPreparationFixture({ raw: [['incoming.md', '[[Shared Alias]]\n']],
      native: [['one.md', '---\naliases: [Shared Alias]\n---\nOne\n'], ['two.md', '---\naliases: [Shared Alias]\n---\nTwo\n']] });
    const ambiguousPlan = createWorkspacePathImportPreparationPlanV1({ ...ambiguous, kind: 'delete', selections: [{ sourcePath: 'one.md' }] });
    assert.equal(ambiguousPlan.readiness, 'blocked'); assert(ambiguousPlan.issues.length > 0);
    assert(ambiguousPlan.issues.some(issue => issue.code === 'resolution-changed'));
    const captured = workspacePathImportPreparationFixture({ raw: [['incoming.md', '[Missing exact](arrived.md)\n']] });
    const capturedPlan = createWorkspacePathImportPreparationPlanV1({ ...captured, kind: 'move', selections: [{ sourcePath: 'note.md', destinationPath: 'arrived.md' }] });
    assert.equal(capturedPlan.readiness, 'blocked'); assert(capturedPlan.issues.some(issue => issue.code === 'resolution-changed'));
    assert.deepEqual(capturedPlan.importRequirements, []);
  }
  groups++;

  // 8. Namespace collisions and overlapping selections are semantic blockers.
  {
    const fixture = workspacePathImportPreparationFixture({ raw: [['folder/raw.md', 'Raw\n']], native: [['note.md', 'Native\n']] });
    const collision = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'move', selections: [{ sourcePath: 'folder/raw.md', destinationPath: 'note.md' }] });
    assert.equal(collision.readiness, 'blocked'); assert(collision.issues.some(issue => issue.code === 'destination-collision'));
    const overlap = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'move', selections: [
      { sourcePath: 'folder', destinationPath: 'moved' }, { sourcePath: 'folder/raw.md', destinationPath: 'other.md' }] });
    assert.equal(overlap.readiness, 'blocked'); assert(overlap.issues.some(issue => issue.code === 'overlapping-selection'));
    const absent = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'delete', selections: [{ sourcePath: 'missing.md' }] });
    assert.equal(absent.readiness, 'blocked'); assert(absent.issues.some(issue => issue.code === 'missing-source'));
    const notebook = workspacePathImportPreparationFixture({ raw: [['raw.md', '[Other](/en/notebook?path=Other.md)\n']],
      native: [['Other.md', '# Other\n']] });
    const notebookPlan = createWorkspacePathImportPreparationPlanV1({ ...notebook, kind: 'move',
      selections: [{ sourcePath: 'raw.md', destinationPath: 'moved.md' }] });
    assert.equal(notebookPlan.readiness, 'blocked');
    assert(notebookPlan.issues.some(issue => issue.code === 'unsupported-target-format'),
      'A selected raw Notebook URL cannot skip the native planner format boundary merely because its target stays resolved.');
  }
  groups++;

  // 9. One physical source accumulates deduplicated reasons in fixed order.
  {
    const fixture = workspacePathImportPreparationFixture({ raw: [['raw.md', '[Self](raw.md) and [Self again](raw.md)\n']] });
    const plan = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'move', selections: [{ sourcePath: 'raw.md', destinationPath: 'moved.md' }] });
    assert.equal(plan.readiness, 'requires-import-rebinding'); assert.equal(plan.importRequirements.length, 1);
    assert.deepEqual(plan.importRequirements[0].reasons, ['selected', 'link-change']); assert.equal(plan.physicalLinkIntents.length, 2);
    assert.equal(new Set(plan.physicalLinkIntents.map(item => item.physicalLinkId)).size, 2);
    assert(plan.physicalLinkIntents.every(item => item.sourcePathAfter === 'moved.md' && item.targetPathAfter === 'moved.md'));
  }
  groups++;

  // 10. The actual central import preparation binds BOM/CRLF and Unicode byte
  // counts without converting offsets into native references.
  {
    const text = '\uFEFF# Grüße 🦊\r\n\r\n[Keep](note.md) und ÄÖÜ\r\n';
    const fixture = workspacePathImportPreparationFixture({ raw: [['raw.md', text]] });
    const plan = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'rename', selections: [{ sourcePath: 'raw.md', destinationPath: 'neu.md' }] });
    assert.equal(plan.readiness, 'requires-import-rebinding'); const requirement = plan.importRequirements[0];
    const prepared = prepareMarkdownFileImport(Buffer.from(text));
    assert.deepEqual(requirement.preparation, { version: 1, representation: prepared.representation, newlineStyle: prepared.newlineStyle,
      hasBom: prepared.hasBom, sourceHash: prepared.sourceHash, sourceBytes: prepared.sourceBytes,
      canonicalHash: createHash('sha256').update(prepared.canonical).digest('hex') });
    assert.equal(requirement.preparation.hasBom, true); assert.equal(requirement.preparation.newlineStyle, 'crlf');
    assert.equal(requirement.physical.byteLength, Buffer.byteLength(text)); assert.notEqual(requirement.physical.byteLength, text.length);
    assert.equal(requirement.importPolicy.parserVersion, 3); assert.equal(requirement.importPolicy.initialRepresentation, 'auto');
  }
  groups++;

  // 11. Fresh original bytes and physical identity are strict, including an
  // unrelated physical source: complete evidence must never be dropped.
  {
    const fixture = workspacePathImportPreparationFixture({ raw: [['raw.md', 'Original\n'], ['unselected.md', 'Unselected\n']] });
    const plan = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'rename', selections: [{ sourcePath: 'raw.md', destinationPath: 'moved.md' }] });
    for (const change of ['content', 'identity'] as const) {
      const changed = structuredClone(fixture), source = changed.observation.stage.sources.find(item => item.kind === 'physical' && item.inventory.path === 'unselected.md');
      assert(source?.kind === 'physical');
      if (change === 'content') source.inventory.originalBytes[0] ^= 1;
      else {
        source.inventory.physical.filesystemIdentity = source.inventory.physical.filesystemIdentity.replace('1:201:', '1:901:');
        const entry = changed.observation.stage.namespace.find(item => item.path === 'unselected.md')!;
        entry.identity = entry.filesystemIdentity = source.inventory.physical.filesystemIdentity;
      }
      workspacePathImportPreparationRefresh(changed);
      workspacePathImportPreparationAssertRejected(() => assertWorkspacePathImportPreparationPlanV1Current(plan, changed.observation, changed.scope), 'PATH_IMPORT_PREPARATION_CHANGED');
    }
    const unreparsed = structuredClone(fixture), physical = unreparsed.observation.stage.sources.find(item => item.kind === 'physical' && item.inventory.path === 'raw.md');
    assert(physical?.kind === 'physical'); physical.inventory.originalBytes[0] ^= 1;
    // Historical hashes still match each other; only fresh byte reinspection
    // can reject this changed original. Do not refresh the inventory/proof.
    workspacePathImportPreparationAssertRejected(() => assertWorkspacePathImportPreparationPlanV1Current(plan, unreparsed.observation, unreparsed.scope));
    workspacePathImportPreparationAssertRejected(() => assertWorkspacePathImportPreparationPlanV1Current(plan, fixture.observation,
      { ...fixture.scope, rootPath: '/data/replaced/files' }), 'PATH_IMPORT_PREPARATION_CHANGED');
  }
  groups++;

  // 12. Plan version, original request, evidence and every proof-bearing arm
  // are strict historical data. Rehashing is not current authorization.
  {
    const fixture = workspacePathImportPreparationFixture({ raw: [['raw.md', '[Self](raw.md)\n']] });
    const plan = createWorkspacePathImportPreparationPlanV1({ ...fixture, kind: 'move', selections: [{ sourcePath: 'raw.md', destinationPath: 'moved.md' }] });
    const requestFixture = workspacePathImportPreparationFixture({ native: [['native.md', '[Raw](raw.md)\n']] });
    for (const selections of [
      [{ sourcePath: 'bad\uD800.md', destinationPath: 'moved.md' }],
      [{ sourcePath: 'raw.md', destinationPath: 'bad\uD800.md' }],
    ]) workspacePathImportPreparationAssertRejected(() => createWorkspacePathImportPreparationPlanV1({ ...requestFixture,
      kind: 'move', selections }), 'PATH_IMPORT_PREPARATION_INVALID');
    for (const change of [
      (value: Mutable<typeof plan>) => { Reflect.set(value, 'version', 2); },
      (value: Mutable<typeof plan>) => { value.request.selections[0].destinationPath = 'forged.md'; },
      (value: Mutable<typeof plan>) => { value.importRequirements[0].physical.byteHash = 'f'.repeat(64); },
      (value: Mutable<typeof plan>) => { value.sourceEvidence.physicalSources[0].physical.byteHash = 'f'.repeat(64); },
      (value: Mutable<typeof plan>) => { value.physicalLinkIntents[0].physicalLinkId = 'f'.repeat(64); },
      (value: Mutable<typeof plan>) => { value.scope.ownerUserId = 'different-owner'; },
      (value: Mutable<typeof plan>) => { value.graphProofs.after = 'f'.repeat(64); },
      (value: Mutable<typeof plan>) => { value.integrityProof = 'f'.repeat(64); },
    ]) {
      const damaged = structuredClone(plan) as Mutable<typeof plan>; change(damaged);
      workspacePathImportPreparationAssertRejected(() => decodeWorkspacePathImportPreparationPlanV1(damaged));
      workspacePathImportPreparationAssertRejected(() => assertWorkspacePathImportPreparationPlanV1Current(damaged, fixture.observation, fixture.scope));
    }
    workspacePathImportPreparationAssertRejected(() => decodeWorkspacePathImportPreparationPlanV1({ ...plan, extra: true }));
  }
  groups++;

  // 13. Hostile input is descriptor-captured without invoking caller code.
  {
    const fixture = workspacePathImportPreparationFixture(), input = { ...fixture, kind: 'move' as const,
      selections: [{ sourcePath: 'raw.md', destinationPath: 'moved.md' }] }, plan = createWorkspacePathImportPreparationPlanV1(input);
    let callbacks = 0;
    const hostile = { ...input };
    Object.defineProperty(hostile, 'observation', { enumerable: true, get() { callbacks++; return input.observation; } });
    workspacePathImportPreparationAssertRejected(() => createWorkspacePathImportPreparationPlanV1(hostile));
    const hostilePlan = structuredClone(plan);
    Object.defineProperty(hostilePlan, 'request', { enumerable: true, get() { callbacks++; return plan.request; } });
    workspacePathImportPreparationAssertRejected(() => decodeWorkspacePathImportPreparationPlanV1(hostilePlan));
    const proxy = new Proxy(input, { get() { callbacks++; return undefined; }, ownKeys() { callbacks++; return []; },
      getPrototypeOf() { callbacks++; return Object.prototype; }, getOwnPropertyDescriptor() { callbacks++; return undefined; } });
    workspacePathImportPreparationAssertRejected(() => createWorkspacePathImportPreparationPlanV1(proxy));
    const nested = structuredClone(input), physical = nested.observation.stage.sources.find(item => item.kind === 'physical'); assert(physical?.kind === 'physical');
    Object.defineProperty(physical.inventory, 'originalBytes', { enumerable: true, get() { callbacks++; return new Uint8Array(); } });
    workspacePathImportPreparationAssertRejected(() => createWorkspacePathImportPreparationPlanV1(nested));
    workspacePathImportPreparationAssertRejected(() => decodeWorkspacePathImportPreparationPlanV1(new Proxy(plan, { get() { callbacks++; return undefined; }, ownKeys() { callbacks++; return []; } })));
    const jsonHook = structuredClone(plan) as Mutable<typeof plan> & { toJSON?: () => unknown };
    jsonHook.toJSON = () => { callbacks++; return plan; };
    workspacePathImportPreparationAssertRejected(() => decodeWorkspacePathImportPreparationPlanV1(jsonHook));
    assert.equal(callbacks, 0);
  }
  groups++;

  // 14. Sparse/oversized hostile data and the actual shared tiny-budget
  // capture fail safely. There is no invented decoder-budget API.
  {
    const fixture = workspacePathImportPreparationFixture(), input = { ...fixture, kind: 'move' as const,
      selections: [{ sourcePath: 'raw.md', destinationPath: 'moved.md' }] }, plan = createWorkspacePathImportPreparationPlanV1(input);
    const sparse = { ...input, selections: new Array(100_001) };
    workspacePathImportPreparationAssertRejected(() => createWorkspacePathImportPreparationPlanV1(sparse));
    workspacePathImportPreparationAssertRejected(() => decodeWorkspacePathImportPreparationPlanV1({ ...plan,
      integrityProof: 'x'.repeat(16 * 1024 * 1024 + 1) }), 'PATH_IMPORT_PREPARATION_TOO_LARGE');
    let reason: string | undefined;
    assert.throws(() => captureWorkspaceOperationNativePlanData(plan, value => { reason = value; throw new Error('fixture-tiny-budget'); }, 1),
      error => error instanceof Error && error.message === 'fixture-tiny-budget');
    assert.equal(reason, 'too-large');
    const malformed = workspacePathImportPreparationFixture({ raw: [['raw.md', 'Mixed\r\nendings\n']] });
    workspacePathImportPreparationAssertRejected(() => createWorkspacePathImportPreparationPlanV1({ ...malformed, kind: 'move',
      selections: [{ sourcePath: 'raw.md', destinationPath: 'moved.md' }] }), 'PATH_IMPORT_PREPARATION_UNSUPPORTED');
  }
  groups++;

  assert.equal(groups, 14);
  console.log(JSON.stringify({ suite: 'workspace-path-import-preparation-plan', groups, pureOnly: true,
    importsPerformed: false, executionAdmission: false, authorityClaim: false }));
}
