import assert from 'node:assert/strict';
import Module from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-bradley-agent-id-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  return originalLoad(request, parent, isMain);
};

let closeDatabaseConnections: (() => Promise<void>) | undefined;

async function main(): Promise<void> {
  const sqlitePath = path.join(dataDir, 'sqlite.db');
  const legacyDatabase = new Database(sqlitePath);
  const { runMigrations } = await import('../app/lib/db/migrate');
  runMigrations(legacyDatabase);

  const userId = 'bradley-agent-id-user';
  const now = Date.now();
  legacyDatabase.prepare(`
    INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, 'Bradley Migration Test', 'bradley-migration@example.test', 1, now, now);
  legacyDatabase.prepare("UPDATE agents SET agent_id = 'canvas-agent' WHERE agent_id = 'bradley'").run();
  legacyDatabase.prepare(`
    INSERT INTO pi_sessions (
      session_id, user_id, agent_id, provider, model, title, created_at, updated_at
    ) VALUES (?, ?, 'canvas-agent', ?, ?, ?, ?, ?)
  `).run('legacy-main-session', userId, 'test', 'test-model', 'Legacy Bradley session', now, now);
  legacyDatabase.prepare(`
    INSERT INTO automation_jobs (
      id, name, status, owner_user_id, prompt, preferred_skill,
      workspace_context_paths_json, schedule_kind, schedule_config_json,
      time_zone, created_by_user_id, agent_id, delivery_mode,
      delivery_session_mode, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'canvas-agent', ?, ?, ?, ?)
  `).run(
    'legacy-main-automation',
    'Legacy Bradley automation',
    'paused',
    userId,
    'Verify the canonical Bradley agent ID.',
    '',
    '[]',
    'manual',
    '{}',
    'Europe/Berlin',
    userId,
    'web',
    'new_session',
    now,
    now,
  );
  legacyDatabase.close();

  const legacySoulPath = path.join(dataDir, 'users', userId, 'agents', 'canvas-agent', 'SOUL.md');
  mkdirSync(path.dirname(legacySoulPath), { recursive: true });
  const soulContent = '# Personal collaboration preferences\n\nUse concise answers.\n';
  writeFileSync(legacySoulPath, soulContent, 'utf8');

  const { DEFAULT_AGENT_ID } = await import('../app/lib/channels/constants');
  const {
    DEFAULT_MANAGED_AGENT_ID,
    readManagedAgentFile,
  } = await import('../app/lib/agents/storage');
  const {
    ensureCanvasAgent,
    MAIN_AGENT_DISPLAY_NAME,
    normalizeManagedAgentId,
  } = await import('../app/lib/agents/registry');
  const databaseModule = await import('../app/lib/db');
  closeDatabaseConnections = databaseModule.closeDatabaseConnections;

  assert.equal(DEFAULT_AGENT_ID, 'bradley');
  assert.equal(DEFAULT_MANAGED_AGENT_ID, 'bradley');
  assert.equal(normalizeManagedAgentId('canvas-agent'), 'bradley');
  assert.equal(normalizeManagedAgentId('bradley'), 'bradley');
  assert.equal(MAIN_AGENT_DISPLAY_NAME, 'Bradley');

  const profile = await ensureCanvasAgent();
  assert.equal(profile.agentId, 'bradley');
  assert.equal(profile.name, MAIN_AGENT_DISPLAY_NAME);
  assert.equal(profile.type, 'main');

  const database = await databaseModule.openDb();
  for (const table of ['agents', 'pi_sessions', 'automation_jobs']) {
    const legacyCount = await database.get(
      `SELECT COUNT(*) AS count FROM ${table} WHERE agent_id = ?`,
      ['canvas-agent'],
    ) as { count: number };
    assert.equal(legacyCount.count, 0, `${table} still contains the legacy main-agent ID`);
  }
  const session = await database.get(
    'SELECT agent_id AS agentId FROM pi_sessions WHERE session_id = ?',
    ['legacy-main-session'],
  ) as { agentId: string } | undefined;
  assert.equal(session?.agentId, 'bradley');
  const automation = await database.get(
    'SELECT agent_id AS agentId FROM automation_jobs WHERE id = ?',
    ['legacy-main-automation'],
  ) as { agentId: string } | undefined;
  assert.equal(automation?.agentId, 'bradley');

  const migratedSoul = await readManagedAgentFile('SOUL.md', 'canvas-agent', { userId });
  const canonicalSoulPath = path.join(dataDir, 'users', userId, 'agents', 'bradley', 'SOUL.md');
  assert.equal(migratedSoul, soulContent);
  assert.equal(readFileSync(canonicalSoulPath, 'utf8'), soulContent);
  assert.equal(existsSync(legacySoulPath), true, 'the rollback-safe legacy copy must remain intact');

  console.log('bradley-runtime-stability-test: ok');
}

main()
  .finally(async () => {
    await closeDatabaseConnections?.();
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
