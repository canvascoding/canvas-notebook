import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-heartbeat-migration-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

async function main() {
  const { runMigrations } = await import('../app/lib/db/migrate');
  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  try {
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('heartbeat-owner', 'Heartbeat Owner', 'heartbeat-owner@example.test', 1, 'admin', now, now);
    const { ensureOrganizationBootstrapForUser } = await import('../app/lib/organization/bootstrap');
    sqlite.exec('BEGIN IMMEDIATE');
    ensureOrganizationBootstrapForUser(sqlite, 'heartbeat-owner');
    sqlite.exec('COMMIT');
  } finally {
    sqlite.close();
  }

  const { db } = await import('../app/lib/db');
  const { automationJobs } = await import('../app/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const { createAutomationJob, getAutomationJob, migrateLegacyHeartbeatJobs } = await import('../app/lib/automations/store');
  const { readLegacyHeartbeatInstructions } = await import('../app/lib/agents/storage');

  const legacyFilePath = path.join(dataDir, 'users', 'heartbeat-owner', 'agents', 'support-agent', 'HEARTBEAT.md');
  mkdirSync(path.dirname(legacyFilePath), { recursive: true });
  writeFileSync(legacyFilePath, 'Prüfe neue Support-Anfragen und fasse nur wichtige Änderungen zusammen.\n', 'utf8');
  const createdJob = await createAutomationJob({
    name: 'Legacy Heartbeat',
    prompt: 'legacy',
    agentId: 'support-agent',
    schedule: { kind: 'daily', times: ['09:00'], timeZone: 'UTC' },
    deliveryMode: 'web',
    deliveryChannelId: 'web',
    deliverySessionMode: 'new_session',
  }, 'heartbeat-owner');
  await db
    .update(automationJobs)
    .set({
      jobType: 'heartbeat',
      workspaceId: null,
      jobScope: 'personal:legacy:legacy',
    })
    .where(eq(automationJobs.id, createdJob.id));
  const legacyJob = { ...createdJob, jobType: 'heartbeat' as const, workspaceId: null };

  assert.equal(legacyJob.jobType, 'heartbeat');
  assert.equal(legacyJob.workspaceId, null);
  assert.equal(await migrateLegacyHeartbeatJobs(), 1);

  const migrated = await getAutomationJob(legacyJob.id);
  assert.ok(migrated);
  assert.equal(migrated.id, legacyJob.id);
  assert.equal(migrated.jobType, 'default');
  assert.equal(migrated.triggerKind, 'schedule');
  assert.equal(migrated.resultPolicy, 'deliver_relevant_only');
  assert.equal(migrated.workspaceType, 'personal');
  assert.ok(migrated.workspaceId);
  assert.deepEqual(migrated.schedule, legacyJob.schedule);
  assert.equal(migrated.deliveryMode, legacyJob.deliveryMode);
  assert.match(migrated.prompt, /Prüfe neue Support-Anfragen/);
  assert.equal(await readLegacyHeartbeatInstructions({ userId: 'heartbeat-owner', agentId: 'support-agent' }), '');
  assert.equal(await migrateLegacyHeartbeatJobs(), 0, 'migration must be idempotent');

  console.log('automation-heartbeat-migration-test: ok');
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });
