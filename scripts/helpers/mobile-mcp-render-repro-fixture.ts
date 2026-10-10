import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { createSharedIntegrationProviderRef } from '../../app/lib/integration-tools/connections/provider-authorization';
import type { IntegrationConnectionDescriptor } from '../../app/lib/integration-tools/connections/contracts';
import type { SharedMcpAppDescriptor } from '../../app/lib/mcp/apps-types';
import type { AgentProfile } from '../../app/lib/agents/registry';
import type { AiAppRuntimeCatalog } from '../../app/lib/agent-runtime-policy/types';
import type { ClientWorkspaceResponse } from '../../app/lib/workspaces/client-types';
import type { MobileChatSession } from '../../app/lib/mobile/chat';
import { readToolAppInvocation } from '../../app/lib/tool-apps/types';
import { withOwnedTestCleanup } from '../../tests/helpers/owned-test-cleanup';

const BASE = 'http://127.0.0.1:3001', ID = /^[A-Za-z0-9_-]{1,128}$/u;
const APP_TOOLS = ['app_view', 'app_action', 'model_only'];
type Parent = { version: 1; nonce: string; actorId: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  rootDevice: string; rootInode: string; ownerMarker: string; directoryProofs: Record<string, { device: string; inode: string }>;
  databaseName: string; databaseOwner: string; serverPid: number; phase: string; createAcknowledged: boolean; listenerVerified: boolean;
  uncertain: boolean; mobileRenderRepro: true; mobileRenderReproDeadline: number };
type Actor = { role: 'owner' | 'manager'; api: APIRequestContext; userId: string; authSessionId: string; personalWorkspaceId: string; authClosed: boolean };
type Invocation = { descriptor: SharedMcpAppDescriptor; input: Record<string, unknown>; result: unknown; messageId: number; sequence: number };
type Source = { actor: Actor; connection: IntegrationConnectionDescriptor; sessionId: string; invocation: Invocation; digest: string; deleted: boolean };
type ProviderCounts = { requests: number; sourceCalls: number; actions: number; modelCalls: number; resourceReads: number; verificationProbes: number };
type Phase = 'ownership' | 'owner-signin' | 'membership' | 'manager-signin' | 'workspace' | 'connections' | 'agent' | 'catalog'
  | 'session' | 'saved-source' | 'warm-source' | 'warm-render' | 'idle' | 'cold-source' | 'cold-render' | 'baseline'
  | 'cleanup-domain' | 'cleanup-auth' | 'cleanup-context' | 'receipt';
type Receipt = { version: 1; nonce: string; actorId: string; deadline: number; acceptance: false; phase: string; diagnosticPassed: boolean;
  closedContexts: boolean; authClosed: boolean; seedersClosed: boolean; ownedDatabasePools: 0; domainCleanup: 'pending' | 'verified' | 'preserved';
  stage: Phase; actors: Array<{ role: Actor['role']; userId: string; authClosed: boolean }>;
  sessions: Array<{ role: Actor['role']; userId: string; agentId: string; sessionId: string; deleted: boolean }>;
  sources: Array<{ role: Actor['role']; scope: string; connectionRef: string; sessionId: string; toolCallId: string; digest: string; deleted: boolean }>;
  processes: Array<{ pid: number; processGroupId: number; closed: boolean }>;
  observations: Array<{ phase: 'warm' | 'cold'; role: Actor['role']; scope: string; sourceStatus: number; renderStatus?: number;
    elapsedMs: number; sourceImmutable: boolean; errorClass?: string; cspVerified?: boolean }>;
  idle?: { startedAt: number; finishedAt: number; durationMs: number; before: ProviderCounts; after: ProviderCounts; noMcpRequests: boolean };
  providerFinal?: ProviderCounts; failure?: { stage: Phase; errorClass: string; status?: number }; cleanupErrors: string[] };
const errorNames = new Set(['Error', 'AssertionError', 'TypeError', 'ReferenceError', 'SyntaxError', 'TimeoutError', 'AbortError',
  'APIRequestError', 'AggregateError']);
const safeError = (value: unknown) => value instanceof Error && errorNames.has(value.name) ? value.name : 'OtherError';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function privateJson<T>(file: string, maxBytes = 128 * 1024): Promise<T> {
  assert.equal(await fs.realpath(file), file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600
      && stat.size > 0 && stat.size <= maxBytes);
    const result: T = JSON.parse(await handle.readFile('utf8'));
    const current = await fs.lstat(file); assert.equal(current.dev, stat.dev); assert.equal(current.ino, stat.ino);
    return result;
  } finally { await handle.close(); }
}

async function readOwnedRenderReproContext(): Promise<Parent> {
  for (const flag of ['CANVAS_AGENT_SETTINGS_BROWSER_RUN', 'CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN',
    'CANVAS_SHARED_MCP_APPS_BROWSER_RUN', 'CANVAS_MOBILE_MCP_RENDER_REPRO_RUN', 'E2E_EXTERNAL_SERVER']) assert.equal(process.env[flag], '1');
  assert.equal(process.argv.length, 2); assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.__NEXT_PROCESSED_ENV, 'true');
  assert.equal(process.env.BASE_URL, BASE);
  const file = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE ?? '';
  assert(path.isAbsolute(file) && path.basename(file) === 'recovery.json');
  const root = path.dirname(file), stat = await fs.lstat(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
  const parent = await privateJson<Parent>(file, 64 * 1024);
  assert.equal(parent.version, 1); assert.equal(parent.fixtureRoot, root); assert.equal(await fs.realpath(root), root);
  assert.equal(parent.rootDevice, String(stat.dev)); assert.equal(parent.rootInode, String(stat.ino));
  assert.equal(parent.repo, await fs.realpath(process.cwd())); assert(ID.test(parent.actorId)); assert.match(parent.nonce, /^[a-f0-9]{32}$/u);
  assert.equal(parent.mobileRenderRepro, true); assert.equal(parent.phase, 'browser'); assert.equal(parent.uncertain, false);
  assert.equal(parent.createAcknowledged, true); assert.equal(parent.listenerVerified, true);
  assert(Number.isSafeInteger(parent.mobileRenderReproDeadline) && parent.mobileRenderReproDeadline > Date.now()
    && parent.mobileRenderReproDeadline <= Date.now() + 30 * 60_000);
  assert(Number.isSafeInteger(parent.serverPid) && parent.serverPid > 0); process.kill(parent.serverPid, 0);
  const listener = await promisify(execFile)('lsof', ['-nP', '-iTCP:3001', '-sTCP:LISTEN', '-Fp'], { timeout: 15_000, maxBuffer: 65536 });
  assert.deepEqual([...new Set(listener.stdout.split('\n').filter(line => /^p\d+$/u.test(line)).map(line => Number(line.slice(1))))], [parent.serverPid]);
  const cwd = await promisify(execFile)('lsof', ['-a', '-p', String(parent.serverPid), '-d', 'cwd', '-Fn'], { timeout: 15_000, maxBuffer: 65536 });
  assert.deepEqual(cwd.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1)), [parent.repo]);
  const marker = await fs.open(path.join(root, '.fixture-owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const value = await marker.stat(); assert(value.isFile() && value.uid === stat.uid && value.nlink === 1 && (value.mode & 0o777) === 0o600);
    assert.equal(await marker.readFile('utf8'), parent.ownerMarker); } finally { await marker.close(); }
  for (const [directory, name] of [[parent.dataRoot, 'data'], [parent.tmpRoot, 'tmp']]) {
    assert.equal(directory, path.join(root, name)); const current = await fs.lstat(directory);
    assert(current.isDirectory() && !current.isSymbolicLink() && current.uid === stat.uid && (current.mode & 0o777) === 0o700);
    assert.deepEqual({ device: String(current.dev), inode: String(current.ino) }, parent.directoryProofs[directory]);
    assert.equal(await fs.realpath(directory), directory);
  }
  assert.equal(process.env.DATA, parent.dataRoot); assert.equal(process.env.CANVAS_DATA_ROOT, parent.dataRoot); assert.equal(process.env.TMPDIR, parent.tmpRoot);
  assert.equal(process.env.CANVAS_APP_ROOT, parent.repo); assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  const database = new URL(process.env.DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(database.protocol)); assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '55433');
  assert.equal(parent.databaseName, `canvas_connection_test_${parent.nonce}`); assert.equal(database.pathname, `/${parent.databaseName}`);
  assert.equal(database.search + database.hash, ''); assert(parent.databaseOwner);
  const provider = new URL(process.env.CANVAS_SHARED_MCP_APPS_URL ?? '');
  assert.equal(provider.protocol, 'http:'); assert.equal(provider.hostname, '127.0.0.1'); assert.equal(provider.pathname, '/mcp');
  assert(provider.port && !['3001', '3100', '4001', '4004', '55433'].includes(provider.port)); assert.equal(provider.username + provider.password + provider.search + provider.hash, '');
  assert.match(process.env.CANVAS_SHARED_MCP_APPS_CONTROL_TOKEN ?? '', /^[A-Za-z0-9_-]{43}$/u);
  await assert.rejects(fs.lstat(path.join(root, 'render-repro-receipt.json')), { code: 'ENOENT' });
  return parent;
}

async function signInOwnedRenderReproActor(role: Actor['role'], email: string, password: string, expectedId?: string): Promise<Actor> {
  const api = await request.newContext({ baseURL: BASE, timeout: 60_000, extraHTTPHeaders: { Origin: BASE } });
  try {
    const response = await api.post('/api/auth/sign-in/email', { data: { email, password } }); assert.equal(response.status(), 200);
    const session = await api.get('/api/auth/get-session'); assert.equal(session.status(), 200);
    const current = await session.json() as { user: { id: string; email: string }; session: { id: string; expiresAt: string } };
    assert(ID.test(current.user.id) && ID.test(current.session.id)); assert.equal(current.user.email.toLowerCase(), email.toLowerCase());
    if (expectedId) assert.equal(current.user.id, expectedId);
    assert(new Date(current.session.expiresAt).getTime() > Date.now() + 30 * 60_000);
    const responseWs = await api.get('/api/workspaces'); assert.equal(responseWs.status(), 200);
    const workspaces = await responseWs.json() as ClientWorkspaceResponse;
    assert(workspaces.defaultWorkspace?.type === 'personal' && workspaces.defaultWorkspace.ownerUserId === current.user.id);
    return { role, api, userId: current.user.id, authSessionId: current.session.id, personalWorkspaceId: workspaces.defaultWorkspace.id, authClosed: false };
  } catch (error) {
    await withOwnedTestCleanup(async () => { throw error; }, [
      { label: 'signin-auth', run: async () => { const out = await api.post('/api/auth/sign-out', { data: {} }); assert.equal(out.status(), 200);
        const current = await api.get('/api/auth/get-session'); assert.equal(current.status(), 200); assert.equal(await current.json(), null); } },
      { label: 'signin-context', run: () => api.dispose() },
    ]);
    throw error;
  }
}

async function seedOwnedRenderReproInvocation(parent: Parent, receipt: Receipt, actor: Actor, agent: AgentProfile,
  connection: IntegrationConnectionDescriptor, sessionId: string, persist: () => Promise<void>): Promise<Invocation> {
  assert(parent.mobileRenderReproDeadline > Date.now() + 75_000);
  const toolCallId = `repro_${randomBytes(12).toString('hex')}`, input = path.join(parent.fixtureRoot, `${toolCallId}.json`);
  await fs.writeFile(input, JSON.stringify({ version: 1, nonce: parent.nonce, actorUserId: actor.userId, sessionId,
    agentId: agent.agentId, providerRef: createSharedIntegrationProviderRef(connection.resource), toolCallId }), { mode: 0o600, flag: 'wx' });
  const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/helpers/shared-mcp-apps-invocation-fixture.ts', input],
    { cwd: parent.repo, env: { ...process.env, NODE_ENV: 'test' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume(); child.stderr.resume(); // The seeder writes its public output privately; never copy diagnostic/raw output.
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => {}); // Preserve a spawn rejection until the protected closure path awaits it.
  const pid = child.pid ?? 0, entry = { pid, processGroupId: pid, closed: false };
  receipt.processes.push(entry);
  let groupVerified = false;
  const stop = (signal: NodeJS.Signals) => {
    if (pid <= 0 || child.pid !== pid || child.exitCode !== null || child.signalCode !== null) return;
    try { if (groupVerified) process.kill(-pid, signal); else child.kill(signal); } catch { /* A closure proof is still required. */ }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assert(pid > 0); await persist();
    const group = await promisify(execFile)('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { timeout: 15_000, maxBuffer: 4096 });
    assert.equal(Number(group.stdout.trim()), pid); groupVerified = true;
    const result = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => {
      stop('SIGTERM');
      reject(new Error('Owned saved-source deadline exceeded.'));
    }, Math.min(60_000, parent.mobileRenderReproDeadline - Date.now())); })]);
    assert.deepEqual(result, { code: 0, signal: null });
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      stop('SIGTERM');
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => { closeTimer = setTimeout(() => resolve(false), 15_000); })]);
      if (closeTimer) clearTimeout(closeTimer);
      if (!finished && child.pid === pid && child.exitCode === null && child.signalCode === null) {
        stop('SIGKILL');
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const killed = await Promise.race([closed.then(() => true), new Promise<boolean>(resolve => { killTimer = setTimeout(() => resolve(false), 5_000); })]);
        if (killTimer) clearTimeout(killTimer); assert(killed, 'The own saved-source process must actually close.');
      }
    }
    assert(pid > 0);
    for (const target of [pid, -pid]) { let absent = false; try { process.kill(target, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; } assert(absent); }
    entry.closed = true; await persist();
  }
  const output = await privateJson<Invocation>(input.replace(/\.json$/u, '.output.json'), 2 * 1024 * 1024);
  assert.deepEqual(Object.keys(output).sort(), ['descriptor', 'input', 'messageId', 'result', 'sequence']);
  assert.equal(output.descriptor.version, 2); assert.equal(output.descriptor.toolCallId, toolCallId);
  assert.equal(output.descriptor.connectionRef, connection.resource.connectionRef); assert.equal(output.descriptor.toolName, 'app_view');
  assert.equal(output.descriptor.resourceUri, 'ui://shared-app-fixture/design.html'); assert.match(output.descriptor.bindingRevision, /^[a-f0-9]{64}$/u);
  assert(Number.isSafeInteger(output.messageId) && output.messageId > 0 && Number.isSafeInteger(output.sequence) && output.sequence > 0);
  assert(!JSON.stringify(output).includes('mcpAppAuthority')); return output;
}

/** Real Cookie-auth HTTP and real saved MCP sources; this is never Native or model acceptance. */
async function runOwnedMobileRenderRepro() {
  const parent = await readOwnedRenderReproContext();
  const receipt: Receipt = { version: 1, nonce: parent.nonce, actorId: parent.actorId, deadline: parent.mobileRenderReproDeadline,
    acceptance: false, phase: 'setup', diagnosticPassed: false, closedContexts: false, authClosed: false, seedersClosed: false,
    ownedDatabasePools: 0, domainCleanup: 'pending', stage: 'ownership', actors: [], sessions: [], sources: [], processes: [], observations: [], cleanupErrors: [] };
  const file = path.join(parent.fixtureRoot, 'render-repro-receipt.json');
  const persist = async () => { const temporary = file + '.tmp'; await fs.writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 }); await fs.rename(temporary, file); };
  await persist();
  const actors: Actor[] = [], sources: Source[] = [], connections: IntegrationConnectionDescriptor[] = [];
  const control = await request.newContext({ timeout: 15_000 });
  let organizationId = '', teamId = '', agent: AgentProfile | undefined, originalCatalog: AiAppRuntimeCatalog | undefined;
  let originalBradley: unknown, originalFlag: boolean | undefined, ownedCatalogRevision = 0;
  let mainFailure: unknown;
  const checkDeadline = (reserve = 0) => assert(Date.now() + reserve < receipt.deadline, 'The original render diagnosis deadline was reached.');
  const api = async <T>(actor: Actor, url: string, method = 'GET', body?: unknown, status = 200, workspaceId?: string): Promise<T> => {
    checkDeadline(); const response = await actor.api.fetch(url, { method, ...(body === undefined ? {} : { data: body }),
      ...(workspaceId ? { headers: { 'X-Canvas-Workspace-Id': workspaceId } } : {}), timeout: Math.min(60_000, receipt.deadline - Date.now()) });
    if (response.status() !== status) throw Object.assign(new Error('An owned HTTP operation failed.'), { status: response.status() });
    const payload = await response.json() as { success: boolean; data: T };
    assert.equal(payload.success, true); assert(payload.data && typeof payload.data === 'object'); return payload.data;
  };
  const identity = async (actor: Actor) => {
    const response = await actor.api.get('/api/auth/get-session'); assert.equal(response.status(), 200);
    const value = await response.json() as { user: { id: string }; session: { id: string; expiresAt: string } };
    assert.equal(value.user.id, actor.userId); assert.equal(value.session.id, actor.authSessionId); assert(new Date(value.session.expiresAt).getTime() > Date.now());
  };
  const savedSource = async (source: Source) => {
    assert(agent);
    const response = await source.actor.api.get(`/api/sessions/messages?${new URLSearchParams({ sessionId: source.sessionId,
      agentId: agent.agentId, workspaceId: teamId, raw: 'true', limit: '10' })}`);
    assert.equal(response.status(), 200);
    const payload = await response.json() as { success: boolean; engine: string; messages: Array<Record<string, unknown>> };
    assert.equal(payload.success, true); assert.equal(payload.engine, 'pi'); assert.equal(payload.messages.length, 1);
    const message = payload.messages[0]; assert.equal(message.toolCallId, source.invocation.descriptor.toolCallId);
    assert.equal(message.id, source.invocation.messageId); assert.equal(message.sequence, source.invocation.sequence); assert.equal(message.role, 'toolResult');
    const invocation = readToolAppInvocation(message); assert(invocation?.kind === 'mcp');
    assert.deepEqual(invocation.descriptor, source.invocation.descriptor); assert.deepEqual(invocation.input, source.invocation.input);
    assert.deepEqual(invocation.result, source.invocation.result);
    assert(!JSON.stringify(message).includes('mcpAppAuthority'));
    const mobile = await source.actor.api.get(`/api/mobile/v1/sessions/${encodeURIComponent(source.sessionId)}/messages`,
      { headers: { 'X-Canvas-Workspace-Id': teamId } }); assert.equal(mobile.status(), 200);
    const rows = await mobile.json() as { success: boolean; messages: Array<{ id: string; sequence: number; toolCallId: string; display: { version: number; mcpApp: SharedMcpAppDescriptor } }> };
    assert.equal(rows.success, true); assert.equal(rows.messages.length, 1);
    assert.equal(rows.messages[0].id, String(source.invocation.messageId)); assert.equal(rows.messages[0].sequence, source.invocation.sequence);
    assert.equal(rows.messages[0].toolCallId, source.invocation.descriptor.toolCallId); assert.equal(rows.messages[0].display.version, 1);
    assert.deepEqual(rows.messages[0].display.mcpApp, source.invocation.descriptor);
  };
  const providerState = async (): Promise<ProviderCounts> => {
    const origin = new URL(process.env.CANVAS_SHARED_MCP_APPS_URL!).origin;
    const response = await control.get(`${origin}/__fixture/state`, { headers: { Authorization: `Bearer ${process.env.CANVAS_SHARED_MCP_APPS_CONTROL_TOKEN}` } });
    assert.equal(response.status(), 200);
    const value = await response.json() as { requests: string[]; calls: Array<{ name: string }>; resourceReads: string[]; verificationProbes: number };
    assert.deepEqual(Object.keys(value).sort(), ['calls', 'requests', 'resourceReads', 'verificationProbes']);
    assert(Array.isArray(value.requests) && Array.isArray(value.calls) && Array.isArray(value.resourceReads));
    return { requests: value.requests.length, sourceCalls: value.calls.filter(item => item.name === 'app_view').length,
      actions: value.calls.filter(item => item.name === 'app_action').length, modelCalls: value.calls.filter(item => item.name === 'model_only').length,
      resourceReads: value.resourceReads.length, verificationProbes: value.verificationProbes };
  };
  const assertNoBusiness = (counts: ProviderCounts) => { assert.equal(counts.actions, 0); assert.equal(counts.modelCalls, 0);
    assert.equal(counts.sourceCalls, 4); assert.equal(counts.verificationProbes, 1); };
  try {
    receipt.stage = 'owner-signin';
    const owner = await signInOwnedRenderReproActor('owner', process.env.TEST_LOGIN_EMAIL!, process.env.TEST_LOGIN_PASSWORD!, parent.actorId);
    actors.push(owner); receipt.actors.push({ role: owner.role, userId: owner.userId, authClosed: false });
    const workspacesResponse = await owner.api.get('/api/workspaces'); assert.equal(workspacesResponse.status(), 200);
    const workspaces = await workspacesResponse.json() as ClientWorkspaceResponse; organizationId = workspaces.defaultWorkspace!.organizationId!; assert(organizationId);
    originalBradley = await api(owner, '/api/agents?agentId=bradley&includeAccess=true');
    receipt.stage = 'membership';
    const proposal = await api<{ membershipId: string; approval: { required: boolean }; quote: { nonBillable: boolean } }>(owner,
      '/api/admin/organization/memberships', 'POST', { name: `Render manager ${parent.nonce}`, email: process.env.TEST_SECONDARY_EMAIL, role: 'member' }, 202);
    assert(ID.test(proposal.membershipId)); assert.equal(proposal.approval.required, false); assert.equal(proposal.quote.nonBillable, true);
    const activation = await api<{ membershipId: string; stage: string; execution: { onboardingInitialized: boolean } }>(owner,
      `/api/admin/organization/memberships/${encodeURIComponent(proposal.membershipId)}/activate`, 'POST', { password: process.env.TEST_SECONDARY_PASSWORD });
    assert.equal(activation.membershipId, proposal.membershipId); assert.equal(activation.stage, 'active'); assert.equal(activation.execution.onboardingInitialized, true);
    receipt.stage = 'manager-signin';
    const manager = await signInOwnedRenderReproActor('manager', process.env.TEST_SECONDARY_EMAIL!, process.env.TEST_SECONDARY_PASSWORD!);
    assert.notEqual(manager.userId, owner.userId); actors.push(manager); receipt.actors.push({ role: manager.role, userId: manager.userId, authClosed: false });
    receipt.stage = 'workspace';
    const teamResponse = await owner.api.post('/api/workspaces', { data: { type: 'team', name: `Render repro ${parent.nonce}` } }); assert.equal(teamResponse.status(), 201);
    const team = await teamResponse.json() as { success: boolean; workspace: { id: string; organizationId: string; type: string } };
    assert.equal(team.success, true); assert(ID.test(team.workspace.id)); assert.equal(team.workspace.organizationId, organizationId); assert.equal(team.workspace.type, 'team'); teamId = team.workspace.id;
    const joined = await owner.api.post(`/api/workspaces/${encodeURIComponent(teamId)}/members`, { data: { userId: manager.userId, role: 'member', canRead: true, canWrite: false, canManage: false } });
    assert.equal(joined.status(), 200); assert.equal((await joined.json()).success, true);
    receipt.stage = 'connections';
    for (const scope of ['organization', 'team'] as const) {
      const connection = (await api<{ connection: IntegrationConnectionDescriptor }>(owner,
        `/api/integrations/shared-connections?workspaceId=${encodeURIComponent(scope === 'team' ? teamId : owner.personalWorkspaceId)}`, 'POST', {
          source: 'mcp', ownership: scope === 'team' ? { type: scope, workspaceId: teamId } : { type: scope },
          displayName: `Render design ${parent.nonce}`, accessMode: 'restricted', allowedToolNames: APP_TOOLS,
          config: { url: process.env.CANVAS_SHARED_MCP_APPS_URL, auth: 'none' }, secrets: [],
          grants: actors.map(actor => ({ targetType: 'user', targetId: actor.userId, canUse: true, canManage: true, allowedToolNames: APP_TOOLS })),
        })).connection;
      assert.match(connection.resource.connectionRef, /^canvas-connection:[a-f0-9-]{36}$/u);
      assert.equal(connection.resource.ownership.type, scope); assert.equal(connection.resource.ownership.organizationId, organizationId);
      if (connection.resource.ownership.type === 'team') assert.equal(connection.resource.ownership.workspaceId, teamId);
      assert.equal(connection.resource.source, 'mcp'); assert.equal(connection.resource.status, 'active'); assert.equal(connection.resource.metadataRevision, 1);
      assert.equal(connection.resource.grantsRevision, 1); assert.equal(connection.resource.bindingRevision, 2); connections.push(connection);
    }
    assert.notEqual(connections[0].resource.connectionRef, connections[1].resource.connectionRef);
    receipt.stage = 'agent';
    const query = new URLSearchParams({ organizationId, workspaceId: teamId });
    agent = (await api<{ agent: AgentProfile }>(owner, `/api/agents?${query}`, 'POST', {
      name: `Render apps ${parent.nonce}`, scopeType: 'organization', enabledTools: ['mcp'], relevantSkills: [], relevantConnections: [],
      grants: actors.map(actor => ({ targetType: 'user', targetId: actor.userId, canUse: true, canEdit: false, canManage: false })),
    })).agent;
    assert(ID.test(agent.agentId)); assert.equal(agent.workflowRevision, 0); assert.equal(agent.createdByUserId, owner.userId);
    originalFlag = (await api<{ integrationToolGatewayEnabled: boolean }>(owner, '/api/admin/experimental-settings')).integrationToolGatewayEnabled;
    assert.equal((await api<{ integrationToolGatewayEnabled: boolean }>(owner, '/api/admin/experimental-settings', 'PATCH', { integrationToolGatewayEnabled: true })).integrationToolGatewayEnabled, true);
    receipt.stage = 'catalog';
    originalCatalog = (await api<{ catalog: AiAppRuntimeCatalog }>(owner, '/api/admin/agent-runtime/catalog')).catalog;
    const configured = (await api<{ catalog: AiAppRuntimeCatalog }>(owner, '/api/admin/agent-runtime/catalog', 'PUT', {
      expectedRevision: originalCatalog.revision, providers: [{ providerId: 'ollama', enabled: true, credentialScope: 'system', modelIds: ['shared-apps-fixture'],
        defaultModelId: 'shared-apps-fixture', config: { ollamaMode: 'local', ollamaHost: new URL(process.env.CANVAS_SHARED_MCP_APPS_URL!).origin,
          ollamaModelSource: 'custom', ollamaCustomModel: 'shared-apps-fixture' } }], defaultSelection: null,
    })).catalog;
    assert.equal(configured.providers.length, 1); const installation = configured.providers[0];
    const verified = await api<{ success: boolean; status: string }>(owner, `/api/admin/agent-runtime/providers/${encodeURIComponent(installation.installationId)}/verify`, 'POST');
    assert.equal(verified.success, true); assert.equal(verified.status, 'ready');
    const ready = (await api<{ catalog: AiAppRuntimeCatalog }>(owner, '/api/admin/agent-runtime/catalog')).catalog;
    const selected = (await api<{ catalog: AiAppRuntimeCatalog }>(owner, '/api/admin/agent-runtime/catalog', 'PUT', {
      expectedRevision: ready.revision, providers: [{ providerInstallationId: installation.installationId, providerId: 'ollama', enabled: true, credentialScope: 'system',
        modelIds: ['shared-apps-fixture'], defaultModelId: 'shared-apps-fixture', config: installation.config }],
      defaultSelection: { providerInstallationId: installation.installationId, providerId: 'ollama', modelId: 'shared-apps-fixture', thinkingLevel: 'off' },
    })).catalog;
    assert.equal(selected.providers[0].status, 'ready'); ownedCatalogRevision = selected.revision;
    for (const actor of actors) for (const connection of connections) {
      receipt.stage = 'session'; await identity(actor);
      checkDeadline();
      const response = await actor.api.post('/api/mobile/v1/sessions', {
        headers: { 'X-Canvas-Workspace-Id': teamId },
        data: { agentId: agent.agentId, title: `Render ${actor.role} ${connection.resource.ownership.type} ${parent.nonce}` },
        timeout: Math.min(60_000, receipt.deadline - Date.now()),
      });
      assert.equal(response.status(), 201);
      const created: { success: boolean; session: MobileChatSession } = await response.json();
      assert(created && typeof created === 'object' && created.session && typeof created.session.id === 'string' && ID.test(created.session.id));
      receipt.sessions.push({ role: actor.role, userId: actor.userId, agentId: agent.agentId, sessionId: created.session.id, deleted: false });
      await persist();
      assert.equal(created.success, true); assert.equal(created.session.agentId, agent.agentId);
      receipt.stage = 'saved-source';
      const invocation = await seedOwnedRenderReproInvocation(parent, receipt, actor, agent, connection, created.session.id, persist);
      const source: Source = { actor, connection, sessionId: created.session.id, invocation, digest: digest(invocation), deleted: false }; sources.push(source);
      receipt.sources.push({ role: actor.role, scope: connection.resource.ownership.type, connectionRef: connection.resource.connectionRef,
        sessionId: source.sessionId, toolCallId: invocation.descriptor.toolCallId, digest: source.digest, deleted: false }); await persist();
    }
    assert.equal(sources.length, 4); assertNoBusiness(await providerState());
    const baseline = connections.map(connection => digest(connection.resource));
    async function observeOwnedRenderRepro(source: Source, phase: 'warm' | 'cold') {
      await identity(source.actor); await savedSource(source); receipt.stage = phase === 'warm' ? 'warm-source' : 'cold-source';
      const detail = await source.actor.api.get(`/api/mobile/v1/integrations/shared-connections/${encodeURIComponent(source.connection.resource.connectionRef)}`,
        { headers: { 'X-Canvas-Workspace-Id': teamId }, timeout: Math.min(60_000, receipt.deadline - Date.now()) });
      const observation: Receipt['observations'][number] = { phase, role: source.actor.role, scope: source.connection.resource.ownership.type,
        sourceStatus: detail.status(), elapsedMs: 0, sourceImmutable: false }; receipt.observations.push(observation);
      assert.equal(detail.status(), 200);
      const payload = await detail.json() as { success: boolean; contractVersion: number; workspaceId: string; data: { connection: IntegrationConnectionDescriptor } };
      assert.equal(payload.success, true); assert.equal(payload.contractVersion, 2); assert.equal(payload.workspaceId, teamId);
      assert.equal(payload.data.connection.resource.connectionRef, source.connection.resource.connectionRef);
      assert.deepEqual(payload.data.connection.resource.ownership, source.connection.resource.ownership);
      assert.equal(digest(payload.data.connection.resource), baseline[connections.indexOf(source.connection)]);
      assert.equal(payload.data.connection.access.canUse, true); assert.equal(payload.data.connection.resource.status, 'active');
      assert.equal(digest(source.invocation), source.digest); observation.sourceImmutable = true;
      receipt.stage = phase === 'warm' ? 'warm-render' : 'cold-render'; const start = performance.now();
      let response: APIResponse;
      try { response = await source.actor.api.post(`/api/mobile/v1/sessions/${encodeURIComponent(source.sessionId)}/mcp-apps/render`,
        { headers: { 'X-Canvas-Workspace-Id': teamId }, data: { contractVersion: 1, toolCallId: source.invocation.descriptor.toolCallId, app: source.invocation.descriptor },
          timeout: Math.min(60_000, receipt.deadline - Date.now()) }); }
      catch (error) { observation.elapsedMs = Math.round(performance.now() - start); observation.errorClass = safeError(error); await persist(); throw error; }
      observation.elapsedMs = Math.round(performance.now() - start); observation.renderStatus = response.status();
      assert.equal(response.status(), 200); assert.match(response.headers()['cache-control'] ?? '', /no-store/u);
      const render = await response.json() as { success: boolean; contractVersion: number; workspaceId: string; sessionId: string; toolCallId: string;
        host: { url: string; origin: string; frameOrigin: string; channelId: string; nonce: string; expiresAt: number } };
      assert.equal(render.success, true); assert.equal(render.contractVersion, 1); assert.equal(render.workspaceId, teamId);
      assert.equal(render.sessionId, source.sessionId); assert.equal(render.toolCallId, source.invocation.descriptor.toolCallId);
      const host = new URL(render.host.url); assert.equal(host.origin, BASE); assert.match(host.pathname, /^\/__preview\/[A-Za-z0-9_-]{43}\/mobile-mcp\/host$/u);
      assert.equal(host.search + host.hash, ''); assert.equal(render.host.origin, BASE); assert.equal(render.host.frameOrigin, BASE);
      assert.match(render.host.channelId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u); assert.match(render.host.nonce, /^[A-Za-z0-9_-]{43}$/u);
      assert(render.host.expiresAt > Date.now() && render.host.expiresAt <= Date.now() + 300_000);
      // Read the real host document only, without running JavaScript, iframe, SDK or app tool calls.
      const hostResponse = await source.actor.api.get(render.host.url); assert.equal(hostResponse.status(), 200);
      const csp = hostResponse.headers()['content-security-policy'] ?? '';
      assert.match(csp, /default-src 'none'/u); assert.match(csp, /connect-src 'none'/u); assert.match(csp, /frame-ancestors 'none'/u);
      assert.match(csp, /frame-src http:\/\/127\.0\.0\.1:3001/u); observation.cspVerified = true;
      assert.equal(digest(source.invocation), source.digest); await persist();
    }
    receipt.phase = 'warm';
    for (const source of sources) { checkDeadline(60_000); await observeOwnedRenderRepro(source, 'warm'); }
    receipt.stage = 'idle'; receipt.phase = 'idle'; const before = await providerState(); assertNoBusiness(before);
    const startedAt = Date.now(); checkDeadline(11 * 60_000 + 5 * 60_000);
    await persist(); console.log('MOBILE_RENDER_REPRO_IDLE_BEGIN warm=4 idleMs=660000');
    await new Promise(resolve => setTimeout(resolve, 11 * 60_000));
    const finishedAt = Date.now(), after = await providerState();
    receipt.idle = { startedAt, finishedAt, durationMs: finishedAt - startedAt, before, after, noMcpRequests: before.requests === after.requests };
    assert(receipt.idle.durationMs >= 11 * 60_000); assert.deepEqual(after, before); await persist();
    receipt.phase = 'cold';
    for (const source of sources) { checkDeadline(60_000); await observeOwnedRenderRepro(source, 'cold'); }
    receipt.stage = 'baseline';
    for (const actor of actors) await identity(actor);
    for (const source of sources) { assert.equal(digest(source.invocation), source.digest); await savedSource(source); }
    receipt.providerFinal = await providerState(); assertNoBusiness(receipt.providerFinal);
    assert.equal(receipt.providerFinal.resourceReads, 8); assert.equal(receipt.observations.length, 8);
    receipt.diagnosticPassed = true;
    receipt.stage = 'cleanup-domain';
    async function cleanupOwnedRenderReproDomains() {
      assert(agent && originalCatalog && originalFlag !== undefined);
      for (const [index, source] of sources.entries()) {
        const response = await source.actor.api.delete(`/api/sessions?${new URLSearchParams({ agentId: agent.agentId, sessionId: source.sessionId })}`);
        assert.equal(response.status(), 200); assert.deepEqual(await response.json(), { success: true, deleted: source.sessionId });
        source.deleted = true; receipt.sources[index].deleted = true;
        receipt.sessions.find(value => value.sessionId === source.sessionId)!.deleted = true;
      }
      for (const actor of actors) { const listing = await actor.api.get(`/api/sessions?${new URLSearchParams({ agentId: agent.agentId })}`);
        assert.equal(listing.status(), 200); assert.deepEqual((await listing.json()).sessions, []); }
      for (const connection of connections) {
        const next = (await api<{ connection: IntegrationConnectionDescriptor }>(owner,
          `/api/integrations/shared-connections/${encodeURIComponent(connection.resource.connectionRef)}?workspaceId=${encodeURIComponent(teamId)}`, 'PATCH', {
            expectedMetadataRevision: connection.resource.metadataRevision, expectedGrantsRevision: connection.resource.grantsRevision,
            expectedBindingRevision: connection.resource.bindingRevision, status: 'archived',
          })).connection;
        assert.equal(next.resource.connectionRef, connection.resource.connectionRef); assert.equal(next.resource.status, 'archived');
      }
      const query = new URLSearchParams({ organizationId, workspaceId: teamId });
      const preview = await api<{ agent: AgentProfile; impacts: { sessions: number }; confirmationToken: string }>(owner,
        `/api/agents/delete-preview?${query}`, 'POST', { agentId: agent.agentId }); assert.equal(preview.impacts.sessions, 0);
      const deleted = await api(owner, `/api/agents?${query}`, 'DELETE', { agentId: agent.agentId, expectedRevision: preview.agent.revision, confirmationToken: preview.confirmationToken });
      assert.deepEqual(deleted, { deleted: true, agentId: agent.agentId });
      const current = (await api<{ catalog: AiAppRuntimeCatalog }>(owner, '/api/admin/agent-runtime/catalog')).catalog;
      assert.equal(current.revision, ownedCatalogRevision);
      const restored = (await api<{ catalog: AiAppRuntimeCatalog }>(owner, '/api/admin/agent-runtime/catalog', 'PUT', { expectedRevision: current.revision,
        providers: originalCatalog.providers.map(value => ({ providerInstallationId: value.installationId, providerId: value.providerId, enabled: value.enabled,
          credentialScope: value.credentialScope, config: value.config, modelIds: value.models.filter(model => model.enabled).map(model => model.id),
          defaultModelId: value.models.find(model => model.isProviderDefault)?.id ?? '' })), defaultSelection: originalCatalog.defaultSelection })).catalog;
      assert.deepEqual(restored.defaultSelection, originalCatalog.defaultSelection);
      assert.deepEqual(restored.providers.map(value => value.installationId), originalCatalog.providers.map(value => value.installationId));
      assert.equal((await api<{ integrationToolGatewayEnabled: boolean }>(owner, '/api/admin/experimental-settings', 'PATCH', { integrationToolGatewayEnabled: originalFlag })).integrationToolGatewayEnabled, originalFlag);
      assert.deepEqual(await api(owner, '/api/agents?agentId=bradley&includeAccess=true'), originalBradley);
      const removed = await owner.api.delete(`/api/workspaces/${encodeURIComponent(teamId)}`); assert.equal(removed.status(), 200); assert.deepEqual(await removed.json(), { success: true });
      receipt.domainCleanup = 'verified';
    }
    await cleanupOwnedRenderReproDomains();
  } catch (error) {
    mainFailure = error; receipt.diagnosticPassed = false; receipt.domainCleanup = 'preserved';
    receipt.failure = { stage: receipt.stage, errorClass: safeError(error),
      ...(Number.isInteger((error as { status?: number } | null)?.status) ? { status: (error as { status: number }).status } : {}) };
  } finally {
    receipt.stage = 'cleanup-auth';
    for (const actor of [...actors].reverse()) {
      try { await withOwnedTestCleanup(() => identity(actor), [{ label: `signout-${actor.role}`, run: async () => {
        const response = await actor.api.post('/api/auth/sign-out', { data: {}, timeout: 15_000 }); assert.equal(response.status(), 200);
        const current = await actor.api.get('/api/auth/get-session', { timeout: 15_000 }); assert.equal(current.status(), 200); assert.equal(await current.json(), null);
        actor.authClosed = true; receipt.actors.find(value => value.userId === actor.userId)!.authClosed = true;
      } }]); }
      catch { receipt.cleanupErrors.push(`auth-${actor.role}`); }
    }
    receipt.authClosed = actors.length > 0 && actors.every(actor => actor.authClosed);
    receipt.stage = 'cleanup-context';
    await withOwnedTestCleanup(async () => {}, [...actors.map(actor => ({ label: `context-${actor.role}`, run: () => actor.api.dispose() })),
      { label: 'provider-context', run: () => control.dispose() }]).then(() => { receipt.closedContexts = true; }, () => { receipt.cleanupErrors.push('contexts'); });
    receipt.seedersClosed = receipt.processes.every(value => value.closed);
    receipt.phase = !mainFailure && receipt.closedContexts && receipt.authClosed && receipt.seedersClosed && receipt.domainCleanup === 'verified'
      ? 'diagnosed_closed' : 'failed_closed';
    receipt.stage = 'receipt'; await persist();
  }
  // Returning a closed failure is explicit diagnostic data; the parent preserves its nonce DB/DATA.
  assert(receipt.closedContexts && receipt.authClosed && receipt.seedersClosed && receipt.cleanupErrors.length === 0);
  console.log(`MOBILE_RENDER_REPRO_CLOSED diagnosticPassed=${receipt.diagnosticPassed} warm=${receipt.observations.filter(value => value.phase === 'warm').length} cold=${receipt.observations.filter(value => value.phase === 'cold').length}`);
}

void runOwnedMobileRenderRepro().catch((error: unknown) => {
  console.error(`MOBILE_RENDER_REPRO_STOPPED class=${safeError(error)}`); process.exitCode = 1;
});
