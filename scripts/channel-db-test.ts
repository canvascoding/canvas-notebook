import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-channel-db-'));
process.env.DATA = dataDir;

async function main() {
  const { and, eq } = await import('drizzle-orm');
  const { db } = await import('../app/lib/db');
  const {
    user,
    piSessions,
    piMessages,
    sessionChannelLinks,
    channelActiveSessions,
  } = await import('../app/lib/db/schema');
  const {
    ensureSessionChannelLink,
    findLastActiveExternalLink,
    markChannelLinkOutbound,
  } = await import('../app/lib/channels/channel-links');
  const {
    getActiveChannelSession,
    setActiveChannelSession,
  } = await import('../app/lib/channels/active-sessions');
  const { loadPiSessionByChannelKey } = await import('../app/lib/pi/session-store');

  const now = new Date();
  const userId = 'user-channel-db';
  const linkedSessionId = 'sess-linked';
  const fallbackSessionId = 'sess-legacy';

  await db.insert(user).values({
    id: userId,
    name: 'Channel Tester',
    email: 'channel-tester@example.test',
    emailVerified: true,
    image: null,
    role: null,
    createdAt: now,
    updatedAt: now,
  });

  const [linkedSession] = await db.insert(piSessions).values({
    sessionId: linkedSessionId,
    userId,
    provider: 'test-provider',
    model: 'test-model',
    title: 'Linked Session',
    channelId: 'app',
    channelSessionKey: null,
    createdAt: now,
    updatedAt: now,
  }).returning({ id: piSessions.id });

  await db.insert(piMessages).values({
    piSessionDbId: linkedSession.id,
    role: 'user',
    content: JSON.stringify({ role: 'user', content: 'from linked session', timestamp: now.getTime() }),
    timestamp: now.getTime(),
  });

  await ensureSessionChannelLink({
    sessionId: linkedSessionId,
    userId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:42',
    displayName: 'Telegram DM',
    inboundAt: now,
  });
  await ensureSessionChannelLink({
    sessionId: linkedSessionId,
    userId,
    channelId: 'web',
    channelSessionKey: `web:user:${userId}`,
    isPrimary: true,
    inboundAt: now,
  });

  const linkedRows = await db.query.sessionChannelLinks.findMany({
    where: eq(sessionChannelLinks.sessionId, linkedSessionId),
  });
  assert.equal(linkedRows.length, 2);

  await setActiveChannelSession({
    userId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:42',
    sessionId: linkedSessionId,
  });
  assert.equal(
    await getActiveChannelSession({ channelId: 'telegram', channelSessionKey: 'telegram:42' }),
    linkedSessionId,
  );

  const loadedByLink = await loadPiSessionByChannelKey('telegram', 'telegram:42');
  assert.equal(loadedByLink?.[0]?.role, 'user');
  assert.equal(loadedByLink?.[0]?.content, 'from linked session');

  await markChannelLinkOutbound({
    sessionId: linkedSessionId,
    userId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:42',
    outboundAt: new Date(now.getTime() + 1_000),
  });

  const outboundLink = await db.query.sessionChannelLinks.findFirst({
    where: and(
      eq(sessionChannelLinks.sessionId, linkedSessionId),
      eq(sessionChannelLinks.channelId, 'telegram'),
      eq(sessionChannelLinks.channelSessionKey, 'telegram:42'),
    ),
  });
  assert.ok(outboundLink?.lastOutboundAt instanceof Date);

  const externalLink = await findLastActiveExternalLink(linkedSessionId, 'web');
  assert.equal(externalLink?.channelId, 'telegram');
  assert.equal(externalLink?.channelSessionKey, 'telegram:42');

  const activeRows = await db.query.channelActiveSessions.findMany({
    where: eq(channelActiveSessions.sessionId, linkedSessionId),
  });
  assert.equal(activeRows.length, 1);

  const [fallbackSession] = await db.insert(piSessions).values({
    sessionId: fallbackSessionId,
    userId,
    provider: 'test-provider',
    model: 'test-model',
    title: 'Legacy Fallback Session',
    channelId: 'telegram',
    channelSessionKey: 'telegram:legacy',
    createdAt: now,
    updatedAt: now,
  }).returning({ id: piSessions.id });

  await db.insert(piMessages).values({
    piSessionDbId: fallbackSession.id,
    role: 'user',
    content: JSON.stringify({ role: 'user', content: 'from legacy fallback', timestamp: now.getTime() }),
    timestamp: now.getTime(),
  });

  const loadedByLegacyFallback = await loadPiSessionByChannelKey('telegram', 'telegram:legacy');
  assert.equal(loadedByLegacyFallback?.[0]?.role, 'user');
  assert.equal(
    loadedByLegacyFallback?.[0] && 'content' in loadedByLegacyFallback[0] ? loadedByLegacyFallback[0].content : null,
    'from legacy fallback',
  );

  console.log('channel db tests passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });
