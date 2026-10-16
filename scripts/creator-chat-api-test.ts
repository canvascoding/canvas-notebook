import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { deriveChatBodySelection, projectChatBodyText } from '../app/lib/chat/chat-body-contracts';
import { capabilityPackageCreatorChatSchema, capabilityPackageCreatorOptionsSchema } from '../app/lib/capabilities/packages/creator-chat-contracts';

/** Actual SQL, package services, fresh Core Options and routes; only the authenticated cookie boundary is controlled. */
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-creator-chat-'));
  const environment = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_ORGANIZATION_ID: 'creator-entry-org',
    CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', QMD_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
    CANVAS_PLUGIN_STORE_REGISTRY_URL: pathToFileURL(path.join(root, 'store.json')).href, BASE_URL: 'http://localhost:3000' };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]])); Object.assign(process.env, environment);
  const database = await createPiTestDatabase(), raw = await database.openDb();
  const loader = Module as typeof Module & { _load(name: string, parent: NodeModule | null, main: boolean): unknown };
  const original = loader._load, originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Creator entry needs no provider or network request.'); };
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return database;
    if (name === '@/app/lib/auth') return { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
      const id = headers.get('x-fixture-user'); return id ? { user: { id }, session: { id: `session-${id}` } } : null;
    } } } };
    if (name === '@earendil-works/pi-ai' || name === '@earendil-works/pi-ai/compat') return {
      getModels: () => [], getProviders: () => [], registerBuiltInApiProviders: () => undefined, isContextOverflow: () => false,
    };
    return original(name, parent, isMain);
  };
  try {
    await fs.writeFile(path.join(root, 'store.json'), JSON.stringify({ schemaVersion: 1, id: 'creator-entry-store', name: 'Fixture', updatedAt: '2026-10-16', plugins: [], skills: [] }));
    for (const id of ['owner', 'admin', 'member']) {
      await raw.run('INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,\'user\',0,1000,1000)', [id, `${id}@creator-entry.example.test`]);
    }
    await raw.run("INSERT INTO canvas_organization_settings (organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES ('creator-entry-org','owner','team',1,1000,1000)");
    for (const id of ['owner', 'admin', 'member']) {
      await raw.run("INSERT INTO organization_user_permissions (organization_id,user_id,role,status,can_share_plugins_and_skills,created_at,updated_at) VALUES ('creator-entry-org',$1,$2,'active',$3,1000,1000)", [id, id, Number(id !== 'member')]);
      await raw.run("INSERT INTO canvas_workspaces (id,organization_id,type,owner_user_id,root_relative_path,display_name,status,created_at,updated_at) VALUES ($1,'creator-entry-org','personal',$2,$1,$2,'active',1000,1000)", [`personal-${id}`, id]);
    }
    const { DEFAULT_PI_CONFIG } = await import('../app/lib/pi/config');
    const { writePiRuntimeConfig } = await import('../app/lib/agents/storage');
    await writePiRuntimeConfig({ ...DEFAULT_PI_CONFIG, runtimeMigrations: { skillToolsDefaultEnabled: true } });
    const { GET, POST } = await import('../app/api/capabilities/packages/creator/route');
    const { NextRequest } = await import('next/server');
    const request = (user: string | null, operation?: unknown, query = `workspaceId=personal-${user}`) => new NextRequest(`http://localhost/api/capabilities/packages/creator?${query}`, {
      method: operation === undefined ? 'GET' : 'POST', headers: { ...(user ? { 'x-fixture-user': user } : {}), 'Content-Type': 'application/json' },
      ...(operation === undefined ? {} : { body: JSON.stringify(operation) }),
    });
    assert.equal((await GET(request(null))).status, 401);
    const optionsResponse = await GET(request('owner')); assert.equal(optionsResponse.status, 200, await optionsResponse.clone().text());
    assert.match(optionsResponse.headers.get('Cache-Control') ?? '', /no-store/);
    const options = capabilityPackageCreatorOptionsSchema.parse((await optionsResponse.json()).data);
    assert(options.canCreate && options.creators.every(creator => creator.available));
    assert.equal(options.ownership?.organizationId, 'creator-entry-org');
    const member = await GET(request('member')); assert.equal(member.status, 200);
    assert.equal(capabilityPackageCreatorOptionsSchema.parse((await member.json()).data).canCreate, false);
    assert.equal((await POST(request('member', { operation: 'create', kind: 'plugin' }))).status, 403);
    const count = async (table: string) => (await raw.get(`SELECT COUNT(*)::integer AS count FROM ${table}`) as { count: number }).count;
    const before = { sessions: await count('pi_sessions'), drafts: await count('capability_package_drafts'), versions: await count('capability_package_versions') };
    for (const kind of ['plugin', 'skill'] as const) {
      const response = await POST(request('owner', { operation: 'create', kind, locale: 'de' }));
      assert.equal(response.status, 200, await response.clone().text());
      const data = capabilityPackageCreatorChatSchema.parse((await response.json()).data);
      assert.equal(data.mode, 'compose'); assert.equal(data.prompt, projectChatBodyText(data.body));
      const selection = deriveChatBodySelection(data.body)?.selections[0]?.selection;
      assert.equal(selection?.kind, kind === 'plugin' ? 'core_plugin' : 'core_skill');
      assert(selection && 'coreSource' in selection); assert.equal('package' in selection, false, 'Core references never invent an SQL pin.');
      assert.equal(data.workspaceId, 'personal-owner'); assert.equal(data.draftRef, undefined);
      assert(!JSON.stringify(data).includes(root), 'The public handoff contains no server roots or file bytes.');
    }
    assert.deepEqual({ sessions: await count('pi_sessions'), drafts: await count('capability_package_drafts'), versions: await count('capability_package_versions') }, before,
      'Opening a Creator composes a message without creating or publishing a resource or Session.');
    for (const intent of [{ operation: 'create', kind: 'plugin', actorUserId: 'owner' }, { operation: 'create', kind: 'plugin', ownership: { type: 'user' } },
      { operation: 'create', kind: 'plugin', body: {} }, { operation: 'resume', draftRef: 'invalid' }]) assert.equal((await POST(request('owner', intent))).status, 400);
    for (const query of ['workspaceId=personal-owner&workspaceId=personal-owner', 'workspaceId=personal-owner&organizationId=forged', '']) {
      assert.equal((await GET(request('owner', undefined, query))).status, 400);
    }
    assert.equal((await GET(request('owner', undefined, 'workspaceId=personal-member'))).status, 403);
    const admin = await GET(request('admin')); assert.equal(admin.status, 200);
    assert(capabilityPackageCreatorOptionsSchema.parse((await admin.json()).data).canCreate);
    await raw.run("UPDATE organization_user_permissions SET can_share_plugins_and_skills=0 WHERE user_id='admin'");
    assert.equal((await POST(request('admin', { operation: 'create', kind: 'skill' }))).status, 403, 'A prior button state cannot bypass current creation rights.');
    const packages = await import('../app/lib/capabilities/packages/actions');
    const draft = await packages.createCapabilityPackageDraftAction({ userId: 'owner', workspaceId: 'personal-owner' },
      { operation: 'create', kind: 'plugin', targetName: 'creator-resume-target', requestId: randomUUID() });
    const resumed = await POST(request('owner', { operation: 'resume', draftRef: draft.draftRef }));
    assert.equal(resumed.status, 200, await resumed.clone().text());
    const resumedData = capabilityPackageCreatorChatSchema.parse((await resumed.json()).data);
    assert.equal(resumedData.draftRef, draft.draftRef); assert.equal(resumedData.kind, 'plugin');
    assert(resumedData.prompt.includes(draft.draftRef));
    assert.equal((await POST(request('member', { operation: 'resume', draftRef: draft.draftRef }))).status, 404);
    assert.equal(networkCalls, 0);
    console.log('PASS Creator entry API: actual fresh CorePlugin/CoreSkill inline selections, scoped creation rights, strict actor/context, private same-draft resume and zero Session/message/provider/publication mutations.');
  } finally {
    loader._load = original; globalThis.fetch = originalFetch; await database.close(); await fs.rm(root, { recursive: true, force: true });
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
