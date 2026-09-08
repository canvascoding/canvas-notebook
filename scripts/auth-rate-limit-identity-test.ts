import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { getRequestRateLimitIdentity, runWithRequestIdentity } from '../app/lib/security/request-identity';
import { rateLimit } from '../app/lib/utils/rate-limit';

const root = mkdtempSync(path.join(tmpdir(), 'canvas-auth-rate-'));
process.env.DATA = root;
process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
process.env.BASE_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_BASE_URL = process.env.BASE_URL;
process.env.BETTER_AUTH_SECRET = 'test-only-auth-identity-secret-'.repeat(3);

async function main() {
  const { createInitialOwner } = await import('../app/lib/auth-setup');
  const { auth } = await import('../app/lib/auth');
  const owner = await createInitialOwner({ name: 'Fixture Owner', email: 'owner@example.test', password: 'FixtureOwnerPassword123!' });
  const response = await auth.handler(new Request('http://localhost:3000/api/auth/sign-in/email', {
    method: 'POST', headers: { origin: process.env.BASE_URL!, 'content-type': 'application/json' },
    body: JSON.stringify({ email: owner.email, password: 'FixtureOwnerPassword123!' }),
  }));
  assert.equal(response.status, 200);
  const cookie = (response.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(cookie, /session_token=/);
  const payload = await response.json() as { token: string };
  const options = { limit: 1, windowMs: 60_000, keyPrefix: 'real-auth' };
  async function check(headers: Record<string, string>, address: string, expected: string | null) {
    return runWithRequestIdentity({ headers: { ...headers }, socket: { remoteAddress: address } } as unknown as IncomingMessage, async () => {
      const session = await auth.api.getSession({ headers: new Headers(headers) });
      assert.equal(session?.user.id ?? null, expected);
      assert.equal(getRequestRateLimitIdentity()?.verifiedUserId, expected, 'rate identity must follow the actual verified auth result');
      return rateLimit(new NextRequest('http://localhost:3000/api/fixture', { headers }), options);
    });
  }
  assert.equal((await check({ cookie }, '203.0.113.1', owner.id)).ok, true);
  assert.equal((await check({ authorization: `Bearer ${payload.token}` }, '203.0.113.2', owner.id)).ok, false, 'web and mobile sessions share the user budget');
  await check({ cookie: 'better-auth.session_token=fabricated.signature' }, '203.0.113.3', null);
  const sqlite = new Database(path.join(root, 'sqlite.db'));
  try {
    sqlite.prepare('UPDATE session SET expires_at = ? WHERE user_id = ?').run(Math.floor(Date.now() / 1000) - 1, owner.id);
    await check({ cookie }, '203.0.113.4', null);
    const freshSignIn = await auth.handler(new Request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST', headers: { origin: process.env.BASE_URL!, 'content-type': 'application/json' },
      body: JSON.stringify({ email: owner.email, password: 'FixtureOwnerPassword123!' }),
    }));
    assert.equal(freshSignIn.status, 200);
    const fresh = await freshSignIn.json() as { token: string };
    await check({ authorization: `Bearer ${fresh.token}` }, '203.0.113.5', owner.id);
    sqlite.prepare('DELETE FROM session WHERE user_id = ?').run(owner.id);
    await check({ authorization: `Bearer ${fresh.token}` }, '203.0.113.6', null);
    // Configured setup rejects even invalid input before validation or hashing.
    await assert.rejects(createInitialOwner(null), (error: unknown) => (error as { code: string }).code === 'ALREADY_CONFIGURED');
  } finally { sqlite.close(); }
  console.log('auth-rate-limit-identity-test: ok (real cookie, bearer, forged, expired and revoked sessions)');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => rmSync(root, { recursive: true, force: true }));
