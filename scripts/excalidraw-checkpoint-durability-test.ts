import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { closeDatabaseConnections, db, openDb } from '@/app/lib/db';
import { user } from '@/app/lib/db/schema';
import { createPostgresPool, runPostgresMigrations } from '@/app/lib/db/postgres';
import { setFileCollaborationConnectionFactoryForTests } from '@/app/lib/files/collaboration-repository';
import { archiveFileCollaborationPaths, moveFileCollaborationPath, readFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { fileVersionContentStore } from '@/app/lib/file-version-center/version-content-store';
import { storeExcalidrawAsset } from '@/app/lib/excalidraw-collaboration/assets';
import { materializeExcalidrawCheckpoint, serializePortableExcalidrawScene } from '@/app/lib/excalidraw-collaboration/checkpoint';
import { flushPendingExcalidrawCheckpoints, resolveExcalidrawCheckpointWorkspace } from '@/app/lib/excalidraw-collaboration/checkpoint-worker';
import { applyExcalidrawScenePatch, loadExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';
import { createExcalidrawDocument, getExcalidrawDocument, recoverPendingExcalidrawCreates } from '@/app/lib/excalidraw-collaboration/scene-service';
import { installExcalidrawSceneNotificationListener } from '@/app/lib/excalidraw-collaboration/runtime';
import { resolveAgentSessionWorkspaceForUser } from '@/app/lib/pi/session-workspace-context';

const execFileAsync = promisify(execFile);
const digest = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');

async function prioritizeCreateReceipt(documentId: string) {
  const database = await openDb();
  try {
    // Shared disposable databases may retain fixtures from earlier suites. Keep
    // this receipt in the worker's bounded batch without touching other fixtures.
    await database.run('UPDATE collaboration_excalidraw_creates SET updated_at=0 WHERE document_id=$1', [documentId]);
  } finally { await database.close(); }
}

async function waitUntil(condition: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail('The PostgreSQL notification did not recover the committed scene.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function childMode(): Promise<boolean> {
  const [mode, documentId, workspaceId] = process.argv.slice(2);
  if (!['--crash-checkpoint', '--publish-scene'].includes(mode)) return false;
  assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/canvas_(?:editor|excalidraw)_test_[a-f0-9]{16}$/u);
  const state = await loadExcalidrawScene(documentId);
  assert(state);
  if (mode === '--publish-scene') {
    await applyExcalidrawScenePatch({ documentId, lifecycleGeneration: state.lifecycleGeneration,
      baseSequence: state.sceneSequence, messageId: `native-child-${randomUUID()}`, elements: [],
      appState: { gridModeEnabled: true }, actorType: 'system', actorId: 'native-durability-test' });
    return true;
  }
  const workspace = await resolveExcalidrawCheckpointWorkspace(workspaceId);
  assert(workspace);
  setFileCollaborationConnectionFactoryForTests(async () => {
    const connection = await openDb();
    return { ...connection, run: async (sql, params) => {
      // Abruptly terminate after the fsync publication, before the SQL checkpoint commit.
      if (/UPDATE collaboration_excalidraw_states\s+SET checkpoint_sequence/u.test(sql)) process.exit(73);
      return connection.run(sql, params);
    } };
  });
  await materializeExcalidrawCheckpoint({ state, workspace });
  assert.fail('The crash point must run after portable bytes have been published.');
}

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/canvas_(?:editor|excalidraw)_test_[a-f0-9]{16}$/u,
    'Run only against the private disposable PostgreSQL test wrapper.');
  assert.equal(process.env.NODE_ENV, 'test');
  const migrations = createPostgresPool();
  try { await runPostgresMigrations(migrations); } finally { await migrations.end(); }
  const userId = `excalidraw-durability-${randomUUID()}`;
  const now = new Date();
  await db.insert(user).values({ id: userId, name: 'Excalidraw durability fixture', email: `${userId}@example.test`,
    emailVerified: true, role: 'admin', createdAt: now, updatedAt: now });
  const workspace = await resolveAgentSessionWorkspaceForUser({ userId, permissions: ['canRead', 'canWrite', 'canRunAgent'] });
  const actor = { userId, actorId: 'native-excalidraw-durability-agent', actorType: 'agent' as const,
    sessionId: `native-excalidraw-session-${randomUUID()}` };
  const created = await createExcalidrawDocument({ workspace, actor, path: 'checkpoint.excalidraw', idempotencyKey: randomUUID() });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const asset = await storeExcalidrawAsset({ workspaceId: workspace.workspaceId, fileId: 'durable-image',
    mimeType: 'image/png', data: png, createdAt: 42 });
  const applied = await applyExcalidrawScenePatch({ documentId: created.documentId, lifecycleGeneration: created.lifecycleGeneration,
    baseSequence: created.sceneSequence, messageId: randomUUID(), actorType: 'agent', actorId: actor.actorId,
    elements: [{ id: 'durable-rectangle', type: 'rectangle', version: 1, versionNonce: 10, isDeleted: false,
      x: 10, y: 20, width: 100, height: 80, angle: 0, opacity: 100, groupIds: [], boundElements: [] }], assets: [asset] });
  const portable = await serializePortableExcalidrawScene(applied.state);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await serializePortableExcalidrawScene(applied.state), portable, 'Retry serialization must be deterministic, including embedded assets.');
  // Pre-upgrade scenes had no checkpoint ID/hash even after a durable edit.
  // Their trusted initial physical revision is still bound to the document identity.
  const legacyDb = await openDb();
  try {
    await legacyDb.run(`UPDATE collaboration_excalidraw_states SET checkpoint_content_hash = NULL,
      checkpoint_revision_id = NULL WHERE document_id = $1`, [created.documentId]);
    await legacyDb.run(`UPDATE collaboration_excalidraw_creates SET status='preparing' WHERE document_id=$1`, [created.documentId]);
  }
  finally { await legacyDb.close(); }
  await assert.rejects(execFileAsync(process.execPath, ['--import', 'tsx', '--conditions', 'react-server',
    'scripts/excalidraw-checkpoint-durability-test.ts', '--crash-checkpoint', created.documentId, workspace.workspaceId],
  { env: process.env, timeout: 15_000 }), error => (error as { code?: number }).code === 73);
  const filePath = path.join(workspace.rootPath, created.path);
  assert.equal(await fs.readFile(filePath, 'utf8'), portable, 'The crashed process must have published complete, fsynced bytes.');
  const crashed = await loadExcalidrawScene(created.documentId);
  assert(crashed);
  assert(crashed.checkpointSequence < crashed.sceneSequence, 'An aborted transaction cannot mark the checkpoint saved.');
  await prioritizeCreateReceipt(created.documentId);
  await recoverPendingExcalidrawCreates();
  const pendingDb = await openDb();
  try {
    const receipt = await pendingDb.get('SELECT status FROM collaboration_excalidraw_creates WHERE document_id=$1', [created.documentId]) as { status: string };
    assert.equal(receipt.status, 'preparing', 'Matching checkpoint bytes alone cannot complete a receipt with its old inode proof.');
  } finally { await pendingDb.close(); }
  const recovered = await materializeExcalidrawCheckpoint({ workspace, state: crashed, actorUserId: userId, actorType: 'agent' });
  assert.equal(recovered.content, portable);
  let state = await loadExcalidrawScene(created.documentId);
  assert(state && state.checkpointSequence === state.sceneSequence);
  assert.equal(state.checkpointContentHash, digest(portable));
  const collaboration = await readFileCollaborationState({ workspace, path: state.path });
  assert(collaboration.lineageId && state.checkpointRevisionId);
  const history = await fileVersionContentStore.readRevisionContent({ workspaceId: workspace.workspaceId,
    lineageId: collaboration.lineageId, revisionId: state.checkpointRevisionId });
  assert.equal(history?.content.toString('utf8'), portable, 'History must store the actual portable bytes, including assets.');
  const database = await openDb();
  try {
    const intents = await database.all('SELECT * FROM collaboration_excalidraw_checkpoint_intents WHERE document_id = $1', [state.documentId]);
    assert.equal(intents.length, 0, 'Successful recovery clears its durable publication intent.');
    const receipt = await database.get('SELECT file_dev,file_ino FROM collaboration_excalidraw_creates WHERE document_id=$1', [state.documentId]) as { file_dev: string; file_ino: string };
    const actualIdentity = await fs.stat(filePath, { bigint: true });
    assert.equal(receipt.file_dev, String(actualIdentity.dev));
    assert.equal(receipt.file_ino, String(actualIdentity.ino), 'Only successful checkpoint recovery rotates the preparing create proof.');
  } finally { await database.close(); }
  await prioritizeCreateReceipt(created.documentId);
  await recoverPendingExcalidrawCreates();
  const completedDb = await openDb();
  try {
    const receipt = await completedDb.get('SELECT status FROM collaboration_excalidraw_creates WHERE document_id=$1', [state.documentId]) as { status: string };
    assert.equal(receipt.status, 'completed');
  } finally { await completedDb.close(); }

  // A no-op checkpoint must not adopt a foreign replacement inode, even if its
  // portable bytes are identical to the trusted checkpoint.
  const replacement = await createExcalidrawDocument({ workspace, actor, path: 'identical-replacement.excalidraw', idempotencyKey: randomUUID() });
  const replacementState = await loadExcalidrawScene(replacement.documentId);
  assert(replacementState);
  const replacementPath = path.join(workspace.rootPath, replacement.path);
  const originalIdentity = await fs.stat(replacementPath, { bigint: true });
  const replacementDb = await openDb();
  try { await replacementDb.run(`UPDATE collaboration_excalidraw_creates SET status='preparing' WHERE document_id=$1`, [replacement.documentId]); }
  finally { await replacementDb.close(); }
  const identicalBytes = await fs.readFile(replacementPath);
  await fs.writeFile(`${replacementPath}.replacement`, identicalBytes);
  await fs.rename(`${replacementPath}.replacement`, replacementPath);
  assert.notEqual((await fs.stat(replacementPath, { bigint: true })).ino, originalIdentity.ino);
  await assert.rejects(materializeExcalidrawCheckpoint({ workspace, state: replacementState }),
    error => (error as { code?: string }).code === 'EXCALIDRAW_CHECKPOINT_CREATE_OWNERSHIP');
  await prioritizeCreateReceipt(replacement.documentId);
  await recoverPendingExcalidrawCreates();
  const unchangedDb = await openDb();
  try {
    const receipt = await unchangedDb.get('SELECT status,file_ino FROM collaboration_excalidraw_creates WHERE document_id=$1', [replacement.documentId]) as { status: string; file_ino: string };
    assert.equal(receipt.status, 'preparing');
    assert.equal(receipt.file_ino, String(originalIdentity.ino), 'No-op checkpoints cannot confer create ownership on a matching-byte replacement.');
  } finally { await unchangedDb.close(); }
  assert.deepEqual(await fs.readFile(replacementPath), identicalBytes);

  // An actual second process commits to PostgreSQL while this process owns the listener.
  let deliveredSequence = -1;
  const listener = installExcalidrawSceneNotificationListener({ documentIds: () => [created.documentId],
    onScene: value => { deliveredSequence = value.sceneSequence; } });
  try {
    await listener.ready;
    await execFileAsync(process.execPath, ['--import', 'tsx', '--conditions', 'react-server',
      'scripts/excalidraw-checkpoint-durability-test.ts', '--publish-scene', created.documentId],
    { env: process.env, timeout: 15_000 });
    await waitUntil(() => deliveredSequence > recovered.sceneSequence);
  } finally { await listener.stop(); }
  await flushPendingExcalidrawCheckpoints({ workspaceId: workspace.workspaceId, paths: [created.path] });
  state = await loadExcalidrawScene(created.documentId);
  assert(state && state.checkpointRevisionId);
  const savedBytes = await fs.readFile(filePath);
  const savedRevisionId = state.checkpointRevisionId;
  const external = `${savedBytes.toString('utf8')}\n\n`;
  await fs.writeFile(filePath, external);
  await assert.rejects(flushPendingExcalidrawCheckpoints({ workspaceId: workspace.workspaceId,
    paths: [created.path], forceValidation: true }), AggregateError,
  'Equal-sequence downloads and backups must still detect external byte changes.');
  assert.equal(await fs.readFile(filePath, 'utf8'), external, 'External content cannot be overwritten silently.');
  const afterConflict = await getExcalidrawDocument({ workspace, documentId: created.documentId });
  assert.equal(afterConflict.checkpoint.status, 'failed');
  assert.equal(afterConflict.canonicalHash, state.canonicalHash, 'PostgreSQL remains authoritative after an external change.');
  assert.equal(afterConflict.checkpointRevisionId, savedRevisionId);
  const conflictDb = await openDb();
  try {
    const externalRevision = await conflictDb.get(`SELECT revision.id, revision.history_only FROM file_revisions revision
      JOIN file_revision_contents content ON content.revision_id = revision.id
      WHERE revision.lineage_id = $1 AND revision.content_hash = $2 AND content.source = 'external_import'`,
    [collaboration.lineageId, digest(external)]) as { id: string; history_only: boolean } | undefined;
    assert(externalRevision?.history_only, 'External bytes belong to historical recovery, never the current scene revision.');
    const externalHistory = await fileVersionContentStore.readRevisionContent({ workspaceId: workspace.workspaceId,
      lineageId: collaboration.lineageId, revisionId: externalRevision.id });
    assert.equal(externalHistory?.content.toString('utf8'), external);
    const latest = await readFileCollaborationState({ workspace, path: created.path });
    assert.equal(latest.latestRevision?.id, savedRevisionId);
    await conflictDb.run('UPDATE collaboration_excalidraw_states SET checkpoint_content_hash = NULL WHERE document_id = $1', [state.documentId]);
  } finally { await conflictDb.close(); }
  // Explicitly restore the trusted file bytes, then exercise the legacy revision-hash upgrade.
  await fs.writeFile(filePath, savedBytes);
  await materializeExcalidrawCheckpoint({ workspace, state: afterConflict });
  state = await loadExcalidrawScene(created.documentId);
  assert(state && !state.degradedReason && state.checkpointContentHash === digest(savedBytes));

  const stalePathState = state;
  const renamedPath = 'renamed-checkpoint.excalidraw';
  await withWorkspaceMutationLock(workspace.workspaceId, async () => {
    await fs.rename(filePath, path.join(workspace.rootPath, renamedPath));
    await moveFileCollaborationPath({ workspace, oldPath: created.path, newPath: renamedPath });
  });
  await materializeExcalidrawCheckpoint({ workspace, state: stalePathState });
  await assert.rejects(fs.access(filePath), { code: 'ENOENT' }, 'A stale checkpoint path cannot resurrect the renamed file.');
  const renamed = await loadExcalidrawScene(created.documentId);
  assert(renamed && renamed.path === renamedPath && renamed.documentId === created.documentId);
  await archiveFileCollaborationPaths({ workspace, paths: [renamedPath] });
  const archivedBytes = await fs.readFile(path.join(workspace.rootPath, renamedPath));
  await assert.rejects(materializeExcalidrawCheckpoint({ workspace, state: renamed }),
    error => (error as { status?: number }).status === 409);
  assert.deepEqual(await fs.readFile(path.join(workspace.rootPath, renamedPath)), archivedBytes,
    'An archived lifecycle rejects old checkpoint writers before publication.');
  console.log('Excalidraw checkpoint process-crash recovery, native notifications, assets, history, external conflicts and lifecycle fences verified.');
}

void (async () => { if (!await childMode()) await main(); })().finally(closeDatabaseConnections);
