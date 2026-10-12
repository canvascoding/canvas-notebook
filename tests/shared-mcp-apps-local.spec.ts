import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, request, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight, waitForAuthRetry } from './helpers/managed-test-context';
import { createSharedIntegrationProviderRef } from '../app/lib/integration-tools/connections/provider-authorization';
import type { IntegrationConnectionDescriptor, IntegrationConnectionMutation } from '../app/lib/integration-tools/connections/contracts';
import type { SharedMcpAppDescriptor } from '../app/lib/mcp/apps-types';
import type { AgentProfile } from '../app/lib/agents/registry';
import type { AiAppRuntimeCatalog, AiEffectiveRuntimeResolution } from '../app/lib/agent-runtime-policy/types';
import type { ClientWorkspaceResponse } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';
import de from '../messages/de.json';

type Fixture = { version: 1; nonce: string; actorId: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; rootDevice: string; rootInode: string; databaseName: string; databaseOwner: string;
  createAcknowledged: boolean; listenerVerified: boolean; phase: string; uncertain: boolean; serverPid: number;
  directoryProofs: Record<string, { device: string; inode: string }> };
type ProviderState = { requests: string[]; calls: Array<{ name: string }>; resourceReads: string[]; verificationProbes: number };
type Member = { context: BrowserContext; userId: string; email: string; password: string };
type OwnedSession = { sessionId: string; actorUserId: string; context: BrowserContext; deleted: boolean };
type Invocation = { descriptor: SharedMcpAppDescriptor; input: Record<string, unknown>; result: unknown; messageId: number; sequence: number };
type NativeHost = { url: string; origin: string; frameOrigin: string; channelId: string; nonce: string; expiresAt: number };
type NativeRender = { success: true; contractVersion: 1; sessionId: string; workspaceId: string; toolCallId: string; checkedAt: number; host: NativeHost };
type NativeCall = { success: true; contractVersion: 1; call: null | { callId: string; status: string; app: SharedMcpAppDescriptor; result?: unknown };
  approval: null | { token: string; tool: string; arguments: Record<string, unknown> } };
type NativeHandle = { api: APIRequestContext; userId: string; authSessionId: string; session: OwnedSession; invocation: Invocation; render: NativeRender };
type Receipt = { version: 1; nonce: string; actorId: string; phase: string; outstanding: string | null; closedContexts: boolean;
  membershipIds: string[]; actorIds: string[]; workspaceIds: string[]; agentId?: string;
  connections: Array<{ connectionRef: string; ownership: 'organization' | 'team'; archived: boolean }>;
  sessions: Array<{ sessionId: string; actorUserId: string; deleted: boolean }>;
  processes: Array<{ pid: number; processGroupId: number; closed: boolean }>;
  invocations: Array<{ sessionId: string; toolCallId: string; connectionRef: string }>;
  visualInventory: string[]; forbiddenRequests: string[]; unexpectedDialogs: string[];
  verifiedCases: number; nativeProtocolCases?: string[]; nativeBridgeTransportSeam?: true; nativeDevice?: false;
  providerFinal?: ProviderState; failure?: { name: string; site?: string } };
const baseUrl = 'http://127.0.0.1:3001';
const tools = ['app_view', 'app_action', 'model_only'];
let fixture: Fixture, receipt: Receipt, admin: BrowserContext, control: Awaited<ReturnType<typeof request.newContext>>;
const members: Member[] = [];
let organizationId = '', teamId = '', adminWorkspaceId = '';
let agent: AgentProfile, originalBradley: unknown, originalCatalog: AiAppRuntimeCatalog, originalFlag = false, ownedCatalogRevision = 0;
let receiptWrite = Promise.resolve();
const connections: IntegrationConnectionDescriptor[] = [], sessions: OwnedSession[] = [], pages: Page[] = [];
const invocations: Invocation[] = [], frameTickets: string[] = [];
const nativeApiContexts: APIRequestContext[] = [], nativeBrowserContexts: BrowserContext[] = [], nativeHandles: NativeHandle[] = [];
test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', video: 'off' });

async function readOwnedSharedMcpAppsData<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status()).toBe(status);
  const payload = await response.json() as { success?: boolean; data?: T };
  expect(payload.success).toBe(true);
  if (!payload.data || typeof payload.data !== 'object') throw new Error('An acknowledged object DTO is required.');
  return payload.data;
}

/** Native authentication is issued by Better Auth and carried only by a cookie-free API client. */
async function createOwnedSharedMcpAppsBearer(email: string, password: string): Promise<{ api: APIRequestContext; userId: string; authSessionId: string }> {
  const signIn = await request.newContext({ baseURL: baseUrl, timeout: 15_000, extraHTTPHeaders: { Origin: baseUrl } });
  nativeApiContexts.push(signIn);
  const deadline = Date.now() + 45_000;
  let token = '';
  for (let attempt = 0; ; attempt++) {
    const response = await signIn.post('/api/auth/sign-in/email', { data: { email, password } });
    if (response.status() === 429 && attempt < 2) { await waitForAuthRetry(response, deadline, 'Owned shared native sign-in', attempt + 1); continue; }
    expect(response.status()).toBe(200); token = response.headers()['set-auth-token'] ?? '';
    if (!token || token.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(token)) throw new Error('The native sign-in requires its actual bounded bearer.');
    break;
  }
  const api = await request.newContext({ baseURL: baseUrl, timeout: 15_000, storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  token = ''; nativeApiContexts.push(api);
  const response = await api.get('/api/auth/get-session'); expect(response.status()).toBe(200);
  const identity = await response.json() as { user: { id: string; email: string }; session: { id: string } };
  expect(identity.user.email.toLowerCase()).toBe(email.toLowerCase()); expect(identity.user.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/u);
  expect(identity.session.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/u); expect((await api.storageState()).cookies).toEqual([]);
  return { api, userId: identity.user.id, authSessionId: identity.session.id };
}

async function readOwnedSharedNativeData<T>(response: APIResponse): Promise<T> {
  expect(response.status()).toBe(200); const payload = await response.json() as { success: boolean; contractVersion: number; workspaceId: string; data: T };
  expect(payload).toMatchObject({ success: true, contractVersion: 2, workspaceId: teamId });
  expect(response.headers()['cache-control']).toContain('no-store'); expect(response.headers().vary).toContain('Authorization'); return payload.data;
}

async function persistOwnedSharedMcpAppsReceipt(): Promise<void> {
  const snapshot = JSON.stringify(receipt);
  receiptWrite = receiptWrite.then(async () => {
    const temporary = path.join(fixture.fixtureRoot, 'browser-receipt.json.tmp');
    await fs.writeFile(temporary, snapshot, { mode: 0o600 });
    await fs.rename(temporary, path.join(fixture.fixtureRoot, 'browser-receipt.json'));
  });
  await receiptWrite;
}

async function readOwnedSharedMcpAppsFixture(): Promise<Fixture> {
  for (const flag of ['CANVAS_AGENT_SETTINGS_BROWSER_RUN', 'CANVAS_SHARED_MCP_APPS_BROWSER_RUN', 'CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN', 'E2E_EXTERNAL_SERVER']) expect(process.env[flag]).toBe('1');
  expect(process.env.BASE_URL).toBe(baseUrl); expect(process.env.__NEXT_PROCESSED_ENV).toBe('true');
  const file = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE ?? '';
  expect(path.isAbsolute(file) && path.basename(file) === 'recovery.json').toBe(true);
  const root = path.dirname(file), rootStat = await fs.lstat(root);
  expect(rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === process.getuid?.() && (rootStat.mode & 0o777) === 0o700).toBe(true);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: Fixture;
  try {
    const stat = await handle.stat();
    expect(stat.isFile() && stat.nlink === 1 && stat.uid === rootStat.uid && (stat.mode & 0o777) === 0o600 && stat.size <= 65536).toBe(true);
    value = JSON.parse(await handle.readFile('utf8')) as Fixture;
    const current = await fs.lstat(file); expect([current.dev, current.ino]).toEqual([stat.dev, stat.ino]);
  } finally { await handle.close(); }
  expect(value).toMatchObject({ version: 1, createAcknowledged: true, listenerVerified: true, phase: 'browser', uncertain: false, fixtureRoot: root });
  expect(value.nonce).toMatch(/^[a-f0-9]{32}$/u); expect(value.databaseName).toBe(`canvas_connection_test_${value.nonce}`);
  expect(value.databaseOwner).toBeTruthy(); expect(value.actorId).toBeTruthy(); expect(value.serverPid).toBeGreaterThan(0);
  process.kill(value.serverPid, 0);
  expect(await fs.realpath(process.cwd())).toBe(value.repo); expect(await fs.realpath(root)).toBe(root);
  expect([String(rootStat.dev), String(rootStat.ino)]).toEqual([value.rootDevice, value.rootInode]);
  const marker = await fs.open(path.join(root, '.fixture-owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await marker.stat(); expect(stat.isFile() && stat.nlink === 1 && stat.uid === rootStat.uid && (stat.mode & 0o777) === 0o600).toBe(true); expect(await marker.readFile('utf8')).toBe(value.ownerMarker); }
  finally { await marker.close(); }
  for (const [directory, name] of [[value.dataRoot, 'data'], [value.tmpRoot, 'tmp']]) {
    expect(directory).toBe(path.join(root, name)); const stat = await fs.lstat(directory);
    expect(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === rootStat.uid && (stat.mode & 0o777) === 0o700).toBe(true);
    expect(await fs.realpath(directory)).toBe(directory);
    expect({ device: String(stat.dev), inode: String(stat.ino) }).toEqual(value.directoryProofs[directory]);
  }
  expect(process.env.DATA).toBe(value.dataRoot); expect(process.env.TMPDIR).toBe(value.tmpRoot);
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  expect(['postgresql:', 'postgres:']).toContain(databaseUrl.protocol); expect(databaseUrl.hostname).toBe('127.0.0.1'); expect(databaseUrl.port).toBe('55433');
  expect(databaseUrl.pathname).toBe(`/${value.databaseName}`); expect(databaseUrl.search + databaseUrl.hash).toBe('');
  const provider = new URL(process.env.CANVAS_SHARED_MCP_APPS_URL ?? '');
  expect(provider.protocol).toBe('http:'); expect(provider.hostname).toBe('127.0.0.1'); expect(provider.pathname).toBe('/mcp');
  expect(provider.search + provider.hash + provider.username + provider.password).toBe(''); expect(['3001', '3100', '4001', '4004', '55433', '']).not.toContain(provider.port);
  expect(process.env.CANVAS_SHARED_MCP_APPS_CONTROL_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  return value;
}

async function requestOwnedSharedMcpAppsProviderState(): Promise<ProviderState> {
  const origin = new URL(process.env.CANVAS_SHARED_MCP_APPS_URL!).origin;
  const response = await control.get(`${origin}/__fixture/state`, { headers: { Authorization: `Bearer ${process.env.CANVAS_SHARED_MCP_APPS_CONTROL_TOKEN}` } });
  expect(response.status()).toBe(200); const state = await response.json() as ProviderState;
  expect(Object.keys(state).sort()).toEqual(['calls', 'requests', 'resourceReads', 'verificationProbes']);
  expect(state.requests.every(value => typeof value === 'string')).toBe(true);
  expect(state.calls.every(value => Object.keys(value).length === 1 && typeof value.name === 'string')).toBe(true);
  expect(state.resourceReads.every(value => typeof value === 'string')).toBe(true);
  expect(Number.isSafeInteger(state.verificationProbes) && state.verificationProbes >= 0).toBe(true); return state;
}

async function createOwnedSharedMcpAppsMember(browser: Browser, index: number): Promise<Member> {
  const email = process.env[index === 0 ? 'TEST_SECONDARY_EMAIL' : 'TEST_EDITOR_EMAIL'];
  const password = process.env[index === 0 ? 'TEST_SECONDARY_PASSWORD' : 'TEST_EDITOR_PASSWORD'];
  if (!email || !password) throw new Error('Two normal fixture members are required.');
  receipt.outstanding = `member:${index}`; await persistOwnedSharedMcpAppsReceipt();
  const proposal = await readOwnedSharedMcpAppsData<{ membershipId: string; approval: { required: boolean }; quote: { nonBillable: boolean } }>(await admin.request.post('/api/admin/organization/memberships', {
    data: { name: `Apps member ${index} ${fixture.nonce}`, email, role: 'member' },
  }), 202);
  if (typeof proposal.membershipId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(proposal.membershipId)) throw new Error('The acknowledged membership identity is required.');
  receipt.membershipIds.push(proposal.membershipId); await persistOwnedSharedMcpAppsReceipt();
  expect(proposal.approval.required).toBe(false); expect(proposal.quote.nonBillable).toBe(true);
  const activated = await readOwnedSharedMcpAppsData<{ membershipId: string; stage: string; execution: { onboardingInitialized: boolean } }>(await admin.request.post(`/api/admin/organization/memberships/${encodeURIComponent(proposal.membershipId)}/activate`, { data: { password } }));
  expect(activated).toMatchObject({ membershipId: proposal.membershipId, stage: 'active', execution: { onboardingInitialized: true } });
  const context = await createAuthenticatedContext(browser, { baseURL: baseUrl, viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { Origin: baseUrl } }, { email, password });
  const member = { context, userId: '', email, password }; members.push(member);
  const response = await requestManagedTestSession(context.request); expect(response.status()).toBe(200);
  const session = await response.json() as { user: { id: string; email: string; role: string } };
  if (typeof session.user?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(session.user.id)) throw new Error('The authenticated member identity is required.');
  member.userId = session.user.id;
  receipt.actorIds.push(session.user.id); await persistOwnedSharedMcpAppsReceipt();
  expect(session.user.email.toLowerCase()).toBe(email.toLowerCase()); expect(session.user.role).toBe('user'); expect(session.user.id).not.toBe(fixture.actorId);
  receipt.outstanding = null; await persistOwnedSharedMcpAppsReceipt();
  return member;
}

async function mutateOwnedSharedMcpAppsConnection(index: number, mutation: Omit<IntegrationConnectionMutation, 'expectedMetadataRevision' | 'expectedGrantsRevision' | 'expectedBindingRevision'>): Promise<void> {
  const current = connections[index]; expect(receipt.outstanding).toBeNull(); receipt.outstanding = `connection:${index}`; await persistOwnedSharedMcpAppsReceipt();
  const url = `${baseUrl}/api/integrations/shared-connections/${encodeURIComponent(current.resource.connectionRef)}?workspaceId=${encodeURIComponent(teamId)}`;
  const next = (await readOwnedSharedMcpAppsData<{ connection: IntegrationConnectionDescriptor }>(await admin.request.patch(url, { data: {
    expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision,
    expectedBindingRevision: current.resource.bindingRevision, ...mutation,
  } }))).connection;
  if (next.resource?.connectionRef !== current.resource.connectionRef) throw new Error('The acknowledged mutation must identify the exact owned connection.');
  connections[index] = next; receipt.connections[index].archived = next.resource.status === 'archived'; await persistOwnedSharedMcpAppsReceipt();
  expect(next.resource.ownership).toEqual(current.resource.ownership);
  receipt.outstanding = null; await persistOwnedSharedMcpAppsReceipt();
}

async function createOwnedSharedMcpAppsSession(member: Member): Promise<OwnedSession> {
  receipt.outstanding = `session:${member.userId}`; await persistOwnedSharedMcpAppsReceipt();
  const effective = await readOwnedSharedMcpAppsData<AiEffectiveRuntimeResolution>(await member.context.request.get(`/api/agent-runtime/effective?${new URLSearchParams({ workspaceId: teamId, agentId: agent.agentId })}`));
  if (!effective.effectiveSelection) throw new Error('The verified fixture runtime must be selectable.');
  expect(effective.effectiveSelection.selection).toMatchObject({ providerId: 'ollama', modelId: 'shared-apps-fixture' });
  const response = await member.context.request.post('/api/sessions', { data: { agentId: agent.agentId, workspaceId: teamId,
    title: `Shared app ${fixture.nonce}`, clientRequestId: `apps-${randomBytes(16).toString('hex')}` } });
  expect(response.status()).toBe(200); const payload = await response.json() as { success: boolean; session: { sessionId: string; agentId: string; engine: string; workspace: { workspaceId: string } } };
  expect(payload.success).toBe(true);
  if (typeof payload.session?.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(payload.session.sessionId)) throw new Error('The acknowledged session identity is required.');
  const owned = { sessionId: payload.session.sessionId, actorUserId: member.userId, context: member.context, deleted: false };
  sessions.push(owned); receipt.sessions.push({ sessionId: owned.sessionId, actorUserId: owned.actorUserId, deleted: false }); await persistOwnedSharedMcpAppsReceipt();
  expect(payload.session).toMatchObject({ agentId: agent.agentId, engine: 'pi', workspace: { workspaceId: teamId } });
  receipt.outstanding = null; await persistOwnedSharedMcpAppsReceipt(); return owned;
}

async function seedOwnedSharedMcpAppInvocation(session: OwnedSession, connection: IntegrationConnectionDescriptor): Promise<Invocation> {
  expect(receipt.outstanding).toBeNull(); receipt.outstanding = 'invocation'; await persistOwnedSharedMcpAppsReceipt();
  const toolCallId = `apps_${randomBytes(16).toString('hex')}`;
  const file = path.join(fixture.fixtureRoot, `${toolCallId}.json`), outputFile = file.replace(/\.json$/u, '.output.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, nonce: fixture.nonce, actorUserId: session.actorUserId, sessionId: session.sessionId,
    agentId: agent.agentId, providerRef: createSharedIntegrationProviderRef(connection.resource), toolCallId }), { mode: 0o600, flag: 'wx' });
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=react-server', path.join(fixture.repo, 'scripts/helpers/shared-mcp-apps-invocation-fixture.ts'), file], {
    cwd: fixture.repo, env: { ...process.env, NODE_ENV: 'test' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-2048); });
  child.stderr.on('data', (chunk: Buffer) => { errors = `${errors}${chunk.toString()}`.slice(-2048); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  expect(child.pid).toBeGreaterThan(0); const pid = child.pid!;
  const ps = await promisify(execFile)('/bin/ps', ['-o', 'pgid=', '-p', String(pid)]); expect(Number(ps.stdout.trim())).toBe(pid);
  const proof = { pid, processGroupId: pid, closed: false }; receipt.processes.push(proof); await persistOwnedSharedMcpAppsReceipt();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => {
      // Only this actual issued child/PGID is eligible; preserve the fixture on a missing acknowledgement.
      if (child.pid === pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-pid, 'SIGTERM'); } catch { /* The closure proof below remains mandatory. */ }
      }
      reject(new Error('The owned invocation process did not close within its deadline.'));
    }, 60_000); })]);
    for (const target of [pid, -pid]) { let absent = false; try { process.kill(target, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; } expect(absent).toBe(true); }
    proof.closed = true;
    const failure = errors.match(/SHARED_MCP_APPS_INVOCATION_FAILED (ownership|imports|runtime-db|runtime-context|runtime-policy|runtime-backend|dispatch|persistence|closure|output)\b/u)?.[1];
    const failureSite = errors.match(/\bsite=(scripts\/helpers\/shared-mcp-apps-invocation-fixture\.ts:\d{1,5}:\d{1,5})\b/u)?.[1];
    expect(result, failure ? `The owned invocation failed during ${failure}${failureSite ? ` at ${failureSite}` : ''}.` : 'The owned invocation must succeed.').toEqual({ code: 0, signal: null });
    expect(output).toContain('SHARED_MCP_APPS_INVOCATION_SAVED'); expect(errors).not.toContain('SHARED_MCP_APPS_INVOCATION_FAILED');
  } finally { clearTimeout(timer); await persistOwnedSharedMcpAppsReceipt(); }
  const handle = await fs.open(outputFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let invocation: Invocation;
  try { const stat = await handle.stat(); expect(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size <= 2 * 1024 * 1024).toBe(true); invocation = JSON.parse(await handle.readFile('utf8')) as Invocation; }
  finally { await handle.close(); }
  expect(Object.keys(invocation).sort()).toEqual(['descriptor', 'input', 'messageId', 'result', 'sequence']);
  expect(invocation.descriptor).toMatchObject({ version: 2, connectionRef: connection.resource.connectionRef, toolCallId, toolName: 'app_view', resourceUri: 'ui://shared-app-fixture/design.html' });
  expect(invocation.descriptor.bindingRevision).toMatch(/^[a-f0-9]{64}$/u); expect(JSON.stringify(invocation)).not.toContain('mcpAppAuthority');
  receipt.invocations.push({ sessionId: session.sessionId, toolCallId, connectionRef: connection.resource.connectionRef }); receipt.outstanding = null; await persistOwnedSharedMcpAppsReceipt(); return invocation;
}

function observeOwnedSharedMcpAppsRequests(page: Page): void {
  page.on('dialog', dialog => { receipt.unexpectedDialogs.push(dialog.type()); void dialog.dismiss(); });
  page.on('request', incoming => {
    const url = new URL(incoming.url()); if (url.origin !== baseUrl || !url.pathname.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(incoming.method())) return;
    const body = incoming.postDataJSON() as Record<string, unknown> | null;
    const watch = incoming.method() === 'POST' && url.pathname === '/api/files/watch' && url.search === `?workspaceId=${encodeURIComponent(teamId)}`
      && body && Object.keys(body).sort().join(',') === 'clientId,dirs' && typeof body.clientId === 'string'
      && /^client-\d+-[a-z0-9]{1,9}$/u.test(body.clientId) && Array.isArray(body.dirs) && body.dirs.length === 0;
    const allowed = incoming.method() === 'POST' && url.pathname === '/api/mcp/apps' && body?.agentId === agent.agentId
      && sessions.some(value => !value.deleted && value.sessionId === body.sessionId) && ['render', 'call'].includes(String(body.action))
      || watch
      || incoming.method() === 'POST' && url.pathname === '/api/instance/human-activity'
      || incoming.method() === 'PATCH' && url.pathname === '/api/sessions' && body?.markAsRead === true && body.agentId === agent.agentId && sessions.some(value => value.sessionId === body.sessionId)
      || incoming.method() === 'PATCH' && url.pathname === '/api/user-preferences' && body?.lastActiveAgentId === agent.agentId && Object.keys(body).length === 1;
    if (!allowed) receipt.forbiddenRequests.push(`${incoming.method()} ${url.pathname}`);
  });
}

async function openOwnedSharedMcpAppWidget(member: Member, session: OwnedSession, locale: 'en' | 'de' = 'en', theme: 'light' | 'dark' = 'light', width = 1280): Promise<{ page: Page; frame: Frame }> {
  const page = await member.context.newPage(); pages.push(page); observeOwnedSharedMcpAppsRequests(page);
  await page.addInitScript(value => { if (window === window.top) localStorage.setItem('theme', value); }, theme);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/${locale}/notebook?${new URLSearchParams({ chat: 'open', workspaceId: teamId })}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chat-input')).toBeVisible();
  const selectedAgentLabel = `${(locale === 'de' ? de : en).chat.agentSelectTitle}: ${agent.name}`;
  if (await page.getByTestId('chat-agent-id').getAttribute('aria-label') !== selectedAgentLabel) {
    await page.getByTestId('chat-agent-id').click();
    await page.getByTestId('chat-agent-selector-popover').getByRole('button').filter({ hasText: agent.name }).click();
  }
  await expect(page.getByTestId('chat-agent-id')).toHaveAttribute('aria-label', selectedAgentLabel);
  // The actual selector persists its choice; agentId in a URL alone is not an authority or selector override.
  await expect.poll(async () => {
    const response = await member.context.request.get('/api/user-preferences');
    expect(response.status()).toBe(200); const value = await response.json() as { data: { lastActiveAgentId: string } }; return value.data.lastActiveAgentId;
  }).toBe(agent.agentId);
  await page.goto(`/${locale}/notebook?${new URLSearchParams({ chat: 'open', workspaceId: teamId, session: session.sessionId, agentId: agent.agentId })}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chat-agent-id')).toHaveAttribute('aria-label', selectedAgentLabel); await expect(page.getByTestId('mcp-app-widget')).toBeVisible();
  await expect.poll(() => page.frames().filter(value => /\/__preview\/[A-Za-z0-9_-]{43}\/mcp-app\/document$/u.test(new URL(value.url() || baseUrl).pathname)).length).toBe(1);
  const frame = page.frames().find(value => /\/__preview\/[A-Za-z0-9_-]{43}\/mcp-app\/document$/u.test(new URL(value.url() || baseUrl).pathname));
  expect(frame).toBeDefined(); await expect(frame!.locator('#status')).toHaveText('Ready');
  expect(await frame!.locator('#context').innerText()).toContain(`"theme":"${theme}"`); expect(await frame!.locator('#context').innerText()).toContain(`"locale":"${locale}"`);
  await expect(frame!.locator('#result')).toContainText('"fixture":true'); await expect(frame!.locator('#meta')).toContainText('ui-only-shared-app');
  await expect(frame!.getByAltText('Shared result image')).toBeVisible();
  await expect(page.getByTestId('mcp-app-widget').locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  return { page, frame: frame! };
}

async function readOwnedSharedMcpAppFrameTicket(page: Page): Promise<string> {
  const src = await page.getByTestId('mcp-app-widget').locator('iframe').getAttribute('src'); expect(src).toBeTruthy();
  const url = new URL(src!); expect(url.search + url.hash).toBe('');
  const match = url.pathname.match(/^\/__preview\/([A-Za-z0-9_-]{43})\/mcp-app\/frame$/u); expect(match).not.toBeNull(); return match![1];
}

async function cleanupOwnedSharedMcpAppsFixture(): Promise<void> {
  if (!receipt) return;
  let verified = false;
  try {
    expect(receipt.verifiedCases).toBe(4); expect(receipt.nativeProtocolCases).toHaveLength(7); expect(receipt.outstanding).toBeNull(); expect(receipt.forbiddenRequests).toEqual([]); expect(receipt.unexpectedDialogs).toEqual([]);
    for (const page of pages) if (!page.isClosed()) await page.close();
    for (const owned of sessions) {
      receipt.outstanding = `cleanup:session:${owned.sessionId}`; await persistOwnedSharedMcpAppsReceipt();
      const response = await owned.context.request.delete(`/api/sessions?${new URLSearchParams({ agentId: agent.agentId, sessionId: owned.sessionId })}`);
      expect(response.status()).toBe(200); expect(await response.json()).toEqual({ success: true, deleted: owned.sessionId });
      owned.deleted = true; const entry = receipt.sessions.find(value => value.sessionId === owned.sessionId); expect(entry).toBeDefined(); entry!.deleted = true;
      receipt.outstanding = null; await persistOwnedSharedMcpAppsReceipt();
    }
    for (const context of [admin, ...members.map(value => value.context)]) {
      const response = await context.request.get(`/api/sessions?${new URLSearchParams({ agentId: agent.agentId })}`); expect(response.status()).toBe(200);
      expect((await response.json() as { sessions: unknown[] }).sessions).toEqual([]);
    }
    for (let index = 0; index < connections.length; index++) {
      await mutateOwnedSharedMcpAppsConnection(index, { status: 'archived' });
      const response = await admin.request.get(`/api/integrations/shared-connections/${encodeURIComponent(connections[index].resource.connectionRef)}?workspaceId=${encodeURIComponent(teamId)}`);
      const current = (await readOwnedSharedMcpAppsData<{ connection: IntegrationConnectionDescriptor }>(response)).connection;
      expect(current.resource.status).toBe('archived'); expect(current.resource.createdByUserId).toBe(fixture.actorId);
      receipt.connections[index].archived = true; await persistOwnedSharedMcpAppsReceipt();
    }
    const q = new URLSearchParams({ organizationId, workspaceId: teamId });
    receipt.outstanding = 'cleanup:agent'; await persistOwnedSharedMcpAppsReceipt();
    const preview = await readOwnedSharedMcpAppsData<{ agent: AgentProfile; impacts: { sessions: number }; confirmationToken: string }>(await admin.request.post(`/api/agents/delete-preview?${q}`, { data: { agentId: agent.agentId } }));
    expect(preview.agent).toMatchObject({ agentId: agent.agentId, name: agent.name, createdByUserId: fixture.actorId, removable: true }); expect(preview.impacts.sessions).toBe(0);
    expect(await readOwnedSharedMcpAppsData(await admin.request.delete(`/api/agents?${q}`, { data: { agentId: agent.agentId, expectedRevision: preview.agent.revision, confirmationToken: preview.confirmationToken } }))).toEqual({ deleted: true, agentId: agent.agentId });
    expect((await admin.request.get(`/api/agents?${q}&agentId=${encodeURIComponent(agent.agentId)}`)).status()).toBe(404);
    receipt.outstanding = 'cleanup:catalog'; await persistOwnedSharedMcpAppsReceipt();
    const currentCatalog = (await readOwnedSharedMcpAppsData<{ catalog: AiAppRuntimeCatalog }>(await admin.request.get('/api/admin/agent-runtime/catalog'))).catalog;
    expect(currentCatalog.revision).toBe(ownedCatalogRevision);
    const restored = await readOwnedSharedMcpAppsData<{ catalog: AiAppRuntimeCatalog }>(await admin.request.put('/api/admin/agent-runtime/catalog', { data: { expectedRevision: currentCatalog.revision,
      providers: originalCatalog.providers.map(value => ({ providerInstallationId: value.installationId, providerId: value.providerId, enabled: value.enabled, credentialScope: value.credentialScope,
        config: value.config, modelIds: value.models.filter(model => model.enabled).map(model => model.id), defaultModelId: value.models.find(model => model.isProviderDefault)?.id ?? '' })), defaultSelection: originalCatalog.defaultSelection } }));
    expect(restored.catalog.defaultSelection).toEqual(originalCatalog.defaultSelection); expect(restored.catalog.providers.map(value => value.installationId)).toEqual(originalCatalog.providers.map(value => value.installationId));
    receipt.outstanding = 'cleanup:gateway'; await persistOwnedSharedMcpAppsReceipt();
    expect((await readOwnedSharedMcpAppsData<{ integrationToolGatewayEnabled: boolean }>(await admin.request.patch('/api/admin/experimental-settings', { data: { integrationToolGatewayEnabled: originalFlag } }))).integrationToolGatewayEnabled).toBe(originalFlag);
    expect(await readOwnedSharedMcpAppsData(await admin.request.get('/api/agents?agentId=bradley&includeAccess=true'))).toEqual(originalBradley);
    receipt.outstanding = 'cleanup:workspace'; await persistOwnedSharedMcpAppsReceipt();
    const removed = await admin.request.delete(`/api/workspaces/${encodeURIComponent(teamId)}`); expect(removed.status()).toBe(200); expect(await removed.json()).toEqual({ success: true });
    const listingResponse = await admin.request.get('/api/workspaces'); expect(listingResponse.status()).toBe(200);
    const listing = await listingResponse.json() as ClientWorkspaceResponse;
    if (!Array.isArray(listing.workspaces)) throw new Error('The current workspace inventory is required.');
    expect(listing.workspaces.some(value => value.id === teamId)).toBe(false);
    expect(receipt.processes.length).toBe(3); expect(receipt.processes.every(value => value.closed && value.processGroupId === value.pid)).toBe(true);
    const finalState = await requestOwnedSharedMcpAppsProviderState(); expect(finalState.verificationProbes).toBe(1);
    expect(finalState.calls.filter(value => value.name === 'app_view')).toHaveLength(3); expect(finalState.calls.filter(value => value.name === 'app_action')).toHaveLength(2);
    expect(finalState.calls.filter(value => value.name === 'model_only')).toHaveLength(0); receipt.providerFinal = finalState;
    receipt.outstanding = null; verified = true;
  } catch (error) {
    receipt.phase = 'preserved'; receipt.failure = { name: error instanceof Error ? error.name : 'UnknownError' };
    const site = error instanceof Error ? error.stack?.match(/tests\/shared-mcp-apps-local\.spec\.ts:\d+:\d+/u)?.[0] : undefined;
    if (site) receipt.failure.site = site;
  } finally {
    for (const page of pages) if (!page.isClosed()) await page.close().catch(() => undefined);
    let closed = true;
    for (const context of [...members.map(value => value.context), admin]) if (context) { try { await context.close(); } catch { closed = false; } }
    for (const context of nativeBrowserContexts) { try { await context.close(); } catch { closed = false; } }
    for (const api of nativeApiContexts) { try { await api.dispose(); } catch { closed = false; } }
    if (control) { try { await control.dispose(); } catch { closed = false; } }
    receipt.closedContexts = closed;
    if (verified && closed) receipt.phase = 'verified_closed'; else receipt.phase = 'preserved';
    await persistOwnedSharedMcpAppsReceipt();
  }
  expect(verified && receipt.closedContexts, 'Only acknowledged own cleanup permits the parent to remove its nonce database.').toBe(true);
}

test.beforeAll(async ({ browser }) => {
  fixture = await readOwnedSharedMcpAppsFixture();
  receipt = { version: 1, nonce: fixture.nonce, actorId: fixture.actorId, phase: 'setup', outstanding: null, closedContexts: false,
    membershipIds: [], actorIds: [fixture.actorId], workspaceIds: [], connections: [], sessions: [], processes: [], invocations: [], visualInventory: [], forbiddenRequests: [], unexpectedDialogs: [], verifiedCases: 0 };
  await persistOwnedSharedMcpAppsReceipt();
  control = await request.newContext({ timeout: 15_000 }); // No Canvas cookies are sent to the separate provider control origin.
  admin = await createAuthenticatedContext(browser, { baseURL: baseUrl, viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { Origin: baseUrl } });
  await runManagedTestPreflight(admin, { baseURL: baseUrl });
  const authenticated = await requestManagedTestSession(admin.request); expect(authenticated.status()).toBe(200);
  expect((await authenticated.json() as { user: { id: string; role: string } }).user).toMatchObject({ id: fixture.actorId, role: 'admin' });
  const listingResponse = await admin.request.get('/api/workspaces'); expect(listingResponse.status()).toBe(200);
  const listing = await listingResponse.json() as ClientWorkspaceResponse;
  expect(listing.defaultWorkspace?.type).toBe('personal'); adminWorkspaceId = listing.defaultWorkspace!.id; organizationId = listing.defaultWorkspace!.organizationId!;
  expect(organizationId).toBeTruthy(); originalBradley = await readOwnedSharedMcpAppsData(await admin.request.get('/api/agents?agentId=bradley&includeAccess=true'));
  await createOwnedSharedMcpAppsMember(browser, 0); await createOwnedSharedMcpAppsMember(browser, 1); expect(members[0].userId).not.toBe(members[1].userId);
  receipt.outstanding = 'workspace:create'; await persistOwnedSharedMcpAppsReceipt();
  const teamResponse = await admin.request.post('/api/workspaces', { data: { type: 'team', name: `MCP Apps ${fixture.nonce}` } }); expect(teamResponse.status()).toBe(201);
  const team = await teamResponse.json() as { success: boolean; workspace: { id: string; type: string; organizationId: string } };
  expect(team.success).toBe(true);
  if (typeof team.workspace?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(team.workspace.id)) throw new Error('The acknowledged team identity is required.');
  teamId = team.workspace.id; receipt.workspaceIds.push(teamId); await persistOwnedSharedMcpAppsReceipt();
  expect(team.workspace).toMatchObject({ type: 'team', organizationId });
  for (const member of members) {
    const joined = await admin.request.post(`/api/workspaces/${encodeURIComponent(teamId)}/members`, { data: { userId: member.userId, role: 'member', canRead: true, canWrite: false, canManage: false } });
    expect(joined.status()).toBe(200); expect((await joined.json() as { success: boolean }).success).toBe(true);
  }
  receipt.outstanding = null; await persistOwnedSharedMcpAppsReceipt();
  for (const ownership of [{ type: 'organization' as const }, { type: 'team' as const, workspaceId: teamId }]) {
    receipt.outstanding = `connection:create:${ownership.type}`; await persistOwnedSharedMcpAppsReceipt();
    const connection = (await readOwnedSharedMcpAppsData<{ connection: IntegrationConnectionDescriptor }>(await admin.request.post(`/api/integrations/shared-connections?workspaceId=${encodeURIComponent(ownership.type === 'team' ? teamId : adminWorkspaceId)}`, { data: {
      source: 'mcp', ownership, displayName: `Design ${fixture.nonce}`, accessMode: 'restricted', allowedToolNames: tools,
      config: { url: process.env.CANVAS_SHARED_MCP_APPS_URL, auth: 'none' }, secrets: [], grants: [
        { targetType: 'user', targetId: fixture.actorId, canUse: false, canManage: true, allowedToolNames: tools },
        ...members.map(value => ({ targetType: 'user', targetId: value.userId, canUse: true, canManage: false, allowedToolNames: tools })),
      ],
    } }))).connection;
    if (typeof connection.resource?.connectionRef !== 'string' || !/^canvas-connection:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(connection.resource.connectionRef)) throw new Error('The acknowledged connection identity is required.');
    connections.push(connection); receipt.connections.push({ connectionRef: connection.resource.connectionRef, ownership: ownership.type, archived: false }); await persistOwnedSharedMcpAppsReceipt();
    expect(connection.resource).toMatchObject({ createdByUserId: fixture.actorId, displayName: `Design ${fixture.nonce}`, source: 'mcp', status: 'active', metadataRevision: 1, grantsRevision: 1, bindingRevision: 2 });
    expect(connection.resource.ownership.type).toBe(ownership.type); receipt.outstanding = null; await persistOwnedSharedMcpAppsReceipt();
  }
  expect(connections[0].resource.connectionRef).not.toBe(connections[1].resource.connectionRef);
  receipt.outstanding = 'agent:create'; await persistOwnedSharedMcpAppsReceipt();
  agent = (await readOwnedSharedMcpAppsData<{ agent: AgentProfile }>(await admin.request.post(`/api/agents?${new URLSearchParams({ organizationId, workspaceId: teamId })}`, { data: {
    name: `Shared MCP Apps ${fixture.nonce}`, scopeType: 'organization', enabledTools: ['mcp'], relevantSkills: [], relevantConnections: [],
    grants: members.map(value => ({ targetType: 'user', targetId: value.userId, canUse: true, canEdit: false, canManage: false })),
  } }))).agent;
  if (typeof agent?.agentId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agent.agentId)) throw new Error('The acknowledged agent identity is required.');
  receipt.agentId = agent.agentId; await persistOwnedSharedMcpAppsReceipt();
  expect(agent).toMatchObject({ scopeType: 'organization', createdByUserId: fixture.actorId, enabledTools: ['mcp'], removable: true }); receipt.outstanding = null; await persistOwnedSharedMcpAppsReceipt();
  originalFlag = (await readOwnedSharedMcpAppsData<{ integrationToolGatewayEnabled: boolean }>(await admin.request.get('/api/admin/experimental-settings'))).integrationToolGatewayEnabled;
  receipt.outstanding = 'gateway:enable'; await persistOwnedSharedMcpAppsReceipt();
  expect((await readOwnedSharedMcpAppsData<{ integrationToolGatewayEnabled: boolean }>(await admin.request.patch('/api/admin/experimental-settings', { data: { integrationToolGatewayEnabled: true } }))).integrationToolGatewayEnabled).toBe(true);
  originalCatalog = (await readOwnedSharedMcpAppsData<{ catalog: AiAppRuntimeCatalog }>(await admin.request.get('/api/admin/agent-runtime/catalog'))).catalog;
  receipt.outstanding = 'catalog:fixture'; await persistOwnedSharedMcpAppsReceipt();
  const configured = await readOwnedSharedMcpAppsData<{ catalog: AiAppRuntimeCatalog }>(await admin.request.put('/api/admin/agent-runtime/catalog', { data: {
    expectedRevision: originalCatalog.revision, providers: [{ providerId: 'ollama', enabled: true, credentialScope: 'system', modelIds: ['shared-apps-fixture'], defaultModelId: 'shared-apps-fixture',
      config: { ollamaMode: 'local', ollamaHost: new URL(process.env.CANVAS_SHARED_MCP_APPS_URL!).origin, ollamaModelSource: 'custom', ollamaCustomModel: 'shared-apps-fixture' } }], defaultSelection: null,
  } }));
  expect(configured.catalog.providers).toHaveLength(1); const installation = configured.catalog.providers[0];
  const verified = await readOwnedSharedMcpAppsData<{ success: boolean; status: string; catalogRevision: number }>(await admin.request.post(`/api/admin/agent-runtime/providers/${encodeURIComponent(installation.installationId)}/verify`));
  expect(verified.success).toBe(true); expect(verified.status).toBe('ready');
  const readyCatalog = (await readOwnedSharedMcpAppsData<{ catalog: AiAppRuntimeCatalog }>(await admin.request.get('/api/admin/agent-runtime/catalog'))).catalog;
  const selected = await readOwnedSharedMcpAppsData<{ catalog: AiAppRuntimeCatalog }>(await admin.request.put('/api/admin/agent-runtime/catalog', { data: {
    expectedRevision: readyCatalog.revision, providers: [{ providerInstallationId: installation.installationId, providerId: 'ollama', enabled: true, credentialScope: 'system', modelIds: ['shared-apps-fixture'], defaultModelId: 'shared-apps-fixture', config: installation.config }],
    defaultSelection: { providerInstallationId: installation.installationId, providerId: 'ollama', modelId: 'shared-apps-fixture', thinkingLevel: 'off' },
  } }));
  expect(selected.catalog.providers[0].status).toBe('ready'); ownedCatalogRevision = selected.catalog.revision;
  expect((await requestOwnedSharedMcpAppsProviderState()).verificationProbes).toBe(1);
  receipt.outstanding = null; receipt.phase = 'ready'; await persistOwnedSharedMcpAppsReceipt();
});

test.afterAll(async () => { await cleanupOwnedSharedMcpAppsFixture(); });

test('organization widget uses real saved output, approval, opaque isolation and a new ticket after reload', async () => {
  const session = await createOwnedSharedMcpAppsSession(members[0]); const invocation = await seedOwnedSharedMcpAppInvocation(session, connections[0]); invocations.push(invocation);
  const { page, frame } = await openOwnedSharedMcpAppWidget(members[0], session);
  const originalTicket = await readOwnedSharedMcpAppFrameTicket(page); frameTickets.push(originalTicket);
  const before = await requestOwnedSharedMcpAppsProviderState(); expect(before.calls.filter(value => value.name === 'app_action')).toHaveLength(0);
  await frame.locator('#action').click(); await expect(page.getByRole('group', { name: en.chat.mcpApp.requestApproval.replace('{tool}', 'app_action') })).toBeVisible();
  await page.getByRole('button', { name: en.chat.mcpApp.allow, exact: true }).click(); await expect(frame.locator('#status')).toHaveText('Approved');
  expect((await requestOwnedSharedMcpAppsProviderState()).calls.filter(value => value.name === 'app_action')).toHaveLength(1);
  await frame.locator('#action').click(); await page.getByRole('button', { name: en.chat.mcpApp.reject, exact: true }).click(); await expect(frame.locator('#status')).toHaveText('Rejected');
  expect((await requestOwnedSharedMcpAppsProviderState()).calls.filter(value => value.name === 'app_action')).toHaveLength(1);
  await frame.locator('#isolation').click(); await expect(frame.locator('#sandbox')).toHaveText(JSON.stringify({ parentBlocked: true, storageBlocked: true, networkBlocked: true }));
  const screenshot = 'mcp-apps-organization-1280-light.png'; await page.screenshot({ path: path.join(fixture.fixtureRoot, screenshot), scale: 'css' }); receipt.visualInventory.push(screenshot);
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.getByTestId('mcp-app-widget')).toBeVisible();
  await expect.poll(async () => { const ticket = await readOwnedSharedMcpAppFrameTicket(page); return ticket !== originalTicket; }).toBe(true);
  await expect.poll(() => page.frames().some(value => value.url().endsWith('/mcp-app/document'))).toBe(true);
  const reloaded = page.frames().find(value => value.url().endsWith('/mcp-app/document')); expect(reloaded).toBeDefined(); await expect(reloaded!.locator('#status')).toHaveText('Ready');
  const messagesResponse = await members[0].context.request.get(`/api/sessions/messages?${new URLSearchParams({ agentId: agent.agentId, sessionId: session.sessionId, workspaceId: teamId, raw: 'true' })}`);
  expect(messagesResponse.status()).toBe(200); const messages = await messagesResponse.text(); expect(messages).toContain(invocation.descriptor.toolCallId); expect(messages).not.toContain('mcpAppAuthority');
  await page.close(); receipt.verifiedCases++; await persistOwnedSharedMcpAppsReceipt();
});

test('two users open the same team instance; cross-session and model-only calls are denied, with mobile-sized DE dark UI', async () => {
  const sessionA = await createOwnedSharedMcpAppsSession(members[0]), sessionB = await createOwnedSharedMcpAppsSession(members[1]);
  const appA = await seedOwnedSharedMcpAppInvocation(sessionA, connections[1]), appB = await seedOwnedSharedMcpAppInvocation(sessionB, connections[1]); invocations.push(appA, appB);
  expect(appA.descriptor.connectionRef).toBe(appB.descriptor.connectionRef); expect(appA.descriptor.toolCallId).not.toBe(appB.descriptor.toolCallId);
  const openedA = await openOwnedSharedMcpAppWidget(members[0], sessionA, 'en', 'light', 375), openedB = await openOwnedSharedMcpAppWidget(members[1], sessionB, 'de', 'dark', 375);
  const ticketA = await readOwnedSharedMcpAppFrameTicket(openedA.page), ticketB = await readOwnedSharedMcpAppFrameTicket(openedB.page); frameTickets.push(ticketA, ticketB); expect(ticketA).not.toBe(ticketB);
  const before = await requestOwnedSharedMcpAppsProviderState();
  const forged = await members[1].context.request.post('/api/mcp/apps', { data: { action: 'render', app: appA.descriptor, agentId: agent.agentId, sessionId: sessionA.sessionId } });
  expect([403, 404]).toContain(forged.status()); expect((await forged.json() as { success: boolean }).success).toBe(false);
  const crossTicket = await members[1].context.request.post('/api/mcp/apps', { data: { action: 'call', app: appB.descriptor, agentId: agent.agentId, sessionId: sessionB.sessionId, ticket: ticketA, tool: 'app_action', arguments: { value: 'forged' } } });
  expect(crossTicket.status()).toBe(403);
  const modelOnly = await members[1].context.request.post('/api/mcp/apps', { data: { action: 'call', app: appB.descriptor, agentId: agent.agentId, sessionId: sessionB.sessionId, ticket: ticketB, tool: 'model_only', arguments: {} } });
  expect([403, 404]).toContain(modelOnly.status());
  const after = await requestOwnedSharedMcpAppsProviderState(); expect(after.calls).toEqual(before.calls);
  await openedB.frame.locator('#action').click(); await openedB.page.getByRole('button', { name: de.chat.mcpApp.reject, exact: true }).click(); await expect(openedB.frame.locator('#status')).toHaveText('Rejected');
  expect((await requestOwnedSharedMcpAppsProviderState()).calls).toEqual(before.calls);
  await openedB.frame.locator('#isolation').click(); await expect(openedB.frame.locator('#sandbox')).toHaveText(JSON.stringify({ parentBlocked: true, storageBlocked: true, networkBlocked: true }));
  const lightScreenshot = 'mcp-apps-team-375-light-en.png'; await openedA.page.screenshot({ path: path.join(fixture.fixtureRoot, lightScreenshot), scale: 'css' }); receipt.visualInventory.push(lightScreenshot);
  const screenshot = 'mcp-apps-team-375-dark-de.png'; await openedB.page.screenshot({ path: path.join(fixture.fixtureRoot, screenshot), scale: 'css' }); receipt.visualInventory.push(screenshot);
  await openedA.page.close(); await openedB.page.close(); receipt.verifiedCases++; await persistOwnedSharedMcpAppsReceipt();
});

test('native bearer contracts retain both exact scopes and shared saved authority through one-shot AppBridge calls', async ({ browser }) => {
  const headers = { 'X-Canvas-Workspace-Id': teamId };
  receipt.nativeProtocolCases = []; receipt.nativeBridgeTransportSeam = true; receipt.nativeDevice = false;
  const unauthenticated = await control.get(`${baseUrl}/api/mobile/v1/integrations/shared-connections`, { headers });
  expect(unauthenticated.status()).toBe(401);
  for (const [index, member] of members.entries()) {
    const identity = await createOwnedSharedMcpAppsBearer(member.email, member.password); expect(identity.userId).toBe(member.userId);
    const bootstrapResponse = await identity.api.get('/api/mobile/v1/bootstrap'); expect(bootstrapResponse.status()).toBe(200);
    const bootstrap = await bootstrapResponse.json() as { mobileApi: { capabilities: string[] } };
    expect(bootstrap.mobileApi.capabilities).toEqual(expect.arrayContaining(['chat.mcp_apps.v1', 'chat.mcp_apps.v2', 'extensions.resources.v2', 'integrations.shared_connections.v2', 'agents.workflow.v2']));
    const listed = await readOwnedSharedNativeData<{ connections: IntegrationConnectionDescriptor[] }>(await identity.api.get('/api/mobile/v1/integrations/shared-connections', { headers }));
    expect(listed.connections).toHaveLength(2); expect(new Set(listed.connections.map(value => value.resource.displayName)).size).toBe(1);
    expect(new Set(listed.connections.map(value => value.resource.connectionRef))).toEqual(new Set(connections.map(value => value.resource.connectionRef)));
    for (const expected of connections) {
      const detail = await readOwnedSharedNativeData<{ connection: IntegrationConnectionDescriptor }>(await identity.api.get(`/api/mobile/v1/integrations/shared-connections/${encodeURIComponent(expected.resource.connectionRef)}`, { headers }));
      expect(detail.connection.resource.connectionRef).toBe(expected.resource.connectionRef); expect(detail.connection.resource.ownership).toEqual(expected.resource.ownership);
      expect(detail.connection.access).toMatchObject({ canRead: true, canUse: true, canManage: false }); expect(detail.connection.grants).toBeUndefined();
      for (const key of ['backend', 'config', 'secrets', 'connectedAccountId', 'profileId', 'connectionId']) expect(Object.hasOwn(detail.connection, key)).toBe(false);
    }
    const resources = await readOwnedSharedNativeData<{ resources: unknown[] }>(await identity.api.get('/api/mobile/v1/capabilities/resources', { headers })); expect(Array.isArray(resources.resources)).toBe(true);
    const workflow = await readOwnedSharedNativeData<{ workflow: { access: { canUse: boolean; canEdit: boolean; canManage: boolean } } }>(await identity.api.get(`/api/mobile/v1/agents/${agent.agentId}/workflow`, { headers }));
    expect(workflow.workflow.access).toEqual({ canUse: true, canEdit: false, canManage: false });
    expect((await identity.api.get(`/api/mobile/v1/agents/${agent.agentId}/configuration-sources`, { headers })).status()).toBe(403);
    expect((await identity.api.get('/api/mobile/v1/integrations/shared-connections?unknown=value', { headers })).status()).toBe(400);
    const session = sessions[index + 1], invocation = invocations[index + 1]; expect(session.actorUserId).toBe(identity.userId);
    const response = await identity.api.post(`/api/mobile/v1/sessions/${session.sessionId}/mcp-apps/render`, { headers,
      data: { contractVersion: 1, toolCallId: invocation.descriptor.toolCallId, app: invocation.descriptor } });
    expect(response.status()).toBe(200); const render = await response.json() as NativeRender;
    expect(render).toMatchObject({ success: true, contractVersion: 1, sessionId: session.sessionId, workspaceId: teamId, toolCallId: invocation.descriptor.toolCallId });
    expect(new URL(render.host.url).pathname).toMatch(/^\/__preview\/[A-Za-z0-9_-]{43}\/mobile-mcp\/host$/u);
    expect(render.host.channelId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u); expect(render.host.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    nativeHandles.push({ ...identity, session, invocation, render }); expect((await identity.api.storageState()).cookies).toEqual([]);
  }
  receipt.nativeProtocolCases.push('real-bearer-and-no-auth-denial', 'same-name-exact-org-team-reader-dtos', 'use-only-workflow-management-denied');
  const handle = nativeHandles[0], other = nativeHandles[1], source = { toolCallId: handle.invocation.descriptor.toolCallId, app: handle.invocation.descriptor };
  const base = `/api/mobile/v1/sessions/${handle.session.sessionId}/mcp-apps`;
  expect((await other.api.post(`${base}/render`, { headers, data: { contractVersion: 1, ...source } })).status()).toBe(404);
  const forged = await handle.api.post(`${base}/render`, { headers, data: { contractVersion: 1, ...source,
    app: { ...source.app, connectionRef: connections[0].resource.connectionRef } } }); expect([403, 409]).toContain(forged.status());
  const context = await browser.newContext({ baseURL: baseUrl, storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });
  nativeBrowserContexts.push(context); const page = await context.newPage(); pages.push(page);
  page.on('dialog', dialog => { receipt.unexpectedDialogs.push(dialog.type()); void dialog.dismiss(); });
  page.on('request', incoming => {
    if (incoming.headers().authorization || incoming.headers().cookie || incoming.method() !== 'GET'
      || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(incoming.url()).hostname)) receipt.forbiddenRequests.push(`${incoming.method()} ${new URL(incoming.url()).pathname}`);
  });
  await page.addInitScript(hostUrl => {
    if (window !== window.top || location.href !== hostUrl) return;
    const native = window as unknown as { __nativeMessages: string[]; ReactNativeWebView: { postMessage(message: string): void } };
    native.__nativeMessages = []; native.ReactNativeWebView = { postMessage(raw) { if (typeof raw === 'string' && new TextEncoder().encode(raw).byteLength <= 65536) native.__nativeMessages.push(raw); } };
  }, handle.render.host.url);
  expect((await page.goto(handle.render.host.url, { waitUntil: 'domcontentloaded' }))?.status()).toBe(200);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __nativeMessages: string[] }).__nativeMessages.some(raw => JSON.parse(raw).type === 'host_ready'))).toBe(true);
  const send = async (type: string, payload: Record<string, unknown>) => page.evaluate(raw => window.dispatchEvent(new MessageEvent('message', { data: raw, origin: location.origin, source: window })),
    JSON.stringify({ version: 1, channelId: handle.render.host.channelId, nonce: handle.render.host.nonce, type, payload }));
  await send('host_context', { context: { theme: 'dark', locale: 'de', containerDimensions: { width: 390, maxHeight: 640 } } });
  await expect.poll(() => page.frames().some(frame => new URL(frame.url() || baseUrl).pathname.endsWith('/mobile-mcp/document'))).toBe(true);
  const document = page.frames().find(frame => new URL(frame.url() || baseUrl).pathname.endsWith('/mobile-mcp/document'))!;
  await expect(document.locator('#status')).toHaveText('Ready'); await expect(document.locator('#context')).toHaveText('{"theme":"dark","locale":"de"}');
  await expect(document.locator('#result')).toHaveText(JSON.stringify((handle.invocation.result as { structuredContent: unknown }).structuredContent));
  await document.locator('#isolation').click(); await expect(document.locator('#sandbox')).toHaveText('{"parentBlocked":true,"storageBlocked":true,"networkBlocked":true}');
  expect(await document.evaluate(() => typeof (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView)).toBe('undefined');
  const before = await requestOwnedSharedMcpAppsProviderState();
  await document.locator('#action').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __nativeMessages: string[] }).__nativeMessages.some(raw => JSON.parse(raw).type === 'tool_call'))).toBe(true);
  const event = await page.evaluate(() => (window as unknown as { __nativeMessages: string[] }).__nativeMessages.map(raw => JSON.parse(raw)).find(value => value.type === 'tool_call')) as { channelId: string; nonce: string; payload: { requestId: string; tool: string; arguments: Record<string, unknown> } };
  expect(event).toMatchObject({ channelId: handle.render.host.channelId, nonce: handle.render.host.nonce, payload: { tool: 'app_action', arguments: { value: 'from-widget' } } });
  const prepare = { contractVersion: 1, ...source, hostChannelId: handle.render.host.channelId, ...event.payload };
  const modelOnly = await handle.api.post(`${base}/calls`, { headers, data: { ...prepare, requestId: randomUUID(), tool: 'model_only' } }); expect([403, 409]).toContain(modelOnly.status());
  const preparedResponse = await handle.api.post(`${base}/calls`, { headers, data: prepare }); expect(preparedResponse.status()).toBe(200); const prepared = await preparedResponse.json() as NativeCall;
  expect(prepared.call).toMatchObject({ status: 'prepared', app: source.app }); expect(prepared.approval).toMatchObject({ tool: 'app_action', arguments: { value: 'from-widget' } });
  expect((await requestOwnedSharedMcpAppsProviderState()).calls).toEqual(before.calls);
  const decide = { contractVersion: 1, decision: 'approve', approvalToken: prepared.approval!.token };
  const approvedResponse = await handle.api.post(`${base}/calls/${prepared.call!.callId}`, { headers, data: decide }); expect(approvedResponse.status()).toBe(200); const approved = await approvedResponse.json() as NativeCall;
  expect(approved.call?.status).toBe('completed');
  await send('tool_result', { requestId: event.payload.requestId, result: approved.call!.result }); await expect(document.locator('#status')).toHaveText('Approved');
  const repeatResponse = await handle.api.post(`${base}/calls/${prepared.call!.callId}`, { headers, data: decide }); expect(repeatResponse.status()).toBe(200); expect((await repeatResponse.json() as NativeCall).call?.status).toBe('completed');
  const recovered = await handle.api.get(`${base}/calls/${prepared.call!.callId}`, { headers }); expect(recovered.status()).toBe(200); expect((await recovered.json() as NativeCall).call?.status).toBe('completed');
  expect((await requestOwnedSharedMcpAppsProviderState()).calls.filter(value => value.name === 'app_action')).toHaveLength(2);
  const screenshot = 'mcp-apps-native-shared-390-dark.png'; await page.screenshot({ path: path.join(fixture.fixtureRoot, screenshot), scale: 'css' }); receipt.visualInventory.push(screenshot);
  await send('teardown', {}); await expect(page.locator('iframe')).toHaveCount(0);
  expect((await context.cookies()).length).toBe(0); await page.close();
  receipt.nativeProtocolCases.push('saved-shared-v2-two-actors-and-no-fallback', 'native-host-sdk-opaque-provider', 'native-prepare-approval-and-no-replay');
  receipt.verifiedCases++; await persistOwnedSharedMcpAppsReceipt();
});

test('a replacement auth session invalidates its ticket; Manage-only and revoked Use cannot render, call or deliver an old document', async () => {
  const session = sessions[2], app = invocations[2]; expect(session.actorUserId).toBe(members[1].userId);
  const ticket = frameTickets[2], before = await requestOwnedSharedMcpAppsProviderState();
  const originalIdentityResponse = await requestManagedTestSession(members[1].context.request); expect(originalIdentityResponse.status()).toBe(200);
  const originalIdentity = await originalIdentityResponse.json() as { session: { id: string }; user: { id: string } };
  expect(originalIdentity.user.id).toBe(members[1].userId); expect(typeof originalIdentity.session.id === 'string' && originalIdentity.session.id.length > 0).toBe(true);
  const signedOut = await members[1].context.request.post('/api/auth/sign-out', { data: {} }); expect(signedOut.status()).toBe(200);
  // Re-authenticate the existing context through the normal endpoint; no cookie or Session-row mutation is used.
  const deadline = Date.now() + 45_000;
  for (let retries = 0; ; retries++) {
    const signedIn = await members[1].context.request.post('/api/auth/sign-in/email', { data: { email: members[1].email, password: members[1].password } });
    if (signedIn.status() !== 429) { expect(signedIn.status()).toBe(200); break; }
    if (retries >= 2) throw new Error('The original fixture identity could not be restored within its bounded authentication retries.');
    await waitForAuthRetry(signedIn, deadline, 'Owned MCP Apps session replacement', retries);
  }
  const replacementIdentityResponse = await requestManagedTestSession(members[1].context.request); expect(replacementIdentityResponse.status()).toBe(200);
  const replacementIdentity = await replacementIdentityResponse.json() as { session: { id: string }; user: { id: string } };
  expect(replacementIdentity.user.id).toBe(members[1].userId); expect(typeof replacementIdentity.session.id === 'string' && replacementIdentity.session.id.length > 0 && replacementIdentity.session.id !== originalIdentity.session.id).toBe(true);
  const oldTicket = await members[1].context.request.post('/api/mcp/apps', { data: { action: 'call', app: app.descriptor, sessionId: session.sessionId, agentId: agent.agentId,
    ticket, tool: 'app_action', arguments: { value: 'old-session' } } }); expect(oldTicket.status()).toBe(403);
  const freshRender = await readOwnedSharedMcpAppsData<{ frameUrl: string }>(await members[1].context.request.post('/api/mcp/apps', { data: { action: 'render', app: app.descriptor, sessionId: session.sessionId, agentId: agent.agentId } }));
  const match = new URL(freshRender.frameUrl).pathname.match(/^\/__preview\/([A-Za-z0-9_-]{43})\/mcp-app\/frame$/u); expect(match).not.toBeNull(); const freshTicket = match![1];
  const initialGrants = connections[1].grants;
  if (!initialGrants) throw new Error('The manager grant descriptor is required.');
  await mutateOwnedSharedMcpAppsConnection(1, { grants: initialGrants.map(value => ({ targetType: value.targetType, targetId: value.targetId,
    canUse: value.targetId === members[1].userId ? false : value.canUse, canManage: value.targetId === members[1].userId ? true : value.canManage, allowedToolNames: value.allowedToolNames })) });
  const managerDescriptor = (await readOwnedSharedMcpAppsData<{ connection: IntegrationConnectionDescriptor }>(await members[1].context.request.get(`/api/integrations/shared-connections/${encodeURIComponent(connections[1].resource.connectionRef)}?workspaceId=${encodeURIComponent(teamId)}`))).connection;
  expect(managerDescriptor.access).toEqual({ canRead: true, canUse: false, canManage: true });
  const beforeManage = await requestOwnedSharedMcpAppsProviderState();
  const native = nativeHandles[1], nativeHeaders = { 'X-Canvas-Workspace-Id': teamId };
  expect(native.userId).toBe(members[1].userId);
  const nativeManager = await readOwnedSharedNativeData<{ connection: IntegrationConnectionDescriptor }>(await native.api.get(`/api/mobile/v1/integrations/shared-connections/${encodeURIComponent(connections[1].resource.connectionRef)}`, { headers: nativeHeaders }));
  expect(nativeManager.connection.access).toMatchObject({ canRead: true, canUse: false, canManage: true });
  const nativeDenied = await native.api.post(`/api/mobile/v1/sessions/${native.session.sessionId}/mcp-apps/render`, { headers: nativeHeaders,
    data: { contractVersion: 1, toolCallId: native.invocation.descriptor.toolCallId, app: native.invocation.descriptor } });
  expect([403, 404, 409]).toContain(nativeDenied.status());
  expect((await control.get(native.render.host.url)).status()).toBe(404);
  const manageOnly = await members[1].context.request.post('/api/mcp/apps', { data: { action: 'render', app: app.descriptor, sessionId: session.sessionId, agentId: agent.agentId } });
  expect([403, 404]).toContain(manageOnly.status()); const afterManage = await requestOwnedSharedMcpAppsProviderState();
  expect(afterManage.requests).toEqual(beforeManage.requests); expect(afterManage.resourceReads).toEqual(beforeManage.resourceReads);
  const grants = connections[1].grants;
  if (!grants) throw new Error('The current manager grant descriptor is required.');
  await mutateOwnedSharedMcpAppsConnection(1, { grants: grants.filter(value => value.targetId !== members[1].userId).map(value => ({ targetType: value.targetType, targetId: value.targetId, canUse: value.canUse, canManage: value.canManage, allowedToolNames: value.allowedToolNames })) });
  const deniedRender = await members[1].context.request.post('/api/mcp/apps', { data: { action: 'render', app: app.descriptor, sessionId: session.sessionId, agentId: agent.agentId } }); expect([403, 404]).toContain(deniedRender.status());
  const deniedCall = await members[1].context.request.post('/api/mcp/apps', { data: { action: 'call', app: app.descriptor, sessionId: session.sessionId, agentId: agent.agentId,
    ticket: freshTicket, tool: 'app_action', arguments: { value: 'revoked' } } }); expect([401, 403, 404]).toContain(deniedCall.status());
  const document = await members[1].context.request.get(`${baseUrl}/__preview/${freshTicket}/mcp-app/document`); expect(document.status()).toBe(404);
  expect(await document.text()).toBe('');
  const after = await requestOwnedSharedMcpAppsProviderState(); expect(after.calls).toEqual(before.calls); expect(after.resourceReads).toEqual(afterManage.resourceReads);
  expect((await native.api.get(`/api/mobile/v1/integrations/shared-connections/${encodeURIComponent(connections[1].resource.connectionRef)}`, { headers: nativeHeaders })).status()).toBe(404);
  const remainingNativeOrg = await readOwnedSharedNativeData<{ connection: IntegrationConnectionDescriptor }>(await native.api.get(`/api/mobile/v1/integrations/shared-connections/${encodeURIComponent(connections[0].resource.connectionRef)}`, { headers: nativeHeaders }));
  expect(remainingNativeOrg.connection.resource.connectionRef).toBe(connections[0].resource.connectionRef);
  for (const handle of nativeHandles) expect((await handle.api.storageState()).cookies).toEqual([]);
  receipt.nativeProtocolCases!.push('native-manage-only-and-revocation-no-same-name-fallback');
  // Same display names in Org and Team never become a fallback for the revoked exact resourceRef.
  const readableOrg = await members[1].context.request.get(`/api/integrations/shared-connections/${encodeURIComponent(connections[0].resource.connectionRef)}?workspaceId=${encodeURIComponent(teamId)}`); expect(readableOrg.status()).toBe(200);
  receipt.verifiedCases++; await persistOwnedSharedMcpAppsReceipt();
});
