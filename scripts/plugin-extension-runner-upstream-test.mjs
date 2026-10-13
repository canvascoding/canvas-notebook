import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {ownedFixtureUpstreamUrl, startConsentProxy, startRegistryTlsProxy} from './run-plugin-extension-e2e.mjs';

async function listenOwned(server) {
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeOwned(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function requestAt(origin, target, options = {}) {
  const own = new URL(origin), transport = own.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({hostname: own.hostname, port: own.port, path: target,
      method: options.method ?? 'GET', ca: options.ca, timeout: 15_000,
      ...(options.body ? {headers: {'Content-Type': 'application/json'}} : {}),
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => resolve({status: response.statusCode, bytes: Buffer.concat(chunks)}));
    });
    request.once('error', reject); request.once('timeout', () => request.destroy(new Error('Owned request timed out.')));
    request.end(options.body);
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-upstream-proof-'));
await fs.chmod(root, 0o700);
const received = [], canaryReads = [], registryReads = [];
const canary = http.createServer((request, response) => {canaryReads.push(request.url); response.writeHead(200); response.end('forbidden');});
const backend = http.createServer(async (request, response) => {
  const address = new URL(request.url, 'http://fixture.invalid');
  received.push({path: address.pathname, query: address.search, method: request.method});
  for await (const chunk of request) void chunk;
  if (address.searchParams.get('redirect') === '1') {response.writeHead(302, {Location: canaryOrigin}); response.end(); return;}
  response.writeHead(200, {'Content-Type': 'application/json'});
  response.end(JSON.stringify({items: [], session_id: 'fixture-session-1', success: true}));
});
const registry = http.createServer((request, response) => {
  registryReads.push(request.url);
  const archive = request.url.startsWith('/archives/');
  response.writeHead(200, {'Content-Type': archive ? 'application/zip' : 'application/json'});
  response.end(archive ? Buffer.from([0x50, 0x4b, 3, 4, 0, 255]) : JSON.stringify({plugins: [], skills: []}));
});
let canaryOrigin, backendOrigin, registryOrigin, consent, registryProxy;
try {
  canaryOrigin = await listenOwned(canary); backendOrigin = await listenOwned(backend); registryOrigin = await listenOwned(registry);
  const provider = {baseUrl: backendOrigin, accounts: new Map(), calls: [], completeOAuth() {throw new Error('Consent is not part of this network proof.');}};
  consent = await startConsentProxy(provider, {setStatus() {}}, randomBytes(24).toString('hex'), 'https://127.0.0.1:41001/logos/canva.svg');
  const allowed = pathname => pathname === '/api/v3.1/toolkits';
  const selected = new URL('/api/v3.1/toolkits?cursor=apps-2', consent.origin);
  assert.equal(ownedFixtureUpstreamUrl(backendOrigin, selected, allowed).href, `${backendOrigin}/api/v3.1/toolkits?cursor=apps-2`);
  const attack = new URL(`/.//127.0.0.1:${new URL(canaryOrigin).port}/private`, consent.origin);
  assert.equal(new URL(attack.pathname, backendOrigin).origin, canaryOrigin, 'The old concatenating resolver has a real authority-confusion regression.');
  assert.throws(() => ownedFixtureUpstreamUrl(backendOrigin, attack, allowed));
  assert.equal(ownedFixtureUpstreamUrl(backendOrigin, attack, () => true).origin, backendOrigin,
    'Even a permissive path predicate cannot change the upstream authority.');
  for (const invalid of ['https://127.0.0.1:41000', 'http://example.invalid:41000', `${backendOrigin}/not-root`, `${backendOrigin}?query=1`]) {
    assert.throws(() => ownedFixtureUpstreamUrl(invalid, selected, allowed));
  }
  for (const [method, target, body] of [
    ['GET', '/api/v3.1/toolkits?cursor=apps-2'], ['GET', '/api/v3.1/tools/DESIGN_CREATE'],
    ['POST', '/api/v3.1/tool_router/session', '{}'], ['DELETE', '/api/v3.1/connected_accounts/fixture-initiated-1'],
  ]) assert.equal((await requestAt(consent.origin, target, {method, body})).status, 200);
  assert.equal(received.length, 4);
  assert.equal(received[0].query, '?cursor=apps-2');
  const attacks = [`/.//127.0.0.1:${new URL(canaryOrigin).port}/private`, `${canaryOrigin}/api/v3.1/toolkits`,
    `//127.0.0.1:${new URL(canaryOrigin).port}/api/v3.1/toolkits`, '/%2f%2fexample.invalid/private',
    '/api/v3.1/unlisted', '/api/v3.1/toolkits#fragment'];
  for (const target of attacks) assert.equal((await requestAt(consent.origin, target)).status, 400);
  assert.equal((await requestAt(consent.origin, '/api/v3.1/toolkits', {method: 'POST', body: '{}'})).status, 400);
  assert.equal(received.length, 4, 'Rejected paths and methods do not reach even the allowed local backend.');
  assert.equal((await requestAt(consent.origin, '/api/v3.1/toolkits?redirect=1')).status, 400);
  assert.equal(received.length, 5, 'Only the own backend sees its own attempted redirect.');
  assert.deepEqual(canaryReads, [], 'The separate canary receives no request.');
  const keyPath = path.join(root, 'key.pem'), certificatePath = path.join(root, 'ca.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', keyPath, '-out', certificatePath], {stdio: 'ignore', timeout: 15_000});
  assert.equal(generated.status, 0);
  for (const file of [keyPath, certificatePath]) await fs.chmod(file, 0o600);
  const ca = await fs.readFile(certificatePath);
  registryProxy = await startRegistryTlsProxy({baseUrl: registryOrigin}, keyPath, certificatePath);
  assert.equal((await requestAt(registryProxy.origin, '/registry/extensions?fixture-config=extensions', {ca})).status, 200);
  const archive = await requestAt(registryProxy.origin, '/archives/extensions/plugin/local-test/1.0.0.zip', {ca});
  assert.equal(archive.status, 200); assert.deepEqual(archive.bytes, Buffer.from([0x50, 0x4b, 3, 4, 0, 255]));
  for (const target of attacks) assert.equal((await requestAt(registryProxy.origin, target, {ca})).status, 400);
  assert.equal(registryReads.length, 2);
  assert.deepEqual(canaryReads, []);
  assert.equal(consent.counters.businessCalls, 0);
  console.info('OWN_PLUGIN_UPSTREAM_GUARD_PASS parser + actual HTTP/HTTPS proxies; fixed origins; SDK path/method guards; redirect rejected; canary 0; archive unchanged');
} finally {
  await Promise.all([consent?.close(), registryProxy?.close()].filter(Boolean));
  await Promise.all([canary, backend, registry].filter(server => server.listening).map(closeOwned));
  await fs.rm(root, {recursive: true, force: true});
}
