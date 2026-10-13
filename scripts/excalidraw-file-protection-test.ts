import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { openDb, closeDatabaseConnections } from '@/app/lib/db';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { createExcalidrawDocument, applyExcalidrawChanges, getExcalidrawDocument } from '@/app/lib/excalidraw-collaboration/scene-service';
import { importExcalidrawDocumentFile } from '@/app/lib/excalidraw-collaboration/portable-import';
import { withExcalidrawPublication, withExcalidrawImportPublication } from '@/app/lib/excalidraw-collaboration/publication-context';
import { writeFile, writeFileIfAbsent, writeWorkspaceFileFromPathIfAbsent,
  replaceWorkspaceFileFromPath, copyFile, copyFileBetweenWorkspaces,
  type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import { runWorkspaceUploadWrite } from '@/app/lib/files/workspace-upload-flow';
import { runWithAgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { workspaceToAgentExecutionContext } from '@/app/lib/pi/session-workspace-context';
import { writeAgentTextFile, writeAgentBinaryFile, editAgentFile, applyAgentFilePatch,
  restoreAgentFileSnapshot, copyAgentPaths, moveAgentPaths, type AgentFileSnapshotMetadata } from '@/app/lib/pi/agent-file-operations';
import { WorkspaceOperationBatchStore } from '@/app/lib/files/workspace-operation-batch-store';
import { createWorkspaceOperationBatchWorker } from '@/app/lib/files/workspace-operation-batch-worker';
import { readDocumentReviewAvailability } from '@/app/lib/document-review-availability';
import { resolveAgentRuntimeTempDir } from '@/app/lib/pi/agent-runtime-temp';
import { executeAgentSandboxedCommand } from '@/app/lib/pi/agent-shell-sandbox';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/contracts';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const suffix = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const userId = `excal-protection-user-${suffix}`;
const organizationId = `excal-protection-org-${suffix}`;
const actor = { userId, actorId: DEFAULT_MANAGED_AGENT_ID, actorType: 'agent' as const };
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const portable = JSON.stringify({ type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} });
const sceneError = (error: unknown) => {
  assert.equal((error as { code?: string }).code, 'EXCALIDRAW_SCENE_SERVICE_REQUIRED');
  assert.equal((error as { status?: number }).status, 409);
  return true;
};
const aliasError = (error: unknown) => { assert.equal((error as { code?: string }).code, 'WORKSPACE_PATH_ALIAS'); return true; };

async function sql(query: string, params: unknown[] = []) {
  const connection = await openDb();
  try { return await connection.all(query, params); }
  finally { await connection.close(); }
}

function workspace(type: 'personal' | 'team'): WorkspaceContext {
  const rootRelativePath = `workspaces/excal-file-protection/${suffix}/${type}/files`;
  return { workspaceId: `excal-protection-${type}-${suffix}`, workspaceType: type, organizationId,
    rootRelativePath, rootPath: workspaceAbsoluteRoot(rootRelativePath), status: 'active', legacy: false,
    ownerUserId: type === 'personal' ? userId : null, displayName: `Excalidraw protection ${type}`,
    permissions: { canRead: true, canWrite: true, canDelete: true, canManageWorkspace: true,
      canRunAgent: true, canCreatePublicLinks: false } };
}

async function seed(workspaces: WorkspaceContext[]) {
  await sql(`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
    VALUES ($1,'Excalidraw protection test',$2,1,1,1)`, [userId, `${userId}@scene.test`]);
  await sql(`INSERT INTO canvas_organization_settings
    (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
    VALUES ($1,$2,'team',1,1,1)`, [organizationId, userId]);
  await sql(`INSERT INTO organization_user_permissions
    (organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
    VALUES ($1,$2,'member','active',1,1,1)`, [organizationId, userId]);
  for (const current of workspaces) {
    await fs.mkdir(current.rootPath, { recursive: true });
    await sql(`INSERT INTO canvas_workspaces
      (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,'active',1,1)`, [current.workspaceId, organizationId,
      current.workspaceType, current.ownerUserId, current.rootRelativePath, current.displayName]);
    if (current.workspaceType === 'team') await sql(`INSERT INTO canvas_workspace_members
      (organization_id,workspace_id,user_id,role,status,can_read,can_write,can_manage,created_at,updated_at)
      VALUES ($1,$2,$3,'member','active',1,1,1,1,1)`, [organizationId, current.workspaceId, userId]);
  }
}

async function rejectedWholeFiles(current: WorkspaceContext) {
  const options = { workspace: current, mutationActorUserId: userId };
  const created = await createExcalidrawDocument({ workspace: current, actor, path: 'closed.excalidraw', idempotencyKey: `closed-${suffix}` });
  const before = await fs.readFile(path.join(current.rootPath, created.path));
  const staged = path.join(current.rootPath, 'upload-staging.json');
  await fs.writeFile(staged, portable);
  for (const action of [
    () => writeFile(created.path, portable, options),
    () => replaceWorkspaceFileFromPath(staged, created.path, options),
    () => writeFile('new.excalidraw', portable, options),
    () => writeFile('new.EXCALIDRAW', portable, options),
    () => writeFileIfAbsent('absent.excalidraw', portable, options),
    () => writeWorkspaceFileFromPathIfAbsent(staged, 'upload.excalidraw', options),
    () => writeFile(created.path, portable, { ...options, excalidrawPublication: true } as WorkspaceFileOperationOptions),
  ]) await assert.rejects(action(), sceneError);
  await assert.rejects(withExcalidrawImportPublication(current.workspaceId, 'import-only.excalidraw', () =>
    writeFile('import-only.excalidraw', portable, options)), sceneError);
  await assert.rejects(withExcalidrawPublication(current.workspaceId, 'different.excalidraw', () =>
    writeFile(created.path, portable, options)), sceneError);
  await fs.symlink(path.join(current.rootPath, created.path), path.join(current.rootPath, 'alias.txt'));
  await assert.rejects(writeFile('alias.txt', portable, options), aliasError);
  await fs.mkdir(path.join(current.rootPath, 'nested'));
  await fs.symlink(current.rootPath, path.join(current.rootPath, 'nested', 'directory-link'));
  await assert.rejects(writeFile('nested/directory-link/closed.excalidraw', portable, options), aliasError);
  await assert.rejects(withExcalidrawPublication(current.workspaceId, created.path, () =>
    writeFile('CLOSED.excalidraw', portable, options)), error => {
    assert.ok(['WORKSPACE_PATH_ALIAS', 'EXCALIDRAW_SCENE_SERVICE_REQUIRED'].includes((error as { code: string }).code));
    return true;
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let detached!: Promise<void>;
  await withExcalidrawPublication(current.workspaceId, 'expired.excalidraw', async () => {
    detached = gate.then(() => writeFileIfAbsent('expired.excalidraw', portable, options));
  });
  release();
  await assert.rejects(detached, sceneError);
  await assert.rejects(fs.stat(path.join(current.rootPath, 'expired.excalidraw')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(current.rootPath, created.path)), before);
  assert.equal((await getExcalidrawDocument({ workspace: current, documentId: created.documentId })).canonicalHash, created.canonicalHash);

  const context = workspaceToAgentExecutionContext({ workspace: current, userId,
    sessionId: `excal-file-guard-session-${current.workspaceType}-${suffix}`, agentId: DEFAULT_MANAGED_AGENT_ID });
  await fs.writeFile(path.join(current.rootPath, 'ordinary.json'), '{"value":1}');
  await fs.link(path.join(current.rootPath, created.path), path.join(current.rootPath, 'hardlink.txt'));
  await runWithAgentExecutionContext(context, async () => {
    for (const action of [
      () => writeAgentTextFile({ path: 'new-agent.excalidraw', content: portable }),
      () => writeAgentTextFile({ path: 'new-agent.EXCALIDRAW', content: portable }),
      () => writeAgentTextFile({ path: created.path, content: portable, expectedSha256: hash(before) }),
      () => writeAgentBinaryFile({ path: 'agent-binary.excalidraw', content: Buffer.from(portable) }),
      () => editAgentFile({ path: created.path, oldText: 'excalidraw', newText: 'damaged', expectedSha256: hash(before) }),
      () => applyAgentFilePatch({ files: [
        { path: 'ordinary.json', expectedSha256: hash('{"value":1}'), edits: [{ oldText: '1', newText: '2' }] },
        { path: created.path, expectedSha256: hash(before), edits: [{ oldText: 'excalidraw', newText: 'damaged' }] },
      ] }),
      () => writeAgentTextFile({ path: 'alias.txt', content: portable, expectedSha256: hash(before) }),
    ]) await assert.rejects(action(), sceneError);
    await assert.rejects(writeAgentTextFile({ path: 'hardlink.txt', content: portable, expectedSha256: hash(before) }), aliasError);
    const snapshotId = `excal-legacy-snapshot-${current.workspaceType}-${suffix}`;
    const snapshotRoot = path.join(process.env.DATA!, 'cache', 'agent-file-snapshots');
    await fs.mkdir(snapshotRoot, { recursive: true });
    const metadata: AgentFileSnapshotMetadata = { version: 1, id: snapshotId, path: created.path,
      resolvedPath: path.join(current.rootPath, created.path), existed: true, size: before.length,
      sha256: hash(before), operation: 'write', createdAt: new Date().toISOString() };
    try {
      await fs.writeFile(path.join(snapshotRoot, `${snapshotId}.json`), JSON.stringify(metadata));
      await fs.writeFile(path.join(snapshotRoot, `${snapshotId}.bin`), 'legacy whole-file replacement');
      await assert.rejects(restoreAgentFileSnapshot({ snapshotId }), sceneError);
      await fs.writeFile(path.join(snapshotRoot, `${snapshotId}.json`), JSON.stringify({ ...metadata, existed: false }));
      await assert.rejects(restoreAgentFileSnapshot({ snapshotId }), sceneError);
    } finally {
      await fs.rm(path.join(snapshotRoot, `${snapshotId}.json`), { force: true });
      await fs.rm(path.join(snapshotRoot, `${snapshotId}.bin`), { force: true });
    }
  });
  await fs.rm(path.join(current.rootPath, 'hardlink.txt'));
  assert.equal(await fs.readFile(path.join(current.rootPath, 'ordinary.json'), 'utf8'), '{"value":1}');
  assert.deepEqual(await fs.readFile(path.join(current.rootPath, created.path)), before);
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    for (const command of [
      'printf damaged >closed.excalidraw', 'printf damaged >os-new.excalidraw',
      `/usr/bin/python3 -c ${quote("from pathlib import Path; Path('closed.excalidraw').write_text('damaged')")}`,
      `/usr/bin/python3 -c ${quote("from pathlib import Path; Path('os-new.excalidraw').write_text('damaged')")}`,
      `${quote(process.execPath)} -e ${quote("require('fs').writeFileSync('closed.excalidraw','damaged')")}`,
      `${quote(process.execPath)} -e ${quote("require('fs').writeFileSync('os-new.excalidraw','damaged')")}`,
    ]) await assert.rejects(executeAgentSandboxedCommand(command, { context,
      env: { NODE_ENV: 'test', PATH: process.env.PATH, LANG: 'en_US.UTF-8' } }));
    assert.deepEqual(await fs.readFile(path.join(current.rootPath, created.path)), before);
    await assert.rejects(fs.stat(path.join(current.rootPath, 'os-new.excalidraw')), { code: 'ENOENT' });
  }
}

async function controlledCopies(current: WorkspaceContext, target: WorkspaceContext) {
  const options = { workspace: current, mutationActorUserId: userId };
  for (const dir of ['source', 'target', 'copied', 'invalid-source', 'mixed-source']) await fs.mkdir(path.join(current.rootPath, dir));
  const source = await createExcalidrawDocument({ workspace: current, actor, path: 'source/diagram.excalidraw', idempotencyKey: `copy-source-${suffix}` });
  const changed = await applyExcalidrawChanges({ workspace: current, actor, documentId: source.documentId,
    lifecycleGeneration: source.lifecycleGeneration, observedSceneSequence: 0, idempotencyKey: `copy-element-${suffix}`,
    actions: [{ type: 'create', element: { id: 'copy-target', type: 'rectangle', version: 1, versionNonce: 99,
      isDeleted: false, x: 12, y: 0, width: 80, height: 80, angle: 0, index: 'a0', opacity: 100, groupIds: [], boundElements: [] } }] });
  assert.equal(changed.status, 'applied');
  const existing = await createExcalidrawDocument({ workspace: current, actor, path: 'target/diagram.excalidraw', idempotencyKey: `copy-existing-${suffix}` });
  const existingBytes = await fs.readFile(path.join(current.rootPath, existing.path));
  await assert.rejects(copyFile(source.path, 'target', true, false, options), sceneError);
  assert.deepEqual(await fs.readFile(path.join(current.rootPath, existing.path)), existingBytes);
  await fs.rm(path.join(current.rootPath, existing.path));
  await assert.rejects(copyFile(source.path, 'target', true, false, options), sceneError);
  await assert.rejects(fs.stat(path.join(current.rootPath, existing.path)), { code: 'ENOENT' });
  assert.equal((await getExcalidrawDocument({ workspace: current, documentId: existing.documentId })).documentId, existing.documentId);
  const copied = await copyFile(source.path, 'copied', true, false, options);
  const state = await getExcalidrawDocument({ workspace: current, path: copied.copied });
  assert.notEqual(state.documentId, source.documentId);
  const sourceState = await getExcalidrawDocument({ workspace: current, documentId: source.documentId });
  assert.equal(state.canonicalHash, sourceState.canonicalHash);
  await fs.writeFile(path.join(current.rootPath, source.path), 'external changed checkpoint bytes');
  const cross = await copyFileBetweenWorkspaces(source.path, '.', false, false,
    { source: options, target: { workspace: target, mutationActorUserId: userId } });
  const crossState = await getExcalidrawDocument({ workspace: target, path: cross.copied });
  assert.notEqual(crossState.documentId, source.documentId);
  assert.equal(crossState.canonicalHash, sourceState.canonicalHash, 'Copy must serialize the PostgreSQL scene rather than the foreign checkpoint.');
  assert.equal(await fs.readFile(path.join(current.rootPath, source.path), 'utf8'), 'external changed checkpoint bytes');
  await fs.writeFile(path.join(current.rootPath, 'invalid-source', 'invalid.excalidraw'), '{broken');
  await fs.writeFile(path.join(current.rootPath, 'invalid-source', 'ordinary.json'), '{"value":1}');
  await assert.rejects(copyFile('invalid-source', 'copied', false, false, options));
  await assert.rejects(fs.stat(path.join(current.rootPath, 'copied', 'invalid-source')), { code: 'ENOENT' });
  await importExcalidrawDocumentFile({ workspace: current, actor, path: 'mixed-source/mixed.excalidraw', content: portable });
  await fs.writeFile(path.join(current.rootPath, 'mixed-source', 'ordinary.json'), '{"value":1}');
  const directory = await copyFile('mixed-source', 'copied', false, false, options);
  assert.equal(await fs.readFile(path.join(current.rootPath, directory.copied, 'ordinary.json'), 'utf8'), '{"value":1}');
  const directoryScene = await getExcalidrawDocument({ workspace: current, path: `${directory.copied}/mixed.excalidraw` });
  assert.equal(directoryScene.status, 'active');
}

async function uploads(current: WorkspaceContext) {
  const options = { workspace: current, mutationActorUserId: userId };
  let rawWrites = 0;
  const request = { workspace: current, fileOptions: options, actorUserId: userId, targetPath: 'uploaded.excalidraw',
    content: Buffer.from(portable), write: async () => { rawWrites += 1; throw new Error('Raw upload callback must not execute.'); } };
  await runWorkspaceUploadWrite(request);
  assert.equal(rawWrites, 0);
  const scene = await getExcalidrawDocument({ workspace: current, path: request.targetPath });
  const before = await fs.readFile(path.join(current.rootPath, request.targetPath));
  await assert.rejects(runWorkspaceUploadWrite(request), error => { assert.equal((error as { code: string }).code, 'PATH_EXISTS'); return true; });
  assert.deepEqual(await fs.readFile(path.join(current.rootPath, request.targetPath)), before);
  await fs.rm(path.join(current.rootPath, request.targetPath));
  await assert.rejects(runWorkspaceUploadWrite(request), error => { assert.equal((error as { code: string }).code, 'PATH_EXISTS'); return true; });
  assert.equal((await getExcalidrawDocument({ workspace: current, documentId: scene.documentId })).documentId, scene.documentId);
  await assert.rejects(fs.stat(path.join(current.rootPath, request.targetPath)), { code: 'ENOENT' });
  await fs.writeFile(path.join(current.rootPath, 'foreign.excalidraw'), portable);
  await assert.rejects(importExcalidrawDocumentFile({ workspace: current, actor, path: 'foreign.excalidraw', content: portable }),
    error => { assert.equal((error as { code: string }).code, 'PATH_EXISTS'); return true; });
  await assert.rejects(importExcalidrawDocumentFile({ workspace: current, actor, path: 'invalid-upload.excalidraw', content: '{broken' }));
  await assert.rejects(fs.stat(path.join(current.rootPath, 'invalid-upload.excalidraw')), { code: 'ENOENT' });
}

async function agentLifecycle(current: WorkspaceContext) {
  assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false,
    'The isolated native fixture uses the existing direct lifecycle worker policy.');
  for (const dir of ['agent-source', 'agent-copy', 'agent-move']) await fs.mkdir(path.join(current.rootPath, dir));
  const created = await createExcalidrawDocument({ workspace: current, actor, path: 'agent-source/diagram.excalidraw',
    idempotencyKey: `agent-lifecycle-${suffix}` });
  const sessionId = `excal-file-lifecycle-${suffix}`;
  await sql(`INSERT INTO pi_sessions
    (session_id,user_id,agent_id,workspace_id,workspace_type,organization_id,workspace_root_relative_path,provider,model,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'fixture','fixture',1,1)`, [sessionId, userId,
    DEFAULT_MANAGED_AGENT_ID, current.workspaceId, current.workspaceType, organizationId, current.rootRelativePath]);
  const context = workspaceToAgentExecutionContext({ workspace: current, userId, sessionId, agentId: DEFAULT_MANAGED_AGENT_ID });
  const tempRoot = resolveAgentRuntimeTempDir(context);
  try {
    await runWithAgentExecutionContext(context, async () => {
      const copied = await copyAgentPaths({ sourcePaths: [created.path], destinationPath: 'agent-copy/diagram.excalidraw' });
      assert.equal(copied.verified, true, JSON.stringify(copied));
      const copy = await getExcalidrawDocument({ workspace: current, path: 'agent-copy/diagram.excalidraw' });
      assert.notEqual(copy.documentId, created.documentId);
      const moveInput = { sourcePaths: [copy.path], destinationPath: 'agent-move/renamed.excalidraw', idempotencyKey: `agent-move-${suffix}` };
      const submitted = await moveAgentPaths(moveInput);
      assert.ok(submitted.fileOperation?.batchId, JSON.stringify(submitted));
      if (submitted.fileOperation.status === 'queued') {
        const batchId = submitted.fileOperation.batchId;
        // Claim only this fixture's job. Other tests' durable work is never consumed.
        class FixtureBatchStore extends WorkspaceOperationBatchStore {
          override async claim(owner: string) {
            const now = Date.now();
            const claimed = await sql(`UPDATE workspace_file_operation_batches SET status='applying',
              lease_owner=$2,lease_expires_at=$3,updated_at=$4
              WHERE batch_id=$1 AND workspace_id=$5 AND status='queued' RETURNING batch_id`,
            [batchId, owner, now + 90_000, now, current.workspaceId]);
            return claimed.length ? this.get(batchId) : null;
          }
        }
        assert.equal(await createWorkspaceOperationBatchWorker({ store: new FixtureBatchStore() }).tick(), true);
      }
      const moved = await moveAgentPaths(moveInput);
      assert.equal(moved.fileOperation?.status, 'applied', JSON.stringify(moved));
      assert.equal(moved.verified, true, JSON.stringify(moved));
      const renamed = await getExcalidrawDocument({ workspace: current, documentId: copy.documentId });
      assert.equal(renamed.path, moveInput.destinationPath);
      assert.equal(renamed.documentId, copy.documentId);
      // Explicit copy-and-rename cannot use the common copy service and must fail closed.
      await assert.rejects(copyAgentPaths({ sourcePaths: [created.path], destinationPath: 'agent-copy/raw-renamed.excalidraw' }), sceneError);
      await assert.rejects(fs.stat(path.join(current.rootPath, 'agent-copy/raw-renamed.excalidraw')), { code: 'ENOENT' });
      await fs.mkdir(path.join(tempRoot, 'portable-dir'), { recursive: true });
      await fs.writeFile(path.join(tempRoot, 'portable-dir', 'nested.EXCALIDRAW'), portable);
      await assert.rejects(copyAgentPaths({ sourcePaths: [path.join(tempRoot, 'portable-dir')], destinationPath: 'raw-temp-copy', recursive: true }), sceneError);
      await assert.rejects(moveAgentPaths({ sourcePaths: [path.join(tempRoot, 'portable-dir')], destinationPath: 'raw-temp-move' }), sceneError);
      await assert.rejects(fs.stat(path.join(current.rootPath, 'raw-temp-copy')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(current.rootPath, 'raw-temp-move')), { code: 'ENOENT' });
    });
  } finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
}

async function missingCheckpointSnapshotAlias(current: WorkspaceContext) {
  const scene = await createExcalidrawDocument({ workspace: current, actor, path: 'missing-snapshot.excalidraw',
    idempotencyKey: `missing-snapshot-${suffix}` });
  const absoluteScene = path.join(current.rootPath, scene.path);
  await fs.rm(absoluteScene);
  const alias = 'dangling-scene.txt';
  await fs.symlink(absoluteScene, path.join(current.rootPath, alias));
  await fs.symlink(alias, path.join(current.rootPath, 'dangling-chain.txt'));
  const context = workspaceToAgentExecutionContext({ workspace: current, userId,
    sessionId: `missing-snapshot-${suffix}`, agentId: DEFAULT_MANAGED_AGENT_ID });
  const snapshotRoot = path.join(process.env.DATA!, 'cache', 'agent-file-snapshots');
  await fs.mkdir(snapshotRoot, { recursive: true });
  await runWithAgentExecutionContext(context, async () => {
    for (const aliasPath of [alias, 'dangling-chain.txt']) {
      const snapshotId = `dangling-snapshot-${aliasPath}-${suffix}`;
      const metadata: AgentFileSnapshotMetadata = { version: 1, id: snapshotId, path: aliasPath,
        resolvedPath: path.join(current.rootPath, aliasPath), existed: true, size: portable.length,
        sha256: hash(portable), operation: 'write', createdAt: new Date().toISOString() };
      try {
        await fs.writeFile(path.join(snapshotRoot, `${snapshotId}.json`), JSON.stringify(metadata));
        await fs.writeFile(path.join(snapshotRoot, `${snapshotId}.bin`), portable);
        await assert.rejects(restoreAgentFileSnapshot({ snapshotId }), sceneError);
      } finally {
        await fs.rm(path.join(snapshotRoot, `${snapshotId}.json`), { force: true });
        await fs.rm(path.join(snapshotRoot, `${snapshotId}.bin`), { force: true });
      }
    }
  });
  await assert.rejects(fs.stat(absoluteScene), { code: 'ENOENT' });
  assert.equal((await getExcalidrawDocument({ workspace: current, documentId: scene.documentId })).canonicalHash, scene.canonicalHash);
}

async function externalCopyCollision(current: WorkspaceContext) {
  await fs.mkdir(path.join(current.rootPath, 'external-copy-target'));
  const source = await createExcalidrawDocument({ workspace: current, actor, path: 'external-copy-source.excalidraw',
    idempotencyKey: `external-copy-${suffix}` });
  const target = path.join(await fs.realpath(current.rootPath), 'external-copy-target', path.basename(source.path));
  const foreign = Buffer.from('foreign bytes created during copy publication');
  const originalLink = fs.link;
  let intervened = false;
  fs.link = async (from, to) => {
    const canonicalTarget = path.join(await fs.realpath(path.dirname(String(to))), path.basename(String(to)));
    if (canonicalTarget === target && String(from).includes('.canvas-create-')) {
      await fs.writeFile(target, foreign, { flag: 'wx' });
      intervened = true;
    }
    return originalLink(from, to);
  };
  try {
    await assert.rejects(copyFile(source.path, 'external-copy-target', false, false,
      { workspace: current, mutationActorUserId: userId }), error => {
      assert.equal((error as { code: string }).code, 'PATH_EXISTS'); return true;
    });
  } finally { fs.link = originalLink; }
  assert.equal(intervened, true, 'Inject the collision at the actual exclusive publication syscall.');
  assert.deepEqual(await fs.readFile(target), foreign, 'Copy rollback must preserve an independently created destination inode.');
  assert.equal((await sql(`SELECT id FROM collaboration_documents WHERE workspace_id=$1 AND path=$2 AND status='active'`,
    [current.workspaceId, `external-copy-target/${path.basename(source.path)}`])).length, 0, 'The foreign occupant must not be adopted.');

  await fs.mkdir(path.join(current.rootPath, 'external-dir-source'));
  await importExcalidrawDocumentFile({ workspace: current, actor, path: 'external-dir-source/nested.excalidraw', content: portable });
  await fs.writeFile(path.join(current.rootPath, 'external-dir-source/ordinary.json'), '{"owned":true}');
  const directoryTarget = path.join(await fs.realpath(current.rootPath), 'external-copy-target/external-dir-source/nested.excalidraw');
  fs.link = async (from, to) => {
    const canonicalTarget = path.join(await fs.realpath(path.dirname(String(to))), path.basename(String(to)));
    if (canonicalTarget === directoryTarget && String(from).includes('.canvas-create-')) await fs.writeFile(directoryTarget, foreign, { flag: 'wx' });
    return originalLink(from, to);
  };
  try {
    await assert.rejects(copyFile('external-dir-source', 'external-copy-target', false, false,
      { workspace: current, mutationActorUserId: userId }), error => {
      assert.equal((error as { code: string }).code, 'PATH_EXISTS'); return true;
    });
  } finally { fs.link = originalLink; }
  assert.deepEqual(await fs.readFile(directoryTarget), foreign, 'Directory rollback must retain an unowned portable scene.');

  await fs.mkdir(path.join(current.rootPath, 'root-race-source'));
  await importExcalidrawDocumentFile({ workspace: current, actor, path: 'root-race-source/nested.excalidraw', content: portable });
  const racedDirectory = path.join(await fs.realpath(current.rootPath), 'external-copy-target/root-race-source');
  const originalMkdir = fs.mkdir;
  fs.mkdir = (async (...args: Parameters<typeof fs.mkdir>) => {
    if (path.resolve(String(args[0])) === racedDirectory && args[1] === undefined) {
      await originalMkdir(racedDirectory);
      await fs.writeFile(path.join(racedDirectory, 'foreign.excalidraw'), foreign, { flag: 'wx' });
    }
    return originalMkdir(...args);
  }) as typeof fs.mkdir;
  try {
    await assert.rejects(copyFile('root-race-source', 'external-copy-target', false, false,
      { workspace: current, mutationActorUserId: userId }), { code: 'EEXIST' });
  } finally { fs.mkdir = originalMkdir; }
  assert.deepEqual(await fs.readFile(path.join(racedDirectory, 'foreign.excalidraw')), foreign,
    'Directory creation must be exclusive and preserve a concurrent destination tree.');
}

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  // Uses the pre-migrated isolated native database; never runs schema changes.
  const workspaces = [workspace('personal'), workspace('team')];
  try {
    await seed(workspaces);
    for (const current of workspaces) { await rejectedWholeFiles(current); await uploads(current); }
    await controlledCopies(workspaces[0], workspaces[1]);
    await missingCheckpointSnapshotAlias(workspaces[0]);
    await externalCopyCollision(workspaces[0]);
    await agentLifecycle(workspaces[0]);
    console.log(JSON.stringify({ success: true, workspaces: ['personal', 'team'], centralWritesDenied: true,
      agentCreateEditPatchSnapshotDenied: true, noPartialPatch: true, publicationScopeAndExpiry: true,
      createOnlyImports: true, aliasAndExtensionCase: true, closedAndMissingCheckpointProtected: true,
      copyHasDistinctIdentity: true, copyUsesAuthoritativeScene: true, invalidDirectoryCopyNoMutation: true,
      agentLifecyclePreservesIdentity: true, agentRawFallbackDenied: true,
      missingCheckpointSnapshotAliasesDenied: true, externalCopyCollisionsPreserved: true,
      nativeOsSandbox: process.platform, shellPythonNodeWritesDenied: true }));
  } finally {
    for (const current of workspaces) {
      await sql("UPDATE canvas_workspaces SET status='archived' WHERE id=$1", [current.workspaceId]).catch(() => undefined);
      await fs.rm(current.rootPath, { recursive: true, force: true });
    }
  }
}

void main().finally(closeDatabaseConnections);
