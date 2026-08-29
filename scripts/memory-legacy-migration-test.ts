import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-memory-legacy-'));
  process.env.CANVAS_DATA_ROOT = dataDir;
  process.env.DATA = dataDir;

  const moduleInternals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => request === 'server-only' ? {} : originalLoad(request, parent, isMain);
  try {
    const { openDb } = await import('../app/lib/db');
    const { writeManagedAgentFile } = await import('../app/lib/agents/storage');
    const { ensureLegacyMemoryMigrated } = await import('../app/lib/memory/legacy-migration');
    const { readMemory } = await import('../app/lib/memory/service');
    const db = await openDb();
    try {
      await db.run(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('user-1', 'Owner', 'owner@example.test', 1, 1, 1)`);
      await db.run(`INSERT INTO canvas_organization_settings (organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at) VALUES ('org-1', 'user-1', 'single_user', 0, 1, 1)`);
    } finally { await db.close(); }

    await writeManagedAgentFile('USER.md', '- [legacy-user] Preserve single-user memory.\n', 'canvas-agent');
    await writeManagedAgentFile('MEMORY.md', '- [legacy-agent] Preserve single-user agent memory.\n', 'canvas-agent');
    await ensureLegacyMemoryMigrated('canvas-agent', { userId: 'user-1' });
    assert.equal((await readMemory({ target: 'user', userId: 'user-1' })).entries.some((entry) => /single-user memory/.test(entry.content)), true);
    assert.equal((await readMemory({ target: 'agent', userId: 'user-1', agentId: 'canvas-agent' })).entries.some((entry) => /single-user agent memory/.test(entry.content)), true);

    const secondUserDb = await openDb();
    try {
      await secondUserDb.run(`INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('user-2', 'Member', 'member@example.test', 1, 1, 1)`);
    } finally { await secondUserDb.close(); }
    await writeManagedAgentFile('USER.md', '- [legacy-user] Do not share this legacy memory.\n', 'canvas-agent');
    await ensureLegacyMemoryMigrated('canvas-agent', { userId: 'user-2' });
    assert.deepEqual((await readMemory({ target: 'user', userId: 'user-2' })).entries, []);
    assert.deepEqual((await readMemory({ target: 'agent', userId: 'user-2', agentId: 'canvas-agent' })).entries, []);
  } finally {
    moduleInternals._load = originalLoad;
    await fs.rm(dataDir, { recursive: true, force: true });
  }
  console.log('memory-legacy-migration-test: ok');
}

void main();
