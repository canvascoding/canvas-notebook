import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { createComposioProviderFixture } from './composio-provider-fixture';
import { createSharedMcpAppsProviderFixture } from './shared-mcp-apps-provider-fixture';
import { createSharedMcpAppsResourceHtml } from './shared-mcp-apps-resource-fixture';
import { readMobileNativeTlsReuseInput, reuseOwnedMobileNativeTls, type MobileNativeTlsReuseProof } from './mobile-native-tls-reuse';
import { startIntegrationToolBrowserProvider } from '../fixtures/integration-tool-browser-provider';
import { assertNaturalWorkflowParentProof } from './natural-workflow-parent-proof';

type Child = { process: ChildProcess; pid: number; closed: Promise<number | null>; ended: boolean };

/** Published packages are sealed. Restore only this proved, stopped fixture tree; never follow links. */
async function makeOwnDirectoriesWritable(treeRoot: string, proof: { device: string; inode: string }): Promise<void> {
  const root = await fs.lstat(treeRoot);
  assert(root.isDirectory() && !root.isSymbolicLink());
  assert.equal(String(root.dev), proof.device); assert.equal(String(root.ino), proof.inode);
  let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    assert(depth <= 64 && ++visited <= 30_000, 'The own fixture directory traversal exceeded its bounds.');
    const relative = path.relative(treeRoot, directory);
    assert(relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return;
    assert.equal(entry.dev, root.dev); assert.equal(entry.uid, root.uid);
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const held = await handle.stat();
      assert.equal(held.dev, entry.dev); assert.equal(held.ino, entry.ino); assert.equal(held.uid, root.uid);
      await handle.chmod(0o700);
      const current = await fs.lstat(directory);
      assert(current.isDirectory() && !current.isSymbolicLink()); assert.equal(current.ino, held.ino); assert.equal(current.dev, held.dev);
      for (const name of await fs.readdir(directory)) await visit(path.join(directory, name), depth + 1);
    } finally { await handle.close(); }
  };
  await visit(treeRoot, 0);
}
type Receipt = {
  version: 1; nonce: string; repo: string; fixtureRoot: string; dataRoot: string; tmpRoot: string;
  ownerMarker: string; rootDevice: string; rootInode: string; databaseName: string; databaseOwner: string | null;
  directoryProofs: Record<string, { device: string; inode: string }>; listenerVerified: boolean;
  createAcknowledged: boolean; phase: string; serverPid: number | null; issuerPid?: number | null; actorId: string | null;
  uncertain: boolean; databaseDropped: boolean; dataRemoved: boolean;
  tlsFiles?: { key: { path: string; device: string; inode: string }; certificate: { path: string; device: string; inode: string } };
  tlsReuse?: MobileNativeTlsReuseProof;
  desktopPaths?: { userData: string; sessionData: string; temp: string; logs: string; crashDumps: string };
  desktopDirectoryProofs?: Record<string, { device: string; inode: string }>;
  desktopProcessIds?: number[];
  desktopClosed?: boolean;
  nativeIdentityDiagnostic?: boolean;
  nativeProvider?: 'composio';
  systemBrowserClosed?: boolean;
  composioProviderClosed?: boolean;
  liveProvider?: 'composio';
  mcpAppProviderClosed?: boolean;
  mobileNative?: true;
  mobileNativeClosed?: boolean;
  mcpOAuthProviderClosed?: boolean;
  mobilePackageProviderClosed?: boolean;
  mobileRenderRepro?: true;
  mobileRenderReproDeadline?: number;
  mobileRenderReproClosed?: boolean;
  naturalModel?: true;
  naturalProviderClosed?: boolean;
  naturalParentPid?: number;
  naturalBrowserPid?: number;
  naturalProviderOrigin?: string;
};
type IssuerReady = {
  version: 1; nonce: string; fixtureRoot: string; origin: string; certificatePath: string;
  initialPublicKey: string; initialPublicKeyFingerprint: string; testPublicKey: string; testPublicKeyFingerprint: string;
  licenseId: string; instanceId: string; cpOrganizationId: string; controlSecret: string;
};

async function readIssuerReady(root: string, nonce: string, instanceId: string): Promise<IssuerReady> {
  const readyPath = path.join(root, 'issuer-ready.json'), stat = await fs.lstat(readyPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600);
  const ready = JSON.parse(await fs.readFile(readyPath, 'utf8')) as IssuerReady;
  assert.equal(ready.version, 1); assert.equal(ready.nonce, nonce); assert.equal(ready.fixtureRoot, root); assert.equal(ready.instanceId, instanceId);
  const origin = new URL(ready.origin);
  assert.equal(origin.hostname, '127.0.0.1'); assert.equal(origin.protocol, 'http:'); assert(origin.port && origin.origin === ready.origin);
  assert.equal(path.dirname(ready.certificatePath), root); assert.equal(await fs.realpath(ready.certificatePath), ready.certificatePath);
  const cert = await fs.lstat(ready.certificatePath); assert(cert.isFile() && !cert.isSymbolicLink() && cert.nlink === 1 && (cert.mode & 0o777) === 0o600);
  for (const [key, fingerprint] of [[ready.initialPublicKey, ready.initialPublicKeyFingerprint], [ready.testPublicKey, ready.testPublicKeyFingerprint]]) {
    assert.equal(createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex'), fingerprint);
  }
  assert.notEqual(ready.initialPublicKeyFingerprint, ready.testPublicKeyFingerprint);
  assert(ready.licenseId && ready.cpOrganizationId && ready.controlSecret.length >= 32);
  return ready;
}

async function requestOwnIssuerControl(ready: IssuerReady, operation: 'approve-claim' | 'development-grant', body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${ready.origin}/__owned/${operation}`, { method: 'POST',
    headers: { Authorization: `Bearer ${ready.controlSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, 'The owned issuer operation must be acknowledged.');
  const result = await response.json() as { success?: boolean; licenseId?: string; instanceId?: string };
  assert.equal(result.success, true); assert.equal(result.licenseId, ready.licenseId); assert.equal(result.instanceId, ready.instanceId);
}

/** Real activation/claim/grant services; no license state is manufactured in SQL. */
async function activateWorkflowTestLicense(ready: IssuerReady, env: NodeJS.ProcessEnv): Promise<void> {
  Object.assign(env, { CANVAS_LICENSE_CONTROL_PLANE_URL: ready.origin, CANVAS_LICENSE_PUBLIC_KEY: ready.initialPublicKey,
    CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: ready.initialPublicKeyFingerprint,
    CANVAS_LICENSE_TEST_PUBLIC_KEY: ready.testPublicKey, CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS: ready.testPublicKeyFingerprint,
    CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_TEST_AUDIENCE: 'canvas-notebook-test',
    CANVAS_TEAM_SEAT_CLIENT_ENABLED: 'true', CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED: 'true',
    CANVAS_TEAM_SEAT_MEMBERSHIP_MUTATIONS_ENABLED: 'true' });
  Object.assign(process.env, env);
  const { activateLicenseCert } = await import('../../app/lib/license');
  const { verifyLicenseJwtDetailed } = await import('../../app/lib/license/jwt');
  const { loadStoredLicenseCert } = await import('../../app/lib/license/storage');
  const { startCommunityLicenseClaim, pollCommunityLicenseClaim, refreshCommunityLicenseCertificate } = await import('../../app/lib/license/control-plane');
  const initialCertificate = await fs.readFile(ready.certificatePath, 'utf8');
  const initial = await verifyLicenseJwtDetailed(initialCertificate, ready.instanceId);
  assert(initial.ok); assert.equal(initial.payload.licenseId, ready.licenseId);
  const activated = await activateLicenseCert(initialCertificate);
  assert.equal(activated.licensed, true); assert.equal(activated.instanceId, ready.instanceId);
  const claim = await startCommunityLicenseClaim();
  assert.equal(claim.state, 'authorization_pending');
  assert('userCode' in claim && typeof claim.userCode === 'string' && 'claimId' in claim && typeof claim.claimId === 'string');
  await requestOwnIssuerControl(ready, 'approve-claim', { userCode: claim.userCode });
  const deadline = Date.now() + 30_000;
  let connected = false;
  while (Date.now() < deadline) {
    const polled = await pollCommunityLicenseClaim(claim.claimId);
    if (polled.state === 'connected') { connected = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  assert(connected, 'The real Community claim must become connected.');
  await requestOwnIssuerControl(ready, 'development-grant', {});
  env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development';
  process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development';
  const refreshed = await refreshCommunityLicenseCertificate();
  assert.equal(refreshed.status.licensed, true); assert.equal(refreshed.status.edition, 'team');
  assert.equal(refreshed.status.licenseClass, 'test'); assert.equal(refreshed.status.licenseEnvironment, 'development');
  // The grant caps four seats. Its first certificate signs the one allocated
  // owner seat; normal membership activation allocates and signs each addition.
  assert.equal(refreshed.status.seatLimit, 1); assert.equal(refreshed.details.id, ready.licenseId);
  const stored = await loadStoredLicenseCert(ready.instanceId); assert(stored);
  const verified = await verifyLicenseJwtDetailed(stored, ready.instanceId); assert(verified.ok);
  assert.equal(verified.payload.licenseId, ready.licenseId); assert.equal(verified.payload.nonBillable, true); assert.equal(verified.payload.provider, 'test');
  Object.assign(env, { CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true' });
  Object.assign(process.env, env);
}

async function assertPortAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: 3001 });
    socket.setTimeout(1_000);
    socket.once('connect', () => { socket.destroy(); reject(new Error('Port 3001 is already occupied; no lifecycle action is permitted.')); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Port availability is uncertain.')); });
    socket.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve() : reject(new Error('Port availability is uncertain.')));
  });
}

async function main(): Promise<void> {
  assert.equal(process.env.CANVAS_AGENT_SETTINGS_BROWSER_RUN, '1');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.__NEXT_PROCESSED_ENV, 'true');
  const maintenance = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(maintenance.hostname, '127.0.0.1'); assert.equal(maintenance.port, '55433');
  assert.equal(maintenance.pathname, '/postgres'); assert.equal(maintenance.search, ''); assert.equal(maintenance.hash, '');
  assert(process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD);
  const workflow = process.env.CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN === '1';
  const oauth = process.env.CANVAS_SHARED_MCP_OAUTH_BROWSER_RUN === '1';
  const desktop = process.env.CANVAS_SHARED_MCP_DESKTOP_OAUTH_BROWSER_RUN === '1';
  const composioDesktopClient = process.env.CANVAS_SHARED_COMPOSIO_DESKTOP_CLIENT_BROWSER_RUN === '1';
  const composioNative = process.env.CANVAS_SHARED_COMPOSIO_DESKTOP_OAUTH_BROWSER_RUN === '1';
  const composioLive = process.env.CANVAS_COMPOSIO_LIVE_BROWSER_RUN === '1';
  const mcpApps = process.env.CANVAS_SHARED_MCP_APPS_BROWSER_RUN === '1';
  const mobileMcpApps = process.env.CANVAS_MOBILE_MCP_APPS_BROWSER_RUN === '1';
  const mobileNative = process.env.CANVAS_MOBILE_PLUGIN_NATIVE_RUN === '1';
  const mobileRenderRepro = process.env.CANVAS_MOBILE_MCP_RENDER_REPRO_RUN === '1';
  const naturalModel = process.env.CANVAS_AGENT_WORKFLOW_NATURAL_MODEL_RUN === '1';
  const naturalModelInput = process.env.CANVAS_NATURAL_MODEL_INPUT;
  assert(process.env.CANVAS_AGENT_WORKFLOW_NATURAL_MODEL_RUN === undefined || naturalModel);
  assert(!naturalModel || workflow && !oauth && !desktop && !composioDesktopClient && !composioNative && !composioLive
    && !mcpApps && !mobileMcpApps && !mobileNative && !mobileRenderRepro,
  'Natural model acceptance requires its separate fixed workflow command.');
  assert(naturalModelInput === undefined || naturalModel);
  if (naturalModel) {
    assert(naturalModelInput && path.isAbsolute(naturalModelInput) && await fs.realpath(naturalModelInput) === naturalModelInput);
    const handle = await fs.open(naturalModelInput, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(), current = await fs.lstat(naturalModelInput);
      assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600
        && stat.size > 0 && stat.size <= 4096 && current.isFile() && !current.isSymbolicLink()
        && current.dev === stat.dev && current.ino === stat.ino);
    } finally { await handle.close(); }
  }
  assert(process.env.CANVAS_MOBILE_MCP_RENDER_REPRO_RUN === undefined || mobileRenderRepro);
  assert(!mobileRenderRepro || workflow && mcpApps && !mobileMcpApps && !mobileNative && !oauth && !desktop
    && !composioNative && !composioDesktopClient && !composioLive, 'Render diagnosis requires its separate fixed API-only command.');
  assert(process.env.CANVAS_MOBILE_PLUGIN_NATIVE_RUN === undefined || mobileNative);
  assert(!mobileNative || workflow && !mcpApps && !mobileMcpApps && !oauth && !desktop && !composioNative && !composioDesktopClient && !composioLive,
    'Native Mobile acceptance requires its own fixed workflow command.');
  const tlsReuseInputPath = process.env.CANVAS_MOBILE_PLUGIN_NATIVE_TLS_REUSE_INPUT;
  assert(tlsReuseInputPath === undefined || mobileNative, 'TLS reuse requires the fixed Mobile Native command.');
  const tlsReuseInput = tlsReuseInputPath === undefined ? undefined : await readMobileNativeTlsReuseInput(tlsReuseInputPath);
  const anyMcpApps = mcpApps || mobileMcpApps || mobileNative;
  assert(!(mcpApps && mobileMcpApps) && (!anyMcpApps || workflow && !oauth && !desktop && !composioNative && !composioDesktopClient && !composioLive),
    'MCP Apps require one separate fixed workflow command.');
  assert(!composioLive || workflow && !oauth && !desktop && !composioNative && !composioDesktopClient,
    'The live Composio gate requires its separate fixed command.');
  let liveKey: string | undefined;
  const liveInputPath = composioLive ? process.env.CANVAS_COMPOSIO_LIVE_INPUT : undefined;
  if (composioLive) {
    assert(liveInputPath && path.isAbsolute(liveInputPath) && await fs.realpath(liveInputPath) === liveInputPath);
    const handle = await fs.open(liveInputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const inputStat = await handle.stat();
      assert(inputStat.isFile() && inputStat.nlink === 1 && inputStat.uid === process.getuid?.()
        && (inputStat.mode & 0o777) === 0o600 && inputStat.size > 0 && inputStat.size < 4096);
      const input = JSON.parse(await handle.readFile('utf8')) as { composioApiKey?: unknown };
      assert(typeof input.composioApiKey === 'string' && input.composioApiKey.length > 10 && input.composioApiKey.length < 256);
      liveKey = input.composioApiKey;
    } finally { await handle.close(); }
  }
  const nativeAny = desktop || composioNative || composioLive;
  assert(!composioDesktopClient || workflow && !oauth && !nativeAny, 'The controlled Composio client gate uses its own workflow command.');
  assert(!composioNative || workflow && !oauth && !desktop && !composioDesktopClient,
    'The native Composio gate uses its own fixed workflow command.');
  const identityDiagnostic = process.env.CANVAS_SHARED_MCP_DESKTOP_IDENTITY_DIAGNOSTIC_RUN === '1';
  assert(process.env.CANVAS_SHARED_MCP_DESKTOP_IDENTITY_DIAGNOSTIC_RUN === undefined || identityDiagnostic);
  assert(!oauth || workflow, 'The OAuth browser fixture requires its owned Team issuer.');
  assert(!desktop || oauth, 'The native desktop fixture requires the owned HTTPS OAuth fixture.');
  assert(!identityDiagnostic || desktop, 'The focused native diagnostic requires the unchanged desktop fixture.');
  const controlPlaneRoot = workflow ? await fs.realpath(process.env.CANVAS_CONTROL_PLANE_TEST_ROOT ?? '') : null;
  const repo = await fs.realpath(process.cwd());
  await fs.access(path.join(repo, '.next/BUILD_ID'));
  await assertPortAvailable();
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-agent-settings-browser-')));
  await fs.chmod(root, 0o700);
  const rootStat = await fs.lstat(root);
  const nonce = randomBytes(16).toString('hex');
  const marker = randomBytes(24).toString('hex');
  const dataRoot = path.join(root, 'data'), tmpRoot = path.join(root, 'tmp'), results = path.join(root, 'results');
  for (const directory of [dataRoot, tmpRoot, results]) await fs.mkdir(directory, { mode: 0o700 });
  const directoryProofs: Receipt['directoryProofs'] = {};
  for (const directory of [dataRoot, tmpRoot]) {
    const stat = await fs.lstat(directory); directoryProofs[directory] = { device: String(stat.dev), inode: String(stat.ino) };
  }
  const desktopPaths: Receipt['desktopPaths'] = nativeAny ? {
    userData: path.join(tmpRoot, 'desktop-user-data'), sessionData: path.join(tmpRoot, 'desktop-session-data'),
    temp: path.join(tmpRoot, 'desktop-temp'), logs: path.join(tmpRoot, 'desktop-logs'),
    crashDumps: path.join(tmpRoot, 'desktop-crash-dumps'),
  } : undefined;
  const desktopDirectoryProofs: Receipt['desktopDirectoryProofs'] = nativeAny ? {} : undefined;
  if (desktopPaths && desktopDirectoryProofs) {
    for (const directory of Object.values(desktopPaths)) {
      await fs.mkdir(directory, { mode: 0o700 });
      const stat = await fs.lstat(directory);
      assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === rootStat.uid && (stat.mode & 0o777) === 0o700);
      assert.equal(await fs.realpath(directory), directory);
      desktopDirectoryProofs[directory] = { device: String(stat.dev), inode: String(stat.ino) };
    }
  }
  await fs.writeFile(path.join(root, '.fixture-owner'), marker, { mode: 0o600 });
  const emptyEnv = path.join(root, 'empty.env');
  await fs.writeFile(emptyEnv, '', { mode: 0o600 });
  const receiptPath = path.join(root, 'recovery.json');
  const receipt: Receipt = { version: 1, nonce, repo, fixtureRoot: root, dataRoot, tmpRoot, ownerMarker: marker,
    rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), databaseName: `canvas_connection_test_${nonce}`,
    directoryProofs, listenerVerified: false,
    databaseOwner: null, createAcknowledged: false, phase: 'before_create', serverPid: null, actorId: null,
    uncertain: false, databaseDropped: false, dataRemoved: false,
    ...(naturalModel ? { naturalModel: true as const, naturalProviderClosed: false, naturalParentPid: process.pid } : {}),
    ...(mobileRenderRepro ? { mobileRenderRepro: true as const, mobileRenderReproDeadline: Date.now() + 30 * 60_000,
      mobileRenderReproClosed: false } : {}),
    ...(mobileNative ? { mobileNative: true as const, mobileNativeClosed: false, mcpOAuthProviderClosed: false } : {}),
    ...(nativeAny ? { desktopPaths, desktopDirectoryProofs, desktopClosed: false,
      ...(composioLive ? { nativeProvider: 'composio' as const, liveProvider: 'composio' as const }
        : composioNative ? { nativeProvider: 'composio' as const, composioProviderClosed: false }
        : { nativeIdentityDiagnostic: identityDiagnostic }) } : {}) };
  const persist = async () => {
    const temporary = `${receiptPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 });
    await fs.rename(temporary, receiptPath);
  };
  // The exact name is durable BEFORE CREATE. An ambiguous CREATE is preserved;
  // current role/ownership alone never turns it into an acknowledged fixture.
  await persist();
  if (composioNative) console.log(`ISOLATED_SHARED_COMPOSIO_NATIVE_FIXTURE ${root} parentPid=${process.pid}`);
  if (composioLive) console.log(`ISOLATED_COMPOSIO_LIVE_FIXTURE ${root} parentPid=${process.pid}`);
  if (naturalModel) console.log(`ISOLATED_NATURAL_WORKFLOW_FIXTURE ${root} parentPid=${process.pid}`);
  const administration = new Pool({ connectionString: maintenance.toString(), max: 1, connectionTimeoutMillis: 5_000, query_timeout: 30_000 });
  let database: Pool | undefined;
  let server: Child | undefined;
  let issuer: Child | undefined;
  let composioProvider: Awaited<ReturnType<typeof createComposioProviderFixture>> | undefined;
  let composioProviderClosed = !composioDesktopClient && !composioNative;
  let mcpAppProvider: Awaited<ReturnType<typeof createSharedMcpAppsProviderFixture>> | undefined;
  let mcpOAuthProvider: Awaited<ReturnType<typeof import('../../tests/fixtures/mcp-oauth-provider.mjs')['startMcpOAuthProvider']>> | undefined;
  let nativePackageProvider: Awaited<ReturnType<typeof import('./mobile-plugin-native-setup-fixture')['createOwnedMobileNativePackageProvider']>> | undefined;
  let mcpAppProviderClosed = !anyMcpApps;
  let naturalProvider: Awaited<ReturnType<typeof startIntegrationToolBrowserProvider>> | undefined;
  let naturalProviderClosed = !naturalModel;
  const children: Child[] = [];
  const abort = new AbortController();
  const signalChild = (child: Child, signal: NodeJS.Signals) => {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0 || child.process.pid !== child.pid) {
      receipt.uncertain = true;
      return;
    }
    if (child.ended || child.process.exitCode !== null || child.process.signalCode !== null) return;
    // Each direct child starts its own process group. Never discover other PIDs
    // or signal a group after its acknowledged direct child has finished.
    try { process.kill(-child.pid, signal); } catch { receipt.uncertain = true; }
  };
  const cancel = () => { receipt.uncertain = true; abort.abort(); for (const child of children) signalChild(child, 'SIGTERM'); };
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  const runtimeUrl = new URL(maintenance); runtimeUrl.pathname = `/${receipt.databaseName}`;
  const permittedEnv = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD',
    'BOOTSTRAP_ADMIN_NAME', 'CANVAS_AGENT_SETTINGS_BROWSER_RUN'];
  const baseEnv = Object.fromEntries(permittedEnv.flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  const env: NodeJS.ProcessEnv = { ...baseEnv, NODE_ENV: 'test', DATABASE_URL: runtimeUrl.toString(),
    DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_APP_ROOT: repo, TMPDIR: tmpRoot, CANVAS_ENV_FILE: emptyEnv,
    CANVAS_PLUGIN_LOCAL_SOURCE_ROOT: path.join(dataRoot, 'workflow-editor-intake'),
    CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_POOL_MAX: '8', CANVAS_DEPLOYMENT_MODE: 'community',
    CANVAS_ORGANIZATION_ID: `agent-settings-browser-${nonce}`, CANVAS_INSTANCE_ID: `agent-settings-browser-${nonce}`,
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_TOKEN: '', CANVAS_LICENSE_CERT: '',
    CANVAS_TEAM_FEATURES_ENABLED: 'false', CANVAS_PROJECT_FEATURES_ENABLED: 'false',
    CANVAS_TEAM_LICENSE_REFRESH_ENABLED: 'false', CANVAS_TEAM_LICENSE_LIFECYCLE_ENABLED: 'false',
    CANVAS_MCP_DIRECT_ENABLED: 'false', QMD_ENABLED: 'false', ONBOARDING: 'false', ONBOARDING_HINTS: 'false',
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'), __NEXT_PROCESSED_ENV: 'true', NEXT_TELEMETRY_DISABLED: '1',
    HOSTNAME: '127.0.0.1', PORT: '3001', BASE_URL: 'http://127.0.0.1:3001', BETTER_AUTH_BASE_URL: 'http://127.0.0.1:3001',
    TEST_LOGIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL, TEST_LOGIN_PASSWORD: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    E2E_EXTERNAL_SERVER: '1', AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE: receiptPath,
    AGENT_SETTINGS_TOOLS_BROWSER_RESULTS: results,
  };
  if (workflow) Object.assign(env, { CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN: '1',
    CANVAS_POSTGRES_VECTOR_ENABLED: 'true', CANVAS_VECTOR_PROVIDER: 'pgvector',
    MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true',
    TEST_SECONDARY_EMAIL: `workflow-member-${nonce}@example.test`, TEST_SECONDARY_PASSWORD: randomBytes(24).toString('base64url'),
    TEST_EDITOR_EMAIL: `workflow-editor-${nonce}@example.test`, TEST_EDITOR_PASSWORD: randomBytes(24).toString('base64url') });
  if (naturalModel) Object.assign(env, { CANVAS_AGENT_WORKFLOW_NATURAL_MODEL_RUN: '1', CANVAS_NATURAL_MODEL_INPUT: naturalModelInput,
    INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url') });
  if (oauth) env.CANVAS_SHARED_MCP_OAUTH_BROWSER_RUN = '1';
  if (anyMcpApps) Object.assign(env, { CANVAS_MCP_APPS_ENABLED: 'true',
    INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url') });
  if (mcpApps) env.CANVAS_SHARED_MCP_APPS_BROWSER_RUN = '1';
  if (mobileRenderRepro) env.CANVAS_MOBILE_MCP_RENDER_REPRO_RUN = '1';
  if (mobileMcpApps) env.CANVAS_MOBILE_MCP_APPS_BROWSER_RUN = '1';
  if (mobileNative) env.CANVAS_MOBILE_PLUGIN_NATIVE_RUN = '1';
  if (composioDesktopClient || composioNative || composioLive || mobileNative) env.INTEGRATIONS_ENV_MASTER_KEY = randomBytes(32).toString('base64url');
  if (composioLive) {
    Object.assign(env, { CANVAS_COMPOSIO_LIVE_BROWSER_RUN: '1', CANVAS_COMPOSIO_LIVE_INPUT: liveInputPath,
      CANVAS_COMPOSIO_LIVE_DESKTOP_PATHS: JSON.stringify(desktopPaths) });
    await fs.writeFile(path.join(root, 'live-runtime-input.json'), JSON.stringify({ masterKey: env.INTEGRATIONS_ENV_MASTER_KEY,
      authSecret: env.BETTER_AUTH_SECRET, organizationId: env.CANVAS_ORGANIZATION_ID, instanceId: env.CANVAS_INSTANCE_ID,
      databaseName: receipt.databaseName, dataRoot, tmpRoot, baseUrl: env.BASE_URL }),
      { mode: 0o600, flag: 'wx' });
  }
  if (composioDesktopClient) env.CANVAS_SHARED_COMPOSIO_DESKTOP_CLIENT_BROWSER_RUN = '1';
  if (composioNative) Object.assign(env, { CANVAS_SHARED_COMPOSIO_DESKTOP_OAUTH_BROWSER_RUN: '1',
    CANVAS_SHARED_COMPOSIO_DESKTOP_PATHS: JSON.stringify(desktopPaths),
    CANVAS_SHARED_COMPOSIO_DESKTOP_RECEIPT: path.join(root, 'desktop-receipt.json') });
  if (desktop) Object.assign(env, { CANVAS_SHARED_MCP_DESKTOP_OAUTH_BROWSER_RUN: '1',
    CANVAS_SHARED_MCP_DESKTOP_PATHS: JSON.stringify(desktopPaths),
    CANVAS_SHARED_MCP_DESKTOP_RECEIPT: path.join(root, 'desktop-receipt.json') });
  if (identityDiagnostic) env.CANVAS_SHARED_MCP_DESKTOP_IDENTITY_DIAGNOSTIC_RUN = '1';
  const startChild = (args: string[], phase: string, nodeEnv: 'production' | 'test' | 'development', overrides: Record<string, string> = {}): Child => {
    abort.signal.throwIfAborted();
    const log = createWriteStream(path.join(root, `${phase}.log`), { mode: 0o600 });
    const redact = (value: string) => [process.env.BOOTSTRAP_ADMIN_PASSWORD, env.BETTER_AUTH_SECRET, env.TEST_SECONDARY_PASSWORD,
      env.TEST_EDITOR_PASSWORD, env.CANVAS_COMPOSIO_NATIVE_CONTROL_TOKEN, env.INTEGRATIONS_ENV_MASTER_KEY, liveKey,
      runtimeUrl.toString(), maintenance.toString()]
      .filter((secret): secret is string => Boolean(secret)).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value)
      .replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-postgres-url]');
    const childEnv: NodeJS.ProcessEnv = { ...env, NODE_ENV: nodeEnv, ...overrides };
    if (phase !== 'browser' && !(mobileNative && phase === 'native-setup')) {
      delete childEnv.CANVAS_COMPOSIO_NATIVE_CONTROL_TOKEN;
      delete childEnv.CANVAS_COMPOSIO_NATIVE_CONTROL_URL;
      delete childEnv.CANVAS_COMPOSIO_LIVE_INPUT;
      delete childEnv.CANVAS_NATURAL_MODEL_INPUT;
    }
    const child = spawn(process.execPath, args, { cwd: repo, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const record: Child = { process: child, pid: child.pid ?? 0, ended: false, closed: Promise.resolve(null) };
    children.push(record);
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream?.on('data', chunk => {
        pending += chunk.toString();
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) log.write(`${redact(line)}\n`);
        if (pending.length > 32_768) { log.write('[oversized log line omitted]\n'); pending = ''; }
      });
      stream?.on('end', () => { if (pending) log.write(redact(pending)); });
    }
    record.closed = new Promise(resolve => {
      child.once('error', () => { receipt.uncertain = true; });
      child.once('close', code => { record.ended = true; log.end(); resolve(code); });
    });
    return record;
  };
  const waitChild = async (child: Child, timeoutMs: number): Promise<number | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([child.closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { receipt.uncertain = true; signalChild(child, 'SIGTERM'); reject(new Error('The own child exceeded its bounded deadline.')); }, timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const stopChild = async (child: Child): Promise<void> => {
    if (child.ended) return;
    signalChild(child, 'SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([child.closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 15_000); })]);
    if (timer) clearTimeout(timer);
    if (!exited) {
      receipt.uncertain = true;
      signalChild(child, 'SIGKILL');
      try { await waitChild(child, 5_000); } catch { /* Preserve the fixture if the owned child remains unreaped. */ }
    }
    if (!child.ended) throw new Error('The recorded fixture child was not reaped.');
  };
  const assertRoot = async () => {
    const current = await fs.lstat(root);
    assert(current.isDirectory() && !current.isSymbolicLink()); assert.equal(current.mode & 0o777, 0o700);
    assert.equal(String(current.dev), receipt.rootDevice); assert.equal(String(current.ino), receipt.rootInode);
    assert.equal(await fs.realpath(root), root);
    const markerStat = await fs.lstat(path.join(root, '.fixture-owner'));
    assert(markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1);
    assert.equal(markerStat.mode & 0o777, 0o600);
    assert.equal(await fs.readFile(path.join(root, '.fixture-owner'), 'utf8'), marker);
  };
  const assertDirectory = async (directory: string) => {
    const current = await fs.lstat(directory); assert(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(String(current.dev), directoryProofs[directory].device); assert.equal(String(current.ino), directoryProofs[directory].inode);
    assert.equal(await fs.realpath(directory), directory); assert.equal(path.dirname(directory), root);
  };
  const inspectProcess = async (args: string[]) => new Promise<string>((resolve, reject) => {
    execFile('lsof', args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(new Error('The exact owned listener could not be verified.')); else resolve(stdout);
    });
  });
  const assertOwnedListener = async () => {
    assert(server && !server.ended && server.process.exitCode === null && server.process.signalCode === null);
    const listener = await inspectProcess(['-nP', '-iTCP:3001', '-sTCP:LISTEN', '-Fp']);
    const pids = new Set(listener.split('\n').filter(line => /^p\d+$/u.test(line)).map(line => Number(line.slice(1))));
    assert.equal(pids.size, 1); assert(pids.has(server.pid), 'A discovered foreign PID cannot become the fixture host.');
    const cwd = await inspectProcess(['-a', '-p', String(server.pid), '-d', 'cwd', '-Fn']);
    const directories = cwd.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    assert.equal(directories.length, 1); assert.equal(await fs.realpath(directories[0]), repo);
  };
  let bodyFailure: unknown;
  let nativeCompletedApps: number | undefined, nativeCompletedMcpOAuth: number | undefined;
  try {
    if (oauth || composioNative || mobileNative) {
      await assertRoot();
      const keyPath = path.join(root, 'tls-key.pem'), certificatePath = path.join(root, 'tls-cert.pem');
      if (tlsReuseInput) receipt.tlsReuse = await reuseOwnedMobileNativeTls(tlsReuseInput, root, repo);
      else {
        await new Promise<void>((resolve, reject) => {
          execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
            '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', keyPath, '-out', certificatePath],
          { timeout: 15_000, maxBuffer: 64 * 1024 }, error => error ? reject(new Error('The private OAuth TLS fixture could not be created.')) : resolve());
        });
      }
      for (const file of [keyPath, certificatePath]) await fs.chmod(file, 0o600);
      const key = await fs.lstat(keyPath), certificate = await fs.lstat(certificatePath);
      for (const entry of [key, certificate]) {
        assert(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.uid === rootStat.uid && (entry.mode & 0o777) === 0o600);
      }
      receipt.tlsFiles = { key: { path: keyPath, device: String(key.dev), inode: String(key.ino) },
        certificate: { path: certificatePath, device: String(certificate.dev), inode: String(certificate.ino) } };
      env.NODE_EXTRA_CA_CERTS = certificatePath;
      if (oauth) Object.assign(env, { CANVAS_SHARED_MCP_OAUTH_TLS_KEY: keyPath, CANVAS_SHARED_MCP_OAUTH_TLS_CERT: certificatePath });
      if (composioNative) Object.assign(env, { CANVAS_SHARED_COMPOSIO_OAUTH_TLS_KEY: keyPath,
        CANVAS_SHARED_COMPOSIO_OAUTH_TLS_CERT: certificatePath });
      if (mobileNative) Object.assign(env, { CANVAS_MOBILE_PLUGIN_NATIVE_TLS_KEY: keyPath, CANVAS_MOBILE_PLUGIN_NATIVE_TLS_CERT: certificatePath });
      await persist();
    }
    const collisions = await administration.query('SELECT datname FROM pg_database WHERE datname=$1', [receipt.databaseName]);
    assert.equal(collisions.rowCount, 0, 'A pre-existing database cannot become this fixture.');
    receipt.databaseOwner = (await administration.query('SELECT current_user AS role')).rows[0].role;
    receipt.phase = 'create_in_flight'; await persist();
    await administration.query(`CREATE DATABASE "${receipt.databaseName}"`);
    receipt.createAcknowledged = true; receipt.phase = 'migrations'; await persist();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env, { NODE_ENV: 'test' });
    database = new Pool({ connectionString: runtimeUrl.toString(), max: 8, connectionTimeoutMillis: 5_000 });
    const { runPostgresMigrations } = await import('../../app/lib/db/postgres');
    await runPostgresMigrations(database);
    assert.equal((await database.query('SELECT current_database() AS name')).rows[0].name, receipt.databaseName);
    assert.equal((await database.query('SELECT COUNT(*)::integer AS count FROM "user"')).rows[0].count, 0);
    await administration.query(`COMMENT ON DATABASE "${receipt.databaseName}" IS '${marker}'`);
    env.CANVAS_DATABASE_MIGRATIONS_COMPLETED = 'true';
    process.env.CANVAS_DATABASE_MIGRATIONS_COMPLETED = 'true';
    receipt.phase = 'bootstrap'; await persist();
    if (workflow) {
      // The normal first-owner setup also adopts the active owner membership.
      // The legacy admin password CLI only creates an account and workspace.
      const { createInitialOwner } = await import('../../app/lib/auth-setup');
      const owner = await createInitialOwner({ name: env.BOOTSTRAP_ADMIN_NAME, email: env.BOOTSTRAP_ADMIN_EMAIL,
        password: env.BOOTSTRAP_ADMIN_PASSWORD });
      assert(owner.id, 'The actual first-owner setup must acknowledge the account.');
    } else {
      const bootstrap = startChild(['scripts/bootstrap-admin.js', '--ensure'], 'bootstrap', 'production');
      assert.equal(await waitChild(bootstrap, 60_000), 0, 'The official bootstrap CLI must succeed.');
    }
    const users = (await database.query('SELECT id,role FROM "user"')).rows;
    assert.equal(users.length, 1); assert.equal(users[0].role, 'admin'); receipt.actorId = String(users[0].id);
    await persist();
    if (workflow) {
      assert(controlPlaneRoot);
      issuer = startChild(['--import', 'tsx', 'scripts/helpers/agent-workflow-team-issuer-fixture.ts'], 'issuer', 'development', {
        CANVAS_ISSUER_MAINTENANCE_DATABASE_URL: maintenance.toString(), CANVAS_CONTROL_PLANE_TEST_ROOT: controlPlaneRoot,
      });
      assert(Number.isSafeInteger(issuer.pid) && issuer.pid > 0);
      receipt.issuerPid = issuer.pid; await persist();
      const issuerDeadline = Date.now() + 120_000;
      let ready: IssuerReady | null = null;
      while (Date.now() < issuerDeadline && !issuer.ended) {
        abort.signal.throwIfAborted();
        try { await fs.access(path.join(root, 'issuer-ready.json')); ready = await readIssuerReady(root, nonce, env.CANVAS_INSTANCE_ID!); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert(ready && !issuer.ended, 'The owned issuer must acknowledge readiness.');
      await activateWorkflowTestLicense(ready, env);
      env.INTEGRATION_GATEWAY_E2E_FIXTURE_URL = ready.origin;
    }
    if (composioDesktopClient || composioNative || mobileNative) {
      const controlToken = composioNative || mobileNative ? randomBytes(32).toString('base64url') : undefined;
      composioProvider = await createComposioProviderFixture(composioNative || mobileNative ? { nativeConsent: {
        tls: { key: await fs.readFile((mobileNative ? env.CANVAS_MOBILE_PLUGIN_NATIVE_TLS_KEY : env.CANVAS_SHARED_COMPOSIO_OAUTH_TLS_KEY)!),
          cert: await fs.readFile((mobileNative ? env.CANVAS_MOBILE_PLUGIN_NATIVE_TLS_CERT : env.CANVAS_SHARED_COMPOSIO_OAUTH_TLS_CERT)!) },
        controlToken: controlToken!, allowedCallbackOrigin: 'http://127.0.0.1:3001', fixtureNonce: nonce,
        cleanAuthorizationAddress: true,
        ...(mobileNative ? { nativeReturnScheme: 'canvasnotebook-dev' as const } : {}),
      } } : undefined);
      const origin = new URL(composioProvider.baseUrl);
      assert.equal(origin.hostname, '127.0.0.1'); assert.equal(origin.protocol, 'http:'); assert(origin.port);
      env.COMPOSIO_BASE_URL = origin.origin;
      if (composioNative || mobileNative) {
        assert(composioProvider.nativeConsent);
        Object.assign(env, { CANVAS_COMPOSIO_NATIVE_CONTROL_URL: composioProvider.nativeConsent.controlUrl,
          CANVAS_COMPOSIO_NATIVE_CONTROL_TOKEN: controlToken!,
          CANVAS_SHARED_COMPOSIO_NATIVE_PROVIDER_ORIGIN: composioProvider.nativeConsent.origin,
          CANVAS_SHARED_COMPOSIO_ELECTRON_PROVIDER_ORIGIN: composioProvider.nativeConsent.origin });
      }
    }
    if (naturalModel) {
      naturalProvider = await startIntegrationToolBrowserProvider();
      const origin = new URL(naturalProvider.baseUrl);
      assert.equal(origin.hostname, '127.0.0.1'); assert.equal(origin.protocol, 'http:'); assert(origin.port);
      Object.assign(env, { COMPOSIO_BASE_URL: origin.origin, INTEGRATION_BROWSER_FIXTURE_URL: origin.origin });
      receipt.naturalProviderOrigin = origin.origin; await persist();
    }
    if (anyMcpApps) {
      const controlToken = randomBytes(32).toString('base64url');
      mcpAppProvider = await createSharedMcpAppsProviderFixture({ html: await createSharedMcpAppsResourceHtml(), controlToken, allowModelVerification: true });
      Object.assign(env, { CANVAS_SHARED_MCP_APPS_URL: mcpAppProvider.url, CANVAS_SHARED_MCP_APPS_CONTROL_TOKEN: controlToken });
      receipt.mcpAppProviderClosed = false;
    }
    if (mobileNative) {
      const { startMcpOAuthProvider } = await import('../../tests/fixtures/mcp-oauth-provider.mjs');
      mcpOAuthProvider = await startMcpOAuthProvider({ allowedRedirectOrigins: [env.BASE_URL], cleanAuthorizationAddress: true,
        nativeReturnScheme: 'canvasnotebook-dev',
        tls: { key: await fs.readFile(env.CANVAS_MOBILE_PLUGIN_NATIVE_TLS_KEY!), cert: await fs.readFile(env.CANVAS_MOBILE_PLUGIN_NATIVE_TLS_CERT!) } });
      Object.assign(env, { CANVAS_MOBILE_PLUGIN_NATIVE_MCP_OAUTH_URL: mcpOAuthProvider.url,
        CANVAS_MOBILE_PLUGIN_NATIVE_MCP_OAUTH_ORIGIN: mcpOAuthProvider.origin,
        CANVAS_SHARED_MCP_APPS_BROWSER_RUN: '1' });
      const { createOwnedMobileNativePackageProvider } = await import('./mobile-plugin-native-setup-fixture');
      nativePackageProvider = await createOwnedMobileNativePackageProvider({ root, nonce, intake: env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT!,
        keyPath: env.CANVAS_MOBILE_PLUGIN_NATIVE_TLS_KEY!, certificatePath: env.CANVAS_MOBILE_PLUGIN_NATIVE_TLS_CERT! });
      receipt.mobilePackageProviderClosed = false;
      Object.assign(env, { CANVAS_PLUGIN_STORE_REGISTRY_URL: nativePackageProvider.registryUrl,
        CANVAS_MOBILE_PLUGIN_NATIVE_PACKAGE_SOURCE: JSON.stringify(nativePackageProvider.sources.filter(source => source.version === '1.0.0'
          && source.entryKey.startsWith('native-contexts-'))),
        CANVAS_MOBILE_PLUGIN_NATIVE_PACKAGE_VERSIONS: JSON.stringify(nativePackageProvider.sources.filter(source => source.entryKey.startsWith('native-contexts-'))),
        CANVAS_MOBILE_PLUGIN_NATIVE_STORE_INSTALL_CANDIDATES: JSON.stringify(nativePackageProvider.storeInstallCandidates) });
    }
    receipt.phase = 'host_starting'; await persist();
    server = startChild(['--import', 'tsx', 'server.js'], 'host', 'production');
    assert(server.pid > 0); receipt.serverPid = server.pid; await persist();
    const deadline = Date.now() + 120_000;
    let healthy = false;
    while (Date.now() < deadline && !server.ended) {
      abort.signal.throwIfAborted();
      try {
        const response = await fetch(`${env.BASE_URL}/api/health`, { signal: AbortSignal.timeout(3_000) });
        const body = await response.json() as { deployment?: { mode?: string; teamFeaturesEnabled?: boolean } };
        healthy = response.status === 200 && body.deployment?.mode === (workflow ? 'team' : 'community')
          && body.deployment.teamFeaturesEnabled === workflow;
        if (healthy) break;
      } catch { /* Bounded readiness polling never changes another host. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert(healthy && !server.ended, 'The recorded isolated production host must become ready.');
    await assertOwnedListener(); receipt.listenerVerified = true;
    receipt.phase = 'browser'; await persist();
    if (mobileRenderRepro) {
      console.log(`ISOLATED_MOBILE_RENDER_REPRO_FIXTURE ${root} parentPid=${process.pid}`);
      const remaining = receipt.mobileRenderReproDeadline! - Date.now(); assert(remaining > 0);
      const worker = startChild(['--conditions=react-server', '--import', 'tsx', 'scripts/helpers/mobile-mcp-render-repro-fixture.ts'], 'render-repro', 'test');
      const workerCode = await waitChild(worker, remaining);
      const handle = await fs.open(path.join(root, 'render-repro-receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        assert(stat.isFile() && stat.nlink === 1 && stat.uid === rootStat.uid && (stat.mode & 0o777) === 0o600 && stat.size < 128 * 1024);
        const result = JSON.parse(await handle.readFile('utf8')) as { version: number; nonce: string; actorId: string; deadline: number;
          phase: string; acceptance: boolean; diagnosticPassed: boolean; closedContexts: boolean; authClosed: boolean;
          seedersClosed: boolean; ownedDatabasePools: number; domainCleanup: string };
        assert.equal(result.version, 1); assert.equal(result.nonce, nonce); assert.equal(result.actorId, receipt.actorId);
        assert.equal(result.deadline, receipt.mobileRenderReproDeadline); assert.equal(result.acceptance, false);
        assert.equal(result.closedContexts, true); assert.equal(result.authClosed, true); assert.equal(result.seedersClosed, true);
        assert.equal(result.ownedDatabasePools, 0); assert.equal(workerCode, 0);
        receipt.mobileRenderReproClosed = true;
        if (!result.diagnosticPassed || result.phase !== 'diagnosed_closed' || result.domainCleanup !== 'verified') {
          throw new Error('The isolated render diagnosis failed; its original source data is preserved.');
        }
      } finally { await handle.close(); }
      receipt.phase = 'render_repro_complete'; await persist();
    } else if (mobileNative) {
      // This compatibility phase belongs only to the saved-invocation guard.
      // Native evidence is separate; this branch never launches a browser.
      console.log(`ISOLATED_MOBILE_NATIVE_FIXTURE ${root} parentPid=${process.pid}`);
      const nativeWorker = startChild(['--conditions=react-server', '--import', 'tsx', 'scripts/helpers/mobile-plugin-native-setup-fixture.ts'], 'native-setup', 'test');
      // Native-only: four-hour handoff plus ten minutes shared by setup/close.
      assert.equal(await waitChild(nativeWorker, 250 * 60_000), 0, 'The native worker must acknowledge its completed closure.');
      const handle = await fs.open(path.join(root, 'native-receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        assert(stat.isFile() && stat.nlink === 1 && stat.uid === rootStat.uid && (stat.mode & 0o777) === 0o600 && stat.size < 64 * 1024);
        const nativeReceipt = JSON.parse(await handle.readFile('utf8')) as { version?: unknown; nonce?: unknown; actorId?: unknown;
          phase?: unknown; outstanding?: unknown; closedContexts?: unknown; poolsClosed?: unknown; seedersClosed?: unknown; nativeAppClosed?: unknown;
          checks?: { appCases?: Array<{ status: string }>; oauthCases?: Array<{ source: string; terminalStatus: string }> } };
        assert.equal(nativeReceipt.version, 1); assert.equal(nativeReceipt.nonce, nonce); assert.equal(nativeReceipt.actorId, receipt.actorId);
        assert.equal(nativeReceipt.phase, 'native_verified_closed'); assert.equal(nativeReceipt.outstanding, null);
        assert.equal(nativeReceipt.closedContexts, true); assert.equal(nativeReceipt.poolsClosed, true);
        assert.equal(nativeReceipt.seedersClosed, true); assert.equal(nativeReceipt.nativeAppClosed, true);
        assert(nativeReceipt.checks && Array.isArray(nativeReceipt.checks.appCases) && Array.isArray(nativeReceipt.checks.oauthCases));
        assert(nativeReceipt.checks.appCases.length <= 32 && nativeReceipt.checks.oauthCases.length <= 32);
        nativeCompletedApps = nativeReceipt.checks.appCases.filter(value => value.status === 'completed').length;
        nativeCompletedMcpOAuth = nativeReceipt.checks.oauthCases.filter(value => value.source === 'mcp' && value.terminalStatus === 'completed').length;
        assert(nativeCompletedApps > 0 && nativeCompletedMcpOAuth >= 2);
      } finally { await handle.close(); }
      receipt.mobileNativeClosed = true; receipt.phase = 'native_complete'; await persist();
    } else {
    const browserArgs = [path.join(repo, 'node_modules/@playwright/test/cli.js'), 'test', '--config', naturalModel
      ? 'playwright.agent-workflow-natural-model-production.config.ts' : mcpApps
      ? 'playwright.shared-mcp-apps-production.config.ts' : mobileMcpApps
      ? 'playwright.mobile-mcp-apps-production.config.ts' : composioLive
      ? 'playwright.composio-live-production.config.ts' : composioNative
      ? 'playwright.shared-composio-desktop-oauth-production.config.ts' : composioDesktopClient
      ? 'playwright.shared-composio-desktop-client-production.config.ts' : desktop
      ? 'playwright.shared-mcp-desktop-oauth-production.config.ts' : oauth
        ? 'playwright.shared-mcp-oauth-production.config.ts' : 'playwright.agent-settings-tools-production.config.ts'];
    if (identityDiagnostic) browserArgs.push('--grep', 'actual Electron cookie ABA and same-origin frame changes deny a verified old launch without publishing or executing');
    const browser = startChild(browserArgs, 'browser', 'test');
    if (naturalModel) { receipt.naturalBrowserPid = browser.pid; await persist(); }
    const browserCode = await waitChild(browser, naturalModel ? 25 * 60_000 : nativeAny ? 26 * 60_000 : workflow ? 600_000 : 300_000);
    const browserReceipt = JSON.parse(await fs.readFile(path.join(root, 'browser-receipt.json'), 'utf8')) as { nonce: string; actorId: string; phase: string; outstanding: unknown };
    assert.equal(browserReceipt.nonce, nonce); assert.equal(browserReceipt.actorId, receipt.actorId);
    assert.equal(browserReceipt.phase, 'verified_closed'); assert.equal(browserReceipt.outstanding, null);
    if (naturalModel) {
      assert.equal(browserCode, 0); assert(naturalProvider && receipt.actorId);
      await assertNaturalWorkflowParentProof({ database, databaseName: receipt.databaseName, root, nonce,
        actorId: receipt.actorId, provider: naturalProvider.calls() });
    }
    if (composioLive) {
      const livePath = path.join(root, 'live-receipt.json');
      const handle = await fs.open(livePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let live: { nonce: string; actorId: string; phase: string; outstanding: unknown; electronClosed: boolean;
        closedContexts: boolean; completedScopes: string[]; readCalls: number; systemBrowserOpenedCount: number;
        desktopPaths: Receipt['desktopPaths']; desktopDirectoryProofs: Receipt['desktopDirectoryProofs'];
        processes: Array<{ pid: number; processGroupId: number; closed: boolean }> };
      try {
        const stat = await handle.stat();
        assert(stat.isFile() && stat.nlink === 1 && stat.uid === rootStat.uid && (stat.mode & 0o777) === 0o600
          && stat.size > 0 && stat.size < 64 * 1024);
        live = JSON.parse(await handle.readFile('utf8'));
        const current = await fs.lstat(livePath);
        assert(current.isFile() && !current.isSymbolicLink() && current.dev === stat.dev && current.ino === stat.ino);
      } finally { await handle.close(); }
      assert.equal(live.nonce, nonce); assert.equal(live.actorId, receipt.actorId); assert.equal(live.phase, 'verified_closed');
      assert.equal(live.outstanding, null); assert.equal(live.electronClosed, true); assert.equal(live.closedContexts, true);
      assert.deepEqual(live.completedScopes, ['organization', 'team']); assert.equal(live.readCalls, 2);
      assert.deepEqual(live.desktopPaths, desktopPaths); assert.deepEqual(live.desktopDirectoryProofs, desktopDirectoryProofs);
      assert.equal(live.processes.length, 1);
      for (const record of live.processes) {
        assert(Number.isSafeInteger(record.pid) && record.pid > 0 && record.closed === true && record.processGroupId === record.pid);
        assert(!children.some(child => child.pid === record.pid) && record.pid !== process.pid);
        assert.throws(() => process.kill(record.pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
        assert.throws(() => process.kill(-record.processGroupId, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
      }
      assert.equal(live.systemBrowserOpenedCount, 2);
      const closeHandle = await fs.open(path.join(root, 'system-browser-closure.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await closeHandle.stat();
        assert(stat.isFile() && stat.nlink === 1 && stat.uid === rootStat.uid && (stat.mode & 0o777) === 0o600 && stat.size < 2048);
        assert.deepEqual(JSON.parse(await closeHandle.readFile('utf8')), { version: 1, nonce, openedCount: 2, closed: true });
      } finally { await closeHandle.close(); }
      for (const directory of Object.values(desktopPaths!)) {
        const stat = await fs.lstat(directory);
        assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === rootStat.uid && (stat.mode & 0o777) === 0o700);
        assert.equal(await fs.realpath(directory), directory);
        assert.deepEqual({ device: String(stat.dev), inode: String(stat.ino) }, desktopDirectoryProofs![directory]);
      }
      receipt.desktopProcessIds = live.processes.map(record => record.pid);
      receipt.desktopClosed = true; receipt.systemBrowserClosed = true;
    } else if (nativeAny) {
      const nativePath = path.join(root, 'desktop-receipt.json'), nativeStat = await fs.lstat(nativePath);
      assert(nativeStat.isFile() && !nativeStat.isSymbolicLink() && nativeStat.nlink === 1
        && nativeStat.uid === rootStat.uid && (nativeStat.mode & 0o777) === 0o600 && nativeStat.size > 0 && nativeStat.size < 64 * 1024);
      const handle = await fs.open(nativePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let native: { version: number; nonce: string; actorId: string; phase: string; outstanding: unknown;
        desktopPaths: Receipt['desktopPaths']; desktopDirectoryProofs: Receipt['desktopDirectoryProofs'];
        processes: Array<{ pid: number; processGroupId: number; closed: boolean }>; electronClosed: boolean;
        providerClosed?: boolean; parentOwnedProvider?: boolean; closedContexts: boolean;
        providerOrigin: string; systemBrowserOpenedCount: number };
      try {
        const held = await handle.stat();
        assert.equal(held.dev, nativeStat.dev); assert.equal(held.ino, nativeStat.ino); assert.equal(held.size, nativeStat.size);
        assert(held.isFile() && held.nlink === 1 && held.uid === rootStat.uid && (held.mode & 0o777) === 0o600);
        native = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
      assert.equal(native.version, 1); assert.equal(native.nonce, nonce); assert.equal(native.actorId, receipt.actorId);
      assert.equal(native.phase, 'verified_closed'); assert.equal(native.outstanding, null);
      assert.equal(native.electronClosed, true); assert.equal(native.closedContexts, true);
      if (composioNative) {
        assert.equal(native.parentOwnedProvider, true);
        assert.notEqual(native.providerClosed, true, 'The worker must not acknowledge closure of the parent-owned provider.');
      } else assert.equal(native.providerClosed, true);
      const providerOrigin = new URL(native.providerOrigin);
      assert.equal(providerOrigin.protocol, 'https:'); assert.equal(providerOrigin.hostname, '127.0.0.1'); assert(providerOrigin.port);
      assert.equal(providerOrigin.origin, native.providerOrigin);
      if (composioNative) assert.equal(native.providerOrigin, composioProvider!.nativeConsent!.origin);
      assert(Number.isSafeInteger(native.systemBrowserOpenedCount) && native.systemBrowserOpenedCount >= 1 && native.systemBrowserOpenedCount <= 8);
      const systemBrowserPath = path.join(root, 'system-browser-closure.json'), systemBrowserStat = await fs.lstat(systemBrowserPath);
      assert(systemBrowserStat.isFile() && !systemBrowserStat.isSymbolicLink() && systemBrowserStat.nlink === 1
        && systemBrowserStat.uid === rootStat.uid && (systemBrowserStat.mode & 0o777) === 0o600
        && systemBrowserStat.size > 0 && systemBrowserStat.size < 2 * 1024);
      const systemBrowserHandle = await fs.open(systemBrowserPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const held = await systemBrowserHandle.stat();
        assert.equal(held.dev, systemBrowserStat.dev); assert.equal(held.ino, systemBrowserStat.ino); assert.equal(held.size, systemBrowserStat.size);
        assert(held.isFile() && held.nlink === 1 && held.uid === rootStat.uid && (held.mode & 0o777) === 0o600);
        const acknowledgement = JSON.parse(await systemBrowserHandle.readFile('utf8')) as {
          version: number; nonce: string; origin: string; openedCount: number; closed: boolean };
        assert.equal(Object.keys(acknowledgement).sort().join(','), 'closed,nonce,openedCount,origin,version');
        assert.equal(acknowledgement.version, 1); assert.equal(acknowledgement.nonce, nonce);
        assert.equal(acknowledgement.origin, native.providerOrigin); assert.equal(acknowledgement.openedCount, native.systemBrowserOpenedCount);
        assert.equal(acknowledgement.closed, true);
      } finally { await systemBrowserHandle.close(); }
      assert.deepEqual(native.desktopPaths, desktopPaths); assert.deepEqual(native.desktopDirectoryProofs, desktopDirectoryProofs);
      assert(Array.isArray(native.processes) && native.processes.length >= 1 && native.processes.length <= 8);
      const pids = native.processes.map(record => {
        assert(Number.isSafeInteger(record.pid) && record.pid > 0 && record.closed === true);
        assert.equal(record.processGroupId, record.pid, 'The acknowledged native process must retain its captured own process group.');
        assert(!children.some(child => child.pid === record.pid) && record.pid !== process.pid);
        // Read-only liveness check: never signal a PID merely reported by a receipt.
        assert.throws(() => process.kill(record.pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
        assert.throws(() => process.kill(-record.processGroupId, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
        return record.pid;
      });
      assert.equal(new Set(pids).size, pids.length);
      for (const directory of Object.values(desktopPaths!)) {
        const current = await fs.lstat(directory);
        assert(current.isDirectory() && !current.isSymbolicLink() && current.uid === rootStat.uid && (current.mode & 0o777) === 0o700);
        assert.equal(await fs.realpath(directory), directory);
        assert.deepEqual({ device: String(current.dev), inode: String(current.ino) }, desktopDirectoryProofs![directory]);
      }
      receipt.desktopProcessIds = pids; receipt.desktopClosed = true; receipt.systemBrowserClosed = true; await persist();
    }
    if (composioNative) {
      const stats = composioProvider!.nativeConsent!.readStats();
      assert.equal(stats.sdkLinks, 4); assert.equal(stats.issued, 4);
      assert.equal(stats.consents, 3); assert.equal(stats.approvals, 3); assert.equal(stats.callbackRedirects, 3);
      assert.equal(stats.denials, 0); assert.equal(stats.businessCalls, 0);
      assert(stats.accountReads >= 2, 'The actual finalizer must read the exact provider account.');
      await fs.writeFile(path.join(root, 'composio-provider-proof.json'), JSON.stringify({ version: 1, nonce, stats }),
        { mode: 0o600, flag: 'wx' });
    }
    assert.equal((await database.query('SELECT COUNT(*)::integer AS count FROM pi_sessions')).rows[0].count, 0);
    await assertOwnedListener();
    if (browserCode !== 0) bodyFailure = new Error('The actual agent-switch browser assertion failed; see the private browser log.');
    receipt.phase = 'browser_complete'; await persist();
    }
  } catch (error) {
    bodyFailure = error;
    // Missing acknowledgements, transport failures, cancellation and interrupted
    // browser writes cannot justify destroying this fixture's diagnostic state.
    receipt.uncertain = true;
  } finally {
    for (const child of [...children].reverse()) {
      try { await stopChild(child); } catch { receipt.uncertain = true; }
      // A surviving process group is preserved, never killed via a reused PID.
      if (Number.isSafeInteger(child.pid) && child.pid > 0 && child.process.pid === child.pid) {
        try { process.kill(-child.pid, 0); receipt.uncertain = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') receipt.uncertain = true; }
      } else receipt.uncertain = true;
    }
    if (server && !server.ended) receipt.uncertain = true;
    if (composioProvider) {
      if (mobileNative && composioProvider.nativeConsent) {
        try {
          await fs.writeFile(path.join(root, 'native-composio-provider-proof.json'), JSON.stringify({ version: 1, nonce,
            stats: composioProvider.nativeConsent.readStats(), issued: composioProvider.nativeConsent.readFlow() }), { mode: 0o600, flag: 'wx' });
        } catch { receipt.uncertain = true; }
      }
      try { await composioProvider.close(); composioProviderClosed = true;
        if (composioNative) receipt.composioProviderClosed = true;
        if (mobileNative && receipt.mobileNativeClosed) assert.equal(composioProvider.nativeConsent!.readStats().businessCalls, 0); }
      catch { receipt.uncertain = true; }
    } else if (composioDesktopClient || composioNative) composioProviderClosed = true;
    if (mcpOAuthProvider) {
      try {
        await mcpOAuthProvider.close(); receipt.mcpOAuthProviderClosed = true;
        await fs.writeFile(path.join(root, 'native-mcp-oauth-provider-proof.json'), JSON.stringify({ version: 1, nonce, ...mcpOAuthProvider.stats }), { mode: 0o600, flag: 'wx' });
        if (receipt.mobileNativeClosed) {
          assert.equal(mcpOAuthProvider.stats.approvals, nativeCompletedMcpOAuth);
          assert.equal(mcpOAuthProvider.stats.tokenExchanges, nativeCompletedMcpOAuth);
          assert.equal(mcpOAuthProvider.stats.failedTokenExchanges, 0); assert.equal(mcpOAuthProvider.stats.toolCalls, 0);
        }
      } catch { receipt.uncertain = true; }
    }
    if (nativePackageProvider) {
      try {
        await nativePackageProvider.close(); receipt.mobilePackageProviderClosed = true;
        await fs.writeFile(path.join(root, 'native-package-provider-proof.json'), JSON.stringify({ version: 1, nonce,
          ...nativePackageProvider.counters }), { mode: 0o600, flag: 'wx' });
      } catch { receipt.uncertain = true; }
    }
    if (mcpAppProvider) {
      try {
        if (mobileNative) { await mcpAppProvider.close(); mcpAppProviderClosed = true; receipt.mcpAppProviderClosed = true; }
        await fs.writeFile(path.join(root, 'mcp-app-provider-proof.json'), JSON.stringify({ version: 1, nonce,
          requests: mcpAppProvider.requests, calls: mcpAppProvider.calls.map(call => ({ name: call.name })),
          resourceReads: mcpAppProvider.resourceReads, verificationProbes: mcpAppProvider.verificationProbes() }),
        { mode: 0o600, flag: 'wx' });
        if (!mobileNative) { await mcpAppProvider.close(); mcpAppProviderClosed = true; receipt.mcpAppProviderClosed = true; }
        if (mobileNative && receipt.mobileNativeClosed) {
          assert.equal(mcpAppProvider.calls.filter(call => call.name === 'app_action').length, nativeCompletedApps);
          assert.equal(mcpAppProvider.calls.filter(call => call.name === 'model_only').length, 0);
        }
      } catch { receipt.uncertain = true; }
    }
    if (naturalProvider) {
      try {
        await naturalProvider.close(); naturalProviderClosed = true; receipt.naturalProviderClosed = true;
        await fs.writeFile(path.join(root, 'natural-provider-proof.json'), JSON.stringify({ version: 1, nonce,
          closed: true, ...naturalProvider.calls() }), { mode: 0o600, flag: 'wx' });
      } catch { receipt.uncertain = true; }
    }
    if (workflow) {
      try { const { closeDatabaseConnections } = await import('../../app/lib/db'); await closeDatabaseConnections(); }
      catch { receipt.uncertain = true; }
    }
    if (database) { try { await database.end(); } catch { receipt.uncertain = true; } }
    try {
      await assertRoot();
      if (workflow && issuer) {
        assert(issuer.ended && issuer.process.exitCode === 0 && issuer.process.signalCode === null,
          'The issuer must acknowledge its own completed cleanup.');
        const issuerReceiptPath = path.join(root, 'issuer-recovery.json'), issuerStat = await fs.lstat(issuerReceiptPath);
        assert(issuerStat.isFile() && !issuerStat.isSymbolicLink() && issuerStat.nlink === 1
          && issuerStat.uid === rootStat.uid && (issuerStat.mode & 0o777) === 0o600 && issuerStat.size < 64 * 1024);
        const issuerReceipt = JSON.parse(await fs.readFile(issuerReceiptPath, 'utf8')) as {
          nonce: string; fixtureRoot: string; databaseName: string; instanceId: string; phase: string;
          rootDevice: string; rootInode: string; databaseOwner: string; databaseDropped: boolean;
          appClosed: boolean; poolsClosed: boolean; uncertain: boolean; requestsInFlight: number; processId: number;
        };
        assert.equal(issuerReceipt.nonce, nonce); assert.equal(issuerReceipt.fixtureRoot, root);
        assert.equal(issuerReceipt.rootDevice, receipt.rootDevice); assert.equal(issuerReceipt.rootInode, receipt.rootInode);
        assert.equal(issuerReceipt.databaseName, `canvas_workflow_issuer_${nonce}`);
        assert.equal(issuerReceipt.instanceId, env.CANVAS_INSTANCE_ID); assert.equal(issuerReceipt.databaseOwner, receipt.databaseOwner);
        assert.equal(issuerReceipt.processId, issuer.pid); assert.equal(receipt.issuerPid, issuer.pid);
        assert.equal(issuerReceipt.phase, 'cleaned'); assert.equal(issuerReceipt.databaseDropped, true);
        assert.equal(issuerReceipt.appClosed, true); assert.equal(issuerReceipt.poolsClosed, true);
        assert.equal(issuerReceipt.uncertain, false); assert.equal(issuerReceipt.requestsInFlight, 0);
        assert.equal((await administration.query('SELECT datname FROM pg_database WHERE datname=$1', [issuerReceipt.databaseName])).rowCount, 0);
      }
      if (composioLive && !bodyFailure && receipt.createAcknowledged && !receipt.uncertain && children.every(child => child.ended)) {
        // Real accounts and the configured profiles remain available for an explicit
        // follow-up run. Preserve the owned encrypted DATA/DB, with all processes stopped.
        assert(receipt.desktopClosed === true);
        receipt.phase = 'live_verified_preserved';
      } else if (!composioLive && receipt.createAcknowledged && !receipt.uncertain && children.every(child => child.ended)) {
        assert(composioProviderClosed, 'The own Composio protocol fixture must close before database cleanup.');
        assert(mcpAppProviderClosed, 'The own MCP App provider must close before database cleanup.');
        assert(naturalProviderClosed, 'The own natural-workflow tool provider must close before database cleanup.');
        assert(!mobileRenderRepro || receipt.mobileRenderReproClosed === true, 'The own API render diagnostic must acknowledge normal closure.');
        assert(!mobileNative || receipt.mobileNativeClosed === true && receipt.mcpOAuthProviderClosed === true && receipt.mobilePackageProviderClosed === true,
          'Native Mobile and the own OAuth provider must acknowledge closure before database cleanup.');
        assert(!nativeAny || receipt.desktopClosed === true && receipt.systemBrowserClosed === true,
          'Native desktop and independent system-browser closure must be acknowledged before normal database cleanup.');
        if (desktopPaths && desktopDirectoryProofs) for (const directory of Object.values(desktopPaths)) {
          const current = await fs.lstat(directory);
          assert(current.isDirectory() && !current.isSymbolicLink() && current.uid === rootStat.uid && (current.mode & 0o777) === 0o700);
          assert.equal(await fs.realpath(directory), directory);
          assert.deepEqual({ device: String(current.dev), inode: String(current.ino) }, desktopDirectoryProofs[directory]);
        }
        for (const directory of [dataRoot, tmpRoot]) await assertDirectory(directory);
        const current = (await administration.query(`SELECT pg_get_userbyid(datdba) AS owner,current_user AS role,
          shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [receipt.databaseName])).rows[0];
        assert(current && current.owner === receipt.databaseOwner && current.owner === current.role && current.marker === marker);
        for (const directory of [dataRoot, tmpRoot]) await makeOwnDirectoriesWritable(directory, receipt.directoryProofs[directory]);
        // No FORCE and no backend termination: an unexpected live connection
        // makes cleanup fail and preserves DATA and the private receipt.
        await administration.query(`DROP DATABASE "${receipt.databaseName}"`);
        receipt.databaseDropped = true; await persist();
        assert.equal((await administration.query('SELECT datname FROM pg_database WHERE datname=$1', [receipt.databaseName])).rowCount, 0);
        for (const directory of [dataRoot, tmpRoot]) {
          await assertDirectory(directory);
          await fs.rm(directory, { recursive: true, force: true });
        }
        receipt.dataRemoved = true; receipt.phase = 'cleaned';
      } else receipt.phase = 'preserved';
    } catch { receipt.uncertain = true; receipt.phase = 'preserved'; }
    await persist(); await administration.end();
    process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
  }
  if (composioLive && receipt.phase === 'live_verified_preserved' && !receipt.uncertain) {
    console.log(`ISOLATED_COMPOSIO_LIVE_PASS ${root}`);
    return;
  }
  if (receipt.uncertain || !receipt.databaseDropped || !receipt.dataRemoved) {
    throw new Error(`The isolated fixture was preserved; private recovery receipt: ${receiptPath}`);
  }
  console.log(`ISOLATED_AGENT_SETTINGS_CLEANUP_PASS ${root}`);
  if (bodyFailure) throw bodyFailure;
}

void main().catch(error => {
  // Never print driver errors, child env or connection URLs.
  console.error(error instanceof Error && /^(?:The isolated fixture was preserved;|The actual agent-switch browser assertion failed;)/u.test(error.message)
    ? error.message : 'Isolated agent settings acceptance stopped safely.');
  process.exitCode = 1;
});
