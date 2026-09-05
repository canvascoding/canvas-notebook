import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { inlineLegacyAutomationPaths } from '../app/lib/automations/legacy-paths';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-automation-paths-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

async function main() {
  const original = { prompt: 'Read the project and report changes.', workspaceContextPaths: ['docs', 'docs'], targetOutputPath: 'reports' };
  const migratedPrompt = inlineLegacyAutomationPaths(original);
  assert.equal(inlineLegacyAutomationPaths({ ...original, prompt: migratedPrompt }), migratedPrompt);
  assert.equal(inlineLegacyAutomationPaths({ prompt: original.prompt }), original.prompt);
  assert.match(migratedPrompt, /Only if this task explicitly requires creating workspace files/);

  const { runMigrations } = await import('../app/lib/db/migrate');
  const sqlite = new Database(path.join(dataDir, 'sqlite.db'));
  try {
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare('INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('path-owner', 'Path Owner', 'paths@example.test', 1, 'admin', now, now);
    const { ensureOrganizationBootstrapForUser } = await import('../app/lib/organization/bootstrap');
    sqlite.exec('BEGIN IMMEDIATE');
    ensureOrganizationBootstrapForUser(sqlite, 'path-owner');
    sqlite.exec('COMMIT');
  } finally {
    sqlite.close();
  }
  const { db } = await import('../app/lib/db');
  const { automationJobs, automationRuns, composioConnectionProfiles } = await import('../app/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const { createAutomationJob, createCustomWebhookAutomationJob, createWebhookAutomationJob, updateAutomationJob, getAutomationJob, createPendingAutomationRun, migrateLegacyAutomationPaths } = await import('../app/lib/automations/store');
  const input = { name: 'Project changes', ...original, schedule: { kind: 'daily' as const, times: ['09:00'], timeZone: 'UTC' } };
  const scheduled = await createAutomationJob(input, 'path-owner');
  const custom = (await createCustomWebhookAutomationJob(input, 'path-owner')).job;
  await db.insert(composioConnectionProfiles).values({ id: 'profile', ownerUserId: 'path-owner', name: 'Test', composioUserId: 'path-owner', createdAt: new Date(), updatedAt: new Date() });
  const webhook = await createWebhookAutomationJob({ ...input, composioTriggerId: 'trigger-path', composioTriggerSlug: 'test', composioToolkitSlug: 'test', composioConnectedAccountId: 'account', composioProfileId: 'profile', composioUserId: 'path-owner' }, 'path-owner');
  for (const job of [scheduled, custom, webhook]) {
    assert.equal(job.prompt, migratedPrompt);
    assert.deepEqual(job.workspaceContextPaths, []);
    assert.equal(job.targetOutputPath, null);
    assert.equal(job.effectiveTargetOutputPath, '');
    const row = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) });
    assert.equal(row?.workspaceContextPathsJson, '[]');
    assert.equal(row?.targetOutputPath, null);
  }
  const run = await createPendingAutomationRun(scheduled.id, 'manual');
  assert.ok(run);
  await db.update(automationRuns).set({ status: 'success', resultText: 'Historic answer', eventsLog: '["historic event"]', metadataJson: '{"historic":true}' }).where(eq(automationRuns.id, run.id));
  await db.update(automationJobs).set({ prompt: original.prompt, workspaceContextPathsJson: '["docs"]', targetOutputPath: 'reports' }).where(eq(automationJobs.id, scheduled.id));
  assert.equal(await migrateLegacyAutomationPaths(), 1);
  assert.equal(await migrateLegacyAutomationPaths(), 0);
  const migrated = await getAutomationJob(scheduled.id);
  assert.equal(migrated?.prompt, migratedPrompt);
  assert.deepEqual(migrated?.schedule, scheduled.schedule);
  const historic = await db.query.automationRuns.findFirst({ where: eq(automationRuns.id, run.id) });
  assert.equal(historic?.resultText, 'Historic answer');
  assert.equal(historic?.eventsLog, '["historic event"]');
  assert.equal(historic?.metadataJson, '{"historic":true}');
  const updated = await updateAutomationJob(scheduled.id, { prompt: migratedPrompt, workspaceContextPaths: ['docs'], targetOutputPath: 'reports' });
  assert.equal(updated?.prompt, migratedPrompt, 'An older client resubmitting fields must not duplicate instructions');
  const edited = await updateAutomationJob(scheduled.id, { prompt: 'Only summarize today.' });
  assert.equal(edited?.prompt, 'Only summarize today.', 'Migrated instructions remain editable as ordinary prompt text');
  console.log('automation-path-migration-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => rmSync(dataDir, { recursive: true, force: true }));
