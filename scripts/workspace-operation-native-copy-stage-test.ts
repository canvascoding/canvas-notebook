import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import io from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as Y from 'yjs';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { inspectPersistedNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { inspectNativeDocumentLinks, nativeLinkJsonProof as proof } from '../app/lib/markdown/workspace-native-link-inventory';
import { workspaceSourceAuthorityStageProof, type WorkspaceSourceAuthorityStage } from '../app/lib/markdown/workspace-physical-link-inventory';
import type { WorkspaceNativeSourceBinding, WorkspaceLinkSourceAuthorityObservation } from '../app/lib/markdown/workspace-source-authority-stage';
import type { NativeNamespaceEntry } from '../app/lib/markdown/workspace-link-contract-v2';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { createWorkspaceOperationNativeCopyPlan, computeWorkspaceOperationNativeCopyPlanId } from '../app/lib/files/workspace-operation-native-copy-plan';
import { captureWorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import { withPreparedWorkspacePathCopy, readPreparedWorkspacePathCopy } from '../app/lib/filesystem/prepared-workspace-path-copy';
import { WorkspaceOperationStaging, WorkspaceOperationStagingError, type WorkspaceOperationNativeCopyStageInput } from '../app/lib/files/workspace-operation-staging';
import { serializeWorkspaceOperationRequest } from '../app/lib/files/workspace-operation-journal';
import { createWorkspaceFileOperationPlan } from '../app/lib/markdown/workspace-file-operation-planner';

// Real Yjs bytes and owned filesystem staging; declared catalogue/registry
// observations below do not assert SQL ownership, current ACL or admission.
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const errorCode = (...codes: string[]) => (error: unknown) => error instanceof WorkspaceOperationStagingError && codes.includes(error.code);
function workspace(rootPath: string, suffix: string): WorkspaceContext {
  return { workspaceId: `stage-${suffix}`, rootPath, rootRelativePath: `users/stage/${suffix}`, workspaceType: 'personal',
    organizationId: null, ownerUserId: 'stage-user', legacy: false, status: 'active', permissions: { canRead: true, canWrite: true,
      canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } };
}
function state(workspace: WorkspaceContext, filePath: string, representation: PersistedCollaborationState['representation']): PersistedCollaborationState {
  const doc = representation === 'plain_text' ? createPlainTextYDoc('Original') : createRichMarkdownYDoc('Original', representation);
  try { return { documentId: `doc-${workspace.workspaceId}-${filePath}`, workspaceId: workspace.workspaceId, organizationId: null,
    path: filePath, representation, lifecycleGeneration: 1, schemaVersion: 1, documentSequence: 4, persistedAt: 100,
    checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false,
    degraded: false, status: 'active', yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) }; }
  finally { doc.destroy(); }
}
function observation(workspace: WorkspaceContext, states: PersistedCollaborationState[], extras: NativeNamespaceEntry[] = []): WorkspaceLinkSourceAuthorityObservation {
  const inventories = states.map(value => inspectPersistedNativeCollaborationSnapshot(value, inspectNativeDocumentLinks));
  const nativeBindings: WorkspaceNativeSourceBinding[] = states.map((value, index) => {
    const lineageId = `lineage-${value.documentId}`;
    return { expected: { documentId: value.documentId, lineageId, workspaceId: workspace.workspaceId, organizationId: null,
      path: value.path, representation: value.representation, schemaVersion: 1, lifecycleGeneration: 1, registryStateVersion: 4,
      documentSequence: 4, persistedAt: 100, stateProof: inventories[index].version.stateProof, binaryHash: sha(value.yjsState), vectorHash: sha(value.stateVector) },
    registry: { documentId: value.documentId, lineageId, workspaceId: workspace.workspaceId, workspaceType: 'personal', organizationId: null,
      customerId: null, projectId: null, path: value.path, provider: 'yjs', stateLifecycle: 'initialized', stateVersion: 4, status: 'active' },
    lineage: { lineageId, workspaceId: workspace.workspaceId, workspaceType: 'personal', organizationId: null, customerId: null, projectId: null,
      path: value.path, status: 'active', archivedAt: null, trashEntryId: null }, byteProfile: { newlineStyle: 'lf', hasBom: false }, inventoryProof: proof(inventories[index]) };
  });
  const namespace: NativeNamespaceEntry[] = states.map(value => ({ workspaceId: workspace.workspaceId, path: value.path, kind: 'file',
    identity: `registry:${value.documentId}:1`, filesystemIdentity: null, documentId: value.documentId, lifecycleGeneration: 1 }));
  const body: Omit<WorkspaceSourceAuthorityStage, 'stageProof'> = { stageVersion: 1, workspaceId: workspace.workspaceId, organizationId: null,
    catalogueProof: proof(nativeBindings.map(binding => binding.registry)), namespace: [...namespace, ...extras],
    sources: inventories.map(inventory => ({ kind: 'native', inventory })), scope: { kind: 'visible-workspace', excludedPaths: [] },
    coverage: { complete: true, gaps: [] }, readiness: 'native-coordinator-required', executionReady: false };
  return { stage: { ...body, stageProof: workspaceSourceAuthorityStageProof(body) }, nativeBindings, privateNativeStates: states };
}
async function fixture(run: (value: { input: WorkspaceOperationNativeCopyStageInput; staging: WorkspaceOperationStaging;
  base: string; storage: string; complete(): void }) => Promise<void>, representation: PersistedCollaborationState['representation'] = 'plain_text', asset = false): Promise<void> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-copy-stage-'))); await fs.chmod(base, 0o700);
  try {
    const fromRoot = path.join(base, 'from'), toRoot = path.join(base, 'to');
    await fs.mkdir(fromRoot, { mode: 0o700 }); await fs.mkdir(toRoot, { mode: 0o700 });
    const source = workspace(fromRoot, 'source'), destination = workspace(toRoot, 'target');
    const sourceStates = [state(source, 'note.md', representation), state(source, 'keep.md', representation)], targetStates = [state(destination, 'existing.md', representation)];
    const sourcePath = asset ? 'asset.pdf' : 'note.md', extras: NativeNamespaceEntry[] = [];
    if (asset) {
      await fs.writeFile(path.join(fromRoot, sourcePath), Buffer.from([0, 1, 255]), { mode: 0o600 }); const info = await fs.stat(path.join(fromRoot, sourcePath));
      const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      extras.push({ workspaceId: source.workspaceId, path: sourcePath, kind: 'file', identity, filesystemIdentity: identity, documentId: null, lifecycleGeneration: null });
    }
    const selected = [{ sourcePath, destinationPath: asset ? 'copied.pdf' : 'copied.md' }];
    const plan = createWorkspaceOperationNativeCopyPlan({ sourceScope: { workspace: source, fileOptions: {} }, destinationScope: { workspace: destination, fileOptions: {} },
      sourceObservation: observation(source, sourceStates, extras), destinationObservation: observation(destination, targetStates), selections: selected });
    const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'stage-user', actorId: 'stage-user', sessionId: 'original-session' }, sourceWorkspace: source, destinationWorkspace: destination });
    const request = { kind: 'copy' as const, selections: selected, origin }, operationId = `stage-${randomUUID()}`;
    const physical = await withPreparedWorkspacePathCopy({ sourceWorkspace: source, destinationWorkspace: destination,
      sourcePath, destinationPath: selected[0].destinationPath, sourceKind: asset ? 'regular_file' : 'projection_absent',
      projectionPaths: asset ? [] : ['note.md'] }, async cap => [{ selectionIndex: 0, original: readPreparedWorkspacePathCopy(cap) }]);
    const input = { operationId, plan, request, physical, nativeRecords: [...sourceStates, ...targetStates].map(state => ({ lineageId: `lineage-${state.documentId}`, state })) };
    let completed = false;
    const staging = new WorkspaceOperationStaging({ dataRoot: base, completionLookup: async () => ({ operationId, planId: plan.planId,
      sourceWorkspaceId: source.workspaceId, destinationWorkspaceId: destination.workspaceId, status: completed ? 'completed' : 'running', requestHash: serializeWorkspaceOperationRequest(request).requestHash }) });
    await run({ input, staging, base, storage: path.join(base, 'workspace-operation-staging', operationId), complete: () => { completed = true; } });
  } finally { await fs.rm(base, { recursive: true, force: true }); }
}

for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) test(`${representation}: native private stage roundtrips all source AND independent destination records`, async () => fixture(async ({ input, staging, storage, complete }) => {
  const before = clone(input), first = await staging.stageNativeCopy(input);
  assert.deepEqual(input, before); assert.equal(first.kind, 'native-copy'); assert.equal(first.version, 2);
  assert.equal(first.nativeRecords.length, 3); assert.deepEqual(first.plan, input.plan); assert.equal(first.plan.executionReady, false);
  assert.deepEqual(first.nativeRecords, input.nativeRecords); assert.equal(await staging.readKind(input.operationId), 'native-copy');
  assert.equal((await staging.stageNativeCopy(clone(input))).payloadSha256, first.payloadSha256);
  assert.deepEqual((await staging.loadNativeCopy(first.identity)).nativeRecords, input.nativeRecords);
  assert.deepEqual((await fs.readdir(storage)).sort(), ['manifest.json', 'native-records.bin']);
  assert.equal((await fs.stat(storage)).mode & 0o777, 0o700);
  for (const name of await fs.readdir(storage)) assert.equal((await fs.stat(path.join(storage, name))).mode & 0o777, 0o600);
  const manifest = JSON.parse(await fs.readFile(path.join(storage, 'manifest.json'), 'utf8'));
  assert.equal(JSON.stringify(manifest).includes('yjsState'), false); assert.equal(JSON.stringify(manifest).includes('originalDocuments'), false);
  await assert.rejects(staging.removeCompletedNativeCopy(first.identity), errorCode('NOT_COMPLETED'));
  complete(); await staging.removeCompletedNativeCopy(first.identity); await staging.removeCompletedNativeCopy(first.identity);
  assert.equal(await staging.readKind(input.operationId), null);
}, representation));

test('real prepared opaque asset must match complete original C1 physical identity', async () => fixture(async ({ input, staging }) => {
  const stage = await staging.stageNativeCopy(input); assert(stage.physical[0].original.staging); assert.equal(stage.physical[0].original.source.kind, 'regular_file');
}, 'plain_text', true));

test('missing, extra, wrong-lineage, changed bytes/clocks and different origin records fail before creating the operation directory', async () => fixture(async ({ input, staging, storage }) => {
  const probes = [() => ({ ...input, nativeRecords: input.nativeRecords.slice(1) }),
    () => ({ ...input, nativeRecords: input.nativeRecords.slice(0, -1) }),
    () => ({ ...input, nativeRecords: [...input.nativeRecords, clone(input.nativeRecords[0])] }),
    () => ({ ...input, nativeRecords: input.nativeRecords.map((record, index) => index ? record : { ...record, lineageId: 'foreign' }) }),
    () => { const value = clone(input); value.nativeRecords[0].state.yjsState[0] ^= 1; return value; },
    () => { const value = clone(input); value.nativeRecords[0].state.documentSequence += 1; return value; },
    () => ({ ...input, request: { ...input.request, origin: { ...input.request.origin!, sourceScope: { ...input.plan.sourceScope, ownerUserId: 'foreign' } } } }),
    () => ({ ...input, physical: [] })];
  for (const probe of probes) { await assert.rejects(staging.stageNativeCopy(probe()), errorCode('STAGE_CONFLICT')); await assert.rejects(fs.stat(storage), { code: 'ENOENT' }); }
}));

test('manifest, binary corruption and link/hardlink/profile replacement never dispatch native content as legacy', async () => {
  for (const mode of ['manifest', 'binary', 'symlink', 'hardlink', 'permissions', 'extra'] as const) await fixture(async ({ input, staging, storage, base }) => {
    const stage = await staging.stageNativeCopy(input), binary = path.join(storage, 'native-records.bin');
    if (mode === 'manifest') { const manifest = JSON.parse(await fs.readFile(path.join(storage, 'manifest.json'), 'utf8')); manifest.version = 1; await fs.writeFile(path.join(storage, 'manifest.json'), JSON.stringify(manifest)); }
    else if (mode === 'binary') { const bytes = await fs.readFile(binary); bytes[bytes.length - 1] ^= 1; await fs.writeFile(binary, bytes); }
    else if (mode === 'symlink') { await fs.rename(binary, path.join(base, 'saved-native.bin')); await fs.symlink(path.join(base, 'saved-native.bin'), binary); }
    else if (mode === 'hardlink') await fs.link(binary, path.join(base, 'linked-native.bin'));
    else if (mode === 'permissions') await fs.chmod(binary, 0o644);
    else await fs.writeFile(path.join(storage, 'foreign'), 'D2', { mode: 0o600 });
    await assert.rejects(staging.loadNativeCopy(stage.identity));
    if (mode === 'manifest') await assert.rejects(staging.readKind(input.operationId), errorCode('CORRUPT_STAGE'));
    else assert.equal(await staging.readKind(input.operationId), 'native-copy');
    assert.equal((await fs.stat(storage)).isDirectory(), true);
  });
});

test('identity conflict and mutated caller data after the first storage await cannot retarget immutable original stage', async t => fixture(async ({ input, staging, storage }) => {
  const before = clone(input), realMkdir = fs.mkdir.bind(fs); let modified = false;
  t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
    const value = await Reflect.apply(realMkdir, fs, args);
    if (!modified) { modified = true; (input.request.selections as { sourcePath: string; destinationPath: string }[])[0] = { sourcePath: 'later.md', destinationPath: 'later-copy.md' };
      input.nativeRecords[0].state.yjsState.fill(0); input.nativeRecords[0].lineageId = 'later-lineage'; }
    return value;
  });
  const stage = await staging.stageNativeCopy(input); assert(modified); assert.deepEqual(stage.request, before.request); assert.deepEqual(stage.nativeRecords, before.nativeRecords);
  assert.deepEqual(io.readdirSync(storage).sort(), ['manifest.json', 'native-records.bin']);
  await assert.rejects(staging.loadNativeCopy({ ...stage.identity, canonicalRequestHash: 'f'.repeat(64) }), errorCode('STAGE_CONFLICT'));
}));


test('rehashing C1 compiler or final graph claims never substitutes for replaying original native bytes', async () => fixture(async ({ input, staging, storage }) => {
  for (const field of ['compilerPlanProof', 'finalGraphProof'] as const) {
    const forged = { ...clone(input.plan), [field]: 'f'.repeat(64) };
    forged.planId = computeWorkspaceOperationNativeCopyPlanId(forged);
    await assert.rejects(staging.stageNativeCopy({ ...input, plan: forged }), errorCode('STAGE_CONFLICT'));
    await assert.rejects(fs.stat(storage), { code: 'ENOENT' });
  }
}));

test('physical selection indices, paths, full scopes and C1 asset inode membership are exact', async () => fixture(async ({ input, staging, storage }) => {
  const original = input.physical[0].original; assert.equal(original.source.kind, 'regular_file');
  const probes = [{ ...input, physical: [{ selectionIndex: 1, original }] },
    { ...input, physical: [{ selectionIndex: 0, original: { ...original, destinationPath: 'different.pdf' } }] },
    { ...input, physical: [{ selectionIndex: 0, original: { ...original, sourceWorkspace: { ...original.sourceWorkspace, ownerUserId: 'foreign' } } }] },
    { ...input, physical: [{ selectionIndex: 0, original: { ...original, source: { ...original.source, identity: { ...original.source.identity, inode: '123' } } } }] }];
  for (const value of probes) {
    await assert.rejects(staging.stageNativeCopy(value), errorCode('STAGE_CONFLICT'));
    await assert.rejects(fs.stat(storage), { code: 'ENOENT' });
  }
}, 'plain_text', true));

test('same operation cannot change its original session/request or C1 plan after immutable staging', async () => fixture(async ({ input, staging, storage }) => {
  const stage = await staging.stageNativeCopy(input), before = await fs.readFile(path.join(storage, 'manifest.json'));
  const origin = { ...input.request.origin!, actor: { ...input.request.origin!.actor, sessionId: 'new-original-session' } };
  await assert.rejects(staging.stageNativeCopy({ ...input, request: { ...input.request, origin } }), errorCode('STAGE_CONFLICT'));
  assert.deepEqual(await fs.readFile(path.join(storage, 'manifest.json')), before);
  assert.equal((await staging.loadNativeCopy(stage.identity)).payloadSha256, stage.payloadSha256);
}));

test('operation-ID recovery returns null only for a safely missing stage and rejects invalid path/operation inputs', async () => fixture(async ({ input, staging, base }) => {
  assert.equal(await staging.loadNativeCopyByOperationId(input.operationId), null);
  const invalid = ['', '../stage-1234567890123456', '/stage-1234567890123456', 'stage-1234567890123456/child', 'stage-1234567890123456\\child', 'tiny'];
  for (const operationId of invalid) await assert.rejects(staging.loadNativeCopyByOperationId(operationId), errorCode('STAGE_CONFLICT'));
  assert.deepEqual((await fs.readdir(path.join(base, 'workspace-operation-staging'))), []);
}));

test('a durable native stage before B0 recovers its exact original plan, chosen destination and C2 origin without consulting any journal', async () => fixture(async ({ input, staging, base, storage }) => {
  const saved = await staging.stageNativeCopy(input), before = await fs.readFile(path.join(storage, 'manifest.json'));
  let journalReads = 0;
  const restarted = new WorkspaceOperationStaging({ dataRoot: base, completionLookup: async () => { journalReads += 1; throw new Error('No B0 journal committed.'); } });
  const occupied = path.join(input.request.origin!.destinationScope.rootPath, input.plan.selections[0].destinationPath);
  await fs.writeFile(occupied, 'Later destination D2', { mode: 0o600 });
  const recovered = await restarted.loadNativeCopyByOperationId(input.operationId);
  assert(recovered); assert.deepEqual(recovered, saved); assert.equal(journalReads, 0);
  assert.equal(await fs.readFile(occupied, 'utf8'), 'Later destination D2');
  assert.deepEqual(recovered.request, input.request); assert.deepEqual(recovered.plan.selections, input.plan.selections);
  assert.deepEqual(recovered.nativeRecords, input.nativeRecords); assert.deepEqual(await fs.readFile(path.join(storage, 'manifest.json')), before);
}));

test('operation-ID native recovery refuses corrupt, foreign-ID, legacy, missing-manifest and substituted manifest payloads', async () => {
  for (const mode of ['corrupt', 'wrong-id', 'legacy', 'missing-manifest', 'manifest-symlink', 'manifest-hardlink', 'binary-corrupt'] as const) await fixture(async ({ input, staging, storage, base }) => {
    await staging.stageNativeCopy(input); const filename = path.join(storage, 'manifest.json');
    if (mode === 'missing-manifest') await fs.rename(filename, path.join(base, 'saved-manifest.json'));
    else if (mode === 'manifest-symlink') { await fs.rename(filename, path.join(base, 'saved-manifest.json')); await fs.symlink(path.join(base, 'saved-manifest.json'), filename); }
    else if (mode === 'manifest-hardlink') await fs.link(filename, path.join(base, 'linked-manifest.json'));
    else if (mode === 'binary-corrupt') { const binary = path.join(storage, 'native-records.bin'), bytes = await fs.readFile(binary); bytes[bytes.length - 1] ^= 1; await fs.writeFile(binary, bytes); }
    else {
      const manifest = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (mode === 'corrupt') manifest.payloadSha256 = 'f'.repeat(64);
      else if (mode === 'wrong-id') manifest.identity.operationId = `foreign-${randomUUID()}`;
      else manifest.version = 1;
      await fs.writeFile(filename, JSON.stringify(manifest));
    }
    await assert.rejects(staging.loadNativeCopyByOperationId(input.operationId));
    assert.equal((await fs.stat(storage)).isDirectory(), true);
  });
});

test('operation-ID recovery never adopts a symlink operation directory or a same-byte substituted private directory', async t => {
  for (const mode of ['symlink', 'substitution'] as const) await fixture(async ({ input, staging, storage }) => {
    await staging.stageNativeCopy(input);
    if (mode === 'symlink') {
      await fs.rename(storage, storage + '-original'); await fs.symlink(storage + '-original', storage);
      await assert.rejects(staging.loadNativeCopyByOperationId(input.operationId), errorCode('UNSAFE_STORAGE')); return;
    }
    const realRead = io.read.bind(io); let changed = false;
    type Reader = { read(fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: (error: NodeJS.ErrnoException | null, bytes: number, buffer: Buffer) => void): void };
    t.mock.method(io as unknown as Reader, 'read', (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: Parameters<Reader['read']>[5]) => {
      realRead(fd, buffer, offset, length, position, (error, bytes, result) => {
        if (!changed) {
          changed = true; io.renameSync(storage, storage + '-original'); io.mkdirSync(storage, { mode: 0o700 });
          for (const name of ['manifest.json', 'native-records.bin']) io.copyFileSync(path.join(storage + '-original', name), path.join(storage, name));
        }
        callback(error, bytes, result);
      });
    });
    await assert.rejects(staging.loadNativeCopyByOperationId(input.operationId), errorCode('UNSAFE_STORAGE')); assert(changed);
    assert.deepEqual(await fs.readFile(path.join(storage, 'manifest.json')), await fs.readFile(path.join(storage + '-original', 'manifest.json')));
    t.mock.restoreAll();
  });
});


test('a genuine existing V1 stage is explicitly rejected by native operation-ID recovery and remains readable as V1', async () => fixture(async ({ input, staging }) => {
  const preview = createWorkspaceFileOperationPlan({ kind: 'copy', sourceWorkspaceId: input.plan.sourceScope.workspaceId,
    destinationWorkspaceId: input.plan.destinationScope.workspaceId, selections: [{ sourcePath: 'legacy.pdf', destinationPath: 'legacy-copy.pdf' }],
    snapshots: [{ workspaceId: input.plan.sourceScope.workspaceId, entries: [{ identity: 'legacy-pdf', kind: 'file', path: 'legacy.pdf', contentHash: sha(Buffer.from('legacy')) }] },
      { workspaceId: input.plan.destinationScope.workspaceId, entries: [] }] });
  assert.equal(preview.readiness, 'ready');
  const legacy = await staging.stage({ operationId: input.operationId, sourceWorkspaceId: input.plan.sourceScope.workspaceId,
    destinationWorkspaceId: input.plan.destinationScope.workspaceId, preview, originalDocuments: [] });
  await assert.rejects(staging.loadNativeCopyByOperationId(input.operationId), errorCode('STAGE_CONFLICT'));
  assert.equal(await staging.readKind(input.operationId), 'legacy');
  assert.deepEqual(await staging.load(legacy.identity), legacy);
}));
