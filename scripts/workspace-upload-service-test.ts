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
      && error.code === 'UPLOAD_NOT_FOUND'
    ),
  );

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
