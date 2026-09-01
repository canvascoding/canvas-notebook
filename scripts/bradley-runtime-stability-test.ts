import assert from 'node:assert/strict';
import Module from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-bradley-runtime-stability-'));
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
  const { DEFAULT_AGENT_ID } = await import('../app/lib/channels/constants');
  const {
    DEFAULT_MANAGED_AGENT_ID,
    writeManagedAgentFile,
  } = await import('../app/lib/agents/storage');
  const {
    ensureCanvasAgent,
    MAIN_AGENT_DISPLAY_NAME,
  } = await import('../app/lib/agents/registry');
  const databaseModule = await import('../app/lib/db');
  closeDatabaseConnections = databaseModule.closeDatabaseConnections;

  assert.equal(DEFAULT_AGENT_ID, 'canvas-agent');
  assert.equal(DEFAULT_MANAGED_AGENT_ID, 'canvas-agent');
  assert.equal(MAIN_AGENT_DISPLAY_NAME, 'Bradley');

  const profile = await ensureCanvasAgent();
  assert.equal(profile.agentId, DEFAULT_AGENT_ID);
  assert.equal(profile.name, MAIN_AGENT_DISPLAY_NAME);
  assert.equal(profile.type, 'main');

  const userId = 'bradley-runtime-stability-user';
  const soulContent = '# Personal collaboration preferences\n\nUse concise answers.\n';
  await writeManagedAgentFile('SOUL.md', soulContent, DEFAULT_MANAGED_AGENT_ID, { userId });

  const expectedSoulPath = path.join(dataDir, 'users', userId, 'agents', 'canvas-agent', 'SOUL.md');
  const displayNamePath = path.join(dataDir, 'users', userId, 'agents', 'Bradley');
  assert.equal(readFileSync(expectedSoulPath, 'utf8'), soulContent);
  assert.equal(existsSync(displayNamePath), false);

  const database = await databaseModule.openDb();
  const now = Math.floor(Date.now() / 1_000);
  await database.run(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, 'Bradley Runtime Test', 'bradley-runtime@example.test', 1, now, now],
  );

  const sessionId = 'bradley-runtime-session';
  await database.run(
    `INSERT INTO pi_sessions (
       session_id, user_id, provider, model, title, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, userId, 'test', 'test-model', 'Bradley runtime stability', now, now],
  );
  const session = await database.get(
    `SELECT agent_id AS agentId FROM pi_sessions WHERE user_id = ? AND session_id = ?`,
    [userId, sessionId],
  ) as { agentId: string } | undefined;
  assert.equal(session?.agentId, DEFAULT_AGENT_ID);

  const automationId = 'bradley-runtime-automation';
  await database.run(
    `INSERT INTO automation_jobs (
       id, name, status, owner_user_id, prompt, preferred_skill,
       workspace_context_paths_json, schedule_kind, schedule_config_json,
       time_zone, created_by_user_id, delivery_mode, delivery_session_mode,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      automationId,
      'Bradley runtime stability',
      'paused',
      userId,
      'Verify the stable internal agent identity.',
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
    ],
  );
  const automation = await database.get(
    `SELECT agent_id AS agentId FROM automation_jobs WHERE id = ?`,
    [automationId],
  ) as { agentId: string } | undefined;
  assert.equal(automation?.agentId, DEFAULT_AGENT_ID);

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
