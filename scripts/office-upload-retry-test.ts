import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-office-upload-retry-'));
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
  try {
    const service = await import('../app/lib/files/workspace-upload-service');
    const { runWorkspaceUploadWrite } = await import('../app/lib/files/workspace-upload-flow');
    const { writeWorkspaceFileContent } = await import('../app/lib/files/write-service');
    const { createEmptyDocx } = await import('../app/lib/office/empty-docx');
    const { readOfficeDocumentSnapshot } = await import('../app/lib/office/document-service');
    const { acquireFileLock, releaseFileLock } = await import('../app/lib/files/collaboration-policy');
    const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
    const { findOfficeCommit } = await import('../app/lib/office/document-journal');
    const workspace: WorkspaceContext = { workspaceId: 'upload-retry', workspaceType: 'personal', rootPath: path.join(dataRoot, 'workspace'), ownerUserId: 'alice', organizationId: null, legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
    await fs.mkdir(workspace.rootPath);
    const original = await createEmptyDocx();
    async function changed(text: string): Promise<Buffer> {
      const zip = await JSZip.loadAsync(original);
      zip.file('word/document.xml', (await zip.file('word/document.xml')!.async('string')).replace('</w:body>', `<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>`));
      return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    }
    const uploaded = await changed('Upload');
    const foreign = await changed('Newer human edit');
    async function createUpload(name: string, existing: boolean) {
      if (existing) await writeWorkspaceFileContent({ workspace, fileOptions: { workspace }, actorUserId: 'alice', path: name, content: original, createOnly: true });
      const session = await service.createWorkspaceUploadSession({ userId: 'alice', workspace, targetDir: '.', files: [{ path: name, size: uploaded.length }] });
      await service.writeWorkspaceUploadChunk({ sessionId: session.id, fileId: session.files[0].id, userId: 'alice', workspace, offset: 0, expectedBytes: uploaded.length,
        body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(uploaded)); controller.close(); } }) });
      return session;
    }
    type Upload = Awaited<ReturnType<typeof createUpload>>;
    let commits = 0;
    async function complete(upload: Upload, failAfter = false, createOnly?: boolean) {
      return service.completeWorkspaceUploadFile({ sessionId: upload.id, fileId: upload.files[0].id, userId: 'alice', workspace,
        commit: async ({ file, sourcePath, persistOfficeAttempt }) => {
          commits++;
          await runWorkspaceUploadWrite({ workspace, fileOptions: { workspace }, actorUserId: 'alice', targetPath: file.targetPath, sourcePath,
            idempotencyKey: `upload:${upload.id}:${file.id}`, officeAttempt: file.officeAttempt, persistOfficeAttempt, createOnly,
            write: async () => assert.fail('DOCX must use its publication service') });
          if (failAfter) throw new Error('Injected crash after publication before completed status');
        } });
    }
    async function edit(name: string, content: Buffer) {
      const current = await readOfficeDocumentSnapshot(workspace, name);
      const { lock } = await acquireFileLock({ workspace, path: name, lockedByUserId: 'bob', lockedBySessionId: 'human-editor', baseRevisionId: current.revision.id });
      try {
        return await writeWorkspaceFileContent({ workspace, fileOptions: { workspace }, actorUserId: 'bob', actorSessionId: 'human-editor', lockId: lock.id,
          path: name, content, expectedSha256: current.stats.sha256, baseRevisionId: current.revision.id });
      } finally { await releaseFileLock({ workspace, lockId: lock.id, actorUserId: 'bob', actorSessionId: 'human-editor' }); }
    }
    async function persisted(upload: Upload) {
      return service.getWorkspaceUploadSession({ sessionId: upload.id, userId: 'alice', workspace });
    }

    const interrupted = await createUpload('interrupted.docx', true);
    await assert.rejects(complete(interrupted, true), /before completed status/);
    const firstAttempt = (await persisted(interrupted)).files[0].officeAttempt;
    assert.ok(firstAttempt);
    assert.equal((await persisted(interrupted)).files[0].status, 'uploaded');
    assert.equal((await findOfficeCommit(firstAttempt))?.status, 'completed');
    const newer = await edit('interrupted.docx', foreign);
    await assert.rejects(complete(interrupted), { code: 'UPLOAD_REVISION_CONFLICT', status: 409 });
    assert.deepEqual((await persisted(interrupted)).files[0].officeAttempt, firstAttempt);
    assert.deepEqual(await fs.readFile(path.join(workspace.rootPath, 'interrupted.docx')), foreign);
    assert.equal((await readOfficeDocumentSnapshot(workspace, 'interrupted.docx')).revision.id, newer.revision.id);
    console.log('PASS: A retry after publication/status failure preserves a later human save and immutable initial preconditions.');

    for (const existing of [true, false]) {
      const name = existing ? 'lost-response.docx' : 'new-upload.docx';
      const upload = await createUpload(name, existing);
      await assert.rejects(complete(upload, true, !existing || undefined), /before completed status/);
      const before = (await persisted(upload)).files[0].officeAttempt;
      const snapshot = await readOfficeDocumentSnapshot(workspace, name);
      const result = await complete(upload, false, !existing || undefined);
      assert.equal(result.alreadyCompleted, false);
      assert.deepEqual(result.file.officeAttempt, before);
      assert.equal((await readOfficeDocumentSnapshot(workspace, name)).revision.id, snapshot.revision.id);
      const calls = commits;
      assert.equal((await complete(upload, false, !existing || undefined)).alreadyCompleted, true);
      assert.equal(commits, calls);
      await edit(name, foreign);
      await assert.rejects(complete(upload, false, !existing || undefined), { code: 'UPLOAD_REVISION_CONFLICT', status: 409 });
      await edit(name, uploaded); // Same bytes, newer revision: an old receipt still cannot claim this edit.
      await assert.rejects(complete(upload, false, !existing || undefined), { code: 'UPLOAD_REVISION_CONFLICT', status: 409 });
    }
    console.log('PASS: Lost responses replay existing/create-only receipts without a new revision; completed retries reject later revisions including ABA.');

    const prepared = await createUpload('prepared.docx', true);
    const rename = fs.rename;
    fs.rename = (async (from, to) => {
      await rename(from, to);
      if (String(to).endsWith('/prepared.docx')) throw new Error('Injected crash immediately after canonical rename');
    }) as typeof fs.rename;
    try { await assert.rejects(complete(prepared), /after canonical rename/); }
    finally { fs.rename = rename; }
    const pendingAttempt = (await persisted(prepared)).files[0].officeAttempt!;
    assert.equal((await findOfficeCommit(pendingAttempt))?.status, 'prepared');
    await complete(prepared);
    assert.equal((await findOfficeCommit(pendingAttempt))?.status, 'completed');
    assert.deepEqual(await fs.readFile(path.join(workspace.rootPath, 'prepared.docx')), uploaded);
    console.log('PASS: A prepared receipt recovers a canonical publication whose revision/status finalization was interrupted.');

    const ordered = await createUpload('ordered.docx', false);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    const holder = withWorkspaceMutationLock(`workspace-upload:${ordered.id}`, async () => { entered(); await gate; });
    await locked;
    const completing = complete(ordered);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        withWorkspaceMutationLock(workspace.workspaceId, async () => undefined),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Upload acquired workspace before its session lock')), 3000); }),
      ]);
    } finally { clearTimeout(timer); release(); }
    await holder;
    await completing;
    console.log('PASS: Waiting for the upload-session lock leaves the workspace lock available; commit persistence reenters without inverse acquisition.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally { await fs.rm(dataRoot, { recursive: true, force: true }); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
