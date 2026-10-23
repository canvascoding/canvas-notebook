import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceOperationManagedCopyPlan } from '../app/lib/files/workspace-operation-managed-copy-plan';
import type { WorkspaceCopySourceObservation } from '../app/lib/files/workspace-operation-copy-source-observation';
import type { NativeMixedBatchPlan } from '../app/lib/markdown/workspace-native-mixed-batch-compiler';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

type Mutable<T> = T extends Uint8Array ? Uint8Array : T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
const mutable = <T>(value: T): Mutable<T> => structuredClone(value) as Mutable<T>;
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { withNativeInspectionSchema } = await import('../app/lib/collaboration/native-inspection-schema');
    const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { readWorkspaceCopySourceObservationOnConnection: observe } = await import('../app/lib/files/workspace-operation-copy-source-observation');
    const { createWorkspaceOperationManagedCopyPlan: create, decodeWorkspaceOperationManagedCopyPlan: decode,
      assertWorkspaceOperationManagedCopyPlanCurrent: current, WorkspaceOperationManagedCopyPlanError } = await import('../app/lib/files/workspace-operation-managed-copy-plan');
    const { WorkspaceOperationNativeSourceEvidenceError } = await import('../app/lib/files/workspace-operation-native-source-evidence');
    const { captureWorkspaceSceneSnapshot: captureSceneSnapshot, WorkspaceSceneSnapshotError } = await import('../app/lib/excalidraw-collaboration/workspace-scene-snapshot');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const { createWorkspaceOperationNativeCopyPlanV2 } = await import('../app/lib/files/workspace-operation-native-copy-plan');
    const { captureWorkspaceOperationCopySourceEvidenceV3: captureEvidence, decodeWorkspaceOperationCopySourceEvidenceV3: decodeEvidence } = await import('../app/lib/files/workspace-operation-copy-source-evidence');
    const { nativeLinkJsonProof: proof } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { workspaceSourceAuthorityStageProof } = await import('../app/lib/markdown/workspace-physical-link-inventory');
    const { importExcalidrawDocumentFile } = await import('../app/lib/excalidraw-collaboration/portable-import');
    const { applyExcalidrawScenePatch, loadExcalidrawScene, ensureExcalidrawScene } = await import('../app/lib/excalidraw-collaboration/repository');
    const { materializeExcalidrawCheckpoint } = await import('../app/lib/excalidraw-collaboration/checkpoint');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const owner = resolveWorkspaceActor({ id: 'owner', role: 'admin', email: 'owner@principal.test' });
    const sourceOwner = await readPostgresWorkspaceForActorOnConnection(h.connection, owner, h.source.workspaceId); assert(sourceOwner);
    assert(sourceOwner.permissions.canWrite); assert(h.source.permissions.canRead && !h.source.permissions.canWrite); assert(h.destination.permissions.canWrite);
    const actor = { userId: 'owner', actorId: 'owner', actorType: 'user' as const, sessionId: 'session-owner' };
    const sourceScope = { workspace: h.source, fileOptions: {} }, destinationScope = { workspace: h.destination, fileOptions: {} };
    const scopes = { sourceScope: captureWorkspaceOperationJobScope(h.source), destinationScope: captureWorkspaceOperationJobScope(h.destination) };
    const selections = [{ sourcePath: 'mixed', destinationPath: 'copied' }];
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const assetId = `managed-${randomUUID()}`;
    const portable = JSON.stringify({ type: 'excalidraw', version: 2,
      elements: [{ id: 'image', type: 'image', fileId: assetId, version: 1, versionNonce: 1, isDeleted: false }],
      appState: { viewBackgroundColor: '#ffffff' }, files: { [assetId]: { id: assetId, mimeType: 'image/png',
        dataURL: `data:image/png;base64,${png.toString('base64')}`, created: 123, version: 2 } } });
    await h.upload('mixed/note.md', Buffer.from('# Note\n[Diagram](/mixed/diagram.excalidraw) [Target](target.md) [Manual](manual.pdf)\n'));
    await h.upload('mixed/target.md', Buffer.from('# Target\n'));
    await h.upload('incoming.md', Buffer.from('[Original scene](mixed/diagram.excalidraw)\n'));
    await fs.mkdir(path.join(h.source.rootPath, 'mixed/empty'), { recursive: true });
    const pdf = Buffer.from('%PDF-1.7\n\0\xff\n%%EOF', 'binary'); await fs.writeFile(path.join(h.source.rootPath, 'mixed/manual.pdf'), pdf);
    const originalScene = await importExcalidrawDocumentFile({ workspace: sourceOwner, actor, path: 'mixed/diagram.excalidraw', content: portable });
    const initialProjection = await fs.readFile(path.join(h.source.rootPath, originalScene.path));
    const advanced = await applyExcalidrawScenePatch({ documentId: originalScene.documentId, lifecycleGeneration: originalScene.lifecycleGeneration,
      baseSequence: originalScene.sceneSequence, messageId: randomUUID(), actorType: 'user', actorId: 'owner', initiatedByUserId: 'owner',
      elements: [{ id: 'rectangle', type: 'rectangle', version: 1, versionNonce: 10, isDeleted: false, x: 10, y: 20, width: 30, height: 40 }] });
    const scene = advanced.state; assert.equal(scene.sceneSequence, originalScene.sceneSequence + 1);
    await fs.unlink(path.join(h.source.rootPath, scene.path));
    const occupied = await importExcalidrawDocumentFile({ workspace: h.destination,
      actor: { userId: 'member', actorId: 'member', actorType: 'user', sessionId: 'session-member' }, path: 'occupied.excalidraw', content: portable });
    await fs.unlink(path.join(h.destination.rootPath, occupied.path));
    // Registry-only Scene and virtual ancestors use actual stored rows and the
    // production Scene writer. This arrangement grants no principal authority.
    const virtualId = `virtual-${randomUUID()}`, virtualLineage = `virtual-lineage-${randomUUID()}`, virtualPath = 'virtual-only/nested/diagram.excalidraw';
    await h.admin.query(`INSERT INTO file_collaboration_lineages(id,organization_id,workspace_id,workspace_type,path,status,created_at)
      VALUES($1,$2,$3,$4,$5,'active',100)`, [virtualLineage, h.source.organizationId ?? null, h.source.workspaceId, h.source.workspaceType, virtualPath]);
    await h.admin.query(`INSERT INTO collaboration_documents(id,lineage_id,organization_id,workspace_id,workspace_type,path,provider,state_version,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'excalidraw',0,'active',100,100)`, [virtualId, virtualLineage, h.source.organizationId ?? null, h.source.workspaceId, h.source.workspaceType, virtualPath]);
    await ensureExcalidrawScene({ documentId: virtualId, workspaceId: h.source.workspaceId, organizationId: h.source.organizationId ?? null,
      path: virtualPath, initialContent: JSON.stringify({ type: 'excalidraw', elements: [], appState: {} }) });

    type Observed = { sourceObservation: WorkspaceCopySourceObservation; destinationObservation: WorkspaceCopySourceObservation };
    const read = async <T>(operation: (observations: Observed) => T | Promise<T>): Promise<T> => {
      const workspaceIds = [h.source.workspaceId, h.destination.workspaceId].sort();
      const enter = (index: number): Promise<T> => index < workspaceIds.length
        ? withWorkspaceMutationLock(workspaceIds[index], () => enter(index + 1)) : (async () => {
          await h.admin.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
          try {
            for (const id of workspaceIds) await h.admin.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(id)]);
            const before = (await h.admin.query("SELECT pg_backend_pid() AS pid,current_setting('transaction_read_only') AS readonly")).rows[0];
            assert.equal(before.readonly, 'on');
            const sourceObservation = await observe(h.connection, h.source), destinationObservation = await observe(h.connection, h.destination);
            const value = await operation({ sourceObservation, destinationObservation });
            assert.deepEqual((await h.admin.query("SELECT pg_backend_pid() AS pid,current_setting('transaction_read_only') AS readonly")).rows[0], before);
            return value;
          } finally { await h.admin.query('ROLLBACK'); }
        })();
      return enter(0);
    };
    const build = (observations: Observed, selected = selections) => create({ sourceScope, destinationScope, selections: selected, ...observations });
    const recheck = (plan: WorkspaceOperationManagedCopyPlan, observations: Observed) => current(plan, { ...scopes, ...observations });
    const failure = (error: unknown) => error instanceof WorkspaceOperationManagedCopyPlanError
      || error instanceof WorkspaceOperationNativeSourceEvidenceError || error instanceof WorkspaceSceneSnapshotError;
    const group = async (name: string, operation: () => Promise<void>) => { currentCase = name; await operation(); console.log(`PASS managed-copy-plan ${++groups}: ${name}`); };
    const edge = (compiled: NativeMixedBatchPlan, workspaceId: string, from: string, to: string) => {
      const source = compiled.finalNamespace.find(entity => entity.workspaceId === workspaceId && entity.path === from);
      const target = compiled.finalNamespace.find(entity => entity.workspaceId === workspaceId && entity.path === to); assert(source && target);
      const value = compiled.finalEdges.find(link => link.sourceEntityKey === source.entityKey && link.resolution.targetEntityKey === target.entityKey); assert(value, `${from} -> ${to}`); return value;
    };
    await withNativeInspectionSchema(async () => {
      let baseline!: WorkspaceOperationManagedCopyPlan;
      await group('real READ source and WRITE destination plan mixed Yjs, Scene, PDF and empty directory without publishing', async () => read(observations => {
        baseline = build(observations); const compiled = recheck(baseline, observations);
        assert.equal(baseline.version, 3); assert.equal(baseline.sourceEvidence.evidenceVersion, 3); assert.equal(baseline.destinationEvidence.evidenceVersion, 3);
        assert.equal(baseline.executionReady, false); assert.equal(compiled.executionReady, false);
        assert.deepEqual(baseline.sourceEvidence.nativeComponent.stage.scope.excludedPaths.filter(value => value.endsWith('.excalidraw')).sort(), [scene.path, virtualPath].sort());
        assert(!baseline.sourceEvidence.nativeComponent.stage.namespace.some(entry => entry.path === scene.path || entry.path.startsWith('virtual-only')));
        assert(baseline.sourceEvidence.stage.namespace.some(entry => entry.provider === 'excalidraw' && entry.path === scene.path));
        assert.equal(compiled.planId, baseline.compilerPlanProof); assert.equal(compiled.finalGraphProof, baseline.finalGraphProof);
        assert.deepEqual(baseline.cloneRequirements.map(requirement => requirement.sourcePath).sort(), ['mixed/note.md', 'mixed/target.md']);
        assert(baseline.cloneRequirements.every(requirement => requirement.sourcePath !== scene.path));
        assert(baseline.sourceEvidence.nativeBindings.every(binding => binding.expected.documentId !== scene.documentId));
        const binding = observations.sourceObservation.sceneBindings.find(value => value.header.id === scene.documentId); assert(binding);
        assert.deepEqual(baseline.sceneCopyRequirements, [{ sourceWorkspaceId: h.source.workspaceId, sourcePath: scene.path,
          sourceDocumentId: scene.documentId, sourceLineageId: binding.header.lineage_id, sourceGeneration: scene.lifecycleGeneration,
          sourceSceneSequence: scene.sceneSequence, sourceCanonicalHash: scene.canonicalHash, sourceContentProof: binding.contentProof,
          destinationWorkspaceId: h.destination.workspaceId, destinationPath: 'copied/diagram.excalidraw' }]);
        const mapped = baseline.nativePathPlan.pathMappings.map(mapping => [mapping.source.path, mapping.destinationPath]);
        for (const [from, to] of [['mixed/diagram.excalidraw', 'copied/diagram.excalidraw'], ['mixed/manual.pdf', 'copied/manual.pdf'], ['mixed/empty', 'copied/empty']]) {
          assert(mapped.some(mapping => mapping[0] === from && mapping[1] === to));
        }
        assert.equal(edge(compiled, h.destination.workspaceId, 'copied/note.md', 'copied/diagram.excalidraw').literal, '/copied/diagram.excalidraw');
        edge(compiled, h.destination.workspaceId, 'copied/note.md', 'copied/target.md'); edge(compiled, h.destination.workspaceId, 'copied/note.md', 'copied/manual.pdf');
        edge(compiled, h.source.workspaceId, 'incoming.md', scene.path);
        assert.equal(compiled.finalNamespace.find(entity => entity.workspaceId === h.destination.workspaceId && entity.path === 'copied/empty')?.kind, 'directory');
        assert.deepEqual(decode(JSON.parse(JSON.stringify(baseline))), baseline); assert(Object.isFrozen(baseline.sceneCopyRequirements));
        assert.equal(JSON.stringify(baseline).includes('privateSceneSnapshots'), false); assert.equal(JSON.stringify(baseline).includes('dataURL'), false);
      }));
      await fs.access(path.join(h.destination.rootPath, 'copied')).then(() => assert.fail('Pure planner published a folder.'), error => assert.equal(error.code, 'ENOENT'));
      assert.deepEqual(await fs.readFile(path.join(h.source.rootPath, 'mixed/manual.pdf')), pdf);

      await group('missing or stale Scene projection never supplies content and registry-only Scene destination blocks collision', async () => {
        await fs.writeFile(path.join(h.source.rootPath, scene.path), '{not a Scene; projection is replaceable}');
        try { await read(observations => {
          const snapshot = observations.sourceObservation.privateSceneSnapshots.find(value => value.scene.documentId === scene.documentId); assert(snapshot);
          assert.equal(snapshot.scene.canonicalHash, scene.canonicalHash); assert.equal(snapshot.scene.assets[0].fileId, assetId);
          assert(!observations.sourceObservation.stage.sources.some(value => value.kind === 'physical' && value.inventory.path === scene.path));
          assert.equal(build(observations).planId, baseline.planId); recheck(baseline, observations);
          assert.throws(() => build(observations, [{ sourcePath: scene.path, destinationPath: occupied.path }]), failure);
        }); } finally { await fs.unlink(path.join(h.source.rootPath, scene.path)); }
      });
      await group('actual checkpoint advances preserve semantic plan ID while historical full proofs change', async () => {
        await fs.writeFile(path.join(h.source.rootPath, scene.path), initialProjection);
        const before = await loadExcalidrawScene(scene.documentId); assert(before);
        const registryBefore = (await h.admin.query('SELECT state_version FROM collaboration_documents WHERE id=$1', [scene.documentId])).rows[0];
        assert.equal(Number(registryBefore.state_version), originalScene.sceneSequence);
        const checkpoint = await materializeExcalidrawCheckpoint({ state: before, workspace: sourceOwner, actorUserId: 'owner', actorType: 'user', sourceSessionId: 'session-owner' });
        assert.equal(checkpoint.sceneSequence, scene.sceneSequence);
        const after = await loadExcalidrawScene(scene.documentId); assert(after);
        assert.equal(after.sceneSequence, scene.sceneSequence); assert.equal(after.canonicalHash, scene.canonicalHash);
        assert.equal(after.checkpointSequence, scene.sceneSequence); assert(after.checkpointRevisionId);
        assert.equal(Number((await h.admin.query('SELECT state_version FROM collaboration_documents WHERE id=$1', [scene.documentId])).rows[0].state_version), scene.sceneSequence);
        await read(observations => { const updated = build(observations); assert.equal(updated.planId, baseline.planId);
          assert.notEqual(updated.sourceEvidence.evidenceProof, baseline.sourceEvidence.evidenceProof);
          assert.notEqual(updated.integrityProof, baseline.integrityProof); recheck(baseline, observations); });
      });
      await group('strict codec rejects unknown keys, altered evidence and historical V2 instead of blessing a rehashed shape', async () => read(observations => {
        for (const mutation of [
          (value: Mutable<WorkspaceOperationManagedCopyPlan>) => { Reflect.set(value, 'unknown', true); },
          (value: Mutable<WorkspaceOperationManagedCopyPlan>) => { value.sourceEvidence.semanticProof = '0'.repeat(64); },
          (value: Mutable<WorkspaceOperationManagedCopyPlan>) => { value.sourceEvidence.sceneBindings[0].contentProof = '0'.repeat(64); },
          (value: Mutable<WorkspaceOperationManagedCopyPlan>) => { value.sceneCopyRequirements[0].sourceDocumentId = 'forged'; },
          (value: Mutable<WorkspaceOperationManagedCopyPlan>) => { value.sceneCopyRequirements = new Array(1); },
          (value: Mutable<WorkspaceOperationManagedCopyPlan>) => { value.nativePathPlan.pathMappings[0].destinationPath = 'forged.md'; },
          (value: Mutable<WorkspaceOperationManagedCopyPlan>) => { Reflect.set(value.sourceEvidence.sceneBindings[0].header, 'unknown', true); },
        ]) { const forged = mutable(baseline); mutation(forged); assert.throws(() => decode(forged), failure); }
        const fresh = build(observations);
        const strip = (value: WorkspaceCopySourceObservation, component: typeof fresh.sourceEvidence.nativeComponent) => { const copy = mutable(value);
          copy.stage = mutable(component.stage);
          Reflect.deleteProperty(copy, 'sceneBindings'); Reflect.deleteProperty(copy, 'privateSceneSnapshots'); Reflect.deleteProperty(copy, 'privateSceneCatalogue');
          copy.stage.stageProof = workspaceSourceAuthorityStageProof(copy.stage); return copy; };
        const historical = createWorkspaceOperationNativeCopyPlanV2({ sourceScope, destinationScope,
          selections: [{ sourcePath: 'mixed/target.md', destinationPath: 'historical.md' }],
          sourceObservation: strip(observations.sourceObservation, fresh.sourceEvidence.nativeComponent),
          destinationObservation: strip(observations.destinationObservation, fresh.destinationEvidence.nativeComponent) });
        assert.equal(historical.version, 2); assert.throws(() => decode(historical), failure);
        const resign = (value: Mutable<typeof fresh.sourceEvidence>) => {
          value.stage.stageProof = workspaceSourceAuthorityStageProof(value.stage);
          const { evidenceProof: _old, ...body } = value; value.evidenceProof = proof(body); return value;
        };
        // Scene paths are already excluded from the native component. A Set
        // must not hide duplicate exclusions in the complete historical stage.
        const duplicate = mutable(fresh.sourceEvidence);
        duplicate.stage.scope.excludedPaths.push(scene.path, scene.path);
        assert.deepEqual([...new Set([...duplicate.stage.scope.excludedPaths,
          ...duplicate.sceneBindings.map(binding => binding.header.path)])].sort(), duplicate.nativeComponent.stage.scope.excludedPaths);
        assert.throws(() => decodeEvidence(resign(duplicate)), failure);
        const duplicateObservation = mutable(observations.sourceObservation);
        duplicateObservation.stage.scope.excludedPaths.push(scene.path, scene.path);
        duplicateObservation.stage.stageProof = workspaceSourceAuthorityStageProof(duplicateObservation.stage);
        assert.throws(() => captureEvidence(scopes.sourceScope, duplicateObservation), failure);

        // Derive a valid equivalent component first, then replace only the full
        // stage's array by its iterable string. All component and outer proofs
        // remain internally consistent, so rejection must inspect the raw scope.
        const iterableObservation = mutable(observations.sourceObservation);
        iterableObservation.stage.scope.excludedPaths = ['a', 'b'];
        iterableObservation.stage.stageProof = workspaceSourceAuthorityStageProof(iterableObservation.stage);
        const iterableEvidence = mutable(captureEvidence(scopes.sourceScope, iterableObservation));
        assert.deepEqual(iterableEvidence.nativeComponent.stage.scope.excludedPaths,
          [...new Set(['a', 'b', ...iterableEvidence.sceneBindings.map(binding => binding.header.path)])].sort());
        Reflect.set(iterableEvidence.stage.scope, 'excludedPaths', 'ab');
        assert.throws(() => decodeEvidence(resign(iterableEvidence)), failure);
        Reflect.set(iterableObservation.stage.scope, 'excludedPaths', 'ab');
        iterableObservation.stage.stageProof = workspaceSourceAuthorityStageProof(iterableObservation.stage);
        assert.throws(() => captureEvidence(scopes.sourceScope, iterableObservation), failure);
        for (const fingerprint of ['01:2:3:4:5', '-1:2:3:4:5', '1:2:3:NaN:5', '1:2:3:4:5:6', '9'.repeat(300)]) {
          const forged = mutable(fresh.sourceEvidence), entry = forged.stage.namespace.find(value => value.path === scene.path); assert(entry);
          entry.filesystemIdentity = fingerprint; assert.throws(() => decodeEvidence(resign(forged)), failure);
        }
        for (const property of ['identity', 'workspaceId'] as const) {
          const forged = mutable(fresh.sourceEvidence), parent = forged.stage.namespace.find(value => value.path === 'virtual-only'); assert(parent);
          assert.equal(parent.filesystemIdentity, null); parent[property] = 'forged';
          assert.throws(() => decodeEvidence(resign(forged)), failure);
        }
      }));
      await group('forged provider bindings, Scene-as-Yjs identities, missing facts and fake parents fail before compilation', async () => read(observations => {
        for (const destinationPath of ['.EXCALIDRAW', 'copied/.EXCALIDRAW']) {
          assert.throws(() => build(observations, [{ sourcePath: scene.path, destinationPath }]), failure);
        }
        const bareSource = mutable(observations.sourceObservation), barePath = 'virtual-only/nested/.EXCALIDRAW';
        const bareSnapshot = bareSource.privateSceneSnapshots.find(value => value.header.id === virtualId); assert(bareSnapshot);
        Object.assign(bareSnapshot.header, { path: barePath, state_path: barePath, lineage_path: barePath });
        bareSnapshot.scene.path = barePath;
        bareSnapshot.contentProof = proof({ version: 1, header: bareSnapshot.header, scene: bareSnapshot.scene });
        // The snapshot decoder intentionally admits stored foreign filenames as
        // facts; the provider-composite Copy contract must reject this basename.
        assert.deepEqual(captureSceneSnapshot(bareSnapshot), bareSnapshot);
        const bareBinding = bareSource.sceneBindings.find(value => value.header.id === virtualId); assert(bareBinding);
        bareBinding.header = mutable(bareSnapshot.header); bareBinding.contentProof = bareSnapshot.contentProof;
        bareSource.privateSceneCatalogue = bareSource.privateSceneCatalogue.map(value => value.id === virtualId ? mutable(bareSnapshot.header) : value);
        const bareEntry = bareSource.stage.namespace.find(value => value.path === virtualPath); assert(bareEntry);
        bareEntry.path = barePath; bareEntry.identity = `scene:${virtualId}:${bareSnapshot.header.lifecycle_generation}:${bareSnapshot.contentProof}`;
        bareSource.stage.stageProof = workspaceSourceAuthorityStageProof(bareSource.stage);
        assert.throws(() => captureEvidence(scopes.sourceScope, bareSource), failure);
        const attempts: Array<(value: Mutable<WorkspaceCopySourceObservation>) => void> = [
          value => { Reflect.set(value.sceneBindings[0], 'provider', 'yjs'); },
          value => { value.sceneBindings = []; value.privateSceneSnapshots = []; value.privateSceneCatalogue = []; },
          value => { const entry = value.stage.namespace.find(entry => entry.path === scene.path); assert(entry); entry.documentId = scene.documentId; entry.lifecycleGeneration = scene.lifecycleGeneration; },
          value => { const parent = value.stage.namespace.find(entry => entry.path === 'mixed'); assert(parent); parent.kind = 'file'; },
          value => { const entry = value.stage.namespace.find(entry => entry.path === scene.path); assert(entry); Reflect.deleteProperty(entry, 'provider'); },
        ];
        for (const mutate of attempts) { const forged = mutable(observations.sourceObservation); mutate(forged);
          forged.stage.stageProof = workspaceSourceAuthorityStageProof(forged.stage);
          assert.throws(() => build({ ...observations, sourceObservation: forged }), failure); }
      }));
      await group('descriptor and proxy fuzz stays outside getters, proxy traps and provider seams', async () => read(observations => {
        let calls = 0; const input = { sourceScope, destinationScope, selections, ...observations };
        const accessor = { ...input }; Object.defineProperty(accessor, 'sourceObservation', { enumerable: true, get: () => { calls++; return observations.sourceObservation; } });
        assert.throws(() => create(accessor), failure);
        const proxy = new Proxy(input, { ownKeys() { calls++; return Reflect.ownKeys(input); }, get() { calls++; throw new Error('Proxy get must not run.'); } });
        assert.throws(() => create(proxy), failure);
        const revoked = Proxy.revocable(input, {}); revoked.revoke(); assert.throws(() => create(revoked.proxy), failure);
        const poisoned = mutable(observations.sourceObservation); Object.defineProperty(poisoned, 'privateSceneSnapshots', { enumerable: true,
          get: () => { calls++; return observations.sourceObservation.privateSceneSnapshots; } });
        assert.throws(() => build({ ...observations, sourceObservation: poisoned }), failure);
        const arrayGetter = mutable(observations.sourceObservation); Object.defineProperty(arrayGetter.privateSceneSnapshots, '0', { enumerable: true,
          get: () => { calls++; return observations.sourceObservation.privateSceneSnapshots[0]; } });
        assert.throws(() => captureEvidence(scopes.sourceScope, arrayGetter), failure);
        const oversized = mutable(observations.sourceObservation), bytes = 128 * 1024 * 1024 + 1;
        oversized.sceneBindings[0].header.elements_bytes = bytes; oversized.privateSceneSnapshots[0].header.elements_bytes = bytes;
        oversized.privateSceneCatalogue[0].elements_bytes = bytes;
        Object.defineProperty(oversized.privateSceneSnapshots[0], 'scene', { enumerable: true,
          get: () => { calls++; return observations.sourceObservation.privateSceneSnapshots[0].scene; } });
        assert.throws(() => captureEvidence(scopes.sourceScope, oversized), (error: unknown) => error instanceof WorkspaceOperationNativeSourceEvidenceError
          && error.code === 'NATIVE_SOURCE_EVIDENCE_TOO_LARGE');
        const raw = mutable(baseline); Object.defineProperty(raw, 'sourceEvidence', { enumerable: true, get: () => { calls++; return baseline.sourceEvidence; } });
        assert.throws(() => decode(raw), failure); assert.equal(calls, 0);
      }));
      await group('actual generation, sequence and canonical-content changes invalidate the original plan', async () => {
        await h.admin.query('UPDATE collaboration_excalidraw_states SET lifecycle_generation=lifecycle_generation+1 WHERE document_id=$1', [scene.documentId]);
        try { await read(observations => assert.throws(() => recheck(baseline, observations), failure)); }
        finally { await h.admin.query('UPDATE collaboration_excalidraw_states SET lifecycle_generation=$2 WHERE document_id=$1', [scene.documentId, scene.lifecycleGeneration]); }
        await h.admin.query('UPDATE collaboration_excalidraw_states SET scene_sequence=scene_sequence+1 WHERE document_id=$1', [scene.documentId]);
        try { await read(observations => assert.throws(() => recheck(baseline, observations), failure)); }
        finally { await h.admin.query('UPDATE collaboration_excalidraw_states SET scene_sequence=$2 WHERE document_id=$1', [scene.documentId, scene.sceneSequence]); }
        const latest = await loadExcalidrawScene(scene.documentId); assert(latest);
        const changed = await applyExcalidrawScenePatch({ documentId: scene.documentId, lifecycleGeneration: latest.lifecycleGeneration,
          baseSequence: latest.sceneSequence, messageId: randomUUID(), actorType: 'user', actorId: 'owner', initiatedByUserId: 'owner',
          elements: [{ ...latest.elements.find(element => element.id === 'rectangle')!, version: 2, versionNonce: 11, x: 99 }] });
        assert.notEqual(changed.state.canonicalHash, scene.canonicalHash);
        // Stored-data counterexample isolates the content guard: keep the old
        // sequence after the real writer changed canonical elements and hash.
        await h.admin.query('UPDATE collaboration_excalidraw_states SET scene_sequence=$2 WHERE document_id=$1', [scene.documentId, scene.sceneSequence]);
        await read(observations => { const updated = build(observations);
          assert.equal(updated.sceneCopyRequirements[0].sourceSceneSequence, baseline.sceneCopyRequirements[0].sourceSceneSequence);
          assert.notEqual(updated.sceneCopyRequirements[0].sourceCanonicalHash, baseline.sceneCopyRequirements[0].sourceCanonicalHash);
          assert.notEqual(updated.planId, baseline.planId); assert.throws(() => recheck(baseline, observations), failure); });
      });
      assert.equal(groups, 7);
    });
  });
  completed = true;
  console.log('Managed Copy Plan V3: 7 real PostgreSQL groups and private fixture cleanup passed; no Copy publication or HTTP authorization claim.');
}
main().catch(error => { console.error(`Managed Copy Plan failure in ${currentCase}:`, error); process.exitCode = 1; });
