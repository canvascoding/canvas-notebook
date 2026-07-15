import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-agent-management-api-'));
process.env.DATA = dataDir;

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === '@earendil-works/pi-agent-core') return {};
  if (request === '@earendil-works/pi-ai/compat') {
    return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
  }
  if (request === '@earendil-works/pi-ai/oauth') return { getOAuthProvider: () => null };
  return originalLoad(request, parent, isMain);
};

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const owner = await createInitialOwner({
    name: 'Agent API Owner',
    email: 'agent-api-owner@example.test',
    password: 'OwnerPassword123!',
  });
  const { auth } = await import('../app/lib/auth');
  type RouteSession = Awaited<ReturnType<typeof auth.api.getSession>>;
  let routeSession: RouteSession = null;
  Reflect.set(auth.api, 'getSession', async () => routeSession);
  const agentsRoute = await import('../app/api/agents/route');
  const filesRoute = await import('../app/api/agents/files/route');
  const previewRoute = await import('../app/api/agents/delete-preview/route');

  const unauthorized = await agentsRoute.GET(new NextRequest('http://localhost:3000/api/agents'));
  assert.equal(unauthorized.status, 401);
  routeSession = {
    user: { id: owner.id, email: owner.email, name: owner.name, role: 'admin' },
    session: { id: 'agent-api-session', userId: owner.id },
  } as NonNullable<RouteSession>;

  const createdResponse = await agentsRoute.POST(new NextRequest('http://localhost:3000/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'API Marketing Agent',
      scopeType: 'user',
      enabledTools: ['read', 'web_search'],
      files: { 'AGENTS.md': '# API instructions' },
    }),
  }));
  assert.equal(createdResponse.status, 200);
  const createdPayload = await json<{ data: { agent: { agentId: string; revision: number; scopeType: string } } }>(createdResponse);
  const created = createdPayload.data.agent;
  assert.equal(created.scopeType, 'user');
  assert.equal(created.revision, 1);

  const missingRevision = await agentsRoute.PATCH(new NextRequest('http://localhost:3000/api/agents', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: created.agentId, name: 'No revision' }),
  }));
  assert.equal(missingRevision.status, 400);

  const updatedResponse = await agentsRoute.PATCH(new NextRequest('http://localhost:3000/api/agents', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: created.agentId, expectedRevision: created.revision, name: 'Updated API Agent' }),
  }));
  assert.equal(updatedResponse.status, 200);
  const updated = (await json<{ data: { agent: { agentId: string; revision: number; name: string } } }>(updatedResponse)).data.agent;
  assert.equal(updated.name, 'Updated API Agent');
  assert.equal(updated.revision, 2);

  const fileResponse = await filesRoute.PUT(new NextRequest('http://localhost:3000/api/agents/files', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: created.agentId,
      expectedRevision: updated.revision,
      fileName: 'SOUL.md',
      content: 'Precise and practical.',
    }),
  }));
  assert.equal(fileResponse.status, 200);
  const filePayload = await json<{ data: { agent: { revision: number } } }>(fileResponse);
  assert.equal(filePayload.data.agent.revision, 3);

  const inspectedResponse = await agentsRoute.GET(new NextRequest(
    `http://localhost:3000/api/agents?agentId=${created.agentId}&includeFiles=true`,
  ));
  assert.equal(inspectedResponse.status, 200);
  const inspected = (await json<{ data: { agent: { revision: number }; files: Record<string, string> } }>(inspectedResponse)).data;
  assert.equal(inspected.agent.revision, 3);
  assert.equal(inspected.files['SOUL.md'].trim(), 'Precise and practical.');

  const previewResponse = await previewRoute.POST(new NextRequest('http://localhost:3000/api/agents/delete-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: created.agentId }),
  }));
  assert.equal(previewResponse.status, 200);
  const preview = (await json<{ data: { agent: { revision: number }; confirmationToken: string } }>(previewResponse)).data;
  assert.equal(preview.agent.revision, 3);
  assert.ok(preview.confirmationToken);

  const deletedResponse = await agentsRoute.DELETE(new NextRequest('http://localhost:3000/api/agents', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: created.agentId,
      expectedRevision: preview.agent.revision,
      confirmationToken: preview.confirmationToken,
    }),
  }));
  assert.equal(deletedResponse.status, 200);
  assert.equal((await json<{ data: { deleted: boolean } }>(deletedResponse)).data.deleted, true);

  console.log('agent management API tests passed');
}

main()
  .finally(() => {
    moduleInternals._load = originalLoad;
    rmSync(dataDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
