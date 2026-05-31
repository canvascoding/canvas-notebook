import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';

function getText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((item) => item.type === 'text')?.text || '';
}

function getDetails<T>(result: unknown): T {
  return (result as { details: T }).details;
}

function userMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: 'user',
    content: text,
    timestamp,
  } as AgentMessage;
}

function assistantMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp,
    api: 'test',
    provider: 'test',
    model: 'test',
    stopReason: 'stop',
  } as AgentMessage;
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-pi-session-search-'));
  process.env.DATA = dataDir;

  const moduleLoader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function loadWithServerOnlyMock(request, parent, isMain) {
    if (request === 'server-only') {
      return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { db } = await import('../app/lib/db');
    const { user, piSessions, piMessages } = await import('../app/lib/db/schema');
    const { createSessionSearchTool } = await import('../app/lib/pi/session-search-tool');

    const now = new Date('2026-05-28T10:00:00.000Z');
    await db.insert(user).values([
      {
        id: 'user-1',
        name: 'User One',
        email: 'user1@example.test',
        emailVerified: true,
        image: null,
        role: 'user',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'user-2',
        name: 'User Two',
        email: 'user2@example.test',
        emailVerified: true,
        image: null,
        role: 'user',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const [alphaSession] = await db.insert(piSessions).values({
      sessionId: 'sess-alpha',
      userId: 'user-1',
      agentId: 'canvas-agent',
      provider: 'test-provider',
      model: 'test-model',
      thinkingLevel: null,
      title: 'Alpha launch',
      createdAt: new Date('2026-05-28T10:00:00.000Z'),
      updatedAt: new Date('2026-05-28T10:03:00.000Z'),
      lastMessageAt: new Date('2026-05-28T10:03:00.000Z'),
      channelId: 'app',
      channelSessionKey: null,
    }).returning();
    const [budgetSession] = await db.insert(piSessions).values({
      sessionId: 'sess-budget',
      userId: 'user-1',
      agentId: 'canvas-agent',
      provider: 'test-provider',
      model: 'test-model',
      thinkingLevel: null,
      title: 'Budget planning',
      createdAt: new Date('2026-05-28T09:00:00.000Z'),
      updatedAt: new Date('2026-05-28T09:02:00.000Z'),
      lastMessageAt: new Date('2026-05-28T09:02:00.000Z'),
      channelId: 'app',
      channelSessionKey: null,
    }).returning();
    const [otherAgentSession] = await db.insert(piSessions).values({
      sessionId: 'sess-other-agent',
      userId: 'user-1',
      agentId: 'other-agent',
      provider: 'test-provider',
      model: 'test-model',
      thinkingLevel: null,
      title: 'Other agent alpha',
      createdAt: new Date('2026-05-28T08:00:00.000Z'),
      updatedAt: new Date('2026-05-28T08:01:00.000Z'),
      lastMessageAt: new Date('2026-05-28T08:01:00.000Z'),
      channelId: 'app',
      channelSessionKey: null,
    }).returning();
    const [otherUserSession] = await db.insert(piSessions).values({
      sessionId: 'sess-other-user',
      userId: 'user-2',
      agentId: 'canvas-agent',
      provider: 'test-provider',
      model: 'test-model',
      thinkingLevel: null,
      title: 'Other user alpha',
      createdAt: new Date('2026-05-28T07:00:00.000Z'),
      updatedAt: new Date('2026-05-28T07:01:00.000Z'),
      lastMessageAt: new Date('2026-05-28T07:01:00.000Z'),
      channelId: 'app',
      channelSessionKey: null,
    }).returning();

    await db.insert(piMessages).values([
      {
        piSessionDbId: alphaSession.id,
        role: 'user',
        content: JSON.stringify(userMessage('Can you recover the Alpha launch decision?', 1000)),
        timestamp: 1000,
      },
      {
        piSessionDbId: alphaSession.id,
        role: 'assistant',
        content: JSON.stringify(assistantMessage('The Alpha launch decision was to ship Friday.', 2000)),
        timestamp: 2000,
      },
      {
        piSessionDbId: budgetSession.id,
        role: 'user',
        content: JSON.stringify(userMessage('Budget planning and vendor notes', 3000)),
        timestamp: 3000,
      },
      {
        piSessionDbId: budgetSession.id,
        role: 'assistant',
        content: JSON.stringify(assistantMessage('The vendor notes have no launch keyword.', 4000)),
        timestamp: 4000,
      },
      {
        piSessionDbId: otherAgentSession.id,
        role: 'user',
        content: JSON.stringify(userMessage('Alpha belongs to another agent', 5000)),
        timestamp: 5000,
      },
      {
        piSessionDbId: otherUserSession.id,
        role: 'user',
        content: JSON.stringify(userMessage('Alpha belongs to another user', 6000)),
        timestamp: 6000,
      },
    ]);

    const [anchor] = await db.insert(piMessages).values({
      piSessionDbId: alphaSession.id,
      role: 'assistant',
      content: JSON.stringify(assistantMessage('Anchor details for Alpha post-launch followup.', 7000)),
      timestamp: 7000,
    }).returning();

    const tool = createSessionSearchTool({ userId: 'user-1', agentId: 'canvas-agent' });

    const browseResult = await tool.execute('browse', {});
    assert.match(getText(browseResult), /Recent sessions/);
    const browseDetails = getDetails<{ mode: string; sessions: Array<{ session_id: string }> }>(browseResult);
    assert.equal(browseDetails.mode, 'browse');
    assert.deepEqual(
      browseDetails.sessions.map((session) => session.session_id),
      ['sess-alpha', 'sess-budget'],
    );

    const discoveryResult = await tool.execute('discovery', { query: 'Alpha', limit: 5 });
    assert.match(getText(discoveryResult), /sess-alpha/);
    const discoveryDetails = getDetails<{
      mode: string;
      results: Array<{ session: { session_id: string }; match_message_id: number; messages: Array<{ anchor?: boolean }> }>;
    }>(discoveryResult);
    assert.equal(discoveryDetails.mode, 'discovery');
    assert.deepEqual(
      discoveryDetails.results.map((result) => result.session.session_id),
      ['sess-alpha'],
    );
    assert.equal(discoveryDetails.results[0].messages.some((message) => message.anchor), true);

    const scrollResult = await tool.execute('scroll', {
      session_id: 'sess-alpha',
      around_message_id: anchor.id,
      window: 1,
    });
    const scrollDetails = getDetails<{ mode: string; messages: Array<{ id: number; anchor?: boolean; text: string }> }>(scrollResult);
    assert.equal(scrollDetails.mode, 'scroll');
    assert.equal(scrollDetails.messages.some((message) => message.id === anchor.id && message.anchor), true);
    assert.equal(scrollDetails.messages.some((message) => /Anchor details/.test(message.text)), true);

    const otherAgentTool = createSessionSearchTool({ userId: 'user-1', agentId: 'other-agent' });
    const otherAgentResult = await otherAgentTool.execute('other-agent', { query: 'Alpha', limit: 5 });
    const otherAgentDetails = getDetails<{ results: Array<{ session: { session_id: string } }> }>(otherAgentResult);
    assert.deepEqual(
      otherAgentDetails.results.map((result) => result.session.session_id),
      ['sess-other-agent'],
    );

    const missingUserTool = createSessionSearchTool({ agentId: 'canvas-agent' });
    assert.match(getText(await missingUserTool.execute('missing-user', {})), /User ID is required/);

    console.log('pi-session-search-tool-test: ok');
  } finally {
    moduleLoader._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
