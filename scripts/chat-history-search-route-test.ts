import assert from 'node:assert/strict';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-chat-history-search-'));
  process.env.DATA = dataDir;
  let authenticated = true;

  const moduleLoader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = function loadWithRouteMocks(request, parent, isMain) {
    if (request === 'server-only') return {};
    if (request.endsWith('/app/lib/auth') || request === '@/app/lib/auth') {
      return {
        auth: {
          api: {
            getSession: async () => authenticated ? { user: { id: 'user-1' } } : null,
          },
        },
      };
    }
    if (request.endsWith('/app/lib/agents/access') || request === '@/app/lib/agents/access') {
      return {
        listAgentAccessForUser: async () => new Map([['canvas-agent', { canUse: true }]]),
        requireAgentAccess: async () => ({ canUse: true }),
      };
    }
    if (request.endsWith('/app/lib/pi/session-workspace-context') || request === '@/app/lib/pi/session-workspace-context') {
      return {
        resolveAgentSessionWorkspaceForUser: async () => ({
          workspaceId: 'workspace-current',
          workspaceType: 'personal',
        }),
        storedPiSessionWorkspaceToSummary: () => null,
      };
    }
    if (request.endsWith('/app/lib/db/legacy-ai-tables') || request === '@/app/lib/db/legacy-ai-tables') {
      return { legacyAiTablesExist: async () => false };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { db } = await import('../app/lib/db');
    const { piMessages, piSessions, user } = await import('../app/lib/db/schema');
    const { GET } = await import('../app/api/sessions/search/route');
    const now = new Date('2026-09-04T10:00:00.000Z');

    await db.insert(user).values([
      {
        id: 'user-1',
        name: 'Search User',
        email: 'search@example.test',
        emailVerified: true,
        image: null,
        role: 'user',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'user-2',
        name: 'Other User',
        email: 'other@example.test',
        emailVerified: true,
        image: null,
        role: 'user',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const [titleSession] = await db.insert(piSessions).values({
      sessionId: 'sess-title',
      userId: 'user-1',
      agentId: 'canvas-agent',
      provider: 'test',
      model: 'test',
      title: 'Quarterly launch',
      workspaceId: 'workspace-current',
      workspaceType: 'personal',
      createdAt: new Date('2026-09-01T10:00:00.000Z'),
      updatedAt: new Date('2026-09-01T10:01:00.000Z'),
      lastMessageAt: new Date('2026-09-01T10:01:00.000Z'),
      channelId: 'app',
    }).returning();
    const [contentSession] = await db.insert(piSessions).values({
      sessionId: 'sess-content',
      userId: 'user-1',
      agentId: 'canvas-agent',
      provider: 'test',
      model: 'test',
      title: 'Creative review',
      workspaceId: 'workspace-current',
      workspaceType: 'personal',
      createdAt: new Date('2026-09-04T09:00:00.000Z'),
      updatedAt: new Date('2026-09-04T09:01:00.000Z'),
      lastMessageAt: new Date('2026-09-04T09:01:00.000Z'),
      channelId: 'app',
    }).returning();
    const [otherWorkspaceSession] = await db.insert(piSessions).values({
      sessionId: 'sess-other-workspace',
      userId: 'user-1',
      agentId: 'canvas-agent',
      provider: 'test',
      model: 'test',
      title: 'Hidden session',
      workspaceId: 'workspace-other',
      workspaceType: 'personal',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      channelId: 'app',
    }).returning();

    await db.insert(piMessages).values([
      {
        piSessionDbId: titleSession.id,
        role: 'user',
        content: JSON.stringify({ role: 'user', content: 'No matching body here.', timestamp: 1 }),
        timestamp: 1,
        sequence: 1,
      },
      {
        piSessionDbId: contentSession.id,
        role: 'assistant',
        content: JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'The quarterly campaign uses blue.' }], timestamp: 2 }),
        timestamp: 2,
        sequence: 1,
      },
      {
        piSessionDbId: contentSession.id,
        role: 'toolResult',
        content: JSON.stringify({ role: 'toolResult', content: [{ type: 'text', text: 'quarterly tool-only hit' }], timestamp: 3 }),
        timestamp: 3,
        sequence: 2,
      },
      {
        piSessionDbId: otherWorkspaceSession.id,
        role: 'user',
        content: JSON.stringify({ role: 'user', content: 'quarterly secret', timestamp: 4 }),
        timestamp: 4,
        sequence: 1,
      },
    ]);

    const response = await GET(new NextRequest(
      'http://localhost/api/sessions/search?query=quarterly&agentId=all&workspaceId=workspace-current',
    ));
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      success: boolean;
      results: Array<{ session: { sessionId: string }; match: { kind: string; snippet?: string } }>;
    };
    assert.equal(payload.success, true);
    assert.deepEqual(payload.results.map((result) => result.session.sessionId), ['sess-title', 'sess-content']);
    assert.deepEqual(payload.results.map((result) => result.match.kind), ['title', 'content']);
    assert.match(payload.results[1].match.snippet || '', /quarterly campaign/i);
    assert.equal(payload.results.some((result) => result.session.sessionId === 'sess-other-workspace'), false);

    authenticated = false;
    const unauthorized = await GET(new NextRequest('http://localhost/api/sessions/search?query=quarterly'));
    assert.equal(unauthorized.status, 401);

    console.log('chat-history-search-route-test: ok');
  } finally {
    moduleLoader._load = originalLoad;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
