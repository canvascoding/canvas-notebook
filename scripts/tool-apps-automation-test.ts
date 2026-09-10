import assert from 'node:assert/strict';
import Module from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../app/lib/db/schema';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import { automationToolApp, readBuiltinToolAppMessage } from '../app/lib/tool-apps/types';

process.env.BASE_URL = 'http://localhost:3000';
process.env.CANVAS_MCP_APPS_ENABLED = 'true';

const postgres = new PGlite();
const database = drizzle(postgres, { schema });
let allowed = true;
let busy = false;
let seat = true;
let providerFails = false;
let providerCalls = 0;
let audits = 0;
let invalidations = 0;
let signedIn = true;
let scopedToolStore: Record<string, unknown> | undefined;
const modules = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = modules._load;
modules._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@earendil-works/pi-ai/compat' || request === '@earendil-works/pi-ai') return {
    getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined,
  };
  if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => signedIn
    ? { user: { id: 'owner' }, session: { id: 'login', expiresAt: new Date(Date.now() + 60_000) } } : null } } };
  if (request === '@/app/lib/db' || request === '../db') return { db: database };
  if (request.endsWith('/automations/store') && parent?.filename.endsWith('/pi/scoped-tools.ts') && scopedToolStore) return scopedToolStore;
  if (request.endsWith('automations/policy') || request === './policy' && parent?.filename.endsWith('/automations/job-actions.ts')) return {
    assertCanAccessAutomationJob: async (userId: string) => { if (!allowed || userId === 'stranger') throw new Error('denied'); },
  };
  if (request.endsWith('/server-settings')) return { getServerPreferredTimeZone: async () => 'Europe/Berlin' };
  if (request.endsWith('/composio-context')) return { resolveBoundComposioContext: async () => ({}) };
  if (request.endsWith('/composio-gateway')) return { prepareGatewayTriggerUpdate: async () => async () => {
    providerCalls += 1;
    if (providerFails) throw new Error('provider failed');
  } };
  if (request.endsWith('/audit-service')) return { recordAuditEvent: async () => { audits += 1; } };
  if (request.endsWith('/seat-limit')) return { assertUserSeatAccess: async () => { if (!seat) throw new Error('no seat'); } };
  if (request.endsWith('/apps-host')) return { requireMcpAppChatAccess: async () => { if (!allowed) throw new Error('chat denied'); } };
  if (request.endsWith('/live-runtime')) return { getExistingPiRuntime: async () => ({ getStatus: () => ({ phase: busy ? 'streaming' : 'idle',
    canAbort: busy, pendingToolCalls: 0, followUpQueue: [], steeringQueue: [] }) }),
    invalidatePiRuntime: async () => { invalidations += 1; } };
  if (request.endsWith('/runtime-event-emitter')) return { getPiRuntimeEventEmitter: () => ({ emitEvent: () => {} }) };
  return originalLoad(request, parent, isMain);
};

async function main() {
  await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
  const { getAutomationJob } = await import('../app/lib/automations/store');
  const { updateAutomationJobForUser } = await import('../app/lib/automations/job-actions');
  const { changeAutomationAppStatus } = await import('../app/lib/tool-apps/automation-actions');
  const now = new Date();
  await database.insert(schema.user).values({ id: 'owner', name: 'Owner', email: 'widget@example.test', emailVerified: true, createdAt: now, updatedAt: now });
  const id = 'job-11111111-1111-4111-8111-111111111111';
  const app = automationToolApp(id, 'tool-create', 'create_automation_job');
  await database.insert(schema.automationJobs).values({ id, name: 'Widget test', status: 'active', prompt: 'Private prompt', preferredSkill: 'auto',
    ownerUserId: 'owner', responsibleUserId: 'owner', createdByUserId: 'owner', workspaceContextPathsJson: '[]',
    scheduleKind: 'daily', scheduleConfigJson: JSON.stringify({ kind: 'daily', times: ['09:00'], timeZone: 'Europe/Berlin' }),
    timeZone: 'Europe/Berlin', createdAt: now, updatedAt: now, composioTriggerId: 'private-trigger' });
  const chat = { userId: 'owner', agentId: 'main', sessionId: 'widget-chat' };
  const [session] = await database.insert(schema.piSessions).values({ ...chat, provider: 'test', model: 'test', createdAt: now, updatedAt: now }).returning();
  await database.insert(schema.piMessages).values({ piSessionDbId: session.id, role: 'toolResult', sequence: 1, timestamp: now.getTime(),
    content: JSON.stringify({ role: 'toolResult', toolCallId: app.toolCallId, toolName: app.operation, details: { toolApp: app, job: { id } } }) });

  const { POST } = await import('../app/api/chat/tool-apps/route');
  const statusRequest = (extra: Record<string, unknown> = {}, origin = 'http://localhost:3000') => new Request('http://localhost:3000/api/chat/tool-apps', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...chat, app,
      action: 'status', status: 'paused', expectedRevision: 1, expectedUpdatedAt: now.toISOString(), locale: 'de', ...extra }),
  }) as Parameters<typeof POST>[0];
  signedIn = false; assert.equal((await POST(statusRequest())).status, 401); signedIn = true;
  assert.equal((await POST(statusRequest({}, 'https://other.example'))).status, 403);
  assert.equal((await POST(statusRequest({ action: 'run_now' }))).status, 400);
  assert.equal((await POST(statusRequest({ expectedUpdatedAt: null }))).status, 400);
  assert.equal((await POST(statusRequest({ status: 'deleted' }))).status, 400);

  scopedToolStore = { ...await import('../app/lib/automations/store'), createAutomationJob: async () => getAutomationJob(id) };
  const { createUserScopedTools } = await import('../app/lib/pi/scoped-tools');
  const actualTools = createUserScopedTools('owner', 'widget-agent', chat.sessionId);
  for (const name of ['inspect_automation_job', 'create_automation_job', 'update_automation_job']) {
    const tool = actualTools.find((candidate) => candidate.name === name)!;
    assert.ok(tool);
    const result = await tool.execute(`actual-${name}`, name === 'create_automation_job'
      ? { name: 'New automation', prompt: 'Test', schedule: { kind: 'daily', time: '09:00' } } : { jobId: id, status: 'active' });
    assert.ok(readBuiltinToolAppMessage({ role: 'toolResult', toolName: name, toolCallId: `actual-${name}`, ...result }), `${name} must return its registered widget after success`);
  }

  const statusCode = (expected: number) => (error: unknown) => (error as { status?: number }).status === expected;
  busy = true;
  await assert.rejects(changeAutomationAppStatus(chat, app, 'paused', 1, 'de'), statusCode(409));
  assert.equal(providerCalls, 0); assert.equal(invalidations, 0);
  busy = false;
  const pausedResponse = await POST(statusRequest());
  assert.equal(pausedResponse.status, 200);
  const paused = (await pausedResponse.json()).data;
  assert.equal(paused.status, 'paused'); assert.equal(paused.revision, 2); assert.equal(providerCalls, 1); assert.equal(audits, 1);
  assert.ok(!JSON.stringify(paused).includes('private-trigger')); assert.ok(!JSON.stringify(paused).includes('Private prompt'));
  let history = await database.select().from(schema.piMessages);
  assert.equal(history.length, 2); assert.equal(history[1].sequence, 2); assert.match(history[1].content, /bereits ausgeführt/);
  await assert.rejects(changeAutomationAppStatus(chat, app, 'paused', 1, 'de'), statusCode(409));
  assert.equal(providerCalls, 1); assert.equal((await database.select().from(schema.piMessages)).length, 2);
  await changeAutomationAppStatus(chat, app, 'paused', 2, 'de');
  assert.equal(providerCalls, 1); assert.equal(audits, 1); assert.equal((await getAutomationJob(id))?.revision, 2);

  providerFails = true;
  await assert.rejects(changeAutomationAppStatus(chat, app, 'active', 2, 'en'), /provider failed/);
  assert.equal((await getAutomationJob(id))?.status, 'paused');
  assert.equal((await database.select().from(schema.piMessages)).length, 2, 'failed provider must roll back the chat event');
  providerFails = false;
  const beforeCalls = providerCalls;
  const race = await Promise.allSettled([
    updateAutomationJobForUser(id, { status: 'active' }, 'owner', { expectedRevision: 2 }),
    updateAutomationJobForUser(id, { status: 'active' }, 'owner', { expectedRevision: 2 }),
  ]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(providerCalls, beforeCalls + 1, 'concurrent writers must perform one provider update');
  assert.equal((await getAutomationJob(id))?.revision, 3);
  await assert.rejects(changeAutomationAppStatus(chat, app, 'paused', 3, 'de', now.toISOString()), statusCode(409));

  await assert.rejects(updateAutomationJobForUser(id, { status: 'paused' }, 'admin', { expectedRevision: 3 }), statusCode(409));
  await assert.rejects(updateAutomationJobForUser(id, { status: 'paused' }, 'stranger', { expectedRevision: 3 }), statusCode(404));
  allowed = false;
  await assert.rejects(changeAutomationAppStatus(chat, app, 'paused', 3, 'de'));
  allowed = true; seat = false;
  await assert.rejects(changeAutomationAppStatus(chat, app, 'paused', 3, 'de'));
  seat = true;
  await assert.rejects(changeAutomationAppStatus({ ...chat, sessionId: 'foreign' }, app, 'paused', 3, 'de'), statusCode(403));
  await assert.rejects(changeAutomationAppStatus(chat, { ...app, entityId: 'job-22222222-2222-4222-8222-222222222222' }, 'paused', 3, 'de'), statusCode(403));
  await assert.rejects(updateAutomationJobForUser(id, { scope: 'organization' }, 'owner'), statusCode(400));
  await assert.rejects(updateAutomationJobForUser(id, { status: 'deleted' }, 'owner'), statusCode(400));
  await assert.rejects(updateAutomationJobForUser(id, { schedule: { kind: 'daily', times: ['99:99'] }, status: 'paused' }, 'owner'));
  assert.equal(providerCalls, beforeCalls + 1);

  await database.update(schema.piMessages).set({ sequence: 7 }).where(eq(schema.piMessages.sequence, 2));
  await assert.rejects(changeAutomationAppStatus(chat, app, 'paused', 3, 'de'), statusCode(409));
  assert.equal((await getAutomationJob(id))?.status, 'active');
  assert.equal(providerCalls, beforeCalls + 1);
  await database.update(schema.piMessages).set({ sequence: 2 }).where(eq(schema.piMessages.sequence, 7));
  await database.update(schema.automationJobs).set({ deletedAt: new Date() }).where(eq(schema.automationJobs.id, id));
  await assert.rejects(changeAutomationAppStatus(chat, app, 'paused', 3, 'de'), statusCode(404));
  history = await database.select().from(schema.piMessages);
  assert.equal(history.length, 2);
  console.log('tool apps automation transaction, permissions, conflicts and history tests passed');
}
void main().finally(async () => { modules._load = originalLoad; await postgres.close(); })
  .catch((error) => { console.error(error); process.exitCode = 1; });
