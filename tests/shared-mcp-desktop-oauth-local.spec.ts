import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { sharedMcpDesktopActorFingerprint, sharedMcpDesktopSessionFingerprint } from '../app/lib/mcp/shared-desktop-oauth-contract';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight, waitForAuthRetry } from './helpers/managed-test-context';
import { launchOwnedSharedMcpElectron, readOwnedSharedMcpElectronReceipt, closeOwnedSharedMcpElectron } from './helpers/shared-mcp-oauth-electron';
import { startMcpOAuthProvider } from './fixtures/mcp-oauth-provider.mjs';
import type { IntegrationConnectionDescriptor, SharedIntegrationConnectionOwnership } from '../app/lib/integration-tools/connections/contracts';
import type { ClientWorkspaceResponse } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';
import de from '../messages/de.json';

type DirectoryProof = { device: string; inode: string };
type DesktopPaths = { userData: string; sessionData: string; temp: string; logs: string; crashDumps: string };
type Fixture = { version: 1; nonce: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; rootDevice: string; rootInode: string; databaseName: string; createAcknowledged: boolean;
  phase: string; serverPid: number; actorId: string; listenerVerified: boolean; uncertain: boolean;
  nativeIdentityDiagnostic?: boolean;
  tlsFiles: { key: { path: string; device: string; inode: string }; certificate: { path: string; device: string; inode: string } };
  directoryProofs: Record<string, DirectoryProof>; desktopPaths: DesktopPaths; desktopDirectoryProofs: Record<string, DirectoryProof> };
type OwnedConnection = { scope: 'organization' | 'team'; label: string; workspaceId: string; initial: IntegrationConnectionDescriptor;
  current: IntegrationConnectionDescriptor; states: string[]; startWrites: number; finalizeWrites: number; cancelWrites: number;
  startIntent?: 'native-api' };
type Receipt = { version: 1; nonce: string; actorId: string; managerActorId: string; phase: string; outstanding: string | null; acceptance?: false;
  closedContexts: boolean; providerClosed: boolean; electronClosed: boolean; processes: Array<{ pid: number; processGroupId: number; closed: true }>;
  providerOrigin: string; systemBrowserOpenedCount: number; desktopPaths: DesktopPaths; desktopDirectoryProofs: Record<string, DirectoryProof>;
  connections: Array<{ connectionRef: string; workspaceId: string; metadataRevision: number; grantsRevision: number; bindingRevision: number }>;
  membershipIds: string[]; workspaceIds: string[]; forbiddenRequests: string[]; unexpectedDialogs: string[];
  providerCounters?: Record<string, number>; visualInventory: string[];
  apiFlowCancelled?: true;
  challenge?: { nonce: string; origin: string; scope: string; action: 'approve' | 'close' | 'cancel'; sequence: number };
  ledgerProofs: Array<{ connectionRef: string; rows: number; stateHash?: string; authSessionHash?: string; actorHash?: string }>;
  failure?: { name: string; site?: string; stage?: string; boundary?: 'cookie-aba' | 'frame'; replacementStatus?: number;
    kind?: 'proof_changed' | 'proof_exists' | 'evaluation_context_or_protocol' | 'target_closed' | 'barrier_release_js_error' | 'other' } };
type Harness = Awaited<ReturnType<typeof launchOwnedSharedMcpElectron>>;
type Provider = Awaited<ReturnType<typeof startMcpOAuthProvider>>;
const baseUrl = 'http://127.0.0.1:3001';
const diagnostic = process.env.CANVAS_SHARED_MCP_DESKTOP_IDENTITY_DIAGNOSTIC_RUN === '1';
let fixture: Fixture, receipt: Receipt, receiptPath = '', fixturePath = '';
let admin: BrowserContext | undefined, manager: BrowserContext | undefined, anonymous: BrowserContext | undefined;
let harness: Harness | undefined, provider: Provider | undefined, tls: { key: Buffer; cert: Buffer } | undefined;
let managerId = '', personalWorkspaceId = '', adminWorkspaceId = '', teamId = '', organizationId = '', nativeAuthSessionHash = '';
let ledgerPoolsClosed = true;
const connections: OwnedConnection[] = [];
let receiptWrite = Promise.resolve(), verifiedCases = 0, releaseStart: (() => void) | undefined;
let holdingStart = false, startHeld = false, manualDeadline = 0;

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

async function readOwnedSharedDesktopFixture(): Promise<Fixture> {
  if (process.env.CANVAS_SHARED_MCP_DESKTOP_IDENTITY_DIAGNOSTIC_RUN !== undefined
    && process.env.CANVAS_SHARED_MCP_DESKTOP_IDENTITY_DIAGNOSTIC_RUN !== '1') {
    throw new Error('Native identity diagnostics require the explicit fixed launcher flag.');
  }
  for (const flag of ['CANVAS_SHARED_MCP_DESKTOP_OAUTH_BROWSER_RUN', 'CANVAS_SHARED_MCP_OAUTH_BROWSER_RUN',
    'CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN', 'CANVAS_AGENT_SETTINGS_BROWSER_RUN', 'E2E_EXTERNAL_SERVER']) expect(process.env[flag]).toBe('1');
  expect(process.env.BASE_URL).toBe(baseUrl);
  const file = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
  if (!file || !path.isAbsolute(file) || path.basename(file) !== 'recovery.json') throw new Error('The exact owned recovery receipt is required.');
  fixturePath = file;
  const before = await fs.lstat(file);
  expect(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size < 64 * 1024).toBe(true);
  expect(before.mode & 0o777).toBe(0o600); expect(before.uid).toBe(process.getuid?.());
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: Fixture;
  try { const held = await handle.stat(); expect(held.ino === before.ino && held.dev === before.dev).toBe(true); value = JSON.parse(await handle.readFile('utf8')) as Fixture; }
  finally { await handle.close(); }
  expect(value).toMatchObject({ version: 1, createAcknowledged: true, phase: 'browser', listenerVerified: true, uncertain: false });
  expect(value.nativeIdentityDiagnostic === undefined || typeof value.nativeIdentityDiagnostic === 'boolean').toBe(true);
  expect(value.nativeIdentityDiagnostic ?? false).toBe(diagnostic);
  expect(/^[a-f0-9]{32}$/u.test(value.nonce)).toBe(true); expect(value.databaseName).toBe(`canvas_connection_test_${value.nonce}`);
  expect(value.actorId).toBeTruthy(); expect(Number.isSafeInteger(value.serverPid) && value.serverPid > 0).toBe(true);
  expect(await fs.realpath(process.cwd())).toBe(value.repo); expect(path.dirname(file)).toBe(value.fixtureRoot);
  const root = await fs.lstat(value.fixtureRoot);
  expect(root.isDirectory() && !root.isSymbolicLink()).toBe(true); expect(root.mode & 0o777).toBe(0o700); expect(root.uid).toBe(before.uid);
  expect(await fs.realpath(value.fixtureRoot)).toBe(value.fixtureRoot); expect(String(root.dev)).toBe(value.rootDevice); expect(String(root.ino)).toBe(value.rootInode);
  const marker = await fs.lstat(path.join(value.fixtureRoot, '.fixture-owner'));
  expect(marker.isFile() && !marker.isSymbolicLink() && marker.nlink === 1 && (marker.mode & 0o777) === 0o600 && marker.uid === root.uid).toBe(true);
  expect(await fs.readFile(path.join(value.fixtureRoot, '.fixture-owner'), 'utf8')).toBe(value.ownerMarker);
  expect(process.env.DATA).toBe(value.dataRoot); expect(process.env.TMPDIR).toBe(value.tmpRoot);
  expect(process.env.CANVAS_SHARED_MCP_DESKTOP_RECEIPT).toBe(path.join(value.fixtureRoot, 'desktop-receipt.json'));
  expect(JSON.parse(process.env.CANVAS_SHARED_MCP_DESKTOP_PATHS ?? 'null')).toEqual(value.desktopPaths);
  for (const directory of [value.dataRoot, value.tmpRoot, ...Object.values(value.desktopPaths)]) {
    expect(await fs.realpath(directory)).toBe(directory); const stat = await fs.lstat(directory);
    expect(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === root.uid && (stat.mode & 0o777) === 0o700).toBe(true);
    expect({ device: String(stat.dev), inode: String(stat.ino) }).toEqual(value.desktopDirectoryProofs[directory] ?? value.directoryProofs[directory]);
    expect(directory === value.dataRoot || directory === value.tmpRoot || path.dirname(directory) === value.tmpRoot).toBe(true);
  }
  const pem: Partial<{ key: Buffer; cert: Buffer }> = {};
  for (const [field, filename, environment, target] of [['key', 'tls-key.pem', process.env.CANVAS_SHARED_MCP_OAUTH_TLS_KEY, 'key'],
    ['certificate', 'tls-cert.pem', process.env.CANVAS_SHARED_MCP_OAUTH_TLS_CERT, 'cert']] as const) {
    const proof = value.tlsFiles[field]; expect(proof.path).toBe(path.join(value.fixtureRoot, filename)); expect(environment).toBe(proof.path);
    const stat = await fs.lstat(proof.path); expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === root.uid && stat.size > 0 && stat.size < 64 * 1024).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600); expect({ device: String(stat.dev), inode: String(stat.ino) }).toEqual({ device: proof.device, inode: proof.inode });
    const opened = await fs.open(proof.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const held = await opened.stat(); expect(held.dev === stat.dev && held.ino === stat.ino).toBe(true); pem[target] = await opened.readFile(); }
    finally { await opened.close(); }
  }
  expect(process.env.NODE_EXTRA_CA_CERTS).toBe(value.tlsFiles.certificate.path);
  if (!pem.key || !pem.cert) throw new Error('The exact owned HTTPS issuer files are required.'); tls = { key: pem.key, cert: pem.cert }; return value;
}

async function persistSharedDesktopReceipt(): Promise<void> {
  const browserValue = JSON.stringify({ ...receipt, processes: undefined, desktopPaths: undefined, desktopDirectoryProofs: undefined });
  const nativeValue = JSON.stringify(receipt);
  receiptWrite = receiptWrite.then(async () => {
    for (const [file, value] of [[receiptPath, browserValue], [path.join(fixture.fixtureRoot, 'desktop-receipt.json'), nativeValue]]) {
      const temporary = `${file}.tmp`; await fs.writeFile(temporary, value, { mode: 0o600 }); await fs.rename(temporary, file);
    }
  });
  await receiptWrite;
}

async function readExactSharedDesktopConnection(owned: OwnedConnection): Promise<IntegrationConnectionDescriptor> {
  if (!manager) throw new Error('The original manager context is required.');
  const response = await manager.request.get(`/api/integrations/shared-connections/${encodeURIComponent(owned.initial.resource.connectionRef)}?${new URLSearchParams({ workspaceId: owned.workspaceId })}`);
  expect(response.status()).toBe(200); const payload = await response.json() as { success: boolean; data: { connection: IntegrationConnectionDescriptor } };
  expect(payload.success).toBe(true); const current = payload.data.connection;
  expect(current.resource.connectionRef).toBe(owned.initial.resource.connectionRef); expect(current.resource.createdByUserId).toBe(fixture.actorId);
  expect(current.resource.ownership).toEqual(owned.initial.resource.ownership); expect(current.resource.displayName).toBe(owned.label);
  expect(current.resource.status).toBe('active'); expect(current.access).toMatchObject({ canRead: true, canManage: true, canUse: false });
  expect(current.resource.metadataRevision).toBe(owned.initial.resource.metadataRevision); expect(current.resource.grantsRevision).toBe(owned.initial.resource.grantsRevision);
  return current;
}

async function createOwnSharedDesktopConnections(): Promise<void> {
  if (!admin || !provider) throw new Error('Owned admin and HTTPS issuer are required.');
  for (const [index, scope] of (['organization', 'team', 'organization', 'team'] as const).entries()) {
    const ownership = scope === 'team' ? { type: 'team' as const, workspaceId: teamId } : { type: 'organization' as const };
    const workspaceId = scope === 'team' ? teamId : personalWorkspaceId;
    const label = `Shared desktop ${scope} ${index} ${fixture.nonce}`;
    receipt.outstanding = `create:${scope}:${index}`; await persistSharedDesktopReceipt();
    const response = await admin.request.post(`/api/integrations/shared-connections?${new URLSearchParams({ workspaceId: scope === 'team' ? teamId : adminWorkspaceId })}`, { data: {
      displayName: label, ownership, source: 'mcp', config: { url: provider.url, transport: 'http', auth: 'oauth' }, secrets: [],
      accessMode: 'restricted', allowedToolNames: [], grants: [{ targetType: 'user', targetId: managerId, canUse: false, canManage: true, allowedToolNames: [] }],
    } });
    expect(response.status()).toBe(200); const payload = await response.json() as { success: boolean; data: { connection: IntegrationConnectionDescriptor } };
    expect(payload.success).toBe(true); const initial = payload.data.connection;
    expect(initial.resource.source).toBe('mcp'); expect(initial.resource.createdByUserId).toBe(fixture.actorId); expect(initial.resource.displayName).toBe(label);
    const owner: SharedIntegrationConnectionOwnership = scope === 'team' ? { type: 'team', organizationId, workspaceId: teamId } : { type: 'organization', organizationId };
    expect(initial.resource.ownership).toEqual(owner); expect(initial.resource.accessMode).toBe('restricted');
    expect(/^canvas-connection:[a-f0-9-]{36}$/u.test(initial.resource.connectionRef)).toBe(true);
    const owned: OwnedConnection = { scope, label, workspaceId, initial, current: initial, states: [], startWrites: 0, finalizeWrites: 0, cancelWrites: 0 };
    owned.current = await readExactSharedDesktopConnection(owned); connections.push(owned);
    receipt.connections.push({ connectionRef: initial.resource.connectionRef, workspaceId, metadataRevision: initial.resource.metadataRevision,
      grantsRevision: initial.resource.grantsRevision, bindingRevision: initial.resource.bindingRevision });
    receipt.outstanding = null; await persistSharedDesktopReceipt();
  }
}

async function observeSharedDesktopRequests(page: Page): Promise<void> {
  page.on('dialog', async dialog => { receipt.unexpectedDialogs.push(dialog.type()); await persistSharedDesktopReceipt(); await dialog.dismiss(); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl) { receipt.forbiddenRequests.push(`renderer-external:${method}`); await persistSharedDesktopReceipt(); await route.abort(); return; }
    if (url.pathname.startsWith('/api/mcp/oauth') || url.pathname.startsWith('/api/integrations/mcp')) {
      receipt.forbiddenRequests.push(`personal-oauth:${method}`); await persistSharedDesktopReceipt(); await route.abort(); return;
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      if (url.pathname.startsWith('/api/mcp/shared-connections/')) {
        const expected = connections.find(value => url.pathname === `/api/mcp/shared-connections/${encodeURIComponent(value.initial.resource.connectionRef)}/oauth`
          || url.pathname === `/api/mcp/shared-connections/${encodeURIComponent(value.initial.resource.connectionRef)}/oauth/desktop`);
        expect(Boolean(expected)).toBe(true); expect(request.headers()['x-canvas-workspace-id']).toBe(expected!.workspaceId);
        if (url.pathname.endsWith('/desktop')) {
          expect([...url.searchParams.keys()].sort()).toEqual(['state', 'workspaceId']); expect(url.searchParams.get('workspaceId')).toBe(expected!.workspaceId);
          expect(expected!.states.includes(url.searchParams.get('state') ?? '')).toBe(true);
        }
      }
      await route.continue(); return;
    }
    const owned = connections.find(value => url.pathname === `/api/mcp/shared-connections/${encodeURIComponent(value.initial.resource.connectionRef)}/oauth`
      || url.pathname === `/api/mcp/shared-connections/${encodeURIComponent(value.initial.resource.connectionRef)}/oauth/desktop`);
    if (owned && method === 'POST') {
      expect(url.searchParams.get('workspaceId')).toBe(owned.workspaceId); expect(request.headers()['x-canvas-workspace-id']).toBe(owned.workspaceId);
      const body = request.postDataJSON() as Record<string, unknown>;
      if (url.pathname.endsWith('/oauth')) {
        expect(body).toEqual({ expectedMetadataRevision: owned.current.resource.metadataRevision, expectedGrantsRevision: owned.current.resource.grantsRevision,
          expectedBindingRevision: owned.current.resource.bindingRevision, desktop: true, returnLocale: owned.scope === 'team' ? 'de' : 'en' });
        owned.startWrites += 1; expect(owned.startWrites).toBe(1); receipt.outstanding = `start:${owned.scope}`;
        const original = await route.fetch({ timeout: 35_000 }); expect(original.status()).toBe(200);
        const result = await original.json() as { success: boolean; data: { desktop: boolean; connectionRef: string; state: string; authorizationUrl: string; redirectUri: string; expiresAt: string } };
        expect(result.success).toBe(true); expect(result.data.desktop).toBe(true); expect(result.data.connectionRef).toBe(owned.initial.resource.connectionRef);
        expect(/^desktop_[A-Za-z0-9_-]{32}$/u.test(result.data.state)).toBe(true); expect(Date.parse(result.data.expiresAt) > Date.now()).toBe(true);
        expect(new URL(result.data.authorizationUrl).origin === provider?.origin && new URL(result.data.authorizationUrl).pathname === '/authorize').toBe(true);
        expect(result.data.redirectUri === `${baseUrl}/api/mcp/oauth/callback`).toBe(true); owned.states.push(result.data.state);
        if (holdingStart) { startHeld = true; receipt.phase = 'start_original_response_held'; await persistSharedDesktopReceipt(); await new Promise<void>(resolve => { releaseStart = resolve; }); }
        await route.fulfill({ response: original }); return;
      }
      expect(Object.keys(body).sort()).toEqual(['action', 'state']); expect(owned.states.includes(String(body.state))).toBe(true);
      expect(body.action === 'finalize' || body.action === 'cancel').toBe(true);
      if (body.action === 'finalize') owned.finalizeWrites += 1; else owned.cancelWrites += 1;
      await persistSharedDesktopReceipt(); await route.continue(); return;
    }
    if (method === 'POST' && url.pathname === '/api/instance/human-activity' && !request.postData()) { await route.continue(); return; }
    if (method === 'POST' && url.pathname === '/api/files/watch') {
      const body = request.postDataJSON() as { clientId?: unknown; dirs?: unknown };
      if ([personalWorkspaceId, teamId].includes(url.searchParams.get('workspaceId') ?? '') && Object.keys(body).sort().join(',') === 'clientId,dirs'
        && typeof body.clientId === 'string' && /^client-\d+-[a-z0-9]{1,9}$/u.test(body.clientId) && Array.isArray(body.dirs) && body.dirs.length === 0) { await route.continue(); return; }
    }
    if (method === 'POST' && url.pathname === '/api/auth/sign-in/email') {
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['email', 'password']);
      expect(body.email === process.env.TEST_SECONDARY_EMAIL && body.password === process.env.TEST_SECONDARY_PASSWORD).toBe(true);
      await route.continue(); return;
    }
    receipt.forbiddenRequests.push(`${method}:${url.pathname}`); await persistSharedDesktopReceipt(); await route.abort();
  });
}

async function readOwnedSharedDesktopLedger(owned: OwnedConnection, expectedCount: 0 | 1): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('An exact owned native database is required for readonly ledger verification.');
  const databaseUrl = new URL(connectionString);
  expect(databaseUrl.protocol === 'postgres:' || databaseUrl.protocol === 'postgresql:').toBe(true);
  expect(databaseUrl.hostname).toBe('127.0.0.1'); expect(databaseUrl.port).toBe('55433');
  expect(databaseUrl.pathname).toBe(`/${fixture.databaseName}`); expect(databaseUrl.search).toBe(''); expect(databaseUrl.hash).toBe(''); expect(databaseUrl.username.length > 0).toBe(true);
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 10_000, options: '-c default_transaction_read_only=on -c statement_timeout=10000' });
  ledgerPoolsClosed = false;
  try {
    const actual = await pool.query<{ name: string }>('SELECT current_database() AS name'); expect(actual.rows[0]?.name).toBe(fixture.databaseName);
    const result = await pool.query<{ state_hash: string; auth_session_hash: string; actor_hash: string; initiating_user_id: string;
      pre_metadata_revision: string | number; pre_grants_revision: string | number; pre_binding_revision: string | number; published_binding_revision: string | number }>(
      `SELECT state_hash,auth_session_hash,actor_hash,initiating_user_id,pre_metadata_revision,pre_grants_revision,pre_binding_revision,published_binding_revision
       FROM mcp_shared_desktop_oauth_commits WHERE connection_ref=$1 ORDER BY committed_at LIMIT 2`, [owned.initial.resource.connectionRef]);
    expect(result.rows.length).toBe(expectedCount);
    const row = result.rows[0];
    if (row) {
      const expectedActor = sharedMcpDesktopActorFingerprint({ userId: managerId, workspaceId: owned.workspaceId });
      expect(row.state_hash === createHash('sha256').update(owned.states[0]).digest('hex')).toBe(true);
      expect(row.auth_session_hash === nativeAuthSessionHash).toBe(true); expect(row.actor_hash === expectedActor).toBe(true); expect(row.initiating_user_id === managerId).toBe(true);
      expect(Number(row.pre_metadata_revision)).toBe(owned.initial.resource.metadataRevision); expect(Number(row.pre_grants_revision)).toBe(owned.initial.resource.grantsRevision);
      expect(Number(row.pre_binding_revision)).toBe(owned.initial.resource.bindingRevision); expect(Number(row.published_binding_revision)).toBe(owned.initial.resource.bindingRevision + 1);
      receipt.ledgerProofs.push({ connectionRef: owned.initial.resource.connectionRef, rows: expectedCount, stateHash: row.state_hash, authSessionHash: row.auth_session_hash, actorHash: row.actor_hash });
    } else receipt.ledgerProofs.push({ connectionRef: owned.initial.resource.connectionRef, rows: 0 });
  } catch { throw new Error('The own readonly desktop ledger assertion failed; preserve the private fixture.'); }
  finally { await pool.end(); ledgerPoolsClosed = true; }
}

async function waitForOriginalSharedDesktopCompletion(owned: OwnedConnection, sequence: number): Promise<void> {
  if (!harness || !provider) throw new Error('The issued native app and HTTPS provider are required.');
  const labels = owned.scope === 'team' ? de.sharedConnections : en.sharedConnections;
  receipt.challenge = { nonce: fixture.nonce, origin: provider.origin, scope: owned.scope, action: 'approve', sequence };
  receipt.phase = 'awaiting_system_browser_consent'; await persistSharedDesktopReceipt();
  console.info(`OWN_SHARED_DESKTOP_HANDOFF ${JSON.stringify(receipt.challenge)}`);
  // Only the real OS browser opened by shell may perform consent. No Playwright goto(authorizationUrl), synthetic callback, or certificate bypass.
  await expect.poll(() => provider!.stats.consents, { timeout: Math.max(1, Math.min(8 * 60_000, manualDeadline - Date.now())), message: 'Await the owned system-browser HTTPS security handoff and genuine consent page.' }).toBe(sequence);
  await expect.poll(() => provider!.stats.approvals, { timeout: Math.max(1, Math.min(8 * 60_000, manualDeadline - Date.now())), message: 'Await actual approval in the owned system-browser tab.' }).toBe(sequence);
  const dialog = harness.page.getByTestId('shared-connection-edit-dialog');
  await expect(dialog.getByText(labels.connected, { exact: true })).toBeVisible({ timeout: 60_000 });
  const current = await readExactSharedDesktopConnection(owned);
  expect(current.resource.bindingRevision).toBe(owned.initial.resource.bindingRevision + 1); expect(current.grants).toEqual(owned.current.grants);
  const statusResponse = await harness.page.request.get(`${baseUrl}/api/mcp/shared-connections/${encodeURIComponent(current.resource.connectionRef)}/oauth?${new URLSearchParams({ workspaceId: owned.workspaceId })}`);
  expect(statusResponse.status()).toBe(200);
  const statusPayload = await statusResponse.json() as { success?: unknown; data?: unknown } | null;
  if (statusPayload?.success !== true || !statusPayload.data || typeof statusPayload.data !== 'object' || Array.isArray(statusPayload.data)) {
    throw new Error('The original native OAuth status has no successful object reply.');
  }
  const status = statusPayload.data as { configured: boolean; authorized: boolean; requiresAuth: boolean; code?: string | null };
  expect(status.configured && status.authorized && status.requiresAuth && (status.code === null || status.code === undefined)).toBe(true);
  const state = owned.states[0]; expect(typeof state === 'string').toBe(true);
  const stateQuery = new URLSearchParams({ workspaceId: owned.workspaceId, state });
  const summary = await harness.page.request.get(`${baseUrl}/api/mcp/shared-connections/${encodeURIComponent(current.resource.connectionRef)}/oauth/desktop?${stateQuery}`);
  expect(summary.status()).toBe(200); expect(summary.headers()['cache-control']).toContain('no-store');
  const summaryPayload = await summary.json() as { success?: unknown; data?: unknown } | null;
  if (summaryPayload?.success !== true || !summaryPayload.data || typeof summaryPayload.data !== 'object' || Array.isArray(summaryPayload.data)) {
    throw new Error('The original native desktop status has no successful object reply.');
  }
  const summaryBody = summaryPayload.data as Record<string, unknown>;
  expect(summaryBody.status).toBe('completed'); expect(summaryBody.connectionRef).toBe(current.resource.connectionRef); expect(summaryBody.state === state).toBe(true);
  expect(Object.keys(summaryBody).every(key => ['connectionRef', 'state', 'status', 'expiresAt', 'code'].includes(key))).toBe(true);
  await readOwnedSharedDesktopLedger(owned, 1);
  const replay = await harness.page.request.post(`${baseUrl}/api/mcp/shared-connections/${encodeURIComponent(current.resource.connectionRef)}/oauth/desktop?${new URLSearchParams({ workspaceId: owned.workspaceId })}`,
    { data: { state, action: 'finalize' }, headers: { Origin: baseUrl } });
  expect(replay.status()).toBe(200);
  const replayPayload = await replay.json() as { success?: unknown; data?: unknown } | null;
  if (replayPayload?.success !== true || !replayPayload.data || typeof replayPayload.data !== 'object' || Array.isArray(replayPayload.data)) {
    throw new Error('The original native desktop replay has no successful object reply.');
  }
  expect((replayPayload.data as Record<string, unknown>).status).toBe('completed');
  await readOwnedSharedDesktopLedger(owned, 1);
  expect(provider.stats.tokenExchanges).toBe(sequence); expect(provider.stats.toolCalls).toBe(0);
  const main = await readOwnedSharedMcpElectronReceipt(harness);
  expect(main.shellAcknowledged).toBe(sequence); expect(main.shellFailures).toBe(0); expect(main.uncertain).toBe(false);
  expect(main.openings.some(opening => opening.stateHash === createHash('sha256').update(state).digest('hex'))).toBe(true);
  owned.current = current; receipt.connections = receipt.connections.map(value => value.connectionRef === current.resource.connectionRef
    ? { ...value, bindingRevision: current.resource.bindingRevision } : value);
  receipt.systemBrowserOpenedCount = main.shellAcknowledged; receipt.outstanding = null; delete receipt.challenge;
  receipt.phase = 'original_manager_completed'; await persistSharedDesktopReceipt();
}

async function assertNoSharedDesktopMutationAfterIdentityChange(owned: OwnedConnection, before: { exchanges: number; openings: number }): Promise<void> {
  if (!harness || !provider) throw new Error('The issued native app and provider are required.');
  const current = await readExactSharedDesktopConnection(owned);
  expect(current.resource.bindingRevision).toBe(owned.initial.resource.bindingRevision); expect(current.grants).toEqual(owned.current.grants);
  expect(provider.stats.tokenExchanges).toBe(before.exchanges); expect(provider.stats.toolCalls).toBe(0);
  const proof = await readOwnedSharedMcpElectronReceipt(harness);
  expect(proof.shellAcknowledged).toBe(before.openings); expect(proof.shellAttempts).toBe(before.openings); expect(proof.uncertain).toBe(false);
  expect(owned.finalizeWrites).toBe(0); expect(owned.cancelWrites).toBe(0); await readOwnedSharedDesktopLedger(owned, 0);
  await expect(harness.page.getByTestId('shared-connection-edit-dialog').getByText(de.sharedConnections.connected, { exact: true })).toHaveCount(0);
}

async function closeOwnedSharedDesktopContexts(): Promise<void> {
  let closed = true, problem = false;
  holdingStart = false; releaseStart?.(); releaseStart = undefined;
  if (harness) {
    const currentHarness = harness;
    let mayCloseElectron = true;
    try {
      const main = await readOwnedSharedMcpElectronReceipt(currentHarness); receipt.systemBrowserOpenedCount = main.shellAcknowledged;
      if (main.shellFailures !== 0 || main.uncertain) problem = true;
    } catch { problem = true; }
    let teardownStage = 'current_target';
    try {
      const editor = currentHarness.page.getByTestId('shared-connection-edit-dialog');
      const apiFlow = connections[3]?.startIntent === 'native-api' ? connections[3] : null;
      if (apiFlow && await editor.count() !== 1) throw new Error('The owned API-start teardown has no exact native editor.');
      if (await editor.count()) {
        await expect(editor).toBeVisible();
        const currentUrl = new URL(currentHarness.page.url());
        const owned = connections.find(value => currentUrl.origin === baseUrl
          && currentUrl.pathname === `/${value.scope === 'team' ? 'de' : 'en'}/plugins`
          && currentUrl.searchParams.get('connectionRef') === value.initial.resource.connectionRef
          && currentUrl.searchParams.get('workspaceId') === value.workspaceId
          && currentUrl.searchParams.get('scope') === value.scope
          && (value.scope !== 'team' || currentUrl.searchParams.get('teamId') === teamId));
        if (!owned) throw new Error('The current native dialog is not an exact owned teardown target.');
        if (apiFlow && (apiFlow.scope !== 'team' || apiFlow.workspaceId !== teamId || apiFlow.startWrites !== 1
          || apiFlow.states.length !== 1 || (owned !== apiFlow && owned !== connections[1]))) {
          throw new Error('The owned API-start teardown selection is ambiguous.');
        }
        const flow = apiFlow ?? owned;
        const labels = owned.scope === 'team' ? de.sharedConnections : en.sharedConnections;
        await expect(editor.locator('#shared-edit-name')).toHaveValue(owned.current.resource.displayName);
        const cancel = editor.getByTestId('shared-desktop-cancel');
        const checkStatus = editor.getByRole('button', { name: labels.checkStatus, exact: true });
        // A released genuine start ACK must reach either its live flow or an already settled editor before shutdown.
        if (!apiFlow && owned.startWrites > 0) {
          teardownStage = 'start_settlement';
          await expect.poll(async () => await cancel.isVisible() || await checkStatus.isEnabled(), { timeout: 15_000 }).toBe(true);
        }
        if (apiFlow || await cancel.isVisible()) {
          teardownStage = 'original_identity';
          expect(flow.states.length).toBe(1);
          const state = flow.states[0];
          expect(typeof state === 'string' && /^desktop_[A-Za-z0-9_-]{32}$/u.test(state)).toBe(true);
          const identityResponse = await currentHarness.page.request.get(`${baseUrl}/api/auth/get-session`, { timeout: 15_000 });
          expect(identityResponse.status()).toBe(200);
          const identity = await identityResponse.json() as { user?: { id?: string }; session?: { id?: string } };
          expect(identity.user?.id === managerId && typeof identity.session?.id === 'string'
            && sharedMcpDesktopSessionFingerprint(identity.session.id) === nativeAuthSessionHash).toBe(true);
          const desktopPath = `/api/mcp/shared-connections/${encodeURIComponent(flow.initial.resource.connectionRef)}/oauth/desktop`;
          receipt.outstanding = `${apiFlow ? 'teardown_api_cancel' : 'teardown_cancel'}:${flow.scope}`; await persistSharedDesktopReceipt();
          let response;
          if (apiFlow) {
            // This branch never clicked Connect, so it must not claim a UI Cancel. Use the exact original native session and captured start.
            teardownStage = 'api_cancel_ack';
            await expect(cancel).toHaveCount(0); expect(flow.cancelWrites).toBe(0); flow.cancelWrites += 1;
            response = await currentHarness.page.request.post(`${baseUrl}${desktopPath}?${new URLSearchParams({ workspaceId: flow.workspaceId })}`,
              { timeout: 15_000, headers: { Origin: baseUrl }, data: { state, action: 'cancel' } });
          } else {
            teardownStage = 'cancel_enabled';
            await expect(cancel).toBeEnabled();
            const cancelResponse = currentHarness.page.waitForResponse(response => {
              const url = new URL(response.url()), request = response.request();
              if (url.origin !== baseUrl || url.pathname !== desktopPath || url.searchParams.get('workspaceId') !== flow.workspaceId
                || request.method() !== 'POST') return false;
              const body = request.postDataJSON() as Record<string, unknown>;
              return Object.keys(body).sort().join(',') === 'action,state' && body.action === 'cancel' && body.state === state;
            }, { timeout: 15_000 });
            teardownStage = 'cancel_ack';
            [response] = await Promise.all([cancelResponse, cancel.click()]);
          }
          expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toContain('no-store');
          const payload = await response.json() as { success?: boolean; data?: Record<string, unknown> };
          const terminal = payload.data;
          teardownStage = 'terminal_shape';
          if (!terminal) throw new Error('The original native cancellation has no terminal acknowledgement.');
          expect(payload.success === true && terminal.connectionRef === flow.initial.resource.connectionRef && terminal.state === state
            && typeof terminal.expiresAt === 'string' && Number.isFinite(Date.parse(terminal.expiresAt))
            && ['cancelled', 'completed', 'expired', 'failed'].includes(String(terminal.status))
            && Object.keys(terminal).every(key => ['connectionRef', 'state', 'status', 'expiresAt', 'code', 'error'].includes(key))).toBe(true);
          expect(terminal.status === 'completed' ? !Object.hasOwn(terminal, 'code') && !Object.hasOwn(terminal, 'error')
            : terminal.status === 'cancelled' ? terminal.code === 'CONNECTION_DESKTOP_OAUTH_CANCELLED' && terminal.error === 'Shared sign-in was cancelled.'
              : terminal.status === 'expired' ? terminal.code === 'CONNECTION_DESKTOP_OAUTH_EXPIRED' && terminal.error === 'Shared sign-in expired. Start again.'
                : terminal.code === 'CONNECTION_DESKTOP_OAUTH_FAILED' && terminal.error === 'Shared sign-in could not be completed. Reload and start again.').toBe(true);
          if (apiFlow) expect(terminal.status).toBe('cancelled');
          teardownStage = 'current_status';
          const statusResponse = await currentHarness.page.request.get(`${baseUrl}${desktopPath}?${new URLSearchParams({ workspaceId: flow.workspaceId, state })}`, { timeout: 15_000 });
          expect(statusResponse.status()).toBe(200); expect(statusResponse.headers()['cache-control']).toContain('no-store');
          const currentStatus = await statusResponse.json() as { success?: boolean; data?: Record<string, unknown> };
          const observed = currentStatus.data;
          teardownStage = 'current_status_shape';
          if (!observed) throw new Error('The current native terminal status is unavailable.');
          expect(currentStatus.success === true && observed.connectionRef === terminal.connectionRef
            && observed.state === state && observed.status === terminal.status && observed.expiresAt === terminal.expiresAt
            && observed.code === terminal.code && observed.error === terminal.error
            && Object.keys(observed).every(key => ['connectionRef', 'state', 'status', 'expiresAt', 'code', 'error'].includes(key))
            && (observed.status !== 'completed' || !Object.hasOwn(observed, 'code') && !Object.hasOwn(observed, 'error'))).toBe(true);
          if (apiFlow) {
            teardownStage = 'api_unchanged';
            const current = await readExactSharedDesktopConnection(flow);
            expect(current.resource.bindingRevision).toBe(flow.initial.resource.bindingRevision); expect(current.grants).toEqual(flow.current.grants);
            expect(flow.finalizeWrites).toBe(0); await readOwnedSharedDesktopLedger(flow, 0);
            teardownStage = 'api_editor_settlement';
            await expect(cancel).toHaveCount(0); await expect(editor.getByTestId('shared-connection-save')).toBeEnabled();
            receipt.apiFlowCancelled = true;
          } else {
            teardownStage = 'ui_settlement';
            await expect(cancel).toHaveCount(0);
            await expect(checkStatus).toBeEnabled({ timeout: 15_000 });
            teardownStage = 'ui_terminal_status';
            if (terminal.status === 'completed') {
              await expect.poll(async () => await editor.getByText(labels.connected, { exact: true }).isVisible()
                || await editor.getByText(labels.connectionRequired, { exact: true }).isVisible()).toBe(true);
            } else {
              await expect(editor.getByText(terminal.status === 'cancelled' ? labels.oauthCancelled : labels.oauthFailed, { exact: true })).toBeVisible();
            }
          }
          receipt.outstanding = null; await persistSharedDesktopReceipt();
        }
        // This actual dialog close also confirms the parent's synchronous write fence has settled.
        teardownStage = 'dialog_close';
        await editor.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(editor).toHaveCount(0);
      }
      // Removing test interception while the context is still open prevents a later Cancel being stranded by close().
      teardownStage = 'test_interception';
      await currentHarness.page.unrouteAll({ behavior: 'wait' });
    } catch { problem = true; mayCloseElectron = false; receipt.outstanding = `teardown_unconfirmed:${teardownStage}`; }
    if (mayCloseElectron) {
      try {
        teardownStage = 'electron_close';
        const result = await closeOwnedSharedMcpElectron(currentHarness);
        receipt.processes = [{ pid: result.processId, processGroupId: result.processGroupId, closed: true }]; receipt.electronClosed = true;
      } catch { problem = true; receipt.outstanding = `teardown_unconfirmed:${teardownStage}`; }
    }
  }
  for (const context of [admin, manager, anonymous]) { try { await context?.close(); } catch { closed = false; problem = true; } }
  receipt.closedContexts = closed;
  if (provider) {
    receipt.providerCounters = Object.fromEntries(Object.entries(provider.stats).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
    receipt.providerOrigin = provider.origin;
    if (provider.stats.consents !== receipt.systemBrowserOpenedCount || provider.stats.toolCalls !== 0) problem = true;
    try { await provider.close(); receipt.providerClosed = true; } catch { problem = true; }
  }
  if (diagnostic) {
    expect(problem).toBe(false); expect(verifiedCases).toBe(1); expect(ledgerPoolsClosed).toBe(true);
    expect(receipt.closedContexts).toBe(true); expect(receipt.providerClosed).toBe(true); expect(receipt.electronClosed).toBe(true);
    expect(receipt.outstanding).toBeNull(); expect(receipt.forbiddenRequests).toEqual([]); expect(receipt.unexpectedDialogs).toEqual([]);
    expect(receipt.apiFlowCancelled).toBe(true);
    if (!harness || !provider) throw new Error('The issued native diagnostic closure is required.');
    const main = await readOwnedSharedMcpElectronReceipt(harness);
    expect(main.phase).toBe('closed'); expect(main.uncertain).toBe(false);
    expect([main.shellAttempts, main.shellAcknowledged, main.shellFailures]).toEqual([0, 0, 0]);
    expect(receipt.systemBrowserOpenedCount).toBe(0);
    expect([provider.stats.consents, provider.stats.approvals, provider.stats.tokenExchanges,
      provider.stats.mcpInitializations, provider.stats.toolsLists, provider.stats.toolCalls]).toEqual([0, 0, 0, 0, 0, 0]);
    // This proves only the focused diagnostic's closure. The parent must still reject it as full native acceptance and preserve DB/DATA.
    receipt.phase = 'identity_diagnostic_closed'; receipt.acceptance = false; await persistSharedDesktopReceipt(); return;
  }
  if (problem || verifiedCases !== 3 || !ledgerPoolsClosed) {
    receipt.phase = 'preserved'; await persistSharedDesktopReceipt(); throw new Error('The own native acceptance or closure is incomplete; preserve the private fixture.');
  }
  expect(receipt.apiFlowCancelled).toBe(true);
  receipt.phase = 'awaiting_manual_system_browser_close'; await persistSharedDesktopReceipt();
  // Root/CUA or the human closes only the observed own AS tabs. This test never writes or infers that acknowledgement.
  const closurePath = path.join(fixture.fixtureRoot, 'system-browser-closure.json');
  await expect.poll(async () => { try { return (await fs.lstat(closurePath)).isFile(); } catch { return false; } },
    { timeout: Math.max(1, Math.min(8 * 60_000, manualDeadline - Date.now())), message: 'Root must confirm closure of exactly the owned system-browser tabs.' }).toBe(true);
  const stat = await fs.lstat(closurePath);
  expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.() && stat.size > 1 && stat.size < 2048).toBe(true);
  expect(stat.mode & 0o777).toBe(0o600); const handle = await fs.open(closurePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat(); expect(held.ino === stat.ino && held.dev === stat.dev).toBe(true);
    expect(JSON.parse(await handle.readFile('utf8'))).toEqual({ version: 1, nonce: fixture.nonce, origin: receipt.providerOrigin,
      openedCount: receipt.systemBrowserOpenedCount, closed: true });
  } finally { await handle.close(); }
  expect(closed).toBe(true); expect(ledgerPoolsClosed).toBe(true); expect(verifiedCases).toBe(3); expect(receipt.outstanding).toBeNull();
  expect(receipt.forbiddenRequests).toEqual([]); expect(receipt.unexpectedDialogs).toEqual([]);
  receipt.phase = 'verified_closed'; await persistSharedDesktopReceipt();
}

test.beforeAll(async ({ browser }) => {
  fixture = await readOwnedSharedDesktopFixture(); receiptPath = path.join(fixture.fixtureRoot, 'browser-receipt.json');
  receipt = { version: 1, nonce: fixture.nonce, actorId: fixture.actorId, managerActorId: '', phase: 'setup', outstanding: null,
    closedContexts: false, providerClosed: false, electronClosed: false, processes: [], providerOrigin: '', systemBrowserOpenedCount: 0,
    desktopPaths: fixture.desktopPaths, desktopDirectoryProofs: fixture.desktopDirectoryProofs, connections: [], membershipIds: [], workspaceIds: [],
    forbiddenRequests: [], unexpectedDialogs: [], visualInventory: [], ledgerProofs: [] };
  await persistSharedDesktopReceipt();
  admin = await createAuthenticatedContext(browser, { baseURL: baseUrl, extraHTTPHeaders: { Origin: baseUrl } });
  await runManagedTestPreflight(admin, { baseURL: baseUrl });
  const sessionResponse = await requestManagedTestSession(admin.request); expect(sessionResponse.status()).toBe(200);
  expect((await sessionResponse.json()).user).toMatchObject({ id: fixture.actorId, role: 'admin' });
  const health = await admin.request.get('/api/health'); expect(health.status()).toBe(200);
  expect((await health.json()).deployment).toMatchObject({ mode: 'team', teamFeaturesEnabled: true });
  const adminListingResponse = await admin.request.get('/api/workspaces'); expect(adminListingResponse.status()).toBe(200);
  const adminListing = await adminListingResponse.json() as ClientWorkspaceResponse;
  expect(adminListing.defaultWorkspace?.type).toBe('personal'); adminWorkspaceId = adminListing.defaultWorkspace!.id;
  const email = process.env.TEST_SECONDARY_EMAIL, password = process.env.TEST_SECONDARY_PASSWORD;
  if (!email || !password) throw new Error('The owned runner must provide private normal member credentials.');
  receipt.outstanding = 'membership:manager'; await persistSharedDesktopReceipt();
  const proposed = await admin.request.post('/api/admin/organization/memberships', { data: { name: `Desktop manager ${fixture.nonce}`, email, role: 'member' } });
  expect(proposed.status()).toBe(202); const proposal = (await proposed.json()).data as { membershipId: string; approval: { required: boolean }; quote: { nonBillable: boolean } };
  expect(proposal.approval.required).toBe(false); expect(proposal.quote.nonBillable).toBe(true); receipt.membershipIds.push(proposal.membershipId); await persistSharedDesktopReceipt();
  const activated = await admin.request.post(`/api/admin/organization/memberships/${encodeURIComponent(proposal.membershipId)}/activate`, { data: { password } });
  expect(activated.status()).toBe(200); expect((await activated.json()).data).toMatchObject({ stage: 'active', membershipId: proposal.membershipId, execution: { onboardingInitialized: true } });
  manager = await createAuthenticatedContext(browser, { baseURL: baseUrl, extraHTTPHeaders: { Origin: baseUrl } }, { email, password });
  const managerSession = await requestManagedTestSession(manager.request); expect(managerSession.status()).toBe(200);
  const identity = (await managerSession.json()).user as { id: string; role: string; email: string };
  expect(identity.email === email).toBe(true); expect(identity.role).toBe('user'); expect(identity.id === fixture.actorId).toBe(false);
  managerId = identity.id; receipt.managerActorId = managerId; receipt.outstanding = null;
  const listingResponse = await manager.request.get('/api/workspaces'); expect(listingResponse.status()).toBe(200);
  const listing = await listingResponse.json() as ClientWorkspaceResponse;
  expect(listing.defaultWorkspace?.type).toBe('personal'); personalWorkspaceId = listing.defaultWorkspace!.id; organizationId = listing.defaultWorkspace!.organizationId!;
  expect(personalWorkspaceId && organizationId).toBeTruthy();
  receipt.outstanding = 'workspace:team'; await persistSharedDesktopReceipt();
  const teamResponse = await admin.request.post('/api/workspaces', { data: { type: 'team', name: `Desktop team ${fixture.nonce}` } }); expect(teamResponse.status()).toBe(201);
  const team = (await teamResponse.json()).workspace as { id: string; type: string; organizationId: string; status: string };
  expect(team).toMatchObject({ type: 'team', organizationId, status: 'active' }); teamId = team.id; receipt.workspaceIds.push(teamId); await persistSharedDesktopReceipt();
  const joined = await admin.request.post(`/api/workspaces/${encodeURIComponent(teamId)}/members`, { data: { userId: managerId, role: 'member', canRead: true, canWrite: false, canManage: false } });
  expect(joined.status()).toBe(200); expect((await joined.json()).success).toBe(true); receipt.outstanding = null;
  if (!tls) throw new Error('The verified private HTTPS issuer is required.');
  provider = await startMcpOAuthProvider({ allowedRedirectOrigins: [baseUrl], tls, cleanAuthorizationAddress: true });
  expect(new URL(provider.origin).protocol).toBe('https:'); expect(new URL(provider.origin).hostname).toBe('127.0.0.1'); receipt.providerOrigin = provider.origin;
  await createOwnSharedDesktopConnections();
  anonymous = await browser.newContext({ baseURL: baseUrl });
  harness = await launchOwnedSharedMcpElectron({ fixturePath, providerOrigin: provider.origin });
  await observeSharedDesktopRequests(harness.page);
  // Real product login controls create the original manager's actual Electron-session cookies; no auth atom/preload replacement.
  await harness.page.goto(`${baseUrl}/en/login`, { waitUntil: 'domcontentloaded' });
  await harness.page.locator('#email').fill(email); await harness.page.locator('#password').fill(password);
  const nativeViewport = await harness.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(nativeViewport.width).toBe(1280); expect(nativeViewport.height > 600).toBe(true);
  const signedIn = harness.page.waitForResponse(response => new URL(response.url()).origin === baseUrl && new URL(response.url()).pathname === '/api/auth/sign-in/email' && response.request().method() === 'POST');
  await harness.page.locator('button[type="submit"]').click(); expect((await signedIn).status()).toBe(200);
  // Sign-in's HTTP ACK precedes the product's preferred-locale lookup and actual document redirect.
  await harness.page.waitForURL(url => url.origin === baseUrl && ['/', '/en', '/en/', '/de', '/de/'].includes(url.pathname), { waitUntil: 'domcontentloaded' });
  await expect(harness.page.getByRole('banner')).toBeVisible();
  await expect(harness.page.locator('#email')).toHaveCount(0);
  const nativeSession = await harness.page.request.get(`${baseUrl}/api/auth/get-session`); expect(nativeSession.status()).toBe(200);
  const nativeIdentity = await nativeSession.json() as { user: { id: string }; session: { id: string } };
  expect(nativeIdentity.user.id).toBe(managerId); expect(typeof nativeIdentity.session.id === 'string' && nativeIdentity.session.id.length > 0).toBe(true);
  nativeAuthSessionHash = sharedMcpDesktopSessionFingerprint(nativeIdentity.session.id);
  manualDeadline = Date.now() + 20 * 60_000;
  receipt.phase = 'native_original_manager_ready'; await persistSharedDesktopReceipt();
});

test('Org and Team Manage-only users complete actual system-browser consent once in the original Electron manager session', async () => {
  try {
    if (!harness || !provider) throw new Error('The owned native harness is required.');
    for (const [index, owned] of connections.slice(0, 2).entries()) {
      const locale = owned.scope === 'team' ? 'de' : 'en', labels = locale === 'de' ? de.sharedConnections : en.sharedConnections;
      const query = new URLSearchParams({ view: 'advanced', scope: owned.scope, workspaceId: owned.workspaceId, connectionRef: owned.initial.resource.connectionRef,
        ...(owned.scope === 'team' ? { teamId } : {}) });
      await harness.page.goto(`${baseUrl}/${locale}/plugins?${query}`, { waitUntil: 'domcontentloaded' });
      const editor = harness.page.getByTestId('shared-connection-edit-dialog'); await expect(editor).toBeVisible();
      await expect(editor.getByTestId('shared-connection-save')).toBeEnabled(); await expect(editor.getByText(labels.managementOnly, { exact: true })).toBeVisible();
      await editor.locator('summary').filter({ hasText: labels.accountSetup }).click();
      if (index === 0) {
        const currentUrl = harness.page.url(), previous = new URL(currentUrl); previous.searchParams.delete('connectionRef');
        await harness.page.evaluate(({ previous, current }) => { const actualNextState: unknown = window.history.state;
          window.history.replaceState(actualNextState, '', previous); window.history.pushState(actualNextState, '', current);
        }, { previous: previous.href, current: currentUrl });
        holdingStart = true; startHeld = false;
      }
      await editor.getByRole('button', { name: labels.connect, exact: true }).click();
      if (index === 0) {
        await expect.poll(() => startHeld).toBe(true); await editor.getByRole('button', { name: 'Close', exact: true }).click();
        await harness.page.keyboard.press('Escape'); await expect(editor).toBeVisible(); expect(owned.startWrites).toBe(1);
        const pendingPage = harness.page;
        const actualBack = pendingPage.waitForEvent('framenavigated', { timeout: 5000, predicate: frame => frame === pendingPage.mainFrame()
          && new URL(frame.url()).origin === baseUrl && new URL(frame.url()).searchParams.get('connectionRef') === null });
        await pendingPage.goBack({ waitUntil: 'commit', timeout: 5000 }); await actualBack;
        await expect.poll(() => { const current = new URL(pendingPage.url()); return current.searchParams.get('connectionRef') === owned.initial.resource.connectionRef
          && current.searchParams.get('workspaceId') === owned.workspaceId; }).toBe(true);
        await expect(editor).toBeVisible(); await expect(editor.locator('#shared-edit-name')).toHaveValue(owned.label);
        expect(owned.startWrites).toBe(1);
        expect(provider.stats.consents).toBe(0); expect(provider.stats.tokenExchanges).toBe(0); expect(receipt.unexpectedDialogs).toEqual([]);
        holdingStart = false; releaseStart?.(); releaseStart = undefined;
      }
      await expect(editor.getByText(labels.desktopWaiting, { exact: true })).toBeVisible();
      await expect(editor.getByTestId('shared-desktop-cancel')).toBeEnabled();
      const screenshot = `${owned.scope}-waiting-1280.png`; await harness.page.screenshot({ path: path.join(fixture.fixtureRoot, screenshot), scale: 'css' }); receipt.visualInventory.push(screenshot);
      await waitForOriginalSharedDesktopCompletion(owned, index + 1);
      expect(owned.startWrites).toBe(1); expect(owned.finalizeWrites).toBe(1); expect(owned.cancelWrites).toBe(0);
      expect(new URL(harness.page.url()).origin === baseUrl && new URL(harness.page.url()).searchParams.get('connectionRef') === owned.initial.resource.connectionRef).toBe(true);
      const completed = `${owned.scope}-completed-1280.png`; await harness.page.screenshot({ path: path.join(fixture.fixtureRoot, completed), scale: 'css' }); receipt.visualInventory.push(completed);
      await editor.getByRole('button', { name: 'Close', exact: true }).click(); await expect(editor).toHaveCount(0);
    }
    expect(provider.stats.tokenExchanges).toBe(2); expect(provider.stats.toolCalls).toBe(0); verifiedCases += 1;
  } catch (error) {
    const site = error instanceof Error ? error.stack?.match(/tests\/shared-mcp-desktop-oauth-local\.spec\.ts:(\d+):(\d+)/u) : null;
    receipt.failure = { name: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(error.name) ? error.name : 'UnknownError',
      ...(site ? { site: `tests/shared-mcp-desktop-oauth-local.spec.ts:${site[1]}:${site[2]}` } : {}) };
    await persistSharedDesktopReceipt(); throw new Error('The owned native completion assertion failed; inspect the private safe receipt.');
  }
});

test('a real live native flow blocks departure and explicit Cancel keeps the binding unpublished', async () => {
  try {
    if (!harness || !provider) throw new Error('The owned native harness is required.'); const owned = connections[2];
    await harness.page.goto(`${baseUrl}/en/plugins?${new URLSearchParams({ view: 'advanced', scope: owned.scope, workspaceId: owned.workspaceId, connectionRef: owned.initial.resource.connectionRef })}`,
      { waitUntil: 'domcontentloaded' });
    const editor = harness.page.getByTestId('shared-connection-edit-dialog'); await expect(editor.getByTestId('shared-connection-save')).toBeEnabled();
    await editor.locator('summary').filter({ hasText: en.sharedConnections.accountSetup }).click(); await editor.getByRole('button', { name: en.sharedConnections.connect, exact: true }).click();
    await expect(editor.getByText(en.sharedConnections.desktopWaiting, { exact: true })).toBeVisible();
    receipt.challenge = { nonce: fixture.nonce, origin: provider.origin, scope: owned.scope, action: 'cancel', sequence: 3 };
    receipt.phase = 'awaiting_system_browser_cancel_case'; await persistSharedDesktopReceipt(); console.info(`OWN_SHARED_DESKTOP_HANDOFF ${JSON.stringify(receipt.challenge)}`);
    await expect.poll(() => provider!.stats.consents, { timeout: Math.max(1, Math.min(8 * 60_000, manualDeadline - Date.now())) }).toBe(3);
    await editor.getByRole('button', { name: 'Close', exact: true }).click(); await harness.page.keyboard.press('Escape'); await expect(editor).toBeVisible();
    expect(receipt.unexpectedDialogs).toEqual([]); await editor.getByTestId('shared-desktop-cancel').click();
    await expect(editor.getByText(en.sharedConnections.oauthCancelled, { exact: true })).toBeVisible();
    expect(owned.cancelWrites).toBe(1); expect(owned.finalizeWrites).toBe(0); const current = await readExactSharedDesktopConnection(owned);
    expect(current.resource.bindingRevision).toBe(owned.initial.resource.bindingRevision); await readOwnedSharedDesktopLedger(owned, 0); expect(provider.stats.tokenExchanges).toBe(2);
    receipt.challenge = { nonce: fixture.nonce, origin: provider.origin, scope: owned.scope, action: 'approve', sequence: 3 };
    receipt.phase = 'awaiting_late_cancelled_consent'; await persistSharedDesktopReceipt(); console.info(`OWN_SHARED_DESKTOP_HANDOFF ${JSON.stringify(receipt.challenge)}`);
    await expect.poll(() => provider!.stats.approvals, { timeout: Math.max(1, Math.min(8 * 60_000, manualDeadline - Date.now())) }).toBe(3);
    expect(provider.stats.tokenExchanges).toBe(2); expect(provider.stats.toolCalls).toBe(0);
    const state = owned.states[0]; const currentStatus = await harness.page.request.get(`${baseUrl}/api/mcp/shared-connections/${encodeURIComponent(current.resource.connectionRef)}/oauth/desktop?${new URLSearchParams({ workspaceId: owned.workspaceId, state })}`);
    expect(currentStatus.status()).toBe(200);
    const currentStatusPayload = await currentStatus.json() as { success?: unknown; data?: unknown } | null;
    if (currentStatusPayload?.success !== true || !currentStatusPayload.data || typeof currentStatusPayload.data !== 'object' || Array.isArray(currentStatusPayload.data)) {
      throw new Error('The original native cancelled status has no successful object reply.');
    }
    expect((currentStatusPayload.data as Record<string, unknown>).status).toBe('cancelled');
    receipt.systemBrowserOpenedCount = (await readOwnedSharedMcpElectronReceipt(harness)).shellAcknowledged;
    expect(receipt.systemBrowserOpenedCount).toBe(3); receipt.outstanding = null; delete receipt.challenge;
    const screenshot = 'cancelled-1280.png'; await harness.page.screenshot({ path: path.join(fixture.fixtureRoot, screenshot), scale: 'css' }); receipt.visualInventory.push(screenshot);
    await editor.getByRole('button', { name: 'Close', exact: true }).click(); await expect(editor).toHaveCount(0); verifiedCases += 1; await persistSharedDesktopReceipt();
  } catch (error) { receipt.failure = { name: error instanceof Error ? error.name : 'UnknownError' }; await persistSharedDesktopReceipt(); throw new Error('The owned native cancellation assertion failed; inspect the private safe receipt.'); }
});

test('actual Electron cookie ABA and same-origin frame changes deny a verified old launch without publishing or executing', async () => {
  let identityStage = 'identity_setup';
  let identityBoundary: 'cookie-aba' | 'frame' | undefined;
  let replacementStatus: number | undefined;
  try {
    if (!harness || !provider || !anonymous) throw new Error('The owned native contexts are required.'); const owned = connections[3], currentHarness = harness;
    const query = new URLSearchParams({ view: 'advanced', scope: 'team', teamId, workspaceId: owned.workspaceId, connectionRef: owned.initial.resource.connectionRef });
    identityStage = 'identity_navigation';
    await currentHarness.page.goto(`${baseUrl}/de/plugins?${query}`, { waitUntil: 'domcontentloaded' });
    const editor = currentHarness.page.getByTestId('shared-connection-edit-dialog'); await expect(editor.getByTestId('shared-connection-save')).toBeEnabled();
    const before = { exchanges: provider.stats.tokenExchanges, openings: (await readOwnedSharedMcpElectronReceipt(currentHarness)).shellAcknowledged };
    expect(before).toEqual(diagnostic ? { exchanges: 0, openings: 0 } : { exchanges: 2, openings: 3 });
    // This adversarial branch is an actual authenticated API + actual native preload/IPC boundary, not a claim of clicking UI Connect.
    identityStage = 'identity_start';
    owned.startIntent = 'native-api';
    const started = await currentHarness.page.evaluate(async ({ ref, workspaceId, revisions }) => {
      const response = await fetch(`/api/mcp/shared-connections/${encodeURIComponent(ref)}/oauth?${new URLSearchParams({ workspaceId })}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-canvas-workspace-id': workspaceId },
        body: JSON.stringify({ ...revisions, desktop: true, returnLocale: 'de' }),
      });
      if (!response.ok) throw new Error('The own native boundary start was not acknowledged.');
      const payload = await response.json() as { success: boolean; data: { connectionRef: string; state: string; authorizationUrl: string; expiresAt: string } };
      if (!payload.success) throw new Error('The own native boundary start was not acknowledged.'); return payload.data;
    }, { ref: owned.initial.resource.connectionRef, workspaceId: owned.workspaceId, revisions: { expectedMetadataRevision: owned.current.resource.metadataRevision,
      expectedGrantsRevision: owned.current.resource.grantsRevision, expectedBindingRevision: owned.current.resource.bindingRevision } });
    expect(started.connectionRef).toBe(owned.initial.resource.connectionRef); expect(owned.states.includes(started.state)).toBe(true);
    const desktopQuery = new URLSearchParams({ workspaceId: owned.workspaceId, state: started.state });
    identityStage = 'identity_anonymous';
    const unauthenticated = await anonymous.request.get(`/api/mcp/shared-connections/${encodeURIComponent(started.connectionRef)}/oauth/desktop?${desktopQuery}`);
    expect(unauthenticated.status()).toBe(401);
    const email = process.env.TEST_SECONDARY_EMAIL, password = process.env.TEST_SECONDARY_PASSWORD;
    if (!email || !password) throw new Error('The private original manager login is required.');
    identityStage = 'identity_replacement_login';
    const replacementDeadline = Date.now() + 45_000;
    let replacementRetries = 0;
    while (true) {
      const remainingMs = replacementDeadline - Date.now();
      if (remainingMs <= 0) throw new Error('The native replacement sign-in exceeded its bounded deadline.');
      const replacement = await anonymous.request.post('/api/auth/sign-in/email', {
        headers: { Origin: baseUrl }, data: { email, password }, timeout: Math.min(15_000, remainingMs),
      });
      replacementStatus = replacement.status();
      if (replacementStatus !== 429 || replacementRetries >= 2) { expect(replacementStatus).toBe(200); break; }
      replacementRetries += 1;
      await waitForAuthRetry(replacement, replacementDeadline, 'Native replacement sign-in', replacementRetries);
    }
    const replacementIdentity = await anonymous.request.get('/api/auth/get-session'); expect(replacementIdentity.status()).toBe(200);
    expect((await replacementIdentity.json()).user.id).toBe(managerId);
    const replacementCookies = (await anonymous.cookies(baseUrl)).filter(cookie => ['better-auth.session_token', '__Host-better-auth.session_token'].includes(cookie.name));
    expect(replacementCookies.length).toBe(1);
    identityStage = 'identity_cookie_read';
    const originalCookies = await currentHarness.application.evaluate(async ({ BrowserWindow }, origin) =>
      (await BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({ url: origin })).filter(cookie => ['better-auth.session_token', '__Host-better-auth.session_token'].includes(cookie.name)), baseUrl);
    expect(originalCookies.length).toBe(1); expect(originalCookies[0].value === replacementCookies[0].value).toBe(false);
    const invocation = { state: started.state, authorizationUrl: started.authorizationUrl,
      target: { kind: 'shared' as const, connectionRef: started.connectionRef, workspaceId: owned.workspaceId } };
    for (const boundary of ['cookie-aba', 'frame'] as const) {
      identityBoundary = boundary;
      identityStage = 'identity_barrier_arm';
      await currentHarness.application.evaluate(async (_electron, selection) => {
        const api = Reflect.get(globalThis, '__canvasOwnedSharedMcpElectron') as { armOwnedOAuthStatusBarrier: (input: { connectionRef: string; state: string; workspaceId: string }) => Promise<void> };
        await api.armOwnedOAuthStatusBarrier(selection);
      }, { connectionRef: started.connectionRef, state: started.state, workspaceId: owned.workspaceId });
      identityStage = 'identity_preload_invocation';
      await currentHarness.page.evaluate(request => {
        const bridge = Reflect.get(window, 'canvasDesktop') as { sharedMcpOAuthVersion: number; openMcpOAuth: (input: { state: string; authorizationUrl: string; target: { kind: 'shared'; connectionRef: string; workspaceId: string } }) => Promise<{ ok: boolean }> };
        if (bridge.sharedMcpOAuthVersion !== 1) throw new Error('The real shared native preload is unavailable.');
        Reflect.set(window, '__ownedSharedDesktopInvocation', bridge.openMcpOAuth(request).then(reply => reply.ok));
      }, invocation);
      identityStage = 'identity_barrier_wait';
      await expect.poll(async () => (await readOwnedSharedMcpElectronReceipt(currentHarness)).barrier.held,
        { timeout: 5000, intervals: [50, 100, 200], message: 'Hold only the exact real NativeSession.fetch GET200 headers.' }).toBe(true);
      if (boundary === 'cookie-aba') {
        identityStage = 'identity_cookie_aba';
        // Both cookies came from actual server logins. Native Electron cookie events, not auth/state mocks, must detect A→B→A.
        await currentHarness.application.evaluate(async ({ BrowserWindow }, input) => {
          const jar = BrowserWindow.getAllWindows()[0].webContents.session.cookies;
          for (const cookie of [input.replacement, input.original]) await jar.set({ url: input.origin, name: cookie.name, value: cookie.value,
            path: cookie.path, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: 'lax' });
        }, { origin: baseUrl, replacement: replacementCookies[0], original: originalCookies[0] });
      } else {
        identityStage = 'identity_frame';
        await currentHarness.page.evaluate(url => window.history.replaceState(null, '', url),
          `${baseUrl}/de/plugins?${new URLSearchParams({ view: 'advanced', scope: 'team', teamId, workspaceId: teamId, connectionRef: connections[1].initial.resource.connectionRef })}`);
      }
      identityStage = 'identity_barrier_release';
      await currentHarness.application.evaluate(async () => {
        const api = Reflect.get(globalThis, '__canvasOwnedSharedMcpElectron') as { releaseOwnedOAuthStatusBarrier: () => Promise<void> }; await api.releaseOwnedOAuthStatusBarrier();
      });
      identityStage = 'identity_launch_result';
      const opened = await currentHarness.page.evaluate(async () => await Reflect.get(window, '__ownedSharedDesktopInvocation') as boolean);
      expect(opened).toBe(false); identityStage = 'identity_unchanged'; await assertNoSharedDesktopMutationAfterIdentityChange(owned, before);
    }
    identityBoundary = undefined;
    // Same user in another genuine BetterAuth session cannot take over the original manager's exact flow.
    identityStage = 'identity_other_session';
    const changedSession = await anonymous.request.get(`/api/mcp/shared-connections/${encodeURIComponent(started.connectionRef)}/oauth/desktop?${desktopQuery}`);
    expect(changedSession.status()).toBe(403);
    const adminStatus = await admin!.request.get(`/api/mcp/shared-connections/${encodeURIComponent(started.connectionRef)}/oauth/desktop?${desktopQuery}`);
    expect(adminStatus.status()).toBe(403);
    const adminFinalize = await admin!.request.post(`/api/mcp/shared-connections/${encodeURIComponent(started.connectionRef)}/oauth/desktop?${new URLSearchParams({ workspaceId: owned.workspaceId })}`,
      { headers: { Origin: baseUrl }, data: { state: started.state, action: 'finalize' } }); expect(adminFinalize.status()).toBe(403);
    const deniedFinalize = await anonymous.request.post(`/api/mcp/shared-connections/${encodeURIComponent(started.connectionRef)}/oauth/desktop?${new URLSearchParams({ workspaceId: owned.workspaceId })}`,
      { headers: { Origin: baseUrl }, data: { state: started.state, action: 'finalize' } }); expect(deniedFinalize.status()).toBe(403);
    identityStage = 'identity_return_ui';
    await currentHarness.page.goto(`${baseUrl}/de/plugins?${query}`, { waitUntil: 'domcontentloaded' });
    const currentEditor = currentHarness.page.getByTestId('shared-connection-edit-dialog'); await expect(currentEditor.getByTestId('shared-connection-save')).toBeEnabled();
    await currentEditor.locator('summary').filter({ hasText: de.sharedConnections.accountSetup }).click();
    await currentEditor.getByRole('button', { name: de.sharedConnections.checkStatus, exact: true }).click();
    await expect(currentEditor.getByText(de.sharedConnections.connectionRequired, { exact: true })).toBeVisible();
    const screenshot = 'native-denied-session-frame-1280.png'; await currentHarness.page.screenshot({ path: path.join(fixture.fixtureRoot, screenshot), scale: 'css' }); receipt.visualInventory.push(screenshot);
    identityStage = 'identity_sessions';
    const sessions = await admin!.request.get('/api/sessions'); expect(sessions.status()).toBe(200); expect((await sessions.json()).sessions).toEqual([]);
    expect(provider.stats.tokenExchanges).toBe(before.exchanges); expect(provider.stats.toolCalls).toBe(0);
    expect(receipt.forbiddenRequests).toEqual([]); expect(receipt.unexpectedDialogs).toEqual([]);
    receipt.outstanding = null; receipt.phase = 'native_current_identity_guards_verified'; verifiedCases += 1; await persistSharedDesktopReceipt();
  } catch (error) {
    const site = error instanceof Error ? error.stack?.match(/tests\/shared-mcp-desktop-oauth-local\.spec\.ts:(\d+):(\d+)/u) : null;
    const message = error instanceof Error ? error.message : '';
    const kind = message.includes('The owned Electron proof changed.') ? 'proof_changed'
      : message.includes('A pre-existing Electron proof cannot be adopted.') ? 'proof_exists'
        : message.includes('Execution context was destroyed, most likely because of a navigation.') ? 'evaluation_context_or_protocol'
          : message.includes('Target page, context or browser has been closed') ? 'target_closed'
            : message.includes('The owned native response barrier release failed.') ? 'barrier_release_js_error' : 'other';
    receipt.failure = { name: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(error.name) ? error.name : 'UnknownError', stage: identityStage, kind,
      ...(identityBoundary ? { boundary: identityBoundary } : {}),
      ...(replacementStatus !== undefined && Number.isInteger(replacementStatus) && replacementStatus >= 100 && replacementStatus <= 599 ? { replacementStatus } : {}),
      ...(site ? { site: `tests/shared-mcp-desktop-oauth-local.spec.ts:${site[1]}:${site[2]}` } : {}) };
    await persistSharedDesktopReceipt(); throw new Error('The own native identity assertion failed; inspect the private safe receipt.');
  }
});

test.afterAll(async () => {
  if (!receipt) return;
  try { await closeOwnedSharedDesktopContexts(); }
  catch {
    receipt.phase = 'preserved'; await persistSharedDesktopReceipt();
    throw new Error('Own native/system-browser closure was not fully acknowledged; preserve the private fixture.');
  }
});
