import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import type { SqlConnection } from '../app/lib/db';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { setFileCollaborationConnectionFactoryForTests } from '../app/lib/files/collaboration-repository';
import type { FileEvent } from '../app/lib/filesystem/file-watcher';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-rename-'));
  // Keep unrelated audit/share tables isolated too. Collaboration uses PostgreSQL below.
  process.env.DATA = root;
  process.env.CANVAS_DATABASE_PROVIDER = 'postgres';
  process.env.DATABASE_URL = 'postgresql://agent-rename-test.invalid/canvas';
  const postgres = new PGlite();
  const query = async (input: string | { text: string; rowMode?: string }, values?: unknown[]) => {
    const result = await postgres.query<Record<string, unknown>>(typeof input === 'string' ? input : input.text, values);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length,
      rows: typeof input !== 'string' && input.rowMode === 'array' ? result.rows.map((row) => result.fields.map((field) => row[field.name])) : result.rows };
  };
  const original = { query: Pool.prototype.query, connect: Pool.prototype.connect };
  Object.defineProperty(Pool.prototype, 'query', { configurable: true, writable: true, value: query });
  Object.defineProperty(Pool.prototype, 'connect', { configurable: true, writable: true, value: async () => ({ query, release() {} }) });
  const connection: SqlConnection = {
    get: async (sql, params = []) => (await postgres.query(sql, params)).rows[0],
    all: async (sql, params = []) => (await postgres.query(sql, params)).rows,
    run: async (sql, params = []) => ({ changes: (await postgres.query(sql, params)).affectedRows ?? 0 }),
    close: () => undefined,
  };
  const { getFileWatcher } = await import('../app/lib/filesystem/file-watcher');
  try {
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    setFileCollaborationConnectionFactoryForTests(async () => connection);
    const { copyAgentPaths, moveAgentPaths, getAgentWorkspaceContext } = await import('../app/lib/pi/agent-file-operations');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { getFileCollaborationState } = await import('../app/lib/files/collaboration-policy');
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, 'notes'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'notes', 'a.md'), '# Preserved');
    await fs.writeFile(path.join(workspaceRoot, 'notes', 'inside.md'), '[A](./a.md)');
    await fs.writeFile(path.join(workspaceRoot, 'index.md'), '[A](notes/a.md)');
    await fs.writeFile(path.join(workspaceRoot, 'stable.md'), '# Stable');
    await fs.mkdir(path.join(workspaceRoot, 'backup'));
    await runWithAgentExecutionContext({
      userId: 'test', sessionId: 'test', agentId: 'canvas-agent', workspaceId: 'test', workspaceType: 'personal',
      workspaceName: 'Test', organizationId: null, customerId: null, projectId: null,
      workspaceRoot, workspaceRootRelativePath: null, canWrite: true, canDelete: true, canShare: false, legacy: false,
    }, async () => {
      const workspace = getAgentWorkspaceContext()!;
      await fs.mkdir(path.join(workspaceRoot, 'blocked'));
      await fs.writeFile(path.join(workspaceRoot, 'blocked', 'missing.md'), '[Missing](./absent.md)');
      await assert.rejects(() => moveAgentPaths({ sourcePaths: ['notes'], destinationPath: 'archive' }));
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'notes', 'a.md'), 'utf8'), '# Preserved');
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'archive')));
      await fs.rm(path.join(workspaceRoot, 'blocked'), { recursive: true });
      await fs.mkdir(path.join(workspaceRoot, 'batch'));
      await fs.writeFile(path.join(workspaceRoot, 'batch', 'one.bin'), 'one');
      await fs.writeFile(path.join(workspaceRoot, 'batch', 'two.bin'), 'two');
      const batch = await moveAgentPaths({
        sourcePaths: ['batch/one.bin', 'batch/two.bin'], destinationPath: 'backup',
      });
      assert.equal(batch.verified, true, JSON.stringify(batch));
      assert.equal(batch.linkStatus, 'complete');
      assert.equal(batch.operationIds?.length, 2);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'backup', 'one.bin'), 'utf8'), 'one');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'backup', 'two.bin'), 'utf8'), 'two');
      const plainCopy = await copyAgentPaths({ sourcePaths: ['backup/one.bin'], destinationPath: 'batch/one.bin' });
      assert.equal(plainCopy.verified, true, JSON.stringify(plainCopy));
      assert.equal(plainCopy.linkStatus, 'complete');
      assert.equal(plainCopy.operationIds?.length, 1);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'batch', 'one.bin'), 'utf8'), 'one');
      const before = await getFileCollaborationState({ workspace, path: 'stable.md', ensureDocument: true });
      const events: FileEvent[] = [];
      getFileWatcher().subscribe({ id: 'tab', workspaceId: workspace.workspaceId, workspace, send: (event) => events.push(event) });
      const result = await moveAgentPaths({ sourcePaths: ['stable.md'], destinationPath: 'stable-renamed.md' });
      assert.equal(result.verified, true, JSON.stringify(result));
      assert.equal(result.linkStatus, 'complete');
      assert.equal(result.operationIds?.length, 1);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'stable-renamed.md'), 'utf8'), '# Stable');
      const after = await getFileCollaborationState({ workspace, path: 'stable-renamed.md', ensureDocument: true });
      assert.equal(after.document?.id, before.document?.id, 'agent move preserves document identity');
      const rename = events.find((event) => event.type === 'rename');
      assert.equal(rename?.mutation?.oldPath, 'stable.md');
      assert.equal(rename?.mutation?.newPath, 'stable-renamed.md');
      assert.equal(events.some((event) => event.type === 'unlink' && event.relativePath === 'stable.md'), false);

      const linkedBefore = await getFileCollaborationState({ workspace, path: 'notes/a.md', ensureDocument: true });
      await assert.rejects(
        () => moveAgentPaths({ sourcePaths: ['notes'], destinationPath: 'archive' }),
        /authoritative collaboration reader or writer is unavailable/u,
      );
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'notes', 'a.md'), 'utf8'), '# Preserved');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'index.md'), 'utf8'), '[A](notes/a.md)');
      await assert.rejects(fs.stat(path.join(workspaceRoot, 'archive')));
      const linkedAfter = await getFileCollaborationState({ workspace, path: 'notes/a.md', ensureDocument: true });
      assert.equal(linkedAfter.document?.id, linkedBefore.document?.id);

      const renamedCopy = await copyAgentPaths({ sourcePaths: ['notes/a.md'], destinationPath: 'backup/a-copy.md' });
      assert.equal(renamedCopy.linkStatus, 'incomplete');
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'backup', 'a-copy.md'), 'utf8'), '# Preserved');
    });
    console.log('notebook-agent-path-mutations-test: ok');
  } finally {
    getFileWatcher().stop();
    setFileCollaborationConnectionFactoryForTests(null);
    Object.assign(Pool.prototype, original);
    await postgres.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
