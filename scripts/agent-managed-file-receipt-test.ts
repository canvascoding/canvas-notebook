import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createPiTestDatabase } from './helpers/pi-test-database';

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'canvas-agent-file-receipt-'));
  const database = await createPiTestDatabase();
  const previousData = process.env.DATA;
  process.env.DATA = directory;
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (request, parent, isMain) => {
    if (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request) || /^(?:\.\.\/)+db$/u.test(request)) return database;
    if (request === 'server-only' || request === '@earendil-works/pi-agent-core') return {};
    if (request === '@earendil-works/pi-ai/compat') return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
    if (request === '@earendil-works/pi-ai/oauth') return { getOAuthProvider: () => null };
    return originalLoad(request, parent, isMain);
  };
  try {
    const { user } = await import('../app/lib/db/schema');
    const ownerId = 'agent-file-receipt-owner';
    await database.db.insert(user).values({ id: ownerId, name: 'Receipt fixture owner', email: 'receipt-owner@example.test',
      emailVerified: false, role: 'admin', createdAt: new Date(), updatedAt: new Date() });
    const { createAgentProfile } = await import('../app/lib/agents/registry');
    let agent = await createAgentProfile({ agentId: 'managed-file-receipt-fixture', name: 'Receipt fixture',
      scopeType: 'user', ownerUserId: ownerId, createdByUserId: ownerId });
    const { auth } = await import('../app/lib/auth');
    type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;
    Reflect.set(auth.api, 'getSession', async () => ({ user: { id: ownerId, role: 'admin' },
      session: { id: 'owned-fixture-session', userId: ownerId } }) as Session);
    const route = await import('../app/api/agents/files/route');
    for (const [submitted, expected] of [
      ['# Persönliche Regeln\n\nBehalte αβγ und äöü.', '# Persönliche Regeln\n\nBehalte αβγ und äöü.\n'],
      ['Already terminated.\n', 'Already terminated.\n'],
      ['', ''],
    ]) {
      const response = await route.PUT(new NextRequest('http://localhost:3000/api/agents/files', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: agent.agentId, fileName: 'AGENTS.md', expectedRevision: agent.revision, content: submitted }),
      }));
      const saved = await response.json();
      assert.equal(response.status, 200, JSON.stringify(saved));
      assert.equal(saved.data.agent.revision, agent.revision + 1);
      assert.equal(saved.data.content, expected, 'The save receipt must describe the bytes actually persisted.');
      agent = saved.data.agent;
      const read = await route.GET(new NextRequest(`http://localhost:3000/api/agents/files?agentId=${agent.agentId}`));
      assert.equal(read.status, 200);
      const loaded = await read.json();
      assert.equal(loaded.data.agent.revision, agent.revision);
      assert.equal(loaded.data.files['AGENTS.md'], saved.data.content);
    }
    console.log('Managed-agent save/read receipts agree, including Unicode, existing newline and empty content');
  } finally {
    internals._load = originalLoad;
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
