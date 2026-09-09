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
    const { moveAgentPaths, getAgentWorkspaceContext } = await import('../app/lib/pi/agent-file-operations');
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { getFileCollaborationState } = await import('../app/lib/files/collaboration-policy');
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, 'notes'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'notes', 'a.md'), '# Preserved');
    await runWithAgentExecutionContext({
      userId: 'test', sessionId: 'test', agentId: 'canvas-agent', workspaceId: 'test', workspaceType: 'personal',
      workspaceName: 'Test', organizationId: null, customerId: null, projectId: null,
      workspaceRoot, workspaceRootRelativePath: null, canWrite: true, canDelete: true, canShare: false, legacy: false,
    }, async () => {
      const workspace = getAgentWorkspaceContext()!;
      const before = await getFileCollaborationState({ workspace, path: 'notes/a.md', ensureDocument: true });
      const events: FileEvent[] = [];
      getFileWatcher().subscribe({ id: 'tab', workspaceId: workspace.workspaceId, workspace, send: (event) => events.push(event) });
      const result = await moveAgentPaths({ sourcePaths: ['notes'], destinationPath: 'archive' });
      assert.equal(result.verified, true);
      assert.equal(await fs.readFile(path.join(workspaceRoot, 'archive', 'a.md'), 'utf8'), '# Preserved');
      const after = await getFileCollaborationState({ workspace, path: 'archive/a.md', ensureDocument: true });
      assert.equal(after.document?.id, before.document?.id, 'agent folder move preserves document identity');
      const rename = events.find((event) => event.type === 'rename');
      assert.equal(rename?.mutation?.oldPath, 'notes');
      assert.equal(rename?.mutation?.newPath, 'archive');
      assert.equal(events.some((event) => event.type === 'unlinkDir' && event.relativePath === 'notes'), false);
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
