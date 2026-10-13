import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { closeDatabaseConnections, openDb } from '@/app/lib/db';
import { createEmptyExcalidrawFileContent } from '@/app/lib/excalidraw-file';
import { loadExcalidrawAsset } from '@/app/lib/excalidraw-collaboration/assets';
import { materializeExcalidrawCheckpoint, serializePortableExcalidrawScene } from '@/app/lib/excalidraw-collaboration/checkpoint';
import { flushPendingExcalidrawCheckpoints } from '@/app/lib/excalidraw-collaboration/checkpoint-worker';
import { applyExcalidrawScenePatch, archiveExcalidrawScenePaths, loadExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';
import {
  applyExcalidrawChanges, createExcalidrawDocument, getExcalidrawDocument,
  recoverPendingExcalidrawCreates, type ExcalidrawDocumentActor, type ExcalidrawDocumentSnapshot,
} from '@/app/lib/excalidraw-collaboration/scene-service';
import type { ExcalidrawElementRecord } from '@/app/lib/excalidraw-collaboration/protocol';
import { fileVersionContentStore } from '@/app/lib/file-version-center/version-content-store';
import { getFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { runWithAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/contracts';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const suffix = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const userId = `scene-user-${suffix}`;
const organizationId = `scene-org-${suffix}`;
const actor: ExcalidrawDocumentActor = { userId, actorId: `scene-agent-${suffix}`, actorType: 'agent' };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: unknown) => {
  assert.equal(error && typeof error === 'object' && 'code' in error ? error.code : undefined, expected);
  return true;
};

function workspace(type: 'personal' | 'team'): WorkspaceContext {
  const rootRelativePath = `workspaces/scene-service-test/${suffix}/${type}/files`;
  return {
    workspaceId: `scene-${type}-${suffix}`, workspaceType: type,
    rootPath: workspaceAbsoluteRoot(rootRelativePath), rootRelativePath,
    organizationId, ownerUserId: type === 'personal' ? userId : null,
    displayName: `Scene service ${type}`, status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true,
      canManageWorkspace: true, canRunAgent: true },
  };
}

function element(id: string, version = 1, versionNonce = 100, extra: Record<string, unknown> = {}): ExcalidrawElementRecord {
  return { id, type: 'rectangle', version, versionNonce, isDeleted: false,
    index: `a${id}`, x: 0, y: 0, width: 100, height: 80, angle: 0,
    opacity: 100, groupIds: [], boundElements: [], ...extra };
}

async function query<Row>(sql: string, params: unknown[] = []): Promise<Row[]> {
  const database = await openDb();
  try { return await database.all(sql, params) as Row[]; }
  finally { await database.close(); }
}

async function execute(sql: string, params: unknown[] = []): Promise<void> {
  const database = await openDb();
  try { await database.run(sql, params); }
  finally { await database.close(); }
}

async function seedWorkspaces(workspaces: WorkspaceContext[]) {
  // This script deliberately never runs migrations: the native PostgreSQL test
  // database must already be migrated, so suites cannot race schema changes.
  await execute(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
    VALUES ($1,'Scene service test',$2,1,$3,$3)`, [userId, `${userId}@scene.test`, Date.now()]);
  await execute(`INSERT INTO canvas_organization_settings
    (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
    VALUES ($1,$2,'team',1,$3,$3)`, [organizationId, userId, Date.now()]);
  for (const current of workspaces) {
    await fs.mkdir(current.rootPath, { recursive: true });
    await execute(`INSERT INTO canvas_workspaces
      (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$7)`, [current.workspaceId, organizationId,
      current.workspaceType, current.ownerUserId ?? null, current.rootRelativePath, current.displayName, Date.now()]);
  }
}

async function assertVersionBytes(current: WorkspaceContext, snapshot: ExcalidrawDocumentSnapshot, bytes: Buffer) {
  const identity = await getFileCollaborationState({ workspace: current, path: snapshot.path });
  assert.ok(identity.lineageId);
  const rows = await query<{ id: string; content_hash: string }>(`SELECT id, content_hash FROM file_revisions
    WHERE lineage_id=$1 AND history_only=false ORDER BY revision_number DESC LIMIT 1`, [identity.lineageId]);
  assert.ok(rows[0], 'A headless scene must have a durable file revision.');
  assert.equal(rows[0].content_hash, hash(bytes));
  const version = await fileVersionContentStore.readRevisionContent({ workspaceId: current.workspaceId,
    lineageId: identity.lineageId, revisionId: rows[0].id });
  assert.ok(version, 'The revision must retain the actual portable bytes.');
  assert.deepEqual(version.content, bytes);
}

async function assertGenericRead(current: WorkspaceContext, snapshot: ExcalidrawDocumentSnapshot) {
  const { readAgentCollaborativeExcalidrawFile } = await import('@/app/lib/pi/agent-file-operations');
  const { piTools } = await import('@/app/lib/pi/core-tools');
  const context = { userId, sessionId: `scene-session-${suffix}`, agentId: actor.actorId,
    workspaceId: current.workspaceId, workspaceType: current.workspaceType,
    workspaceName: current.displayName ?? null, organizationId, customerId: null, projectId: null,
    workspaceRoot: current.rootPath, workspaceRootRelativePath: current.rootRelativePath ?? null,
    canWrite: true, canDelete: true, canShare: true, legacy: false };
  await runWithAgentExecutionContext(context, async () => {
    const read = await readAgentCollaborativeExcalidrawFile(path.join(current.rootPath, snapshot.path));
    assert.ok(read);
    assert.equal(read.documentId, snapshot.documentId);
    assert.equal(read.lifecycleGeneration, snapshot.lifecycleGeneration);
    assert.equal(read.sceneSequence, snapshot.sceneSequence);
    const live = JSON.parse(read.content);
    assert.deepEqual(live.elements, snapshot.elements);
    assert.deepEqual(live.assets, snapshot.assets);
    assert.equal(live.canonicalHash, snapshot.canonicalHash);
    const tool = piTools.find(candidate => candidate.name === 'read');
    assert.ok(tool);
    const result = await tool.execute(`scene-read-${suffix}`, { path: snapshot.path, maxChars: 30_000 });
    const details = result.details as { error?: string; collaboration?: { documentId: string;
      lifecycleGeneration: number; sceneSequence: number; canonicalHash: string } };
    assert.equal(details.error, undefined);
    assert.equal(details.collaboration?.documentId, snapshot.documentId);
    assert.equal(details.collaboration?.lifecycleGeneration, snapshot.lifecycleGeneration);
    assert.equal(details.collaboration?.sceneSequence, snapshot.sceneSequence);
    assert.equal(details.collaboration?.canonicalHash, snapshot.canonicalHash);
    assert.ok(result.content.some(part => part.type === 'text' && part.text.includes(snapshot.canonicalHash)),
      'The generic read tool must include the authoritative scene in model-visible content.');
  });
}

async function headless(current: WorkspaceContext) {
  const created = await createExcalidrawDocument({ workspace: current, path: 'headless.excalidraw', actor,
    idempotencyKey: `headless-${suffix}` });
  assert.equal(created.workspaceId, current.workspaceId);
  assert.equal(created.lifecycleGeneration, 1);
  assert.equal(created.sceneSequence, 0);
  assert.deepEqual(created.elements, []);
  await assertVersionBytes(current, created, await fs.readFile(path.join(current.rootPath, created.path)));
  const applied = await applyExcalidrawChanges({ workspace: current, actor, documentId: created.documentId,
    lifecycleGeneration: created.lifecycleGeneration, observedSceneSequence: created.sceneSequence,
    idempotencyKey: `headless-edit-${suffix}`, actions: [
      { type: 'create', element: element('first') }, { type: 'create', element: element('second') },
    ] });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.sceneSequence, 1);
  assert.equal(applied.checkpoint.status, 'saved', 'A closed document must checkpoint without an editor room.');
  assert.equal(applied.checkpoint.sequence, applied.sceneSequence);
  const replayInput = { workspace: current, actor, documentId: created.documentId,
    lifecycleGeneration: created.lifecycleGeneration, observedSceneSequence: created.sceneSequence,
    idempotencyKey: `headless-edit-${suffix}`, actions: [
      { type: 'create' as const, element: element('first') }, { type: 'create' as const, element: element('second') },
    ] };
  const replay = await applyExcalidrawChanges(replayInput);
  assert.equal(replay.operationId, applied.operationId);
  assert.equal(replay.sceneSequence, applied.sceneSequence, 'A service retry must not apply the same actions twice.');
  await assert.rejects(applyExcalidrawChanges({ ...replayInput,
    actions: [{ type: 'create', element: element('different-payload') }] }), code('EXCALIDRAW_IDEMPOTENCY_CONFLICT'));
  const loaded = await getExcalidrawDocument({ workspace: current, documentId: created.documentId });
  assert.equal(loaded.documentId, created.documentId);
  assert.deepEqual(loaded.elements.map(entry => entry.id), ['first', 'second']);
  const bytes = await fs.readFile(path.join(current.rootPath, created.path));
  assert.equal(bytes.toString(), await serializePortableExcalidrawScene(loaded));
  await assertVersionBytes(current, loaded, bytes);
  await assertGenericRead(current, loaded);
  const observed = loaded.elements.find(entry => entry.id === 'first')!;
  const updated = await applyExcalidrawChanges({ workspace: current, actor, documentId: loaded.documentId,
    lifecycleGeneration: loaded.lifecycleGeneration, observedSceneSequence: loaded.sceneSequence,
    idempotencyKey: `closed-second-edit-${suffix}`, actions: [{ type: 'update', elementId: 'first',
      expectedVersion: observed.version, expectedVersionNonce: observed.versionNonce,
      element: { ...observed, x: 42 } }] });
  assert.equal(updated.status, 'applied');
  assert.equal(updated.checkpoint.status, 'saved');
  assert.equal((await getExcalidrawDocument({ workspace: current, documentId: loaded.documentId })).elements[0].x, 42);
  return created;
}

async function concurrentCreate(current: WorkspaceContext) {
  const input = { workspace: current, actor, path: 'concurrent.excalidraw', idempotencyKey: `same-${suffix}` };
  const repeated = await Promise.all(Array.from({ length: 4 }, () => createExcalidrawDocument(input)));
  assert.equal(new Set(repeated.map(scene => scene.documentId)).size, 1, 'Identical concurrent creates must converge.');
  const identity = await fs.stat(path.join(current.rootPath, input.path), { bigint: true });
  assert.equal((await createExcalidrawDocument(input)).documentId, repeated[0].documentId);
  assert.equal((await fs.stat(path.join(current.rootPath, input.path), { bigint: true })).ino, identity.ino);
  await assert.rejects(createExcalidrawDocument({ ...input, path: 'different-payload.excalidraw' }), code('EXCALIDRAW_IDEMPOTENCY_CONFLICT'));
  await assert.rejects(fs.stat(path.join(current.rootPath, 'different-payload.excalidraw')), { code: 'ENOENT' });
  const competing = await Promise.allSettled(['one', 'two'].map(key => createExcalidrawDocument({ workspace: current,
    actor, path: 'competing.excalidraw', idempotencyKey: `competing-${key}-${suffix}` })));
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  const loser = competing.find(result => result.status === 'rejected');
  assert.ok(loser && loser.status === 'rejected');
  code('PATH_EXISTS')(loser.reason);
  await assert.rejects(createExcalidrawDocument({ ...input, actor: { ...actor, actorId: `another-agent-${suffix}` } }), code('PATH_EXISTS'));
  await assert.rejects(createExcalidrawDocument({ ...input, actor: { ...actor, userId: `another-user-${suffix}` } }), code('PATH_EXISTS'));
  await fs.writeFile(path.join(current.rootPath, 'foreign-empty.excalidraw'), createEmptyExcalidrawFileContent());
  await assert.rejects(createExcalidrawDocument({ workspace: current, actor, path: 'foreign-empty.excalidraw',
    idempotencyKey: `foreign-empty-${suffix}` }), code('PATH_EXISTS'));
}

async function imports(current: WorkspaceContext) {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR3cAAAAASUVORK5CYII=', 'base64');
  const portable = JSON.stringify({ type: 'excalidraw', version: 2,
    elements: [element('portable-image', 3, 400, { type: 'image', fileId: 'portable-png' })],
    appState: { viewBackgroundColor: '#123456', selectedElementIds: { 'portable-image': true } },
    files: { 'portable-png': { id: 'portable-png', mimeType: 'image/png',
      dataURL: `data:image/png;base64,${png.toString('base64')}`, created: 10, version: 2 } } });
  await fs.writeFile(path.join(current.rootPath, 'imported.excalidraw'), portable);
  const imported = await getExcalidrawDocument({ workspace: current, path: 'imported.excalidraw', actor });
  assert.equal(imported.elements[0].version, 3);
  assert.equal(imported.elements[0].versionNonce, 400);
  assert.deepEqual(imported.appState, { viewBackgroundColor: '#123456' });
  assert.equal(imported.assets.length, 1);
  assert.equal(imported.assets[0].fileId, 'portable-png');
  assert.deepEqual((await loadExcalidrawAsset({ workspaceId: current.workspaceId, fileId: 'portable-png' }))?.data, png);
  assert.equal((await getExcalidrawDocument({ workspace: current, path: 'imported.excalidraw' })).documentId, imported.documentId);
  await assertVersionBytes(current, imported, Buffer.from(portable));
  const image = (fileId: string) => element(`image-${fileId}`, 1, 100, { type: 'image', fileId });
  const portableAsset = (id: string, bytes = png) => ({ id, mimeType: 'image/png',
    dataURL: `data:image/png;base64,${bytes.toString('base64')}`, version: 1, created: 10 });
  for (const [name, content] of [['invalid-json', '{'], ['wrong-type', '{"type":"markdown","elements":[]}'],
    ['invalid-element', JSON.stringify({ type: 'excalidraw', elements: [element('bad', 0)] })],
    ['missing-asset', JSON.stringify({ type: 'excalidraw', elements: [image('missing-png')], files: {} })],
    ['invalid-asset-id', JSON.stringify({ type: 'excalidraw', elements: [],
      files: { 'mismatched-png': portableAsset('another-id') } })],
    ['invalid-asset-bytes', JSON.stringify({ type: 'excalidraw', elements: [image('invalid-png')],
      files: { 'invalid-png': portableAsset('invalid-png', Buffer.from('not PNG bytes')) } })],
    ['late-invalid-asset', JSON.stringify({ type: 'excalidraw', elements: [], files: {
      'prefix-good-png': portableAsset('prefix-good-png'),
      'late-invalid-png': portableAsset('late-invalid-png', Buffer.from('not PNG bytes')),
    } })],
    ['existing-asset-conflict', JSON.stringify({ type: 'excalidraw', elements: [image('portable-png')], files: {
      'prefix-before-conflict': portableAsset('prefix-before-conflict'),
      'portable-png': portableAsset('portable-png', Buffer.concat([png, Buffer.from('different content')])),
    } })]]) {
    await fs.writeFile(path.join(current.rootPath, `${name}.excalidraw`), content);
    await assert.rejects(getExcalidrawDocument({ workspace: current, path: `${name}.excalidraw` }),
      undefined, `${name}: invalid imports must reject before creating document identity.`);
    assert.equal((await query(`SELECT state.document_id FROM collaboration_excalidraw_states state
      WHERE state.workspace_id=$1 AND state.path=$2`, [current.workspaceId, `${name}.excalidraw`])).length, 0,
    'Invalid existing files must never become initialized scenes.');
    assert.equal((await query('SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
      [current.workspaceId, `${name}.excalidraw`])).length, 0, 'Invalid imports must not allocate document identities.');
    assert.equal((await query('SELECT id FROM file_collaboration_lineages WHERE workspace_id=$1 AND path=$2',
      [current.workspaceId, `${name}.excalidraw`])).length, 0, 'Invalid imports must not allocate active lineages.');
    assert.equal(await fs.readFile(path.join(current.rootPath, `${name}.excalidraw`), 'utf8'), content);
  }
  assert.equal(await loadExcalidrawAsset({ workspaceId: current.workspaceId, fileId: 'prefix-good-png' }), null,
    'A late invalid asset must be validated before the valid asset prefix is persisted.');
  assert.equal(await loadExcalidrawAsset({ workspaceId: current.workspaceId, fileId: 'prefix-before-conflict' }), null,
    'An existing fileId conflict must be checked before a new asset prefix is persisted.');
  assert.deepEqual((await loadExcalidrawAsset({ workspaceId: current.workspaceId, fileId: 'portable-png' }))?.data, png,
    'An invalid portable import must preserve the asset already bound to that workspace fileId.');
}

async function seedCreateReceipt(current: WorkspaceContext, relativePath: string, key: string,
  identity: { dev: string; ino: string } | null) {
  await execute(`INSERT INTO collaboration_excalidraw_creates
    (workspace_id,actor_user_id,actor_id,idempotency_key,request_fingerprint,path,file_dev,file_ino,status,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'preparing',$9,$9)`, [current.workspaceId, userId, actor.actorId, key,
    hash(JSON.stringify({ workspaceId: current.workspaceId, path: relativePath })), relativePath,
    identity?.dev ?? null, identity?.ino ?? null, Date.now()]);
}

async function crashRecovery(current: WorkspaceContext) {
  for (const name of ['owned', 'foreign', 'unknown']) {
    const relativePath = `crash-${name}.excalidraw`;
    const absolutePath = path.join(current.rootPath, relativePath);
    await fs.writeFile(absolutePath, createEmptyExcalidrawFileContent());
    const identity = await fs.stat(absolutePath, { bigint: true });
    await seedCreateReceipt(current, relativePath, `crash-${name}-${suffix}`, name === 'unknown' ? null : {
      dev: String(identity.dev), ino: String(name === 'foreign' ? identity.ino + BigInt(1) : identity.ino),
    });
  }
  await recoverPendingExcalidrawCreates(1000);
  const rows = await query<{ path: string; document_id: string | null; status: string }>(`SELECT path,document_id,status
    FROM collaboration_excalidraw_creates WHERE workspace_id=$1 AND path LIKE 'crash-%' ORDER BY path`, [current.workspaceId]);
  const owned = rows.find(row => row.path === 'crash-owned.excalidraw')!;
  assert.equal(owned.status, 'completed');
  assert.ok(owned.document_id, 'Recovery must finish the metadata for the journal-owned inode.');
  const replay = await createExcalidrawDocument({ workspace: current, actor, path: owned.path,
    idempotencyKey: `crash-owned-${suffix}` });
  assert.equal(replay.documentId, owned.document_id);
  for (const name of ['foreign', 'unknown']) {
    const relativePath = `crash-${name}.excalidraw`;
    const foreign = rows.find(row => row.path === relativePath)!;
    assert.equal(foreign.status, 'preparing');
    assert.equal(foreign.document_id, null);
    assert.equal((await query('SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2',
      [current.workspaceId, relativePath])).length, 0, 'Equal bytes never prove create ownership.');
    await assert.rejects(createExcalidrawDocument({ workspace: current, actor, path: relativePath,
      idempotencyKey: `crash-${name}-${suffix}` }), code('PATH_EXISTS'));
    assert.equal(await fs.readFile(path.join(current.rootPath, relativePath), 'utf8'), createEmptyExcalidrawFileContent());
  }

  // A reader can bind metadata while a creator is interrupted. That binding
  // does not authorize adopting a later replacement inode, even with equal bytes.
  const boundPath = 'crash-bound-foreign.excalidraw';
  const boundAbsolutePath = path.join(current.rootPath, boundPath);
  await fs.writeFile(boundAbsolutePath, createEmptyExcalidrawFileContent());
  const boundIdentity = await fs.stat(boundAbsolutePath, { bigint: true });
  const boundKey = `crash-bound-foreign-${suffix}`;
  await seedCreateReceipt(current, boundPath, boundKey,
    { dev: String(boundIdentity.dev), ino: String(boundIdentity.ino) });
  const boundDocument = await getExcalidrawDocument({ workspace: current, path: boundPath });
  const boundReceipt = (await query<{ document_id: string; status: string }>(`SELECT document_id,status
    FROM collaboration_excalidraw_creates WHERE workspace_id=$1 AND idempotency_key=$2`, [current.workspaceId, boundKey]))[0];
  assert.equal(boundReceipt.document_id, boundDocument.documentId);
  assert.equal(boundReceipt.status, 'preparing');
  const replacement = `${boundAbsolutePath}.replacement-${suffix}`;
  await fs.writeFile(replacement, createEmptyExcalidrawFileContent(), { flag: 'wx' });
  await fs.rename(replacement, boundAbsolutePath);
  const foreignIdentity = await fs.stat(boundAbsolutePath, { bigint: true });
  assert.notEqual(foreignIdentity.ino, boundIdentity.ino);
  await recoverPendingExcalidrawCreates(1000);
  assert.equal((await query<{ status: string }>(`SELECT status FROM collaboration_excalidraw_creates
    WHERE workspace_id=$1 AND idempotency_key=$2`, [current.workspaceId, boundKey]))[0].status, 'preparing');
  await assert.rejects(createExcalidrawDocument({ workspace: current, actor, path: boundPath, idempotencyKey: boundKey }), code('PATH_EXISTS'));
  assert.equal((await fs.stat(boundAbsolutePath, { bigint: true })).ino, foreignIdentity.ino);

  // More than a recovery batch of abandoned, unowned receipts must not keep a
  // later recoverable publication permanently outside the worker's scan.
  for (let index = 0; index < 55; index += 1) {
    const relativePath = `crash-starvation-unowned-${index}.excalidraw`;
    const key = `starvation-unowned-${index}-${suffix}`;
    await seedCreateReceipt(current, relativePath, key, null);
    await execute(`UPDATE collaboration_excalidraw_creates SET created_at=$1
      WHERE workspace_id=$2 AND idempotency_key=$3`, [index + 1, current.workspaceId, key]);
  }
  const recoverablePath = 'crash-starvation-owned.excalidraw';
  await fs.writeFile(path.join(current.rootPath, recoverablePath), createEmptyExcalidrawFileContent());
  const recoverableIdentity = await fs.stat(path.join(current.rootPath, recoverablePath), { bigint: true });
  const recoverableKey = `starvation-owned-${suffix}`;
  await seedCreateReceipt(current, recoverablePath, recoverableKey,
    { dev: String(recoverableIdentity.dev), ino: String(recoverableIdentity.ino) });
  // Keep the synthetic queue ordering independent from receipts left by other
  // suites sharing the already-migrated native test database.
  await execute(`UPDATE collaboration_excalidraw_creates SET created_at=100,updated_at=100
    WHERE workspace_id=$1 AND idempotency_key=$2`, [current.workspaceId, recoverableKey]);
  for (let index = 0; index < 55; index += 1) {
    const relativePath = `crash-starvation-foreign-${index}.excalidraw`;
    const key = `starvation-foreign-${index}-${suffix}`;
    await fs.writeFile(path.join(current.rootPath, relativePath), createEmptyExcalidrawFileContent());
    const identity = await fs.stat(path.join(current.rootPath, relativePath), { bigint: true });
    await seedCreateReceipt(current, relativePath, key, { dev: String(identity.dev), ino: String(identity.ino + BigInt(1)) });
    await execute(`UPDATE collaboration_excalidraw_creates SET created_at=$1,updated_at=$1
      WHERE workspace_id=$2 AND idempotency_key=$3`, [index + 1, current.workspaceId, key]);
  }
  await recoverPendingExcalidrawCreates(50);
  assert.equal((await query<{ status: string }>(`SELECT status FROM collaboration_excalidraw_creates
    WHERE workspace_id=$1 AND idempotency_key=$2`, [current.workspaceId, recoverableKey]))[0].status, 'preparing',
  'The first bounded sweep must not skip the older receipts without examining ownership.');
  await recoverPendingExcalidrawCreates(50);
  await recoverPendingExcalidrawCreates(50);
  assert.equal((await query<{ status: string }>(`SELECT status FROM collaboration_excalidraw_creates
    WHERE workspace_id=$1 AND idempotency_key=$2`, [current.workspaceId, recoverableKey]))[0].status, 'completed',
  'Unowned pending receipts must not starve a recoverable create behind the batch limit.');
}

async function externalConflict(current: WorkspaceContext) {
  const document = await createExcalidrawDocument({ workspace: current, actor, path: 'external-conflict.excalidraw',
    idempotencyKey: `external-${suffix}` });
  await materializeExcalidrawCheckpoint({ workspace: current, state: document });
  const original = (await loadExcalidrawScene(document.documentId))!;
  const altered = `${createEmptyExcalidrawFileContent()}external bytes preserved`;
  await fs.writeFile(path.join(current.rootPath, document.path), altered);
  const persisted = await getExcalidrawDocument({ workspace: current, documentId: document.documentId });
  assert.equal(persisted.canonicalHash, original.canonicalHash, 'Initialized scenes must be read from PostgreSQL.');
  await assert.rejects(materializeExcalidrawCheckpoint({ workspace: current, state: persisted }), code('EXCALIDRAW_CHECKPOINT_CONFLICT'));
  assert.equal(await fs.readFile(path.join(current.rootPath, document.path), 'utf8'), altered);
  const captured = await query<{ id: string; lineage_id: string; history_only: boolean }>(`SELECT revision.id,
    revision.lineage_id,revision.history_only FROM file_revisions revision
    JOIN file_revision_contents content ON content.revision_id=revision.id
    WHERE revision.workspace_id=$1 AND revision.path=$2 AND content.source='external_import'
      AND revision.content_hash=$3`, [current.workspaceId, document.path, hash(altered)]);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].history_only, true);
  const saved = await fileVersionContentStore.readRevisionContent({ workspaceId: current.workspaceId,
    lineageId: captured[0].lineage_id, revisionId: captured[0].id });
  assert.equal(saved?.content.toString(), altered, 'Conflict history must preserve the actual external bytes.');
  await assert.rejects(materializeExcalidrawCheckpoint({ workspace: current, state: persisted }), code('EXCALIDRAW_CHECKPOINT_CONFLICT'));
  assert.equal((await query(`SELECT id FROM file_revisions WHERE workspace_id=$1 AND path=$2
    AND content_hash=$3 AND history_only=true`, [current.workspaceId, document.path, hash(altered)])).length, 1,
  'Repeated conflict inspection must not duplicate the preserved version.');
  const applied = await applyExcalidrawChanges({ workspace: current, actor, documentId: persisted.documentId,
    lifecycleGeneration: persisted.lifecycleGeneration, observedSceneSequence: persisted.sceneSequence,
    idempotencyKey: `external-persisted-edit-${suffix}`, actions: [{ type: 'create', element: element('persisted-despite-conflict') }] });
  assert.equal(applied.status, 'applied', 'A persisted scene change remains applied even when its checkpoint fails.');
  assert.equal(applied.sceneSequence, persisted.sceneSequence + 1);
  assert.equal(applied.checkpoint.status, 'failed', 'The response must disclose the failed portable publication separately.');
  assert.ok(applied.checkpoint.error);
  assert.equal(applied.checkpoint.sequence, persisted.sceneSequence);
  assert.equal((await loadExcalidrawScene(persisted.documentId))?.elements[0].id, 'persisted-despite-conflict');
  assert.equal(await fs.readFile(path.join(current.rootPath, document.path), 'utf8'), altered);
}

async function guards(current: WorkspaceContext, other: WorkspaceContext, document: ExcalidrawDocumentSnapshot) {
  const readonly = { ...current, permissions: { ...current.permissions, canWrite: false } };
  const unreadable = { ...current, permissions: { ...current.permissions, canRead: false } };
  const edit = { workspace: current, actor, documentId: document.documentId,
    lifecycleGeneration: document.lifecycleGeneration, observedSceneSequence: document.sceneSequence,
    actions: [{ type: 'create' as const, element: element('denied') }], idempotencyKey: `denied-${suffix}` };
  await assert.rejects(createExcalidrawDocument({ workspace: readonly, actor, path: 'denied.excalidraw',
    idempotencyKey: `denied-create-${suffix}` }), code('EXCALIDRAW_PERMISSION_DENIED'));
  await assert.rejects(applyExcalidrawChanges({ ...edit, workspace: readonly }), code('EXCALIDRAW_PERMISSION_DENIED'));
  await assert.rejects(getExcalidrawDocument({ workspace: unreadable, documentId: document.documentId }), code('EXCALIDRAW_PERMISSION_DENIED'));
  await assert.rejects(getExcalidrawDocument({ workspace: { ...current, status: 'disabled' }, documentId: document.documentId }), code('EXCALIDRAW_PERMISSION_DENIED'));
  await assert.rejects(getExcalidrawDocument({ workspace: { ...current, legacy: true }, documentId: document.documentId }), code('EXCALIDRAW_PROVIDER_UNAVAILABLE'));
  await assert.rejects(getExcalidrawDocument({ workspace: other, documentId: document.documentId }), code('EXCALIDRAW_DOCUMENT_NOT_FOUND'));
  await assert.rejects(getExcalidrawDocument({ workspace: current, documentId: document.documentId,
    path: 'concurrent.excalidraw' }), code('EXCALIDRAW_DOCUMENT_MISMATCH'));
  await assert.rejects(applyExcalidrawChanges({ ...edit, lifecycleGeneration: document.lifecycleGeneration + 1 }), code('EXCALIDRAW_LIFECYCLE_STALE'));
  await assert.rejects(createExcalidrawDocument({ workspace: current, actor, path: '../escaped.excalidraw',
    idempotencyKey: `escape-${suffix}` }));
  await assert.rejects(createExcalidrawDocument({ workspace: current, actor, path: 'not-scene.md',
    idempotencyKey: `extension-${suffix}` }), code('INVALID_EXCALIDRAW_PATH'));
  const pending = await getExcalidrawDocument({ workspace: current, path: 'concurrent.excalidraw' });
  await applyExcalidrawScenePatch({ documentId: pending.documentId, lifecycleGeneration: pending.lifecycleGeneration,
    baseSequence: pending.sceneSequence, messageId: `worker-patch-${suffix}`, actorType: 'user', actorId: userId,
    elements: [element('worker-recovery')] });
  const flushed = await flushPendingExcalidrawCheckpoints({ workspaceId: current.workspaceId,
    paths: ['concurrent.excalidraw'], throwOnFailure: true });
  assert.equal(flushed.completed, 1, 'The headless worker must resolve a stored workspace without any editor room.');
  const checkpointed = await getExcalidrawDocument({ workspace: current, path: 'concurrent.excalidraw' });
  assert.equal(checkpointed.checkpoint.status, 'saved');
  await archiveExcalidrawScenePaths({ workspaceId: current.workspaceId, paths: [document.path] });
  await assert.rejects(applyExcalidrawChanges(edit), code('EXCALIDRAW_LIFECYCLE_STALE'));
}

async function providerUnavailable() {
  const current = workspace('personal');
  await assert.rejects(getExcalidrawDocument({ workspace: current, path: 'missing.excalidraw' }), code('EXCALIDRAW_PROVIDER_UNAVAILABLE'));
  await assert.rejects(createExcalidrawDocument({ workspace: current, actor, path: 'missing.excalidraw',
    idempotencyKey: 'provider-test' }), code('EXCALIDRAW_PROVIDER_UNAVAILABLE'));
  await assert.rejects(applyExcalidrawChanges({ workspace: current, actor, documentId: 'unavailable',
    lifecycleGeneration: 1, observedSceneSequence: 0, actions: [{ type: 'create', element: element('unavailable') }],
    idempotencyKey: 'provider-test' }), code('EXCALIDRAW_PROVIDER_UNAVAILABLE'));
}

async function main() {
  if (process.argv.includes('--provider-unavailable')) { await providerUnavailable(); return; }
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const workspaces = [workspace('personal'), workspace('team')];
  try {
    await seedWorkspaces(workspaces);
    const documents: ExcalidrawDocumentSnapshot[] = [];
    for (const current of workspaces) {
      documents.push(await headless(current));
      await concurrentCreate(current);
      await imports(current);
      await crashRecovery(current);
      await externalConflict(current);
    }
    for (let index = 0; index < workspaces.length; index += 1) {
      await guards(workspaces[index], workspaces[1 - index], documents[index]);
    }
    const environment = { ...process.env };
    delete environment.DATABASE_URL;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--conditions', 'react-server',
        'scripts/excalidraw-scene-service-test.ts', '--provider-unavailable'],
      { cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-10_000); });
      child.stderr.on('data', chunk => { output = (output + chunk).slice(-10_000); });
      child.once('error', reject);
      child.once('exit', status => status === 0 ? resolve() : reject(new Error(`Unavailable provider test failed: ${output}`)));
    });
    console.log(JSON.stringify({ success: true, workspaces: workspaces.map(current => current.workspaceType),
      headless: true, genericRead: true, closedCheckpoint: true, initialVersionBytes: true,
      concurrentCreate: true, idempotency: true, portableAssets: true, invalidImport: true,
      inodeRecovery: true, boundDocumentForeignInodeRejected: true, recoveryStarvationPrevented: true,
      equalForeignBytesRejected: true, externalConflictBytesRetained: true, persistedChangeCheckpointFailure: true,
      accessAndLifecycle: true, checkpointWorker: true, unavailableProvider: true }));
  } finally {
    for (const current of workspaces) {
      await execute('DELETE FROM collaboration_excalidraw_creates WHERE workspace_id=$1', [current.workspaceId]).catch(() => undefined);
      await execute("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [current.workspaceId]).catch(() => undefined);
      await fs.rm(current.rootPath, { recursive: true, force: true });
    }
  }
}

void main().finally(() => process.argv.includes('--provider-unavailable') ? undefined : closeDatabaseConnections());
