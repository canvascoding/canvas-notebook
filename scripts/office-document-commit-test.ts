import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { PGlite } from '@electric-sql/pglite';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { setFileCollaborationConnectionFactoryForTests } from '../app/lib/files/collaboration-repository';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function documentBytes(text: string) {
  return new JSZip()
    .file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    .file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    .file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)
    .generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-office-commit-'));
  process.env.DATA = root;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
  const database = new PGlite();
  try {
    await runPostgresMigrations(database as unknown as Parameters<typeof runPostgresMigrations>[0]);
    setFileCollaborationConnectionFactoryForTests(async () => ({
      get: async (sql, params = []) => (await database.query(sql, params)).rows[0],
      all: async (sql, params = []) => (await database.query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await database.query(sql, params)).affectedRows ?? 0 }),
      close: () => undefined,
    }));
    const { writeWorkspaceFileContent } = await import('../app/lib/files/write-service');
    const { readOfficeDocumentSnapshot } = await import('../app/lib/office/document-service');
    const { acquireFileLock, releaseFileLock } = await import('../app/lib/files/collaboration-policy');
    const { prepareOfficeCommit, findOfficeCommit, readOfficeVersion } = await import('../app/lib/office/document-journal');
    const { sha256Buffer } = await import('../app/lib/files/revision-guard');
    const { writeFile } = await import('../app/lib/filesystem/workspace-files');
    const workspace: WorkspaceContext = { workspaceId: 'office-commit-test', workspaceType: 'personal',
      rootPath: path.join(root, 'workspace'), organizationId: null, ownerUserId: 'alice', legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true },
    };
    await fs.mkdir(workspace.rootPath, { recursive: true });
    const original = await documentBytes('Original');
    const proposal = await documentBytes('First edit');
    const common = { workspace, fileOptions: { workspace }, actorUserId: 'alice', path: 'draft.docx' };
    const created = await writeWorkspaceFileContent({ ...common, content: original, createOnly: true, idempotencyKey: randomUUID() });
    assert.equal(created.stats.sha256, sha256Buffer(original));
    const loaded = await readOfficeDocumentSnapshot(workspace, common.path);
    assert.equal(loaded.stats.sha256, sha256Buffer(loaded.content));
    const session = randomUUID();
    const { lock } = await acquireFileLock({ workspace, path: common.path, lockedByUserId: 'alice', lockedBySessionId: session, baseRevisionId: loaded.revision.id });
    const input = { ...common, actorSessionId: session, lockId: lock.id, expectedSha256: loaded.stats.sha256, baseRevisionId: loaded.revision.id, content: proposal, idempotencyKey: randomUUID() };
    const committed = await writeWorkspaceFileContent(input);
    const replayed = await writeWorkspaceFileContent(input);
    assert.equal(replayed.revision.id, committed.revision.id);
    assert.deepEqual(await readOfficeVersion({ workspaceId: workspace.workspaceId, lineageId: loaded.collaboration.lineageId!, contentHash: loaded.stats.sha256 }), original);
    const isCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;
    await assert.rejects(() => writeWorkspaceFileContent({ ...input, content: original }), isCode('OFFICE_IDEMPOTENCY_CONFLICT'));
    const next = { ...input, expectedSha256: committed.stats.sha256, baseRevisionId: committed.revision.id, idempotencyKey: randomUUID(), content: original };
    await assert.rejects(() => writeWorkspaceFileContent({ ...next, actorSessionId: randomUUID() }), isCode('FILE_LOCKED'));
    await assert.rejects(() => writeWorkspaceFileContent({ ...next, expectedSha256: null }), isCode('FILE_REVISION_REQUIRED'));
    await assert.rejects(() => writeWorkspaceFileContent({ ...next, lockId: 'old-generation' }), isCode('FILE_LOCK_STALE'));
    await assert.rejects(() => writeWorkspaceFileContent({ ...next, content: Buffer.alloc(0) }), isCode('DOCX_INVALID_PACKAGE'));
    await assert.rejects(() => writeFile(common.path, original, { workspace }), isCode('OFFICE_PUBLICATION_REQUIRED'));
    const abort = new AbortController(); abort.abort();
    await assert.rejects(() => writeWorkspaceFileContent({ ...next, signal: abort.signal }), { name: 'AbortError' });
    assert.deepEqual(await fs.readFile(path.join(workspace.rootPath, common.path)), proposal);
    console.log('PASS exact-byte load, conditional commit, original bytes, idempotent retry, foreign/stale leases, invalid ZIP, cancellation and low-level bypass');

    // Reproduce the durable boundary: journal prepared + canonical replaced,
    // but the process died before appending the database revision.
    const recoveredContent = await documentBytes('Recovered after publication');
    const journalInput = { workspaceId: workspace.workspaceId, lineageId: loaded.collaboration.lineageId!, path: common.path,
      actorUserId: 'alice', actorSessionId: 'agent-recovery', actorType: 'agent' as const,
      beforeHash: committed.stats.sha256, beforeContent: proposal, content: recoveredContent,
      baseRevisionId: committed.revision.id, idempotencyKey: randomUUID() };
    const pending = await prepareOfficeCommit(journalInput);
    await fs.writeFile(path.join(workspace.rootPath, common.path), recoveredContent);
    const recovered = await readOfficeDocumentSnapshot(workspace, common.path);
    assert.equal(recovered.stats.sha256, sha256Buffer(recoveredContent));
    assert.equal(recovered.revision.createdByActorType, 'agent');
    assert.equal(recovered.revision.sourceSessionId, 'agent-recovery');
    assert.equal((await findOfficeCommit(journalInput))?.status, 'completed');
    assert.equal((await findOfficeCommit(journalInput))?.id, pending.id);
    const notPublished = await prepareOfficeCommit({ ...journalInput, beforeHash: recovered.stats.sha256, beforeContent: recoveredContent, baseRevisionId: recovered.revision.id, content: original, idempotencyKey: randomUUID() });
    const unchanged = await readOfficeDocumentSnapshot(workspace, common.path);
    assert.equal(unchanged.revision.id, recovered.revision.id);
    assert.equal((await findOfficeCommit(notPublished))?.status, 'prepared');
    await releaseFileLock({ workspace, lockId: lock.id, actorUserId: 'alice', actorSessionId: session });
    console.log('PASS recovery after filesystem/database crash boundary; unpublished proposal retained without replacing canonical bytes');
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    setFileCollaborationConnectionFactoryForTests(null);
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
