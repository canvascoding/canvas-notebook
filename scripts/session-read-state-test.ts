import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-session-read-state-'));
process.env.DATA = dataDir;

async function main() {
  const { db } = await import('../app/lib/db');
  const { user, piSessions } = await import('../app/lib/db/schema');
  const {
    markPiSessionAsReadForUser,
    markPiSessionAsUnreadForUser,
  } = await import('../app/lib/chat/session-read-state');

  const now = new Date('2026-05-31T12:00:00.000Z');
  const messageAt = new Date('2026-05-31T12:05:00.000Z');
  const readAt = new Date('2026-05-31T12:10:00.000Z');

  await db.insert(user).values([
    {
      id: 'user-read-state',
      name: 'Read State',
      email: 'read-state@example.test',
      emailVerified: true,
      image: null,
      role: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'user-other',
      name: 'Other User',
      email: 'other-read-state@example.test',
      emailVerified: true,
      image: null,
      role: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(piSessions).values([
    {
      sessionId: 'sess-readable',
      userId: 'user-read-state',
      agentId: 'canvas-agent',
      provider: 'test-provider',
      model: 'test-model',
      thinkingLevel: null,
      title: 'Readable Session',
      lastMessageAt: messageAt,
      lastViewedAt: readAt,
      channelId: 'app',
      channelSessionKey: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      sessionId: 'sess-readable',
      userId: 'user-other',
      agentId: 'canvas-agent',
      provider: 'test-provider',
      model: 'test-model',
      thinkingLevel: null,
      title: 'Other User Session',
      lastMessageAt: messageAt,
      lastViewedAt: readAt,
      channelId: 'app',
      channelSessionKey: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      sessionId: 'sess-empty',
      userId: 'user-read-state',
      agentId: 'canvas-agent',
      provider: 'test-provider',
      model: 'test-model',
      thinkingLevel: null,
      title: 'Empty Session',
      lastMessageAt: null,
      lastViewedAt: null,
      channelId: 'app',
      channelSessionKey: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const unread = await markPiSessionAsUnreadForUser({
    sessionId: 'sess-readable',
    userId: 'user-read-state',
    agentId: 'canvas-agent',
    now: new Date('2026-05-31T12:15:00.000Z'),
  });
  assert.equal(unread?.sessionId, 'sess-readable');
  assert.equal(unread?.lastViewedAt, null);
  assert.equal(unread?.hasUnread, true);

  const unreadRow = await db.query.piSessions.findFirst({
    where: eq(piSessions.userId, 'user-read-state'),
  });
  assert.equal(unreadRow?.lastViewedAt, null);

  const otherUserRow = await db.query.piSessions.findFirst({
    where: eq(piSessions.userId, 'user-other'),
  });
  assert.equal(otherUserRow?.lastViewedAt?.toISOString(), readAt.toISOString());

  const read = await markPiSessionAsReadForUser({
    sessionId: 'sess-readable',
    userId: 'user-read-state',
    agentId: 'canvas-agent',
    now: readAt,
  });
  assert.equal(read?.hasUnread, false);
  assert.equal(read?.lastViewedAt?.toISOString(), readAt.toISOString());

  const emptyUnread = await markPiSessionAsUnreadForUser({
    sessionId: 'sess-empty',
    userId: 'user-read-state',
    agentId: 'canvas-agent',
  });
  assert.equal(emptyUnread, null);

  const missingUnread = await markPiSessionAsUnreadForUser({
    sessionId: 'sess-readable',
    userId: 'user-read-state',
    agentId: 'other-agent',
  });
  assert.equal(missingUnread, null);
}

main()
  .then(() => {
    console.log('[Session Read State Test] passed');
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error('[Session Read State Test] failed:', error);
    process.exitCode = 1;
  });
