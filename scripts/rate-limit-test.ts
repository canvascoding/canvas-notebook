import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { NextRequest } from 'next/server';

import { rateLimit } from '../app/lib/utils/rate-limit';

function request(sessionToken?: string, forwardedFor?: string) {
  const headers = new Headers();
  if (sessionToken) {
    headers.set('cookie', `better-auth.session_token=${sessionToken}`);
  }
  if (forwardedFor) {
    headers.set('x-forwarded-for', forwardedFor);
  }
  return new NextRequest('http://localhost:3000/api/test', { headers });
}

const authenticatedOptions = {
  limit: 1,
  windowMs: 60_000,
  keyPrefix: `rate-limit-authenticated-${randomUUID()}`,
};

const firstAuthenticated = rateLimit(request('session-a.signature', '203.0.113.1'), authenticatedOptions);
assert.equal(firstAuthenticated.ok, true);

const spoofedForwardedIp = rateLimit(request('session-a.signature', '198.51.100.42'), authenticatedOptions);
assert.equal(spoofedForwardedIp.ok, false, 'changing X-Forwarded-For must not bypass an authenticated limit');
if (!spoofedForwardedIp.ok) {
  assert.equal(spoofedForwardedIp.response.status, 429);
}

const differentSession = rateLimit(request('session-b.signature', '198.51.100.42'), authenticatedOptions);
assert.equal(differentSession.ok, true, 'a different authenticated session receives its own bucket');

const anonymousOptions = {
  limit: 1,
  windowMs: 60_000,
  keyPrefix: `rate-limit-anonymous-${randomUUID()}`,
};

assert.equal(rateLimit(request(undefined, '203.0.113.1'), anonymousOptions).ok, true);
assert.equal(
  rateLimit(request(undefined, '198.51.100.42'), anonymousOptions).ok,
  false,
  'anonymous requests must not derive their bucket from forwarded IP headers',
);

console.log('rate-limit-test: ok');
