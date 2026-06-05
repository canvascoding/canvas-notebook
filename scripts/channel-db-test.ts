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
  const {
    createAgentProfile,
    deleteAgentProfile,
    getAgentProfile,
  } = await import('../app/lib/agents/registry');

  const now = new Date();
  const userId = 'user-channel-db';
  const linkedSessionId = 'sess-linked';

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

  const webChannelSessionKey = `web:user:${userId}`;
  const secondWebSessionId = 'sess-second-web';
  const [secondWebSession] = await db.insert(piSessions).values({
    sessionId: secondWebSessionId,
    userId,
    provider: 'test-provider',
    model: 'test-model',
    title: 'Second Web Session',
    channelId: 'app',
    channelSessionKey: null,
    createdAt: now,
    updatedAt: now,
  }).returning({ id: piSessions.id });
  await db.insert(piMessages).values({
    piSessionDbId: secondWebSession.id,
    role: 'user',
    content: JSON.stringify({ role: 'user', content: 'from second web session', timestamp: now.getTime() + 2_000 }),
    timestamp: now.getTime() + 2_000,
  });
  await ensureSessionChannelLink({
    sessionId: secondWebSessionId,
    userId,
    channelId: 'web',
    channelSessionKey: webChannelSessionKey,
    isPrimary: true,
    inboundAt: new Date(now.getTime() + 2_000),
  });

  let webLinks = await db.query.sessionChannelLinks.findMany({
    where: and(
      eq(sessionChannelLinks.userId, userId),
      eq(sessionChannelLinks.channelId, 'web'),
      eq(sessionChannelLinks.channelSessionKey, webChannelSessionKey),
    ),
  });
  assert.equal(webLinks.filter((link) => link.isPrimary).length, 1);
  assert.equal(webLinks.find((link) => link.isPrimary)?.sessionId, secondWebSessionId);

  await setActiveChannelSession({
    userId,
    channelId: 'web',
    channelSessionKey: webChannelSessionKey,
    sessionId: linkedSessionId,
  });
  webLinks = await db.query.sessionChannelLinks.findMany({
    where: and(
      eq(sessionChannelLinks.userId, userId),
      eq(sessionChannelLinks.channelId, 'web'),
      eq(sessionChannelLinks.channelSessionKey, webChannelSessionKey),
    ),
  });
  assert.equal(webLinks.filter((link) => link.isPrimary).length, 1);
  assert.equal(webLinks.find((link) => link.isPrimary)?.sessionId, linkedSessionId);
  const loadedByWebLink = await loadPiSessionByChannelKey('web', webChannelSessionKey);
  assert.equal(loadedByWebLink?.[0]?.role, 'user');
  assert.equal(loadedByWebLink?.[0]?.content, 'from linked session');

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
    where: and(
      eq(channelActiveSessions.sessionId, linkedSessionId),
      eq(channelActiveSessions.channelId, 'telegram'),
    ),
  });
  assert.equal(activeRows.length, 1);

  const missingLegacyFallback = await loadPiSessionByChannelKey('telegram', 'telegram:legacy');
  assert.equal(missingLegacyFallback, null);

  const { savePiSession } = await import('../app/lib/pi/session-store');
  const savedSessionId = 'sess-save-link-only';
  await savePiSession(
    savedSessionId,
    userId,
    'test-provider',
    'test-model',
    [{ role: 'user', content: 'saved via session store', timestamp: now.getTime() }],
    undefined,
    {
      titleOverride: 'Saved Link Only',
      channelId: 'telegram',
      channelSessionKey: 'telegram:stored-link',
    },
  );

  const savedSession = await db.query.piSessions.findFirst({
    where: eq(piSessions.sessionId, savedSessionId),
  });
  assert.equal(savedSession?.channelId, 'app');
  assert.equal(savedSession?.channelSessionKey, null);

  const savedLink = await db.query.sessionChannelLinks.findFirst({
    where: and(
      eq(sessionChannelLinks.sessionId, savedSessionId),
      eq(sessionChannelLinks.channelId, 'telegram'),
      eq(sessionChannelLinks.channelSessionKey, 'telegram:stored-link'),
    ),
  });
  assert.equal(savedLink?.sessionId, savedSessionId);

  const specialAgent = await createAgentProfile({ name: 'Research Agent' });
  assert.equal(specialAgent.agentId, 'research-agent');
  assert.equal(specialAgent.removable, true);
  assert.ok(await getAgentProfile('research-agent'));

  const [specialSession] = await db.insert(piSessions).values({
    sessionId: 'sess-research-agent',
    userId,
    agentId: specialAgent.agentId,
    provider: 'test-provider',
    model: 'test-model',
    title: 'Research Session',
    channelId: 'app',
    channelSessionKey: null,
    createdAt: now,
    updatedAt: now,
  }).returning({ id: piSessions.id });
  await db.insert(piMessages).values({
    piSessionDbId: specialSession.id,
    role: 'user',
    content: JSON.stringify({ role: 'user', content: 'research', timestamp: now.getTime() }),
    timestamp: now.getTime(),
  });
  await ensureSessionChannelLink({
    sessionId: 'sess-research-agent',
    userId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:research',
    inboundAt: now,
  });
  await setActiveChannelSession({
    userId,
    agentId: specialAgent.agentId,
    channelId: 'telegram',
    channelSessionKey: 'telegram:research',
    sessionId: 'sess-research-agent',
  });

  await deleteAgentProfile('research-agent');
  assert.equal(await getAgentProfile('research-agent'), null);
  assert.equal(
    await db.query.piSessions.findFirst({ where: eq(piSessions.sessionId, 'sess-research-agent') }),
    undefined,
  );
  assert.equal(
    await db.query.sessionChannelLinks.findFirst({ where: eq(sessionChannelLinks.sessionId, 'sess-research-agent') }),
    undefined,
  );
  assert.equal(
    await db.query.channelActiveSessions.findFirst({ where: eq(channelActiveSessions.sessionId, 'sess-research-agent') }),
    undefined,
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
