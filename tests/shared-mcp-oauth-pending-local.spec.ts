import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Page, type Response } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import { startMcpOAuthProvider } from './fixtures/mcp-oauth-provider.mjs';
import type { IntegrationConnectionDescriptor, IntegrationConnectionScopeChoice } from '../app/lib/integration-tools/connections/contracts';
import type { ClientWorkspaceResponse } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';

type Fixture = { version: 1; nonce: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; rootDevice: string; rootInode: string; databaseName: string; createAcknowledged: boolean;
  phase: string; serverPid: number; actorId: string; listenerVerified: boolean; uncertain: boolean;
  tlsFiles: { key: { path: string; device: string; inode: string }; certificate: { path: string; device: string; inode: string } };
  directoryProofs: Record<string, { device: string; inode: string }> };
type BrowserReceipt = { version: 1; nonce: string; actorId: string; phase: string; outstanding: string | null;
  closedContexts: boolean; providerClosed: boolean; forbiddenRequests: string[]; unexpectedDialogs: string[];
  createWrites: number; oauthWrites: number; consentWrites: number; humanActivityWrites: number; watchWrites: number;
  connection?: { connectionRef: string; metadataRevision: number; grantsRevision: number; bindingRevision: number };
  callbackStatus?: number;
  failure?: { name: string; matcherName?: string; expected?: number | boolean; actual?: number | boolean };
  providerCounters?: Record<string, number>; authorized: boolean };
type Provider = Awaited<ReturnType<typeof startMcpOAuthProvider>>;
type OAuthStatus = { configured: boolean; requiresAuth: boolean; authorized: boolean; authStatus: string; code: string | null };
const baseUrl = 'http://127.0.0.1:3001';
const labels = en.sharedConnections;
let fixture: Fixture, receipt: BrowserReceipt, receiptPath = '';
let admin: BrowserContext | undefined, page: Page | undefined, provider: Provider | undefined;
let workspaceId = '', organizationId = '';
let connection: IntegrationConnectionDescriptor | undefined;
let releaseStart: (() => void) | undefined;
let testVerified = false;
let receiptWrite = Promise.resolve();
let tls: { key: Buffer; cert: Buffer } | undefined;

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

async function readOwnedOAuthFixture(): Promise<Fixture> {
  expect(process.env.CANVAS_SHARED_MCP_OAUTH_BROWSER_RUN).toBe('1');
  expect(process.env.CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN).toBe('1');
  expect(process.env.BASE_URL).toBe(baseUrl); expect(process.env.E2E_EXTERNAL_SERVER).toBe('1');
  const file = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
  if (!file || !path.isAbsolute(file) || path.basename(file) !== 'recovery.json') throw new Error('An exact owned receipt is required.');
  const stat = await fs.lstat(file);
  expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 64 * 1024).toBe(true);
  expect(stat.mode & 0o777).toBe(0o600); expect(stat.uid).toBe(process.getuid?.());
  const value = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture;
  expect(value).toMatchObject({ version: 1, createAcknowledged: true, phase: 'browser', listenerVerified: true, uncertain: false });
  expect(value.nonce).toMatch(/^[a-f0-9]{32}$/u); expect(value.databaseName).toBe(`canvas_connection_test_${value.nonce}`);
  expect(value.actorId).toBeTruthy(); expect(Number.isSafeInteger(value.serverPid) && value.serverPid > 0).toBe(true);
  expect(await fs.realpath(process.cwd())).toBe(value.repo); expect(path.dirname(file)).toBe(value.fixtureRoot);
  const root = await fs.lstat(value.fixtureRoot);
  expect(root.isDirectory() && !root.isSymbolicLink()).toBe(true); expect(root.mode & 0o777).toBe(0o700);
  expect(root.uid).toBe(stat.uid); expect(await fs.realpath(value.fixtureRoot)).toBe(value.fixtureRoot);
  expect(String(root.dev)).toBe(value.rootDevice); expect(String(root.ino)).toBe(value.rootInode);
  const markerPath = path.join(value.fixtureRoot, '.fixture-owner'), marker = await fs.lstat(markerPath);
  expect(marker.isFile() && !marker.isSymbolicLink() && marker.nlink === 1).toBe(true);
  expect(marker.mode & 0o777).toBe(0o600); expect(marker.uid).toBe(root.uid);
  expect(await fs.readFile(markerPath, 'utf8')).toBe(value.ownerMarker);
  for (const [name, directory] of [['data', value.dataRoot], ['tmp', value.tmpRoot]]) {
    expect(directory).toBe(path.join(value.fixtureRoot, name));
    const held = await fs.lstat(directory);
    expect(held.isDirectory() && !held.isSymbolicLink()).toBe(true); expect(held.uid).toBe(root.uid);
    expect(await fs.realpath(directory)).toBe(directory);
    expect({ device: String(held.dev), inode: String(held.ino) }).toEqual(value.directoryProofs[directory]);
  }
  expect(process.env.DATA).toBe(value.dataRoot); expect(process.env.TMPDIR).toBe(value.tmpRoot);
  const pem: Partial<{ key: Buffer; cert: Buffer }> = {};
  for (const [field, filename, environment, target] of [
    ['key', 'tls-key.pem', process.env.CANVAS_SHARED_MCP_OAUTH_TLS_KEY, 'key'],
    ['certificate', 'tls-cert.pem', process.env.CANVAS_SHARED_MCP_OAUTH_TLS_CERT, 'cert'],
  ] as const) {
    const proof = value.tlsFiles[field];
    expect(proof.path).toBe(path.join(value.fixtureRoot, filename)); expect(environment).toBe(proof.path);
    expect(await fs.realpath(proof.path)).toBe(proof.path);
    const before = await fs.lstat(proof.path);
    expect(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= 64 * 1024).toBe(true);
    expect(before.mode & 0o777).toBe(0o600); expect(before.uid).toBe(root.uid);
    expect({ device: String(before.dev), inode: String(before.ino) }).toEqual({ device: proof.device, inode: proof.inode });
    const handle = await fs.open(proof.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const held = await handle.stat();
      expect(held.isFile() && held.nlink === 1 && held.size > 0 && held.size <= 64 * 1024).toBe(true);
      expect(held.mode & 0o777).toBe(0o600); expect(held.uid).toBe(root.uid);
      expect({ device: String(held.dev), inode: String(held.ino) }).toEqual({ device: proof.device, inode: proof.inode });
      pem[target] = await handle.readFile();
    } finally { await handle.close(); }
    const after = await fs.lstat(proof.path);
    expect(after.isFile() && !after.isSymbolicLink() && after.nlink === 1).toBe(true);
    expect({ device: String(after.dev), inode: String(after.ino) }).toEqual({ device: proof.device, inode: proof.inode });
  }
  expect(process.env.NODE_EXTRA_CA_CERTS).toBe(value.tlsFiles.certificate.path);
  if (!pem.key || !pem.cert) throw new Error('The exact own TLS files are required.');
  tls = { key: pem.key, cert: pem.cert };
  return value;
}

async function persistOAuthBrowserReceipt(): Promise<void> {
  const snapshot = JSON.stringify(receipt);
  const temporary = `${receiptPath}.tmp`;
  receiptWrite = receiptWrite.then(async () => {
    await fs.writeFile(temporary, snapshot, { mode: 0o600 }); await fs.rename(temporary, receiptPath);
  });
  await receiptWrite;
}

async function readOAuthData<T>(response: APIResponse | Response, phase: string): Promise<T> {
  if (response.status() !== 200) {
    const rejected = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof rejected?.code === 'string' && /^[a-zA-Z0-9_]{1,80}$/u.test(rejected.code) ? rejected.code : 'UNCLASSIFIED';
    // No response bodies, OAuth URLs, codes, tokens or exception messages.
    console.info(`OWN_SHARED_OAUTH_REJECTION ${JSON.stringify({ phase, status: response.status(), code })}`);
  }
  expect(response.status(), `${phase} must be acknowledged by the real endpoint.`).toBe(200);
  const payload = await response.json() as { success?: boolean; data?: T };
  expect(payload.success).toBe(true); expect(payload.data).toBeDefined(); return payload.data!;
}

function assertOwnOAuthConnection(value: IntegrationConnectionDescriptor): void {
  expect(value.resource.connectionRef).toMatch(/^canvas-connection:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
  expect(value.resource.source).toBe('mcp'); expect(value.resource.displayName).toBe(`Shared OAuth ${fixture.nonce}`);
  expect(value.resource.createdByUserId).toBe(fixture.actorId); expect(value.resource.ownership).toEqual({ type: 'organization', organizationId });
  expect(value.resource.status).toBe('active'); expect(value.access.canManage).toBe(true);
  for (const revision of [value.resource.metadataRevision, value.resource.grantsRevision, value.resource.bindingRevision]) {
    expect(Number.isSafeInteger(revision) && revision > 0).toBe(true);
  }
  if (connection) expect(value.resource.connectionRef).toBe(connection.resource.connectionRef);
}

async function createOwnOAuthConnectionViaUi(): Promise<IntegrationConnectionDescriptor> {
  expect(page && admin && provider).toBeTruthy();
  const currentPage = page!, currentProvider = provider!;
  receipt.phase = 'connections_ui'; await persistOAuthBrowserReceipt();
  await currentPage.goto(`/en/plugins?${new URLSearchParams({ scope: 'organization', view: 'advanced', workspaceId })}`, { waitUntil: 'domcontentloaded' });
  const section = currentPage.getByTestId('shared-connections'); await expect(section).toBeVisible();
  await section.getByTestId('shared-connection-create').click();
  const dialog = currentPage.getByTestId('shared-connection-create-dialog'); await expect(dialog).toBeVisible();
  const orgOption = dialog.locator('#shared-owner option').filter({ hasText: labels.organization });
  expect(await orgOption.count()).toBe(1); await dialog.locator('#shared-owner').selectOption(await orgOption.getAttribute('value') ?? '');
  await dialog.locator('#shared-source').selectOption('mcp'); await dialog.locator('#shared-name').fill(`Shared OAuth ${fixture.nonce}`);
  await dialog.locator('#shared-url').fill(currentProvider.url); await dialog.getByRole('checkbox', { name: labels.oauth, exact: true }).check();
  await expect(dialog.locator('#shared-token')).toHaveCount(0);
  const created = currentPage.waitForResponse(response => new URL(response.url()).origin === baseUrl
    && new URL(response.url()).pathname === '/api/integrations/shared-connections' && response.request().method() === 'POST');
  receipt.outstanding = 'create:shared-oauth'; await persistOAuthBrowserReceipt();
  await dialog.getByRole('button', { name: labels.create, exact: true }).click();
  const result = await readOAuthData<{ connection: IntegrationConnectionDescriptor }>(await created, 'Own UI connection creation');
  assertOwnOAuthConnection(result.connection); connection = result.connection;
  receipt.connection = { connectionRef: connection.resource.connectionRef, metadataRevision: connection.resource.metadataRevision,
    grantsRevision: connection.resource.grantsRevision, bindingRevision: connection.resource.bindingRevision };
  receipt.outstanding = null; await persistOAuthBrowserReceipt();
  await expect(dialog).toHaveCount(0);
  return connection;
}

async function readOwnOAuthStatus(): Promise<OAuthStatus> {
  expect(admin && connection).toBeTruthy();
  return readOAuthData(await admin!.request.get(`/api/mcp/shared-connections/${encodeURIComponent(connection!.resource.connectionRef)}/oauth?${new URLSearchParams({ workspaceId })}`), 'Own current OAuth status');
}

test.beforeAll(async ({ browser }) => {
  fixture = await readOwnedOAuthFixture(); receiptPath = path.join(fixture.fixtureRoot, 'browser-receipt.json');
  receipt = { version: 1, nonce: fixture.nonce, actorId: fixture.actorId, phase: 'setup', outstanding: null,
    closedContexts: false, providerClosed: false, forbiddenRequests: [], unexpectedDialogs: [], createWrites: 0,
    oauthWrites: 0, consentWrites: 0, humanActivityWrites: 0, watchWrites: 0, authorized: false };
  await persistOAuthBrowserReceipt();
  admin = await createAuthenticatedContext(browser, { baseURL: baseUrl, viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true });
  await runManagedTestPreflight(admin, { baseURL: baseUrl });
  const sessionResponse = await requestManagedTestSession(admin.request); expect(sessionResponse.status()).toBe(200);
  expect((await sessionResponse.json() as { user: { id: string; role: string } }).user).toMatchObject({ id: fixture.actorId, role: 'admin' });
  const healthResponse = await admin.request.get('/api/health'); expect(healthResponse.status()).toBe(200);
  expect((await healthResponse.json() as { deployment: { mode: string; teamFeaturesEnabled: boolean } }).deployment).toMatchObject({ mode: 'team', teamFeaturesEnabled: true });
  const workspacesResponse = await admin.request.get('/api/workspaces'); expect(workspacesResponse.status()).toBe(200);
  const workspaces = await workspacesResponse.json() as ClientWorkspaceResponse;
  expect(workspaces.teamFeaturesEnabled).toBe(true); expect(workspaces.defaultWorkspace?.type).toBe('personal');
  workspaceId = workspaces.defaultWorkspace!.id; organizationId = workspaces.defaultWorkspace!.organizationId!;
  expect(workspaceId && organizationId).toBeTruthy();
  const setup = await readOAuthData<{ scopes: IntegrationConnectionScopeChoice[] }>(await admin.request.get(`/api/integrations/shared-connections/setup?${new URLSearchParams({ workspaceId })}`), 'Current organization management setup');
  expect(setup.scopes.some(value => value.ownership.type === 'organization' && value.ownership.organizationId === organizationId)).toBe(true);
  const initial = await readOAuthData<{ connections: IntegrationConnectionDescriptor[] }>(await admin.request.get(`/api/integrations/shared-connections?${new URLSearchParams({ workspaceId })}`), 'Empty own nonce connections');
  expect(initial.connections).toEqual([]);
  if (!tls) throw new Error('The exact owned HTTPS provider credentials were not verified.');
  provider = await startMcpOAuthProvider({ allowedRedirectOrigins: [baseUrl], tls });
  expect(new URL(provider.origin).hostname).toBe('127.0.0.1'); expect(new URL(provider.origin).protocol).toBe('https:');
  page = await admin.newPage();
  page.on('dialog', async dialog => { receipt.unexpectedDialogs.push(dialog.type()); await persistOAuthBrowserReceipt(); await dialog.dismiss(); });
  // Inspect only application writes. External telemetry is aborted before any
  // body parsing; the only second origin is the own in-memory OAuth provider.
  await admin.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === provider!.origin) {
      const allowed = method === 'GET' && url.pathname === '/authorize' || method === 'POST' && url.pathname === '/consent';
      if (!allowed) { receipt.forbiddenRequests.push(`provider:${method}:${url.pathname}`); await persistOAuthBrowserReceipt(); await route.abort(); return; }
      if (method === 'POST') receipt.consentWrites += 1;
      await route.continue(); return;
    }
    if (url.origin !== baseUrl) { await route.abort(); return; }
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) { await route.continue(); return; }
    if (method === 'POST' && url.pathname === '/api/integrations/shared-connections') {
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(body).toEqual({ displayName: `Shared OAuth ${fixture.nonce}`, ownership: { type: 'organization' }, source: 'mcp',
        config: { url: provider!.url, transport: 'http', auth: 'oauth' }, secrets: [] });
      receipt.createWrites += 1; expect(receipt.createWrites).toBe(1); await persistOAuthBrowserReceipt(); await route.continue(); return;
    }
    if (method === 'POST' && connection && url.pathname === `/api/mcp/shared-connections/${encodeURIComponent(connection.resource.connectionRef)}/oauth`) {
      expect(request.postDataJSON()).toEqual({ expectedMetadataRevision: connection.resource.metadataRevision,
        expectedGrantsRevision: connection.resource.grantsRevision, expectedBindingRevision: connection.resource.bindingRevision, returnLocale: 'en' });
      receipt.oauthWrites += 1; expect(receipt.oauthWrites).toBe(1); await persistOAuthBrowserReceipt(); await route.continue(); return;
    }
    if (method === 'POST' && url.pathname === '/api/instance/human-activity' && !request.postData()) {
      receipt.humanActivityWrites += 1; await route.continue(); return;
    }
    if (method === 'POST' && url.pathname === '/api/files/watch' && url.search === `?workspaceId=${encodeURIComponent(workspaceId)}`) {
      const body = request.postDataJSON() as { clientId?: unknown; dirs?: unknown };
      if (Object.keys(body).sort().join(',') === 'clientId,dirs' && typeof body.clientId === 'string'
        && /^client-\d+-[a-z0-9]{1,9}$/u.test(body.clientId) && Array.isArray(body.dirs) && body.dirs.length === 0) {
        receipt.watchWrites += 1; await route.continue(); return;
      }
    }
    receipt.forbiddenRequests.push(`${method}:${url.pathname}`); await persistOAuthBrowserReceipt(); await route.abort();
  });
});

test('clean shared MCP Connect blocks pre-ACK close, then completes real OAuth without an unload dialog', async () => {
  try {
    await createOwnOAuthConnectionViaUi(); expect(connection && page && admin && provider).toBeTruthy();
    const currentPage = page!, currentProvider = provider!, before = structuredClone(connection!);
    const statusBefore = await readOwnOAuthStatus(); expect(statusBefore.requiresAuth).toBe(true); expect(statusBefore.authorized).toBe(false);
    const row = currentPage.getByTestId('shared-connection-row').filter({ hasText: `Shared OAuth ${fixture.nonce}` });
    await expect(row).toHaveCount(1); await row.click();
    const editor = currentPage.getByTestId('shared-connection-edit-dialog'); await expect(editor).toBeVisible();
    await editor.locator('summary').filter({ hasText: labels.accountSetup }).click();
    let fetched = false;
    const hold = new Promise<void>(resolve => { releaseStart = resolve; });
    const oauthPath = `/api/mcp/shared-connections/${encodeURIComponent(connection!.resource.connectionRef)}/oauth`;
    // This later exact route overrides the observer for this ONE POST. Execute
    // the real backend, keep its body in RAM, and fulfill unchanged after ACK.
    await currentPage.route(`${baseUrl}${oauthPath}`, async route => {
      if (route.request().method() !== 'POST') { await route.fallback(); return; }
      expect(route.request().postDataJSON()).toEqual({ expectedMetadataRevision: before.resource.metadataRevision,
        expectedGrantsRevision: before.resource.grantsRevision, expectedBindingRevision: before.resource.bindingRevision, returnLocale: 'en' });
      receipt.oauthWrites += 1; expect(receipt.oauthWrites).toBe(1); await persistOAuthBrowserReceipt();
      const original = await route.fetch({ timeout: 30_000 });
      const reply = await readOAuthData<{ authorizationUrl: string; state: string; redirectUri: string }>(original, 'Actual held OAuth start');
      const authorization = new URL(reply.authorizationUrl);
      expect(authorization.origin === currentProvider.origin && authorization.pathname === '/authorize').toBe(true);
      expect(reply.redirectUri).toBe(`${baseUrl}/api/mcp/shared-connections/oauth/callback`);
      expect(/^[A-Za-z0-9_-]{32}$/u.test(reply.state)).toBe(true);
      receipt.phase = 'actual_start_held'; await persistOAuthBrowserReceipt(); fetched = true;
      await hold; await route.fulfill({ response: original });
    });
    receipt.outstanding = 'oauth:held-start'; await persistOAuthBrowserReceipt();
    await editor.getByRole('button', { name: labels.connect, exact: true }).click();
    await expect.poll(() => fetched, { timeout: 35_000, message: 'The actual OAuth start must reach the held response gate.' }).toBe(true);
    expect(currentProvider.stats.consents).toBe(0); expect(currentProvider.stats.tokenExchanges).toBe(0);
    await editor.getByRole('button', { name: 'Close', exact: true }).click(); await expect(editor).toBeVisible();
    await currentPage.keyboard.press('Escape'); await expect(editor).toBeVisible();
    expect(receipt.unexpectedDialogs).toEqual([]); expect(receipt.oauthWrites).toBe(1);
    receipt.phase = 'pre_ack_close_blocked'; await persistOAuthBrowserReceipt();
    releaseStart!(); releaseStart = undefined;
    await expect(currentPage.getByRole('heading', { name: 'Connect Canvas Notebook', exact: true })).toBeVisible();
    expect(new URL(currentPage.url()).origin === currentProvider.origin).toBe(true);
    expect(receipt.unexpectedDialogs).toEqual([]); expect(currentProvider.stats.consents).toBe(1);
    receipt.phase = 'real_consent'; await persistOAuthBrowserReceipt();
    const callback = currentPage.waitForResponse(response => new URL(response.url()).origin === baseUrl
      && new URL(response.url()).pathname === '/api/mcp/shared-connections/oauth/callback' && response.request().method() === 'GET');
    await currentPage.getByRole('button', { name: 'Approve', exact: true }).click();
    const callbackResponse = await callback;
    receipt.callbackStatus = callbackResponse.status(); receipt.phase = 'callback_received'; await persistOAuthBrowserReceipt();
    expect(receipt.callbackStatus).toBe(303);
    await expect.poll(() => {
      const returned = new URL(currentPage.url());
      return returned.origin === baseUrl && returned.pathname === '/en/plugins'
        && returned.searchParams.get('view') === 'advanced' && returned.searchParams.get('scope') === 'organization'
        && returned.searchParams.get('workspaceId') === workspaceId && returned.searchParams.get('connectionRef') === before.resource.connectionRef
        && returned.searchParams.get('sharedOAuth') === 'connected'
        && [...returned.searchParams.keys()].sort().join(',') === 'connectionRef,scope,sharedOAuth,view,workspaceId' && !returned.hash;
    }, { message: 'The callback must return to its bound local Plugins context without OAuth parameters.' }).toBe(true);
    const returnedEditor = currentPage.getByTestId('shared-connection-edit-dialog');
    await expect(returnedEditor).toBeVisible();
    await expect(returnedEditor.locator('#shared-edit-name')).toHaveValue(`Shared OAuth ${fixture.nonce}`);
    await expect(returnedEditor.getByText(labels.connected, { exact: true })).toBeVisible();
    expect(receipt.unexpectedDialogs).toEqual([]);
    receipt.outstanding = null;
    const status = await readOwnOAuthStatus(); expect(status).toMatchObject({ configured: true, requiresAuth: true, authorized: true, authStatus: 'authorized' });
    const current = (await readOAuthData<{ connection: IntegrationConnectionDescriptor }>(await admin!.request.get(`/api/integrations/shared-connections/${encodeURIComponent(before.resource.connectionRef)}?${new URLSearchParams({ workspaceId })}`), 'Own post-OAuth binding')).connection;
    assertOwnOAuthConnection(current); expect(current.resource.metadataRevision).toBe(before.resource.metadataRevision);
    expect(current.resource.grantsRevision).toBe(before.resource.grantsRevision); expect(current.resource.bindingRevision).toBe(before.resource.bindingRevision + 1);
    connection = current; receipt.connection = { connectionRef: current.resource.connectionRef, metadataRevision: current.resource.metadataRevision,
      grantsRevision: current.resource.grantsRevision, bindingRevision: current.resource.bindingRevision };
    expect(currentProvider.stats.tokenExchanges).toBe(1); expect(currentProvider.stats.toolCalls).toBe(0);
    expect(receipt.forbiddenRequests).toEqual([]); expect(receipt.unexpectedDialogs).toEqual([]);
    expect({ create: receipt.createWrites, oauth: receipt.oauthWrites, consent: receipt.consentWrites }).toEqual({ create: 1, oauth: 1, consent: 1 });
    receipt.authorized = true; receipt.phase = 'callback_verified'; await persistOAuthBrowserReceipt(); testVerified = true;
  } catch (error) {
    // Playwright navigation errors can include a credential-bearing callback URL.
    // Keep only bounded names and scalar matcher data, never messages or bodies.
    const failure = error as { name?: unknown; matcherResult?: { name?: unknown; expected?: unknown; actual?: unknown } } | null;
    receipt.failure = { name: typeof failure?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(failure.name) ? failure.name : 'UnknownError' };
    const matcher = failure?.matcherResult;
    if (typeof matcher?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(matcher.name)) receipt.failure.matcherName = matcher.name;
    if (typeof matcher?.expected === 'boolean' || typeof matcher?.expected === 'number' && Number.isFinite(matcher.expected)) receipt.failure.expected = matcher.expected;
    if (typeof matcher?.actual === 'boolean' || typeof matcher?.actual === 'number' && Number.isFinite(matcher.actual)) receipt.failure.actual = matcher.actual;
    await persistOAuthBrowserReceipt();
    throw new Error('The own shared OAuth UI assertion failed; inspect the private safe stage/counter receipt.');
  } finally { releaseStart?.(); releaseStart = undefined; }
});

test.afterAll(async () => {
  let verified = false;
  let closeFailed = false;
  try {
    if (testVerified && receipt.outstanding === null && admin && connection && provider) {
      const current = (await readOAuthData<{ connection: IntegrationConnectionDescriptor }>(await admin.request.get(`/api/integrations/shared-connections/${encodeURIComponent(connection.resource.connectionRef)}?${new URLSearchParams({ workspaceId })}`), 'Own final binding')).connection;
      assertOwnOAuthConnection(current); expect(current).toEqual(connection); expect((await readOwnOAuthStatus()).authorized).toBe(true);
      const sessionsResponse = await admin.request.get('/api/sessions'); expect(sessionsResponse.status()).toBe(200);
      expect((await sessionsResponse.json() as { sessions: unknown[] }).sessions).toEqual([]);
      expect(provider.stats.tokenExchanges).toBe(1); expect(provider.stats.toolCalls).toBe(0);
      expect(receipt.forbiddenRequests).toEqual([]); expect(receipt.unexpectedDialogs).toEqual([]);
      verified = true;
    }
  } finally {
    // Preserve stage counters on failure too. The provider keeps codes/tokens
    // private; only this numeric snapshot survives its awaited close.
    if (receipt && provider) receipt.providerCounters = Object.fromEntries(Object.entries(provider.stats).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
    for (const ownedContext of [page, admin]) {
      try { await ownedContext?.close(); } catch { closeFailed = true; }
    }
    if (receipt) receipt.closedContexts = !closeFailed;
    if (provider) {
      try { await provider.close(); if (receipt) receipt.providerClosed = true; } catch { closeFailed = true; }
    }
    if (receipt) {
      if (verified && receipt.closedContexts && receipt.providerClosed && !closeFailed) receipt.phase = 'verified_closed';
      await persistOAuthBrowserReceipt();
    }
  }
  if (closeFailed) throw new Error('An owned OAuth provider or browser context did not acknowledge closure; preserve the private fixture.');
  // No Agent DELETE, profile/ENV changes, SQL or server lifecycle actions. The
  // parent owns normal DROP of this whole acknowledged nonce DB/DATA fixture.
});
