import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { NextRequest } from 'next/server';

import { rateLimit } from '../app/lib/utils/rate-limit';
import { rememberVerifiedRateLimitUser, runWithRequestIdentity } from '../app/lib/security/request-identity';

const prefix = randomUUID();
const options = { limit: 1, windowMs: 60_000, keyPrefix: prefix };

function attempt(client: string, cookie?: string, verifiedUserId?: string, headers: Record<string, string> = {}) {
  const incoming = {
    socket: { remoteAddress: client },
    headers: { ...headers, ...(cookie ? { cookie: `better-auth.session_token=${cookie}` } : {}) },
  } as unknown as IncomingMessage;
  return runWithRequestIdentity(incoming, () => {
    // Models only the result of a successful server-side session check.
    if (verifiedUserId) rememberVerifiedRateLimitUser(verifiedUserId);
    return rateLimit(new NextRequest('http://localhost/api/test', { headers: incoming.headers as Record<string, string> }), options);
  });
}

assert.equal(attempt('203.0.113.1').ok, true);
for (let index = 0; index < 20; index++) {
  const result = attempt('203.0.113.1', `invented-${index}`, undefined, {
    'x-forwarded-for': `198.51.100.${index + 1}`,
    'x-real-ip': `198.51.100.${index + 1}`,
    'x-canvas-proxy-client-ip': `198.51.100.${index + 1}`,
    'x-canvas-proxy-token': 'a'.repeat(64),
  });
  assert.equal(result.ok, false, 'fabricated cookies and headers must not renew a public budget');
  if (!result.ok) {
    assert.equal(result.response.status, 429);
    assert.ok(Number(result.response.headers.get('retry-after')) > 0);
  }
}
assert.equal(attempt('203.0.113.2').ok, true, 'another visitor has its own budget');
assert.equal(attempt('::ffff:203.0.113.2').ok, false, 'IPv4-mapped addresses have the same identity');
assert.equal(attempt('203.0.113.1', 'valid-session-a', 'alice').ok, true);
assert.equal(attempt('203.0.113.99', 'another-valid-session-a', 'alice').ok, false, 'session/IP rotation cannot renew a verified user budget');
assert.equal(attempt('203.0.113.1', 'valid-session-b', 'bob').ok, true, 'users behind one proxy/NAT remain independent');
assert.equal(attempt('203.0.113.1', 'valid-session-b').ok, false, 'a cookie does not inherit a previously verified user');

const noTransport = new NextRequest('http://localhost/api/test', { headers: { cookie: 'better-auth.session_token=unverified' } });
const unscoped = { ...options, keyPrefix: `${prefix}:unscoped` };
assert.equal(rateLimit(noTransport, unscoped).ok, true);
assert.equal(rateLimit(new NextRequest('http://localhost/api/test'), unscoped).ok, false, 'missing transport information fails closed');
console.log('rate-limit-test: ok');
