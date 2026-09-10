import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdtemp, mkdir, writeFile, rename, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { parse } from 'parse5';
import * as schema from '../app/lib/db/schema';
import { runPostgresMigrations } from '../app/lib/db/postgres';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { publicShareToolApps, readBuiltinToolAppMessages, readToolAppInvocations, MAX_BUILTIN_TOOL_APPS } from '../app/lib/tool-apps/types';
import { presentPublicShareAppData, readPublicShareAppData } from '../app/lib/tool-apps/public-share-data';
import { projectAgentMessageForLoadedContext } from '../app/lib/pi/message-projection';
import { projectAgentMessageForPersistence } from '../app/lib/pi/visual-data-projection';

const postgres = new PGlite();
const database = drizzle(postgres, { schema });
let workspace: WorkspaceContext;
let allowed = true;
let signedIn = true;
let toolService: Record<string, unknown> | undefined;
const modules = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = modules._load;
modules._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request.endsWith('/live-runtime')) return {};
  if (request === '@earendil-works/pi-ai/compat' || request === '@earendil-works/pi-ai') return { getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined };
  if (request === '@/app/lib/db' || request === '../db') return { db: database };
  if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => signedIn ? {
    user: { id: 'owner' }, session: { id: 'login', expiresAt: new Date(Date.now() + 60_000) },
  } : null } } };
  if (request.endsWith('/public-file-shares') && parent?.filename.endsWith('/pi/scoped-tools.ts') && toolService) return toolService;
  if (request.endsWith('/mcp/manager')) return { startMcpIdleCleanup: () => undefined };
  if (request.endsWith('/seat-limit')) return { assertUserSeatAccess: async () => undefined };
  if (request.endsWith('/organization/permissions')) return { assertUserOrganizationPermission: async () => { if (!allowed) throw new Error('denied'); } };
  if (request.endsWith('/agents/access')) return { requireAgentAccess: async () => undefined };
  if (request.endsWith('/file-tree-cache')) return { clearFileTreeCache: () => undefined };
  if (request.endsWith('/session-workspace-context')) return { resolveAgentSessionWorkspaceForUser: async () => { if (!allowed) throw new Error('denied'); return workspace; } };
  return originalLoad(request, parent, isMain);
};

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'canvas-share-widget-'));
  process.env.DATA = temp;
  process.env.BASE_URL = 'http://localhost:3000';
  process.env.CANVAS_MCP_APPS_ENABLED = 'true';
  try {
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const rootPath = path.join(temp, 'workspaces/owner');
    await mkdir(rootPath, { recursive: true });
    for (const name of ['one.md', 'two.md']) await writeFile(path.join(rootPath, name), '# Review\n');
    workspace = { workspaceId: 'workspace-1', workspaceType: 'personal', rootPath, rootRelativePath: 'workspaces/owner',
      displayName: 'Owner workspace', status: 'active', ownerUserId: 'owner', organizationId: 'widget-org',
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true }, legacy: false };
    const now = new Date();
    for (const id of ['owner', 'stranger']) await database.insert(schema.user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now });
    await database.insert(schema.canvasOrganizationSettings).values({ organizationId: 'widget-org', ownerUserId: 'owner', deploymentMode: 'standalone', createdAt: now, updatedAt: now });
    await database.insert(schema.canvasWorkspaces).values({ organizationId: 'widget-org', id: workspace.workspaceId, type: 'personal', ownerUserId: 'owner', rootRelativePath: workspace.rootRelativePath!, displayName: workspace.displayName!, createdAt: now, updatedAt: now });
    const service = await import('../app/lib/public-sharing/public-file-shares');
    toolService = { ...service,
      createPublicFileShares: (p: Parameters<typeof service.createPublicFileShares>[0]) => service.createPublicFileShares({ ...p, workspace }),
      listPublicFileShares: (p: Parameters<typeof service.listPublicFileShares>[0]) => service.listPublicFileShares({ ...p, workspace }),
      revokePublicFileShare: (p: Parameters<typeof service.revokePublicFileShare>[0]) => service.revokePublicFileShare({ ...p, workspace }),
    };
    const { createUserScopedTools } = await import('../app/lib/pi/scoped-tools');
    const tool = createUserScopedTools('owner', 'main', 'share-chat').find(t => t.name === 'public_share_file')!;
    const input = { action: 'create', paths: ['one.md', 'two.md'], confirmPublicExposure: true, reason: 'User asked for a public review link' };
    const denied = await tool.execute('denied', { ...input, confirmPublicExposure: false });
    assert.equal(readBuiltinToolAppMessages({ role: 'toolResult', toolName: tool.name, toolCallId: 'denied', ...denied }).length, 0);
    assert.equal((await database.select().from(schema.publicFileShares)).length, 0, 'No publication without confirmation');
    const result = await tool.execute('create-call', input);
    const message = { role: 'toolResult', toolName: tool.name, toolCallId: 'create-call', ...result };
    const apps = readBuiltinToolAppMessages(message);
    assert.equal(apps.length, 2, JSON.stringify(result));
    assert.notEqual(apps[0].entityId, apps[1].entityId);
    const chat = { userId: 'owner', agentId: 'main', sessionId: 'share-chat' };
    const [session] = await database.insert(schema.piSessions).values({ ...chat, workspaceId: workspace.workspaceId, provider: 'test', model: 'test', createdAt: now, updatedAt: now }).returning();
    await database.insert(schema.piMessages).values({ piSessionDbId: session.id, role: 'toolResult', sequence: 1, timestamp: now.getTime(), content: JSON.stringify(message) });
    const { requireBuiltinToolAppAccess } = await import('../app/lib/tool-apps/builtin-access');
    const { POST } = await import('../app/api/chat/tool-apps/route');
    const request = (action: string, app = apps[0]) => new Request('http://localhost:3000/api/chat/tool-apps', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ action, app, ...chat }) }) as Parameters<typeof POST>[0];
    for (const app of apps) {
      assert.equal((await POST(request('render', app))).status, 200);
      const response = await POST(request('refresh', app));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.id, app.entityId);
    }
    const active = await requireBuiltinToolAppAccess(chat, apps[0]);
    assert.equal(readPublicShareAppData(active)?.status, 'active');
    const get = (extra: Partial<Parameters<typeof service.getPublicFileShareForUser>[0]> = {}) => service.getPublicFileShareForUser({ id: apps[0].entityId, userId: 'owner', workspace, baseUrl: 'http://localhost:3000', ...extra });
    await assert.rejects(get({ userId: 'stranger' }), /Forbidden/);
    assert.equal(await get({ workspace: { ...workspace, workspaceId: 'other' } }), null);
    await assert.rejects(get({ workspace: { ...workspace, permissions: { ...workspace.permissions, canRead: false } } }), /Forbidden/);
    const share = (await get())!;
    const safe = presentPublicShareAppData({ ...share, reason: 'never-forward', createdByUserId: 'never-forward' }, workspace.workspaceId);
    assert.ok(!JSON.stringify(safe).includes('never-forward'));
    assert.equal(readPublicShareAppData({ ...safe, publicUrl: 'javascript:alert(1)' }), null);
    assert.equal(readPublicShareAppData({ ...safe, publicUrl: 'https://user:password@example.test/p/Ab123C' }), null);
    assert.equal(readPublicShareAppData({ ...safe, expiresAt: 'invalid' }), null);
    for (const status of ['expired', 'revoked', 'missing', 'stale'] as const) assert.equal(readPublicShareAppData({ ...safe, status })?.publicUrl, null);
    await database.update(schema.publicFileShares).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.publicFileShares.id, apps[0].entityId));
    let fresh = readPublicShareAppData(await requireBuiltinToolAppAccess(chat, apps[0]))!;
    assert.equal(fresh.status, 'expired'); assert.equal(fresh.publicUrl, null);
    await database.update(schema.publicFileShares).set({ expiresAt: null }).where(eq(schema.publicFileShares.id, apps[0].entityId));
    await rename(path.join(rootPath, 'one.md'), path.join(rootPath, 'hidden.md'));
    fresh = readPublicShareAppData(await requireBuiltinToolAppAccess(chat, apps[0]))!;
    assert.equal(fresh.status, 'missing'); assert.equal(fresh.publicUrl, null);
    await writeFile(path.join(rootPath, 'one.md'), '# Different inode\n');
    assert.equal(readPublicShareAppData(await requireBuiltinToolAppAccess(chat, apps[0]))?.status, 'stale');
    const revoked = await tool.execute('revoke-call', { action: 'revoke', shareId: apps[0].entityId });
    assert.equal(readBuiltinToolAppMessages({ role: 'toolResult', toolName: tool.name, toolCallId: 'revoke-call', ...revoked }).length, 1);
    assert.equal(readPublicShareAppData(await requireBuiltinToolAppAccess(chat, apps[0]))?.status, 'revoked');
    const listed = await tool.execute('list-call', { action: 'list', status: 'all' });
    assert.equal(readBuiltinToolAppMessages({ role: 'toolResult', toolName: tool.name, toolCallId: 'list-call', ...listed }).length, 2);
    allowed = false; assert.equal((await POST(request('refresh'))).status, 403); allowed = true;
    signedIn = false; assert.equal((await POST(request('refresh'))).status, 401); signedIn = true;
    await assert.rejects(requireBuiltinToolAppAccess(chat, { ...apps[0], entityId: '99999999-9999-4999-8999-999999999999' }), { status: 403 });
    await assert.rejects(requireBuiltinToolAppAccess({ ...chat, sessionId: 'foreign' }, apps[0]), { status: 403 });
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}` }));
    const descriptors = publicShareToolApps([...many, many[0]], 'many', 'list');
    assert.equal(descriptors.length, MAX_BUILTIN_TOOL_APPS);
    const raw = { role: 'toolResult', toolName: tool.name, toolCallId: 'many', content: [{ type: 'text', text: 'x'.repeat(250_000) }],
      details: { publicShareAction: 'list', shares: many, toolApps: descriptors } };
    const persisted = projectAgentMessageForPersistence(raw as AgentMessage);
    const display = projectAgentMessageForLoadedContext(persisted, 'display');
    assert.equal(readToolAppInvocations(display).length, MAX_BUILTIN_TOOL_APPS);
    assert.ok(JSON.stringify(display).length < 30_000);
    assert.ok(!JSON.stringify(projectAgentMessageForLoadedContext(persisted, 'context')).includes('toolApps'));
    assert.equal(readBuiltinToolAppMessages({ ...raw, isError: true }).length, 0);
    assert.equal(readBuiltinToolAppMessages({ ...raw, details: { ...raw.details, publicShareAction: 'revoke' } }).length, 0);
    assert.equal(readBuiltinToolAppMessages({ ...raw, details: { ...raw.details, shares: [] } }).length, 0);
    const html = await readFile('public/_canvas-tool-apps/public-share-v1.html', 'utf8');
    type Node = { nodeName: string; childNodes?: Node[] };
    const scripts = (node: Node): number => Number(node.nodeName === 'script') + (node.childNodes || []).reduce((sum, child) => sum + scripts(child), 0);
    assert.equal(scripts(parse(html)), 1); assert.ok(Buffer.byteLength(html) < 2 * 1024 * 1024);
    console.log('Public-share widgets: real PostgreSQL/file lifecycle, tools, authorization, refresh and multi-result history passed');
  } finally { modules._load = originalLoad; await postgres.close(); await rm(temp, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
