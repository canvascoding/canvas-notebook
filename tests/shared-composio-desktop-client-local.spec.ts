import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import type { IntegrationConnectionDescriptor, IntegrationConnectionScopeChoice } from '../app/lib/integration-tools/connections/contracts';
import type { ClientWorkspaceResponse } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';

// This is actual production UI/auth/Common resource acceptance with deliberately
// controlled desktop transport and IPC. It does not open an OS browser or prove
// provider OAuth, Electron identity fences, account publication or Native consent.
type Fixture = { version: 1; nonce: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; rootDevice: string; rootInode: string; databaseName: string; createAcknowledged: boolean;
  phase: string; serverPid: number; actorId: string; listenerVerified: boolean; uncertain: boolean;
  directoryProofs: Record<string, { device: string; inode: string }> };
type Receipt = { version: 1; nonce: string; actorId: string; phase: string; outstanding: string | null;
  controlledTransport: true; closedContexts: boolean; completedCases: number; profileWrites: number; secretWrites: number;
  connectionWrites: number; startRequests: number; statusRequests: number; cancelRequests: number; bridgeRequests: number;
  humanActivityWrites: number; watchWrites: number; forbiddenRequests: string[]; unexpectedDialogs: string[];
  connectionRefs: string[]; failure?: { name: string } };
type Transport = { mode: 'no_auth' | 'lost_start'; starts: number; statuses: number; cancels: number;
  state: string; deadline: string; intent: string | null; cancelled: boolean; held: boolean; release: () => void };

const baseUrl = 'http://127.0.0.1:3001';
const labels = en.sharedConnections;
let fixture: Fixture, receipt: Receipt, context: BrowserContext, receiptPath = '';
let workspaceId = '', organizationId = '', profileId = '';
let receiptWrites: Promise<void> = Promise.resolve();
let beforeAgents: unknown;
const connections: IntegrationConnectionDescriptor[] = [];
const pages = new Set<Page>();
const transports = new Set<Transport>();
const query = () => new URLSearchParams({ workspaceId });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

async function readOwnedComposioClientFixture(): Promise<Fixture> {
  expect(process.env.CANVAS_SHARED_COMPOSIO_DESKTOP_CLIENT_BROWSER_RUN).toBe('1');
  expect(process.env.CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN).toBe('1');
  expect(process.env.E2E_EXTERNAL_SERVER).toBe('1'); expect(process.env.BASE_URL).toBe(baseUrl);
  const filename = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
  if (!filename || !path.isAbsolute(filename) || path.basename(filename) !== 'recovery.json') throw new Error('An owned fixture receipt is required.');
  const stat = await fs.lstat(filename);
  expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size < 64 * 1024).toBe(true);
  expect(stat.mode & 0o777).toBe(0o600); expect(stat.uid).toBe(process.getuid?.());
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: Fixture;
  try {
    const held = await handle.stat(); expect(held.dev).toBe(stat.dev); expect(held.ino).toBe(stat.ino);
    value = JSON.parse(await handle.readFile('utf8')) as Fixture;
  } finally { await handle.close(); }
  expect(value).toMatchObject({ version: 1, phase: 'browser', createAcknowledged: true, listenerVerified: true, uncertain: false });
  expect(value.nonce).toMatch(/^[a-f0-9]{32}$/u); expect(value.databaseName).toBe(`canvas_connection_test_${value.nonce}`);
  expect(value.actorId).toBeTruthy(); expect(Number.isSafeInteger(value.serverPid) && value.serverPid > 0).toBe(true);
  expect(await fs.realpath(process.cwd())).toBe(value.repo); expect(path.dirname(filename)).toBe(value.fixtureRoot);
  const root = await fs.lstat(value.fixtureRoot);
  expect(root.isDirectory() && !root.isSymbolicLink()).toBe(true); expect(root.mode & 0o777).toBe(0o700);
  expect(root.uid).toBe(stat.uid); expect(await fs.realpath(value.fixtureRoot)).toBe(value.fixtureRoot);
  expect(String(root.dev)).toBe(value.rootDevice); expect(String(root.ino)).toBe(value.rootInode);
  const markerPath = path.join(value.fixtureRoot, '.fixture-owner'), marker = await fs.lstat(markerPath);
  expect(marker.isFile() && !marker.isSymbolicLink() && marker.nlink === 1).toBe(true);
  expect(marker.mode & 0o777).toBe(0o600); expect(marker.uid).toBe(root.uid);
  const markerHandle = await fs.open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await markerHandle.stat(); expect(held.dev).toBe(marker.dev); expect(held.ino).toBe(marker.ino);
    expect(await markerHandle.readFile('utf8')).toBe(value.ownerMarker);
  } finally { await markerHandle.close(); }
  for (const [name, directory] of [['data', value.dataRoot], ['tmp', value.tmpRoot]]) {
    expect(directory).toBe(path.join(value.fixtureRoot, name)); const stat = await fs.lstat(directory);
    expect(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === root.uid).toBe(true);
    expect(await fs.realpath(directory)).toBe(directory);
    expect({ device: String(stat.dev), inode: String(stat.ino) }).toEqual(value.directoryProofs[directory]);
  }
  expect(process.env.DATA).toBe(value.dataRoot); expect(process.env.TMPDIR).toBe(value.tmpRoot);
  const provider = new URL(process.env.COMPOSIO_BASE_URL ?? '');
  expect(provider.protocol).toBe('http:'); expect(provider.hostname).toBe('127.0.0.1'); expect(provider.port).toBeTruthy();
  expect(provider.pathname).toBe('/'); expect(provider.search).toBe(''); expect(provider.hash).toBe('');
  expect(!provider.username && !provider.password).toBe(true);
  return value;
}

async function persistComposioClientReceipt(): Promise<void> {
  const snapshot = JSON.stringify(receipt), temporary = `${receiptPath}.tmp`;
  receiptWrites = receiptWrites.then(async () => { await fs.writeFile(temporary, snapshot, { mode: 0o600 }); await fs.rename(temporary, receiptPath); });
  await receiptWrites;
}
async function unpackComposioClientResponse<T>(response: APIResponse | Response): Promise<T> {
  expect(response.status(), 'The actual owned endpoint must acknowledge the request.').toBe(200);
  const body = await response.json() as { success?: boolean; data?: T };
  expect(body.success).toBe(true); expect(body.data).toBeDefined(); return body.data!;
}
async function createOwnComposioClientConnection(label: string, toolkit: 'canva' | 'duckduckgo'): Promise<IntegrationConnectionDescriptor> {
  receipt.outstanding = `create:${label}`; await persistComposioClientReceipt();
  const result = await unpackComposioClientResponse<{ connection: IntegrationConnectionDescriptor }>(await context.request.post('/api/integrations/shared-connections', {
    headers: { Origin: baseUrl, 'x-canvas-workspace-id': workspaceId }, data: { displayName: `Client ${label} ${fixture.nonce}`,
      source: 'composio', ownership: { type: 'organization' }, profileId, toolkit },
  }));
  const value = result.connection;
  expect(value.resource.displayName).toBe(`Client ${label} ${fixture.nonce}`); expect(value.resource.createdByUserId).toBe(fixture.actorId);
  expect(value.resource.source).toBe('composio'); expect(value.resource.ownership).toEqual({ type: 'organization', organizationId });
  expect(value.resource.connectionRef).toMatch(/^canvas-connection:[a-f0-9-]{36}$/u);
  expect(value.access).toEqual({ canRead: true, canUse: false, canManage: true });
  expect(value.resource.accessMode).toBe('restricted'); expect(value.grants).toEqual([]);
  connections.push(value); receipt.connectionRefs.push(value.resource.connectionRef); receipt.connectionWrites += 1;
  receipt.outstanding = null; await persistComposioClientReceipt(); return value;
}
async function openOwnComposioClientEditor(page: Page, value: IntegrationConnectionDescriptor): Promise<Locator> {
  const ready = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspaces' && response.request().method() === 'GET');
  await page.goto(`/en/plugins?${new URLSearchParams({ scope: 'organization', view: 'advanced', workspaceId })}`, { waitUntil: 'domcontentloaded' });
  expect((await ready).status()).toBe(200);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('canvas.activeWorkspaceId'))).toBe(workspaceId);
  const section = page.getByTestId('shared-connections'); await expect(section).toBeVisible();
  const disclosure = section.getByRole('button', { name: new RegExp(`^${labels.title}`, 'u') });
  if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
  const row = section.getByTestId('shared-connection-row').filter({ hasText: value.resource.displayName });
  await expect(row).toHaveCount(1); await row.click();
  const dialog = page.getByTestId('shared-connection-edit-dialog'); await expect(dialog).toBeVisible();
  await expect(dialog.locator('#shared-edit-name')).toHaveValue(value.resource.displayName);
  await expect(dialog.getByTestId('shared-connection-save')).toBeEnabled();
  await dialog.locator('summary').filter({ hasText: labels.accountSetup }).click();
  await expect(dialog.getByRole('button', { name: labels.connect, exact: true })).toBeEnabled(); return dialog;
}
async function installControlledComposioDesktopBridge(page: Page, capability: boolean): Promise<void> {
  await page.exposeBinding('__ownedComposioOpen', async (_source, request: unknown) => {
    const value = request as { state: string; authorizationUrl: string; expiresAt: string; target: { kind: string; connectionRef: string; workspaceId: string } };
    expect(Object.keys(value).sort()).toEqual(['authorizationUrl', 'expiresAt', 'state', 'target']);
    expect(typeof value.state === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value.state)).toBe(true);
    expect(value.authorizationUrl === 'https://controlled-provider.invalid/authorize').toBe(true);
    expect(new Date(value.expiresAt).toISOString()).toBe(value.expiresAt);
    expect(value.target).toEqual({ kind: 'shared', connectionRef: connections[2].resource.connectionRef, workspaceId });
    receipt.bridgeRequests += 1; await persistComposioClientReceipt();
    // A deliberately lost IPC acknowledgement. No shell/OS opener is invoked.
    throw new Error('Controlled opener acknowledgement unavailable.');
  });
  await page.addInitScript(({ enabled }) => {
    Object.defineProperty(window, 'canvasDesktop', { configurable: false, value: Object.freeze({
      sharedComposioOAuthVersion: enabled ? 1 : 0,
      openSharedComposioOAuth: (request: unknown) => (window as unknown as { __ownedComposioOpen: (value: unknown) => Promise<unknown> }).__ownedComposioOpen(request),
    }) });
  }, { enabled: capability });
}
async function controlComposioDesktopTransport(page: Page, value: IntegrationConnectionDescriptor, mode: Transport['mode']): Promise<Transport> {
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const transport: Transport = { mode, starts: 0, statuses: 0, cancels: 0, state: randomBytes(32).toString('base64url'),
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(), intent: null, cancelled: false, held: false, release };
  transports.add(transport);
  const startPath = `/api/composio/shared-connections/${encodeURIComponent(value.resource.connectionRef)}/connect`;
  await page.route('**/api/composio/shared-connections/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl || ![startPath, `${startPath}/desktop`].includes(url.pathname)) { await route.fallback(); return; }
    expect(url.searchParams.get('workspaceId')).toBe(workspaceId);
    const respond = async (data: unknown) => route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ success: true, data }) });
    if (url.pathname === startPath) {
      expect(method).toBe('POST'); const body = request.postDataJSON() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['desktop', 'expectedBindingRevision', 'expectedGrantsRevision', 'expectedMetadataRevision', 'intent']);
      expect({ desktop: body.desktop, expectedMetadataRevision: body.expectedMetadataRevision,
        expectedGrantsRevision: body.expectedGrantsRevision, expectedBindingRevision: body.expectedBindingRevision })
        .toEqual({ desktop: true, expectedMetadataRevision: value.resource.metadataRevision,
        expectedGrantsRevision: value.resource.grantsRevision, expectedBindingRevision: value.resource.bindingRevision });
      expect(typeof body.intent === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(body.intent)).toBe(true); transport.intent = body.intent as string;
      transport.starts += 1; receipt.startRequests += 1; expect(transport.starts).toBe(1); await persistComposioClientReceipt();
      if (mode === 'no_auth') { await respond({ connectionRef: value.resource.connectionRef, noAuth: true }); return; }
      transport.held = true; receipt.phase = 'controlled_start_held'; await persistComposioClientReceipt();
      await hold; transport.held = false; await route.abort('failed'); return;
    }
    if (method === 'GET') {
      expect([...url.searchParams.keys()].sort()).toEqual([transport.statuses === 0 ? 'intent' : 'state', 'workspaceId']);
      expect(url.searchParams.get(transport.statuses === 0 ? 'intent' : 'state') === (transport.statuses === 0 ? transport.intent : transport.state)).toBe(true);
      transport.statuses += 1; receipt.statusRequests += 1; await persistComposioClientReceipt();
      await respond({ connectionRef: value.resource.connectionRef, state: transport.state, expiresAt: transport.deadline,
        status: 'waiting', authorizationUrl: 'https://controlled-provider.invalid/authorize' }); return;
    }
    expect(method).toBe('POST'); const action = request.postDataJSON() as Record<string, unknown>;
    expect(Object.keys(action).sort()).toEqual(['action', 'state']); expect(action.state === transport.state && action.action === 'cancel').toBe(true);
    transport.cancels += 1; receipt.cancelRequests += 1; expect(transport.cancels).toBe(1); transport.cancelled = true;
    await persistComposioClientReceipt(); await respond({ connectionRef: value.resource.connectionRef, state: transport.state,
      expiresAt: transport.deadline, status: 'cancelled', code: 'CONNECTION_DESKTOP_OAUTH_CANCELLED', error: 'Shared sign-in was cancelled.' });
  });
  return transport;
}

test.beforeAll(async ({ browser }) => {
  fixture = await readOwnedComposioClientFixture(); receiptPath = path.join(fixture.fixtureRoot, 'browser-receipt.json');
  receipt = { version: 1, nonce: fixture.nonce, actorId: fixture.actorId, phase: 'setup', outstanding: null,
    controlledTransport: true, closedContexts: false, completedCases: 0, profileWrites: 0, secretWrites: 0, connectionWrites: 0,
    startRequests: 0, statusRequests: 0, cancelRequests: 0, bridgeRequests: 0, humanActivityWrites: 0, watchWrites: 0,
    forbiddenRequests: [], unexpectedDialogs: [], connectionRefs: [] };
  await persistComposioClientReceipt(); context = await createAuthenticatedContext(browser, { baseURL: baseUrl });
  await runManagedTestPreflight(context, { baseURL: baseUrl });
  const session = await requestManagedTestSession(context.request); expect(session.status()).toBe(200);
  expect((await session.json() as { user: { id: string; role: string } }).user).toMatchObject({ id: fixture.actorId, role: 'admin' });
  const health = await context.request.get('/api/health'); expect(health.status()).toBe(200);
  expect((await health.json() as { deployment: { mode: string; teamFeaturesEnabled: boolean } }).deployment).toMatchObject({ mode: 'team', teamFeaturesEnabled: true });
  const workspaceResponse = await context.request.get('/api/workspaces'); expect(workspaceResponse.status()).toBe(200);
  const workspaces = await workspaceResponse.json() as ClientWorkspaceResponse;
  expect(workspaces.teamFeaturesEnabled).toBe(true); expect(workspaces.defaultWorkspace?.organizationId).toBeTruthy();
  workspaceId = workspaces.defaultWorkspace!.id; organizationId = workspaces.defaultWorkspace!.organizationId!;
  const scopes = await unpackComposioClientResponse<{ scopes: IntegrationConnectionScopeChoice[] }>(await context.request.get(`/api/integrations/shared-connections/setup?${query()}`));
  expect(scopes.scopes.some(value => value.ownership.type === 'organization' && value.ownership.organizationId === organizationId)).toBe(true);
  const initial = await unpackComposioClientResponse<{ connections: IntegrationConnectionDescriptor[] }>(await context.request.get(`/api/integrations/shared-connections?${query()}`));
  expect(initial.connections).toEqual([]);
  const agentsResponse = await context.request.get('/api/agents?includeAccess=true'); expect(agentsResponse.status()).toBe(200); beforeAgents = await agentsResponse.json();
  receipt.outstanding = 'own_secret'; await persistComposioClientReceipt();
  const secret = await unpackComposioClientResponse<{ revision: string; entries: Array<{ key: string }> }>(await context.request.get('/api/integrations/env?scope=integrations&secretScope=organization&key=COMPOSIO_API_KEY'));
  expect(secret.entries.some(value => value.key === 'COMPOSIO_API_KEY')).toBe(false);
  await unpackComposioClientResponse(await context.request.patch('/api/integrations/env', { headers: { Origin: baseUrl }, data: {
    scope: 'integrations', secretScope: 'organization', baseRevision: secret.revision,
    patches: [{ key: 'COMPOSIO_API_KEY', value: `owned-client-provider-${fixture.nonce}` }],
  } })); receipt.secretWrites += 1;
  receipt.outstanding = 'own_profile'; await persistComposioClientReceipt();
  const profile = await unpackComposioClientResponse<{ profile: { id: string; name: string; ownership: unknown; createdByUserId: string } }>(await context.request.post('/api/composio/shared-profiles', {
    headers: { Origin: baseUrl, 'x-canvas-workspace-id': workspaceId }, data: { name: `Client ${fixture.nonce}`, ownership: { type: 'organization' }, providerMode: 'local' },
  }));
  expect(profile.profile.name).toBe(`Client ${fixture.nonce}`); expect(profile.profile.ownership).toEqual({ type: 'organization', organizationId });
  expect(profile.profile.createdByUserId).toBe(fixture.actorId); expect(typeof profile.profile.id === 'string' && profile.profile.id.length > 0).toBe(true);
  profileId = profile.profile.id; receipt.profileWrites += 1; receipt.outstanding = null; await persistComposioClientReceipt();
  for (const [label, toolkit] of [['capability', 'canva'], ['noauth', 'duckduckgo'], ['recovery', 'canva']] as const) await createOwnComposioClientConnection(label, toolkit);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl) { await route.abort(); return; }
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) { await route.continue(); return; }
    if (method === 'POST' && url.pathname === '/api/instance/human-activity' && !request.postData()) { receipt.humanActivityWrites += 1; await route.continue(); return; }
    if (method === 'POST' && url.pathname === '/api/files/watch' && url.search === `?workspaceId=${encodeURIComponent(workspaceId)}`) {
      const body = request.postDataJSON() as { clientId?: unknown; dirs?: unknown };
      if (Object.keys(body).sort().join(',') === 'clientId,dirs' && typeof body.clientId === 'string'
        && /^client-\d+-[a-z0-9]{1,9}$/u.test(body.clientId) && Array.isArray(body.dirs) && body.dirs.length === 0) {
        receipt.watchWrites += 1; await route.continue(); return;
      }
    }
    receipt.forbiddenRequests.push(`${method}:${url.pathname}`); await persistComposioClientReceipt(); await route.abort();
  });
  receipt.phase = 'actual_connections_ready'; await persistComposioClientReceipt();
});

test('missing desktop capability denies before any Start or opener', async ({}, info) => {
  const page = await context.newPage(); pages.add(page); await installControlledComposioDesktopBridge(page, false);
  page.on('dialog', async dialog => { receipt.unexpectedDialogs.push(dialog.type()); await dialog.dismiss(); });
  const dialog = await openOwnComposioClientEditor(page, connections[0]);
  await dialog.getByRole('button', { name: labels.connect, exact: true }).click();
  await expect(dialog.getByText(labels.desktopUpdateRequired, { exact: true })).toBeVisible();
  expect(receipt.startRequests).toBe(0); expect(receipt.bridgeRequests).toBe(0);
  await expect(dialog.getByTestId('shared-desktop-cancel')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('capability-feedback.png'), animations: 'disabled' });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  receipt.completedCases += 1; receipt.phase = 'capability_verified'; await persistComposioClientReceipt();
});

test('no-auth acknowledgement uses actual fresh readiness and never opens IPC', async ({}, info) => {
  const page = await context.newPage(); pages.add(page); await installControlledComposioDesktopBridge(page, true);
  page.on('dialog', async dialog => { receipt.unexpectedDialogs.push(dialog.type()); await dialog.dismiss(); });
  const transport = await controlComposioDesktopTransport(page, connections[1], 'no_auth');
  const dialog = await openOwnComposioClientEditor(page, connections[1]);
  const freshStatus = page.waitForResponse(response => new URL(response.url()).pathname === `/api/composio/shared-connections/${encodeURIComponent(connections[1].resource.connectionRef)}/status`);
  await dialog.getByRole('button', { name: labels.connect, exact: true }).click(); expect((await freshStatus).status()).toBe(200);
  await expect(dialog.getByText(labels.connected, { exact: true })).toBeVisible(); expect(transport.starts).toBe(1);
  expect(transport.statuses).toBe(0); expect(transport.cancels).toBe(0); expect(receipt.bridgeRequests).toBe(0);
  await expect(dialog.getByTestId('shared-desktop-cancel')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('actual-noauth-feedback.png'), animations: 'disabled' });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  receipt.completedCases += 1; receipt.phase = 'noauth_verified'; await persistComposioClientReceipt();
});

test('lost Start and opener acknowledgements retain the attempt until explicit Cancel, then status and reopen', async ({}, info) => {
  const page = await context.newPage(); pages.add(page); await installControlledComposioDesktopBridge(page, true);
  page.on('dialog', async dialog => { receipt.unexpectedDialogs.push(dialog.type()); await dialog.dismiss(); });
  const transport = await controlComposioDesktopTransport(page, connections[2], 'lost_start');
  const dialog = await openOwnComposioClientEditor(page, connections[2]); receipt.outstanding = 'controlled_attempt'; await persistComposioClientReceipt();
  await dialog.getByRole('button', { name: labels.connect, exact: true }).click(); await expect.poll(() => transport.held).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible(); expect(receipt.unexpectedDialogs).toEqual([]);
  expect(transport.starts).toBe(1); expect(transport.statuses).toBe(0); expect(receipt.bridgeRequests).toBe(0);
  transport.release(); await expect(dialog.getByText(labels.desktopUnconfirmed, { exact: true })).toBeVisible();
  await expect(dialog.getByTestId('shared-desktop-resume')).toBeEnabled(); expect(transport.statuses).toBe(0);
  await dialog.getByTestId('shared-desktop-resume').click();
  await expect.poll(() => receipt.bridgeRequests).toBe(1); await expect(dialog.getByText(labels.desktopUnconfirmed, { exact: true })).toBeVisible();
  await expect(dialog.getByTestId('shared-desktop-resume')).toBeEnabled(); expect(transport.starts).toBe(1); expect(transport.statuses).toBe(1); expect(transport.cancels).toBe(0);
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible(); expect(receipt.unexpectedDialogs).toEqual([]);
  await dialog.getByTestId('shared-desktop-cancel').click(); await expect(dialog.getByText(labels.oauthCancelled, { exact: true })).toBeVisible();
  await expect(dialog.getByTestId('shared-desktop-cancel')).toHaveCount(0); expect(transport.cancelled).toBe(true); expect(transport.cancels).toBe(1);
  receipt.outstanding = null; await persistComposioClientReceipt();
  await dialog.getByRole('button', { name: labels.checkStatus, exact: true }).click();
  await expect(dialog.getByText(labels.connectionRequired, { exact: true })).toBeVisible();
  await expect(dialog.getByText(labels.connected, { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('cancelled-static-feedback.png'), animations: 'disabled' });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  const reopened = await openOwnComposioClientEditor(page, connections[2]);
  await expect(reopened.getByTestId('shared-desktop-resume')).toHaveCount(0);
  await expect(reopened.getByRole('button', { name: labels.connect, exact: true })).toBeEnabled();
  expect(transport.starts).toBe(1); expect(transport.statuses).toBe(1); expect(transport.cancels).toBe(1); expect(receipt.bridgeRequests).toBe(1);
  await page.keyboard.press('Escape'); await expect(reopened).toHaveCount(0);
  receipt.completedCases += 1; receipt.phase = 'recovery_verified'; await persistComposioClientReceipt();
});

async function closeOwnedComposioClientContexts(): Promise<void> {
  let verified = false, failedClose = false;
  try {
    if (receipt?.completedCases === 3 && receipt.outstanding === null) {
      for (const before of connections) {
        const after = await unpackComposioClientResponse<{ connection: IntegrationConnectionDescriptor }>(await context.request.get(`/api/integrations/shared-connections/${encodeURIComponent(before.resource.connectionRef)}?${query()}`));
        expect(after.connection).toEqual(before);
      }
      const agentsResponse = await context.request.get('/api/agents?includeAccess=true'); expect(agentsResponse.status()).toBe(200);
      expect(await agentsResponse.json()).toEqual(beforeAgents);
      const sessions = await context.request.get('/api/sessions'); expect(sessions.status()).toBe(200);
      expect((await sessions.json() as { sessions: unknown[] }).sessions).toEqual([]);
      expect(receipt.forbiddenRequests).toEqual([]); expect(receipt.unexpectedDialogs).toEqual([]);
      expect({ starts: receipt.startRequests, statuses: receipt.statusRequests, cancels: receipt.cancelRequests, openers: receipt.bridgeRequests })
        .toEqual({ starts: 2, statuses: 1, cancels: 1, openers: 1 }); verified = true;
    }
  } finally {
    for (const transport of transports) transport.release();
    for (const page of pages) {
      try { await page.unrouteAll({ behavior: 'wait' }); await page.close(); } catch { failedClose = true; }
    }
    try { await context?.unrouteAll({ behavior: 'wait' }); await context?.close(); } catch { failedClose = true; }
    if (receipt) {
      receipt.closedContexts = !failedClose;
      if (verified && !failedClose) receipt.phase = 'verified_closed';
      await persistComposioClientReceipt();
    }
  }
  if (failedClose) throw new Error('An owned controlled-client context did not acknowledge closure.');
  // The parent closes its own toolkit fixture and performs normal DROP only
  // after all acknowledged children/pools have closed. No per-agent deletion.
}
test.afterAll(async () => { await closeOwnedComposioClientContexts(); });
