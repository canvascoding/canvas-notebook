import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash, createPublicKey, timingSafeEqual, X509Certificate } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Module from 'node:module';
import { parse as parseEnv } from 'dotenv';
import { Pool } from 'pg';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseURL = 'http://127.0.0.1:3001';
const ownFlag = 'CANVAS_PLUGIN_EXTENSION_E2E';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fixtureLogo = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#2563eb"/><path d="M33 15a14 14 0 1 0 0 18" fill="none" stroke="#fff" stroke-width="6"/></svg>';

async function readPrivateFile(file, maxBytes = 64 * 1024) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat();
    assert(held.isFile() && held.nlink === 1 && held.uid === process.getuid?.()
      && (held.mode & 0o077) === 0 && held.size > 0 && held.size <= maxBytes,
    'The requested fixture input must be an owned private regular file.');
    const bytes = await handle.readFile();
    const current = await fs.lstat(file);
    assert(current.isFile() && !current.isSymbolicLink() && current.dev === held.dev && current.ino === held.ino
      && current.size === held.size && bytes.length === held.size);
    return bytes.toString('utf8');
  } finally { await handle.close(); }
}

async function assertFreePort() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error('Port 3001 is occupied; its current process will not be changed.')));
    probe.listen({ host: '127.0.0.1', port: 3001, exclusive: true }, () => probe.close(error => error ? reject(error) : resolve()));
  });
}

async function launch() {
  const chatInline = process.argv.length === 3 && process.argv[2] === '--chat-inline';
  assert(process.argv.length === 2 || chatInline, 'Choose the default or fixed --chat-inline acceptance.');
  await assertFreePort();
  const privateEnv = parseEnv(await readPrivateFile(path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env')));
  assert(privateEnv.BOOTSTRAP_ADMIN_EMAIL?.trim() && privateEnv.BOOTSTRAP_ADMIN_PASSWORD?.length >= 8,
    'The existing private bootstrap credentials are required.');
  const maintenance = new URL(privateEnv.DATABASE_URL || '');
  assert(['postgres:', 'postgresql:'].includes(maintenance.protocol) && maintenance.hostname === '127.0.0.1'
    && maintenance.port === '55433' && maintenance.username && !maintenance.search && !maintenance.hash,
  'The runner only uses the existing managed local PostgreSQL service.');
  maintenance.pathname = '/postgres';
  const controlPlaneRoot = await fs.realpath(path.join(repo, '..', 'canvas-control-plane'));
  await fs.access(path.join(controlPlaneRoot, 'apps/api/src/routes/license.ts'));
  const clean = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  Object.assign(clean, {
    [ownFlag]: '1', CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN: '1',
    CANVAS_CONTROL_PLANE_TEST_ROOT: controlPlaneRoot, DATABASE_URL: maintenance.toString(),
    BOOTSTRAP_ADMIN_EMAIL: privateEnv.BOOTSTRAP_ADMIN_EMAIL,
    BOOTSTRAP_ADMIN_PASSWORD: privateEnv.BOOTSTRAP_ADMIN_PASSWORD,
    NODE_ENV: 'test', __NEXT_PROCESSED_ENV: 'true', NEXT_TELEMETRY_DISABLED: '1',
    ...(chatInline ? { CANVAS_CHAT_INLINE_E2E: '1' } : {}),
  });
  const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', fileURLToPath(import.meta.url), '--fixture', ...(chatInline ? ['--chat-inline'] : [])], {
    cwd: repo, env: clean, stdio: ['ignore', 'inherit', 'inherit'],
  });
  const cancel = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  const result = await new Promise(resolve => {
    child.once('error', () => resolve(1));
    child.once('close', code => resolve(code ?? 1));
  });
  process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
  process.exitCode = result;
}

/** A request path can never become a second URL authority or a redirect target. */
export function ownedFixtureUpstreamUrl(originInput, selected, allowedPath) {
  const own = new URL(originInput);
  assert(own.protocol === 'http:' && own.hostname === '127.0.0.1' && own.port
    && own.pathname === '/' && !own.search && !own.hash && !own.username && !own.password);
  assert(selected instanceof URL && !selected.username && !selected.password && !selected.hash && allowedPath(selected.pathname));
  const upstream = new URL('http://127.0.0.1/');
  upstream.port = own.port;
  upstream.pathname = selected.pathname;
  upstream.search = selected.search;
  assert(upstream.protocol === 'http:' && upstream.hostname === '127.0.0.1' && upstream.origin === own.origin
    && !upstream.username && !upstream.password && !upstream.hash
    && upstream.pathname === selected.pathname && upstream.search === selected.search && allowedPath(upstream.pathname));
  return upstream;
}

function allowedConsentSdkPath(pathname, method) {
  if (method === 'GET') return ['/api/v3.1/toolkits', '/api/v3.1/auth_configs', '/api/v3.1/connected_accounts', '/api/v3.1/tools'].includes(pathname)
    || /^\/api\/v3\.1\/tools\/[A-Z][A-Z0-9_]{0,127}$/u.test(pathname);
  if (method === 'POST') return pathname === '/api/v3.1/tool_router/session'
    || /^\/api\/v3\.1\/tool_router\/session\/fixture-session-[1-9]\d*\/link$/u.test(pathname);
  return method === 'DELETE' && /^\/api\/v3\.1\/connected_accounts\/fixture-initiated-[1-9]\d*$/u.test(pathname);
}

/** The production Store keeps HTTPS validation; only owned fixture origins are translated. */
export async function startRegistryTlsProxy(registry, keyPath, certificatePath) {
  const upstreamOrigin = new URL(registry.baseUrl);
  assert(upstreamOrigin.protocol === 'http:' && upstreamOrigin.hostname === '127.0.0.1' && upstreamOrigin.port
    && upstreamOrigin.pathname === '/' && !upstreamOrigin.search && !upstreamOrigin.hash && !upstreamOrigin.username && !upstreamOrigin.password);
  const key = await readPrivateFile(keyPath), cert = await readPrivateFile(certificatePath), certificate = new X509Certificate(cert);
  assert(certificate.checkIP('127.0.0.1') && certificate.ca && certificate.checkIssued(certificate) && certificate.verify(certificate.publicKey));
  assert.equal(createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'),
    certificate.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  const stats = { registryReads: 0, archiveReads: 0, iconReads: 0, rejectedRequests: 0 };
  const allowed = pathname => pathname === '/registry/extensions'
    || /^\/archives\/extensions\/(?:plugin|skill)\/[a-z0-9-]+\/\d+\.\d+\.\d+\.zip$/u.test(pathname);
  let origin;
  const rewrite = value => {
    const url = new URL(value);
    assert(url.origin === upstreamOrigin.origin && !url.username && !url.password && allowed(url.pathname));
    return new URL(url.pathname + url.search + url.hash, origin).toString();
  };
  const server = https.createServer({ key, cert }, async (request, response) => {
    try {
      assert(typeof request.url === 'string' && request.url.length <= 4096 && request.method === 'GET');
      const selected = new URL(request.url, origin);
      if (selected.origin === origin && selected.pathname === '/logos/canva.svg' && !selected.search && !selected.hash) {
        stats.iconReads += 1;
        const bytes = Buffer.from(fixtureLogo); response.writeHead(200, { 'Content-Type': 'image/svg+xml',
          'Content-Length': bytes.length, 'Cache-Control': 'no-store' }); response.end(bytes); return;
      }
      assert(selected.origin === origin && !selected.username && !selected.password && allowed(selected.pathname));
      const upstream = ownedFixtureUpstreamUrl(upstreamOrigin, selected, allowed);
      assert(upstream.origin === upstreamOrigin.origin && upstream.hostname === '127.0.0.1' && upstream.protocol === 'http:');
      const result = await fetch(upstream, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const chunks = []; let size = 0;
      for await (const chunk of result.body || []) { size += chunk.length; assert(size <= 32 * 1024 * 1024); chunks.push(Buffer.from(chunk)); }
      let body = Buffer.concat(chunks);
      if (selected.pathname === '/registry/extensions') {
        stats.registryReads += 1; assert(size <= 1024 * 1024);
        if (result.ok) {
          const metadata = JSON.parse(body.toString('utf8'));
          for (const kind of ['plugins', 'skills']) {
            assert(Array.isArray(metadata[kind]));
            for (const offering of metadata[kind]) {
              assert(offering.versions && typeof offering.versions === 'object' && !Array.isArray(offering.versions));
              for (const version of Object.values(offering.versions)) version.downloadUrl = rewrite(version.downloadUrl);
              if (typeof offering.name === 'string' && offering.name.startsWith('canva-')) offering.icon = `${origin}/logos/canva.svg`;
            }
          }
          body = Buffer.from(JSON.stringify(metadata));
        }
      } else stats.archiveReads += 1;
      response.writeHead(result.status, { 'Content-Type': selected.pathname === '/registry/extensions' ? 'application/json' : 'application/zip',
        'Content-Length': body.length, 'Cache-Control': 'no-store' }); response.end(body);
    } catch {
      stats.rejectedRequests += 1;
      if (!response.headersSent) response.writeHead(400, { 'Cache-Control': 'no-store' }); response.end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `https://127.0.0.1:${server.address().port}`;
  return { origin, stats, logoUrl: `${origin}/logos/canva.svg`, fingerprint: certificate.fingerprint256, registryUrl: value => rewrite(registry.registryUrl(value)),
    async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

/** A browser approves this local provider; only the upstream fixture account changes. */
export async function startConsentProxy(provider, registry, token, logoUrl) {
  const logo = new URL(logoUrl);
  assert(logo.protocol === 'https:' && logo.hostname === '127.0.0.1' && logo.port && logo.pathname === '/logos/canva.svg'
    && !logo.search && !logo.hash && !logo.username && !logo.password);
  const flows = new Map();
  const upstreamOrigin = new URL(provider.baseUrl);
  // Validate the trusted local listener before accepting any request.
  ownedFixtureUpstreamUrl(upstreamOrigin, new URL('/api/v3.1/toolkits', upstreamOrigin), path => allowedConsentSdkPath(path, 'GET'));
  const counters = { approvals: 0, denials: 0, sdkLinks: 0, callbackRedirects: 0, businessCalls: 0, blockedExternalRedirects: 0, laterToolkitPageReads: 0 };
  let origin;
  const callbacks = new Set(['/api/composio/callback', '/api/composio/shared/callback', '/api/composio/shared/desktop/callback']);
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  const server = http.createServer(async (request, response) => {
    try {
      assert(typeof request.url === 'string' && request.url.length <= 4096);
      const address = new URL(request.url, origin);
      assert(address.origin === origin && !address.username && !address.password && !address.hash);
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; assert(length <= 1024 * 1024); chunks.push(chunk); }
      const raw = Buffer.concat(chunks);
      const send = (status, body) => { response.writeHead(status, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
      if (address.pathname === '/__fixture') {
        const supplied = Buffer.from(request.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { error: 'unauthorized' });
        if (request.method === 'GET') return send(200, { counters, toolkitReads: provider.calls.filter(call => /\/toolkits$/u.test(call.path)).length });
        if (request.method === 'POST') {
          const command = JSON.parse(raw.toString('utf8'));
          assert(Object.keys(command).sort().join(',') === 'operation,status' && command.operation === 'registry-status'
            && [200, 503].includes(command.status));
          registry.setStatus('extensions', command.status); return send(200, { success: true });
        }
        return send(405, { error: 'method_not_allowed' });
      }
      const ticket = /^\/consent\/([a-f0-9]{48})$/u.exec(address.pathname)?.[1];
      if (ticket) {
        const flow = flows.get(ticket);
        if (!flow || flow.used || flow.expiresAt <= Date.now()) return send(410, { error: 'consent_unavailable' });
        if (request.method === 'GET') {
          response.writeHead(200, { ...headers, 'Referrer-Policy': 'same-origin', 'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': `default-src 'none'; form-action 'self' ${baseURL}; frame-ancestors 'none'; base-uri 'none'` });
          response.end(`<!doctype html><html lang="en"><title>Local integration consent</title><main><h1>Connect Canvas Notebook</h1><p>Authorize this local test integration.</p><form method="post"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form></main></html>`);
          return;
        }
        if (request.method !== 'POST' || request.headers.origin !== origin) return send(403, { error: 'invalid_origin' });
        const form = new URLSearchParams(raw.toString('utf8'));
        assert(form.getAll('decision').length === 1 && [...form.keys()].every(key => key === 'decision'));
        const decision = form.get('decision'); assert(['approve', 'deny'].includes(decision));
        flow.used = true;
        const current = provider.accounts.get(flow.entityId)?.find(account => account.id === flow.accountId && account.toolkit === flow.toolkit);
        assert(current?.status === 'INITIATED', 'Only the exact issued pending account may be approved.');
        const target = new URL(flow.callback);
        assert(target.origin === baseURL && callbacks.has(target.pathname) && !target.username && !target.password && !target.hash);
        if (decision === 'approve') {
          assert.equal(provider.completeOAuth(flow.accountId), flow.callback); counters.approvals += 1;
        } else { current.status = 'FAILED'; target.searchParams.set('error', 'access_denied'); counters.denials += 1; }
        counters.callbackRedirects += 1;
        response.writeHead(303, { ...headers, Location: target.href }); response.end(); return;
      }
      if (/\/tools\/(?:execute|proxy)|\/tool_router\/.*\/execute/u.test(address.pathname)) {
        counters.businessCalls += 1; return send(403, { error: 'business_call_disabled' });
      }
      const upstream = ownedFixtureUpstreamUrl(upstreamOrigin, address, pathname => allowedConsentSdkPath(pathname, request.method));
      assert(upstream.origin === upstreamOrigin.origin && upstream.hostname === '127.0.0.1' && upstream.protocol === 'http:');
      if (address.pathname === '/api/v3.1/toolkits' && address.searchParams.has('cursor')) counters.laterToolkitPageReads += 1;
      const forwardedHeaders = {};
      for (const name of ['content-type', 'x-api-key']) if (typeof request.headers[name] === 'string') forwardedHeaders[name] = request.headers[name];
      const upstreamResponse = await fetch(upstream, { method: request.method, headers: forwardedHeaders,
        ...(raw.length ? { body: raw } : {}), redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const bytes = await upstreamResponse.text(); assert(Buffer.byteLength(bytes) <= 1024 * 1024);
      const body = JSON.parse(bytes);
      if (address.pathname === '/api/v3.1/toolkits' && upstreamResponse.ok) {
        assert(Array.isArray(body.items));
        for (const toolkit of body.items) if (toolkit.slug === 'canva') toolkit.meta = { ...toolkit.meta, logo: logo.href };
      }
      if (/\/tool_router\/session\/[^/]+\/link$/u.test(address.pathname) && upstreamResponse.ok) {
        const input = JSON.parse(raw.toString('utf8')), callback = new URL(input.callback_url);
        if (callback.origin !== baseURL || !callbacks.has(callback.pathname) || callback.username || callback.password || callback.hash) {
          counters.blockedExternalRedirects += 1; return send(400, { error: 'invalid_fixture_callback' });
        }
        const accountId = body.connected_account_id;
        let entityId;
        for (const [entity, accounts] of provider.accounts) if (accounts.some(account => account.id === accountId && account.toolkit === input.toolkit && account.status === 'INITIATED')) entityId = entity;
        assert(entityId && typeof accountId === 'string');
        const ticketValue = randomBytes(24).toString('hex');
        flows.set(ticketValue, { accountId, entityId, toolkit: input.toolkit, callback: callback.href, used: false, expiresAt: Date.now() + 10 * 60_000 });
        body.redirect_url = `${origin}/consent/${ticketValue}`; counters.sdkLinks += 1;
      }
      return send(upstreamResponse.status, body);
    } catch { if (!response.headersSent) response.writeHead(400, headers); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, counters, async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); flows.clear(); } };
}

async function activateFixtureLicense(ready, env) {
  assert(ready.version === 1 && ready.nonce === env.PLUGIN_EXTENSION_E2E_NONCE && ready.instanceId === env.CANVAS_INSTANCE_ID);
  const address = new URL(ready.origin); assert(address.hostname === '127.0.0.1' && address.protocol === 'http:' && address.port);
  for (const [key, fingerprint] of [[ready.initialPublicKey, ready.initialPublicKeyFingerprint], [ready.testPublicKey, ready.testPublicKeyFingerprint]]) {
    assert.equal(createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex'), fingerprint);
  }
  Object.assign(env, {
    CANVAS_LICENSE_CONTROL_PLANE_URL: ready.origin, CANVAS_LICENSE_PUBLIC_KEY: ready.initialPublicKey,
    CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS: ready.initialPublicKeyFingerprint,
    CANVAS_LICENSE_TEST_PUBLIC_KEY: ready.testPublicKey, CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS: ready.testPublicKeyFingerprint,
    CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_TEST_AUDIENCE: 'canvas-notebook-test',
    CANVAS_TEAM_SEAT_CLIENT_ENABLED: 'true', CANVAS_TEAM_SEAT_COMMUNITY_CLAIM_ENABLED: 'true', CANVAS_TEAM_SEAT_MEMBERSHIP_MUTATIONS_ENABLED: 'true',
  });
  Object.assign(process.env, env);
  const { activateLicenseCert } = await import('../app/lib/license/index.ts');
  const { startCommunityLicenseClaim, pollCommunityLicenseClaim, refreshCommunityLicenseCertificate } = await import('../app/lib/license/control-plane.ts');
  assert.equal(path.dirname(ready.certificatePath), env.PLUGIN_EXTENSION_E2E_ROOT);
  const activated = await activateLicenseCert(await readPrivateFile(ready.certificatePath)); assert(activated.licensed);
  const claim = await startCommunityLicenseClaim(); assert(claim.state === 'authorization_pending' && claim.userCode && claim.claimId);
  const control = async (operation, body) => {
    const response = await fetch(`${ready.origin}/__owned/${operation}`, { method: 'POST', headers: {
      Authorization: `Bearer ${ready.controlSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    assert(response.status === 200, 'The real local issuer must acknowledge the requested operation.');
    const value = await response.json(); assert(value.success && value.licenseId === ready.licenseId && value.instanceId === ready.instanceId);
  };
  await control('approve-claim', { userCode: claim.userCode });
  const deadline = Date.now() + 30_000; let connected = false;
  while (!connected && Date.now() < deadline) { connected = (await pollCommunityLicenseClaim(claim.claimId)).state === 'connected'; if (!connected) await sleep(250); }
  assert(connected, 'The real local claim must finish.'); await control('development-grant', {});
  env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development'; process.env.CANVAS_LICENSE_RUNTIME_ENVIRONMENT = 'development';
  const refreshed = await refreshCommunityLicenseCertificate();
  assert(refreshed.status.licensed && refreshed.status.edition === 'team' && refreshed.status.licenseClass === 'test'
    && refreshed.status.licenseEnvironment === 'development' && refreshed.details.id === ready.licenseId);
  Object.assign(env, { CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true' }); Object.assign(process.env, env);
}

async function runFixture() {
  const chatInline = process.argv.length === 4 && process.argv[3] === '--chat-inline' && process.env.CANVAS_CHAT_INLINE_E2E === '1';
  assert((process.argv.length === 3 || chatInline) && process.argv[2] === '--fixture' && process.env[ownFlag] === '1' && process.env.NODE_ENV === 'test');
  await assertFreePort();
  const maintenance = new URL(process.env.DATABASE_URL); assert(maintenance.hostname === '127.0.0.1' && maintenance.port === '55433' && maintenance.pathname === '/postgres');
  const nonce = randomBytes(16).toString('hex'), marker = randomBytes(24).toString('hex');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-extension-e2e-'))); await fs.chmod(root, 0o700);
  const rootStat = await fs.lstat(root), dataRoot = path.join(root, 'data'), tmpRoot = path.join(root, 'tmp'), results = path.join(root, 'results');
  for (const directory of [dataRoot, tmpRoot, results]) await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(root, '.fixture-owner'), marker, { mode: 0o600 });
  const emptyEnv = path.join(root, 'empty.env'); await fs.writeFile(emptyEnv, '', { mode: 0o600 });
  const databaseName = `canvas_plugin_extension_test_${nonce}`, runtimeURL = new URL(maintenance); runtimeURL.pathname = `/${databaseName}`;
  const receiptPath = path.join(root, 'recovery.json');
  const receipt = { version: 1, nonce, repo, fixtureRoot: root, dataRoot, tmpRoot, ownerMarker: marker,
    rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), databaseName, databaseOwner: null,
    createAcknowledged: false, actorId: null, phase: 'before_create', uncertain: false, listenerVerified: false,
    databaseDropped: false, serverPid: null, issuerPid: null, browserPid: null };
  const persist = async () => { const temporary = `${receiptPath}.tmp`; await fs.writeFile(temporary, JSON.stringify(receipt), { mode: 0o600 }); await fs.rename(temporary, receiptPath); };
  await persist();
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD', 'CANVAS_CONTROL_PLANE_TEST_ROOT']
    .flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  Object.assign(env, {
    [ownFlag]: '1', CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN: '1', NODE_ENV: 'test', __NEXT_PROCESSED_ENV: 'true', NEXT_TELEMETRY_DISABLED: '1',
    ...(chatInline ? { CANVAS_CHAT_INLINE_E2E: '1' } : {}),
    DATABASE_URL: runtimeURL.toString(), CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_POOL_MAX: '8',
    DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_APP_ROOT: repo, CANVAS_ENV_FILE: emptyEnv, TMPDIR: tmpRoot,
    CANVAS_INSTANCE_ID: `agent-settings-browser-${nonce}`, CANVAS_ORGANIZATION_ID: `agent-settings-browser-${nonce}`,
    CANVAS_PLUGIN_LOCAL_SOURCE_ROOT: path.join(dataRoot, 'intake'),
    CANVAS_DEPLOYMENT_MODE: 'community', CANVAS_TEAM_FEATURES_ENABLED: 'false', CANVAS_PROJECT_FEATURES_ENABLED: 'false',
    CANVAS_TEAM_LICENSE_REFRESH_ENABLED: 'false', CANVAS_TEAM_LICENSE_LIFECYCLE_ENABLED: 'false',
    CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false', QMD_ENABLED: 'false', ONBOARDING: 'false', ONBOARDING_HINTS: 'false',
    MCP_ALLOW_PRIVATE_NETWORK: 'true', MCP_ALLOW_INSECURE_HTTP: 'true',
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'), INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'),
    BOOTSTRAP_ADMIN_NAME: 'Plugin extension test owner',
    HOSTNAME: '127.0.0.1', PORT: '3001', BASE_URL: baseURL, BETTER_AUTH_BASE_URL: baseURL, E2E_EXTERNAL_SERVER: '1',
    TEST_LOGIN_EMAIL: env.BOOTSTRAP_ADMIN_EMAIL, TEST_LOGIN_PASSWORD: env.BOOTSTRAP_ADMIN_PASSWORD,
    TEST_SECONDARY_EMAIL: `plugin-extension-member-${nonce}@example.test`, TEST_SECONDARY_PASSWORD: randomBytes(24).toString('base64url'),
    AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE: receiptPath, PLUGIN_EXTENSION_E2E_ROOT: root, PLUGIN_EXTENSION_E2E_NONCE: nonce,
    PLUGIN_EXTENSION_E2E_FIXTURE: path.join(root, 'fixture.json'), PLUGIN_EXTENSION_E2E_CONTROL_TOKEN: randomBytes(32).toString('base64url'),
  });
  for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, env);
  const administration = new Pool({ connectionString: maintenance.toString(), max: 1, connectionTimeoutMillis: 5000, query_timeout: 30_000 });
  const children = []; let database, issuer, host, provider, consent, mcp, registry, registryTls, modelFixture, failure;
  const originalModuleLoad = Module._load;
  const abort = new AbortController();
  const cancelled = () => { receipt.uncertain = true; abort.abort(); for (const child of children) if (!child.ended && child.process.pid === child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Preserve on uncertain cancellation. */ } } };
  process.once('SIGTERM', cancelled); process.once('SIGINT', cancelled);
  const redacted = value => [env.BOOTSTRAP_ADMIN_PASSWORD, env.TEST_SECONDARY_PASSWORD, env.BETTER_AUTH_SECRET, env.INTEGRATIONS_ENV_MASTER_KEY,
    env.PLUGIN_EXTENSION_E2E_CONTROL_TOKEN, env.COMPOSIO_API_KEY, runtimeURL.toString(), maintenance.toString()].filter(Boolean)
    .reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value).replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-postgres-url]');
  const start = (command, args, phase, extra = {}) => {
    abort.signal.throwIfAborted();
    const log = createWriteStream(path.join(root, `${phase}.log`), { mode: 0o600 });
    const childEnv = { ...env, ...extra };
    if (phase !== 'browser') delete childEnv.PLUGIN_EXTENSION_E2E_CONTROL_TOKEN;
    const child = spawn(command, args, { cwd: repo, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tracked = { process: child, pid: child.pid, ended: false, closed: null }; children.push(tracked);
    for (const stream of [child.stdout, child.stderr]) {
      let buffered = '';
      stream.on('data', chunk => { buffered += chunk.toString(); const lines = buffered.split('\n'); buffered = lines.pop() || ''; for (const line of lines) log.write(`${redacted(line)}\n`); if (buffered.length > 32768) { log.write('[oversized log omitted]\n'); buffered = ''; } });
      stream.on('end', () => { if (buffered) log.write(redacted(buffered)); });
    }
    tracked.closed = new Promise(resolve => { child.once('error', () => { receipt.uncertain = true; }); child.once('close', code => { tracked.ended = true; log.end(); resolve(code); }); });
    return tracked;
  };
  const wait = async (child, timeout) => { let timer; try { return await Promise.race([child.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The owned test child exceeded its deadline.')), timeout); })]); } finally { clearTimeout(timer); } };
  const stop = async child => {
    if (!child || child.ended) return;
    assert(child.process.pid === child.pid && child.process.exitCode === null && child.process.signalCode === null);
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    try { await wait(child, 20_000); } catch { receipt.uncertain = true; if (!child.ended) { process.kill(-child.pid, 'SIGKILL'); await wait(child, 5000); } }
  };
  try {
    assert.equal((await administration.query('SELECT datname FROM pg_database WHERE datname=$1', [databaseName])).rowCount, 0);
    receipt.databaseOwner = (await administration.query('SELECT current_user AS role')).rows[0].role;
    receipt.phase = 'create_in_flight'; await persist(); await administration.query(`CREATE DATABASE "${databaseName}"`);
    receipt.createAcknowledged = true; receipt.phase = 'migrations'; await persist();
    database = new Pool({ connectionString: runtimeURL.toString(), max: 2, connectionTimeoutMillis: 5000 });
    const { runPostgresMigrations } = await import('../app/lib/db/postgres.ts'); await runPostgresMigrations(database);
    await administration.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
    const { createInitialOwner } = await import('../app/lib/auth-setup.ts');
    const owner = await createInitialOwner({ name: env.BOOTSTRAP_ADMIN_NAME, email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD });
    receipt.actorId = owner.id; receipt.phase = 'bootstrap'; await persist();
    issuer = start(process.execPath, ['--import', 'tsx', 'scripts/helpers/agent-workflow-team-issuer-fixture.ts'], 'issuer', {
      NODE_ENV: 'development', CANVAS_ISSUER_MAINTENANCE_DATABASE_URL: maintenance.toString(),
    }); receipt.issuerPid = issuer.pid; await persist();
    const issuerDeadline = Date.now() + 120_000; let ready;
    while (!ready && !issuer.ended && Date.now() < issuerDeadline) {
      abort.signal.throwIfAborted();
      try { ready = JSON.parse(await readPrivateFile(path.join(root, 'issuer-ready.json'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!ready) await sleep(250);
    }
    assert(ready && !issuer.ended, 'The local CP issuer must become ready.'); await activateFixtureLicense(ready, env);
    const { createComposioProviderFixture } = await import('./helpers/composio-provider-fixture.ts'); provider = await createComposioProviderFixture();
    const { startMcpOAuthProvider } = await import('../tests/fixtures/mcp-oauth-provider.mjs');
    const { createPackageStoreRegistryFixture } = await import('./helpers/package-store-registry-fixture.ts'); registry = await createPackageStoreRegistryFixture(root);
    const keyPath = path.join(root, 'registry-key.pem'), certificatePath = path.join(root, 'registry-ca.pem');
    const tls = start('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', keyPath, '-out', certificatePath], 'tls-certificate');
    assert.equal(await wait(tls, 15_000), 0, 'The owned registry CA must be generated.');
    for (const file of [keyPath, certificatePath]) await fs.chmod(file, 0o600);
    registryTls = await startRegistryTlsProxy(registry, keyPath, certificatePath);
    receipt.registryTls = { origin: registryTls.origin, fingerprint: registryTls.fingerprint, certificatePath }; await persist();
    const mcpKeyPath = path.join(root, 'mcp-key.pem'), mcpCertificatePath = path.join(root, 'mcp-ca.pem');
    const mcpTls = start('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', mcpKeyPath, '-out', mcpCertificatePath], 'mcp-tls-certificate');
    assert.equal(await wait(mcpTls, 15_000), 0, 'The own MCP HTTPS certificate must be generated.');
    for (const file of [mcpKeyPath, mcpCertificatePath]) await fs.chmod(file, 0o600);
    const mcpKey = await readPrivateFile(mcpKeyPath), mcpCert = await readPrivateFile(mcpCertificatePath), mcpCertificate = new X509Certificate(mcpCert);
    assert(mcpCertificate.checkIP('127.0.0.1') && mcpCertificate.ca && mcpCertificate.checkIssued(mcpCertificate)
      && mcpCertificate.verify(mcpCertificate.publicKey));
    const mcpPublicKey = mcpCertificate.publicKey.export({type: 'spki', format: 'der'});
    assert(mcpPublicKey.equals(createPublicKey(mcpKey).export({type: 'spki', format: 'der'})));
    assert.notEqual(mcpCertificate.fingerprint256, registryTls.fingerprint, 'Browser MCP trust must never cover the intentionally untrusted registry logo.');
    const mcpSpki = createHash('sha256').update(mcpPublicKey).digest('base64');
    const registryCert = await readPrivateFile(certificatePath);
    assert.notEqual(mcpSpki, createHash('sha256').update(new X509Certificate(registryCert).publicKey.export({type: 'spki', format: 'der'})).digest('base64'));
    const caBundlePath = path.join(root, 'provider-ca-bundle.pem');
    await fs.writeFile(caBundlePath, `${registryCert}\n${mcpCert}`, {mode: 0o600, flag: 'wx'});
    mcp = await startMcpOAuthProvider({allowedRedirectOrigins: [baseURL], tls: {key: mcpKey, cert: mcpCert}, passiveLogo: true});
    receipt.mcpTls = {origin: mcp.origin, fingerprint: mcpCertificate.fingerprint256, spki: mcpSpki, certificatePath: mcpCertificatePath}; await persist();
    consent = await startConsentProxy(provider, registry, env.PLUGIN_EXTENSION_E2E_CONTROL_TOKEN, registryTls.logoUrl);
    env.COMPOSIO_BASE_URL = consent.origin; env.PLUGIN_EXTENSION_E2E_CONTROL_URL = `${consent.origin}/__fixture`;
    env.COMPOSIO_API_KEY = `fixture-${randomBytes(24).toString('hex')}`;
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config.ts');
    for (const scope of [{ secretScope: 'system' }, { secretScope: 'organization', organizationId: env.CANVAS_ORGANIZATION_ID }]) {
      await replaceScopedEnvEntries('integrations', [{ key: 'COMPOSIO_API_KEY', value: env.COMPOSIO_API_KEY }], scope);
    }
    const { computeCanvasPluginChecksum } = await import('../app/lib/plugins/canvas-plugin-registry.ts');
    const packageName = `canva-workflow-${nonce.slice(0, 10)}`, skillName = `canva-brief-${nonce.slice(0, 10)}`;
    const manifest = { name: packageName, version: '1.0.0', description: 'Canva integration and MCP acceptance package', skills: './skills',
      interface: { logo: './logo.svg' },
      connectors: { composio: [{ toolkit: 'canva', label: 'Canva', required: true }, { toolkit: 'github', label: 'GitHub', required: false, recommended: true }],
        mcp: [{ name: 'Canva MCP', label: 'Canva MCP', required: true, oauth: true, configPath: '.mcp.json' }] } };
    const packageFiles = { '.canvas-plugin/plugin.json': JSON.stringify(manifest),
      'logo.svg': fixtureLogo,
      [`skills/${packageName}-context/SKILL.md`]: `---\nname: ${packageName}-context\ndescription: Canva design context\nmetadata:\n  version: "1.0.0"\n---\nPrepare a design brief.\n`,
      [`skills/${packageName}-context/agents/canvas.yaml`]: 'interface:\n  icon_small: ./logo.svg\n',
      [`skills/${packageName}-context/logo.svg`]: fixtureLogo,
      '.mcp.json': JSON.stringify({ mcpServers: { 'Canva MCP': { url: mcp.url } } }) };
    const source = await registry.addPackage('extensions', 'plugin', packageName, '1.0.0', packageFiles, computeCanvasPluginChecksum);
    const skill = await registry.addPackage('extensions', 'skill', skillName, '1.0.0', { 'SKILL.md': `---\nname: ${skillName}\ndescription: Canva standalone design brief\nmetadata:\n  version: "1.0.0"\n---\nCreate a standalone brief.\n`,
      'agents/canvas.yaml': 'interface:\n  icon_small: ./logo.svg\n', 'logo.svg': fixtureLogo }, computeCanvasPluginChecksum);
    for (let index = 0; index < 21; index += 1) {
      const name = `catalog-extra-${String(index).padStart(2, '0')}`;
      await registry.addPackage('extensions', 'skill', name, '1.0.0', { 'SKILL.md': `---\nname: ${name}\ndescription: Pagination acceptance fixture\nmetadata:\n  version: "1.0.0"\n---\nInspect the current context.\n` }, computeCanvasPluginChecksum);
    }
    Object.assign(env, { CANVAS_PLUGIN_STORE_REGISTRY_URL: registryTls.registryUrl('extensions'), CANVAS_SKILL_STORE_REGISTRY_URL: registryTls.registryUrl('extensions'),
      CANVAS_DATABASE_MIGRATIONS_COMPLETED: 'true' }); Object.assign(process.env, env);
    // The real SDK exports ESM-only entrypoints. The standalone TS fixture is
    // compiled as CJS by tsx; bridge to the actual imported module namespaces,
    // as the existing native fixtures do. No SDK or application code is mocked.
    const piModules = new Map();
    for (const name of ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-ai/compat', '@earendil-works/pi-ai/oauth']) {
      piModules.set(name, await import(name));
    }
    Module._load = function (name, parent, isMain) {
      return piModules.has(name) ? piModules.get(name) : originalModuleLoad.call(this, name, parent, isMain);
    };
    const createModel = chatInline ? (await import('./helpers/chat-inline-model-fixture.ts')).createChatInlineModelFixture
      : (await import('./helpers/agent-extension-model-fixture.ts')).createAgentExtensionModelFixture;
    modelFixture = await createModel({ nonce, organizationId: env.CANVAS_ORGANIZATION_ID, actorUserId: owner.id });
    const fixture = { version: 1, nonce, repo, root, actorId: owner.id, databaseName, dataRoot, baseURL,
      model: modelFixture.model,
      ...(chatInline ? { modelProofUrl: `${modelFixture.origin}/__owned/${nonce}/proof` } : {}),
      packageName, skillName, mcpUrl: mcp.url, mcpSpki, composioOrigin: consent.origin, logoUrl: registryTls.logoUrl, registryId: 'store-extensions',
      sources: [{ kind: 'plugin', registryId: 'store-extensions', entryKey: packageName, version: '1.0.0', checksum: source.checksum },
        { kind: 'skill', registryId: 'store-extensions', entryKey: skillName, version: '1.0.0', checksum: skill.checksum }] };
    const { prepareAgentExtensionToolBrowserFixture, verifyAgentExtensionToolBrowserFixture } = await import('./helpers/agent-extension-tool-browser-fixture.ts');
    fixture.toolAgent = await prepareAgentExtensionToolBrowserFixture(fixture);
    await fs.writeFile(env.PLUGIN_EXTENSION_E2E_FIXTURE, JSON.stringify(fixture), { mode: 0o600, flag: 'wx' });
    if (chatInline) {
      // The admission/claim process must actually terminate before the new
      // production host reads its durable queue. A browser reload is not this boundary.
      const seeded = start(process.execPath, ['--conditions=react-server', '--import', 'tsx',
        'scripts/helpers/chat-queue-recovery-browser-fixture.ts', '--seed', env.PLUGIN_EXTENSION_E2E_FIXTURE],
      'queue-seed', { NODE_EXTRA_CA_CERTS: caBundlePath });
      receipt.queueSeedPid = seeded.pid; receipt.queueSeedExited = false; await persist();
      assert.equal(await wait(seeded, 120_000), 0, 'The separate durable-queue seed process must finish before restart acceptance.');
      assert(seeded.ended); receipt.queueSeedExited = true; await persist();
      const prepared = JSON.parse(await readPrivateFile(path.join(root, 'chat-queue-recovery-prepared.json')));
      assert.equal(prepared.version, 1); assert.equal(prepared.nonce, nonce); assert(prepared.prepared);
      fixture.queueRecovery = prepared.prepared;
      await fs.writeFile(env.PLUGIN_EXTENSION_E2E_FIXTURE, JSON.stringify(fixture), { mode: 0o600 });
    }
    receipt.phase = 'build'; await persist(); console.log(`PLUGIN_EXTENSION_E2E_BUILD ${root}`);
    const build = start('npm', ['run', 'build'], 'build', { NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=8192', NODE_EXTRA_CA_CERTS: caBundlePath }); assert.equal(await wait(build, 15 * 60_000), 0, 'The current worktree production build must pass.');
    fixture.buildId = (await fs.readFile(path.join(repo, '.next/BUILD_ID'), 'utf8')).trim(); assert(fixture.buildId);
    await fs.writeFile(env.PLUGIN_EXTENSION_E2E_FIXTURE, JSON.stringify(fixture), { mode: 0o600 });
    await assertFreePort(); host = start(process.execPath, ['--import', 'tsx', 'server.js'], 'host', { NODE_ENV: 'production', NODE_EXTRA_CA_CERTS: caBundlePath }); receipt.serverPid = host.pid; await persist();
    const deadline = Date.now() + 120_000; let healthy = false;
    while (!healthy && !host.ended && Date.now() < deadline) {
      abort.signal.throwIfAborted();
      try { const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(3000) }); const body = await response.json(); healthy = response.status === 200 && body.deployment?.mode === 'team' && body.deployment?.teamFeaturesEnabled === true; }
      catch { /* Only the owned listener is polled. */ }
      if (!healthy) await sleep(250);
    }
    assert(healthy && !host.ended, 'The fresh production host must become ready.');
    const inspect = args => new Promise((resolve, reject) => { const inspected = spawn('lsof', args, { stdio: ['ignore', 'pipe', 'ignore'] }); let output = ''; inspected.stdout.on('data', chunk => { output += chunk; }); inspected.once('error', reject); inspected.once('close', code => code === 0 ? resolve(output) : reject(new Error('The owned host process was not confirmed.'))); });
    const cwd = await inspect(['-a', '-p', String(host.pid), '-d', 'cwd', '-Fn']);
    const listener = await inspect(['-nP', '-iTCP:3001', '-sTCP:LISTEN', '-Fp']);
    assert(cwd.split('\n').includes(`n${repo}`));
    assert.deepEqual(listener.split('\n').filter(line => /^p\d+$/u.test(line)), [`p${host.pid}`]);
    receipt.listenerVerified = true; receipt.phase = 'browser'; await persist();
    console.log(`PLUGIN_EXTENSION_E2E_BROWSER ${root}`);
    const browser = start(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/playwright/playwright.plugin-extensions.config.ts'], 'browser', {PLUGIN_EXTENSION_E2E_MCP_SPKI: mcpSpki}); receipt.browserPid = browser.pid; await persist();
    const browserCode = await wait(browser, 20 * 60_000);
    await fs.writeFile(path.join(root, 'provider-proof.json'), JSON.stringify({ version: 1, nonce, composio: consent.counters, mcp: mcp.stats, registryTls: registryTls.stats,
      model: modelFixture.counts(),
      sdkBusinessCalls: provider.calls.filter(call => /\/tools\/execute\//u.test(call.path)).length }), { mode: 0o600 });
    assert.equal(browserCode, 0, 'The plugin extension browser acceptance must pass.');
    assert.equal(consent.counters.businessCalls, 0); assert.equal(mcp.stats.toolCalls, 0); assert.equal(consent.counters.blockedExternalRedirects, 0);
    assert(modelFixture.counts().catalogReads > 0); assert.equal(modelFixture.counts().forbiddenRequests, 0, 'The model fixture must receive only its explicitly supported requests.');
    if (chatInline) assert(modelFixture.counts().completions.some(row => row.hasSkillSentinel), 'A real SDK model request must receive the exact selected skill context.');
    assert(mcp.stats.iconDiscoveryReads > 0 && mcp.stats.iconReads > 0, 'The real cold MCP logo must be discovered and loaded from the owned passive HTTP(S) fixture.');
    assert.equal(provider.calls.filter(call => /\/tools\/execute\//u.test(call.path)).length, 0);
    const toolRoundtrip = await verifyAgentExtensionToolBrowserFixture(fixture);
    await fs.writeFile(path.join(root, 'agent-tool-roundtrip-verified.json'), JSON.stringify({ version: 1, nonce, ...toolRoundtrip }), { mode: 0o600 });
    if (chatInline) {
      const { verifyChatQueueRecoveryBrowserFixture } = await import('./helpers/chat-queue-recovery-browser-fixture.ts');
      const queueRecovery = await verifyChatQueueRecoveryBrowserFixture(fixture, fixture.queueRecovery);
      assert(receipt.queueSeedExited && receipt.queueSeedPid !== host.pid);
      await fs.writeFile(path.join(root, 'chat-queue-recovery-sql-verified.json'), JSON.stringify({ version: 1, nonce,
        seedProcessExited: true, seedPid: receipt.queueSeedPid, restartedHostPid: host.pid, ...queueRecovery }), { mode: 0o600 });
    }
    receipt.phase = 'verified'; await persist();
  } catch (error) {
    failure = error;
    await fs.writeFile(path.join(root, 'failure.log'), redacted(error instanceof Error ? error.stack || error.message : String(error)), { mode: 0o600 });
  }
  finally {
    for (const child of [...children].reverse()) { try { await stop(child); } catch { receipt.uncertain = true; } }
    for (const fixture of [modelFixture, consent, provider, mcp, registryTls, registry]) { try { await fixture?.close(); } catch { receipt.uncertain = true; } }
    try { const { closeDatabaseConnections } = await import('../app/lib/db/index.ts'); await closeDatabaseConnections(); } catch { receipt.uncertain = true; }
    Module._load = originalModuleLoad;
    try { await database?.end(); } catch { receipt.uncertain = true; }
    try {
      const issuerReceipt = issuer ? JSON.parse(await readPrivateFile(path.join(root, 'issuer-recovery.json'))) : null;
      if (issuer) assert(issuer.ended && issuer.process.exitCode === 0 && issuerReceipt?.nonce === nonce && issuerReceipt.databaseDropped === true && issuerReceipt.uncertain === false);
      const held = await fs.lstat(root); assert(held.isDirectory() && !held.isSymbolicLink() && String(held.dev) === receipt.rootDevice && String(held.ino) === receipt.rootInode);
      assert.equal(await readPrivateFile(path.join(root, '.fixture-owner')), marker);
      if (receipt.createAcknowledged && !receipt.uncertain && children.every(child => child.ended)) {
        const current = (await administration.query("SELECT pg_get_userbyid(datdba) AS owner,current_user AS role,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [databaseName])).rows[0];
        assert(current && current.owner === receipt.databaseOwner && current.owner === current.role && current.marker === marker);
        await administration.query(`DROP DATABASE "${databaseName}"`); receipt.databaseDropped = true;
        assert.equal((await administration.query('SELECT datname FROM pg_database WHERE datname=$1', [databaseName])).rowCount, 0);
        // Keep private artifacts and failed-run DATA for diagnosis; no managed filesystem is touched.
        receipt.phase = failure ? 'failed_cleaned' : 'cleaned';
      } else receipt.phase = 'preserved';
    } catch { receipt.uncertain = true; receipt.phase = 'preserved'; }
    await persist(); await administration.end(); process.removeListener('SIGTERM', cancelled); process.removeListener('SIGINT', cancelled);
  }
  if (receipt.uncertain || !receipt.databaseDropped) throw new Error(`The isolated fixture was preserved; inspect private receipt ${receiptPath}`);
  if (failure) throw new Error(`Plugin extension acceptance failed; private diagnostics ${root}`);
  console.log(`PLUGIN_EXTENSION_E2E_PASS ${root}`);
}

// Imported helpers remain inert; only this runner starts processes or providers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const work = process.argv[2] === '--fixture' ? runFixture : launch;
  void work().catch(error => {
    const safe = error instanceof Error && /^(?:The isolated fixture was preserved;|Plugin extension acceptance failed;)/u.test(error.message);
    console.error(safe ? error.message : 'Plugin extension acceptance stopped before changing an unrelated service.'); process.exitCode = 1;
  });
}
