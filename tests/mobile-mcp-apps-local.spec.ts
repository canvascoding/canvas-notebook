import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, request, type APIRequestContext, type APIResponse, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { waitForAuthRetry } from './helpers/managed-test-context';
import type { AgentProfile } from '../app/lib/agents/registry';
import type { AiAppRuntimeCatalog } from '../app/lib/agent-runtime-policy/types';
import type { McpConfig } from '../app/lib/mcp/config';
import type { McpAppDescriptor } from '../app/lib/mcp/apps-types';

type Fixture = { version: 1; nonce: string; actorId: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; rootDevice: string; rootInode: string; databaseName: string; databaseOwner: string;
  createAcknowledged: boolean; listenerVerified: boolean; phase: string; uncertain: boolean; serverPid: number;
  directoryProofs: Record<string, { device: string; inode: string }> };
type ProviderState = { requests: string[]; calls: Array<{ name: string }>; resourceReads: string[]; verificationProbes: number };
type Identity = { api: APIRequestContext; webApi: APIRequestContext; userId: string; authSessionId: string };
type Source = { toolCallId: string; app: McpAppDescriptor };
type Invocation = { descriptor: McpAppDescriptor; input: Record<string, unknown>; result: unknown; messageId: number; sequence: number };
type Host = { url: string; origin: string; frameOrigin: string; channelId: string; nonce: string; expiresAt: number };
type Render = { success: true; contractVersion: 1; sessionId: string; workspaceId: string; toolCallId: string; checkedAt: number; authVersion: number; host: Host };
type Call = { success: true; contractVersion: 1; sessionId: string; workspaceId: string; checkedAt: number;
  call: null | { callId: string; requestId: string; status: string; requestDigest: string; app: McpAppDescriptor; result?: unknown };
  approval: null | { token: string; tool: string; arguments: Record<string, unknown>; expiresAt: number } };
type NativeEnvelope = { version: 1; channelId: string; nonce: string; type: string; payload: Record<string, unknown> };
type Receipt = { version: 1; nonce: string; actorId: string; phase: string; outstanding: string | null; closedContexts: boolean;
  membershipIds: string[]; actorIds: string[]; workspaceIds: string[]; agentId?: string;
  personalConnectionId?: string; personalConfigRestored: boolean; gatewayRestored: boolean; catalogRestored: boolean;
  sessions: Array<{ sessionId: string; actorUserId: string; deleted: boolean }>;
  processes: Array<{ pid: number; processGroupId: number; closed: boolean }>;
  invocations: Array<{ sessionId: string; toolCallId: string; connectionId: string }>;
  nativeBridgeTransportSeam: true; nativeDevice: false; verifiedCases: number; protocolCases: string[];
  forbiddenRequests: string[]; unexpectedDialogs: string[]; providerFinal?: ProviderState; failure?: { name: string; site?: string } };
const baseUrl = 'http://127.0.0.1:3001';
const resourceUri = 'ui://shared-app-fixture/design.html';
let fixture: Fixture, receipt: Receipt, admin: Identity, secondAdmin: Identity, member: Identity, control: APIRequestContext;
let organizationId = '', workspaceId = '', connectionId = '', serverName = '';
let agent: AgentProfile, originalMcp: McpConfig, installedMcp: McpConfig, originalCatalog: AiAppRuntimeCatalog, originalFlag = false;
let ownedCatalogRevision = 0, originalBradley: unknown, source: Source, invocation: Invocation, render: Render, page: Page, document: Frame;
let writeReceipt = Promise.resolve();
const apiContexts: APIRequestContext[] = [], browserContexts: BrowserContext[] = [];
test.describe.configure({ mode: 'serial' });
test.use({ trace: 'off', video: 'off' });

async function data<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status()).toBe(status);
  const value = await response.json() as { success?: boolean; data?: T };
  expect(value.success).toBe(true); expect(Boolean(value.data && typeof value.data === 'object')).toBe(true);
  return value.data!;
}
async function persist(): Promise<void> {
  const snapshot = JSON.stringify(receipt);
  writeReceipt = writeReceipt.then(async () => {
    const file = path.join(fixture.fixtureRoot, 'browser-receipt.json.tmp');
    await fs.writeFile(file, snapshot, { mode: 0o600 });
    await fs.rename(file, path.join(fixture.fixtureRoot, 'browser-receipt.json'));
  });
  await writeReceipt;
}
async function readOwnedMobileMcpFixture(): Promise<Fixture> {
  for (const flag of ['CANVAS_AGENT_SETTINGS_BROWSER_RUN', 'CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN', 'CANVAS_MOBILE_MCP_APPS_BROWSER_RUN', 'E2E_EXTERNAL_SERVER']) expect(process.env[flag]).toBe('1');
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
  expect(value.databaseOwner).toBeTruthy(); expect(value.actorId).toBeTruthy(); expect(value.serverPid).toBeGreaterThan(0); process.kill(value.serverPid, 0);
  expect(await fs.realpath(process.cwd())).toBe(value.repo); expect(await fs.realpath(root)).toBe(root);
  expect([String(rootStat.dev), String(rootStat.ino)]).toEqual([value.rootDevice, value.rootInode]);
  const marker = await fs.open(path.join(root, '.fixture-owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await marker.stat(); expect(stat.isFile() && stat.nlink === 1 && stat.uid === rootStat.uid && (stat.mode & 0o777) === 0o600).toBe(true); expect(await marker.readFile('utf8')).toBe(value.ownerMarker); }
  finally { await marker.close(); }
  for (const [directory, name] of [[value.dataRoot, 'data'], [value.tmpRoot, 'tmp']]) {
    expect(directory).toBe(path.join(root, name)); const stat = await fs.lstat(directory);
    expect(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === rootStat.uid && (stat.mode & 0o777) === 0o700).toBe(true);
    expect(await fs.realpath(directory)).toBe(directory); expect({ device: String(stat.dev), inode: String(stat.ino) }).toEqual(value.directoryProofs[directory]);
  }
  expect(process.env.DATA).toBe(value.dataRoot); expect(process.env.CANVAS_DATA_ROOT).toBe(value.dataRoot); expect(process.env.TMPDIR).toBe(value.tmpRoot);
  expect(process.env.CANVAS_APP_ROOT).toBe(value.repo); expect(process.env.CANVAS_DATABASE_PROVIDER).toBe('postgres');
  const database = new URL(process.env.DATABASE_URL ?? '');
  expect(['postgresql:', 'postgres:']).toContain(database.protocol); expect(database.hostname).toBe('127.0.0.1'); expect(database.port).toBe('55433');
  expect(database.pathname).toBe(`/${value.databaseName}`); expect(database.search + database.hash).toBe('');
  const provider = new URL(process.env.CANVAS_SHARED_MCP_APPS_URL ?? '');
  expect(provider.protocol).toBe('http:'); expect(provider.hostname).toBe('127.0.0.1'); expect(provider.pathname).toBe('/mcp');
  expect(provider.search + provider.hash + provider.username + provider.password).toBe(''); expect(['3001', '3100', '4001', '4004', '55433', '']).not.toContain(provider.port);
  expect(process.env.CANVAS_SHARED_MCP_APPS_CONTROL_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(path.dirname(process.env.AGENT_SETTINGS_TOOLS_BROWSER_RESULTS ?? '')).toBe(root);
  return value;
}
async function providerState(): Promise<ProviderState> {
  const response = await control.get(`${new URL(process.env.CANVAS_SHARED_MCP_APPS_URL!).origin}/__fixture/state`, {
    headers: { Authorization: `Bearer ${process.env.CANVAS_SHARED_MCP_APPS_CONTROL_TOKEN}` },
  });
  expect(response.status()).toBe(200); const state = await response.json() as ProviderState;
  expect(Object.keys(state).sort()).toEqual(['calls', 'requests', 'resourceReads', 'verificationProbes']);
  expect(state.calls.every(value => Object.keys(value).length === 1 && typeof value.name === 'string')).toBe(true);
  expect(state.requests.every(value => typeof value === 'string') && state.resourceReads.every(value => typeof value === 'string')).toBe(true);
  expect(Number.isSafeInteger(state.verificationProbes)).toBe(true); return state;
}
async function actionCount(): Promise<number> { return (await providerState()).calls.filter(value => value.name === 'app_action').length; }
async function recordCase(name: string): Promise<void> { expect(receipt.protocolCases).not.toContain(name); receipt.protocolCases.push(name); await persist(); }

/** Real Better Auth issues the bearer. The browser host and provider never receive this token. */
async function login(email: string, password: string): Promise<Identity> {
  const transport = await request.newContext({ baseURL: baseUrl, timeout: 15_000, extraHTTPHeaders: { Origin: baseUrl } });
  apiContexts.push(transport);
  let token = '';
  {
    const deadline = Date.now() + 45_000;
    for (let retries = 0; ; retries++) {
      const response = await transport.post('/api/auth/sign-in/email', { data: { email, password } }).catch(() => { throw new Error('The owned sign-in transport failed.'); });
      if (response.status() === 429 && retries < 2) { await waitForAuthRetry(response, deadline, 'Owned native bearer sign-in', retries + 1); continue; }
      expect(response.status()).toBe(200); token = response.headers()['set-auth-token'] ?? '';
      if (!token || token.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(token)) throw new Error('The actual sign-in must issue a bounded bearer token.');
      break;
    }
  }
  const webResponse = await transport.get('/api/auth/get-session'); expect(webResponse.status()).toBe(200);
  const webIdentity = await webResponse.json() as { user: { id: string }; session: { id: string } };
  expect((await transport.storageState()).cookies.length > 0).toBe(true);
  const api = await request.newContext({ baseURL: baseUrl, timeout: 15_000, storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { Authorization: `Bearer ${token}`, Origin: baseUrl } });
  token = ''; apiContexts.push(api);
  const response = await api.get('/api/auth/get-session'); expect(response.status()).toBe(200);
  const identity = await response.json() as { user: { id: string; email: string }; session: { id: string } };
  expect(identity.user.email.toLowerCase()).toBe(email.toLowerCase()); expect(identity.user.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/u);
  expect(identity.session.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/u); expect((await api.storageState()).cookies).toEqual([]);
  expect(webIdentity.user.id).toBe(identity.user.id); expect(webIdentity.session.id).toBe(identity.session.id);
  return { api, webApi: transport, userId: identity.user.id, authSessionId: identity.session.id };
}
async function createSession(): Promise<string> {
  receipt.outstanding = 'session:create'; await persist();
  const response = await admin.api.post('/api/mobile/v1/sessions', { headers: { 'X-Canvas-Workspace-Id': workspaceId },
    data: { agentId: agent.agentId, title: `Native MCP ${fixture.nonce}`, clientRequestId: `native-${randomBytes(16).toString('hex')}` } });
  expect(response.status()).toBe(201); const value = await response.json() as { success: boolean; session: { id: string; agentId: string } };
  expect(value.success).toBe(true); expect(value.session.agentId).toBe(agent.agentId); expect(value.session.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/u);
  receipt.sessions.push({ sessionId: value.session.id, actorUserId: admin.userId, deleted: false });
  receipt.outstanding = null; await persist(); return value.session.id;
}
async function seed(sessionId: string): Promise<Invocation> {
  receipt.outstanding = 'invocation'; await persist();
  const toolCallId = `native_${randomBytes(16).toString('hex')}`;
  const file = path.join(fixture.fixtureRoot, `${toolCallId}.json`), outputFile = file.replace(/\.json$/u, '.output.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, nonce: fixture.nonce, actorUserId: admin.userId, sessionId,
    agentId: agent.agentId, connectionId, toolCallId }), { mode: 0o600, flag: 'wx' });
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=react-server', path.join(fixture.repo, 'scripts/helpers/mobile-mcp-apps-invocation-fixture.ts'), file], {
    cwd: fixture.repo, env: { ...process.env, NODE_ENV: 'test' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child.stdout.on('data', (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-2048); });
  child.stderr.on('data', (chunk: Buffer) => { errors = `${errors}${chunk.toString()}`.slice(-2048); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', () => reject(new Error('The owned source child could not start.'))); child.once('close', (code, signal) => resolve({ code, signal })); });
  expect(child.pid).toBeGreaterThan(0); const pid = child.pid!;
  const ps = await promisify(execFile)('/bin/ps', ['-o', 'pgid=', '-p', String(pid)]); expect(Number(ps.stdout.trim())).toBe(pid);
  const proof = { pid, processGroupId: pid, closed: false }; receipt.processes.push(proof); await persist();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => {
      if (child.pid === pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-pid, 'SIGTERM'); } catch { /* Closure remains mandatory. */ } }
      reject(new Error('The owned invocation did not close within its deadline.'));
    }, 60_000); })]);
    for (const target of [pid, -pid]) { let absent = false; try { process.kill(target, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; } expect(absent).toBe(true); }
    proof.closed = true;
    const stage = errors.match(/MOBILE_MCP_APPS_INVOCATION_FAILED (ownership|imports|runtime-db|runtime-context|runtime-policy|runtime-backend|dispatch|persistence|closure|output)\b/u)?.[1];
    const site = errors.match(/\bsite=(scripts\/helpers\/mobile-mcp-apps-invocation-fixture\.ts:\d{1,5}:\d{1,5})\b/u)?.[1];
    expect(result, stage ? `The owned invocation failed during ${stage}${site ? ` at ${site}` : ''}.` : 'The owned invocation must succeed.').toEqual({ code: 0, signal: null });
    expect(output).toContain('MOBILE_MCP_APPS_INVOCATION_SAVED'); expect(errors).not.toContain('MOBILE_MCP_APPS_INVOCATION_FAILED');
  } finally { clearTimeout(timer); await persist(); }
  const handle = await fs.open(outputFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let saved: Invocation;
  try { const stat = await handle.stat(); expect(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size <= 2 * 1024 * 1024).toBe(true); saved = JSON.parse(await handle.readFile('utf8')) as Invocation; }
  finally { await handle.close(); }
  expect(Object.keys(saved).sort()).toEqual(['descriptor', 'input', 'messageId', 'result', 'sequence']);
  expect(saved.descriptor).toEqual({ version: 1, connectionId, toolName: 'app_view', resourceUri });
  expect(saved.messageId).toBeGreaterThan(0); expect(saved.sequence).toBe(1); expect(JSON.stringify(saved).includes('mcpAppAuthority')).toBe(false);
  source = { toolCallId, app: saved.descriptor }; receipt.invocations.push({ sessionId, toolCallId, connectionId });
  receipt.outstanding = null; await persist(); return saved;
}
function url(suffix: string, sessionId = receipt.sessions[0].sessionId): string { return `/api/mobile/v1/sessions/${encodeURIComponent(sessionId)}/mcp-apps${suffix}`; }
async function mobile(response: APIResponse): Promise<Call> {
  expect(response.status()).toBe(200); const result = await response.json() as Call;
  expect(result).toMatchObject({ success: true, contractVersion: 1, sessionId: receipt.sessions[0].sessionId, workspaceId }); return result;
}
async function nativeSend(type: string, payload: Record<string, unknown>, overrides: Partial<NativeEnvelope> = {}): Promise<void> {
  const envelope = JSON.stringify({ version: 1, channelId: render.host.channelId, nonce: render.host.nonce, type, payload, ...overrides });
  await page.evaluate(raw => window.dispatchEvent(new MessageEvent('message', { data: raw, origin: location.origin, source: window })), envelope);
}
async function nativeEvent(type: string, after = 0): Promise<NativeEnvelope> {
  await expect.poll(() => page.evaluate(({ type, after }) => {
    const messages = (window as unknown as { __nativeMessages: string[] }).__nativeMessages;
    return messages.slice(after).some(raw => JSON.parse(raw).type === type);
  }, { type, after })).toBe(true);
  const envelope = await page.evaluate(({ type, after }) => (window as unknown as { __nativeMessages: string[] }).__nativeMessages.slice(after).map(raw => JSON.parse(raw)).find(value => value.type === type), { type, after }) as NativeEnvelope;
  expect(envelope.version === 1 && envelope.channelId === render.host.channelId && envelope.nonce === render.host.nonce && envelope.type === type).toBe(true); return envelope;
}
async function messageCount(): Promise<number> { return page.evaluate(() => (window as unknown as { __nativeMessages: string[] }).__nativeMessages.length); }

test.beforeAll(async () => {
  fixture = await readOwnedMobileMcpFixture();
  receipt = { version: 1, nonce: fixture.nonce, actorId: fixture.actorId, phase: 'setup', outstanding: null, closedContexts: false,
    membershipIds: [], actorIds: [fixture.actorId], workspaceIds: [], personalConfigRestored: false, gatewayRestored: false, catalogRestored: false,
    sessions: [], processes: [], invocations: [], nativeBridgeTransportSeam: true, nativeDevice: false, verifiedCases: 0,
    protocolCases: [], forbiddenRequests: [], unexpectedDialogs: [] };
  await persist(); control = await request.newContext({ timeout: 15_000 }); apiContexts.push(control);
  const email = process.env.TEST_LOGIN_EMAIL ?? '', password = process.env.TEST_LOGIN_PASSWORD ?? '';
  if (!email || !password) throw new Error('The parent-owned bootstrap credentials are required.');
  admin = await login(email, password); expect(admin.userId).toBe(fixture.actorId);
  secondAdmin = await login(email, password); expect(secondAdmin.userId).toBe(admin.userId); expect(secondAdmin.authSessionId).not.toBe(admin.authSessionId);
  const unauthenticated = await control.get(`${baseUrl}/api/mobile/v1/bootstrap`); expect(unauthenticated.status()).toBe(401);
  const wrongBearer = await control.get(`${baseUrl}/api/mobile/v1/bootstrap`, { headers: { Authorization: `Bearer ${randomBytes(32).toString('base64url')}` } }); expect(wrongBearer.status()).toBe(401);
  expect((await control.storageState()).cookies).toEqual([]);
  const bootstrapResponse = await admin.api.get('/api/mobile/v1/bootstrap'); expect(bootstrapResponse.status()).toBe(200);
  const bootstrap = await bootstrapResponse.json() as { product: string; mobileApi: { capabilities: string[] }; user: { id: string }; workspace: { defaultWorkspaceId: string; items: Array<{ id: string; type: string }> } };
  expect(bootstrap.product).toBe('canvas-notebook'); expect(bootstrap.user.id).toBe(admin.userId);
  expect(bootstrap.mobileApi.capabilities).toEqual(expect.arrayContaining(['chat.mcp_apps.v1', 'integrations.mcp_mobile.v1']));
  workspaceId = bootstrap.workspace.defaultWorkspaceId; expect(bootstrap.workspace.items.find(value => value.id === workspaceId)?.type).toBe('personal');
  const listingResponse = await admin.webApi.get('/api/workspaces'); expect(listingResponse.status()).toBe(200);
  const listing = await listingResponse.json() as { defaultWorkspace: { id: string; organizationId: string } };
  expect(listing.defaultWorkspace.id).toBe(workspaceId); organizationId = listing.defaultWorkspace.organizationId; expect(organizationId).toBeTruthy();
  originalBradley = await data(await admin.webApi.get('/api/agents?agentId=bradley&includeAccess=true'));
  const memberEmail = process.env.TEST_SECONDARY_EMAIL ?? '', memberPassword = process.env.TEST_SECONDARY_PASSWORD ?? '';
  if (!memberEmail || !memberPassword) throw new Error('The fixed normal-member credentials are required.');
  receipt.outstanding = 'member:create'; await persist();
  const proposed = await data<{ membershipId: string; approval: { required: boolean }; quote: { nonBillable: boolean } }>(await admin.webApi.post('/api/admin/organization/memberships', { data: { name: `Native member ${fixture.nonce}`, email: memberEmail, role: 'member' } }), 202);
  expect(proposed.membershipId).toMatch(/^[A-Za-z0-9_-]{1,200}$/u); receipt.membershipIds.push(proposed.membershipId); await persist();
  expect(proposed.approval.required).toBe(false); expect(proposed.quote.nonBillable).toBe(true);
  expect(await data(await admin.webApi.post(`/api/admin/organization/memberships/${encodeURIComponent(proposed.membershipId)}/activate`, { data: { password: memberPassword } }))).toMatchObject({ membershipId: proposed.membershipId, stage: 'active', execution: { onboardingInitialized: true } });
  member = await login(memberEmail, memberPassword); expect(member.userId).not.toBe(admin.userId); receipt.actorIds.push(member.userId);
  const deniedConfig = await member.webApi.put('/api/integrations/mcp-config', { data: { rawContent: JSON.stringify({ mcpServers: {} }) } }); expect(deniedConfig.status()).toBe(403);
  originalMcp = JSON.parse((await data<{ rawContent: string }>(await admin.webApi.get('/api/integrations/mcp-config'))).rawContent) as McpConfig;
  expect(Object.keys(originalMcp.mcpServers)).toEqual([]); receipt.outstanding = 'personal-config:create'; await persist();
  serverName = `native_${fixture.nonce}`;
  installedMcp = JSON.parse((await data<{ rawContent: string }>(await admin.webApi.put('/api/integrations/mcp-config', { data: {
    rawContent: JSON.stringify({ ...originalMcp, mcpServers: { [serverName]: { url: process.env.CANVAS_SHARED_MCP_APPS_URL, auth: 'none', enabled: true, displayName: `Native ${fixture.nonce}` } } }),
  } }))).rawContent) as McpConfig;
  connectionId = installedMcp.mcpServers[serverName].connectionId!; expect(connectionId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  expect(installedMcp.mcpServers[serverName].ownerUserId).toBe(admin.userId); receipt.personalConnectionId = connectionId; await persist();
  receipt.outstanding = 'agent:create'; await persist();
  agent = (await data<{ agent: AgentProfile }>(await admin.webApi.post(`/api/agents?${new URLSearchParams({ organizationId, workspaceId })}`, { data: {
    name: `Native MCP ${fixture.nonce}`, scopeType: 'user', enabledTools: ['mcp'], relevantSkills: [], relevantConnections: [],
  } }))).agent;
  expect(agent.agentId).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/u); expect(agent).toMatchObject({ scopeType: 'user', createdByUserId: fixture.actorId, removable: true, enabledTools: ['mcp'] });
  receipt.agentId = agent.agentId; await persist();
  originalFlag = (await data<{ integrationToolGatewayEnabled: boolean }>(await admin.webApi.get('/api/admin/experimental-settings'))).integrationToolGatewayEnabled;
  receipt.outstanding = 'gateway:enable'; await persist();
  expect((await data<{ integrationToolGatewayEnabled: boolean }>(await admin.webApi.patch('/api/admin/experimental-settings', { data: { integrationToolGatewayEnabled: true } }))).integrationToolGatewayEnabled).toBe(true);
  originalCatalog = (await data<{ catalog: AiAppRuntimeCatalog }>(await admin.webApi.get('/api/admin/agent-runtime/catalog'))).catalog;
  receipt.outstanding = 'catalog:fixture'; await persist();
  const configured = await data<{ catalog: AiAppRuntimeCatalog }>(await admin.webApi.put('/api/admin/agent-runtime/catalog', { data: {
    expectedRevision: originalCatalog.revision, providers: [{ providerId: 'ollama', enabled: true, credentialScope: 'system', modelIds: ['shared-apps-fixture'], defaultModelId: 'shared-apps-fixture',
      config: { ollamaMode: 'local', ollamaHost: new URL(process.env.CANVAS_SHARED_MCP_APPS_URL!).origin, ollamaModelSource: 'custom', ollamaCustomModel: 'shared-apps-fixture' } }], defaultSelection: null,
  } }));
  expect(configured.catalog.providers).toHaveLength(1); const installation = configured.catalog.providers[0];
  expect(await data(await admin.webApi.post(`/api/admin/agent-runtime/providers/${encodeURIComponent(installation.installationId)}/verify`))).toMatchObject({ success: true, status: 'ready' });
  const ready = (await data<{ catalog: AiAppRuntimeCatalog }>(await admin.webApi.get('/api/admin/agent-runtime/catalog'))).catalog;
  const selected = await data<{ catalog: AiAppRuntimeCatalog }>(await admin.webApi.put('/api/admin/agent-runtime/catalog', { data: {
    expectedRevision: ready.revision, providers: [{ providerInstallationId: installation.installationId, providerId: 'ollama', enabled: true, credentialScope: 'system', modelIds: ['shared-apps-fixture'], defaultModelId: 'shared-apps-fixture', config: installation.config }],
    defaultSelection: { providerInstallationId: installation.installationId, providerId: 'ollama', modelId: 'shared-apps-fixture', thinkingLevel: 'off' },
  } }));
  expect(selected.catalog.providers[0].status).toBe('ready'); ownedCatalogRevision = selected.catalog.revision;
  const sessionId = await createSession(); await createSession();
  invocation = await seed(sessionId); expect((await providerState()).calls.filter(value => value.name === 'app_view')).toHaveLength(1);
  receipt.outstanding = null; receipt.phase = 'ready'; await persist();
});

test('actual personal saved source opens the native host bundle and nested App SDK through a transport seam', async ({ browser }) => {
  const response = await admin.api.post(url('/render'), { headers: { 'X-Canvas-Workspace-Id': workspaceId }, data: { contractVersion: 1, ...source } });
  expect(response.status()).toBe(200); render = await response.json() as Render;
  expect(render.success === true && render.contractVersion === 1 && render.sessionId === receipt.sessions[0].sessionId
    && render.workspaceId === workspaceId && render.toolCallId === source.toolCallId).toBe(true);
  expect(render.host.url.startsWith(`${baseUrl}/__preview/`) && /^\/__preview\/[A-Za-z0-9_-]{43}\/mobile-mcp\/host$/u.test(new URL(render.host.url).pathname)).toBe(true);
  const configuredPreview = process.env.CANVAS_HTML_PREVIEW_ORIGIN?.trim();
  const expectedFrameOrigin = configuredPreview ? new URL(configuredPreview).origin : baseUrl;
  expect(render.host.origin).toBe(baseUrl); expect(render.host.frameOrigin).toBe(expectedFrameOrigin);
  expect(render.host.channelId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  expect(render.host.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u); expect(render.host.expiresAt - render.checkedAt).toBeLessThanOrEqual(300_000);
  const context = await browser.newContext({ baseURL: baseUrl, storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } }); browserContexts.push(context);
  page = await context.newPage(); page.on('dialog', dialog => { receipt.unexpectedDialogs.push(dialog.type()); void dialog.dismiss(); });
  page.on('request', incoming => {
    // All authenticated API work remains outside the host realm; the provider's deliberately CSP-blocked isolation probe is expected.
    const incomingUrl = new URL(incoming.url());
    if (incoming.headers().authorization || incoming.headers().cookie || incoming.method() !== 'GET'
      || !['127.0.0.1', 'localhost', '[::1]'].includes(incomingUrl.hostname)) receipt.forbiddenRequests.push(`${incoming.method()} ${incomingUrl.pathname}`);
  });
  await page.addInitScript(hostUrl => {
    if (window !== window.top || location.href !== hostUrl) return;
    const native = window as unknown as { __nativeMessages: string[]; ReactNativeWebView: { postMessage(message: string): void } };
    native.__nativeMessages = [];
    native.ReactNativeWebView = { postMessage(raw) { if (typeof raw === 'string' && new TextEncoder().encode(raw).byteLength <= 65536) native.__nativeMessages.push(raw); } };
  }, render.host.url);
  const hostResponse = await page.goto(render.host.url, { waitUntil: 'domcontentloaded' }); expect(hostResponse?.status()).toBe(200);
  expect(hostResponse!.headers()['content-security-policy']).toContain("connect-src 'none'"); expect(hostResponse!.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await nativeEvent('host_ready'); const contextData = { theme: 'dark', locale: 'de', timeZone: 'Europe/Berlin', containerDimensions: { width: 390, maxHeight: 640 }, safeAreaInsets: { top: 12, right: 0, bottom: 20, left: 0 } };
  await nativeSend('host_context', { context: contextData }, { nonce: randomBytes(32).toString('base64url') });
  expect(await page.locator('iframe').getAttribute('src')).toBeNull();
  await nativeSend('host_context', { context: contextData }); await nativeEvent('app_ready');
  await expect.poll(() => page.frames().filter(frame => new URL(frame.url() || baseUrl).pathname.endsWith('/mobile-mcp/document')).length).toBe(1);
  document = page.frames().find(frame => new URL(frame.url() || baseUrl).pathname.endsWith('/mobile-mcp/document'))!;
  await expect(document.locator('#status')).toHaveText('Ready'); await expect(document.locator('#context')).toHaveText('{"theme":"dark","locale":"de"}');
  await expect(document.locator('#result')).toHaveText(JSON.stringify((invocation.result as { structuredContent: unknown }).structuredContent));
  await expect(document.locator('#meta')).toHaveText(JSON.stringify((invocation.result as { _meta: unknown })._meta));
  await expect(document.getByRole('img', { name: 'Shared result image' })).toBeVisible();
  expect(await document.evaluate(() => typeof (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView)).toBe('undefined');
  await document.locator('#isolation').click(); await expect(document.locator('#sandbox')).toHaveText('{"parentBlocked":true,"storageBlocked":true,"networkBlocked":true}');
  // Even a forged envelope with the correct channel cannot control the trusted top host from the provider realm.
  await document.evaluate(raw => window.top!.postMessage(raw, '*'), JSON.stringify({ version: 1,
    channelId: render.host.channelId, nonce: render.host.nonce, type: 'teardown', payload: {} }));
  await nativeSend('host_context', { context: { ...contextData, locale: 'fr' } });
  await expect(document.locator('#context')).toHaveText('{"theme":"dark","locale":"fr"}');
  await nativeSend('host_context', { context: contextData }); await expect(document.locator('#context')).toHaveText('{"theme":"dark","locale":"de"}');
  expect((await context.cookies()).length).toBe(0); expect(await actionCount()).toBe(0);
  await recordCase('bearer-only-real-session'); await recordCase('issued-native-host-real-sdk-saved-result'); await recordCase('wrong-nonce-ignored'); await recordCase('opaque-provider-no-native-bridge-storage-network');
  receipt.verifiedCases++; await persist();
});

test('real prepare requires explicit approval; duplicate decisions and rejection never replay an action', async () => {
  const headers = { 'X-Canvas-Workspace-Id': workspaceId }, before = await messageCount();
  await document.locator('#action').click(); await expect(document.locator('#status')).toHaveText('Waiting for approval');
  const event = await nativeEvent('tool_call', before);
  expect(event.payload).toMatchObject({ tool: 'app_action', arguments: { value: 'from-widget' } }); expect(event.payload.requestId).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
  const prepare = { contractVersion: 1, ...source, hostChannelId: render.host.channelId, ...event.payload };
  const deniedSource = await admin.api.post(url('/render'), { headers, data: { contractVersion: 1, ...source, app: { ...source.app, toolName: 'forged_source' } } }); expect(deniedSource.status()).toBe(403);
  const unsaved = await admin.api.post(url('/render'), { headers, data: { contractVersion: 1, ...source, toolCallId: `not_saved_${randomBytes(8).toString('hex')}` } }); expect(unsaved.status()).toBe(425);
  const otherWorkspace = await admin.api.post(url('/render'), { headers: { 'X-Canvas-Workspace-Id': randomUUID() }, data: { contractVersion: 1, ...source } }); expect([403, 404].includes(otherWorkspace.status())).toBe(true);
  const otherActor = await member.api.post(url('/render'), { headers, data: { contractVersion: 1, ...source } }); expect([403, 404].includes(otherActor.status())).toBe(true);
  const otherChat = await admin.api.post(url('/calls', receipt.sessions[1].sessionId), { headers, data: prepare }); expect(otherChat.status()).toBe(409);
  const otherAuthSession = await secondAdmin.api.post(url('/calls'), { headers, data: prepare }); expect(otherAuthSession.status()).toBe(409);
  const otherChannel = await admin.api.post(url('/calls'), { headers, data: { ...prepare, hostChannelId: randomUUID() } }); expect(otherChannel.status()).toBe(409);
  const modelOnly = await admin.api.post(url('/calls'), { headers, data: { ...prepare, tool: 'model_only' } }); expect(modelOnly.status()).toBe(409);
  expect(await actionCount()).toBe(0);
  await recordCase('source-unsaved-and-forged-denied'); await recordCase('actor-workspace-chat-auth-session-channel-bound'); await recordCase('model-only-tool-denied');
  const prepared = await mobile(await admin.api.post(url('/calls'), { headers, data: prepare }));
  expect(prepared.call?.status).toBe('prepared'); expect(prepared.approval?.tool).toBe('app_action');
  expect(prepared.approval?.arguments).toEqual({ value: 'from-widget' }); expect(await actionCount()).toBe(0);
  const duplicatePrepare = await mobile(await admin.api.post(url('/calls'), { headers, data: prepare })); expect(duplicatePrepare.call?.callId).toBe(prepared.call!.callId);
  const recovered = await mobile(await admin.api.get(url(`/calls?requestId=${encodeURIComponent(String(event.payload.requestId))}`), { headers })); expect(recovered.call?.callId).toBe(prepared.call!.callId);
  const wrongApproval = await admin.api.post(url(`/calls/${prepared.call!.callId}`), { headers, data: { contractVersion: 1, decision: 'approve', approvalToken: `mca1.${randomBytes(32).toString('base64url')}` } }); expect(wrongApproval.status()).toBe(403); expect(await actionCount()).toBe(0);
  const approved = await mobile(await admin.api.post(url(`/calls/${prepared.call!.callId}`), { headers, data: { contractVersion: 1, decision: 'approve', approvalToken: prepared.approval!.token } }));
  expect(approved.call?.status).toBe('completed'); expect(await actionCount()).toBe(1);
  await nativeSend('tool_result', { requestId: event.payload.requestId, result: approved.call!.result }); await expect(document.locator('#status')).toHaveText('Approved');
  const repeat = await mobile(await admin.api.post(url(`/calls/${prepared.call!.callId}`), { headers, data: { contractVersion: 1, decision: 'approve', approvalToken: prepared.approval!.token } })); expect(repeat.call?.status).toBe('completed');
  const terminalPrepare = await mobile(await admin.api.post(url('/calls'), { headers, data: prepare })); expect(terminalPrepare.call?.callId).toBe(prepared.call!.callId); expect(terminalPrepare.approval).toBeNull();
  const status = await mobile(await admin.api.get(url(`/calls/${prepared.call!.callId}`), { headers })); expect(status.call?.status).toBe('completed'); expect(await actionCount()).toBe(1);
  const newer = await mobile(await secondAdmin.api.get(url(`/calls/${prepared.call!.callId}`), { headers })); expect(newer.call).toBeNull();
  await recordCase('prepare-and-recovery-no-dispatch'); await recordCase('explicit-approval-one-dispatch'); await recordCase('duplicate-prepare-decision-status-no-replay');
  const deniedBefore = await messageCount(); await document.locator('#action').click(); const deniedEvent = await nativeEvent('tool_call', deniedBefore);
  const denial = await mobile(await admin.api.post(url('/calls'), { headers, data: { contractVersion: 1, ...source, hostChannelId: render.host.channelId, ...deniedEvent.payload } }));
  const rejected = await mobile(await admin.api.post(url(`/calls/${denial.call!.callId}`), { headers, data: { contractVersion: 1, decision: 'reject', approvalToken: denial.approval!.token } })); expect(rejected.call?.status).toBe('rejected');
  await nativeSend('tool_result', { requestId: deniedEvent.payload.requestId, result: { isError: true, content: [{ type: 'text', text: 'MCP_CALL_REJECTED' }] } }); await expect(document.locator('#status')).toHaveText('Rejected');
  const deniedAgain = await mobile(await admin.api.post(url(`/calls/${denial.call!.callId}`), { headers, data: { contractVersion: 1, decision: 'approve', approvalToken: denial.approval!.token } })); expect(deniedAgain.call?.status).toBe('rejected'); expect(await actionCount()).toBe(1);
  await recordCase('rejection-and-late-approval-zero-dispatch'); receipt.verifiedCases++; await persist();
});

test('teardown and real connection invalidation reject stale native channels with no provider dispatch', async () => {
  await nativeSend('teardown', {}); await expect(page.locator('iframe')).toHaveCount(0);
  const count = await messageCount();
  await nativeSend('host_context', { context: { theme: 'light', containerDimensions: { width: 390, height: 640 } } });
  await nativeSend('tool_result', { requestId: randomUUID(), result: { content: [] } });
  expect(await messageCount()).toBe(count); await expect(page.locator('iframe')).toHaveCount(0); expect(await actionCount()).toBe(1);
  await recordCase('teardown-stale-native-envelopes-ignored');
  receipt.outstanding = 'personal-config:disable'; await persist();
  const disabled = { ...installedMcp, mcpServers: { [serverName]: { ...installedMcp.mcpServers[serverName], enabled: false } } };
  const saved = JSON.parse((await data<{ rawContent: string }>(await admin.webApi.put('/api/integrations/mcp-config', { data: { rawContent: JSON.stringify(disabled) } }))).rawContent) as McpConfig;
  expect(saved.mcpServers[serverName]).toMatchObject({ connectionId, ownerUserId: admin.userId, enabled: false }); receipt.outstanding = null; await persist();
  const denied = await admin.api.post(url('/calls'), { headers: { 'X-Canvas-Workspace-Id': workspaceId }, data: { contractVersion: 1, ...source,
    hostChannelId: render.host.channelId, requestId: randomUUID(), tool: 'app_action', arguments: { value: 'from-widget' } } }); expect(denied.status()).toBe(409);
  const unavailable = await control.get(render.host.url); expect(unavailable.status()).toBe(404); expect(await actionCount()).toBe(1);
  await recordCase('current-disabled-config-invalidates-issued-host-and-call'); receipt.verifiedCases++; await persist();
});

test.afterAll(async () => {
  if (!receipt) return;
  let verified = false;
  try {
    expect(receipt.verifiedCases).toBe(3); expect(receipt.protocolCases).toHaveLength(13); expect(receipt.outstanding).toBeNull();
    expect(receipt.forbiddenRequests).toEqual([]); expect(receipt.unexpectedDialogs).toEqual([]);
    for (const context of browserContexts) await context.close(); browserContexts.length = 0;
    for (const owned of receipt.sessions) {
      receipt.outstanding = 'cleanup:session'; await persist();
      const response = await admin.webApi.delete(`/api/sessions?${new URLSearchParams({ agentId: agent.agentId, sessionId: owned.sessionId })}`);
      expect(response.status()).toBe(200); expect(await response.json()).toEqual({ success: true, deleted: owned.sessionId }); owned.deleted = true; await persist();
    }
    const sessions = await admin.webApi.get(`/api/sessions?${new URLSearchParams({ agentId: agent.agentId })}`); expect(sessions.status()).toBe(200); expect((await sessions.json() as { sessions: unknown[] }).sessions).toEqual([]);
    const q = new URLSearchParams({ organizationId, workspaceId }); receipt.outstanding = 'cleanup:agent'; await persist();
    const preview = await data<{ agent: AgentProfile; impacts: { sessions: number }; confirmationToken: string }>(await admin.webApi.post(`/api/agents/delete-preview?${q}`, { data: { agentId: agent.agentId } }));
    expect(preview.agent).toMatchObject({ agentId: agent.agentId, name: agent.name, createdByUserId: fixture.actorId, removable: true }); expect(preview.impacts.sessions).toBe(0);
    expect(await data(await admin.webApi.delete(`/api/agents?${q}`, { data: { agentId: agent.agentId, expectedRevision: preview.agent.revision, confirmationToken: preview.confirmationToken } }))).toEqual({ deleted: true, agentId: agent.agentId });
    expect((await admin.webApi.get(`/api/agents?${q}&agentId=${encodeURIComponent(agent.agentId)}`)).status()).toBe(404);
    receipt.outstanding = 'cleanup:personal-config'; await persist();
    const restoredMcp = JSON.parse((await data<{ rawContent: string }>(await admin.webApi.put('/api/integrations/mcp-config', { data: { rawContent: JSON.stringify(originalMcp) } }))).rawContent) as McpConfig;
    expect(restoredMcp).toEqual(originalMcp); receipt.personalConfigRestored = true;
    receipt.outstanding = 'cleanup:catalog'; await persist();
    const current = (await data<{ catalog: AiAppRuntimeCatalog }>(await admin.webApi.get('/api/admin/agent-runtime/catalog'))).catalog; expect(current.revision).toBe(ownedCatalogRevision);
    const restored = await data<{ catalog: AiAppRuntimeCatalog }>(await admin.webApi.put('/api/admin/agent-runtime/catalog', { data: { expectedRevision: current.revision,
      providers: originalCatalog.providers.map(value => ({ providerInstallationId: value.installationId, providerId: value.providerId, enabled: value.enabled, credentialScope: value.credentialScope,
        config: value.config, modelIds: value.models.filter(model => model.enabled).map(model => model.id), defaultModelId: value.models.find(model => model.isProviderDefault)?.id ?? '' })), defaultSelection: originalCatalog.defaultSelection } }));
    expect(restored.catalog.defaultSelection).toEqual(originalCatalog.defaultSelection); expect(restored.catalog.providers.map(value => value.installationId)).toEqual(originalCatalog.providers.map(value => value.installationId)); receipt.catalogRestored = true;
    receipt.outstanding = 'cleanup:gateway'; await persist();
    expect((await data<{ integrationToolGatewayEnabled: boolean }>(await admin.webApi.patch('/api/admin/experimental-settings', { data: { integrationToolGatewayEnabled: originalFlag } }))).integrationToolGatewayEnabled).toBe(originalFlag); receipt.gatewayRestored = true;
    expect(await data(await admin.webApi.get('/api/agents?agentId=bradley&includeAccess=true'))).toEqual(originalBradley);
    const final = await providerState(); expect(final.verificationProbes).toBe(1); expect(final.calls.filter(value => value.name === 'app_view')).toHaveLength(1);
    expect(final.calls.filter(value => value.name === 'app_action')).toHaveLength(1); expect(final.calls.filter(value => value.name === 'model_only')).toHaveLength(0); receipt.providerFinal = final;
    expect(receipt.processes).toHaveLength(1); expect(receipt.processes.every(value => value.closed && value.processGroupId === value.pid)).toBe(true);
    for (const process of receipt.processes) for (const target of [process.pid, -process.processGroupId]) { let absent = false; try { globalThis.process.kill(target, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; } expect(absent).toBe(true); }
    receipt.outstanding = null; verified = true;
  } catch (error) {
    receipt.failure = { name: error instanceof Error ? error.name : 'UnknownError' };
    const site = error instanceof Error ? error.stack?.match(/tests\/mobile-mcp-apps-local\.spec\.ts:\d+:\d+/u)?.[0] : undefined; if (site) receipt.failure.site = site;
  } finally {
    let closed = true;
    for (const context of browserContexts) { try { await context.close(); } catch { closed = false; } }
    for (const identity of [admin, secondAdmin, member]) if (identity) {
      try { if ((await identity.api.storageState()).cookies.length) closed = false; } catch { closed = false; }
    }
    for (const context of apiContexts) { try { await context.dispose(); } catch { closed = false; } }
    receipt.closedContexts = closed; receipt.phase = verified && closed ? 'verified_closed' : 'preserved'; await persist();
  }
  expect(verified && receipt.closedContexts, 'Only acknowledged own cleanup permits nonce database removal.').toBe(true);
  console.info('OWN_MOBILE_MCP_APPS_PROTOCOL_PASS: real bearer HTTP, dispatcher-saved personal source, actual host/SDK, approval and nonduplicate dispatch; native bridge transport seam only, no Expo UI/device/model claim.');
});
