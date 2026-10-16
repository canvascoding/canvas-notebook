import assert from 'node:assert/strict';
import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'canvas-workspace-upload-'));
process.env.DATA = dataRoot;

async function main(): Promise<void> {
  const limits = await import('../app/lib/files/upload-limits');
  const service = await import('../app/lib/files/workspace-upload-service');
  const workspaceFiles = await import('../app/lib/filesystem/workspace-files');
  const workspaceRoot = path.join(dataRoot, 'workspace');
  const workspace = {
    workspaceId: 'workspace-upload-test',
    workspaceType: 'personal' as const,
    rootPath: workspaceRoot,
    permissions: {
      canRead: true,
      canWrite: true,
      canDelete: true,
      canCreatePublicLinks: true,
      canManageWorkspace: true,
      canRunAgent: true,
    },
    legacy: false,
  };
  await fs.mkdir(workspaceRoot, { recursive: true });

  assert.equal(limits.WORKSPACE_UPLOAD_MAX_FILES, 1_000);
  assert.equal(limits.WORKSPACE_UPLOAD_MAX_FILE_BYTES, 5 * 1024 * 1024 * 1024);
  assert.equal(limits.WORKSPACE_UPLOAD_MAX_TOTAL_BYTES, 20 * 1024 * 1024 * 1024);
  assert.ok(limits.WORKSPACE_UPLOAD_CHUNK_SIZE < 256 * 1024 * 1024);

  await assert.rejects(
    () => service.createWorkspaceUploadSession({
      userId: 'user-1',
      workspace,
      targetDir: '.',
      files: Array.from({ length: limits.WORKSPACE_UPLOAD_MAX_FILES + 1 }, (_, index) => ({
        path: `file-${index}.txt`,
        size: 1,
      })),
    }),
    (error: unknown) => Boolean(
      error instanceof service.WorkspaceUploadServiceError
      && error.code === 'UPLOAD_TOO_MANY_FILES'
      && error.status === 400
    ),
  );

  await assert.rejects(
    () => service.createWorkspaceUploadSession({
      userId: 'user-1',
      workspace,
      targetDir: '.',
      files: [{ path: 'large-video.mp4', size: limits.WORKSPACE_UPLOAD_MAX_FILE_BYTES + 1 }],
    }),
    (error: unknown) => Boolean(
      error instanceof service.WorkspaceUploadServiceError
      && error.code === 'UPLOAD_FILE_TOO_LARGE'
      && error.status === 413
    ),
  );

  await assert.rejects(
    () => service.createWorkspaceUploadSession({
      userId: 'user-1',
      workspace,
      targetDir: '.',
      files: [
        { path: 'same?.txt', size: 1 },
        { path: 'same_.txt', size: 1 },
      ],
    }),
    (error: unknown) => Boolean(
      error instanceof service.WorkspaceUploadServiceError
      && error.code === 'UPLOAD_DUPLICATE_PATH'
      && error.status === 409
    ),
  );

  const content = Buffer.from('hello world');
  const upload = await service.createWorkspaceUploadSession({
    userId: 'user-1',
    workspace,
    targetDir: 'folder',
    files: [{ path: 'nested/test?.txt', size: content.length, mimeType: 'text/plain' }],
  });
  const file = upload.files[0];
  assert.equal(file.targetPath, 'folder/nested/test_.txt');

  await assert.rejects(
    () => service.getWorkspaceUploadSession({
      sessionId: upload.id,
      userId: 'different-user',
      workspace,
    }),
    (error: unknown) => Boolean(
      error instanceof service.WorkspaceUploadServiceError
      && error.code === 'UPLOAD_FORBIDDEN'
      && error.status === 403
    ),
  );

  await assert.rejects(
    () => service.writeWorkspaceUploadChunk({
      sessionId: upload.id,
      fileId: file.id,
      userId: 'user-1',
      workspace,
      offset: 0,
      expectedBytes: 5,
      body: new Blob([content.subarray(0, 3)]).stream(),
    }),
    (error: unknown) => Boolean(
      error instanceof service.WorkspaceUploadServiceError
      && error.code === 'UPLOAD_CHUNK_SIZE_MISMATCH'
    ),
  );
  assert.equal((await service.getWorkspaceUploadSession({
    sessionId: upload.id,
    userId: 'user-1',
    workspace,
  })).files[0].uploadedBytes, 0);

  const first = await service.writeWorkspaceUploadChunk({
    sessionId: upload.id,
    fileId: file.id,
    userId: 'user-1',
    workspace,
    offset: 0,
    expectedBytes: 5,
    body: new Blob([content.subarray(0, 5)]).stream(),
  });
  assert.equal(first.file.uploadedBytes, 5);
  assert.equal(first.file.status, 'uploading');

  const second = await service.writeWorkspaceUploadChunk({
    sessionId: upload.id,
    fileId: file.id,
    userId: 'user-1',
    workspace,
    offset: 5,
    expectedBytes: content.length - 5,
    body: new Blob([content.subarray(5)]).stream(),
  });
  assert.equal(second.file.uploadedBytes, content.length);
  assert.equal(second.file.status, 'uploaded');

  const duplicateRetry = await service.writeWorkspaceUploadChunk({
    sessionId: upload.id,
    fileId: file.id,
    userId: 'user-1',
    workspace,
    offset: 5,
    expectedBytes: content.length - 5,
    body: new Blob([content.subarray(5)]).stream(),
  });
  assert.equal(duplicateRetry.alreadyReceived, true);

  const completed = await service.completeWorkspaceUploadFile({
    sessionId: upload.id,
    fileId: file.id,
    userId: 'user-1',
    workspace,
    commit: ({ file: completedFile, sourcePath }) => workspaceFiles.replaceWorkspaceFileFromPath(
      sourcePath,
      completedFile.targetPath,
      { workspace },
    ),
  });
  assert.equal(completed.file.status, 'completed');
  assert.equal(completed.session.status, 'completed');
  const completedPath = path.join(workspaceRoot, 'folder/nested/test_.txt');
  assert.deepEqual(await fs.readFile(completedPath), content);
  assert.equal((await fs.stat(completedPath)).mode & 0o777, 0o644);

  const completedRetry = await service.completeWorkspaceUploadFile({
    sessionId: upload.id,
    fileId: file.id,
    userId: 'user-1',
    workspace,
    commit: async () => {
      throw new Error('Idempotent completion must not run commit again.');
    },
  });
  assert.equal(completedRetry.alreadyCompleted, true);

  await service.cancelWorkspaceUploadSession({
    sessionId: upload.id,
    userId: 'user-1',
    workspace,
  });
  await assert.rejects(
    () => service.getWorkspaceUploadSession({
      sessionId: upload.id,
      userId: 'user-1',
      workspace,
    }),
    (error: unknown) => Boolean(
      error instanceof service.WorkspaceUploadServiceError
      && error.code === 'UPLOAD_CANCELLED'
      && error.status === 409
    ),
  );

  const exactSources = [
    { path: 'name.md', content: Buffer.from('# Normal upload\n') },
    { path: ' name.md', content: Buffer.from('# Leading-space upload\n') },
    { path: ' Dir / Note .md', content: Buffer.from('# Exact nested upload\n') },
  ];
  const exactUpload = await service.createWorkspaceUploadSession({ userId: 'user-1', workspace, targetDir: '.',
    files: exactSources.map(source => ({ path: source.path, size: source.content.length, mimeType: 'text/markdown' })) });
  assert.deepEqual(exactUpload.files.map(file => file.relativePath), exactSources.map(source => source.path));
  assert.deepEqual(exactUpload.files.map(file => file.targetPath), exactSources.map(source => source.path));
  const exactScope = { sessionId: exactUpload.id, userId: 'user-1', workspace };
  for (const [index, source] of exactSources.entries()) {
    const file = exactUpload.files[index];
    await service.writeWorkspaceUploadChunk({ ...exactScope, fileId: file.id, offset: 0, expectedBytes: source.content.length,
      body: new Blob([source.content]).stream() });
    const complete = await service.completeWorkspaceUploadFile({ ...exactScope, fileId: file.id,
      commit: ({ file: completedFile, sourcePath }) => {
        assert.equal(completedFile.targetPath, source.path);
        return workspaceFiles.replaceWorkspaceFileFromPath(sourcePath, completedFile.targetPath, { workspace });
      } });
    assert.equal(complete.file.targetPath, source.path); assert.equal(complete.file.status, 'completed');
    assert.deepEqual(await fs.readFile(path.join(workspaceRoot, source.path)), source.content);
  }
  const exactCompleted = await service.getWorkspaceUploadSession(exactScope);
  assert.equal(exactCompleted.status, 'completed');
  assert.deepEqual(exactCompleted.files.map(file => file.targetPath), exactSources.map(source => source.path));
  assert.notEqual((await fs.stat(path.join(workspaceRoot, 'name.md'))).ino, (await fs.stat(path.join(workspaceRoot, ' name.md'))).ino);
  assert((await fs.stat(path.join(workspaceRoot, ' Dir '))).isDirectory());
  await assert.rejects(fs.stat(path.join(workspaceRoot, 'Dir')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(workspaceRoot, ' Dir /Note .md')), { code: 'ENOENT' });

  console.log('workspace-upload-service-test: ok');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });
