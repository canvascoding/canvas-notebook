/** Root launches this fixed fixture. Importing it never starts a host, logs in or mutates SQL. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:https';
import JSZip from 'jszip';
import { request, type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import type { AgentProfile } from '../../app/lib/agents/registry';
import type { AgentWorkflowConfiguration, AgentWorkflowDescriptor } from '../../app/lib/agents/workflow-contracts';
import type { AgentWorkflowManagementPackageVersion } from '../../app/lib/agents/workflow-management-contracts';
import type { CapabilityResourceDescriptor } from '../../app/lib/capabilities/resources/contracts';
import type { CapabilityPackageDescriptor } from '../../app/lib/capabilities/packages/contracts';
import type { CapabilityPackageStoreApplicationResult, CapabilityPackageStoreSelection } from '../../app/lib/capabilities/packages/store-contracts';
import type { IntegrationConnectionDescriptor } from '../../app/lib/integration-tools/connections/contracts';
import type { AiAppRuntimeCatalog } from '../../app/lib/agent-runtime-policy/types';
import type { McpConfig } from '../../app/lib/mcp/config';
import type { McpAppDescriptor } from '../../app/lib/mcp/apps-types';
import { createSharedIntegrationProviderRef } from '../../app/lib/integration-tools/connections/provider-authorization';
import { IntegrationConnectionError } from '../../app/lib/integration-tools/connections/contracts';
import { withOwnedTestCleanup } from '../../tests/helpers/owned-test-cleanup';

type Parent = { version: 1; nonce: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; rootDevice: string; rootInode: string; databaseName: string; databaseOwner: string; actorId: string;
  createAcknowledged: boolean; listenerVerified: boolean; phase: string; uncertain: boolean; serverPid: number; mobileNative: true;
  directoryProofs: Record<string, { device: string; inode: string }> };
type User = { role: 'owner' | 'manager' | 'use-only'; userId: string; name: string; email: string; password: string;
  personalWorkspaceId: string; setupAuthSessionHash: string; api: APIRequestContext };
type Connection = { purpose: 'app' | 'oauth'; source: 'mcp' | 'composio'; scope: 'organization' | 'team'; value: IntegrationConnectionDescriptor };
type OwnedSession = { actor: User; agentId: string; sessionId: string; workspaceId: string; toolCallId: string; app: McpAppDescriptor; deleted: boolean };
type Receipt = { version: 1; nonce: string; actorId: string; phase: 'setup' | 'awaiting_native' | 'native_verified_closed' | 'preserved';
  outstanding: string | null; closedContexts: boolean; poolsClosed: boolean; seedersClosed: boolean; nativeAppClosed: boolean;
  memberships: string[]; users: string[]; workspaceIds: string[]; connectionRefs: string[]; profileIds: string[];
  resources: string[]; agents: string[]; acknowledgements: Array<{ method: string; path: string; status: number; responseHash: string }>;
  nativeEvidence?: Array<{ caseId: string; actorIds: string[]; platform: 'ios' | 'android'; buildNumber: number; evidence: string[] }>;
  sessions: Array<{ sessionId: string; agentId: string; userId: string; deleted: boolean }>;
  seeders: Array<{ pid: number; processGroupId: number; closed: boolean }>; checks?: Record<string, unknown>;
  httpDiagnostic?: { actualStatus: number; expectedStatus: number; method: string; pathname: string; code: string | null };
  connectionCheck?: { source: 'mcp' | 'composio'; purpose: 'app' | 'oauth'; scope: 'organization' | 'team'; connectionRef: string;
    metadataRevision: number | null; grantsRevision: number | null; bindingRevision: number | null; expectedBindingRevision: number };
  failure?: { stage: string; name: string; site?: string } };
type Fixture = { parent: Parent; receipt: Receipt; contexts: APIRequestContext[]; users: User[]; teamId: string; organizationId: string;
  connections: Connection[]; packages: CapabilityPackageStoreApplicationResult[]; appAgent?: AgentProfile; workflowAgent?: AgentProfile;
  personalAgent?: AgentProfile; personalConnectionId?: string; personalMcp?: McpConfig; sessions: OwnedSession[];
  manifest: Record<string, unknown>; originalBradley?: unknown; pool?: Pool; failureStage: string; abort: AbortController;
  childProcesses: Array<{ process: ChildProcess; proof: Receipt['seeders'][number] }> };
const BASE_URL = 'http://127.0.0.1:3001';
const ID = /^[A-Za-z0-9_-]{1,200}$/u;
const REF = /^canvas-connection:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const REQUIRED_CASES = ['personal-v1', 'scoped-resources', 'shared-connections', 'workflow-management', 'use-only-choice',
  'shared-app-approval', 'native-oauth-return', 'identity-lifetime'] as const;
const APP_TOOLS = ['app_view', 'app_action', 'model_only'];
const HASH = /^[a-f0-9]{64}$/u;
type OAuthObservation = { source: 'mcp' | 'composio'; connectionRef: string; scope: 'organization' | 'team'; flowId: string;
  actorUserId: string; workspaceId: string; authSessionHash: string; providerStateHash: string | null;
  status: string; checkedAt: number; revisions: { metadataRevision: number; grantsRevision: number; bindingRevision: number } };
type AppObservation = { callId: string; requestId: string; actorUserId: string; workspaceId: string; authSessionHash: string;
  sessionId: string; agentId: string; toolCallId: string; appVersion: 1 | 2; connectionRef: string | null; status: string; checkedAt: number };
/** Private Root input only: opaque correlations grant no product authority. */
export type OwnedMobileNativeCompletion = { version: 1; nonce: string; actorId: string; phase: 'native_verified'; acceptance: true;
  nativeAppClosed: true; appId: 'app.canvasnotebook.mobile.dev'; scheme: 'canvasnotebook-dev'; simulatorId: string;
  cases: NonNullable<Receipt['nativeEvidence']>;
  oauthCases: Array<Pick<OAuthObservation, 'source' | 'connectionRef' | 'flowId' | 'actorUserId' | 'workspaceId' | 'authSessionHash'> & { terminalStatus: 'completed' | 'cancelled' }>;
  appCases: Array<Pick<AppObservation, 'requestId' | 'sessionId' | 'toolCallId' | 'actorUserId' | 'workspaceId' | 'authSessionHash' | 'appVersion' | 'connectionRef'> & { status: 'completed' | 'rejected' }> };
export type OwnedMobileNativeStoreInstallCandidate = { platform: 'ios' | 'android'; entryKey: string; offeringDisplayName: string;
  expectedInitialInstalledName: string; sourceV1: CapabilityPackageStoreSelection; sourceV2: CapabilityPackageStoreSelection;
  selectedRoot: string; replacementRoot: string; siblingRoot: string };

/** Parent-only complete Store source. Real download/checksum/install services validate these bytes again. */
export async function createOwnedMobileNativePackageProvider(input: { root: string; nonce: string; intake: string; keyPath: string; certificatePath: string }) {
  assert.match(input.nonce, /^[a-f0-9]{32}$/u); assert.equal(await fs.realpath(input.root), input.root);
  const root = await fs.lstat(input.root); assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid?.() && (root.mode & 0o777) === 0o700);
  assert.equal(input.intake, path.join(input.root, 'data', 'workflow-editor-intake'));
  assert.equal(input.keyPath, path.join(input.root, 'tls-key.pem')); assert.equal(input.certificatePath, path.join(input.root, 'tls-cert.pem'));
  for (const file of [input.keyPath, input.certificatePath]) {
    assert.equal(await fs.realpath(file), file); const stat = await fs.lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === root.uid && (stat.mode & 0o777) === 0o600);
  }
  await fs.mkdir(input.intake, { recursive: true, mode: 0o700 });
  assert.equal(await fs.realpath(input.intake), input.intake);
  const { computeCanvasPluginChecksum } = await import('../../app/lib/plugins/canvas-plugin-registry');
  const { validateCompleteCapabilityPackage } = await import('../../app/lib/capabilities/packages/artifacts');
  const registryId = `native-store-${input.nonce}`;
  const archives = new Map<string, Buffer>(), sources: CapabilityPackageStoreSelection[] = [];
  const entries: Array<{ key: string; name: string; displayName: string; platform?: 'ios' | 'android' }> = [
    ...['organization', 'team'].map(scope => ({ key: scope, name: `native-contexts-${scope}-${input.nonce}`, displayName: `Native contexts ${input.nonce}` })),
    ...(['ios', 'android'] as const).map(platform => ({ key: `install-${platform}`, name: `native-install-${platform}-${input.nonce}`,
      displayName: `Native install ${platform} ${input.nonce}`, platform })),
  ];
  for (const entry of entries) for (const version of ['1.0.0', '2.0.0']) {
    const name = entry.name;
    const selected = version === '1.0.0' ? 'selected-context' : 'replacement-context';
    const source = path.join(input.intake, `${name}-${version}`);
    await fs.mkdir(source, { mode: 0o700 });
    const workflow = { version: 1, integrationCapabilities: [
      { id: 'fixed-design', application: 'canva', required: true, alternatives: [{ source: 'mcp', connector: 'design', requiredTools: ['app_view'] }] },
      { id: 'selectable-design', application: 'canva', required: true, alternatives: [
        { source: 'mcp', connector: 'design', requiredTools: ['app_view'] }, { source: 'composio', toolkit: 'canva', requiredTools: ['ASSET_LOOKUP'] },
      ] },
    ] };
    const files = new Map<string, Buffer>([
      ['.canvas-plugin/plugin.json', Buffer.from(JSON.stringify({ name, version, description: 'Owned native scope and workflow fixture', skills: 'skills',
        connectors: { mcp: [{ name: 'design', required: false }], composio: [{ toolkit: 'canva', required: false, tools: ['ASSET_LOOKUP'] }] } }))],
      ['README.md', Buffer.from(`Private native fixture ${input.nonce}; explicit published roots only.\n`)],
      [`skills/${selected}/SKILL.md`, Buffer.from(`---\nname: ${selected}\ndescription: Exact selected native context\nmetadata:\n  version: "${version}"\n---\nUse the explicit configured connection.\n`)],
      ['skills/unselected-context/SKILL.md', Buffer.from(`---\nname: unselected-context\ndescription: Context that must never be selected implicitly\nmetadata:\n  version: "${version}"\n---\nThis sibling is not part of the pinned selection.\n`)],
      [`skills/${selected}/agents/canvas.yaml`, Buffer.from(`workflow: ${JSON.stringify(workflow)}\n`)],
    ]);
    const zip = new JSZip();
    for (const [relative, bytes] of files) {
      const file = path.join(source, relative); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' }); zip.file(relative, bytes);
    }
    const validated = await validateCompleteCapabilityPackage('plugin', source, { name, version });
    const checksum = await computeCanvasPluginChecksum(source); assert.equal(validated.checksum, checksum);
    archives.set(`${entry.key}/${version}`, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    sources.push({ kind: 'plugin', registryId, entryKey: name, version, checksum });
  }
  let origin = '', closing: Promise<void> | undefined; const counters = { registryReads: 0, archiveReads: 0, rejected: 0 };
  const server = createServer({ key: await fs.readFile(input.keyPath), cert: await fs.readFile(input.certificatePath) }, (req, res) => {
    try {
      const url = new URL(req.url ?? '/', origin);
      if (req.method !== 'GET') { counters.rejected += 1; res.writeHead(405).end(); return; }
      if (url.pathname === '/registry.json' && url.search === `?owned-native=${input.nonce}`) {
        counters.registryReads += 1;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ schemaVersion: 1, id: registryId, name: 'Owned native Store', updatedAt: new Date().toISOString(),
          plugins: entries.map(entry => ({ name: entry.name, displayName: entry.displayName,
            description: 'Owned versioned native context', latestVersion: '2.0.0',
            versions: Object.fromEntries(sources.filter(value => value.entryKey === entry.name)
              .map(value => [value.version, { version: value.version, checksum: value.checksum,
                downloadUrl: `${origin}/${entry.key}/${value.version}.zip` }])) })), skills: [] })); return;
      }
      const archive = [...archives.entries()].find(([key]) => url.pathname === `/${key}.zip` && url.search === '');
      if (archive) { counters.archiveReads += 1; res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': archive[1].length, 'Cache-Control': 'no-store' }); res.end(archive[1]); return; }
      counters.rejected += 1; res.writeHead(404).end();
    } catch { counters.rejected += 1; if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string'); origin = `https://127.0.0.1:${address.port}`;
  const storeInstallCandidates: OwnedMobileNativeStoreInstallCandidate[] = entries.filter(entry => entry.platform !== undefined).map(entry => {
    const sourceV1 = sources.find(value => value.entryKey === entry.name && value.version === '1.0.0');
    const sourceV2 = sources.find(value => value.entryKey === entry.name && value.version === '2.0.0'); assert(sourceV1 && sourceV2 && entry.platform);
    return { platform: entry.platform, entryKey: entry.name, offeringDisplayName: entry.displayName, expectedInitialInstalledName: entry.name,
      sourceV1, sourceV2, selectedRoot: 'skills/selected-context', replacementRoot: 'skills/replacement-context', siblingRoot: 'skills/unselected-context' };
  });
  return { registryUrl: `${origin}/registry.json?owned-native=${input.nonce}`, sources, storeInstallCandidates, counters,
    close: () => closing ??= new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

async function readOwnedMobileNativeFixture(): Promise<Fixture> {
  assert.equal(process.env.CANVAS_MOBILE_PLUGIN_NATIVE_RUN, '1'); assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.__NEXT_PROCESSED_ENV, 'true'); assert.equal(process.env.BASE_URL, BASE_URL);
  const file = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
  assert(file && path.isAbsolute(file) && path.basename(file) === 'recovery.json');
  const rootPath = path.dirname(file), root = await fs.lstat(rootPath);
  assert(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid?.() && (root.mode & 0o777) === 0o700);
  assert.equal(await fs.realpath(rootPath), rootPath);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let parent: Parent;
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === root.uid && (stat.mode & 0o777) === 0o600 && stat.size < 64 * 1024);
    parent = JSON.parse(await handle.readFile('utf8')) as Parent;
  } finally { await handle.close(); }
  assert.equal(parent.version, 1); assert.match(parent.nonce, /^[a-f0-9]{32}$/u);
  assert.equal(parent.fixtureRoot, rootPath); assert.equal(parent.repo, await fs.realpath(process.cwd()));
  assert.equal(parent.rootDevice, String(root.dev)); assert.equal(parent.rootInode, String(root.ino));
  assert.equal(parent.createAcknowledged, true); assert.equal(parent.listenerVerified, true);
  assert.equal(parent.phase, 'browser'); assert.equal(parent.uncertain, false); assert.equal(parent.mobileNative, true);
  assert(ID.test(parent.actorId)); assert.equal(parent.databaseName, `canvas_connection_test_${parent.nonce}`);
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(databaseUrl.protocol)); assert.equal(databaseUrl.hostname, '127.0.0.1');
  assert.equal(databaseUrl.port, '55433'); assert.equal(databaseUrl.pathname, `/${parent.databaseName}`);
  assert.equal(databaseUrl.search, ''); assert.equal(databaseUrl.hash, ''); assert(databaseUrl.username);
  const marker = await fs.open(path.join(rootPath, '.fixture-owner'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await marker.stat(); assert(stat.isFile() && stat.nlink === 1 && stat.uid === root.uid && (stat.mode & 0o777) === 0o600);
    assert.equal(await marker.readFile('utf8'), parent.ownerMarker); } finally { await marker.close(); }
  for (const [directory, name] of [[parent.dataRoot, 'data'], [parent.tmpRoot, 'tmp']]) {
    assert.equal(directory, path.join(rootPath, name)); assert.equal(await fs.realpath(directory), directory);
    const stat = await fs.lstat(directory); assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === root.uid);
    assert.deepEqual({ device: String(stat.dev), inode: String(stat.ino) }, parent.directoryProofs[directory]);
  }
  assert.equal(process.env.DATA, parent.dataRoot); assert.equal(process.env.TMPDIR, parent.tmpRoot);
  assert.equal(process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT, path.join(parent.dataRoot, 'workflow-editor-intake'));
  assert(Number.isSafeInteger(parent.serverPid) && parent.serverPid > 0); process.kill(parent.serverPid, 0);
  for (const filename of ['native-receipt.json', 'native-setup.json', 'native-credentials.json', 'native-completion.json']) {
    await assert.rejects(fs.lstat(path.join(rootPath, filename)), { code: 'ENOENT' });
  }
  return { parent, contexts: [], users: [], teamId: '', organizationId: '', connections: [], packages: [], sessions: [], failureStage: 'setup',
    abort: new AbortController(), childProcesses: [],
    manifest: {}, receipt: { version: 1, nonce: parent.nonce, actorId: parent.actorId, phase: 'setup', outstanding: null,
      closedContexts: false, poolsClosed: false, seedersClosed: true, nativeAppClosed: false, memberships: [], users: [], workspaceIds: [],
      connectionRefs: [], profileIds: [], resources: [], agents: [], acknowledgements: [], sessions: [], seeders: [] } };
}

/** Normal HTTP transport with real BetterAuth cookies; no cached/mock identity or mutation retry. */
async function requestOwnedMobileNativeApi<T>(fixture: Fixture, api: APIRequestContext, pathname: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET', body?: unknown, status = 200, workspaceId?: string): Promise<T> {
  fixture.abort.signal.throwIfAborted(); assert(pathname.startsWith('/api/') && !pathname.startsWith('//') && !pathname.includes('#'));
  const url = new URL(pathname, BASE_URL); assert.equal(url.origin, BASE_URL);
  if (method !== 'GET') {
    assert.equal(fixture.receipt.outstanding, null); fixture.receipt.outstanding = `setup:${method}:${url.pathname}`;
    await fs.writeFile(path.join(fixture.parent.fixtureRoot, 'native-receipt.json'), JSON.stringify(fixture.receipt), { mode: 0o600 });
  }
  const response = await api.fetch(url.href, { method, ...(body === undefined ? {} : { data: body }),
    ...(workspaceId ? { headers: { 'X-Canvas-Workspace-Id': workspaceId } } : {}), timeout: 30_000, maxRedirects: 0 });
  const value: unknown = await response.json().catch(() => null);
  const code = value && typeof value === 'object' && !Array.isArray(value) ? Reflect.get(value, 'code') : undefined;
  // Only finite Canvas codes may leave the response; messages, bodies and headers never do.
  const allowedCodes = ['PACKAGE_NOT_FOUND', 'PACKAGE_ACCESS_DENIED', 'PACKAGE_READ_ONLY', 'PACKAGE_REQUEST_INVALID',
    'PACKAGE_PATH_INVALID', 'PACKAGE_LIMIT_EXCEEDED', 'PACKAGE_REVISION_CONFLICT', 'PACKAGE_DRAFT_CONFLICT',
    'PACKAGE_SOURCE_CHANGED', 'PACKAGE_INVALID', 'PACKAGE_SNAPSHOT_UNAVAILABLE', 'PACKAGE_NAMESPACE_CONFLICT',
    'CAPABILITY_RESOURCE_ACCESS_DENIED', 'CAPABILITY_RESOURCE_REVISION_CONFLICT', 'CAPABILITY_RESOURCE_BINDING_CONFLICT',
    'CAPABILITY_RESOURCE_NOT_FOUND', 'CAPABILITY_RESOURCE_INVALID', 'AGENT_CONFIGURATION_INVALID', 'AGENT_WORKFLOW_INVALID',
    'AGENT_ACCESS_DENIED', 'AGENT_NOT_FOUND', 'AGENT_REVISION_CONFLICT', 'AGENT_WORKFLOW_REVISION_CONFLICT',
    'CONNECTION_ACCESS_DENIED', 'CONNECTION_REVISION_CONFLICT', 'UNAUTHORIZED', 'INVALID_REQUEST',
    'CATALOG_READ_FAILED', 'CATALOG_WRITE_FAILED', 'PROVIDER_VERIFIED', 'REQUEST_BODY_NOT_ALLOWED',
    'SECRET_STORAGE_UNAVAILABLE', 'SECRET_REVISION_CONFLICT', 'SECRET_SETTINGS_RESERVED',
    'ACCOUNT_PREFERENCES_UPDATE_FAILED', 'UNSUPPORTED_LOCALE', 'invalid_request', 'connection_not_found',
    'binding_changed', 'outcome_unknown', 'rate_limit_exceeded'];
  fixture.receipt.httpDiagnostic = { actualStatus: response.status(), expectedStatus: status, method, pathname: url.pathname,
    code: typeof code === 'string' && allowedCodes.includes(code) ? code : null };
  await fs.writeFile(path.join(fixture.parent.fixtureRoot, 'native-receipt.json'), JSON.stringify(fixture.receipt), { mode: 0o600 });
  assert.equal(response.status(), status, `The normal fixture ${method} must receive the expected HTTP acknowledgement.`);
  assert(value && typeof value === 'object' && !Array.isArray(value));
  const record = value as { success?: unknown; data?: unknown };
  assert.equal(record.success, true, 'The normal fixture API must acknowledge success.');
  if ('data' in record) assert(record.data && typeof record.data === 'object');
  if (method !== 'GET') {
    fixture.receipt.acknowledgements.push({ method, path: url.pathname, status: response.status(), responseHash: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
    fixture.receipt.outstanding = null;
    await fs.writeFile(path.join(fixture.parent.fixtureRoot, 'native-receipt.json'), JSON.stringify(fixture.receipt), { mode: 0o600 });
  }
  return ('data' in record ? record.data : value) as T;
}

async function setupOwnedMobileNativeUsers(fixture: Fixture): Promise<void> {
  fixture.failureStage = 'normal-users';
  const nonce = fixture.parent.nonce;
  const identities = [
    { role: 'owner' as const, email: process.env.TEST_LOGIN_EMAIL, password: process.env.TEST_LOGIN_PASSWORD, name: 'Isolated Agent Settings Owner' },
    { role: 'manager' as const, email: process.env.TEST_EDITOR_EMAIL, password: process.env.TEST_EDITOR_PASSWORD, name: `Native manager ${nonce}` },
    { role: 'use-only' as const, email: process.env.TEST_SECONDARY_EMAIL, password: process.env.TEST_SECONDARY_PASSWORD, name: `Native user ${nonce}` },
  ];
  for (const identity of identities) {
    assert(identity.email && identity.password && identity.password.length >= 8);
    if (identity.role !== 'owner') {
      const proposed = await requestOwnedMobileNativeApi<{ membershipId: string; quote: { nonBillable: boolean }; approval: { required: boolean } }>(
        fixture, fixture.users[0].api, '/api/admin/organization/memberships', 'POST', { name: identity.name, email: identity.email, role: 'member' }, 202);
      assert(ID.test(proposed.membershipId)); fixture.receipt.memberships.push(proposed.membershipId);
      assert.equal(proposed.quote.nonBillable, true); assert.equal(proposed.approval.required, false);
      const activated = await requestOwnedMobileNativeApi<{ membershipId: string; stage: string; execution: { onboardingInitialized: boolean } }>(
        fixture, fixture.users[0].api, `/api/admin/organization/memberships/${encodeURIComponent(proposed.membershipId)}/activate`, 'POST', { password: identity.password });
      assert.equal(activated.membershipId, proposed.membershipId); assert.equal(activated.stage, 'active'); assert.equal(activated.execution.onboardingInitialized, true);
    }
    const api = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL }, timeout: 30_000 });
    fixture.contexts.push(api);
    const login = await api.post(`${BASE_URL}/api/auth/sign-in/email`, { data: { email: identity.email, password: identity.password }, maxRedirects: 0 });
    assert.equal(login.status(), 200, 'Fixture accounts must sign in normally.');
    const sessionResponse = await api.get(`${BASE_URL}/api/auth/get-session`); assert.equal(sessionResponse.status(), 200);
    const session = await sessionResponse.json() as { user: { id: string; email: string; name: string; role: string }; session: { id: string } };
    assert(ID.test(session.user.id) && ID.test(session.session.id)); assert.equal(session.user.email, identity.email);
    assert.equal(session.user.role, identity.role === 'owner' ? 'admin' : 'user');
    if (identity.role === 'owner') assert.equal(session.user.id, fixture.parent.actorId);
    assert(!fixture.users.some(user => user.userId === session.user.id));
    const workspaces = await requestOwnedMobileNativeApi<{ workspaces: Array<{ id: string; type: string; ownerUserId: string; organizationId: string; status: string }> }>(fixture, api, '/api/workspaces');
    const personal = workspaces.workspaces.find(value => value.type === 'personal' && value.ownerUserId === session.user.id && value.status === 'active');
    assert(personal && ID.test(personal.id) && personal.organizationId);
    if (!fixture.organizationId) fixture.organizationId = personal.organizationId; assert.equal(personal.organizationId, fixture.organizationId);
    const preferences = await requestOwnedMobileNativeApi<{ locale: string }>(fixture, api, '/api/mobile/v1/account/preferences', 'PATCH', { locale: 'en' });
    assert.equal(preferences.locale, 'en');
    const user: User = { role: identity.role, userId: session.user.id, name: session.user.name, email: identity.email,
      password: identity.password, personalWorkspaceId: personal.id, setupAuthSessionHash: createHash('sha256').update(session.session.id).digest('hex'), api };
    fixture.users.push(user); fixture.receipt.users.push(user.userId);
  }
  const owner = fixture.users[0];
  fixture.originalBradley = await requestOwnedMobileNativeApi(fixture, owner.api, '/api/agents?agentId=bradley&includeAccess=true');
  const created = await requestOwnedMobileNativeApi<{ workspace: { id: string; name: string; type: string; organizationId: string } }>(
    fixture, owner.api, '/api/workspaces', 'POST', { type: 'team', name: `Native plugins ${nonce}` }, 201);
  assert(ID.test(created.workspace.id)); fixture.teamId = created.workspace.id; fixture.receipt.workspaceIds.push(fixture.teamId);
  assert.equal(created.workspace.type, 'team'); assert.equal(created.workspace.organizationId, fixture.organizationId);
  for (const user of fixture.users.slice(1)) {
    await requestOwnedMobileNativeApi(fixture, owner.api, `/api/workspaces/${encodeURIComponent(fixture.teamId)}/members`, 'POST', {
      userId: user.userId, role: 'member', canRead: true, canWrite: false, canManage: false,
    });
  }
  await fs.writeFile(path.join(fixture.parent.fixtureRoot, 'native-credentials.json'), JSON.stringify({ version: 1, nonce,
    owner: { email: owner.email, password: owner.password },
    manager: { email: fixture.users[1].email, password: fixture.users[1].password },
    user: { email: fixture.users[2].email, password: fixture.users[2].password } }), { mode: 0o600, flag: 'wx' });
  fixture.manifest = { version: 1, nonce, baseUrl: BASE_URL, scheme: 'canvasnotebook-dev', appId: 'app.canvasnotebook.mobile.dev',
    organizationId: fixture.organizationId, teamId: fixture.teamId, teamName: created.workspace.name, locale: 'en',
    users: fixture.users.map(({ role, userId, name, email, personalWorkspaceId }) => ({ role, userId, name, email, personalWorkspaceId })) };
}

async function setupOwnedMobileNativeResources(fixture: Fixture): Promise<void> {
  fixture.failureStage = 'scoped-resources';
  const owner = fixture.users[0], manager = fixture.users[1], user = fixture.users[2], nonce = fixture.parent.nonce;
  const packageSources = JSON.parse(process.env.CANVAS_MOBILE_PLUGIN_NATIVE_PACKAGE_SOURCE ?? 'null') as CapabilityPackageStoreSelection[] | null;
  assert(Array.isArray(packageSources) && packageSources.length === 2);
  assert.deepEqual(packageSources.map(value => value.entryKey).sort(), [`native-contexts-organization-${nonce}`, `native-contexts-team-${nonce}`].sort());
  assert(packageSources.every(value => value.kind === 'plugin' && value.registryId === `native-store-${nonce}`
    && value.version === '1.0.0' && /^[a-f0-9]{64}$/u.test(value.checksum)));
  const scopeQuery = new URLSearchParams({ organizationId: fixture.organizationId, workspaceId: fixture.teamId });
  for (const scope of ['organization', 'team'] as const) {
    const packageSource: CapabilityPackageStoreSelection | undefined = packageSources.find(value => value.entryKey === `native-contexts-${scope}-${nonce}`);
    assert(packageSource);
    const installed: CapabilityPackageStoreApplicationResult = await requestOwnedMobileNativeApi<CapabilityPackageStoreApplicationResult>(fixture, owner.api,
      `/api/capabilities/packages/store/install?${scopeQuery}`, 'POST', { source: packageSource,
        ownership: scope === 'team' ? { type: 'team', workspaceId: fixture.teamId } : { type: 'organization' },
        responsibleUserId: manager.userId, grants: [
          { targetType: 'user', targetId: owner.userId, canUse: true, canEdit: true, canManage: true },
          { targetType: 'user', targetId: manager.userId, canUse: true, canEdit: true, canManage: true },
          { targetType: 'user', targetId: user.userId, canUse: true, canEdit: false, canManage: false },
        ] });
    assert(/^canvas-resource:[a-f0-9-]{36}$/u.test(installed.resource.resourceRef));
    fixture.packages.push(installed); fixture.receipt.resources.push(installed.resource.resourceRef);
    assert.equal(installed.published.resourceRef, installed.resource.resourceRef); assert.equal(installed.published.checksum, packageSource.checksum);
    const resource = (await requestOwnedMobileNativeApi<{ resource: CapabilityResourceDescriptor }>(fixture, owner.api,
      `/api/capabilities/resources/${encodeURIComponent(installed.resource.resourceRef)}?${scopeQuery}`)).resource;
    await requestOwnedMobileNativeApi(fixture, owner.api, `/api/capabilities/resources/${encodeURIComponent(installed.resource.resourceRef)}?${scopeQuery}`, 'PATCH', {
      expectedMetadataRevision: resource.metadata.metadataRevision, expectedGrantsRevision: resource.metadata.grantsRevision,
      metadata: { displayName: `Native contexts ${nonce}` },
    });
    const currentResource = (await requestOwnedMobileNativeApi<{ resource: CapabilityResourceDescriptor }>(fixture, owner.api,
      `/api/capabilities/resources/${encodeURIComponent(installed.resource.resourceRef)}?${scopeQuery}`)).resource;
    const currentPackage = (await requestOwnedMobileNativeApi<{ package: CapabilityPackageDescriptor }>(fixture, owner.api,
      `/api/capabilities/packages/${encodeURIComponent(installed.resource.resourceRef)}?${scopeQuery}`)).package;
    assert(currentPackage.state && currentPackage.state.currentPublishedRevisionRef === installed.published.revisionRef);
    await requestOwnedMobileNativeApi(fixture, owner.api,
      `/api/capabilities/packages/${encodeURIComponent(installed.resource.resourceRef)}/activation?${scopeQuery}`, 'PATCH', {
        enabled: true, expectedDefaultEnabled: currentPackage.defaultEnabled,
        expectedMetadataRevision: currentResource.metadata.metadataRevision, expectedGrantsRevision: currentResource.metadata.grantsRevision,
        expectedPackageRevision: currentPackage.state.packageRevision, expectedPublishedRevisionRef: installed.published.revisionRef,
      });
  }
  const secret = await requestOwnedMobileNativeApi<{ revision: string; entries: Array<{ key: string }> }>(fixture, owner.api,
    '/api/integrations/env?scope=integrations&secretScope=organization&key=COMPOSIO_API_KEY');
  assert(!secret.entries.some(value => value.key === 'COMPOSIO_API_KEY'));
  await requestOwnedMobileNativeApi(fixture, owner.api, '/api/integrations/env', 'PATCH', { scope: 'integrations', secretScope: 'organization',
    baseRevision: secret.revision, patches: [{ key: 'COMPOSIO_API_KEY', value: `own-native-mobile-${randomBytes(16).toString('hex')}` }] });
  for (const scope of ['organization', 'team'] as const) {
    const ownership = scope === 'team' ? { type: 'team' as const, workspaceId: fixture.teamId } : { type: 'organization' as const };
    const query = new URLSearchParams({ workspaceId: scope === 'team' ? fixture.teamId : owner.personalWorkspaceId });
    const profile = (await requestOwnedMobileNativeApi<{ profile: { id: string; createdByUserId: string } }>(fixture, owner.api,
      `/api/composio/shared-profiles?${query}`, 'POST', { name: `Native ${scope} ${nonce}`, ownership, providerMode: 'local' })).profile;
    assert(ID.test(profile.id)); fixture.receipt.profileIds.push(profile.id); assert.equal(profile.createdByUserId, owner.userId);
    for (const variant of [
      { source: 'mcp' as const, purpose: 'app' as const, displayName: `Native design ${nonce}`, config: { url: process.env.CANVAS_SHARED_MCP_APPS_URL, auth: 'none' }, tools: APP_TOOLS },
      { source: 'mcp' as const, purpose: 'oauth' as const, displayName: `Native MCP sign-in ${nonce}`, config: { url: process.env.CANVAS_MOBILE_PLUGIN_NATIVE_MCP_OAUTH_URL, transport: 'http', auth: 'oauth' }, tools: ['echo'] },
      { source: 'composio' as const, purpose: 'oauth' as const, displayName: `Native Canva ${nonce}`, config: undefined, tools: ['ASSET_LOOKUP', 'DESIGN_CREATE'] },
    ]) {
      const input = { source: variant.source, ownership, displayName: variant.displayName,
        description: `Owned native ${scope} ${variant.source} ${variant.purpose} ${nonce}`, accessMode: 'restricted', allowedToolNames: variant.tools,
        ...(variant.source === 'mcp' ? { config: variant.config, secrets: [] } : { profileId: profile.id, toolkit: 'canva' }),
        grants: [
          { targetType: 'user', targetId: owner.userId, canUse: true, canManage: true, allowedToolNames: variant.tools },
          { targetType: 'user', targetId: manager.userId, canUse: true, canManage: true, allowedToolNames: variant.tools },
          { targetType: 'user', targetId: user.userId, canUse: true, canManage: false, allowedToolNames: variant.tools },
        ] };
      const value = (await requestOwnedMobileNativeApi<{ connection: IntegrationConnectionDescriptor }>(fixture, owner.api,
        `/api/integrations/shared-connections?${query}`, 'POST', input)).connection;
      assert(REF.test(value.resource.connectionRef)); fixture.receipt.connectionRefs.push(value.resource.connectionRef);
      fixture.connections.push({ scope, purpose: variant.purpose, source: variant.source, value });
      const expectedBindingRevision: number = variant.source === 'mcp' ? 2 : 1;
      fixture.receipt.connectionCheck = { source: variant.source, purpose: variant.purpose, scope, connectionRef: value.resource.connectionRef,
        metadataRevision: Number.isSafeInteger(value.resource.metadataRevision) ? value.resource.metadataRevision : null,
        grantsRevision: Number.isSafeInteger(value.resource.grantsRevision) ? value.resource.grantsRevision : null,
        bindingRevision: Number.isSafeInteger(value.resource.bindingRevision) ? value.resource.bindingRevision : null, expectedBindingRevision };
      await fs.writeFile(path.join(fixture.parent.fixtureRoot, 'native-receipt.json'), JSON.stringify(fixture.receipt), { mode: 0o600 });
      assert.equal(value.resource.source, variant.source); assert.equal(value.resource.createdByUserId, owner.userId);
      assert.equal(value.resource.ownership.type, scope); assert.equal(value.resource.metadataRevision, 1); assert.equal(value.resource.grantsRevision, 1);
      assert.equal(value.resource.bindingRevision, expectedBindingRevision);
    }
  }
  await requestOwnedMobileNativeApi(fixture, owner.api, '/api/admin/experimental-settings', 'PATCH', { integrationToolGatewayEnabled: true });
  const original = (await requestOwnedMobileNativeApi<{ catalog: AiAppRuntimeCatalog }>(fixture, owner.api, '/api/admin/agent-runtime/catalog')).catalog;
  const configured = (await requestOwnedMobileNativeApi<{ catalog: AiAppRuntimeCatalog }>(fixture, owner.api, '/api/admin/agent-runtime/catalog', 'PUT', {
    expectedRevision: original.revision, providers: [{ providerId: 'ollama', enabled: true, credentialScope: 'system', modelIds: ['shared-apps-fixture'], defaultModelId: 'shared-apps-fixture',
      config: { ollamaMode: 'local', ollamaHost: new URL(process.env.CANVAS_SHARED_MCP_APPS_URL!).origin, ollamaModelSource: 'custom', ollamaCustomModel: 'shared-apps-fixture' } }], defaultSelection: null,
  })).catalog;
  assert.equal(configured.providers.length, 1); const installation = configured.providers[0];
  const verified = await requestOwnedMobileNativeApi<{ success: boolean; status: string }>(fixture, owner.api,
    `/api/admin/agent-runtime/providers/${encodeURIComponent(installation.installationId)}/verify`, 'POST');
  assert.equal(verified.status, 'ready');
  const ready = (await requestOwnedMobileNativeApi<{ catalog: AiAppRuntimeCatalog }>(fixture, owner.api, '/api/admin/agent-runtime/catalog')).catalog;
  await requestOwnedMobileNativeApi(fixture, owner.api, '/api/admin/agent-runtime/catalog', 'PUT', { expectedRevision: ready.revision,
    providers: [{ providerInstallationId: installation.installationId, providerId: 'ollama', enabled: true, credentialScope: 'system', modelIds: ['shared-apps-fixture'], defaultModelId: 'shared-apps-fixture', config: installation.config }],
    defaultSelection: { providerInstallationId: installation.installationId, providerId: 'ollama', modelId: 'shared-apps-fixture', thinkingLevel: 'off' } });
  fixture.manifest.packages = fixture.packages.map((value, index) => ({ scope: index === 0 ? 'organization' : 'team',
    resourceRef: value.resource.resourceRef, displayName: `Native contexts ${nonce}`, publishedRevisionRef: value.published.revisionRef,
    checksum: value.published.checksum, version: value.published.version, selectedRoot: 'skills/selected-context', siblingRoot: 'skills/unselected-context' }));
  fixture.manifest.connections = fixture.connections.map(({ scope, purpose, source, value }) => ({ scope, purpose, source,
    connectionRef: value.resource.connectionRef, displayName: value.resource.displayName, description: value.resource.description, metadataRevision: value.resource.metadataRevision,
    grantsRevision: value.resource.grantsRevision, bindingRevision: value.resource.bindingRevision, ownership: value.resource.ownership,
    ownershipLabel: typeof Reflect.get(value, 'ownershipLabel') === 'string' ? Reflect.get(value, 'ownershipLabel') as string : null }));
  fixture.manifest.providerOrigins = { mcp: process.env.CANVAS_MOBILE_PLUGIN_NATIVE_MCP_OAUTH_ORIGIN,
    composio: process.env.CANVAS_SHARED_COMPOSIO_NATIVE_PROVIDER_ORIGIN };
  fixture.manifest.publicCertificatePath = process.env.CANVAS_MOBILE_PLUGIN_NATIVE_TLS_CERT;
  fixture.manifest.storeVersions = JSON.parse(process.env.CANVAS_MOBILE_PLUGIN_NATIVE_PACKAGE_VERSIONS ?? 'null') as unknown;
  const storeCandidates = JSON.parse(process.env.CANVAS_MOBILE_PLUGIN_NATIVE_STORE_INSTALL_CANDIDATES ?? 'null') as OwnedMobileNativeStoreInstallCandidate[] | null;
  assert(Array.isArray(storeCandidates) && storeCandidates.length === 2);
  assert.deepEqual(storeCandidates.map(value => value.platform).sort(), ['android', 'ios']);
  for (const candidate of storeCandidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ['entryKey', 'expectedInitialInstalledName', 'offeringDisplayName', 'platform',
      'replacementRoot', 'selectedRoot', 'siblingRoot', 'sourceV1', 'sourceV2']);
    assert.equal(candidate.entryKey, `native-install-${candidate.platform}-${nonce}`);
    assert.equal(candidate.expectedInitialInstalledName, candidate.entryKey);
    assert.equal(candidate.offeringDisplayName, `Native install ${candidate.platform} ${nonce}`);
    for (const [source, version] of [[candidate.sourceV1, '1.0.0'], [candidate.sourceV2, '2.0.0']] as const) {
      assert.deepEqual(Object.keys(source).sort(), ['checksum', 'entryKey', 'kind', 'registryId', 'version']);
      assert.equal(source.kind, 'plugin'); assert.equal(source.entryKey, candidate.entryKey); assert.equal(source.registryId, `native-store-${nonce}`);
      assert.equal(source.version, version); assert(HASH.test(source.checksum));
    }
    assert.equal(candidate.selectedRoot, 'skills/selected-context'); assert.equal(candidate.replacementRoot, 'skills/replacement-context');
    assert.equal(candidate.siblingRoot, 'skills/unselected-context');
  }
  fixture.manifest.storeInstallCandidates = storeCandidates;
}

async function setupOwnedMobileNativeWorkflow(fixture: Fixture): Promise<void> {
  fixture.failureStage = 'workflow';
  const owner = fixture.users[0], manager = fixture.users[1], user = fixture.users[2];
  const query = new URLSearchParams({ workspaceId: fixture.teamId, organizationId: fixture.organizationId });
  const grants = [
    { targetType: 'user', targetId: manager.userId, canUse: true, canEdit: true, canManage: true },
    { targetType: 'user', targetId: user.userId, canUse: true, canEdit: false, canManage: false },
  ];
  for (const kind of ['workflow', 'apps'] as const) {
    const value = (await requestOwnedMobileNativeApi<{ agent: AgentProfile }>(fixture, owner.api, `/api/agents?${query}`, 'POST', {
      name: `Native ${kind} ${fixture.parent.nonce}`, scopeType: 'organization', enabledTools: ['mcp'], relevantSkills: [], relevantConnections: [], grants,
    })).agent;
    assert(ID.test(value.agentId)); fixture.receipt.agents.push(value.agentId);
    if (kind === 'workflow') fixture.workflowAgent = value; else fixture.appAgent = value;
  }
  assert(fixture.workflowAgent);
  const version = await requestOwnedMobileNativeApi<AgentWorkflowManagementPackageVersion>(fixture, owner.api,
    `/api/agents/workflow?${new URLSearchParams({ ...Object.fromEntries(query), agentId: fixture.workflowAgent.agentId, view: 'package-version',
      expectedRevision: String(fixture.workflowAgent.revision), expectedWorkflowRevision: String(fixture.workflowAgent.workflowRevision ?? 0),
      resourceRef: fixture.packages[0].resource.resourceRef, publishedRevisionRef: fixture.packages[0].published.revisionRef })}`);
  assert.equal(version.view, 'package-version'); assert.equal(version.checksum, fixture.packages[0].published.checksum);
  const selected = version.skillRoots.find(value => value.relativeRoot === 'skills/selected-context'); assert(selected);
  const declaration = version.declarations.find(value => value.declarationPath === 'skills/selected-context/agents/canvas.yaml'); assert(declaration);
  assert.deepEqual(declaration.workflow.integrationCapabilities.map(value => value.id), ['fixed-design', 'selectable-design']);
  const organization = fixture.connections.find(value => value.scope === 'organization' && value.purpose === 'app');
  const team = fixture.connections.find(value => value.scope === 'team' && value.purpose === 'app'); assert(organization && team);
  const target = { kind: 'shared' as const, source: 'mcp' as const, connectionRef: organization.value.resource.connectionRef,
    bindingRevision: organization.value.resource.bindingRevision, mcpMapping: { kind: 'manager_confirmation' as const } };
  const workflow: AgentWorkflowConfiguration = { version: 1, packages: [{ resourceRef: version.resourceRef,
    publishedRevisionRef: version.publishedRevisionRef, checksum: version.checksum, skillSelection: { kind: 'skills', relativeRoots: [selected.relativeRoot] },
    declarations: [{ declarationPath: declaration.declarationPath, capabilities: [
      { capabilityId: 'fixed-design', required: true, selection: { mode: 'fixed', alternativeKey: 'mcp:design', target, toolCap: null } },
      { capabilityId: 'selectable-design', required: true, selection: { mode: 'selectable', allowedChoices: [
        { choiceId: 'org-design', alternativeKey: 'mcp:design', target, toolCap: null },
        { choiceId: 'team-design', alternativeKey: 'mcp:design', target: { ...target, connectionRef: team.value.resource.connectionRef,
          bindingRevision: team.value.resource.bindingRevision }, toolCap: null },
      ], defaultChoiceId: 'org-design', personalPolicy: { sources: ['composio'], alternativeKeys: ['composio:canva'], toolCap: ['ASSET_LOOKUP'] } } },
    ] }] }] };
  const configured = (await requestOwnedMobileNativeApi<{ agent: AgentProfile }>(fixture, owner.api, `/api/agents?${query}`, 'PATCH', {
    agentId: fixture.workflowAgent.agentId, expectedRevision: fixture.workflowAgent.revision,
    expectedWorkflowRevision: fixture.workflowAgent.workflowRevision ?? 0, workflow,
  })).agent;
  assert.equal(configured.agentId, fixture.workflowAgent.agentId); assert.equal(configured.revision, fixture.workflowAgent.revision + 1);
  fixture.workflowAgent = configured;
  const own = await requestOwnedMobileNativeApi<AgentWorkflowDescriptor>(fixture, user.api, `/api/agents/workflow?${query}&agentId=${configured.agentId}`);
  assert.equal(own.access.canUse, true); assert.equal(own.access.canEdit, false); assert.equal(own.access.canManage, false);
  fixture.manifest.workflow = { agentId: configured.agentId, name: configured.name, revision: configured.revision,
    workflowRevision: configured.workflowRevision, package: fixture.manifest.packages,
    capabilities: own.packages.flatMap(value => value.declarations.flatMap(item => item.capabilities.map(capability => ({
      capabilityId: capability.capabilityId, capabilityKey: capability.capabilityKey, application: capability.application,
      choices: capability.choices.map(choice => ({ choiceId: choice.choiceId, label: choice.label, scopeLabel: choice.scopeLabel })),
      defaultChoiceId: capability.selectedChoiceId,
    })))) };
  fixture.manifest.appAgent = { agentId: fixture.appAgent!.agentId, name: fixture.appAgent!.name };
}

async function seedOwnedMobileNativeApps(fixture: Fixture): Promise<void> {
  fixture.failureStage = 'saved-app-sources';
  const owner = fixture.users[0], manager = fixture.users[1], user = fixture.users[2]; assert(fixture.appAgent);
  const personal = await requestOwnedMobileNativeApi<{ rawContent: string }>(fixture, owner.api, '/api/integrations/mcp-config');
  const original = JSON.parse(personal.rawContent) as McpConfig; assert.equal(Object.keys(original.mcpServers).length, 0);
  const name = `native_${fixture.parent.nonce}`;
  const configured = await requestOwnedMobileNativeApi<{ rawContent: string }>(fixture, owner.api, '/api/integrations/mcp-config', 'PUT', {
    rawContent: JSON.stringify({ ...original, mcpServers: { [name]: { url: process.env.CANVAS_SHARED_MCP_APPS_URL, auth: 'none', enabled: true, displayName: `Native personal ${fixture.parent.nonce}` } } }),
  });
  const config = JSON.parse(configured.rawContent) as McpConfig;
  assert(config.mcpServers[name]?.connectionId && config.mcpServers[name].ownerUserId === owner.userId);
  fixture.personalConnectionId = config.mcpServers[name].connectionId; fixture.personalMcp = original;
  const query = new URLSearchParams({ organizationId: fixture.organizationId, workspaceId: owner.personalWorkspaceId });
  const personalAgent = (await requestOwnedMobileNativeApi<{ agent: AgentProfile }>(fixture, owner.api, `/api/agents?${query}`, 'POST', {
    name: `Native personal ${fixture.parent.nonce}`, scopeType: 'user', enabledTools: ['mcp'], relevantSkills: [], relevantConnections: [],
  })).agent;
  assert(ID.test(personalAgent.agentId)); fixture.personalAgent = personalAgent; fixture.receipt.agents.push(personalAgent.agentId);
  const shared = fixture.connections.filter(value => value.purpose === 'app'); assert.equal(shared.length, 2);
  for (const [index, seed] of [
    { actor: owner, agent: personalAgent, workspaceId: owner.personalWorkspaceId, connection: undefined },
    { actor: manager, agent: fixture.appAgent, workspaceId: fixture.teamId, connection: shared[0] },
    { actor: manager, agent: fixture.appAgent, workspaceId: fixture.teamId, connection: shared[1] },
    { actor: user, agent: fixture.appAgent, workspaceId: fixture.teamId, connection: shared[1] },
  ].entries()) {
    const created = await requestOwnedMobileNativeApi<{ session: { id: string; agentId: string } }>(fixture, seed.actor.api,
      '/api/mobile/v1/sessions', 'POST', { agentId: seed.agent.agentId, title: `Native ${index} ${fixture.parent.nonce}` }, 201, seed.workspaceId);
    assert(ID.test(created.session.id)); fixture.receipt.sessions.push({ sessionId: created.session.id, agentId: seed.agent.agentId, userId: seed.actor.userId, deleted: false });
    assert.equal(created.session.agentId, seed.agent.agentId);
    const toolCallId = `native-app-${index}-${randomBytes(8).toString('hex')}`;
    const inputFile = path.join(fixture.parent.fixtureRoot, `native-invocation-${index}.json`);
    let providerRef: string | undefined;
    if (seed.connection) providerRef = createSharedIntegrationProviderRef(seed.connection.value.resource);
    const input = { version: 1, nonce: fixture.parent.nonce, actorUserId: seed.actor.userId, sessionId: created.session.id,
      agentId: seed.agent.agentId, toolCallId, ...(seed.connection ? { providerRef } : { connectionId: fixture.personalConnectionId }) };
    await fs.writeFile(inputFile, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
    const filename = seed.connection ? 'shared-mcp-apps-invocation-fixture.ts' : 'mobile-mcp-apps-invocation-fixture.ts';
    fixture.receipt.outstanding = `seeder:${index}`; fixture.receipt.seedersClosed = false;
    const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', `scripts/helpers/${filename}`, inputFile], {
      cwd: fixture.parent.repo, env: { ...process.env, CANVAS_SHARED_MCP_APPS_BROWSER_RUN: seed.connection ? '1' : undefined,
        CANVAS_MOBILE_MCP_APPS_BROWSER_RUN: seed.connection ? undefined : '1' }, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    });
    assert(child.pid && Number.isSafeInteger(child.pid)); const pid = child.pid;
    const owned = { pid, processGroupId: 0, closed: false }; fixture.receipt.seeders.push(owned);
    fixture.childProcesses.push({ process: child, proof: owned });
    await fs.writeFile(path.join(fixture.parent.fixtureRoot, 'native-receipt.json'), JSON.stringify(fixture.receipt), { mode: 0o600 });
    const processGroup = await new Promise<string>((resolve, reject) => {
      execFile('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 }, (error, output) => error ? reject(error) : resolve(output.trim()));
    });
    assert.equal(Number(processGroup), pid, 'The actual owned child must acknowledge its issued process group.');
    owned.processGroupId = Number(processGroup);
    await fs.writeFile(path.join(fixture.parent.fixtureRoot, 'native-receipt.json'), JSON.stringify(fixture.receipt), { mode: 0o600 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await new Promise<number | null>((resolve, reject) => {
      timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-owned.processGroupId, 'SIGTERM'); } catch { /* Preserve the missing closure acknowledgement. */ } }
        reject(new Error('The issued saved-invocation child exceeded its deadline.')); }, 120_000);
      child.once('error', reject); child.once('close', resolve);
    }).finally(() => { if (timer) clearTimeout(timer); });
    assert.equal(code, 0, 'Only an actual successful gateway/SDK saved invocation can seed a native card.');
    assert.equal(child.exitCode, 0);
    assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' }); owned.closed = true; fixture.receipt.seedersClosed = true;
    const outputPath = inputFile.slice(0, -5) + '.output.json', handle = await fs.open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let output: { descriptor?: McpAppDescriptor; result?: unknown; messageId?: number };
    try {
      const stat = await handle.stat(); assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size < 1024 * 1024);
      output = JSON.parse(await handle.readFile('utf8')) as typeof output;
    } finally { await handle.close(); }
    assert(output.descriptor && Number.isSafeInteger(output.messageId) && output.result);
    assert.equal(output.descriptor.version, seed.connection ? 2 : 1);
    if (output.descriptor.version === 2) {
      assert.equal(output.descriptor.connectionRef, seed.connection!.value.resource.connectionRef); assert.equal(output.descriptor.toolCallId, toolCallId);
    } else assert.equal(output.descriptor.connectionId, fixture.personalConnectionId);
    fixture.sessions.push({ actor: seed.actor, agentId: seed.agent.agentId, sessionId: created.session.id, workspaceId: seed.workspaceId,
      toolCallId, app: output.descriptor, deleted: false }); fixture.receipt.outstanding = null;
  }
  fixture.manifest.sessions = fixture.sessions.map(value => ({ actorUserId: value.actor.userId, role: value.actor.role,
    sessionId: value.sessionId, agentId: value.agentId, workspaceId: value.workspaceId, app: value.app,
    url: `canvasnotebook-dev://chat/${encodeURIComponent(value.sessionId)}?workspaceId=${encodeURIComponent(value.workspaceId)}` }));
}


/** Cleanup-only authentication after all original native/counter/SQL checks. No proof identity is replaced. */
export async function prepareOwnedMobileNativeCleanupAuthentication(fixture: Fixture, actor: User) {
  fixture.abort.signal.throwIfAborted();
  type Session = { user: { id: string; email: string; role: string }; session: { id: string; expiresAt: string } };
  const json = async (response: Awaited<ReturnType<APIRequestContext['get']>>) => {
    assert.equal(response.status(), 200); const bytes = await response.body();
    assert(bytes.length > 0 && bytes.length <= 64 * 1024);
    return JSON.parse(bytes.toString('utf8')) as unknown;
  };
  const current = async (): Promise<Session | null> => {
    fixture.abort.signal.throwIfAborted();
    const value = await json(await actor.api.get(`${BASE_URL}/api/auth/get-session`, { maxRedirects: 0, timeout: 30_000 }));
    if (value === null) return null;
    assert(value && typeof value === 'object' && !Array.isArray(value)); const session = value as Session;
    assert(session.user && session.session && ID.test(session.user.id) && ID.test(session.session.id));
    assert.equal(session.user.id, actor.userId); assert.equal(session.user.email, actor.email);
    assert.equal(session.user.role, actor.role === 'owner' ? 'admin' : 'user');
    assert(typeof session.session.expiresAt === 'string' && Number.isFinite(Date.parse(session.session.expiresAt))
      && Date.parse(session.session.expiresAt) > Date.now() + 30_000, 'Cleanup requires a current unexpired normal session.');
    return session;
  };
  let renewed = false, established = false;
  let cleanupSessionId: string | null = null;
  const assertCurrent = async () => {
    assert(cleanupSessionId); const value = await current(); assert(value);
    assert.equal(value.session.id, cleanupSessionId, 'Cleanup actor/session changed.');
  };
  const signOutRenewed = async (requireEstablishedIdentity: boolean) => {
    if (!renewed) return;
    // During setup failure, this cookie was issued by this context's one owned sign-in attempt.
    // Once validated, a replacement actor/session cannot be used for cleanup.
    if (requireEstablishedIdentity) await assertCurrent();
    const response = await actor.api.post(`${BASE_URL}/api/auth/sign-out`, { data: {}, maxRedirects: 0, timeout: 30_000 });
    assert.equal(response.status(), 200); assert.equal(await current(), null);
  };
  return await withOwnedTestCleanup(async () => {
    let authenticated = await current(); renewed = authenticated === null;
    if (renewed) {
      // Exactly one ordinary sign-in; never replay a Sessions mutation or resurrect a deleted session ID.
      const response = await actor.api.post(`${BASE_URL}/api/auth/sign-in/email`, {
        data: { email: actor.email, password: actor.password }, maxRedirects: 0, timeout: 30_000,
      });
      assert.equal(response.status(), 200); authenticated = await current();
    }
    assert(authenticated); cleanupSessionId = authenticated.session.id;
    const workspaceId = actor.role === 'owner' ? actor.personalWorkspaceId : fixture.teamId;
    const value = await json(await actor.api.get(`${BASE_URL}/api/workspaces`, {
      headers: { 'X-Canvas-Workspace-Id': workspaceId }, maxRedirects: 0, timeout: 30_000,
    })) as { workspaces?: Array<{ id: string; type: string; ownerUserId?: string; organizationId: string; status: string }> };
    assert(Array.isArray(value.workspaces) && value.workspaces.length <= 1000);
    const personal = value.workspaces.filter(item => item.id === actor.personalWorkspaceId);
    assert.equal(personal.length, 1); assert.equal(personal[0].type, 'personal'); assert.equal(personal[0].ownerUserId, actor.userId);
    assert.equal(personal[0].organizationId, fixture.organizationId); assert.equal(personal[0].status, 'active');
    const selected = value.workspaces.filter(item => item.id === workspaceId);
    assert.equal(selected.length, 1); assert.equal(selected[0].type, actor.role === 'owner' ? 'personal' : 'team');
    assert.equal(selected[0].organizationId, fixture.organizationId); assert.equal(selected[0].status, 'active');
    await assertCurrent(); established = true;
    return { assertCurrent, close: async () => { await signOutRenewed(true); } };
  }, [{ label: 'normal-cleanup-auth-signout-after-failed-validation', run: async () => {
    // Includes sign-in200 -> malformed/wrong/near-expired/null session and workspace failures.
    // The original validation error is preserved even when the normal sign-out also fails.
    if (!established) await signOutRenewed(false);
  } }]);
}

async function waitOwnedMobileNativeAcceptance(fixture: Fixture): Promise<void> {
  fixture.failureStage = 'native-handoff';
  const acknowledgement = path.join(fixture.parent.fixtureRoot, 'native-completion.json');
  const { readMcpCredentialJson } = await import('../../app/lib/mcp/credential-storage');
  const { MCP_SYSTEM_SCOPE } = await import('../../app/lib/mcp/scope');
  const { resolveMcpStoragePath } = await import('../../app/lib/mcp/storage');
  const { getSharedMcpDesktopOAuthStatus } = await import('../../app/lib/mcp/shared-desktop-oauth');
  const { getSharedComposioDesktopOAuthStatusByIntent } = await import('../../app/lib/composio/composio-shared-desktop-oauth');
  const { sharedMcpDesktopActorFingerprint } = await import('../../app/lib/mcp/shared-desktop-oauth-contract');
  const { sharedComposioDesktopActorFingerprint } = await import('../../app/lib/composio/composio-shared-desktop-oauth-contract');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000,
    query_timeout: 30_000, options: '-c default_transaction_read_only=on -c statement_timeout=30000' }); fixture.pool = pool;
  const own = (await pool.query('SELECT current_database() AS name,current_user AS owner')).rows[0];
  assert.equal(own.name, fixture.parent.databaseName); assert.equal(own.owner, fixture.parent.databaseOwner);
  const nativeDirectory = resolveMcpStoragePath('mobile-shared-oauth-flows-v2', MCP_SYSTEM_SCOPE);
  assert(nativeDirectory.startsWith(`${fixture.parent.dataRoot}${path.sep}`));
  const appProviderUrl = new URL(process.env.CANVAS_SHARED_MCP_APPS_URL ?? '');
  assert.equal(appProviderUrl.protocol, 'http:'); assert.equal(appProviderUrl.hostname, '127.0.0.1'); assert.equal(appProviderUrl.pathname, '/mcp');
  assert.equal(appProviderUrl.search + appProviderUrl.hash + appProviderUrl.username + appProviderUrl.password, '');
  assert(!['', '3001', '3100', '4001', '4004', '55433'].includes(appProviderUrl.port));
  const appProviderControlToken = process.env.CANVAS_SHARED_MCP_APPS_CONTROL_TOKEN;
  assert(appProviderControlToken && /^[A-Za-z0-9_-]{43}$/u.test(appProviderControlToken));
  const observations = new Map<string, OAuthObservation>(); let apps: AppObservation[] = [], previous = '';
  let completion: OwnedMobileNativeCompletion | undefined;
  // Capture once for this native handoff; OAuth and license expiries stay real.
  const deadline = Date.now() + 240 * 60_000;
  let accepted = false;
  while (Date.now() < deadline) {
    fixture.abort.signal.throwIfAborted();
    let files: string[] = [];
    try { files = await fs.readdir(nativeDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    assert(files.length <= 128, 'The own native observation inventory must remain bounded.');
    for (const file of files) {
      // Normal atomic writers can still have their acknowledged-primary rename pending.
      if (/^[a-f0-9]{64}\.json\.tmp-/u.test(file)) continue;
      assert(/^[a-f0-9]{64}\.json$/u.test(file));
      const record = await readMcpCredentialJson<{ version: number; connectionId: string; flowId: string; source: 'mcp' | 'composio';
        connectionRef: string; userId: string; workspaceId: string; authSessionId: string; providerState: string | null;
        phase: string; revisions: OAuthObservation['revisions'] }>(`mobile-shared-oauth-flows-v2/${file}`, MCP_SYSTEM_SCOPE);
      assert(record && record.version === 2 && record.connectionId === 'mobile-shared-oauth-v2');
      assert(/^[A-Za-z0-9_-]{43}$/u.test(record.flowId)); assert.equal(file, `${createHash('sha256').update(record.flowId).digest('hex')}.json`);
      const target = fixture.connections.find(value => value.purpose === 'oauth' && value.source === record.source && value.value.resource.connectionRef === record.connectionRef);
      const nativeUser = fixture.users.find(user => user.userId === record.userId); assert(target && nativeUser);
      assert.equal(record.workspaceId, fixture.teamId);
      const sessionHash = createHash('sha256').update(record.authSessionId).digest('hex');
      assert(!fixture.users.some(user => user.setupAuthSessionHash === sessionHash), 'Setup cookies cannot prove a native sign-in.');
      const providerStateHash = record.providerState ? createHash('sha256').update(record.providerState).digest('hex') : null;
      const prior = observations.get(record.flowId);
      if (prior && ['completed', 'cancelled', 'failed', 'expired'].includes(prior.status)) {
        assert.equal(prior.source, record.source); assert.equal(prior.actorUserId, record.userId); assert.equal(prior.workspaceId, record.workspaceId);
        assert.equal(prior.connectionRef, record.connectionRef); assert.equal(prior.authSessionHash, sessionHash);
        assert.equal(prior.providerStateHash, providerStateHash); assert.deepEqual(prior.revisions, record.revisions); continue;
      }
      const value: OAuthObservation = { source: record.source, connectionRef: record.connectionRef, scope: target.scope, flowId: record.flowId,
        actorUserId: record.userId, workspaceId: record.workspaceId, authSessionHash: sessionHash, providerStateHash,
        status: 'starting', checkedAt: Date.now(), revisions: record.revisions };
      try {
        const initiator = { actor: { userId: record.userId, workspaceId: record.workspaceId }, authSessionId: record.authSessionId };
        if (record.source === 'composio') value.status = (await getSharedComposioDesktopOAuthStatusByIntent(initiator, record.connectionRef, record.flowId)).status;
        else if (record.providerState) value.status = (await getSharedMcpDesktopOAuthStatus(initiator, record.connectionRef, record.providerState)).status;
        else if (record.phase === 'cancelled') value.status = 'cancelled';
      } catch (error) {
        if (!(error instanceof IntegrationConnectionError) || ![401, 403, 404, 409, 410].includes(error.status)) throw error;
        value.status = 'authorization_unavailable';
      }
      observations.set(record.flowId, value);
    }
    const rows = (await pool.query(`SELECT call_id,request_id,actor_user_id,auth_session_id,workspace_id,session_id,agent_id,
      source_tool_call_id,status,request_json FROM mobile_mcp_app_calls WHERE session_id=ANY($1::text[])`, [fixture.sessions.map(item => item.sessionId)])).rows;
    apps = rows.map(row => {
      const seeded = fixture.sessions.find(item => item.sessionId === row.session_id && item.actor.userId === row.actor_user_id
        && item.agentId === row.agent_id && item.workspaceId === row.workspace_id && item.toolCallId === row.source_tool_call_id); assert(seeded);
      const request = JSON.parse(row.request_json) as { app: McpAppDescriptor }; assert.deepEqual(request.app, seeded.app);
      const sessionHash = createHash('sha256').update(String(row.auth_session_id)).digest('hex');
      assert(!fixture.users.some(user => user.setupAuthSessionHash === sessionHash));
      return { callId: String(row.call_id), requestId: String(row.request_id), actorUserId: String(row.actor_user_id), workspaceId: String(row.workspace_id),
        sessionId: String(row.session_id), agentId: String(row.agent_id), toolCallId: String(row.source_tool_call_id), authSessionHash: sessionHash,
        appVersion: seeded.app.version, connectionRef: seeded.app.version === 2 ? seeded.app.connectionRef : null, status: String(row.status), checkedAt: Date.now() };
    });
    const response: Response = await fetch(`${appProviderUrl.origin}/__fixture/state`, { headers: { Authorization: `Bearer ${appProviderControlToken}` },
      redirect: 'error', signal: AbortSignal.any([fixture.abort.signal, AbortSignal.timeout(5_000)]) });
    assert.equal(response.status, 200);
    const appProvider = await response.json() as { requests: string[]; calls: Array<{ name: string }>; resourceReads: string[]; verificationProbes: number };
    assert.deepEqual(Object.keys(appProvider).sort(), ['calls', 'requests', 'resourceReads', 'verificationProbes']);
    assert(Array.isArray(appProvider.requests) && appProvider.requests.length <= 10_000
      && appProvider.requests.every(value => typeof value === 'string' && /^[A-Za-z0-9_./-]{1,200}$/u.test(value)));
    assert(Array.isArray(appProvider.calls) && appProvider.calls.length <= 10_000
      && appProvider.calls.every(value => Object.keys(value).length === 1 && APP_TOOLS.includes(value.name)));
    assert(Array.isArray(appProvider.resourceReads) && appProvider.resourceReads.length <= 10_000
      && appProvider.resourceReads.every(value => typeof value === 'string' && /^ui:\/\/[^\s\x00-\x1f\x7f]{1,4096}$/u.test(value)));
    assert(Number.isSafeInteger(appProvider.verificationProbes) && appProvider.verificationProbes >= 0);
    const projection = { version: 1, nonce: fixture.parent.nonce, oauth: [...observations.values()], apps, appProvider };
    // Compare without sample timestamps, retaining the last real pre-logout terminal read.
    const digest = createHash('sha256').update(JSON.stringify({ oauth: projection.oauth.map(({ checkedAt: _time, ...value }) => value),
      apps: apps.map(({ checkedAt: _time, ...value }) => value), appProvider })).digest('hex');
    if (digest !== previous) {
      const temporary = path.join(fixture.parent.fixtureRoot, 'native-flow-observations.json.tmp');
      await fs.writeFile(temporary, JSON.stringify(projection), { mode: 0o600 });
      await fs.rename(temporary, path.join(fixture.parent.fixtureRoot, 'native-flow-observations.json')); previous = digest;
    }
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try { handle = await fs.open(acknowledgement, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 2_000)); continue; }
    try {
      const stat = await handle.stat(); assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600 && stat.size < 64 * 1024);
      const ack = JSON.parse(await handle.readFile('utf8')) as OwnedMobileNativeCompletion;
      assert.deepEqual(Object.keys(ack).sort(), ['acceptance', 'actorId', 'appCases', 'appId', 'cases', 'nativeAppClosed', 'nonce', 'oauthCases', 'phase', 'scheme', 'simulatorId', 'version']);
      assert.equal(ack.version, 1); assert.equal(ack.nonce, fixture.parent.nonce); assert.equal(ack.actorId, fixture.parent.actorId);
      assert.equal(ack.phase, 'native_verified'); assert.equal(ack.acceptance, true); assert.equal(ack.nativeAppClosed, true);
      assert.equal(ack.appId, 'app.canvasnotebook.mobile.dev'); assert.equal(ack.scheme, 'canvasnotebook-dev');
      assert.equal(ack.simulatorId, '539E8227-51F5-42CD-AD8E-0D39DE4E4098');
      assert(Array.isArray(ack.cases) && ack.cases.length === REQUIRED_CASES.length * 2);
      const cases = ack.cases as NonNullable<Receipt['nativeEvidence']>;
      assert.deepEqual(cases.map(value => `${value.caseId}:${value.platform}`).sort(),
        REQUIRED_CASES.flatMap(caseId => ['ios', 'android'].map(platform => `${caseId}:${platform}`)).sort());
      for (const item of cases) {
        assert.deepEqual(Object.keys(item).sort(), ['actorIds', 'buildNumber', 'caseId', 'evidence', 'platform']);
        assert(Array.isArray(item.actorIds) && item.actorIds.length > 0 && item.actorIds.length <= 3
          && new Set(item.actorIds).size === item.actorIds.length && item.actorIds.every(id => fixture.receipt.users.includes(id)));
        assert(item.platform === 'ios' || item.platform === 'android'); assert(Number.isSafeInteger(item.buildNumber) && item.buildNumber > 0);
        assert.equal(item.buildNumber, item.platform === 'ios' ? 55 : 17);
        if (item.caseId === 'personal-v1') assert(item.actorIds.includes(fixture.users[0].userId));
        if (item.caseId === 'use-only-choice') assert(item.actorIds.includes(fixture.users[2].userId));
        assert(Array.isArray(item.evidence) && item.evidence.length > 0 && item.evidence.length <= 32);
        for (const relative of item.evidence) {
          assert(typeof relative === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(relative)
            && relative.split('/').every(part => part !== '..' && part !== '.' && part !== ''));
          const file = path.join(fixture.parent.fixtureRoot, relative); assert.equal(await fs.realpath(file), file);
          const proof = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
          try { const observed = await proof.stat(); assert(observed.isFile() && observed.nlink === 1 && observed.uid === process.getuid?.()
            && (observed.mode & 0o777) === 0o600 && observed.size > 0 && observed.size <= 32 * 1024 * 1024); } finally { await proof.close(); }
        }
      }
      fixture.receipt.nativeEvidence = cases;
      completion = ack;
      fixture.receipt.nativeAppClosed = true; accepted = true;
    } finally { await handle.close(); }
    break;
  }
  assert(accepted, 'Native UI acceptance requires an explicit owned Root acknowledgement; elapsed time proves nothing.');
  assert(completion);
  fixture.failureStage = 'native-readback';
  assert(Array.isArray(completion.oauthCases) && completion.oauthCases.length >= 4 && completion.oauthCases.length <= 32);
  assert(new Set(completion.oauthCases.map(value => value.flowId)).size === completion.oauthCases.length);
  for (const evidence of completion.oauthCases) {
    assert.deepEqual(Object.keys(evidence).sort(), ['actorUserId', 'authSessionHash', 'connectionRef', 'flowId', 'source', 'terminalStatus', 'workspaceId']);
    const observed = observations.get(evidence.flowId); assert(observed && HASH.test(evidence.authSessionHash));
    for (const key of ['actorUserId', 'authSessionHash', 'connectionRef', 'flowId', 'source', 'workspaceId'] as const) assert.equal(evidence[key], observed[key]);
    assert.equal(observed.status, evidence.terminalStatus); assert(['completed', 'cancelled'].includes(evidence.terminalStatus));
    const target = fixture.connections.find(value => value.value.resource.connectionRef === evidence.connectionRef); assert(target);
    const actor = { userId: evidence.actorUserId, workspaceId: evidence.workspaceId };
    const actorHash = evidence.source === 'mcp' ? sharedMcpDesktopActorFingerprint(actor) : sharedComposioDesktopActorFingerprint(actor);
    const table = evidence.source === 'mcp' ? 'mcp_shared_desktop_oauth_commits' : 'composio_shared_desktop_oauth_commits';
    const receipts = observed.providerStateHash
      ? (await pool.query(`SELECT * FROM ${table} WHERE state_hash=$1`, [observed.providerStateHash])).rows
      : (await pool.query(`SELECT * FROM ${table} WHERE connection_ref=$1 AND initiating_user_id=$2 AND actor_hash=$3
        AND auth_session_hash=$4 AND pre_metadata_revision=$5 AND pre_grants_revision=$6 AND pre_binding_revision=$7`,
      [evidence.connectionRef, evidence.actorUserId, actorHash, evidence.authSessionHash, observed.revisions.metadataRevision,
        observed.revisions.grantsRevision, observed.revisions.bindingRevision])).rows;
    if (evidence.terminalStatus === 'completed') {
      assert(observed.providerStateHash, 'Completion requires the exact issued provider state.');
      assert.equal(receipts.length, 1); const receipt = receipts[0];
      assert.equal(receipt.connection_ref, evidence.connectionRef); assert.equal(receipt.initiating_user_id, evidence.actorUserId);
      assert.equal(receipt.auth_session_hash, evidence.authSessionHash);
      assert.equal(receipt.actor_hash, actorHash);
      assert.equal(Number(receipt.pre_metadata_revision), observed.revisions.metadataRevision);
      assert.equal(Number(receipt.pre_grants_revision), observed.revisions.grantsRevision);
      assert.equal(Number(receipt.pre_binding_revision), observed.revisions.bindingRevision);
      assert.equal(Number(receipt.published_binding_revision), observed.revisions.bindingRevision + 1);
    } else if (observed.providerStateHash) assert.equal(receipts.length, 0, 'Cancellation cannot publish that native flow.');
    else {
      // A later explicit intent can legitimately publish the same original CAS tuple.
      // Its exact state receipt must pass the completed-case checks in this same matrix.
      const unexplained: typeof receipts = receipts.filter(receipt => !completion!.oauthCases.some(candidate => candidate.source === 'mcp'
        && candidate.terminalStatus === 'completed' && candidate.flowId !== evidence.flowId
        && candidate.connectionRef === evidence.connectionRef && candidate.actorUserId === evidence.actorUserId
        && candidate.workspaceId === evidence.workspaceId && candidate.authSessionHash === evidence.authSessionHash
        && observations.get(candidate.flowId)?.providerStateHash === receipt.state_hash));
      assert.equal(unexplained.length, 0, 'A stateless cancelled intent cannot explain any publication.');
    }
    if (observed.providerStateHash === null) {
      assert.equal(evidence.source, 'mcp'); assert.equal(evidence.terminalStatus, 'cancelled');
      const cancelled = await readMcpCredentialJson<{ version: number; connectionId: string; flowId: string; source: string;
        connectionRef: string; userId: string; workspaceId: string; authSessionId: string; providerState: string | null;
        phase: string; revisions: OAuthObservation['revisions'] }>(`mobile-shared-oauth-flows-v2/${createHash('sha256').update(evidence.flowId).digest('hex')}.json`, MCP_SYSTEM_SCOPE);
      assert(cancelled && cancelled.version === 2 && cancelled.connectionId === 'mobile-shared-oauth-v2');
      assert.equal(cancelled.flowId, evidence.flowId); assert.equal(cancelled.source, 'mcp'); assert.equal(cancelled.providerState, null);
      assert.equal(cancelled.phase, 'cancelled'); assert.equal(cancelled.connectionRef, evidence.connectionRef);
      assert.equal(cancelled.userId, evidence.actorUserId); assert.equal(cancelled.workspaceId, evidence.workspaceId);
      assert.equal(createHash('sha256').update(cancelled.authSessionId).digest('hex'), evidence.authSessionHash);
      assert.deepEqual(cancelled.revisions, observed.revisions);
    }
    if (evidence.source === 'composio') {
      assert(observed.providerStateHash);
      const transaction = (await pool.query('SELECT status,connection_ref,initiating_user_id,actor_hash,auth_session_hash FROM composio_shared_desktop_oauth_transactions WHERE state_hash=$1', [observed.providerStateHash])).rows;
      assert(transaction.length <= 1);
      if (transaction.length === 1) {
        assert.equal(transaction[0].status, evidence.terminalStatus); assert.equal(transaction[0].connection_ref, evidence.connectionRef);
        assert.equal(transaction[0].initiating_user_id, evidence.actorUserId); assert.equal(transaction[0].auth_session_hash, evidence.authSessionHash);
        assert.equal(transaction[0].actor_hash, actorHash);
      } else assert.equal(evidence.terminalStatus, 'cancelled', 'Only an exact early cancellation marker can replace a transaction.');
      if (evidence.terminalStatus === 'cancelled') {
        const marker = (await pool.query('SELECT connection_ref,initiating_user_id,actor_hash,auth_session_hash,metadata_revision,grants_revision,binding_revision FROM composio_shared_desktop_oauth_cancellations WHERE state_hash=$1', [observed.providerStateHash])).rows;
        assert.equal(marker.length, 1); assert.equal(marker[0].connection_ref, evidence.connectionRef);
        assert.equal(marker[0].initiating_user_id, evidence.actorUserId); assert.equal(marker[0].actor_hash, actorHash);
        assert.equal(marker[0].auth_session_hash, evidence.authSessionHash);
        assert.equal(Number(marker[0].metadata_revision), observed.revisions.metadataRevision);
        assert.equal(Number(marker[0].grants_revision), observed.revisions.grantsRevision);
        assert.equal(Number(marker[0].binding_revision), observed.revisions.bindingRevision);
      }
    }
  }
  assert([...observations.values()].every(value => ['completed', 'cancelled'].includes(value.status))
    && completion.oauthCases.length === observations.size, 'Unknown or unconfirmed native flows must be retained, never dropped.');
  for (const target of fixture.connections.filter(value => value.purpose === 'oauth')) {
    assert(completion.oauthCases.some(value => value.connectionRef === target.value.resource.connectionRef && value.terminalStatus === 'completed'),
      'Both providers and both scopes require their exact native positive flow.');
    const current = (await pool.query(`SELECT connection_ref,source,ownership_type,organization_id,team_workspace_id,metadata_revision,
      grants_revision,binding_revision FROM integration_connection_resources WHERE connection_ref=$1`, [target.value.resource.connectionRef])).rows[0];
    assert(current); assert.equal(current.source, target.source); assert.equal(current.ownership_type, target.scope); assert.equal(current.organization_id, fixture.organizationId);
    assert.equal(current.team_workspace_id, target.scope === 'team' ? fixture.teamId : null);
    assert.equal(Number(current.metadata_revision), target.value.resource.metadataRevision); assert.equal(Number(current.grants_revision), target.value.resource.grantsRevision);
    const published: number = completion.oauthCases.filter(value => value.connectionRef === target.value.resource.connectionRef && value.terminalStatus === 'completed').length;
    assert.equal(Number(current.binding_revision), target.value.resource.bindingRevision + published);
  }
  assert(completion.oauthCases.some(value => value.terminalStatus === 'cancelled'), 'A real native cancelled flow is required.');
  assert(Array.isArray(completion.appCases) && completion.appCases.length >= 2 && completion.appCases.length <= 32);
  assert(new Set(completion.appCases.map(value => value.requestId)).size === completion.appCases.length);
  for (const evidence of completion.appCases) {
    assert.deepEqual(Object.keys(evidence).sort(), ['actorUserId', 'appVersion', 'authSessionHash', 'connectionRef', 'requestId', 'sessionId', 'status', 'toolCallId', 'workspaceId']);
    const observed = apps.find(value => value.requestId === evidence.requestId && value.actorUserId === evidence.actorUserId); assert(observed);
    for (const key of ['actorUserId', 'appVersion', 'authSessionHash', 'connectionRef', 'requestId', 'sessionId', 'status', 'toolCallId', 'workspaceId'] as const) assert.equal(observed[key], evidence[key]);
    assert(evidence.status === 'completed' || evidence.status === 'rejected');
  }
  assert(completion.appCases.some(value => value.status === 'completed' && value.appVersion === 2)
    && completion.appCases.some(value => value.status === 'rejected' && value.appVersion === 2));
  const calls = (await pool.query('SELECT status,COUNT(*)::integer AS count FROM mobile_mcp_app_calls GROUP BY status')).rows;
  assert(calls.every(value => !['executing', 'unknown', 'failed'].includes(value.status)));
  assert(calls.some(value => value.status === 'completed' && value.count >= 1)); assert(calls.some(value => value.status === 'rejected' && value.count >= 1));
  const mcp = (await pool.query('SELECT COUNT(*)::integer AS count FROM mcp_shared_desktop_oauth_commits')).rows[0];
  const composio = (await pool.query('SELECT status,COUNT(*)::integer AS count FROM composio_shared_desktop_oauth_transactions GROUP BY status')).rows;
  const commits = (await pool.query('SELECT COUNT(*)::integer AS count FROM composio_shared_desktop_oauth_commits')).rows[0];
  assert(composio.every(value => !['starting', 'waiting', 'callback_received'].includes(value.status)));
  assert.equal(mcp.count + commits.count, completion.oauthCases.filter(value => value.terminalStatus === 'completed').length);
  fixture.receipt.checks = { calls, mcpCommits: mcp.count, composio, composioCommits: commits.count,
    oauthCases: completion.oauthCases, appCases: completion.appCases };
  fixture.failureStage = 'owned-chat-cleanup';
  const cleanupSignouts: Array<{ label: string; run: () => Promise<void> }> = [];
  const cleanupByActor = new Map<string, Awaited<ReturnType<typeof prepareOwnedMobileNativeCleanupAuthentication>>>();
  await withOwnedTestCleanup(async () => {
    for (const actor of fixture.users) {
      const cleanup = await prepareOwnedMobileNativeCleanupAuthentication(fixture, actor);
      cleanupByActor.set(actor.userId, cleanup);
      // Keep every verified cleanup context until the final Owner Bradley read is complete.
      // Reverse registration closes later actors first; all closures run on any body failure.
      cleanupSignouts.unshift({ label: `normal-${actor.role}-cleanup-signout`, run: cleanup.close });
      for (const agentId of fixture.receipt.agents) {
        await cleanup.assertCurrent();
        const response = await actor.api.get(`${BASE_URL}/api/sessions?${new URLSearchParams({ agentId })}`, { maxRedirects: 0, timeout: 30_000 });
        if ([403, 404].includes(response.status())) continue;
        assert.equal(response.status(), 200); const value = await response.json() as { sessions: Array<{ sessionId: string }> };
        for (const session of value.sessions) {
          assert(ID.test(session.sessionId)); await cleanup.assertCurrent();
          const removed = await actor.api.delete(`${BASE_URL}/api/sessions?${new URLSearchParams({ agentId, sessionId: session.sessionId })}`, { maxRedirects: 0, timeout: 30_000 });
          assert.equal(removed.status(), 200); assert.deepEqual(await removed.json(), { success: true, deleted: session.sessionId });
          const saved = fixture.receipt.sessions.find(item => item.sessionId === session.sessionId && item.userId === actor.userId); if (saved) saved.deleted = true;
        }
      }
    }
    const ownerCleanup = cleanupByActor.get(fixture.users[0].userId); assert(ownerCleanup);
    await ownerCleanup.assertCurrent();
    const bradley = await requestOwnedMobileNativeApi(fixture, fixture.users[0].api, '/api/agents?agentId=bradley&includeAccess=true');
    assert.deepEqual(bradley, fixture.originalBradley, 'The default/native tools remain unchanged.');
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM pi_sessions')).rows[0].count, 0);
  }, cleanupSignouts);
  await pool.end(); fixture.pool = undefined; fixture.receipt.poolsClosed = true;
}

async function main(): Promise<void> {
  const fixture = await readOwnedMobileNativeFixture(); let success = false;
  const stopped = () => {
    fixture.abort.abort();
    for (const owned of fixture.childProcesses) {
      if (owned.process.pid !== owned.proof.pid || owned.process.exitCode !== null || owned.process.signalCode !== null || owned.proof.closed) continue;
      try {
        if (owned.proof.processGroupId === owned.proof.pid) process.kill(-owned.proof.processGroupId, 'SIGTERM');
        else owned.process.kill('SIGTERM');
      } catch { /* No discovered PID can become owned; preserve missing closure proof. */ }
    }
  };
  process.once('SIGTERM', stopped); process.once('SIGINT', stopped);
  try {
    await setupOwnedMobileNativeUsers(fixture);
    await setupOwnedMobileNativeResources(fixture);
    await setupOwnedMobileNativeWorkflow(fixture);
    await seedOwnedMobileNativeApps(fixture);
    fixture.receipt.phase = 'awaiting_native';
    await fs.writeFile(path.join(fixture.parent.fixtureRoot, 'native-setup.json'), JSON.stringify(fixture.manifest), { mode: 0o600, flag: 'wx' });
    await fs.writeFile(path.join(fixture.parent.fixtureRoot, 'native-receipt.json'), JSON.stringify(fixture.receipt), { mode: 0o600 });
    console.log(`ISOLATED_MOBILE_NATIVE_READY ${fixture.parent.fixtureRoot}`);
    await waitOwnedMobileNativeAcceptance(fixture); success = true;
  } catch (error) {
    const site = error instanceof Error ? error.stack?.match(/[\\/]mobile-plugin-native-setup-fixture\.ts:([1-9][0-9]{0,6}):([1-9][0-9]{0,6})(?:\)|\n|$)/u) : null;
    fixture.receipt.failure = { stage: fixture.failureStage, name: error instanceof Error ? error.name : 'unknown',
      ...(site ? { site: `mobile-plugin-native-setup-fixture.ts:${site[1]}:${site[2]}` } : {}) };
    fixture.receipt.phase = 'preserved';
  } finally {
    let closed = true;
    for (const owned of fixture.childProcesses) {
      if (!owned.proof.closed) {
        if (owned.process.exitCode === null && owned.process.signalCode === null) {
          if (owned.proof.processGroupId === owned.proof.pid) { try { process.kill(-owned.proof.processGroupId, 'SIGTERM'); } catch { closed = false; } }
          else owned.process.kill('SIGTERM');
          await new Promise<void>(resolve => { const timeout = setTimeout(resolve, 5_000); owned.process.once('close', () => { clearTimeout(timeout); resolve(); }); });
        }
        if (owned.process.exitCode === null && owned.process.signalCode === null) closed = false;
        else if (owned.proof.processGroupId === owned.proof.pid) {
          try { process.kill(-owned.proof.processGroupId, 0); closed = false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') owned.proof.closed = true; else closed = false; }
        } else closed = false;
      }
    }
    for (const api of [...fixture.contexts].reverse()) { try { await api.dispose(); } catch { closed = false; } }
    fixture.receipt.closedContexts = closed;
    if (fixture.pool) { try { await fixture.pool.end(); fixture.pool = undefined; fixture.receipt.poolsClosed = true; } catch { closed = false; } }
    try { const { closeAllMcpServers } = await import('../../app/lib/mcp/manager'); await closeAllMcpServers();
      const { closeDatabaseConnections } = await import('../../app/lib/db'); await closeDatabaseConnections(); } catch { closed = false; }
    fixture.receipt.poolsClosed = closed;
    fixture.receipt.seedersClosed = fixture.receipt.seeders.every(value => value.closed);
    if (success && closed && fixture.receipt.seedersClosed && fixture.receipt.outstanding === null && fixture.receipt.nativeAppClosed) fixture.receipt.phase = 'native_verified_closed';
    else fixture.receipt.phase = 'preserved';
    await fs.writeFile(path.join(fixture.parent.fixtureRoot, 'native-receipt.json'), JSON.stringify(fixture.receipt), { mode: 0o600 });
    process.removeListener('SIGTERM', stopped); process.removeListener('SIGINT', stopped);
  }
  assert.equal(fixture.receipt.phase, 'native_verified_closed', 'The nonce fixture is preserved without a genuine native acceptance and closure proof.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/helpers/mobile-plugin-native-setup-fixture.ts')) {
  void main().catch(() => { console.error('The isolated native Mobile fixture stopped safely; inspect its private static receipt.'); process.exitCode = 1; });
}
