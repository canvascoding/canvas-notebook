import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { expect, test, request as playwrightRequest, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { sharedComposioDesktopActorFingerprint, sharedComposioDesktopSessionFingerprint } from '../app/lib/composio/composio-shared-desktop-oauth-contract';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight, waitForAuthRetry } from './helpers/managed-test-context';
import { launchOwnedSharedComposioElectron, readOwnedSharedComposioElectronReceipt, closeOwnedSharedComposioElectron } from './helpers/shared-composio-oauth-electron';
import type { IntegrationConnectionDescriptor, SharedIntegrationConnectionOwnership } from '../app/lib/integration-tools/connections/contracts';
import type { ClientWorkspaceResponse } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';
import de from '../messages/de.json';

// Actual production host, SDK, Main/preload and system browser. The parent owns
// the local protocol provider; this gate does not claim live Composio acceptance.
type DirectoryProof = { device: string; inode: string };
type DesktopPaths = { userData: string; sessionData: string; temp: string; logs: string; crashDumps: string };
type Fixture = { version: 1; nonce: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; rootDevice: string; rootInode: string; databaseName: string; createAcknowledged: boolean;
  phase: string; serverPid: number; actorId: string; listenerVerified: boolean; uncertain: boolean; nativeProvider: 'composio';
  tlsFiles: { key: { path: string; device: string; inode: string }; certificate: { path: string; device: string; inode: string } };
  directoryProofs: Record<string, DirectoryProof>; desktopPaths: DesktopPaths; desktopDirectoryProofs: Record<string, DirectoryProof> };
type IssuedProof = { flowHash: string; profileEntityHash: string; pendingAccountHash: string; authorizationUrlHash: string; toolkit: string;
  status: 'INITIATED' | 'ACTIVE' | 'FAILED'; consents: number; approvals: number; denials: number; callbackRedirects: number };
type ProviderProof = { version: 1; nonce: string; origin: string; stats: Record<string, number>; issued: IssuedProof[] };
type OwnedConnection = { scope: 'organization' | 'team'; label: string; workspaceId: string; profileId: string;
  initial: IntegrationConnectionDescriptor; current: IntegrationConnectionDescriptor; states: string[]; intents: string[];
  startWrites: number; finalizeWrites: number; cancelWrites: number; startIntent?: 'native-api' };
type Receipt = { version: 1; nonce: string; actorId: string; managerActorId: string; phase: string; outstanding: string | null;
  parentOwnedProvider: true; closedContexts: boolean; electronClosed: boolean; processes: Array<{ pid: number; processGroupId: number; closed: true }>;
  providerOrigin: string; systemBrowserOpenedCount: number; desktopPaths: DesktopPaths; desktopDirectoryProofs: Record<string, DirectoryProof>;
  connections: Array<{ connectionRef: string; workspaceId: string; metadataRevision: number; grantsRevision: number; bindingRevision: number }>;
  membershipIds: string[]; workspaceIds: string[]; profileIds: string[]; forbiddenRequests: string[]; unexpectedDialogs: string[];
  providerCounters?: Record<string, number>; visualInventory: string[]; apiFlowCancelled?: true;
  challenge?: { nonce: string; origin: string; scope: string; action: 'approve' | 'cancel'; sequence: number };
  ledgerProofs: Array<{ connectionRef: string; rows: number; stateHash?: string; authSessionHash?: string; actorHash?: string; pendingAccountHash?: string }>;
  failure?: { name: string; site?: string; stage?: string; boundary?: 'cookie-aba' | 'frame'; replacementStatus?: number } };
type Harness = Awaited<ReturnType<typeof launchOwnedSharedComposioElectron>>;
const baseUrl = 'http://127.0.0.1:3001';
const canonicalState = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
let fixture: Fixture, receipt: Receipt, receiptPath = '', fixturePath = '', providerOrigin = '', controlUrl = '', controlToken = '';
let admin: BrowserContext | undefined, manager: BrowserContext | undefined, anonymous: BrowserContext | undefined, harness: Harness | undefined;
let providerControl: APIRequestContext | undefined;
let managerId = '', personalWorkspaceId = '', adminWorkspaceId = '', teamId = '', organizationId = '', nativeAuthSessionHash = '';
let ledgerPoolsClosed = true, verifiedCases = 0, receiptWrite = Promise.resolve(), manualDeadline = 0;
const connections: OwnedConnection[] = [];
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

async function readOwnedSharedComposioDesktopFixture(): Promise<Fixture> {
  for (const flag of ['CANVAS_SHARED_COMPOSIO_DESKTOP_OAUTH_BROWSER_RUN', 'CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN',
    'CANVAS_AGENT_SETTINGS_BROWSER_RUN', 'E2E_EXTERNAL_SERVER']) expect(process.env[flag]).toBe('1');
  expect(process.env.BASE_URL).toBe(baseUrl);
  const file = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
  if (!file || !path.isAbsolute(file) || path.basename(file) !== 'recovery.json') throw new Error('The exact owned recovery receipt is required.');
  fixturePath = file;
  const before = await fs.lstat(file);
  expect(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size < 64 * 1024).toBe(true);
  expect(before.mode & 0o777).toBe(0o600); expect(before.uid).toBe(process.getuid?.());
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); let value: Fixture;
  try { const held = await handle.stat(); expect(held.ino === before.ino && held.dev === before.dev).toBe(true); value = JSON.parse(await handle.readFile('utf8')) as Fixture; }
  finally { await handle.close(); }
  expect(value).toMatchObject({ version: 1, createAcknowledged: true, phase: 'browser', listenerVerified: true, uncertain: false, nativeProvider: 'composio' });
  expect(value.nonce).toMatch(/^[a-f0-9]{32}$/u); expect(value.databaseName).toBe(`canvas_connection_test_${value.nonce}`);
  expect(value.actorId).toBeTruthy(); expect(Number.isSafeInteger(value.serverPid) && value.serverPid > 0).toBe(true);
  expect(await fs.realpath(process.cwd())).toBe(value.repo); expect(path.dirname(file)).toBe(value.fixtureRoot);
  const root = await fs.lstat(value.fixtureRoot);
  expect(root.isDirectory() && !root.isSymbolicLink() && root.uid === before.uid && (root.mode & 0o777) === 0o700).toBe(true);
  expect(await fs.realpath(value.fixtureRoot)).toBe(value.fixtureRoot); expect(String(root.dev)).toBe(value.rootDevice); expect(String(root.ino)).toBe(value.rootInode);
  const marker = await fs.open(path.join(value.fixtureRoot, '.fixture-owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const held = await marker.stat(); expect(held.isFile() && held.nlink === 1 && held.uid === root.uid && (held.mode & 0o777) === 0o600 && held.size > 0 && held.size < 1024).toBe(true); expect(await marker.readFile('utf8')).toBe(value.ownerMarker); }
  finally { await marker.close(); }
  expect(process.env.DATA).toBe(value.dataRoot); expect(process.env.TMPDIR).toBe(value.tmpRoot);
  expect(process.env.CANVAS_SHARED_COMPOSIO_DESKTOP_RECEIPT).toBe(path.join(value.fixtureRoot, 'desktop-receipt.json'));
  expect(JSON.parse(process.env.CANVAS_SHARED_COMPOSIO_DESKTOP_PATHS ?? 'null')).toEqual(value.desktopPaths);
  for (const directory of [value.dataRoot, value.tmpRoot, ...Object.values(value.desktopPaths)]) {
    const stat = await fs.lstat(directory);
    expect(await fs.realpath(directory)).toBe(directory); expect(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === root.uid && (stat.mode & 0o777) === 0o700).toBe(true);
    expect({ device: String(stat.dev), inode: String(stat.ino) }).toEqual(value.desktopDirectoryProofs[directory] ?? value.directoryProofs[directory]);
    expect(directory === value.dataRoot || directory === value.tmpRoot || path.dirname(directory) === value.tmpRoot).toBe(true);
  }
  for (const [field, filename, environment] of [['key', 'tls-key.pem', process.env.CANVAS_SHARED_COMPOSIO_OAUTH_TLS_KEY],
    ['certificate', 'tls-cert.pem', process.env.CANVAS_SHARED_COMPOSIO_OAUTH_TLS_CERT]] as const) {
    const proof = value.tlsFiles[field]; expect(proof.path).toBe(path.join(value.fixtureRoot, filename)); expect(environment).toBe(proof.path);
    const opened = await fs.open(proof.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await opened.stat(); expect(stat.isFile() && stat.nlink === 1 && stat.uid === root.uid && (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size < 64 * 1024).toBe(true);
      expect({ device: String(stat.dev), inode: String(stat.ino) }).toEqual({ device: proof.device, inode: proof.inode }); }
    finally { await opened.close(); }
  }
  expect(process.env.NODE_EXTRA_CA_CERTS).toBe(value.tlsFiles.certificate.path);
  const sdk = new URL(process.env.COMPOSIO_BASE_URL ?? ''), control = new URL(process.env.CANVAS_COMPOSIO_NATIVE_CONTROL_URL ?? '');
  expect(sdk.protocol).toBe('http:'); expect(sdk.hostname).toBe('127.0.0.1'); expect(sdk.port && sdk.port !== '3001').toBeTruthy();
  expect(sdk.pathname).toBe('/'); expect(sdk.search + sdk.hash).toBe(''); expect(!sdk.username && !sdk.password).toBe(true);
  expect(control.origin).toBe(sdk.origin); expect(control.pathname).toBe('/__native/composio'); expect(control.search + control.hash).toBe('');
  expect(!control.username && !control.password).toBe(true); controlUrl = control.href;
  const token = process.env.CANVAS_COMPOSIO_NATIVE_CONTROL_TOKEN; if (!token || !canonicalState.test(token)) throw new Error('The private native provider control proof is required.'); controlToken = token;
  const consent = new URL(process.env.CANVAS_SHARED_COMPOSIO_NATIVE_PROVIDER_ORIGIN ?? '');
  expect(consent.href).toBe(`${consent.origin}/`); expect(consent.protocol).toBe('https:'); expect(consent.hostname).toBe('127.0.0.1');
  expect(consent.port && consent.port !== '3001' && consent.port !== sdk.port).toBeTruthy(); expect(!consent.username && !consent.password).toBe(true);
  providerOrigin = consent.origin; return value;
}

async function persistSharedComposioDesktopReceipt(): Promise<void> {
  const browserValue = JSON.stringify({ ...receipt, processes: undefined, desktopPaths: undefined, desktopDirectoryProofs: undefined });
  const nativeValue = JSON.stringify(receipt);
  receiptWrite = receiptWrite.then(async () => {
    for (const [file, value] of [[receiptPath, browserValue], [path.join(fixture.fixtureRoot, 'desktop-receipt.json'), nativeValue]]) {
      const temporary = `${file}.tmp`; await fs.writeFile(temporary, value, { mode: 0o600 }); await fs.rename(temporary, file);
    }
  }); await receiptWrite;
}

async function readExactSharedComposioDesktopConnection(owned: OwnedConnection): Promise<IntegrationConnectionDescriptor> {
  if (!manager) throw new Error('The original manager context is required.');
  const response = await manager.request.get(`/api/integrations/shared-connections/${encodeURIComponent(owned.initial.resource.connectionRef)}?${new URLSearchParams({ workspaceId: owned.workspaceId })}`);
  expect(response.status()).toBe(200); const payload = await response.json() as { success?: boolean; data?: { connection?: IntegrationConnectionDescriptor } };
  if (payload.success !== true || !payload.data?.connection) throw new Error('The owned connection has no successful object reply.');
  const current = payload.data.connection;
  expect(current.resource.connectionRef).toBe(owned.initial.resource.connectionRef); expect(current.resource.createdByUserId).toBe(fixture.actorId);
  expect(current.resource.ownership).toEqual(owned.initial.resource.ownership); expect(current.resource.displayName).toBe(owned.label);
  expect(current.resource.status).toBe('active'); expect(current.access).toMatchObject({ canRead: true, canManage: true, canUse: false });
  expect(current.resource.metadataRevision).toBe(owned.initial.resource.metadataRevision); expect(current.resource.grantsRevision).toBe(owned.initial.resource.grantsRevision);
  return current;
}

async function createOwnSharedComposioDesktopConnections(): Promise<void> {
  if (!admin) throw new Error('The owned admin context is required.');
  const profileIds = new Map<'organization' | 'team', string>();
  for (const scope of ['organization', 'team'] as const) {
    const workspaceId = scope === 'team' ? teamId : adminWorkspaceId;
    const ownership = scope === 'team' ? { type: 'team', workspaceId: teamId } : { type: 'organization' };
    receipt.outstanding = `profile:${scope}`; await persistSharedComposioDesktopReceipt();
    const response = await admin.request.post(`/api/composio/shared-profiles?${new URLSearchParams({ workspaceId })}`, { data: {
      name: `Native ${scope} ${fixture.nonce}`, ownership, providerMode: 'local',
    } }); expect(response.status()).toBe(200);
    const payload = await response.json() as { success?: boolean; data?: { profile?: { id: string; ownership: SharedIntegrationConnectionOwnership; createdByUserId: string } } };
    if (payload.success !== true || !payload.data?.profile) throw new Error('The own shared profile was not acknowledged.');
    const profile = payload.data.profile; expect(profile.createdByUserId).toBe(fixture.actorId);
    expect(profile.ownership).toEqual(scope === 'team' ? { type: 'team', organizationId, workspaceId: teamId } : { type: 'organization', organizationId });
    profileIds.set(scope, profile.id); receipt.profileIds.push(profile.id); await persistSharedComposioDesktopReceipt();
  }
  for (const [index, scope] of (['organization', 'team', 'organization', 'team'] as const).entries()) {
    const ownership = scope === 'team' ? { type: 'team' as const, workspaceId: teamId } : { type: 'organization' as const };
    const workspaceId = scope === 'team' ? teamId : personalWorkspaceId, profileId = profileIds.get(scope); if (!profileId) throw new Error('The exact owned profile is required.');
    const label = `Shared Composio desktop ${scope} ${index} ${fixture.nonce}`;
    receipt.outstanding = `create:${scope}:${index}`; await persistSharedComposioDesktopReceipt();
    const response = await admin.request.post(`/api/integrations/shared-connections?${new URLSearchParams({ workspaceId: scope === 'team' ? teamId : adminWorkspaceId })}`, { data: {
      displayName: label, ownership, source: 'composio', profileId, toolkit: 'canva', accessMode: 'restricted', allowedToolNames: [],
      grants: [{ targetType: 'user', targetId: managerId, canUse: false, canManage: true, allowedToolNames: [] }],
    } }); expect(response.status()).toBe(200);
    const payload = await response.json() as { success?: boolean; data?: { connection?: IntegrationConnectionDescriptor } };
    if (payload.success !== true || !payload.data?.connection) throw new Error('The own shared connection was not acknowledged.');
    const initial = payload.data.connection;
    expect(initial.resource.source).toBe('composio'); expect(initial.resource.createdByUserId).toBe(fixture.actorId); expect(initial.resource.displayName).toBe(label);
    expect(initial.resource.ownership).toEqual(scope === 'team' ? { type: 'team', organizationId, workspaceId: teamId } : { type: 'organization', organizationId });
    expect(initial.resource.accessMode).toBe('restricted'); expect(initial.resource.connectionRef).toMatch(/^canvas-connection:[a-f0-9-]{36}$/u);
    const owned: OwnedConnection = { scope, label, workspaceId, profileId, initial, current: initial, states: [], intents: [], startWrites: 0, finalizeWrites: 0, cancelWrites: 0 };
    owned.current = await readExactSharedComposioDesktopConnection(owned); connections.push(owned);
    receipt.connections.push({ connectionRef: initial.resource.connectionRef, workspaceId, metadataRevision: initial.resource.metadataRevision,
      grantsRevision: initial.resource.grantsRevision, bindingRevision: initial.resource.bindingRevision });
    receipt.outstanding = null; await persistSharedComposioDesktopReceipt();
  }
}

async function readOwnedSharedComposioDesktopProviderProof(flowHash?: string): Promise<ProviderProof> {
  if (!providerControl || !controlUrl || !controlToken) throw new Error('The exact parent-owned provider control proof is required.');
  if (flowHash) expect(flowHash).toMatch(/^[a-f0-9]{64}$/u);
  const url = new URL(controlUrl); if (flowHash) url.searchParams.set('flowHash', flowHash);
  const response = await providerControl.get(url.href, { timeout: 10_000, maxRedirects: 0 });
  expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toContain('no-store');
  const value = await response.json() as ProviderProof;
  expect(Object.keys(value).sort()).toEqual(['issued', 'nonce', 'origin', 'stats', 'version']);
  expect(value.version).toBe(1); expect(value.nonce).toBe(fixture.nonce); expect(value.origin).toBe(providerOrigin);
  expect(Object.keys(value.stats).sort()).toEqual(['accountReads', 'approvals', 'businessCalls', 'callbackRedirects', 'consents', 'denials',
    'issued', 'rejectedConsentRequests', 'sdkLinks', 'sdkRequests', 'sessions']);
  expect(Object.values(value.stats).every(count => Number.isSafeInteger(count) && count >= 0)).toBe(true);
  expect(Array.isArray(value.issued) && value.issued.length <= (flowHash ? 1 : 32)).toBe(true);
  for (const issued of value.issued) {
    expect(Object.keys(issued).sort()).toEqual(['approvals', 'authorizationUrlHash', 'callbackRedirects', 'consents', 'denials',
      'flowHash', 'pendingAccountHash', 'profileEntityHash', 'status', 'toolkit']);
    expect([issued.flowHash, issued.profileEntityHash, issued.pendingAccountHash, issued.authorizationUrlHash].every(hash => /^[a-f0-9]{64}$/u.test(hash))).toBe(true);
    if (flowHash) expect(issued.flowHash === flowHash).toBe(true);
    expect(issued.toolkit).toBe('canva'); expect(['INITIATED', 'ACTIVE', 'FAILED'].includes(issued.status)).toBe(true);
    expect([issued.consents, issued.approvals, issued.denials, issued.callbackRedirects].every(count => Number.isSafeInteger(count) && count >= 0)).toBe(true);
  }
  return value;
}

async function observeSharedComposioDesktopRequests(page: Page): Promise<void> {
  page.on('dialog', async dialog => { receipt.unexpectedDialogs.push(dialog.type()); await persistSharedComposioDesktopReceipt(); await dialog.dismiss(); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    try {
      if (url.origin !== baseUrl) { receipt.forbiddenRequests.push(`renderer-external:${method}`); await persistSharedComposioDesktopReceipt(); await route.abort(); return; }
      if (url.pathname.startsWith('/api/mcp/') || url.pathname.startsWith('/api/integrations/mcp') || url.pathname === '/api/composio/connect'
        || url.pathname.startsWith('/api/composio/oauth/') || url.pathname.startsWith('/api/composio/profiles/')) {
        receipt.forbiddenRequests.push(`personal-or-mcp:${method}`); await persistSharedComposioDesktopReceipt(); await route.abort(); return;
      }
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        if (url.pathname.startsWith('/api/composio/shared-connections/')) {
          const owned = connections.find(value => ['/status', '/connect/desktop'].some(suffix => url.pathname === `/api/composio/shared-connections/${encodeURIComponent(value.initial.resource.connectionRef)}${suffix}`));
          expect(owned).toBeDefined(); expect(request.headers()['x-canvas-workspace-id']).toBe(owned!.workspaceId);
          if (url.pathname.endsWith('/connect/desktop')) {
            expect(url.searchParams.get('workspaceId')).toBe(owned!.workspaceId);
            expect(url.searchParams.getAll('workspaceId').length).toBe(1);
            expect([...url.searchParams.keys()].every(key => ['workspaceId', 'state', 'intent'].includes(key))).toBe(true);
            expect(url.searchParams.has('state') !== url.searchParams.has('intent')).toBe(true);
            if (url.searchParams.has('state')) expect(owned!.states.includes(url.searchParams.get('state')!)).toBe(true);
            else expect(owned!.intents.includes(url.searchParams.get('intent')!)).toBe(true);
          } else expect(url.search).toBe('');
        }
        await route.continue(); return;
      }
      const owned = connections.find(value => url.pathname === `/api/composio/shared-connections/${encodeURIComponent(value.initial.resource.connectionRef)}/connect`
        || url.pathname === `/api/composio/shared-connections/${encodeURIComponent(value.initial.resource.connectionRef)}/connect/desktop`);
      if (owned && method === 'POST') {
        expect([...url.searchParams.keys()]).toEqual(['workspaceId']); expect(url.searchParams.get('workspaceId')).toBe(owned.workspaceId);
        const body = request.postDataJSON() as Record<string, unknown>;
        if (url.pathname.endsWith('/connect')) {
          expect(Object.keys(body).sort()).toEqual(['desktop', 'expectedBindingRevision', 'expectedGrantsRevision', 'expectedMetadataRevision', 'intent']);
          expect(body).toEqual({ expectedMetadataRevision: owned.current.resource.metadataRevision, expectedGrantsRevision: owned.current.resource.grantsRevision,
            expectedBindingRevision: owned.current.resource.bindingRevision, desktop: true, intent: body.intent });
          expect(typeof body.intent === 'string' && canonicalState.test(body.intent)).toBe(true);
          owned.startWrites += 1; expect(owned.startWrites).toBe(1); owned.intents.push(String(body.intent)); receipt.outstanding = `start:${owned.scope}`; await persistSharedComposioDesktopReceipt();
          const original = await route.fetch({ timeout: 35_000 }); expect(original.status()).toBe(200); expect(original.headers()['cache-control']).toContain('no-store');
          const payload = await original.json() as { success?: boolean; data?: Record<string, unknown> };
          if (payload.success !== true || !payload.data) throw new Error('The actual native start was not acknowledged.');
          const result = payload.data;
          expect(Object.keys(result).sort()).toEqual(['authorizationUrl', 'connectionRef', 'expiresAt', 'state', 'status']);
          expect(result.connectionRef).toBe(owned.initial.resource.connectionRef); expect(result.status).toBe('waiting');
          expect(typeof result.state === 'string' && canonicalState.test(result.state)).toBe(true);
          expect(typeof result.expiresAt === 'string' && Date.parse(result.expiresAt) > Date.now()).toBe(true);
          if (typeof result.state !== 'string' || typeof result.authorizationUrl !== 'string' || typeof body.intent !== 'string') throw new Error('The actual native start proof is invalid.');
          const authorization = new URL(result.authorizationUrl);
          expect(authorization.origin).toBe(providerOrigin); expect(authorization.pathname).toBe('/authorize'); expect(!authorization.username && !authorization.password).toBe(true);
          expect([...authorization.searchParams.keys()]).toEqual(['ticket']); expect(canonicalState.test(authorization.searchParams.get('ticket') ?? '')).toBe(true);
          const stateHash = createHash('sha256').update(result.state).digest('hex'), urlHash = createHash('sha256').update(result.authorizationUrl).digest('hex');
          const proof = await readOwnedSharedComposioDesktopProviderProof(stateHash); expect(proof.issued.length).toBe(1);
          expect(proof.issued[0].authorizationUrlHash === urlHash && proof.issued[0].status === 'INITIATED').toBe(true);
          owned.states.push(result.state);
          if (!harness) throw new Error('The actual native shell target observer is required.');
          await harness.application.evaluate(async (_electron, hashes) => {
            const api = Reflect.get(globalThis, '__canvasOwnedSharedComposioElectron') as { armOwnedOAuthShellTarget: (value: { urlHash: string; stateHash: string }) => Promise<void> };
            await api.armOwnedOAuthShellTarget(hashes);
          }, { urlHash, stateHash });
          await route.fulfill({ response: original }); return; // Unmodified authentic response, no DTO or authority substitution.
        }
        if ('intent' in body) {
          expect(Object.keys(body).sort()).toEqual(['action', 'expectedBindingRevision', 'expectedGrantsRevision', 'expectedMetadataRevision', 'intent']);
          expect(body).toEqual({ action: 'cancel', intent: owned.intents[0], expectedMetadataRevision: owned.initial.resource.metadataRevision,
            expectedGrantsRevision: owned.initial.resource.grantsRevision, expectedBindingRevision: owned.initial.resource.bindingRevision });
        } else { expect(Object.keys(body).sort()).toEqual(['action', 'state']); expect(owned.states.includes(String(body.state))).toBe(true); }
        expect(body.action === 'finalize' || body.action === 'cancel').toBe(true);
        if (body.action === 'finalize') owned.finalizeWrites += 1; else owned.cancelWrites += 1;
        await persistSharedComposioDesktopReceipt(); await route.continue(); return;
      }
      if (method === 'POST' && url.pathname === '/api/instance/human-activity' && !request.postData()) { await route.continue(); return; }
      if (method === 'POST' && url.pathname === '/api/files/watch') {
        const body = request.postDataJSON() as { clientId?: unknown; dirs?: unknown };
        if ([personalWorkspaceId, teamId].includes(url.searchParams.get('workspaceId') ?? '') && Object.keys(body).sort().join(',') === 'clientId,dirs'
          && typeof body.clientId === 'string' && /^client-\d+-[a-z0-9]{1,9}$/u.test(body.clientId) && Array.isArray(body.dirs) && body.dirs.length === 0) { await route.continue(); return; }
      }
      if (method === 'POST' && url.pathname === '/api/auth/sign-in/email') {
        const body = request.postDataJSON() as Record<string, unknown>; expect(Object.keys(body).sort()).toEqual(['email', 'password']);
        expect(body.email === process.env.TEST_SECONDARY_EMAIL && body.password === process.env.TEST_SECONDARY_PASSWORD).toBe(true);
        await route.continue(); return;
      }
      receipt.forbiddenRequests.push(`${method}:${url.pathname}`); await persistSharedComposioDesktopReceipt(); await route.abort();
    } catch {
      receipt.forbiddenRequests.push('observer-contract-failure'); await persistSharedComposioDesktopReceipt(); await route.abort().catch(() => undefined);
    }
  });
}

async function readOwnedSharedComposioDesktopLedger(owned: OwnedConnection, expectedCount: 0 | 1): Promise<void> {
  const connectionString = process.env.DATABASE_URL; if (!connectionString) throw new Error('The exact own native database is required.');
  const url = new URL(connectionString);
  expect(['postgres:', 'postgresql:'].includes(url.protocol)).toBe(true); expect(url.hostname).toBe('127.0.0.1'); expect(url.port).toBe('55433');
  expect(url.pathname).toBe(`/${fixture.databaseName}`); expect(url.search + url.hash).toBe(''); expect(url.username.length > 0).toBe(true);
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000, query_timeout: 10_000,
    options: '-c default_transaction_read_only=on -c statement_timeout=10000' }); ledgerPoolsClosed = false;
  try {
    expect((await pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name).toBe(fixture.databaseName);
    const result = await pool.query<{ state_hash: string; snapshot_hash: string; flow_snapshot_hash: string; status: string;
      auth_session_hash: string; actor_hash: string; initiating_user_id: string; profile_id_hash: string; composio_user_id_hash: string;
      pending_account_hash: string; authorization_url_hash: string; toolkit: string; provider_mode: string;
      pre_metadata_revision: string | number; pre_grants_revision: string | number; pre_binding_revision: string | number; published_binding_revision: string | number }>(
      `SELECT c.state_hash,c.snapshot_hash,t.snapshot_hash AS flow_snapshot_hash,t.status,c.auth_session_hash,c.actor_hash,c.initiating_user_id,
       c.profile_id_hash,c.composio_user_id_hash,c.pending_account_hash,c.authorization_url_hash,c.toolkit,c.provider_mode,
       c.pre_metadata_revision,c.pre_grants_revision,c.pre_binding_revision,c.published_binding_revision
       FROM composio_shared_desktop_oauth_commits c JOIN composio_shared_desktop_oauth_transactions t USING (state_hash)
       WHERE c.connection_ref=$1 ORDER BY c.committed_at LIMIT 2`, [owned.initial.resource.connectionRef]);
    expect(result.rows.length).toBe(expectedCount);
    const row = result.rows[0];
    if (row) {
      expect(owned.states.length).toBe(1); const stateHash = createHash('sha256').update(owned.states[0]).digest('hex');
      const provider = await readOwnedSharedComposioDesktopProviderProof(stateHash); expect(provider.issued.length).toBe(1); const issued = provider.issued[0];
      expect(row.state_hash === stateHash && row.snapshot_hash === row.flow_snapshot_hash && row.status === 'completed').toBe(true);
      expect(row.auth_session_hash === nativeAuthSessionHash && row.actor_hash === sharedComposioDesktopActorFingerprint({ userId: managerId, workspaceId: owned.workspaceId })
        && row.initiating_user_id === managerId).toBe(true);
      expect(row.profile_id_hash === createHash('sha256').update(owned.profileId).digest('hex') && row.composio_user_id_hash === issued.profileEntityHash
        && row.pending_account_hash === issued.pendingAccountHash && row.authorization_url_hash === issued.authorizationUrlHash).toBe(true);
      expect(row.toolkit).toBe('canva'); expect(row.provider_mode).toBe('local'); expect(issued.status).toBe('ACTIVE');
      expect(Number(row.pre_metadata_revision)).toBe(owned.initial.resource.metadataRevision); expect(Number(row.pre_grants_revision)).toBe(owned.initial.resource.grantsRevision);
      expect(Number(row.pre_binding_revision)).toBe(owned.initial.resource.bindingRevision); expect(Number(row.published_binding_revision)).toBe(owned.initial.resource.bindingRevision + 1);
      receipt.ledgerProofs.push({ connectionRef: owned.initial.resource.connectionRef, rows: 1, stateHash, authSessionHash: row.auth_session_hash,
        actorHash: row.actor_hash, pendingAccountHash: row.pending_account_hash });
    } else receipt.ledgerProofs.push({ connectionRef: owned.initial.resource.connectionRef, rows: 0 });
  } catch { throw new Error('The own readonly Composio ledger assertion failed; preserve the private fixture.'); }
  finally { await pool.end(); ledgerPoolsClosed = true; }
}

async function waitForOriginalSharedComposioDesktopCompletion(owned: OwnedConnection, sequence: number): Promise<void> {
  if (!harness) throw new Error('The issued native app is required.');
  receipt.challenge = { nonce: fixture.nonce, origin: providerOrigin, scope: owned.scope, action: 'approve', sequence };
  receipt.phase = 'awaiting_system_browser_consent'; await persistSharedComposioDesktopReceipt();
  console.info(`OWN_SHARED_COMPOSIO_DESKTOP_HANDOFF ${JSON.stringify(receipt.challenge)}`);
  // The real OS browser opened by shell must perform consent; never navigate to its URL or invoke provider completion from the test.
  await expect.poll(async () => (await readOwnedSharedComposioDesktopProviderProof()).stats.consents,
    { timeout: Math.max(1, Math.min(8 * 60_000, manualDeadline - Date.now())), intervals: [1000, 2000] }).toBe(sequence);
  await expect.poll(async () => (await readOwnedSharedComposioDesktopProviderProof()).stats.approvals,
    { timeout: Math.max(1, Math.min(8 * 60_000, manualDeadline - Date.now())), intervals: [1000, 2000] }).toBe(sequence);
  const labels = owned.scope === 'team' ? de.sharedConnections : en.sharedConnections;
  const editor = harness.page.getByTestId('shared-connection-edit-dialog');
  await expect(editor.getByText(labels.connected, { exact: true })).toBeVisible({ timeout: 60_000 });
  const current = await readExactSharedComposioDesktopConnection(owned);
  expect(current.resource.bindingRevision).toBe(owned.initial.resource.bindingRevision + 1); expect(current.grants).toEqual(owned.current.grants);
  const ref = current.resource.connectionRef, state = owned.states[0]; expect(canonicalState.test(state)).toBe(true);
  const statusResponse = await harness.page.request.get(`${baseUrl}/api/composio/shared-connections/${encodeURIComponent(ref)}/status?${new URLSearchParams({ workspaceId: owned.workspaceId })}`);
  expect(statusResponse.status()).toBe(200);
  const statusPayload = await statusResponse.json() as { success?: boolean; data?: { status?: { state: string; connected: boolean; application: string } } };
  if (statusPayload.success !== true || !statusPayload.data?.status) throw new Error('The original native Composio status has no successful object reply.');
  expect(statusPayload.data.status).toMatchObject({ state: 'ready', connected: true, application: 'canva' });
  const response = await harness.page.request.get(`${baseUrl}/api/composio/shared-connections/${encodeURIComponent(ref)}/connect/desktop?${new URLSearchParams({ workspaceId: owned.workspaceId, state })}`);
  expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toContain('no-store');
  const payload = await response.json() as { success?: boolean; data?: Record<string, unknown> };
  if (payload.success !== true || !payload.data) throw new Error('The original native completed flow has no successful object reply.');
  expect(Object.keys(payload.data).sort()).toEqual(['connectionRef', 'expiresAt', 'state', 'status']);
  expect(payload.data.status).toBe('completed'); expect(payload.data.connectionRef).toBe(ref); expect(payload.data.state === state).toBe(true);
  await readOwnedSharedComposioDesktopLedger(owned, 1); await readOwnedSharedComposioDesktopLedger(owned, 1);
  expect((await readExactSharedComposioDesktopConnection(owned)).resource.bindingRevision).toBe(current.resource.bindingRevision);
  expect(owned.startWrites).toBe(1); expect(owned.finalizeWrites).toBe(1); expect(owned.cancelWrites).toBe(0);
  const proof = await readOwnedSharedComposioDesktopProviderProof(); expect(proof.stats.businessCalls).toBe(0);
  const main = await readOwnedSharedComposioElectronReceipt(harness);
  expect(main.shellAcknowledged).toBe(sequence); expect(main.shellFailures).toBe(0); expect(main.blockedShellRequests).toBe(0); expect(main.uncertain).toBe(false);
  owned.current = current; receipt.connections = receipt.connections.map(value => value.connectionRef === ref ? { ...value, bindingRevision: current.resource.bindingRevision } : value);
  receipt.systemBrowserOpenedCount = main.shellAcknowledged; receipt.outstanding = null; delete receipt.challenge;
  receipt.phase = 'original_manager_completed'; await persistSharedComposioDesktopReceipt();
}

async function assertNoSharedComposioDesktopMutationAfterIdentityChange(owned: OwnedConnection, before: { links: number; openings: number; attempts: number; blockedRequests: number; blockedShellRequests: number }): Promise<void> {
  if (!harness) throw new Error('The issued native app is required.');
  const current = await readExactSharedComposioDesktopConnection(owned);
  expect(current.resource.bindingRevision).toBe(owned.initial.resource.bindingRevision); expect(current.grants).toEqual(owned.current.grants);
  const proof = await readOwnedSharedComposioDesktopProviderProof(); expect(proof.stats.sdkLinks).toBe(before.links); expect(proof.stats.businessCalls).toBe(0);
  const main = await readOwnedSharedComposioElectronReceipt(harness);
  expect(main.shellAcknowledged).toBe(before.openings); expect(main.shellAttempts).toBe(before.attempts);
  // Background requests may be denied after a frame change; a rejected shell target must never be hidden by that counter.
  expect(main.blockedRequests).toBeGreaterThanOrEqual(before.blockedRequests); expect(main.blockedShellRequests).toBe(before.blockedShellRequests);
  expect(main.shellFailures).toBe(0); expect(main.uncertain).toBe(false);
  await readOwnedSharedComposioDesktopLedger(owned, 0);
}

async function closeOwnedSharedComposioDesktopContexts(): Promise<void> {
  let problem = false, closed = true, teardownStage = 'current_target';
  if (harness) {
    const currentHarness = harness; let mayCloseElectron = true;
    try {
      const main = await readOwnedSharedComposioElectronReceipt(currentHarness); receipt.systemBrowserOpenedCount = main.shellAcknowledged;
      if (main.shellFailures !== 0 || main.uncertain) problem = true;
      const editor = currentHarness.page.getByTestId('shared-connection-edit-dialog');
      const apiFlow = connections[3]?.startIntent === 'native-api' ? connections[3] : null;
      teardownStage = 'current_editor';
      if (apiFlow) await expect(editor).toHaveCount(1, { timeout: 15_000 });
      if (await editor.count()) {
        teardownStage = 'current_scope';
        await expect(editor).toBeVisible(); const currentUrl = new URL(currentHarness.page.url());
        const owned = connections.find(value => currentUrl.origin === baseUrl && currentUrl.pathname === `/${value.scope === 'team' ? 'de' : 'en'}/plugins`
          && currentUrl.searchParams.get('connectionRef') === value.initial.resource.connectionRef && currentUrl.searchParams.get('workspaceId') === value.workspaceId
          && currentUrl.searchParams.get('scope') === value.scope && (value.scope !== 'team' || currentUrl.searchParams.get('teamId') === teamId));
        if (!owned || apiFlow && (apiFlow.scope !== 'team' || apiFlow.workspaceId !== teamId || apiFlow.startWrites !== 1
          || apiFlow.states.length !== 1 || owned !== apiFlow && owned !== connections[1])) throw new Error('The native teardown target is ambiguous.');
        const flow = apiFlow ?? owned, labels = owned.scope === 'team' ? de.sharedConnections : en.sharedConnections;
        teardownStage = 'current_label'; await expect(editor.locator('#shared-edit-name')).toHaveValue(owned.current.resource.displayName);
        const cancel = editor.getByTestId('shared-desktop-cancel'), checkStatus = editor.getByRole('button', { name: labels.checkStatus, exact: true });
        if (!apiFlow && owned.startWrites > 0) {
          teardownStage = 'start_settlement';
          await expect.poll(async () => await cancel.count() === 1 || await checkStatus.isEnabled(), { timeout: 15_000 }).toBe(true);
        }
        if (apiFlow || await cancel.count()) {
          teardownStage = 'original_identity';
          expect(flow.intents.length).toBe(1);
          const identityResponse = await currentHarness.page.request.get(`${baseUrl}/api/auth/get-session`, { timeout: 15_000 }); expect(identityResponse.status()).toBe(200);
          const identity = await identityResponse.json() as { user?: { id?: string }; session?: { id?: string } };
          expect(identity.user?.id === managerId && typeof identity.session?.id === 'string' && sharedComposioDesktopSessionFingerprint(identity.session.id) === nativeAuthSessionHash).toBe(true);
          const desktopPath = `/api/composio/shared-connections/${encodeURIComponent(flow.initial.resource.connectionRef)}/connect/desktop`;
          receipt.outstanding = `${apiFlow ? 'teardown_api_cancel' : 'teardown_cancel'}:${flow.scope}`; await persistSharedComposioDesktopReceipt();
          let response;
          if (apiFlow) {
            teardownStage = 'api_cancel_ack'; await expect(cancel).toHaveCount(0); expect(flow.cancelWrites).toBe(0); flow.cancelWrites += 1;
            response = await currentHarness.page.request.post(`${baseUrl}${desktopPath}?${new URLSearchParams({ workspaceId: flow.workspaceId })}`,
              { timeout: 15_000, headers: { Origin: baseUrl }, data: { state: flow.states[0], action: 'cancel' } });
          } else {
            if (!await cancel.isVisible()) await editor.locator('summary').filter({ hasText: labels.accountSetup }).click();
            teardownStage = 'cancel_enabled'; await expect(cancel).toBeEnabled();
            const acknowledgement = currentHarness.page.waitForResponse(value => {
              const url = new URL(value.url()), request = value.request();
              if (url.origin !== baseUrl || url.pathname !== desktopPath || url.searchParams.get('workspaceId') !== flow.workspaceId || request.method() !== 'POST') return false;
              const body = request.postDataJSON() as Record<string, unknown>; return body.action === 'cancel'
                && (flow.states.includes(String(body.state)) || flow.intents.includes(String(body.intent)));
            }, { timeout: 15_000 }); teardownStage = 'cancel_ack'; [response] = await Promise.all([acknowledgement, cancel.click()]);
          }
          expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toContain('no-store');
          const payload = await response.json() as { success?: boolean; data?: Record<string, unknown> }; const terminal = payload.data;
          teardownStage = 'terminal_shape';
          if (payload.success !== true || !terminal || typeof terminal.state !== 'string' || !canonicalState.test(terminal.state)) throw new Error('The cancellation has no exact terminal acknowledgement.');
          expect(terminal.connectionRef).toBe(flow.initial.resource.connectionRef); if (flow.states.length) expect(terminal.state === flow.states[0]).toBe(true);
          expect(typeof terminal.expiresAt === 'string' && Number.isFinite(Date.parse(terminal.expiresAt))).toBe(true);
          expect(Object.keys(terminal).sort()).toEqual(['connectionRef', 'expiresAt', 'state', 'status', ...(terminal.status === 'completed' ? [] : ['code', 'error'])].sort());
          expect(terminal.status === 'completed' ? !Object.hasOwn(terminal, 'code') && !Object.hasOwn(terminal, 'error')
            : terminal.status === 'cancelled' ? terminal.code === 'CONNECTION_DESKTOP_OAUTH_CANCELLED' && terminal.error === 'Shared sign-in was cancelled.'
              : terminal.status === 'expired' ? terminal.code === 'CONNECTION_DESKTOP_OAUTH_EXPIRED' && terminal.error === 'Shared sign-in expired. Start again.'
                : terminal.status === 'failed' && terminal.code === 'CONNECTION_DESKTOP_OAUTH_FAILED' && terminal.error === 'Shared sign-in could not be completed. Reload and start again.').toBe(true);
          teardownStage = 'fresh_status';
          const fresh = await currentHarness.page.request.get(`${baseUrl}${desktopPath}?${new URLSearchParams({ workspaceId: flow.workspaceId, state: terminal.state })}`, { timeout: 15_000 });
          expect(fresh.status()).toBe(200); expect(fresh.headers()['cache-control']).toContain('no-store');
          const freshPayload = await fresh.json() as { success?: boolean; data?: Record<string, unknown> };
          expect(freshPayload.success).toBe(true); expect(freshPayload.data).toEqual(terminal);
          if (apiFlow) {
            expect(terminal.status).toBe('cancelled'); const current = await readExactSharedComposioDesktopConnection(flow);
            expect(current.resource.bindingRevision).toBe(flow.initial.resource.bindingRevision); expect(current.grants).toEqual(flow.current.grants);
            expect(flow.finalizeWrites).toBe(0); await readOwnedSharedComposioDesktopLedger(flow, 0); receipt.apiFlowCancelled = true;
          }
          teardownStage = 'editor_settlement'; await expect(cancel).toHaveCount(0); await expect(editor.getByTestId('shared-connection-save')).toBeEnabled({ timeout: 15_000 });
          receipt.outstanding = null; await persistSharedComposioDesktopReceipt();
        }
        teardownStage = 'dialog_close'; await editor.getByRole('button', { name: 'Close', exact: true }).click(); await expect(editor).toHaveCount(0);
      }
      teardownStage = 'test_interception'; await currentHarness.page.unrouteAll({ behavior: 'wait' });
    } catch { problem = true; mayCloseElectron = false; receipt.outstanding = `teardown_unconfirmed:${teardownStage}`; }
    if (mayCloseElectron) {
      try { teardownStage = 'electron_close'; const result = await closeOwnedSharedComposioElectron(currentHarness);
        receipt.processes = [{ pid: result.processId, processGroupId: result.processGroupId, closed: true }]; receipt.electronClosed = true;
      } catch { problem = true; receipt.outstanding = `teardown_unconfirmed:${teardownStage}`; }
    }
  }
  for (const context of [manager, anonymous]) { try { await context?.close(); } catch { closed = false; problem = true; } }
  try {
    const proof = await readOwnedSharedComposioDesktopProviderProof(); receipt.providerCounters = proof.stats;
    expect(proof.stats.consents).toBe(receipt.systemBrowserOpenedCount); expect(proof.stats.approvals).toBe(3); expect(proof.stats.sdkLinks).toBe(4);
    expect(proof.stats.businessCalls).toBe(0); expect(proof.stats.callbackRedirects).toBe(3);
  } catch { problem = true; }
  try { await admin?.close(); } catch { closed = false; problem = true; }
  try { await providerControl?.dispose(); } catch { closed = false; problem = true; } receipt.closedContexts = closed;
  if (problem || verifiedCases !== 3 || !ledgerPoolsClosed || !receipt.apiFlowCancelled || !receipt.electronClosed) {
    receipt.phase = 'preserved'; await persistSharedComposioDesktopReceipt(); throw new Error('The own native acceptance or closure is incomplete; preserve the private fixture.');
  }
  receipt.phase = 'awaiting_manual_system_browser_close'; await persistSharedComposioDesktopReceipt();
  const closurePath = path.join(fixture.fixtureRoot, 'system-browser-closure.json');
  await expect.poll(async () => { try { return (await fs.lstat(closurePath)).isFile(); } catch { return false; } },
    { timeout: Math.max(1, Math.min(8 * 60_000, manualDeadline - Date.now())), message: 'Root must confirm closure of exactly the owned system-browser tabs.' }).toBe(true);
  const stat = await fs.lstat(closurePath);
  expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.() && stat.size > 1 && stat.size < 2048 && (stat.mode & 0o777) === 0o600).toBe(true);
  const handle = await fs.open(closurePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const held = await handle.stat(); expect(held.ino === stat.ino && held.dev === stat.dev).toBe(true);
    expect(JSON.parse(await handle.readFile('utf8'))).toEqual({ version: 1, nonce: fixture.nonce, origin: providerOrigin, openedCount: receipt.systemBrowserOpenedCount, closed: true });
  } finally { await handle.close(); }
  expect(receipt.forbiddenRequests).toEqual([]); expect(receipt.unexpectedDialogs).toEqual([]); expect(ledgerPoolsClosed).toBe(true);
  // Provider lifetime/close is exclusively owned and checked by the parent after this worker exits.
  receipt.phase = 'verified_closed'; await persistSharedComposioDesktopReceipt();
}

test.beforeAll(async ({ browser }) => {
  fixture = await readOwnedSharedComposioDesktopFixture(); receiptPath = path.join(fixture.fixtureRoot, 'browser-receipt.json');
  receipt = { version: 1, nonce: fixture.nonce, actorId: fixture.actorId, managerActorId: '', phase: 'setup', outstanding: null,
    parentOwnedProvider: true, closedContexts: false, electronClosed: false, processes: [], providerOrigin, systemBrowserOpenedCount: 0,
    desktopPaths: fixture.desktopPaths, desktopDirectoryProofs: fixture.desktopDirectoryProofs, connections: [], membershipIds: [], workspaceIds: [], profileIds: [],
    forbiddenRequests: [], unexpectedDialogs: [], visualInventory: [], ledgerProofs: [] };
  await persistSharedComposioDesktopReceipt();
  providerControl = await playwrightRequest.newContext({ baseURL: new URL(controlUrl).origin, extraHTTPHeaders: { Authorization: `Bearer ${controlToken}` }, timeout: 10_000 });
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
  receipt.outstanding = 'membership:manager'; await persistSharedComposioDesktopReceipt();
  const proposed = await admin.request.post('/api/admin/organization/memberships', { data: { name: `Composio manager ${fixture.nonce}`, email, role: 'member' } });
  expect(proposed.status()).toBe(202);
  const proposal = (await proposed.json()).data as { membershipId: string; approval: { required: boolean }; quote: { nonBillable: boolean } };
  expect(proposal.approval.required).toBe(false); expect(proposal.quote.nonBillable).toBe(true); receipt.membershipIds.push(proposal.membershipId); await persistSharedComposioDesktopReceipt();
  const activated = await admin.request.post(`/api/admin/organization/memberships/${encodeURIComponent(proposal.membershipId)}/activate`, { data: { password } });
  expect(activated.status()).toBe(200); expect((await activated.json()).data).toMatchObject({ stage: 'active', membershipId: proposal.membershipId, execution: { onboardingInitialized: true } });
  manager = await createAuthenticatedContext(browser, { baseURL: baseUrl, extraHTTPHeaders: { Origin: baseUrl } }, { email, password });
  const managerSession = await requestManagedTestSession(manager.request); expect(managerSession.status()).toBe(200);
  const identity = (await managerSession.json()).user as { id: string; role: string; email: string };
  expect(identity.email === email && identity.role === 'user' && identity.id !== fixture.actorId).toBe(true); managerId = identity.id; receipt.managerActorId = managerId;
  const listingResponse = await manager.request.get('/api/workspaces'); expect(listingResponse.status()).toBe(200);
  const listing = await listingResponse.json() as ClientWorkspaceResponse;
  expect(listing.defaultWorkspace?.type).toBe('personal'); personalWorkspaceId = listing.defaultWorkspace!.id; organizationId = listing.defaultWorkspace!.organizationId!;
  expect(personalWorkspaceId && organizationId).toBeTruthy(); receipt.outstanding = 'workspace:team'; await persistSharedComposioDesktopReceipt();
  const teamResponse = await admin.request.post('/api/workspaces', { data: { type: 'team', name: `Composio desktop team ${fixture.nonce}` } }); expect(teamResponse.status()).toBe(201);
  const team = (await teamResponse.json()).workspace as { id: string; type: string; organizationId: string; status: string };
  expect(team).toMatchObject({ type: 'team', organizationId, status: 'active' }); teamId = team.id; receipt.workspaceIds.push(teamId); await persistSharedComposioDesktopReceipt();
  const joined = await admin.request.post(`/api/workspaces/${encodeURIComponent(teamId)}/members`, { data: { userId: managerId, role: 'member', canRead: true, canWrite: false, canManage: false } });
  expect(joined.status()).toBe(200); expect((await joined.json()).success).toBe(true);
  receipt.outstanding = 'own_org_secret'; await persistSharedComposioDesktopReceipt();
  const secretResponse = await admin.request.get('/api/integrations/env?scope=integrations&secretScope=organization&key=COMPOSIO_API_KEY'); expect(secretResponse.status()).toBe(200);
  const secretPayload = await secretResponse.json() as { success?: boolean; data?: { revision: string; entries: Array<{ key: string }> } };
  if (secretPayload.success !== true || !secretPayload.data) throw new Error('The exact owning organization secret revision is required.');
  expect(secretPayload.data.entries.some(entry => entry.key === 'COMPOSIO_API_KEY')).toBe(false);
  const savedSecret = await admin.request.patch('/api/integrations/env', { data: { scope: 'integrations', secretScope: 'organization', baseRevision: secretPayload.data.revision,
    patches: [{ key: 'COMPOSIO_API_KEY', value: `own-native-composio-${randomBytes(16).toString('hex')}` }] } }); expect(savedSecret.status()).toBe(200); expect((await savedSecret.json()).success).toBe(true);
  await createOwnSharedComposioDesktopConnections(); expect((await readOwnedSharedComposioDesktopProviderProof()).stats.sdkLinks).toBe(0);
  anonymous = await browser.newContext({ baseURL: baseUrl }); harness = await launchOwnedSharedComposioElectron({ fixturePath, providerOrigin });
  await observeSharedComposioDesktopRequests(harness.page);
  await harness.page.goto(`${baseUrl}/en/login`, { waitUntil: 'domcontentloaded' });
  await harness.page.locator('#email').fill(email); await harness.page.locator('#password').fill(password);
  const signedIn = harness.page.waitForResponse(response => new URL(response.url()).origin === baseUrl && new URL(response.url()).pathname === '/api/auth/sign-in/email' && response.request().method() === 'POST');
  await harness.page.locator('button[type="submit"]').click(); expect((await signedIn).status()).toBe(200);
  await harness.page.waitForURL(url => url.origin === baseUrl && ['/', '/en', '/en/', '/de', '/de/'].includes(url.pathname), { waitUntil: 'domcontentloaded' });
  await expect(harness.page.getByRole('banner')).toBeVisible(); await expect(harness.page.locator('#email')).toHaveCount(0);
  const nativeSession = await harness.page.request.get(`${baseUrl}/api/auth/get-session`); expect(nativeSession.status()).toBe(200);
  const nativeIdentity = await nativeSession.json() as { user?: { id?: string }; session?: { id?: string } };
  if (nativeIdentity.user?.id !== managerId || typeof nativeIdentity.session?.id !== 'string') throw new Error('The real native manager session was not acknowledged.');
  nativeAuthSessionHash = sharedComposioDesktopSessionFingerprint(nativeIdentity.session.id);
  expect(await harness.page.evaluate(() => Reflect.get(window, 'canvasDesktop')?.sharedComposioOAuthVersion)).toBe(1);
  manualDeadline = Date.now() + 20 * 60_000; receipt.outstanding = null; receipt.phase = 'native_original_manager_ready'; await persistSharedComposioDesktopReceipt();
});

test('Org and Team Manage-only users complete genuine system-browser Composio consent once in their original Electron session', async () => {
  let stage = 'positive_setup';
  try {
    if (!harness) throw new Error('The issued native app is required.');
    for (const [index, owned] of connections.slice(0, 2).entries()) {
      const locale = owned.scope === 'team' ? 'de' : 'en', labels = owned.scope === 'team' ? de.sharedConnections : en.sharedConnections;
      const query = new URLSearchParams({ view: 'advanced', scope: owned.scope, workspaceId: owned.workspaceId, connectionRef: owned.initial.resource.connectionRef,
        ...(owned.scope === 'team' ? { teamId } : {}) });
      stage = `positive_${owned.scope}_navigation`; await harness.page.goto(`${baseUrl}/${locale}/plugins?${query}`, { waitUntil: 'domcontentloaded' });
      const editor = harness.page.getByTestId('shared-connection-edit-dialog'); await expect(editor.getByTestId('shared-connection-save')).toBeEnabled();
      await expect(editor.locator('#shared-edit-name')).toHaveValue(owned.label); await editor.locator('summary').filter({ hasText: labels.accountSetup }).click();
      stage = `positive_${owned.scope}_connect`; await editor.getByRole('button', { name: labels.connect, exact: true }).click();
      await expect(editor.getByText(labels.desktopWaiting, { exact: true })).toBeVisible(); expect(owned.startWrites).toBe(1);
      const viewport = await harness.page.evaluate(() => ({ width: innerWidth, height: innerHeight })); expect(viewport.width).toBe(1280); expect(viewport.height > 600).toBe(true);
      const waitingImage = `composio-${owned.scope}-waiting-1280.png`; await harness.page.screenshot({ path: path.join(fixture.fixtureRoot, waitingImage), scale: 'css' }); receipt.visualInventory.push(waitingImage);
      stage = `positive_${owned.scope}_consent`; await waitForOriginalSharedComposioDesktopCompletion(owned, index + 1);
      const completedImage = `composio-${owned.scope}-completed-1280.png`; await harness.page.screenshot({ path: path.join(fixture.fixtureRoot, completedImage), scale: 'css' }); receipt.visualInventory.push(completedImage);
      await editor.getByRole('button', { name: 'Close', exact: true }).click(); await expect(editor).toHaveCount(0);
    }
    const provider = await readOwnedSharedComposioDesktopProviderProof(); expect(provider.stats.sdkLinks).toBe(2); expect(provider.stats.businessCalls).toBe(0);
    verifiedCases += 1; receipt.phase = 'two_original_manager_publications_verified'; await persistSharedComposioDesktopReceipt();
  } catch (error) {
    const site = error instanceof Error ? error.stack?.match(/tests\/shared-composio-desktop-oauth-local\.spec\.ts:(\d+):(\d+)/u) : null;
    receipt.failure = { name: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(error.name) ? error.name : 'UnknownError', stage,
      ...(site ? { site: `tests/shared-composio-desktop-oauth-local.spec.ts:${site[1]}:${site[2]}` } : {}) }; await persistSharedComposioDesktopReceipt();
    throw new Error('The own native Composio completion assertion failed; inspect the private safe receipt.');
  }
});

test('a genuine live native flow blocks departure and explicit Cancel prevents publication after late HTTPS approval', async () => {
  let stage = 'cancel_setup';
  try {
    if (!harness) throw new Error('The issued native app is required.'); const owned = connections[2];
    const query = new URLSearchParams({ view: 'advanced', scope: owned.scope, workspaceId: owned.workspaceId, connectionRef: owned.initial.resource.connectionRef });
    stage = 'cancel_navigation'; await harness.page.goto(`${baseUrl}/en/plugins?${query}`, { waitUntil: 'domcontentloaded' });
    const editor = harness.page.getByTestId('shared-connection-edit-dialog'); await expect(editor.getByTestId('shared-connection-save')).toBeEnabled();
    await editor.locator('summary').filter({ hasText: en.sharedConnections.accountSetup }).click();
    stage = 'cancel_start'; await editor.getByRole('button', { name: en.sharedConnections.connect, exact: true }).click();
    await expect(editor.getByText(en.sharedConnections.desktopWaiting, { exact: true })).toBeVisible();
    receipt.challenge = { nonce: fixture.nonce, origin: providerOrigin, scope: owned.scope, action: 'cancel', sequence: 3 };
    receipt.phase = 'awaiting_system_browser_cancel_case'; await persistSharedComposioDesktopReceipt(); console.info(`OWN_SHARED_COMPOSIO_DESKTOP_HANDOFF ${JSON.stringify(receipt.challenge)}`);
    await expect.poll(async () => (await readOwnedSharedComposioDesktopProviderProof()).stats.consents,
      { timeout: Math.max(1, Math.min(8 * 60_000, manualDeadline - Date.now())), intervals: [1000, 2000] }).toBe(3);
    stage = 'cancel_departure_guard'; await editor.getByRole('button', { name: 'Close', exact: true }).click(); await harness.page.keyboard.press('Escape'); await expect(editor).toBeVisible();
    await harness.page.evaluate(() => {
      const current = new URL(location.href), previous = new URL(location.href); previous.searchParams.delete('connectionRef');
      history.replaceState(history.state, '', previous.href); history.pushState(history.state, '', current.href); history.back();
    });
    await expect.poll(async () => new URL(harness!.page.url()).searchParams.get('connectionRef')).toBe(owned.initial.resource.connectionRef);
    await expect(editor).toBeVisible(); expect(owned.startWrites).toBe(1); expect(receipt.unexpectedDialogs).toEqual([]);
    stage = 'cancel_ack'; await editor.getByTestId('shared-desktop-cancel').click(); await expect(editor.getByText(en.sharedConnections.oauthCancelled, { exact: true })).toBeVisible();
    expect(owned.cancelWrites).toBe(1); expect(owned.finalizeWrites).toBe(0);
    const current = await readExactSharedComposioDesktopConnection(owned); expect(current.resource.bindingRevision).toBe(owned.initial.resource.bindingRevision); await readOwnedSharedComposioDesktopLedger(owned, 0);
    receipt.challenge = { nonce: fixture.nonce, origin: providerOrigin, scope: owned.scope, action: 'approve', sequence: 3 };
    receipt.phase = 'awaiting_late_cancelled_consent'; await persistSharedComposioDesktopReceipt(); console.info(`OWN_SHARED_COMPOSIO_DESKTOP_HANDOFF ${JSON.stringify(receipt.challenge)}`);
    stage = 'cancel_late_consent'; await expect.poll(async () => (await readOwnedSharedComposioDesktopProviderProof()).stats.approvals,
      { timeout: Math.max(1, Math.min(8 * 60_000, manualDeadline - Date.now())), intervals: [1000, 2000] }).toBe(3);
    const state = owned.states[0], flowHash = createHash('sha256').update(state).digest('hex');
    const provider = await readOwnedSharedComposioDesktopProviderProof(flowHash); expect(provider.issued[0]?.status).toBe('ACTIVE'); expect(provider.stats.businessCalls).toBe(0);
    const status = await harness.page.request.get(`${baseUrl}/api/composio/shared-connections/${encodeURIComponent(current.resource.connectionRef)}/connect/desktop?${new URLSearchParams({ workspaceId: owned.workspaceId, state })}`);
    expect(status.status()).toBe(200); expect(status.headers()['cache-control']).toContain('no-store'); const payload = await status.json() as { success?: boolean; data?: Record<string, unknown> };
    if (payload.success !== true || !payload.data) throw new Error('The late cancelled flow has no acknowledged status.');
    expect(payload.data).toEqual({ connectionRef: current.resource.connectionRef, state, expiresAt: payload.data.expiresAt, status: 'cancelled',
      code: 'CONNECTION_DESKTOP_OAUTH_CANCELLED', error: 'Shared sign-in was cancelled.' });
    expect((await readExactSharedComposioDesktopConnection(owned)).resource.bindingRevision).toBe(owned.initial.resource.bindingRevision); await readOwnedSharedComposioDesktopLedger(owned, 0);
    const screenshot = 'composio-cancelled-1280.png'; await harness.page.screenshot({ path: path.join(fixture.fixtureRoot, screenshot), scale: 'css' }); receipt.visualInventory.push(screenshot);
    receipt.systemBrowserOpenedCount = (await readOwnedSharedComposioElectronReceipt(harness)).shellAcknowledged; expect(receipt.systemBrowserOpenedCount).toBe(3);
    receipt.outstanding = null; delete receipt.challenge; await editor.getByRole('button', { name: 'Close', exact: true }).click(); await expect(editor).toHaveCount(0);
    verifiedCases += 1; receipt.phase = 'late_cancelled_consent_unpublished'; await persistSharedComposioDesktopReceipt();
  } catch (error) {
    const site = error instanceof Error ? error.stack?.match(/tests\/shared-composio-desktop-oauth-local\.spec\.ts:(\d+):(\d+)/u) : null;
    receipt.failure = { name: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(error.name) ? error.name : 'UnknownError', stage,
      ...(site ? { site: `tests/shared-composio-desktop-oauth-local.spec.ts:${site[1]}:${site[2]}` } : {}) }; await persistSharedComposioDesktopReceipt();
    throw new Error('The own native Composio cancellation assertion failed; inspect the private safe receipt.');
  }
});

test('actual native cookie ABA, frame changes and replacement sessions cannot open or publish the original Composio attempt', async () => {
  let stage = 'identity_setup', boundary: 'cookie-aba' | 'frame' | undefined, replacementStatus: number | undefined;
  try {
    if (!harness || !anonymous || !admin) throw new Error('The issued native contexts are required.'); const currentHarness = harness, owned = connections[3];
    const query = new URLSearchParams({ view: 'advanced', scope: 'team', teamId, workspaceId: owned.workspaceId, connectionRef: owned.initial.resource.connectionRef });
    stage = 'identity_navigation'; await currentHarness.page.goto(`${baseUrl}/de/plugins?${query}`, { waitUntil: 'domcontentloaded' });
    const editor = currentHarness.page.getByTestId('shared-connection-edit-dialog'); await expect(editor.getByTestId('shared-connection-save')).toBeEnabled();
    const initialMain = await readOwnedSharedComposioElectronReceipt(currentHarness), initialProvider = await readOwnedSharedComposioDesktopProviderProof();
    expect(initialMain.shellAcknowledged).toBe(3); expect(initialProvider.stats.sdkLinks).toBe(3);
    // This is actual API start plus actual native preload/IPC, not a claim of clicking UI Connect.
    stage = 'identity_start'; owned.startIntent = 'native-api';
    const started = await currentHarness.page.evaluate(async ({ ref, workspaceId, revisions, intent }) => {
      const response = await fetch(`/api/composio/shared-connections/${encodeURIComponent(ref)}/connect?${new URLSearchParams({ workspaceId })}`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-canvas-workspace-id': workspaceId },
        body: JSON.stringify({ ...revisions, desktop: true, intent }),
      });
      if (!response.ok) throw new Error('The own native boundary start was not acknowledged.');
      const payload = await response.json() as { success?: boolean; data?: { connectionRef: string; state: string; authorizationUrl: string; expiresAt: string; status: string } };
      if (payload.success !== true || !payload.data || payload.data.status !== 'waiting') throw new Error('The own native boundary start was not acknowledged.'); return payload.data;
    }, { ref: owned.initial.resource.connectionRef, workspaceId: owned.workspaceId, intent: randomBytes(32).toString('base64url'),
      revisions: { expectedMetadataRevision: owned.current.resource.metadataRevision, expectedGrantsRevision: owned.current.resource.grantsRevision, expectedBindingRevision: owned.current.resource.bindingRevision } });
    expect(started.connectionRef).toBe(owned.initial.resource.connectionRef); expect(owned.states.includes(started.state)).toBe(true);
    const desktopPath = `/api/composio/shared-connections/${encodeURIComponent(started.connectionRef)}/connect/desktop`;
    const desktopQuery = new URLSearchParams({ workspaceId: owned.workspaceId, state: started.state });
    stage = 'identity_anonymous'; expect((await anonymous.request.get(`${desktopPath}?${desktopQuery}`)).status()).toBe(401);
    const email = process.env.TEST_SECONDARY_EMAIL, password = process.env.TEST_SECONDARY_PASSWORD;
    if (!email || !password) throw new Error('The private original manager login is required.');
    stage = 'identity_replacement_login'; const deadline = Date.now() + 45_000; let retries = 0;
    while (true) {
      const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('The bounded replacement sign-in expired.');
      const response = await anonymous.request.post('/api/auth/sign-in/email', { headers: { Origin: baseUrl }, data: { email, password }, timeout: Math.min(15_000, remaining) });
      replacementStatus = response.status(); if (replacementStatus !== 429 || retries >= 2) { expect(replacementStatus).toBe(200); break; }
      retries += 1; await waitForAuthRetry(response, deadline, 'Native replacement sign-in', retries);
    }
    const replacementIdentity = await anonymous.request.get('/api/auth/get-session'); expect(replacementIdentity.status()).toBe(200); expect((await replacementIdentity.json()).user.id).toBe(managerId);
    const replacementCookies = (await anonymous.cookies(baseUrl)).filter(cookie => ['better-auth.session_token', '__Host-better-auth.session_token'].includes(cookie.name)); expect(replacementCookies.length).toBe(1);
    stage = 'identity_cookie_read';
    const originalCookies = await currentHarness.application.evaluate(async ({ BrowserWindow }, origin) =>
      (await BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({ url: origin })).filter(cookie => ['better-auth.session_token', '__Host-better-auth.session_token'].includes(cookie.name)), baseUrl);
    expect(originalCookies.length).toBe(1); expect(originalCookies[0].value === replacementCookies[0].value).toBe(false);
    const mainBefore = await readOwnedSharedComposioElectronReceipt(currentHarness);
    const before = { links: (await readOwnedSharedComposioDesktopProviderProof()).stats.sdkLinks, openings: mainBefore.shellAcknowledged,
      attempts: mainBefore.shellAttempts, blockedRequests: mainBefore.blockedRequests, blockedShellRequests: mainBefore.blockedShellRequests };
    expect(before.links).toBe(4); expect(before.openings).toBe(3); expect(before.blockedShellRequests).toBe(0);
    const invocation = { state: started.state, authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt,
      target: { kind: 'shared' as const, connectionRef: started.connectionRef, workspaceId: owned.workspaceId } };
    for (const currentBoundary of ['cookie-aba', 'frame'] as const) {
      boundary = currentBoundary; stage = 'identity_barrier_arm';
      await currentHarness.application.evaluate(async (_electron, input) => {
        const api = Reflect.get(globalThis, '__canvasOwnedSharedComposioElectron') as { armOwnedOAuthStatusBarrier: (value: { connectionRef: string; state: string; workspaceId: string }) => Promise<void> };
        await api.armOwnedOAuthStatusBarrier(input);
      }, { connectionRef: started.connectionRef, state: started.state, workspaceId: owned.workspaceId });
      stage = 'identity_preload_invocation';
      await currentHarness.page.evaluate(input => {
        const bridge = Reflect.get(window, 'canvasDesktop') as { sharedComposioOAuthVersion: number; openSharedComposioOAuth: (value: typeof input) => Promise<{ ok: boolean }> };
        if (bridge.sharedComposioOAuthVersion !== 1) throw new Error('The actual shared Composio preload is unavailable.');
        Reflect.set(window, '__ownedSharedComposioInvocation', bridge.openSharedComposioOAuth(input).then(reply => reply.ok));
      }, invocation);
      stage = 'identity_barrier_wait';
      await expect.poll(async () => (await readOwnedSharedComposioElectronReceipt(currentHarness)).barrier.held,
        { timeout: 5000, intervals: [50, 100, 200], message: 'Hold only the exact original NativeSession.fetch GET200 headers.' }).toBe(true);
      if (currentBoundary === 'cookie-aba') {
        stage = 'identity_cookie_aba';
        await currentHarness.application.evaluate(async ({ BrowserWindow }, input) => {
          const jar = BrowserWindow.getAllWindows()[0].webContents.session.cookies;
          for (const cookie of [input.replacement, input.original]) await jar.set({ url: input.origin, name: cookie.name, value: cookie.value,
            path: cookie.path, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: 'lax' });
        }, { origin: baseUrl, replacement: replacementCookies[0], original: originalCookies[0] });
      } else {
        stage = 'identity_frame'; await currentHarness.page.evaluate(url => history.replaceState(history.state, '', url),
          `${baseUrl}/de/plugins?${new URLSearchParams({ view: 'advanced', scope: 'team', teamId, workspaceId: teamId, connectionRef: connections[1].initial.resource.connectionRef })}`);
      }
      stage = 'identity_barrier_release';
      await currentHarness.application.evaluate(async () => {
        const api = Reflect.get(globalThis, '__canvasOwnedSharedComposioElectron') as { releaseOwnedOAuthStatusBarrier: () => Promise<void> }; await api.releaseOwnedOAuthStatusBarrier();
      });
      stage = 'identity_launch_result'; expect(await currentHarness.page.evaluate(async () => await Reflect.get(window, '__ownedSharedComposioInvocation') as boolean)).toBe(false);
      await assertNoSharedComposioDesktopMutationAfterIdentityChange(owned, before);
    }
    boundary = undefined; stage = 'identity_other_session';
    for (const context of [anonymous, admin]) {
      expect((await context.request.get(`${desktopPath}?${desktopQuery}`)).status()).toBe(403);
      expect((await context.request.post(`${desktopPath}?${new URLSearchParams({ workspaceId: owned.workspaceId })}`,
        { headers: { Origin: baseUrl }, data: { state: started.state, action: 'finalize' } })).status()).toBe(403);
    }
    stage = 'identity_return_ui'; await currentHarness.page.goto(`${baseUrl}/de/plugins?${query}`, { waitUntil: 'domcontentloaded' });
    const currentEditor = currentHarness.page.getByTestId('shared-connection-edit-dialog'); await expect(currentEditor.getByTestId('shared-connection-save')).toBeEnabled();
    await currentEditor.locator('summary').filter({ hasText: de.sharedConnections.accountSetup }).click();
    await currentEditor.getByRole('button', { name: de.sharedConnections.checkStatus, exact: true }).click();
    await expect(currentEditor.getByText(de.sharedConnections.connectionRequired, { exact: true })).toBeVisible();
    const screenshot = 'composio-native-denied-session-frame-1280.png'; await currentHarness.page.screenshot({ path: path.join(fixture.fixtureRoot, screenshot), scale: 'css' }); receipt.visualInventory.push(screenshot);
    await assertNoSharedComposioDesktopMutationAfterIdentityChange(owned, before);
    const sessions = await admin.request.get('/api/sessions'); expect(sessions.status()).toBe(200); expect((await sessions.json()).sessions).toEqual([]);
    expect(receipt.forbiddenRequests).toEqual([]); expect(receipt.unexpectedDialogs).toEqual([]);
    receipt.outstanding = null; receipt.phase = 'native_current_identity_guards_verified'; verifiedCases += 1; await persistSharedComposioDesktopReceipt();
  } catch (error) {
    const site = error instanceof Error ? error.stack?.match(/tests\/shared-composio-desktop-oauth-local\.spec\.ts:(\d+):(\d+)/u) : null;
    receipt.failure = { name: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(error.name) ? error.name : 'UnknownError', stage,
      ...(boundary ? { boundary } : {}), ...(replacementStatus !== undefined && Number.isInteger(replacementStatus) && replacementStatus >= 100 && replacementStatus <= 599 ? { replacementStatus } : {}),
      ...(site ? { site: `tests/shared-composio-desktop-oauth-local.spec.ts:${site[1]}:${site[2]}` } : {}) }; await persistSharedComposioDesktopReceipt();
    throw new Error('The own native Composio identity assertion failed; inspect the private safe receipt.');
  }
});

test.afterAll(async () => {
  if (!receipt) return;
  try { await closeOwnedSharedComposioDesktopContexts(); }
  catch { receipt.phase = 'preserved'; await persistSharedComposioDesktopReceipt(); throw new Error('Own native/system-browser closure is unconfirmed; preserve the private fixture.'); }
});
