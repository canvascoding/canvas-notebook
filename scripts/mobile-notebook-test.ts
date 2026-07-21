import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-notebook-'));
  const originalData = process.env.DATA;
  const originalProvider = process.env.CANVAS_DATABASE_PROVIDER;
  process.env.DATA = path.join(temporaryRoot, 'data');
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  try {
    const workspaceRoot = path.join(process.env.DATA, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, 'Research'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'Alpha.md'), '# Alpha\n\nFirst notebook note.');
    await fs.writeFile(path.join(workspaceRoot, 'Research', 'Beta.markdown'), '# Beta\n\nNeedle in content.');

    const { closeDatabaseConnections, openDb } = await import('../app/lib/db');
    const database = await openDb();
    const now = Date.now();
    await database.run(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['notebook-user', 'Notebook User', 'notebook@example.test', 1, now, now],
    );
    await database.close();

    const { createLegacyPersonalWorkspaceContext } = await import('../app/lib/workspaces/context');
    const {
      createMobileNotebookDocument,
      listMobileNotebookDocuments,
      normalizeMobileNotebookPath,
      readMobileNotebookDocument,
      saveMobileNotebookDocument,
    } = await import('../app/lib/mobile/notebook');
    const workspace = createLegacyPersonalWorkspaceContext({
      userId: 'notebook-user',
      email: 'notebook@example.test',
      role: 'owner',
    });
    const fileOptions = { workspace };

    const recent = await listMobileNotebookDocuments({ workspace, fileOptions, limit: 20 });
    assert.equal(recent.items.length, 2);
    assert.equal(recent.items.some((item) => item.title === 'Alpha'), true);

    const search = await listMobileNotebookDocuments({
      workspace,
      fileOptions,
      query: 'needle',
      limit: 20,
    });
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0]?.path, 'Research/Beta.markdown');
    assert.equal(search.items[0]?.match, 'content');

    const loaded = await readMobileNotebookDocument({
      workspace,
      fileOptions,
      actorUserId: 'notebook-user',
      path: 'Alpha.md',
    });
    assert.equal(loaded.canEdit, true);
    assert.match(loaded.sha256, /^[a-f0-9]{64}$/u);

    const saved = await saveMobileNotebookDocument({
      workspace,
      fileOptions,
      actorUserId: 'notebook-user',
      actorSessionId: 'auth-session',
      path: loaded.path,
      content: '# Alpha\n\nUpdated safely.',
      expectedSha256: loaded.sha256,
      baseRevisionId: loaded.revisionId,
    });
    assert.equal(saved.content.includes('Updated safely.'), true);

    await fs.writeFile(path.join(workspaceRoot, 'Alpha.md'), '# Alpha\n\nChanged elsewhere.');
    await assert.rejects(
      () => saveMobileNotebookDocument({
        workspace,
        fileOptions,
        actorUserId: 'notebook-user',
        actorSessionId: 'auth-session',
        path: saved.path,
        content: '# Alpha\n\nLocal stale edit.',
        expectedSha256: saved.sha256,
        baseRevisionId: saved.revisionId,
      }),
      (error: unknown) => Boolean(
        error && typeof error === 'object' && 'code' in error && error.code === 'FILE_REVISION_CONFLICT',
      ),
    );

    const created = await createMobileNotebookDocument({
      workspace,
      fileOptions,
      actorUserId: 'notebook-user',
      actorSessionId: 'auth-session',
      title: 'Alpha',
    });
    assert.equal(created.path, 'Alpha (2).md');
    assert.throws(() => normalizeMobileNotebookPath('../outside.md'));

    const imageRoute = await fs.readFile(
      path.join(process.cwd(), 'app/api/mobile/v1/notebook/images/import/route.ts'),
      'utf8',
    );
    assert.match(imageRoute, /app\/api\/markdown\/images\/import\/route/u);
    assert.match(imageRoute, /export const runtime = 'nodejs'/u);

    await closeDatabaseConnections();
    console.log('mobile-notebook-test: ok');
  } finally {
    if (originalData === undefined) delete process.env.DATA;
    else process.env.DATA = originalData;
    if (originalProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = originalProvider;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

void main();
