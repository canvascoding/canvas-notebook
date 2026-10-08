import { test, expect, type BrowserContext } from '@playwright/test';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createAuthenticatedContext, runManagedTestPreflight, requestManagedTestSession } from './helpers/managed-test-context';
import { launchComposioLiveElectron, readComposioLiveElectronReceipt, closeComposioLiveElectron, type ComposioLiveElectron } from './helpers/composio-live-electron';
import type { IntegrationConnectionDescriptor } from '../app/lib/integration-tools/connections/contracts';
import type { ClientWorkspaceResponse } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';
import de from '../messages/de.json';

const BASE = 'http://127.0.0.1:3001';
const TOOL = 'CANVA_GET_USERS_ME_CAPABILITIES';
type Fixture = { version: 1; nonce: string; actorId: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  phase: string; liveProvider: string; nativeProvider: string; uncertain: boolean; listenerVerified: boolean; createAcknowledged: boolean;
  rootDevice: string; rootInode: string; ownerMarker: string; desktopPaths: Record<string, string>; desktopDirectoryProofs: Record<string, { device: string; inode: string }> };
type Owned = { scope: 'organization' | 'team'; workspaceId: string; profileId: string; initial: IntegrationConnectionDescriptor; current: IntegrationConnectionDescriptor;
  states: string[]; stateHashes: string[]; starts: number; finalizes: number; cancelled: number };
let fixture: Fixture, admin: BrowserContext | undefined, harness: ComposioLiveElectron | undefined;
let orgId = '', personalId = '', teamId = '', authSessionHash = '';
const connections: Owned[] = [];
let receipt: { nonce: string; actorId: string; phase: string; outstanding: string | null; electronClosed: boolean; closedContexts: boolean;
  completedScopes: string[]; readCalls: number; desktopPaths: Record<string, string>; desktopDirectoryProofs: Fixture['desktopDirectoryProofs'];
  processes: Array<{ pid: number; processGroupId: number; closed: true }>; systemBrowserOpenedCount: number; profiles: string[];
  connections: Array<{ connectionRef: string; scope: string; workspaceId: string; metadataRevision: number; grantsRevision: number; bindingRevision: number }>; failure?: { stage: string } };
let currentStage = 'setup';

async function readComposioLiveFixture(): Promise<Fixture> {
  expect(process.env.CANVAS_COMPOSIO_LIVE_BROWSER_RUN).toBe('1'); expect(process.env.BASE_URL).toBe(BASE); expect(process.env.COMPOSIO_BASE_URL).toBeUndefined();
  const file = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE; if (!file || !path.isAbsolute(file) || path.basename(file) !== 'recovery.json') throw new Error('Owned live recovery required.');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: Fixture;
  try { const stat = await handle.stat(); expect(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size < 65536).toBe(true); value = JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
  expect(value).toMatchObject({ version: 1, liveProvider: 'composio', nativeProvider: 'composio', phase: 'browser', uncertain: false, listenerVerified: true, createAcknowledged: true });
  expect(value.nonce).toMatch(/^[a-f0-9]{32}$/u); expect(value.repo).toBe(await fs.realpath(process.cwd())); expect(value.fixtureRoot).toBe(path.dirname(file));
  const dbUrl = new URL(process.env.DATABASE_URL!); expect(dbUrl.hostname).toBe('127.0.0.1'); expect(dbUrl.port).toBe('55433'); expect(dbUrl.pathname).toBe(`/canvas_connection_test_${value.nonce}`);
  const root = await fs.lstat(value.fixtureRoot); expect(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid?.() && (root.mode & 0o777) === 0o700).toBe(true);
  expect(String(root.dev)).toBe(value.rootDevice); expect(String(root.ino)).toBe(value.rootInode);
  expect(process.env.DATA).toBe(value.dataRoot); expect(process.env.TMPDIR).toBe(value.tmpRoot); return value;
}
async function persistComposioLiveReceipt(): Promise<void> {
  for (const name of ['browser-receipt.json', 'live-receipt.json']) await fs.writeFile(path.join(fixture.fixtureRoot, name), JSON.stringify(receipt), { mode: 0o600 });
}
async function createLiveCanvaConnections(): Promise<void> {
  if (!admin) throw new Error('Owned admin required.');
  const listing = await admin.request.get('/api/workspaces'); expect(listing.status()).toBe(200);
  const workspaces = await listing.json() as ClientWorkspaceResponse; personalId = workspaces.defaultWorkspace!.id; orgId = workspaces.defaultWorkspace!.organizationId!;
  expect(workspaces.defaultWorkspace?.type).toBe('personal'); expect(orgId).toBeTruthy();
  receipt.outstanding = 'team-create'; await persistComposioLiveReceipt();
  const createdTeam = await admin.request.post('/api/workspaces', { data: { type: 'team', name: `Live Canva ${fixture.nonce}` } }); expect(createdTeam.status()).toBe(201);
  const team = (await createdTeam.json()).workspace as { id: string; organizationId: string; type: string }; expect(team.organizationId).toBe(orgId); expect(team.type).toBe('team'); teamId = team.id;
  const secretRead = await admin.request.get('/api/integrations/env?scope=integrations&secretScope=organization&key=COMPOSIO_API_KEY'); expect(secretRead.status()).toBe(200);
  const secret = await secretRead.json() as { success: boolean; data: { revision: string; entries: Array<{ key: string }> } }; expect(secret.success).toBe(true); expect(secret.data.entries.some(entry => entry.key === 'COMPOSIO_API_KEY')).toBe(false);
  const input = process.env.CANVAS_COMPOSIO_LIVE_INPUT; if (!input || !path.isAbsolute(input)) throw new Error('Private live input required.');
  const file = await fs.open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  let key: string;
  try { const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) throw new Error('Invalid private live input.'); const value = JSON.parse(await file.readFile('utf8')) as { composioApiKey?: unknown }; if (typeof value.composioApiKey !== 'string' || !value.composioApiKey.trim()) throw new Error('Private key required.'); key = value.composioApiKey; }
  finally { await file.close(); }
  receipt.outstanding = 'own-organization-secret'; await persistComposioLiveReceipt();
  const saved = await admin.request.patch('/api/integrations/env', { data: { scope: 'integrations', secretScope: 'organization', baseRevision: secret.data.revision, patches: [{ key: 'COMPOSIO_API_KEY', value: key }] } }); key = '';
  expect(saved.status()).toBe(200); expect((await saved.json()).success).toBe(true);
  const flag = await admin.request.patch('/api/admin/experimental-settings', { data: { integrationToolGatewayEnabled: true } }); expect(flag.status()).toBe(200);
  for (const scope of ['organization', 'team'] as const) {
    const workspaceId = scope === 'team' ? teamId : personalId, ownership = scope === 'team' ? { type: 'team', workspaceId: teamId } : { type: 'organization' };
    receipt.outstanding = `profile:${scope}`; await persistComposioLiveReceipt();
    const profileResponse = await admin.request.post(`/api/composio/shared-profiles?${new URLSearchParams({ workspaceId })}`, { data: { name: `Live Canva ${scope} ${fixture.nonce}`, ownership, providerMode: 'local' } }); expect(profileResponse.status()).toBe(200);
    const profileBody = await profileResponse.json() as { success: boolean; data: { profile: { id: string; createdByUserId: string } } }; expect(profileBody.success).toBe(true); expect(profileBody.data.profile.createdByUserId).toBe(fixture.actorId);
    const profileId = profileBody.data.profile.id; receipt.profiles.push(profileId); await persistComposioLiveReceipt();
    receipt.outstanding = `connection:${scope}`; await persistComposioLiveReceipt();
    const created = await admin.request.post(`/api/integrations/shared-connections?${new URLSearchParams({ workspaceId })}`, { data: {
      displayName: `Live Canva ${scope} ${fixture.nonce}`, ownership, source: 'composio', profileId, toolkit: 'canva', accessMode: 'restricted', allowedToolNames: [TOOL],
      grants: [{ targetType: 'user', targetId: fixture.actorId, canUse: true, canManage: true, allowedToolNames: [TOOL] }] } }); expect(created.status()).toBe(200);
    const body = await created.json() as { success: boolean; data: { connection: IntegrationConnectionDescriptor } }; expect(body.success).toBe(true);
    const initial = body.data.connection; expect(initial.resource.createdByUserId).toBe(fixture.actorId); expect(initial.resource.source).toBe('composio'); expect(initial.resource.application).toBe('canva'); expect(initial.resource.ownership.type).toBe(scope);
    connections.push({ scope, workspaceId, profileId, initial, current: initial, states: [], stateHashes: [], starts: 0, finalizes: 0, cancelled: 0 });
    receipt.connections.push({ connectionRef: initial.resource.connectionRef, scope, workspaceId, metadataRevision: initial.resource.metadataRevision, grantsRevision: initial.resource.grantsRevision, bindingRevision: initial.resource.bindingRevision });
    receipt.outstanding = null; await persistComposioLiveReceipt();
  }
}
async function observeLiveComposioRequests(): Promise<void> {
  if (!harness) throw new Error('Original Electron required.');
  harness.page.on('dialog', dialog => { void dialog.dismiss(); });
  await harness.page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== BASE) { await route.abort(); return; }
    const own = connections.find(connection => url.pathname === `/api/composio/shared-connections/${encodeURIComponent(connection.initial.resource.connectionRef)}/connect`
      || url.pathname === `/api/composio/shared-connections/${encodeURIComponent(connection.initial.resource.connectionRef)}/connect/desktop`);
    if (!own || request.method() !== 'POST') { if (['GET', 'HEAD'].includes(request.method()) || url.pathname.startsWith('/api/auth/')) await route.continue(); else await route.abort(); return; }
    try {
      expect([...url.searchParams.keys()]).toEqual(['workspaceId']); expect(url.searchParams.get('workspaceId')).toBe(own.workspaceId);
      const body = request.postDataJSON() as Record<string, unknown>;
      if (url.pathname.endsWith('/connect')) {
        expect(Object.keys(body).sort()).toEqual(['desktop', 'expectedBindingRevision', 'expectedGrantsRevision', 'expectedMetadataRevision', 'intent']);
        expect(body.desktop).toBe(true); expect(body.expectedBindingRevision).toBe(own.current.resource.bindingRevision); expect(body.expectedMetadataRevision).toBe(own.current.resource.metadataRevision); expect(body.expectedGrantsRevision).toBe(own.current.resource.grantsRevision);
        own.starts++; expect(own.starts).toBe(1); receipt.outstanding = `start:${own.scope}`; await persistComposioLiveReceipt();
        const actual = await route.fetch({ timeout: 120_000 }); expect(actual.status()).toBe(200);
        const payload = await actual.json() as { success?: boolean; data?: { status: string; connectionRef: string; state: string; authorizationUrl: string; expiresAt: string } };
        if (payload.success !== true || !payload.data || payload.data.status !== 'waiting' || payload.data.connectionRef !== own.initial.resource.connectionRef
          || !/^[A-Za-z0-9_-]{43}$/u.test(payload.data.state) || new Date(payload.data.expiresAt).toISOString() !== payload.data.expiresAt) throw new Error('Invalid actual live start.');
        const result = payload.data, origin = new URL(result.authorizationUrl).origin;
        expect(['https://app.composio.dev', 'https://connect.composio.dev']).toContain(origin);
        const stateHash = createHash('sha256').update(result.state).digest('hex'), urlHash = createHash('sha256').update(result.authorizationUrl).digest('hex'); own.states.push(result.state); own.stateHashes.push(stateHash);
        await harness!.application.evaluate(async (_electron, value) => { const api = Reflect.get(globalThis, '__canvasComposioLiveElectron') as { armLiveAuthorizationTarget(input: typeof value): Promise<void> }; await api.armLiveAuthorizationTarget(value); }, { origin, urlHash, stateHash });
        await route.fulfill({ response: actual }); console.info(`LIVE_CANVA_HANDOFF ${JSON.stringify({ scope: own.scope, nonce: fixture.nonce, origin, stateHash, urlHash })}`); return;
      }
      expect(Object.keys(body).sort()).toEqual(['action', 'state']); expect(body.state).toBe(own.states[0]); expect(['finalize', 'cancel']).toContain(body.action);
      if (body.action === 'finalize') { own.finalizes++; expect(own.finalizes).toBe(1); } else own.cancelled++;
      const actual = await route.fetch({ timeout: 120_000 }); await route.fulfill({ response: actual });
    } catch { receipt.failure = { stage: `transport:${own.scope}` }; await persistComposioLiveReceipt(); await route.abort().catch(() => undefined); }
  });
}
async function runLiveCanvaGatewayRead(): Promise<void> {
  const file = path.join(fixture.fixtureRoot, 'live-gateway-input.json');
  await fs.writeFile(file, JSON.stringify({ nonce: fixture.nonce, actorId: fixture.actorId, authSessionHash,
    targets: connections.map(connection => ({ scope: connection.scope, workspaceId: connection.workspaceId, organizationId: orgId, connectionRef: connection.current.resource.connectionRef })) }), { mode: 0o600, flag: 'wx' });
  receipt.outstanding = 'two-canva-read-calls'; await persistComposioLiveReceipt();
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' }; delete env.CANVAS_COMPOSIO_LIVE_INPUT;
  await new Promise<void>((resolve, reject) => execFile(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/composio-live-gateway-read.ts', file],
    { cwd: fixture.repo, env, timeout: 8 * 60_000, maxBuffer: 16384 }, error => error ? reject(new Error('The real live Canva dispatcher read failed.')) : resolve()));
  const proof = JSON.parse(await fs.readFile(path.join(fixture.fixtureRoot, 'live-gateway-read-proof.json'), 'utf8')) as { nonce: string; readCalls: number; scopes: Array<{ scope: string; successful: boolean }> };
  expect(proof.nonce).toBe(fixture.nonce); expect(proof.readCalls).toBe(2); expect(proof.scopes.map(scope => scope.scope)).toEqual(['organization', 'team']); expect(proof.scopes.every(scope => scope.successful)).toBe(true);
  receipt.readCalls = 2; receipt.outstanding = null; await persistComposioLiveReceipt();
}

test('real Composio Canva Org and Team desktop consent and exact read dispatch', async ({ browser }) => {
  fixture = await readComposioLiveFixture(); receipt = { nonce: fixture.nonce, actorId: fixture.actorId, phase: 'setup', outstanding: null, electronClosed: false, closedContexts: false,
    completedScopes: [], readCalls: 0, desktopPaths: fixture.desktopPaths, desktopDirectoryProofs: fixture.desktopDirectoryProofs, processes: [], systemBrowserOpenedCount: 0, profiles: [], connections: [] }; await persistComposioLiveReceipt();
  try {
    admin = await createAuthenticatedContext(browser, { baseURL: BASE, extraHTTPHeaders: { Origin: BASE } }); await runManagedTestPreflight(admin, { baseURL: BASE });
    const identityResponse = await requestManagedTestSession(admin.request); expect(identityResponse.status()).toBe(200); expect((await identityResponse.json()).user.id).toBe(fixture.actorId);
    await createLiveCanvaConnections(); currentStage = 'native-login'; harness = await launchComposioLiveElectron({ fixturePath: process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE! }); await observeLiveComposioRequests();
    await harness.page.goto(`${BASE}/en/login`, { waitUntil: 'domcontentloaded' }); await harness.page.locator('#email').fill(process.env.BOOTSTRAP_ADMIN_EMAIL!); await harness.page.locator('#password').fill(process.env.BOOTSTRAP_ADMIN_PASSWORD!);
    const login = harness.page.waitForResponse(response => new URL(response.url()).origin === BASE && new URL(response.url()).pathname === '/api/auth/sign-in/email' && response.request().method() === 'POST');
    await harness.page.locator('button[type="submit"]').click(); expect((await login).status()).toBe(200);
    await harness.page.waitForURL(url => url.origin === BASE && ['/', '/en', '/en/', '/de', '/de/'].includes(url.pathname)); await expect(harness.page.getByRole('banner')).toBeVisible(); await expect(harness.page.locator('#email')).toHaveCount(0);
    const nativeIdentityResponse = await harness.page.request.get(`${BASE}/api/auth/get-session`); expect(nativeIdentityResponse.status()).toBe(200);
    const nativeIdentity = await nativeIdentityResponse.json() as { user: { id: string }; session: { id: string } }; expect(nativeIdentity.user.id).toBe(fixture.actorId); authSessionHash = createHash('sha256').update(nativeIdentity.session.id).digest('hex');
    for (const own of connections) {
      currentStage = `ui:${own.scope}`; const locale = own.scope === 'team' ? 'de' : 'en', labels = own.scope === 'team' ? de.sharedConnections : en.sharedConnections;
      await harness.page.goto(`${BASE}/${locale}/plugins?${new URLSearchParams({ view: 'advanced', scope: own.scope, workspaceId: own.workspaceId, connectionRef: own.initial.resource.connectionRef, ...(own.scope === 'team' ? { teamId } : {}) })}`);
      const editor = harness.page.getByTestId('shared-connection-edit-dialog'); await expect(editor.getByTestId('shared-connection-save')).toBeEnabled(); await editor.locator('summary').filter({ hasText: labels.accountSetup }).click();
      await editor.getByRole('button', { name: labels.connect, exact: true }).click(); await expect(editor.getByText(labels.desktopWaiting, { exact: true })).toBeVisible({ timeout: 120_000 });
      await expect(editor.getByText(labels.connected, { exact: true })).toBeVisible({ timeout: 8 * 60_000 });
      const finalFlow = await harness.page.request.get(`${BASE}/api/composio/shared-connections/${encodeURIComponent(own.initial.resource.connectionRef)}/connect/desktop?${new URLSearchParams({ workspaceId: own.workspaceId, state: own.states[0] })}`); expect(finalFlow.status()).toBe(200);
      const flow = await finalFlow.json(); expect(flow.success === true && flow.data.status === 'completed' && flow.data.connectionRef === own.initial.resource.connectionRef && flow.data.state === own.states[0]).toBe(true);
      const inspected = await harness.page.request.get(`${BASE}/api/integrations/shared-connections/${encodeURIComponent(own.initial.resource.connectionRef)}?${new URLSearchParams({ workspaceId: own.workspaceId })}`); expect(inspected.status()).toBe(200);
      own.current = (await inspected.json()).data.connection as IntegrationConnectionDescriptor;
      expect(own.current.resource.bindingRevision).toBe(own.initial.resource.bindingRevision + 1); expect(own.current.resource.metadataRevision).toBe(own.initial.resource.metadataRevision); expect(own.current.resource.grantsRevision).toBe(own.initial.resource.grantsRevision); expect(own.current.grants).toEqual(own.initial.grants);
      expect(own.starts).toBe(1); expect(own.finalizes).toBe(1); expect(own.cancelled).toBe(0);
      const { Pool } = await import('pg'); const database = new Pool({ connectionString: process.env.DATABASE_URL, max: 1,
        options: '-c default_transaction_read_only=on -c statement_timeout=15000', query_timeout: 15_000 });
      try {
        const result = await database.query(`SELECT c.auth_session_hash,c.connection_ref,c.published_binding_revision,c.profile_id_hash,c.composio_user_id_hash,c.pending_account_hash,
          r.backend_profile_id,r.backend_account_id,p.composio_user_id FROM composio_shared_desktop_oauth_commits c
          JOIN integration_connection_resources r ON r.connection_ref=c.connection_ref JOIN composio_connection_profiles p ON p.id=r.backend_profile_id WHERE c.state_hash=$1`, [own.stateHashes[0]]);
        expect(result.rows.length).toBe(1); const row = result.rows[0]; expect(row.auth_session_hash).toBe(authSessionHash); expect(row.connection_ref).toBe(own.initial.resource.connectionRef);
        expect(Number(row.published_binding_revision)).toBe(own.current.resource.bindingRevision); expect(row.backend_profile_id).toBe(own.profileId);
        expect(row.profile_id_hash === createHash('sha256').update(own.profileId).digest('hex')).toBe(true);
        expect(typeof row.backend_account_id === 'string' && row.pending_account_hash === createHash('sha256').update(row.backend_account_id).digest('hex')).toBe(true);
        expect(typeof row.composio_user_id === 'string' && row.composio_user_id_hash === createHash('sha256').update(row.composio_user_id).digest('hex')).toBe(true);
      } finally { await database.end(); }
      receipt.completedScopes.push(own.scope); receipt.connections = receipt.connections.map(connection => connection.connectionRef === own.current.resource.connectionRef ? { ...connection, bindingRevision: own.current.resource.bindingRevision } : connection);
      receipt.outstanding = null; await persistComposioLiveReceipt(); await harness.page.screenshot({ path: path.join(fixture.fixtureRoot, `live-canva-${own.scope}-completed.png`) }); await editor.getByRole('button', { name: 'Close', exact: true }).click();
    }
    currentStage = 'dispatcher-read'; await runLiveCanvaGatewayRead();
    const main = await readComposioLiveElectronReceipt(harness); expect(main.shellAcknowledged).toBe(2); expect(main.uncertain).toBe(false); receipt.systemBrowserOpenedCount = 2;
    currentStage = 'native-close'; await closeComposioLiveElectron(harness); receipt.electronClosed = true; receipt.processes = [{ pid: harness.processId, processGroupId: harness.processGroupId, closed: true }]; harness = undefined;
    await admin.close(); admin = undefined; receipt.closedContexts = true; receipt.phase = 'awaiting_manual_system_browser_close'; await persistComposioLiveReceipt();
    console.info(`LIVE_CANVA_CLOSE_HANDOFF ${JSON.stringify({ nonce: fixture.nonce, openedCount: 2, stateHashes: connections.flatMap(connection => connection.stateHashes) })}`);
    currentStage = 'manual-close'; const ackPath = path.join(fixture.fixtureRoot, 'system-browser-closure.json');
    await expect.poll(async () => fs.lstat(ackPath).then(() => true, () => false), { timeout: 5 * 60_000, intervals: [1000] }).toBe(true);
    const ack = await fs.open(ackPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await ack.stat(); expect(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size < 2048).toBe(true); expect(JSON.parse(await ack.readFile('utf8'))).toEqual({ version: 1, nonce: fixture.nonce, openedCount: 2, closed: true }); }
    finally { await ack.close(); }
    expect(receipt.failure).toBeUndefined(); receipt.phase = 'verified_closed'; receipt.outstanding = null; await persistComposioLiveReceipt();
  } catch {
    receipt.failure = { stage: currentStage }; receipt.phase = 'preserved'; await persistComposioLiveReceipt();
    // Cancel actual outstanding own flows before asking Electron to close; never clear a live guard synthetically.
    if (harness) {
      let cancellationUnconfirmed = false;
      for (const own of connections.filter(connection => connection.starts > 0 && !receipt.completedScopes.includes(connection.scope))) {
        try {
          if (!own.states[0]) throw new Error('The original state is unconfirmed; preserve the live flow.');
          const editor = harness.page.getByTestId('shared-connection-edit-dialog');
          const currentUrl = new URL(harness.page.url());
          if (currentUrl.origin !== BASE || currentUrl.searchParams.get('connectionRef') !== own.initial.resource.connectionRef
            || currentUrl.searchParams.get('workspaceId') !== own.workspaceId) throw new Error('The original editor context changed.');
          await expect(editor).toBeVisible({ timeout: 30_000 });
          await expect(editor.locator('#shared-edit-name')).toHaveValue(own.initial.resource.displayName);
          const cancel = editor.getByTestId('shared-desktop-cancel');
          if (await cancel.isVisible()) { await expect(cancel).toBeEnabled({ timeout: 30_000 }); await cancel.click(); }
          await expect.poll(async () => {
            const result = await harness!.page.request.get(`${BASE}/api/composio/shared-connections/${encodeURIComponent(own.initial.resource.connectionRef)}/connect/desktop?${new URLSearchParams({ workspaceId: own.workspaceId, state: own.states[0] })}`, { timeout: 10_000 });
            if (result.status() !== 200) return false;
            const body = await result.json() as { success?: boolean; data?: { connectionRef?: string; state?: string; status?: string } };
            return body.success === true && body.data?.connectionRef === own.initial.resource.connectionRef
              && body.data.state === own.states[0] && ['cancelled', 'completed', 'expired', 'failed'].includes(body.data.status ?? '');
          }, { timeout: 30_000, intervals: [500, 1000] }).toBe(true);
          await expect(cancel).toHaveCount(0); await expect(editor.getByTestId('shared-desktop-resume')).toHaveCount(0);
          await editor.getByRole('button', { name: 'Close', exact: true }).click(); await expect(editor).toHaveCount(0);
          if (!cancellationUnconfirmed) receipt.outstanding = null; await persistComposioLiveReceipt();
        }
        catch { cancellationUnconfirmed = true; receipt.outstanding = `unconfirmed-cancel:${own.scope}`; await persistComposioLiveReceipt(); }
      }
      if (!cancellationUnconfirmed) try { await closeComposioLiveElectron(harness); receipt.electronClosed = true; receipt.processes = [{ pid: harness.processId, processGroupId: harness.processGroupId, closed: true }]; } catch { /* Preserve exact native handle proof. */ }
    }
    try { await admin?.close(); receipt.closedContexts = receipt.electronClosed; } catch { /* Preserve. */ }
    await persistComposioLiveReceipt(); throw new Error('Live Composio Canva acceptance failed; inspect only the private safe stage receipt.');
  }
});
