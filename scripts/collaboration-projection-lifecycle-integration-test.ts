import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import * as Y from 'yjs';
import { closeDatabaseConnections, openDb } from '../app/lib/db';
import { ensureAgentGrantIntegrationFixture } from './agent-grant-integration-fixture';
import { createCollaborationSessionGrant, parseCollaborationSessionRequest } from '../app/lib/collaboration/session-service';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { changeCollaborationRepresentation, CollaborationStateInactiveError, CollaborationStateStaleError,
  loadCollaborationState, loadCollaborationStateIncludingArchived, persistCollaborationYDoc } from '../app/lib/collaboration/persistence';
import { installCollaborationRoomInspector } from '../app/lib/collaboration/runtime-state';
import { hasPendingCollaborationProjection, listPendingCollaborationProjections } from '../app/lib/collaboration/projection-repository';
import { archiveFileCollaborationPaths, restoreFileCollaborationPath } from '../app/lib/files/collaboration-policy';
import { renameWorkspacePath } from '../app/lib/files/rename-service';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';
import { trashWorkspacePaths, restoreWorkspaceTrashEntry } from '../app/lib/filesystem/workspace-trash';
import * as WorkspaceFiles from '../app/lib/filesystem/workspace-files';
import { resolveAgentExecutionContextForStoredSession } from '../app/lib/pi/session-workspace-context';
import type * as Checkpoint from '../app/lib/collaboration/checkpoint';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const databaseUrl = new URL(process.env.DATABASE_URL!);
  assert.match(databaseUrl.pathname, /^\/canvas_editor_test_\w+$/u);
  assert(['localhost', '127.0.0.1'].includes(databaseUrl.hostname));
  assert.equal(databaseUrl.port, '55433');
  const fixture = await ensureAgentGrantIntegrationFixture({ agentId: 'canvas-agent' });
  const { workspace, userId, execution } = fixture;
  const rooms = new Map<string, Y.Doc>();
  const allDocs: Y.Doc[] = [];
  const removeInspector = installCollaborationRoomInspector((id) => rooms.has(id) ? 1 : 0);
  let beforeWrite: (() => Promise<void>) | null = null;
  const writes: string[] = [];
  const filename = path.resolve('app/lib/collaboration/checkpoint.ts');
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const checkpoint = {} as typeof Checkpoint;
  new Function('require', 'module', 'exports', compiled.outputText)((name: string) => {
    if (name.endsWith('/filesystem/workspace-files')) return { ...WorkspaceFiles,
      writeFile: async (...args: Parameters<typeof WorkspaceFiles.writeFile>) => {
        const pending = beforeWrite; beforeWrite = null; await pending?.();
        writes.push(args[0]); return WorkspaceFiles.writeFile(...args);
      },
    };
    return load(name);
  }, { exports: checkpoint }, checkpoint);
  const file = (name: string) => fs.readFile(path.join(workspace.rootPath, name), 'utf8');
  const current = async (id: string) => { const value = await loadCollaborationState(id); assert(value); return value; };
  const create = async (name: string, content: string) => {
    await fs.writeFile(path.join(workspace.rootPath, name), content);
    const request = parseCollaborationSessionRequest({ path: name, representation: 'plain_text', ...COLLABORATION_CLIENT_CAPABILITIES });
    assert(request);
    const session = await createCollaborationSessionGrant({ workspace, fileOptions: { workspace }, request });
    const state = await current(session.documentId);
    const live = new Y.Doc(); Y.applyUpdate(live, state.yjsState); allDocs.push(live); rooms.set(state.documentId, live);
    return { state, live, id: state.documentId };
  };
  const trash = (name: string) => withWorkspaceMutationLock(workspace.workspaceId, async () => {
    const result = await trashWorkspacePaths({ workspace, paths: [name], deletedByUserId: userId });
    assert.deepEqual(result.failed, []); assert.equal(result.trashed.length, 1);
    await archiveFileCollaborationPaths({ workspace,
      paths: result.trashed.map((entry) => ({ path: entry.originalPath, trashEntryId: entry.id })) });
    return result.trashed[0];
  });
  const restore = (entryId: string) => withWorkspaceMutationLock(workspace.workspaceId, async () => {
    const entry = await restoreWorkspaceTrashEntry({ workspace, entryId, restoredByUserId: userId });
    await restoreFileCollaborationPath({ workspace, path: entry.originalPath, trashEntryId: entry.id });
  });
  let cases = 0;
  try {
    // This is the real persisted-session resolver; no authority result is mocked.
    const sessionRequest = { sessionId: execution.sessionId!, userId, agentId: 'canvas-agent', permissions: ['canWrite'] as const };
    assert.equal((await resolveAgentExecutionContextForStoredSession({ ...sessionRequest, permissions: ['canWrite'] })).workspaceId, workspace.workspaceId);
    const database = await openDb();
    try {
      await database.run('UPDATE pi_sessions SET archived_at = $3 WHERE session_id = $1 AND user_id = $2',
        [execution.sessionId, userId, Date.now()]);
      await assert.rejects(resolveAgentExecutionContextForStoredSession({ ...sessionRequest, permissions: ['canWrite'] }), /no longer available/);
      await database.run('UPDATE pi_sessions SET archived_at = NULL WHERE session_id = $1 AND user_id = $2', [execution.sessionId, userId]);
      assert.equal((await resolveAgentExecutionContextForStoredSession({ ...sessionRequest, permissions: ['canWrite'] })).workspaceId, workspace.workspaceId);
      cases++;
    } finally { await database.close(); }

    const source = await create('rename.md', 'Alpha\n\nBeta');
    source.live.getText('content').insert(0, 'Human ');
    const pending = await persistCollaborationYDoc(source.id, source.state.lifecycleGeneration, source.live);
    const entered = gate(); const release = gate();
    beforeWrite = async () => { entered.resolve(); await release.promise; };
    const projecting = checkpoint.materializeCollaborationCheckpoint({ state: pending, workspace });
    await entered.promise;
    // New durable Yjs deletion proceeds while the older file output is stalled.
    source.live.getText('content').delete(0, 6);
    const deleted = await persistCollaborationYDoc(source.id, pending.lifecycleGeneration, source.live);
    assert.deepEqual(deleted.stateVector, pending.stateVector);
    assert.equal(deleted.documentSequence, pending.documentSequence + 1);
    let renamed = false;
    const renaming = renameWorkspacePath({ workspace, oldPath: 'rename.md', newPath: 'renamed.md',
      overwrite: false, fileOptions: { workspace } }).then(() => { renamed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(renamed, false);
    release.resolve(); const projected = await projecting; await renaming;
    assert.equal(projected.state.checkpointSequence, pending.documentSequence);
    assert.equal(projected.state.documentSequence, deleted.documentSequence);
    assert.equal(await file('renamed.md'), 'Human Alpha\n\nBeta');
    assert.equal((await current(source.id)).path, 'renamed.md');
    assert.equal(checkpoint.authoritativeCollaborationSnapshot(await current(source.id)).canonicalContent, 'Alpha\n\nBeta');
    cases++;

    const replacement = await create('rename.md', 'Unrelated replacement');
    const writeCount = writes.length;
    await assert.rejects(checkpoint.materializeCollaborationCheckpoint({ state: deleted, workspace }), checkpoint.CollaborationCheckpointSupersededError);
    assert.equal(writes.length, writeCount, 'the old path is rejected before filesystem output');
    assert.equal(await file('rename.md'), 'Unrelated replacement');
    await checkpoint.materializeCollaborationCheckpoint({ state: await current(source.id), workspace });
    assert.equal(await file('renamed.md'), 'Alpha\n\nBeta');
    assert.equal(await file('rename.md'), 'Unrelated replacement');
    assert.notEqual(replacement.id, source.id); cases++;

    // Migration must observe room occupancy and take its content from Yjs.
    const latest = await current(source.id);
    const migrate = () => changeCollaborationRepresentation({ documentId: source.id,
      expectedLifecycleGeneration: latest.lifecycleGeneration, representation: 'tiptap_blocks', schemaVersion: 1 });
    await assert.rejects(migrate(), { code: 'room_active' });
    rooms.delete(source.id);
    const migrated = await migrate();
    assert.equal(migrated.lifecycleGeneration, latest.lifecycleGeneration + 1);
    assert.equal(checkpoint.authoritativeCollaborationSnapshot(migrated).canonicalContent, 'Alpha\n\nBeta');
    await assert.rejects(persistCollaborationYDoc(source.id, latest.lifecycleGeneration, source.live), CollaborationStateStaleError);
    await assert.rejects(checkpoint.materializeCollaborationCheckpoint({ state: latest, workspace }), checkpoint.CollaborationCheckpointSupersededError);
    const backupDb = await openDb();
    try {
      const backup = await backupDb.get('SELECT yjs_state FROM collaboration_yjs_state_backups WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1',
        [source.id]) as { yjs_state: Uint8Array };
      assert.deepEqual(Buffer.from(backup.yjs_state), Buffer.from(latest.yjsState));
    } finally { await backupDb.close(); }
    cases++;

    const original = await create('trash.txt', 'Original');
    original.live.getText('content').insert(8, ' projected');
    const beforeTrash = await persistCollaborationYDoc(original.id, original.state.lifecycleGeneration, original.live);
    const trashEntered = gate(); const trashRelease = gate();
    beforeWrite = async () => { trashEntered.resolve(); await trashRelease.promise; };
    const trashProjection = checkpoint.materializeCollaborationCheckpoint({ state: beforeTrash, workspace });
    await trashEntered.promise;
    original.live.getText('content').insert(original.live.getText('content').length, ' latest');
    const latestBeforeTrash = await persistCollaborationYDoc(original.id, beforeTrash.lifecycleGeneration, original.live);
    let trashed = false;
    const trashing = trash('trash.txt').then((entry) => { trashed = true; return entry; });
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(trashed, false);
    trashRelease.resolve(); await trashProjection; const entry = await trashing;
    const archived = await loadCollaborationStateIncludingArchived(original.id); assert(archived);
    assert.equal(archived.status, 'archived'); assert.equal(archived.lifecycleGeneration, beforeTrash.lifecycleGeneration + 1);
    assert.deepEqual(archived.yjsState, latestBeforeTrash.yjsState);
    await assert.rejects(file('trash.txt'), { code: 'ENOENT' });
    await assert.rejects(persistCollaborationYDoc(original.id, beforeTrash.lifecycleGeneration, original.live), CollaborationStateInactiveError);
    await assert.rejects(checkpoint.materializeCollaborationCheckpoint({ state: beforeTrash, workspace }), checkpoint.CollaborationCheckpointSupersededError);
    assert(!(await listPendingCollaborationProjections()).some((item) => item.documentId === original.id));
    cases++;

    const reused = await create('trash.txt', 'Replacement survives');
    await assert.rejects(checkpoint.materializeCollaborationCheckpoint({ state: latestBeforeTrash, workspace }), checkpoint.CollaborationCheckpointSupersededError);
    assert.equal(await file('trash.txt'), 'Replacement survives');
    const replacementEntry = await trash('trash.txt'); assert.notEqual(replacementEntry.id, entry.id);
    await restore(entry.id);
    const restored = await current(original.id);
    assert.equal(restored.lifecycleGeneration, beforeTrash.lifecycleGeneration + 2);
    assert.deepEqual(restored.yjsState, latestBeforeTrash.yjsState, 'restore retains the latest binary state, even when trash held an older Markdown projection');
    assert.equal(checkpoint.authoritativeCollaborationSnapshot(restored).canonicalContent, 'Original projected latest');
    assert.equal(await file('trash.txt'), 'Original projected', 'the older trash file is only a recoverable projection');
    assert.equal((await loadCollaborationStateIncludingArchived(reused.id))?.status, 'archived');
    assert(await hasPendingCollaborationProjection(restored));
    assert((await listPendingCollaborationProjections()).some((item) => item.documentId === original.id && item.lifecycleGeneration === restored.lifecycleGeneration));
    await assert.rejects(persistCollaborationYDoc(original.id, beforeTrash.lifecycleGeneration, original.live), CollaborationStateStaleError);
    const beforeOldCallback = writes.length;
    await assert.rejects(checkpoint.materializeCollaborationCheckpoint({ state: latestBeforeTrash, workspace }), checkpoint.CollaborationCheckpointSupersededError);
    assert.equal(writes.length, beforeOldCallback);
    await checkpoint.materializeCollaborationCheckpoint({ state: restored, workspace });
    assert.equal(await file('trash.txt'), 'Original projected latest');
    assert.equal(await hasPendingCollaborationProjection(await current(original.id)), false);
    cases++;
    console.log(`Postgres projection lifecycle: ${cases} scenarios passed; real filesystem/SQL fences, latest Yjs through rename/trash/restore/migration, archived-session authority.`);
  } finally {
    removeInspector(); for (const doc of allDocs) doc.destroy(); await closeDatabaseConnections();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
