/** Focused helper regression. Actual BetterAuth/PGlite; no host, native, provider or license acceptance claim. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { hashPassword } from 'better-auth/crypto';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { withOwnedTestCleanup } from '../tests/helpers/owned-test-cleanup';
import type { prepareOwnedMobileNativeCleanupAuthentication as Prepare } from './helpers/mobile-plugin-native-setup-fixture';

const BASE = 'http://127.0.0.1:3001';
const ORG = 'owned-native-cleanup-auth-regression';
type Fixture = Parameters<typeof Prepare>[0];
type Actor = Parameters<typeof Prepare>[1];
type Session = { user: { id: string; email: string; role: string }; session: { id: string; token: string; expiresAt: string } };
type Fault = 'null' | 'malformed' | 'wrong-actor' | 'near-expired' | 'http';
type RequestOptions = { data?: unknown; headers?: Record<string, string>; maxRedirects?: number; timeout?: number };
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
function apiResponse(status: number, value: unknown): APIResponse {
  const bytes = Buffer.from(JSON.stringify(value));
  return { status: () => status, body: async () => bytes, json: async () => JSON.parse(bytes.toString('utf8')) } as APIResponse;
}
async function rejection(body: () => Promise<unknown>): Promise<unknown> {
  let thrown = false, failure: unknown;
  try { await body(); } catch (error) { thrown = true; failure = error; }
  assert.equal(thrown, true); return failure;
}

async function main(): Promise<void> {
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const loader = Module as typeof Module & { _load: (name: string, parent: NodeModule | null, main: boolean) => unknown };
  const originalLoad = loader._load;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-cleanup-auth-')));
  await fs.chmod(root, 0o700); const rootIdentity = await fs.lstat(root);
  let database: Awaited<ReturnType<typeof createPiTestDatabase>> | undefined;
  let auth: typeof import('../app/lib/auth')['auth'] | undefined;
  const jars: Jar[] = [];
  const previousEnvironment = () => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, environment); };
  class Jar {
    readonly cookies = new Map<string, string>();
    readonly calls: Array<{ method: 'GET' | 'POST' | 'DELETE'; pathname: string }> = [];
    faultAfterSignIn: Fault | null = null;
    failSignOut: Error | null = null;
    private faultPending = false;
    deleted = 0;
    deleteHook: (() => Promise<APIResponse>) | null = null;
    disposed = false;
    constructor(readonly actor: { userId: string; email: string; password: string; role: 'owner' | 'manager' | 'use-only'; personalWorkspaceId: string }) { jars.push(this); }
    async exchange(method: 'GET' | 'POST' | 'DELETE', input: string, options: RequestOptions = {}): Promise<APIResponse> {
      assert.equal(this.disposed, false); const url = new URL(input); assert.equal(url.origin, BASE);
      assert.equal(url.hash, ''); assert.equal(options.maxRedirects ?? 0, 0);
      if (url.pathname !== '/api/sessions') assert.equal(url.search, '');
      this.calls.push({ method, pathname: url.pathname });
      if (url.pathname === '/api/workspaces') {
        assert.equal(method, 'GET'); const expected = this.actor.role === 'owner' ? this.actor.personalWorkspaceId : 'owned-native-team';
        assert.equal(options.headers?.['X-Canvas-Workspace-Id'], expected);
        const current = await this.session(); assert(current); assert.equal(current.user.id, this.actor.userId);
        // Only the workspace transport is controlled: strict actual helper ownership validation remains enabled.
        return apiResponse(200, { workspaces: [
          { id: this.actor.personalWorkspaceId, type: 'personal', ownerUserId: this.actor.userId, organizationId: ORG, status: 'active' },
          { id: 'owned-native-team', type: 'team', organizationId: ORG, status: 'active' },
        ] });
      }
      if (url.pathname === '/api/sessions') {
        assert.equal(method, 'DELETE'); assert.deepEqual([...url.searchParams], [['agentId', 'owned-agent'], ['sessionId', 'owned-session']]);
        this.deleted += 1; assert(this.deleteHook); return this.deleteHook();
      }
      assert(url.pathname.startsWith('/api/auth/')); assert(auth);
      if (url.pathname === '/api/auth/sign-out' && this.failSignOut) throw this.failSignOut;
      const headers = new Headers({ origin: BASE });
      const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      if (cookie) headers.set('cookie', cookie);
      if (method === 'POST') headers.set('content-type', 'application/json');
      const response = await auth.handler(new Request(url, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(options.data ?? {}) } : {}) }));
      for (const cookie of response.headers.getSetCookie()) {
        const first = cookie.split(';', 1)[0]; const separator = first.indexOf('='); assert(separator > 0);
        const name = first.slice(0, separator), value = first.slice(separator + 1);
        if (!value || /(?:^|;)\s*max-age=0(?:;|$)/iu.test(cookie)) this.cookies.delete(name); else this.cookies.set(name, value);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (url.pathname === '/api/auth/sign-in/email' && response.status === 200) this.faultPending = this.faultAfterSignIn !== null;
      if (url.pathname === '/api/auth/get-session' && this.faultPending) {
        this.faultPending = false; const fault = this.faultAfterSignIn;
        if (fault === 'http') return apiResponse(503, { code: 'CONTROLLED_AUTH_READ_UNAVAILABLE' });
        if (fault === 'null') return apiResponse(200, null);
        if (fault === 'malformed') return apiResponse(200, { user: [] });
        const actual = JSON.parse(bytes.toString('utf8')) as Session; assert(actual?.session && actual.user);
        if (fault === 'wrong-actor') return apiResponse(200, { ...actual, user: { ...actual.user, id: 'wrong-controlled-actor' } });
        if (fault === 'near-expired') return apiResponse(200, { ...actual, session: { ...actual.session, expiresAt: new Date(Date.now() + 5_000).toISOString() } });
        assert.fail('Unknown controlled fault.');
      }
      return { status: () => response.status, body: async () => bytes, json: async () => JSON.parse(bytes.toString('utf8')) } as APIResponse;
    }
    api(): APIRequestContext {
      return { get: (url: string, options?: RequestOptions) => this.exchange('GET', url, options),
        post: (url: string, options?: RequestOptions) => this.exchange('POST', url, options),
        delete: (url: string, options?: RequestOptions) => this.exchange('DELETE', url, options) } as unknown as APIRequestContext;
    }
    async login(): Promise<Session> {
      assert.equal((await this.exchange('POST', `${BASE}/api/auth/sign-in/email`, { data: { email: this.actor.email, password: this.actor.password } })).status(), 200);
      const session = await this.session(); assert(session); return session;
    }
    async session(): Promise<Session | null> { return await (await this.exchange('GET', `${BASE}/api/auth/get-session`)).json() as Session | null; }
    async logout(): Promise<void> {
      this.faultAfterSignIn = null; this.faultPending = false; this.failSignOut = null;
      if (await this.session()) assert.equal((await this.exchange('POST', `${BASE}/api/auth/sign-out`, { data: {} })).status(), 200);
      assert.equal(await this.session(), null);
    }
    count(pathname: string): number { return this.calls.filter(call => call.pathname === pathname).length; }
  }
  let failed = false, bodyFailure: unknown;
  try {
    for (const key of Object.keys(process.env)) if (!['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'].includes(key)) delete process.env[key];
    Object.assign(process.env, { NODE_ENV: 'test', DATA: root, CANVAS_DATA_ROOT: root, DATABASE_URL: 'postgresql://127.0.0.1:1/unused_cleanup_auth',
      CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_ORGANIZATION_ID: ORG,
      CANVAS_MANAGED_SERVICES_ENABLED: 'false', CANVAS_INSTANCE_ID: `cleanup-${randomUUID()}`, CANVAS_INSTANCE_TOKEN: '',
      BASE_URL: BASE, BETTER_AUTH_BASE_URL: BASE, BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'), AUTH_COOKIE_SECURE: 'false',
      INTEGRATIONS_ENV_MASTER_KEY: randomBytes(32).toString('base64url'), CANVAS_MCP_DIRECT_ENABLED: 'false', __NEXT_PROCESSED_ENV: 'true' });
    delete process.env.CANVAS_LICENSE_CERT;
    database = await createPiTestDatabase(); const actualDatabase = database;
    loader._load = (name, parent, isMain) => {
      if (name === 'server-only') return {};
      if (name === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(name) || /^(?:\.\.\/)+db$/u.test(name)) return actualDatabase;
      if (name === '@/app/lib/license/seat-limit' || /\/app\/lib\/license\/seat-limit(?:\.ts)?$/u.test(name)) {
        // External issuance is isolated. Actual BetterAuth/password/session SQL is unchanged; no real license acceptance claim.
        const actual = originalLoad(name, parent, isMain) as typeof import('../app/lib/license/seat-limit');
        return { ...actual, assertUserSeatAccess: async ({ userId }: { userId: string }) => ({ userId, mode: 'team', organizationId: ORG }) };
      }
      return originalLoad(name, parent, isMain);
    };
    globalThis.fetch = async () => { throw new Error('This in-memory auth regression permits no network.'); };
    const actors = [
      { role: 'owner' as const, userId: 'cleanup-owner', email: 'cleanup-owner@example.test', password: randomBytes(24).toString('hex'), personalWorkspaceId: 'cleanup-owner-personal' },
      { role: 'use-only' as const, userId: 'cleanup-user', email: 'cleanup-user@example.test', password: randomBytes(24).toString('hex'), personalWorkspaceId: 'cleanup-user-personal' },
    ];
    const sql = await database.openDb();
    try {
      for (const actor of actors) {
        const now = Date.now(), passwordHash = await hashPassword(actor.password);
        await sql.run('INSERT INTO "user" (id,name,email,email_verified,role,banned,created_at,updated_at) VALUES ($1,$1,$2,1,$3,0,$4,$4)', [actor.userId, actor.email, actor.role === 'owner' ? 'admin' : 'user', now]);
        await sql.run('INSERT INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES ($1,$2,\'credential\',$2,$3,$4,$4)', [randomUUID(), actor.userId, passwordHash, now]);
      }
    } finally { await sql.close(); }
    const authModule = await import('../app/lib/auth'); await authModule.ensureAuthReady(); auth = authModule.auth;
    const { prepareOwnedMobileNativeCleanupAuthentication: prepare } = await import('./helpers/mobile-plugin-native-setup-fixture');
    const fixture = { organizationId: ORG, teamId: 'owned-native-team', abort: new AbortController() } as Fixture;
    let cases = 0;
    // Missing setup sessions are genuinely removed using the normal actor's revoke-session API.
    for (const definition of actors) {
      const setup = new Jar(definition), native = new Jar(definition); const old = await setup.login(), originalNative = await native.login();
      assert.notEqual(old.session.id, originalNative.session.id);
      assert.equal((await native.exchange('POST', `${BASE}/api/auth/revoke-session`, { data: { token: old.session.token } })).status(), 200);
      assert.equal(await setup.session(), null);
      const actor = { ...definition, setupAuthSessionHash: fingerprint(old.session.id), api: setup.api() } as Actor;
      const handle = await prepare(fixture, actor); const renewed = await setup.session(); assert(renewed);
      assert.notEqual(renewed.session.id, old.session.id); assert.notEqual(renewed.session.id, originalNative.session.id);
      assert.equal(setup.count('/api/auth/sign-in/email'), 2); assert.equal(actor.setupAuthSessionHash, fingerprint(old.session.id));
      await handle.assertCurrent();
      // Owner is intentionally kept authenticated for final ordinary reads before close, rather than signed out after its first cleanup step.
      assert.equal((await setup.exchange('GET', `${BASE}/api/workspaces`, { headers: { 'X-Canvas-Workspace-Id': definition.role === 'owner' ? definition.personalWorkspaceId : fixture.teamId } })).status(), 200);
      await handle.close(); assert.equal(await setup.session(), null);
      assert.equal((await native.session())?.session.id, originalNative.session.id); cases += 1;
    }
    // Healthy original authentication is retained; cleanup must never sign it out or issue an unnecessary login.
    {
      const jar = new Jar(actors[0]), initial = await jar.login();
      const actor = { ...actors[0], setupAuthSessionHash: fingerprint(initial.session.id), api: jar.api() } as Actor;
      const handle = await prepare(fixture, actor); await handle.close();
      assert.equal(jar.count('/api/auth/sign-in/email'), 1); assert.equal(jar.count('/api/auth/sign-out'), 0);
      assert.equal((await jar.session())?.session.id, initial.session.id); cases += 1;
    }
    // Successful ordinary login followed by unconfirmed validation always attempts normal sign-out.
    for (const fault of ['null', 'malformed', 'wrong-actor', 'near-expired', 'http'] as const) {
      const jar = new Jar(actors[1]); jar.faultAfterSignIn = fault;
      const actor = { ...actors[1], setupAuthSessionHash: 'a'.repeat(64), api: jar.api() } as Actor;
      const error = await rejection(() => prepare(fixture, actor)); assert(error instanceof assert.AssertionError);
      assert.equal(jar.count('/api/auth/sign-in/email'), 1); assert.equal(jar.count('/api/auth/sign-out'), 1);
      assert.equal(jar.deleted, 0); assert.equal(await jar.session(), null); cases += 1;
    }
    // Setup validation remains primary even if normal sign-out fails; no swallowed cleanup failure.
    {
      const jar = new Jar(actors[1]); jar.faultAfterSignIn = 'null'; const signOutFailure = new Error('Controlled sign-out failure.'); jar.failSignOut = signOutFailure;
      const error = await rejection(() => prepare(fixture, { ...actors[1], setupAuthSessionHash: 'b'.repeat(64), api: jar.api() } as Actor));
      assert(error instanceof AggregateError); assert(error.errors[0] instanceof assert.AssertionError);
      assert.equal(error.errors[1].cause, signOutFailure); assert.equal(jar.count('/api/auth/sign-in/email'), 1); assert.equal(jar.count('/api/auth/sign-out'), 1);
      assert.equal(jar.deleted, 0); await jar.logout(); cases += 1;
    }
    // The real returned freshness guard is repeatable. A held DELETE's original failure is preserved, and replacement sessions cannot trigger a retry or another mutation.
    for (const deleteStatus of [200, 503]) {
      const jar = new Jar(actors[1]); const actor = { ...actors[1], setupAuthSessionHash: 'c'.repeat(64), api: jar.api() } as Actor;
      const handle = await prepare(fixture, actor); const initial = await jar.session(); assert(initial);
      let release!: (value: APIResponse) => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { entered = resolve; });
      jar.deleteHook = () => { entered(); return new Promise<APIResponse>(resolve => { release = resolve; }); };
      const failure = withOwnedTestCleanup(async () => {
        await handle.assertCurrent(); const response = await actor.api.delete(`${BASE}/api/sessions?agentId=owned-agent&sessionId=owned-session`, { maxRedirects: 0, timeout: 30_000 });
        assert.equal(response.status(), 200); assert.deepEqual(await response.json(), { success: true, deleted: 'owned-session' }); await handle.assertCurrent();
      }, [{ label: 'owned-auth-close', run: handle.close }]);
      await gate; const replacement = await jar.login(); assert.notEqual(replacement.session.id, initial.session.id);
      release(apiResponse(deleteStatus, deleteStatus === 200 ? { success: true, deleted: 'owned-session' } : { code: 'CONTROLLED_DELETE_FAILED' }));
      const error = await rejection(() => failure); assert(error instanceof AggregateError);
      assert(error.errors[0] instanceof assert.AssertionError); assert(error.errors[1].cause instanceof assert.AssertionError);
      await rejection(() => handle.assertCurrent()); assert.equal(jar.deleted, 1);
      assert.equal(jar.count('/api/auth/sign-out'), 0); assert.equal(jar.count('/api/auth/sign-in/email'), 2);
      assert.equal((await jar.session())?.session.id, replacement.session.id);
      const revoked = await jar.exchange('POST', `${BASE}/api/auth/revoke-session`, { data: { token: initial.session.token } });
      assert.equal(revoked.status(), 200); assert.deepEqual(await revoked.json(), { status: true });
      assert.equal((await jar.session())?.session.id, replacement.session.id);
      await jar.logout(); cases += 1;
    }
    // Abort must fail before any auth read/login or mutation.
    {
      const jar = new Jar(actors[1]), abort = new AbortController(); abort.abort();
      await rejection(() => prepare({ ...fixture, abort }, { ...actors[1], setupAuthSessionHash: 'd'.repeat(64), api: jar.api() } as Actor));
      assert.equal(jar.calls.length, 0); cases += 1;
    }
    for (const jar of jars) await jar.logout();
    assert.equal(jars.reduce((total, jar) => total + jar.deleted, 0), 2);
    const closedSessions = await database.openDb();
    try { assert.equal(Number((await closedSessions.get('SELECT COUNT(*) AS count FROM "session"') as { count: number }).count), 0); } finally { await closedSessions.close(); }
    console.info(JSON.stringify({ gate: 'mobile-native-cleanup-auth', cases, network: 0, nativeAcceptance: false }));
  } catch (error) { failed = true; bodyFailure = error; }
  // No original primary failure can skip database/environment/private-file closure.
  await withOwnedTestCleanup(async () => { if (failed) throw bodyFailure; }, [
      ...jars.map((jar, index) => ({ label: `jar-${index}`, run: async () => { if (auth) await jar.logout(); jar.disposed = true; } })),
      { label: 'database', run: async () => { await database?.close(); } },
      { label: 'loader-fetch-environment', run: () => { loader._load = originalLoad; globalThis.fetch = originalFetch; previousEnvironment(); } },
      { label: 'private-root', run: async () => { const current = await fs.lstat(root); assert.equal(current.dev, rootIdentity.dev); assert.equal(current.ino, rootIdentity.ino); assert.equal(current.uid, rootIdentity.uid); assert.equal(current.mode & 0o777, 0o700); await fs.rm(root, { recursive: true, force: false }); } },
  ]);
}
void main().catch(error => {
  const site = error instanceof Error ? error.stack?.match(/(?:mobile-native-cleanup-auth-test|mobile-plugin-native-setup-fixture)\.ts:[1-9][0-9]*:[1-9][0-9]*/u)?.[0] : undefined;
  console.error(JSON.stringify({ gate: 'mobile-native-cleanup-auth', failed: true, name: error instanceof Error ? error.name : 'unknown', site }));
  process.exitCode = 1;
});
