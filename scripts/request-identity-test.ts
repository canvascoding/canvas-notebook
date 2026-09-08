import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';

import { deriveProxyIdentityToken } from '../app/lib/security/proxy-identity';
import {
  getRequestRateLimitIdentity, normalizeClientAddress, rememberVerifiedRateLimitUser,
  resolveRequestClientAddress, runWithRequestIdentity,
} from '../app/lib/security/request-identity';
import { renderCaddyfile } from '../cli/src/core/caddy';

async function main() {
  const internalKey = 'test-only-proxy-root-'.repeat(4);
  process.env.CANVAS_INTERNAL_API_KEY = internalKey;
  const token = deriveProxyIdentityToken(internalKey)!;
  assert.equal(deriveProxyIdentityToken('short'), null);
  const headers = { 'x-canvas-proxy-token': token, 'x-canvas-proxy-client-ip': '198.51.100.4' };
  const mock = { socket: { remoteAddress: '192.0.2.1' }, headers } as unknown as IncomingMessage;
  assert.equal(resolveRequestClientAddress(mock), '198.51.100.4');
  assert.equal(resolveRequestClientAddress(mock, 'rotated-internal-key-'.repeat(4)), '192.0.2.1');
  assert.equal(normalizeClientAddress('2001:0db8:0:0:0:0:0:1'), normalizeClientAddress('2001:db8::1'));
  assert.equal(normalizeClientAddress('198.51.100.4, 198.51.100.5'), null);
  assert.equal(normalizeClientAddress('localhost'), null);
  const config = renderCaddyfile('notebook.example.com', 3456, internalKey);
  assert.ok(config.includes(`header_up X-Canvas-Proxy-Token ${token}`));
  assert.ok(config.includes('header_up X-Canvas-Proxy-Client-IP {remote_host}'));
  assert.ok(!config.includes(internalKey), 'proxy must not receive the internal API credential');
  const shellConfig = execFileSync('bash', ['-c', 'source install/lib/shared/caddy.sh\nconfig_json_read() { printf "%s" "$TEST_INTERNAL_KEY"; }\ncaddy_site_block notebook.example.com'], {
    encoding: 'utf8', env: { ...process.env, TEST_INTERNAL_KEY: internalKey },
  });
  assert.ok(shellConfig.includes(`header_up X-Canvas-Proxy-Token ${token}`), 'shell and portable CLI must agree on proxy attestation');

  const server = createServer((request, response) => runWithRequestIdentity(request, async () => {
    if (request.url === '/verified') rememberVerifiedRateLimitUser('fixture-user');
    await new Promise(resolve => setImmediate(resolve));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ identity: getRequestRateLimitIdentity(), token: request.headers['x-canvas-proxy-token'], forwarded: request.headers['x-forwarded-for'] }));
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const spoof = await fetch(origin, { headers: { 'x-forwarded-for': '198.51.100.5', 'x-canvas-proxy-client-ip': '198.51.100.5', 'x-canvas-proxy-token': '0'.repeat(64) } }).then(r => r.json());
    assert.equal(spoof.identity.clientAddress, '127.0.0.1');
    assert.equal(spoof.forwarded, '127.0.0.1');
    assert.equal(spoof.token, undefined);
    const [verified, anonymous] = await Promise.all([
      fetch(`${origin}/verified`, { headers }).then(r => r.json()),
      fetch(origin).then(r => r.json()),
    ]);
    assert.equal(verified.identity.clientAddress, '198.51.100.4');
    assert.equal(verified.identity.verifiedUserId, 'fixture-user');
    assert.equal(anonymous.identity.verifiedUserId, null, 'concurrent requests must not share verified users');
    assert.equal(verified.token, undefined, 'proxy attestation must be stripped before application routing');
    assert.equal(getRequestRateLimitIdentity(), undefined, 'identity must not escape its HTTP request');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  console.log('request-identity-test: ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
