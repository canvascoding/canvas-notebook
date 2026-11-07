import assert from 'node:assert/strict';
import { Client } from 'pg';
import { serializeSignedCookie } from 'better-call';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';

let stage = 'setup', groups = 0;
async function main() {
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { auth } = await import('../app/lib/auth');
    const { assertUserSeatAccess, assertUserSeatAccessInSingleSnapshot, SeatLimitGuardError } = await import('../app/lib/license/seat-limit');
    await fixture.seed({ filePath: 'protected-session-jwt.md', text: 'Preserve native session content.' });
    const baseline = await fixture.snapshot();
    const jwksBefore = (await fixture.admin.query('SELECT id,xmin::text FROM jwks ORDER BY id')).rows;
    const headers = async (cookie: boolean) => {
      const token = String((await fixture.admin.query("SELECT token FROM session WHERE id='reader-session'")).rows[0].token);
      return cookie ? new Headers({ cookie: (await serializeSignedCookie('better-auth.session_token', token,
        process.env.BETTER_AUTH_SECRET!)).split(';')[0] }) : new Headers({ authorization: `Bearer ${token}` });
    };
    const session = (selected: Headers) => auth.handler(new Request('http://localhost/api/auth/get-session', { headers: selected }));
    const check = async (name: string, operation: () => Promise<void>) => {
      stage = name; await operation(); groups++; console.log(`Session JWT configuration passed: ${name}`);
    };
    await check('genuine Cookie and session Bearer reads do not mint JWT headers or read JWKs', async () => {
      for (const cookie of [true, false]) {
        const selected = await headers(cookie);
        await session(selected); // Warm the genuine provider before counting.
        const queries: string[] = [], original = Client.prototype.query;
        Client.prototype.query = function (this: Client, ...args: Parameters<typeof original>) {
          const first: unknown = args[0];
          queries.push(typeof first === 'string' ? first : String((first as { text?: string })?.text ?? ''));
          return Reflect.apply(original, this, args);
        } as typeof original;
        try {
          const response = await session(selected), body = await response.json();
          assert.equal(response.status, 200);
          assert.equal(body.session.id, 'reader-session');
          assert.equal(body.user.id, 'reader');
          stage = `implicit JWT header on ${cookie ? 'Cookie' : 'Bearer'} session read`;
          const jwkQueries = queries.filter(sql => /\bjwks\b/iu.test(sql)).length;
          console.log(JSON.stringify({ transport: cookie ? 'cookie' : 'session-bearer', queries: queries.length, jwkQueries }));
          assert(!response.headers.has('set-auth-jwt'), 'Genuine session responses must not mint an implicit JWT header');
          assert.equal(jwkQueries, 0,
            'A current session read must not query signing keys for an unused header');
          assert(queries.some(sql => /\bsession\b/iu.test(sql)), 'Session authority must still come from the real database');
          assert(queries.length <= 4, `A genuine session read used ${queries.length} queries; budget is 4`);
        } finally { Client.prototype.query = original; }
      }
      assert.deepEqual((await fixture.admin.query('SELECT id,xmin::text FROM jwks ORDER BY id')).rows, jwksBefore);
    });
    await check('session reads still observe ban, seat suspension, expiration and deletion', async () => {
      const changes = [
        ["UPDATE \"user\" SET banned=1 WHERE id='reader'", "UPDATE \"user\" SET banned=0 WHERE id='reader'"],
        ["UPDATE team_memberships SET status='suspended' WHERE user_id='reader'", "UPDATE team_memberships SET status='active' WHERE user_id='reader'"],
        ["UPDATE session SET expires_at=1 WHERE id='reader-session'", null],
        ["DELETE FROM session WHERE id='reader-session'", null],
      ] as const;
      for (const cookie of [true, false]) for (const [revoke, restore] of changes) {
        await fixture.restoreReaderSession();
        const originalHeaders = await headers(cookie);
        assert.equal((await (await session(originalHeaders)).json()).session.id, 'reader-session');
        await fixture.admin.query(revoke);
        try {
          const response = await session(originalHeaders), body = await response.json();
          assert([200, 401, 403].includes(response.status));
          assert(!body?.session, 'A previously valid original credential must not survive revocation');
          assert(!response.headers.has('set-auth-jwt'));
        } finally {
          if (restore) await fixture.admin.query(restore);
          await fixture.restoreReaderSession();
        }
      }
    });
    await check('one-snapshot seat service matches ordinary current seat decisions', async () => {
      const decision = async (read: () => ReturnType<typeof assertUserSeatAccess>) => {
        try { return { allowed: true, access: await read() }; }
        catch (error) {
          if (!(error instanceof SeatLimitGuardError)) throw error;
          return { allowed: false, code: error.code, status: error.status, details: error.details };
        }
      };
      const compare = async (userId = 'reader') => {
        assert.deepEqual(await decision(() => assertUserSeatAccessInSingleSnapshot(userId)),
          await decision(() => assertUserSeatAccess({ userId })));
      };
      await compare('owner'); await compare(); await compare('missing-account');
      for (const [change, restore] of [
        ["UPDATE \"user\" SET banned=1 WHERE id='reader'", "UPDATE \"user\" SET banned=0 WHERE id='reader'"],
        ["UPDATE team_memberships SET status='suspended' WHERE user_id='reader'", "UPDATE team_memberships SET status='active' WHERE user_id='reader'"],
        ["UPDATE organization_user_permissions SET status='disabled' WHERE user_id='reader'", "UPDATE organization_user_permissions SET status='active' WHERE user_id='reader'"],
        ["UPDATE team_membership_sync_state SET reconciliation_seat_limit=1", "UPDATE team_membership_sync_state SET reconciliation_seat_limit=NULL"],
      ]) {
        await fixture.admin.query(change);
        try { await compare('owner'); await compare(); }
        finally { await fixture.admin.query(restore); }
      }
    });
    await check('OAuth-mode token routing and explicit signing still work', async () => {
      const response = await auth.handler(new Request('http://localhost/api/auth/token', { headers: await headers(false) }));
      assert.equal(response.status, 404, 'OAuth mode must not expose the separate session JWT token endpoint');
      stage = 'verify explicit MCP audience isolation';
      const signed = await fixture.issue(); // The first explicit issuance can initialize the real signing key.
      const verified = await auth.api.verifyJWT({ body: { token: signed, issuer: 'http://localhost/api/auth' } });
      assert.equal(verified.payload, null, 'An MCP-resource token must not authenticate to a different audience');
      stage = 'explicit internal JWT signing';
      const internal = await auth.api.signJWT({ body: { payload: { sub: 'reader' } } });
      stage = 'explicit internal JWT verification';
      const internalVerified = await auth.api.verifyJWT({ body: { token: internal.token } });
      assert.equal(internalVerified.payload?.sub, 'reader');
      // Real explicit issuance and the actual MCP credential verifier, with
      // current session, client, scope, consent and seat checks.
      stage = 'explicit MCP JWT through actual credential verifier';
      const { verifyDirectMcpAccessToken, DirectMcpAuthorizationError } = await import('../app/lib/mcp/server/access-token-verifier');
      const fresh = await fixture.issue();
      const principal = await verifyDirectMcpAccessToken(fresh, ['knowledge:read']);
      assert.equal(principal.userId, 'reader');
      assert.equal(principal.sessionId, 'reader-session');
      await assert.rejects(verifyDirectMcpAccessToken(fresh, ['knowledge:write']),
        error => error instanceof DirectMcpAuthorizationError && error.status === 403);
      await assert.rejects(verifyDirectMcpAccessToken(internal.token, ['knowledge:read']),
        error => error instanceof DirectMcpAuthorizationError && error.status === 401);
      assert.deepEqual(await fixture.snapshot(), baseline);
    });
  });
  console.log(JSON.stringify({ suite: 'genuine-session-jwt-configuration', passed: true, groups,
    actualAuthAndPostgres: true, compiledNext: false, browserOAuthIssuance: false }));
}
main().catch(error => {
  console.error(JSON.stringify({ suite: 'genuine-session-jwt-configuration', passed: false, stage,
    errorType: error instanceof Error ? error.name : 'UnknownError',
    assertion: error instanceof assert.AssertionError ? error.message.slice(0, 240) : undefined,
    frames: error instanceof Error ? error.stack?.split('\n').slice(1, 5) : undefined }));
  process.exitCode = 1;
});
