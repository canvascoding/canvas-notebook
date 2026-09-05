import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-automation-chats-'));
process.env.DATA = dataDir;
process.env.CANVAS_DATA_ROOT = dataDir;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

async function main() {
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
  const { piSessions, user } = await import('../app/lib/db/schema');
  const { eq } = await import('drizzle-orm');
  const { createAutomationJob, updateAutomationJob } = await import('../app/lib/automations/store');
  const { listAutomationChatTargets, assertAutomationChatTarget } = await import('../app/lib/automations/chat-targets');
  const job = await createAutomationJob({ name: 'Chat test', prompt: 'Summarize', schedule: { kind: 'daily', times: ['09:00'], timeZone: 'UTC' } }, 'path-owner');
  const context = { userId: 'path-owner', agentId: job.agentId, workspaceId: job.workspaceId! };
  const now = new Date();
  await db.insert(user).values({ id: 'other', name: 'Other', email: 'other@example.test', emailVerified: true, createdAt: now, updatedAt: now });
  const row = { ...context, provider: 'test', model: 'test', workspaceType: 'personal', createdAt: now, updatedAt: now };
  for (let i = 0; i < 35; i++) {
    await db.insert(piSessions).values({ ...row, sessionId: `chat-${i}`, title: `Project ${i}` });
  }
  await db.insert(piSessions).values([
    { ...row, sessionId: 'archived', title: 'Project archived', archivedAt: now },
    { ...row, sessionId: 'worker', title: 'Project worker', sessionKind: 'delegation_worker' },
    { ...row, sessionId: 'wrong-agent', title: 'Project wrong agent', agentId: 'other-agent' },
    { ...row, sessionId: 'wrong-user', title: 'Project private', userId: 'other' },
    { ...row, sessionId: 'wrong-workspace', title: 'Project elsewhere', workspaceId: 'elsewhere', workspaceType: 'organization' },
    { ...row, sessionId: 'literal', title: '100%_complete' },
    { ...row, sessionId: 'legacy', title: 'Legacy', workspaceId: null },
  ]);
  const first = await listAutomationChatTargets(context);
  assert.equal(first.chats.length, 30);
  assert.ok(first.nextCursor);
  const second = await listAutomationChatTargets({ ...context, cursor: first.nextCursor! });
  const ids = [...first.chats, ...second.chats].map((chat) => chat.sessionId);
  assert.equal(new Set(ids).size, 37);
  assert.equal(second.nextCursor, null);
  for (const id of ['archived', 'worker', 'wrong-agent', 'wrong-user', 'wrong-workspace']) assert.ok(!ids.includes(id));
  assert.deepEqual((await listAutomationChatTargets({ ...context, query: '%_' })).chats.map((chat) => chat.sessionId), ['literal']);
  assert.deepEqual((await listAutomationChatTargets({ ...context, sessionId: 'chat-1' })).chats.map((chat) => chat.sessionId), ['chat-1']);
  const target = { ...context, workspaceType: 'personal' as const, deliverySessionMode: 'fixed_session' as const };
  await assertAutomationChatTarget({ ...target, deliverySessionId: 'chat-1' });
  await assertAutomationChatTarget({ ...target, deliverySessionId: 'legacy' });
  for (const id of ['', 'missing', 'archived', 'worker', 'wrong-agent', 'wrong-user', 'wrong-workspace']) {
    await assert.rejects(assertAutomationChatTarget({ ...target, deliverySessionId: id }), /selected chat is no longer available/);
  }
  await assert.rejects(updateAutomationJob(job.id, { deliverySessionMode: 'fixed_session', deliverySessionId: 'wrong-workspace' }, { actorUserId: 'path-owner' }), /selected chat/);
  await updateAutomationJob(job.id, { deliverySessionMode: 'fixed_session', deliverySessionId: 'chat-1' }, { actorUserId: 'path-owner' });
  await db.delete(piSessions).where(eq(piSessions.sessionId, 'chat-1'));
  await assert.rejects(updateAutomationJob(job.id, { status: 'active' }), /selected chat/);
  assert.equal((await updateAutomationJob(job.id, { status: 'paused' }))?.status, 'paused', 'Invalid targets must still be pausable');
  assert.equal((await updateAutomationJob(job.id, { deliverySessionMode: 'new_session', deliverySessionId: null }))?.deliverySessionMode, 'new_session');
  await assert.rejects(createAutomationJob({ name: 'Invalid', prompt: 'Task', schedule: job.schedule, deliverySessionMode: 'fixed_session', deliverySessionId: 'missing' }, 'path-owner'), /selected chat/);
  console.log('automation-chat-target-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => rmSync(dataDir, { recursive: true, force: true }));
