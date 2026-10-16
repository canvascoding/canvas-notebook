import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {request as httpsRequest} from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {NextRequest} from 'next/server';
import {createCapabilityPackageStoreApplicationFixture} from './helpers/capability-package-store-application-fixture';
import type {PluginExtensionSourceResult} from '../app/lib/plugins/plugin-extension-integrations';

/** Trust only this test's own certificate; no global TLS exceptions or external provider requests. */
async function requestOwnedHttps(input: RequestInfo | URL, init: RequestInit | undefined, origin: string, certificate: Buffer): Promise<Response> {
  const outgoing = new Request(input, init), url = new URL(outgoing.url);
  assert(url.origin === origin && url.protocol === 'https:' && url.hostname === '127.0.0.1', 'Only the exact owned HTTPS provider is allowed');
  const body = outgoing.body ? Buffer.from(await outgoing.arrayBuffer()) : undefined;
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {method: outgoing.method, headers: Object.fromEntries(outgoing.headers), ca: certificate, signal: outgoing.signal}, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', chunk => {
        const value = Buffer.from(chunk); size += value.length;
        if (size > 256 * 1024) { response.destroy(); reject(new Error('Owned fixture response exceeded its bound.')); return; }
        chunks.push(value);
      });
      response.on('error', () => reject(new Error('Owned HTTPS fixture response failed.')));
      response.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const status = response.statusCode || 0;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {status, headers}));
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error('Owned HTTPS fixture timed out.')));
    request.on('error', () => reject(new Error('Owned HTTPS fixture request failed.')));
    request.end(body);
  });
}

async function main() {
  assert(process.env.NODE_ENV === 'test' && process.env.CANVAS_SHARED_CONNECTION_POSTGRES_TEST === '1', 'Native regression must use real PostgreSQL');
  if (process.argv[2] !== '--own-cert-child') {
    assert(process.argv.length === 2, 'Only the exact test child mode is allowed');
    const nonce = randomUUID(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-catalog-native-'));
    await fs.chmod(root, 0o700);
    await fs.writeFile(path.join(root, '.owner'), nonce, {mode: 0o600, flag: 'wx'});
    const keyPath = path.join(root, 'own.key'), certificatePath = path.join(root, 'own.crt');
    try {
      execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certificatePath], {stdio: 'ignore', timeout: 15_000});
      await fs.chmod(keyPath, 0o600); await fs.chmod(certificatePath, 0o600);
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', process.argv[1]!, '--own-cert-child'], {
          stdio: 'inherit', env: {...process.env, NODE_EXTRA_CA_CERTS: certificatePath, CANVAS_PLUGIN_MCP_NATIVE_CERT_ROOT: root, CANVAS_PLUGIN_MCP_NATIVE_CERT_NONCE: nonce},
        });
        child.once('error', () => reject(new Error('The owned native regression child could not start.')));
        child.once('exit', value => resolve(value ?? 1));
      });
      assert(code === 0, 'Native personal MCP authorization child must pass');
    } finally {
      assert((await fs.readFile(path.join(root, '.owner'), 'utf8')) === nonce && (await fs.lstat(root)).isDirectory(), 'Only the exact owned certificate fixture is removed');
      await fs.rm(root, {recursive: true, force: true});
    }
    return;
  }
  assert(process.argv.length === 3, 'Only the exact native child arguments are allowed');
  const root = process.env.CANVAS_PLUGIN_MCP_NATIVE_CERT_ROOT!, nonce = process.env.CANVAS_PLUGIN_MCP_NATIVE_CERT_NONCE!;
  assert(root && path.basename(root).startsWith('canvas-mcp-catalog-native-') && /^[a-f0-9-]{36}$/u.test(nonce), 'Owned test certificate marker required');
  assert((await fs.readFile(path.join(root, '.owner'), 'utf8')) === nonce, 'Exact owned certificate marker');
  const keyPath = path.join(root, 'own.key'), certificatePath = path.join(root, 'own.crt');
  assert(process.env.NODE_EXTRA_CA_CERTS === certificatePath, 'The child trusts only the exact owned certificate');
  for (const file of [keyPath, certificatePath]) {
    const info = await fs.lstat(file); assert(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'Private own test certificate files only');
  }
  const fixture = await createCapabilityPackageStoreApplicationFixture({native: true});
  let provider: Awaited<ReturnType<typeof import('../tests/fixtures/mcp-oauth-provider.mjs').startMcpOAuthProvider>> | undefined;
  try {
    assert(fixture.native, 'Native gate never falls back to an in-memory database');
    const tls = {key: await fs.readFile(keyPath), cert: await fs.readFile(certificatePath)};
    const {startMcpOAuthProvider} = await import('../tests/fixtures/mcp-oauth-provider.mjs');
    const base = 'http://localhost:3001';
    provider = await startMcpOAuthProvider({allowedRedirectOrigins: [base], tls});
    const ownedOrigin = provider.origin, guardedFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).origin === ownedOrigin
      ? requestOwnedHttps(input, init, ownedOrigin, tls.cert) : guardedFetch(input, init);
    process.env.MCP_ALLOW_PRIVATE_NETWORK = 'true'; process.env.MCP_ALLOW_INSECURE_HTTP = 'true'; process.env.NODE_ENV = 'production';
    const configRoute = await import('../app/api/integrations/mcp-config/route');
    const statusRoute = await import('../app/api/integrations/mcp-status/route');
    const callbackRoute = await import('../app/api/mcp/oauth/callback/route');
    const {readMcpConfig, writeMcpConfigRaw} = await import('../app/lib/mcp/config');
    const {requireMcpUserAccess} = await import('../app/lib/mcp/access');
    const {readMcpConnectionStatus} = await import('../app/lib/mcp/connection-status');
    const {getMcpOAuthStatus} = await import('../app/lib/mcp/oauth');
    const {resolveMcpStoragePath} = await import('../app/lib/mcp/storage');
    const {readMcpExtensions} = await import('../app/lib/plugins/plugin-extension-integrations');
    const {parsePluginExtensionQuery, searchPluginExtensions} = await import('../app/lib/plugins/plugin-extension-search');
    const headers = fixture.headers('owner'); headers.set('origin', base);
    const request = (pathname: string, method = 'GET', body?: unknown) => new NextRequest(new URL(pathname, base), {method, headers,
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const responseData = async (response: Response, description: string) => {
      const payload = await response.json() as {success?: boolean; code?: string; data?: Record<string, unknown>};
      assert(response.ok && payload.success === true, description); return payload.data!;
    };
    const serverName = 'Canva MCP';
    await responseData(await configRoute.PUT(request('/api/integrations/mcp-config', 'PUT', {
      rawContent: JSON.stringify({mcpServers: {[serverName]: {url: provider.url, transport: 'http', auth: 'oauth', enabled: true}}}),
    })), 'Actual personal MCP configuration API creation');
    const config = await readMcpConfig({userId: fixture.owner.userId}), connection = config.mcpServers[serverName];
    assert(connection?.connectionId && connection.ownerUserId === fixture.owner.userId && connection.organizationId === null,
      'The real personal API binds manual connections to the current user with nullable organization');
    const mcpActor = await requireMcpUserAccess({userId: fixture.owner.userId});
    assert(mcpActor?.organizationId === fixture.organizationId, 'The actual actor belongs to a current organization');
    const credentialScope = {userId: fixture.owner.userId};
    await assert.rejects(() => readMcpConnectionStatus(serverName, connection as typeof connection & {connectionId: string},
      {...credentialScope, organizationId: mcpActor.organizationId}), error => error instanceof Error && error.message === 'MCP connection belongs to another organization.',
    'An actor organization cannot be substituted for the connection credential binding');
    const started = await responseData(await statusRoute.POST(request('/api/integrations/mcp-status', 'POST', {
      server: connection.connectionId, action: 'authorize', desktop: false,
    })), 'Actual HTTPS personal OAuth start');
    assert(typeof started.authorizationUrl === 'string' && new URL(started.authorizationUrl).origin === ownedOrigin, 'Exact owned provider authorization URL');
    const consentPage = await requestOwnedHttps(started.authorizationUrl, undefined, ownedOrigin, tls.cert);
    assert(consentPage.status === 200, 'Real owned HTTPS consent form');
    const consentValue = (await consentPage.text()).match(/name="consent" value="([A-Za-z0-9_-]{32})"/u)?.[1]; assert(consentValue, 'Real consent value remains private');
    const decided = await requestOwnedHttps(new URL('/consent', ownedOrigin), {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({consent: consentValue, decision: 'approve'})}, ownedOrigin, tls.cert);
    assert(decided.status === 303, 'Genuine provider approval');
    const callbackAddress = decided.headers.get('location'); assert(callbackAddress && new URL(callbackAddress).origin === base, 'Exact owned callback origin');
    const callback = await callbackRoute.GET(request(callbackAddress));
    assert(callback.status === 200, 'Actual personal callback saves the approved token');
    assert((await getMcpOAuthStatus(connection.connectionId, undefined, credentialScope)).authorized === true, 'Canonical token status is authorized in its actual personal credential scope');
    const exact = (result: PluginExtensionSourceResult) => {
      const item = result.items.find(value => value.id === `mcp-personal:${connection.connectionId}`);
      assert(item?.kind === 'mcp', 'Exact current readable personal MCP is present'); return item.connections[0]!;
    };
    const projected = await readMcpExtensions(fixture.owner);
    assert(exact(projected).authorization === 'authorized', 'Actual catalogue preserves confirmed personal authorization despite the actor organization');
    assert(exact(projected).health === 'unknown', 'An OAuth token never invents provider reachability');
    assert(projected.coverage.status === 'complete', 'A valid nullable personal credential binding is not a partial source');
    const healthPath = resolveMcpStoragePath(`connections/${connection.connectionId}/health.json`, credentialScope);
    const healthBefore = await fs.readFile(healthPath);
    await fs.writeFile(healthPath, '{invalid-owned-health-record', {mode: 0o600});
    const healthFailed = await readMcpExtensions(fixture.owner);
    assert(exact(healthFailed).authorization === 'authorized' && exact(healthFailed).health === 'unknown', 'Unavailable health cannot erase independently verified OAuth authorization');
    assert(healthFailed.coverage.status === 'partial', 'Health failure remains visible as incomplete metadata');
    assert(!JSON.stringify(healthFailed).includes('invalid-owned-health-record'), 'Private health errors never enter the DTO');
    await fs.writeFile(healthPath, healthBefore, {mode: 0o600});
    const common = await searchPluginExtensions(fixture.owner, parsePluginExtensionQuery(new URLSearchParams('q=Canva+MCP&types=mcp&limit=50')));
    assert(exact({items: common.items, coverage: common.coverage.find(value => value.source === 'mcp')!}).authorization === 'authorized', 'Common search retains the freshly authorized exact connection');
    assert(!JSON.stringify(projected).includes(provider.url), 'Private MCP endpoint is not projected');
    const foreign = {...connection, connectionId: undefined, organizationId: 'foreign-organization'};
    await writeMcpConfigRaw(JSON.stringify({mcpServers: {...config.mcpServers, 'Foreign organization MCP': foreign}}), credentialScope);
    const denied = await readMcpExtensions(fixture.owner);
    assert(!denied.items.some(value => value.name === 'Foreign organization MCP'), 'Current actor organization access guard is retained');
    await fixture.sql.run('UPDATE organization_user_permissions SET status=$1 WHERE user_id=$2', ['suspended', fixture.owner.userId]);
    assert(!(await readMcpExtensions(fixture.owner)).items.some(value => value.id === `mcp-personal:${connection.connectionId}`), 'Late actor membership revocation removes personal catalogue access');
    assert(provider.stats.approvals === 1 && provider.stats.tokenExchanges === 1 && provider.stats.toolCalls === 0, 'Real HTTPS OAuth without any business tool actions');
    assert(fixture.providerRequests() === 0, 'No external provider request attempts');
    console.log('PASS native PostgreSQL personal MCP catalogue: real organization actor/null-organization API config, own HTTPS approval and token, canonical credential projection, independent failed health, common search, foreign organization and revoked actor fences; business calls0.');
  } finally {await provider?.close(); await fixture.close();}
}
main().catch(error => {console.error(error instanceof assert.AssertionError ? error.message : 'Native personal MCP authorization regression failed.'); process.exitCode = 1;});
