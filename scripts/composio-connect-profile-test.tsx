import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { JSDOM, VirtualConsole } from 'jsdom';
import React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { createSharedConnectionTestDatabase } from './helpers/shared-connection-test-database';
import type { ResolvedComposioContext } from '../app/lib/composio/composio-context';
import type { PluginExtensionItem } from '../app/lib/plugins/plugin-extension-contracts';

// Actual SQL profiles/ownership/workspace/auth, actual connect route + gateway +
// OAuth-state persistence, and actual setup React. Only the external Composio
// SDK/session transport and UI catalogue metadata are controlled. No HTTP
// server, browser, container, business tool or live provider is started.
async function main() {
  const native = process.argv.includes('--native');
  if (native) { assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST, '1'); }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-connect-profile-'));
  const engine = native ? await createSharedConnectionTestDatabase() : { ...await createPiTestDatabase(), native: false };
  if (native) assert.equal(engine.native, true);
  const sql = await engine.openDb(), organizationId = 'connect-profile-org', workspaceId = 'connect-profile-workspace';
  const env = { DATA: root, CANVAS_DATA_ROOT: root, CANVAS_INSTANCE_ID: 'connect-profile-fixture', CANVAS_ORGANIZATION_ID: organizationId,
    BASE_URL: 'http://localhost:3001', BETTER_AUTH_BASE_URL: 'http://localhost:3001', AUTH_SECRET: randomBytes(32).toString('hex'),
    INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), CANVAS_MANAGED_SERVICES_ENABLED: 'false', NODE_ENV: 'test' };
  const oldEnv = new Map(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, isMain: boolean) => unknown;
    _resolveFilename: (name: string, parent: NodeModule | null) => string };
  const originalLoad = loader._load, originalFetch = globalThis.fetch, modules = new Map<string, unknown>();
  const authorized: Array<{ context: ResolvedComposioContext; toolkit: string; callbackUrl: string }> = [];
  let cleanupUi: (() => void) | undefined;
  loader._load = (name, parent, isMain) => {
    if (name === 'server-only') return {};
    if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return engine;
    if (modules.has(name)) return modules.get(name);
    const parentPath = parent?.filename ?? '';
    if (parentPath.includes('/app/lib/composio/')) {
      if (name === './composio-client') return { getComposio: async () => ({}), getComposioMode: async () => 'local', isManagedComposioConfigured: () => false };
      if (name === './composio-session') return { resetSessionCache: () => {}, getComposioSession: async (context: ResolvedComposioContext) => ({
        authorize: async (toolkit: string, options: { callbackUrl: string }) => { authorized.push({ context, toolkit, callbackUrl: options.callbackUrl });
          return { redirectUrl: 'https://oauth.fixture.invalid/authorize' }; },
      }) };
      if (name === './composio-toolkit-registry') return { getAvailableToolkitsRaw: async () => [{ slug: 'canva', noAuth: false }], clearToolkitCache: () => {} };
    }
    if (name === '@/i18n/navigation') return { Link: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(function FixtureLink(props, ref) { return <a {...props} ref={ref} />; }) };
    return originalLoad(name, parent, isMain);
  };
  globalThis.fetch = async () => { throw new Error('The profile fixture must not contact external services.'); };
  try {
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) modules.set(name, await import(name));
    for (const id of ['owner', 'other']) await sql.run('INSERT INTO "user"(id,name,email,role,email_verified,banned,created_at,updated_at) VALUES($1,$1,$2,$3,1,0,1,1)', [id, `${id}@connect-profile.fixture.invalid`, id === 'owner' ? 'admin' : 'user']);
    await sql.run("INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at) VALUES($1,'owner','team',1,1,1)", [organizationId]);
    for (const id of ['owner', 'other']) await sql.run("INSERT INTO organization_user_permissions(organization_id,user_id,role,status,created_at,updated_at) VALUES($1,$2,$3,'active',1,1)", [organizationId, id, id === 'owner' ? 'owner' : 'member']);
    await sql.run("INSERT INTO canvas_workspaces(id,organization_id,type,root_relative_path,display_name,status,created_at,updated_at) VALUES($1,$2,'team',$1,'Connect fixture','active',1,1)", [workspaceId, organizationId]);
    await sql.run("INSERT INTO canvas_workspace_members(organization_id,workspace_id,user_id,role,status,can_read,can_manage,created_at,updated_at) VALUES($1,$2,'owner','member','active',1,1,1,1)", [organizationId, workspaceId]);
    const { auth, ensureAuthReady } = await import('../app/lib/auth'); await ensureAuthReady();
    const token = randomBytes(32).toString('hex');
    await sql.run('INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id) VALUES($1,$2,$3,$4,$4,$5)', ['connect-profile-session', Date.now() + 3_600_000, token, Date.now(), 'owner']);
    const profiles = await import('../app/lib/composio/composio-profiles');
    const contexts = await import('../app/lib/composio/composio-context');
    const { POST } = await import('../app/api/composio/connect/[toolkit]/route');
    const defaultProfile = await profiles.ensureDefaultComposioProfile('owner');
    const chosen = await profiles.createComposioProfile({ ownerUserId: 'owner', name: 'Explicit design B' });
    const override = await profiles.createComposioProfile({ ownerUserId: 'owner', name: 'Workspace default C' });
    const foreign = await profiles.createComposioProfile({ ownerUserId: 'other', name: 'Other owner' });
    await profiles.setComposioWorkspaceProfileOverride({ userId: 'owner', workspaceId, profileId: override.id });
    const headers = () => new Headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-canvas-workspace-id': workspaceId });
    const send = (body?: unknown, options: { raw?: string; authenticated?: boolean; toolkit?: string; workspace?: string } = {}) => {
      const h = headers(); if (options.authenticated === false) h.delete('authorization'); if (options.workspace) h.set('x-canvas-workspace-id', options.workspace);
      return POST(new NextRequest('http://localhost:3001/api/composio/connect/canva', { method: 'POST', headers: h,
        ...(options.raw !== undefined ? { body: options.raw } : body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve({ toolkit: options.toolkit ?? 'canva' }) });
    };
    let cases = 0;
    const beforeOverride = await sql.get('SELECT profile_id,updated_at FROM composio_workspace_profile_overrides WHERE user_id=$1 AND workspace_id=$2', ['owner', workspaceId]);
    const response = await send({ profileId: chosen.id, returnPath: '/en/plugins?view=browse&extensionId=composio:canva' }); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.effectiveProfile.id, chosen.id); assert.equal(authorized.at(-1)?.context.profileId, chosen.id);
    assert.equal(authorized.at(-1)?.context.composioUserId, chosen.composioUserId);
    const flow = await sql.get('SELECT user_id,workspace_id,profile_id,composio_user_id FROM composio_oauth_flow_states ORDER BY created_at DESC LIMIT 1');
    assert.deepEqual(flow, { user_id: 'owner', workspace_id: workspaceId, profile_id: chosen.id, composio_user_id: chosen.composioUserId });
    assert.deepEqual(await sql.get('SELECT profile_id,updated_at FROM composio_workspace_profile_overrides WHERE user_id=$1 AND workspace_id=$2', ['owner', workspaceId]), beforeOverride);
    assert.equal((await profiles.ensureDefaultComposioProfile('owner')).id, defaultProfile.id); cases++;
    await profiles.setComposioWorkspaceProfileOverride({ userId: 'owner', workspaceId, profileId: defaultProfile.id });
    assert.equal((await send({ profileId: chosen.id })).status, 200); assert.equal(authorized.at(-1)?.context.profileId, chosen.id);
    assert.equal((await contexts.resolveComposioContext({ userId: 'owner', workspaceId })).profileId, defaultProfile.id); cases++;
    assert.equal((await send()).status, 200); assert.equal(authorized.at(-1)?.context.profileId, defaultProfile.id, 'An absent body preserves the effective-profile route for old callers.'); cases++;
    const authorizedBeforeRejections = authorized.length;
    const denied = await send({ profileId: foreign.id }); assert.equal(denied.status, 409); assert.equal((await denied.json()).code, 'COMPOSIO_PROFILE_BINDING_INVALID'); cases++;
    const archived = await profiles.createComposioProfile({ ownerUserId: 'owner', name: 'Archived own profile' });
    await profiles.archiveComposioProfile({ ownerUserId: 'owner', profileId: archived.id }); assert.equal((await send({ profileId: archived.id })).status, 409); cases++;
    for (const body of [{ profileId: '' }, { profileId: ' ' }, { profileId: chosen.id, userId: 'other' }, { profileId: chosen.id, composioUserId: foreign.composioUserId },
      { profileId: null }, { profileId: chosen.id, ownerUserId: 'other' }, { profileId: chosen.id, returnPath: '//evil.invalid' }, [], null]) {
      assert.equal((await send(body)).status, 400, 'Malformed selection and client identity overrides fail before SDK/OAuth mutation.');
    }
    assert.equal((await send(undefined, { raw: '{not-json' })).status, 400);
    assert.equal((await send(undefined, { raw: JSON.stringify({ profileId: 'x'.repeat(17_000) }) })).status, 413);
    assert.equal((await send({ profileId: chosen.id }, { toolkit: '../invalid' })).status, 400); cases++;
    assert.equal((await send({ profileId: chosen.id }, { authenticated: false })).status, 401);
    assert.equal((await send({ profileId: chosen.id }, { workspace: 'missing-workspace' })).status, 404);
    assert.equal(authorized.length, authorizedBeforeRejections); cases++;

    // Real setup selection -> real POST -> real SQL-bound profile. Catalogue
    // reads are metadata DTOs; the SDK stub above is the only OAuth boundary.
    await profiles.setComposioWorkspaceProfileOverride({ userId: 'owner', workspaceId, profileId: override.id });
    const virtualConsole = new VirtualConsole(); let navigations = 0;
    virtualConsole.on('jsdomError', error => { if (error.message.includes('navigation')) navigations++; else throw error; });
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:3001/en/plugins?view=browse&extensionId=composio:canva', pretendToBeVisual: true, virtualConsole });
    for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle'] as const)
      Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const { render, screen, fireEvent, waitFor, cleanup, act } = await import('@testing-library/react'); cleanupUi = () => { cleanup(); dom.window.close(); };
    const session = await auth.api.getSession({ headers: headers() }); assert(session);
    const item: Extract<PluginExtensionItem, {kind: 'integration'}> = { id: 'composio:canva', kind: 'integration', name: 'canva', displayName: 'Canva', description: 'Fixture metadata', source: 'composio', stock: 'installed',
      access: { canRead: true, canUse: true, canManage: true }, toolkit: { slug: 'canva', noAuth: false }, connections: [] };
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    let heldProfiles: Promise<void> | undefined;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), 'http://localhost:3001'), method = init?.method ?? 'GET';
      if (url.pathname === '/api/auth/get-session') return Response.json(session);
      if (url.pathname === '/api/plugins/search') return Response.json({ success: true, data: { selectedItem: item, items: [], coverage: [{ source: 'composio', status: 'complete' }], pagination: { hasNextPage: false } } });
      if (url.pathname === '/api/integrations/shared-connections/setup') return Response.json({ success: true, data: { scopes: [] } });
      if (url.pathname === '/api/composio/profiles') {
        await heldProfiles;
        const actual = await profiles.listExistingComposioProfiles('owner'), current = await contexts.resolveComposioContext({ userId: 'owner', workspaceId });
        return Response.json({ success: true, profiles: actual.map(profile => ({ id: profile.id, name: profile.name, status: profile.status })),
          effectiveProfile: contexts.toPublicEffectiveComposioContext(current), workspace: { id: workspaceId } });
      }
      if (method === 'POST' && url.pathname === '/api/composio/connect/canva') {
        const body = JSON.parse(String(init?.body)); writes.push({ path: url.pathname, body }); const result = await send(body);
        assert.equal(result.status, 200, 'The real selected-profile UI POST must pass its actual server guards.'); return result;
      }
      if (method === 'PUT' && url.pathname === '/api/composio/workspace-profile') {
        const body = JSON.parse(String(init?.body)); writes.push({ path: url.pathname, body });
        await profiles.setComposioWorkspaceProfileOverride({ userId: 'owner', workspaceId, profileId: String(body.profileId) }); return Response.json({ success: true });
      }
      throw new Error(`Unexpected UI metadata request ${method} ${url.pathname}`);
    };
    // BetterAuth captures its fetch transport when its client is created. Load
    // it only after the real-session HTTP adapter exists; otherwise its initial
    // refresh correctly fences the setup click after the deny-network error.
    const { authClient } = await import('../app/lib/auth-client');
    authClient.$store.atoms.session.set({ ...authClient.$store.atoms.session.get(), data: session, isPending: false, error: null, isRefetching: false });
    const { PluginIntegrationDetail } = await import('../app/components/plugins/PluginIntegrationDetail');
    render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={en}><PluginIntegrationDetail item={item} workspaceId={workspaceId}
      returnPath={`/en/plugins?view=browse&extensionId=composio:canva&workspaceId=${workspaceId}`} onClose={() => {}} onUpdated={() => {}} /></NextIntlClientProvider>);
    await screen.findByTestId('plugin-integration-connect'); fireEvent.change(screen.getByLabelText(en.skills.workspace.setup.profile), { target: { value: chosen.id } });
    const currentSession = authClient.$store.atoms.session.get();
    assert.deepEqual({ pending: currentSession.isPending, error: Boolean(currentSession.error), actor: currentSession.data?.user.id, session: currentSession.data?.session.id },
      { pending: false, error: false, actor: 'owner', session: 'connect-profile-session' }, 'The real browser session must still be current before the selected-profile click.');
    assert.equal(screen.getByLabelText<HTMLSelectElement>(en.skills.workspace.setup.profile).value, chosen.id);
    assert.equal(screen.getByTestId<HTMLButtonElement>('plugin-integration-connect').disabled, false);
    fireEvent.click(screen.getByTestId('plugin-integration-connect'));
    await waitFor(() => assert.equal(navigations, 1, `Expected one OAuth navigation after ${writes.length} UI writes; error visible: ${Boolean(screen.queryByText(en.skills.workspace.setup.saveError))}`), { timeout: 10_000 }); assert.equal(writes.length, 1); assert.equal(writes[0].body.profileId, chosen.id);
    assert.equal(authorized.at(-1)?.context.profileId, chosen.id); assert.equal((await contexts.resolveComposioContext({ userId: 'owner', workspaceId })).profileId, override.id);
    assert(!writes.some(write => write.path.endsWith('/workspace-profile')), 'Connecting the chosen profile must never change the Workspace default.'); cases++;
    fireEvent.click(screen.getByRole('button', { name: en.skills.workspace.setup.useConnection }));
    await waitFor(() => assert(writes.some(write => write.path.endsWith('/workspace-profile'))));
    assert.equal((await contexts.resolveComposioContext({ userId: 'owner', workspaceId })).profileId, chosen.id, 'Only the separate explicit default-profile action changes the default.'); cases++;

    // Two actual own SQL profiles, controlled catalogue account metadata, and
    // the genuine route/OAuth state. The selected row changes while the real
    // profile read is held; its late default must not replace the user's row.
    cleanup(); await profiles.setComposioWorkspaceProfileOverride({ userId: 'owner', workspaceId, profileId: override.id });
    const beforeLateProfile = await sql.get('SELECT profile_id,updated_at FROM composio_workspace_profile_overrides WHERE user_id=$1 AND workspace_id=$2', ['owner', workspaceId]);
    item.connections = [override, chosen].map((profile, index) => ({connectionRef: `composio-personal:${profile.id}:metadata-account-${index}`,
      displayName: profile.name, ownership: {type: 'user', ownerUserId: 'owner', organizationId: null}, access: {...item.access},
      authorization: 'authorized', health: 'unknown', enabled: true, profileId: profile.id, accountId: `metadata-account-${index}`}));
    let releaseProfiles!: () => void;
    heldProfiles = new Promise<void>(resolve => { releaseProfiles = resolve; });
    const beforeLateWrites = writes.length, beforeNavigations = navigations;
    render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={en}><PluginIntegrationDetail item={item} workspaceId={workspaceId}
      returnPath={`/en/plugins?view=browse&extensionId=composio:canva&workspaceId=${workspaceId}`} onClose={() => {}} onUpdated={() => {}} /></NextIntlClientProvider>);
    const account = await screen.findByLabelText<HTMLSelectElement>(en.skills.workspace.setup.account);
    fireEvent.change(account, {target: {value: item.connections[1].connectionRef}});
    assert.equal(account.value, item.connections[1].connectionRef); assert(screen.getByTestId('plugin-integration-personal-loading'));
    assert.equal(screen.queryByTestId('plugin-integration-connect'), null);
    await act(async () => { heldProfiles = undefined; releaseProfiles(); });
    await screen.findByTestId('plugin-integration-connect');
    assert.equal(screen.getByLabelText<HTMLSelectElement>(en.skills.workspace.setup.profile).value, chosen.id,
      'Late profile metadata must follow the currently selected account B instead of restoring the captured default A.');
    fireEvent.click(screen.getByTestId('plugin-integration-connect'));
    await waitFor(() => assert.equal(navigations, beforeNavigations + 1));
    assert.deepEqual(writes.slice(beforeLateWrites).map(write => [write.path, write.body.profileId]), [['/api/composio/connect/canva', chosen.id]]);
    assert.equal(authorized.at(-1)?.context.profileId, chosen.id); assert.equal(authorized.at(-1)?.context.composioUserId, chosen.composioUserId);
    assert.deepEqual(await sql.get('SELECT profile_id,updated_at FROM composio_workspace_profile_overrides WHERE user_id=$1 AND workspace_id=$2', ['owner', workspaceId]), beforeLateProfile);
    const latestFlow = await sql.get('SELECT profile_id FROM composio_oauth_flow_states ORDER BY created_at DESC LIMIT 1') as {profile_id: string} | undefined;
    assert.equal(latestFlow?.profile_id, chosen.id); cases++;

    cleanup(); item.connections = [item.connections[1]];
    render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={en}><PluginIntegrationDetail item={item} workspaceId={workspaceId}
      returnPath={`/en/plugins?view=browse&extensionId=composio:canva&workspaceId=${workspaceId}`} onClose={() => {}} onUpdated={() => {}} /></NextIntlClientProvider>);
    await screen.findByTestId('plugin-integration-connect');
    assert.equal(screen.getByLabelText<HTMLSelectElement>(en.skills.workspace.setup.profile).value, chosen.id,
      'An immediately resolved profile read must also retain the freshly selected sole connection instead of the workspace default.'); cases++;

    cleanup(); await profiles.archiveComposioProfile({ownerUserId: 'owner', profileId: chosen.id});
    render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={en}><PluginIntegrationDetail item={item} workspaceId={workspaceId}
      returnPath={`/en/plugins?view=browse&extensionId=composio:canva&workspaceId=${workspaceId}`} onClose={() => {}} onUpdated={() => {}} /></NextIntlClientProvider>);
    await screen.findByLabelText(en.skills.workspace.setup.profile);
    assert.equal(screen.getByLabelText<HTMLSelectElement>(en.skills.workspace.setup.profile).value, '',
      'A selected account whose real profile became inactive cannot silently fall back to the workspace default.');
    assert(screen.getByTestId<HTMLButtonElement>('plugin-integration-connect').disabled);
    assert.deepEqual(await sql.get('SELECT profile_id,updated_at FROM composio_workspace_profile_overrides WHERE user_id=$1 AND workspace_id=$2', ['owner', workspaceId]), beforeLateProfile); cases++;
    console.log(`Composio explicit connect profile: PASS (${native ? 'native PostgreSQL' : 'PGlite'}, ${cases} route/SQL/real-React cases; real OAuth-state, controlled SDK transport; no live provider or browser E2E).`);
  } finally {
    cleanupUi?.(); globalThis.fetch = originalFetch; loader._load = originalLoad;
    await sql.close(); await engine.close(); await fs.rm(root, { recursive: true, force: true });
    assert.equal(await fs.stat(root).then(() => true, () => false), false);
    for (const [key, value] of oldEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
