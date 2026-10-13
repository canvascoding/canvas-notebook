/** Real issuer input/environment + CP refresh/signing regressions. Controlled CP persistence, no external DB/host/native acceptance. */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { assertIssuerInput, configureIssuerEnvironment } from './helpers/agent-workflow-team-issuer-fixture';
import { withOwnedTestCleanup } from '../tests/helpers/owned-test-cleanup';

type Input = Awaited<ReturnType<typeof assertIssuerInput>>;
// This fixture loads the verified sibling at runtime. Notebook type checking
// must not require a second repository beside every isolated worktree.
type CP = { refreshCommunityLicenseCertificate(licenseId: string, instanceId: string): Promise<{ license: string } | null> };
type CPPolicy = {
  assertTeamSeatGrantPolicy(input: {
    grantType: 'test'; actorUserId: string; allowedUserId: string;
    licenseEnvironment: 'development'; seatLimit: number; expiresAt: Date;
  }, now?: Date): void;
  TeamSeatGrantPolicyError: new (statusCode: number, code: string, message: string) => Error & { readonly code: string };
};
type Row = Record<string, unknown>;
type Query = { from: (value: object) => Query; where: (predicate: unknown) => Query; orderBy: (order: unknown) => Query;
  limit: (limit: number) => Promise<Row[]>; then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) => Promise<unknown> };

async function main(): Promise<void> {
  const originalEnvironment = { ...process.env }, originalArgv = [...process.argv], originalFetch = globalThis.fetch;
  const restoreEnvironment = () => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, originalEnvironment); };
  const repo = await fs.realpath(process.cwd()), cpRoot = await fs.realpath(path.join(repo, '..', 'canvas-control-plane'));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-native-issuer-certificate-')));
  await fs.chmod(root, 0o700); const identity = await fs.lstat(root), nonce = randomBytes(16).toString('hex'), marker = randomUUID();
  await fs.writeFile(path.join(root, '.fixture-owner'), marker, { mode: 0o600, flag: 'wx' });
  const parentPath = path.join(root, 'recovery.json');
  const parentBase = { version: 1, nonce, fixtureRoot: root, repo, ownerMarker: marker, rootDevice: String(identity.dev), rootInode: String(identity.ino),
    createAcknowledged: true, phase: 'bootstrap', actorId: 'actual-owned-test-issuer', uncertain: false,
    // This opaque baseline is immutable; neither helper changes an already-captured fixture deadline.
    capturedNativeDeadline: Date.now() + 180 * 60_000 };
  const production = generateKeyPairSync('rsa', { modulusLength: 2048 }), development = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keys = { initial: production.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), test: development.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  const tables: { licenses?: object; grants?: object } = {};
  let currentLicense: Row, currentGrant: Row;
  const updates: Array<{ table: object; values: Row }> = [];
  // Strict controlled DB boundary: the certificate implementation and expiration resolver are real.
  // No grant issuance/SQL lock/activation acceptance is asserted by this gate.
  const db = {
    select: () => {
      let table: object | undefined;
      const rows = () => { assert(table === tables.licenses || table === tables.grants); return table === tables.licenses ? [currentLicense] : [currentGrant]; };
      const query: Query = { from: (value: object) => { table = value; return query; }, where: (_predicate: unknown) => query,
        orderBy: (_order: unknown) => query, limit: async (limit: number) => { assert.equal(limit, 1); return rows(); },
        then: (resolve: (value: Row[]) => unknown, reject: (error: unknown) => unknown) => {
          // expireTeamEntitlementGrants performs an unbounded query of expired rows; this fixture has none.
          assert.equal(table, tables.grants); return Promise.resolve([] as Row[]).then(resolve, reject);
        } };
      return query;
    },
    update: (table: object) => ({ set: (values: Row) => ({ where: async (_predicate: unknown) => {
      assert(table === tables.licenses || table === tables.grants); updates.push({ table, values }); return [];
    } }) }),
    transaction: async () => { assert.fail('No expired grant or unrelated CP transaction is allowed in this fixture.'); },
    insert: () => { assert.fail('Certificate refresh must not create grants, Stripe objects or users.'); },
  };
  const setGuardEnvironment = (flag: string | undefined) => {
    restoreEnvironment(); Object.assign(process.env, { CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN: '1', NODE_ENV: 'development',
      AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE: parentPath, CANVAS_CONTROL_PLANE_TEST_ROOT: cpRoot,
      CANVAS_ISSUER_MAINTENANCE_DATABASE_URL: 'postgresql://owned_fixture@127.0.0.1:55433/postgres', CANVAS_INSTANCE_ID: `agent-settings-browser-${nonce}` });
    if (flag === undefined) delete process.env.CANVAS_MOBILE_PLUGIN_NATIVE_RUN; else process.env.CANVAS_MOBILE_PLUGIN_NATIVE_RUN = flag;
    process.argv = [process.execPath, path.join(repo, 'scripts/mobile-native-issuer-certificate-test.ts')];
  };
  const writeParent = async (native: boolean) => {
    const value = { ...parentBase, ...(native ? { mobileNative: true as const } : {}) };
    await fs.writeFile(parentPath, JSON.stringify(value), { mode: 0o600 }); return value;
  };
  let bodyFailure: unknown, failed = false, moduleMock: ReturnType<typeof mock.module> | undefined;
  try {
    globalThis.fetch = async () => { throw new Error('The certificate regression permits no network.'); };
    // Clear inherited provider/SMTP/database secrets before importing any CP services.
    await writeParent(true); setGuardEnvironment('1');
    const initialInput = await assertIssuerInput();
    configureIssuerEnvironment(initialInput, 'http://127.0.0.1:1', new URL(`postgresql://owned_fixture@127.0.0.1:1/canvas_issuer_test_${nonce}`), keys);
    // The import-safe fixture exports must not start an issuer, create a pool or mutate a database.
    moduleMock = mock.module(pathToFileURL(path.join(cpRoot, 'apps/api/src/db/connection.js')).href, { namedExports: {
      db, assertDatabaseTimeZone: async () => {}, closeDatabaseConnection: async () => {},
    } });
    const schema = await import(pathToFileURL(path.join(cpRoot, 'apps/api/src/db/schema.ts')).href) as { licenses: object; teamEntitlementGrants: object };
    tables.licenses = schema.licenses; tables.grants = schema.teamEntitlementGrants;
    const licenses = await import(pathToFileURL(path.join(cpRoot, 'apps/api/src/services/licenses.ts')).href) as CP;
    const { jwtVerify } = await import('jose');
    let count = 0;
    for (const native of [false, true]) {
      const parent = await writeParent(native); setGuardEnvironment(native ? '1' : undefined);
      const input = await assertIssuerInput(); assert.equal(input.parent.mobileNative === true, native);
      const before = await fs.readFile(parentPath), selected = native ? 12600 : 3600;
      configureIssuerEnvironment(input, 'http://127.0.0.1:1', new URL(`postgresql://owned_fixture@127.0.0.1:1/canvas_issuer_test_${nonce}`), keys);
      assert.equal(process.env.TEAM_SEAT_GRANT_CERTIFICATE_TTL_SECONDS, String(selected));
      assert.equal(process.env.TEAM_SEAT_TEST_MAX_TTL_HOURS, '24'); assert.equal(process.env.TEAM_SEAT_TEST_MAX_SEATS, '4');
      assert.equal(process.env.LICENSE_TEST_AUDIENCE, 'canvas-notebook-test');
      assert.equal(process.env.TEAM_SEAT_STRIPE_MUTATIONS_ENABLED, 'false'); assert.equal(process.env.BILLING_MODE, 'disabled');
      assert.deepEqual(await fs.readFile(parentPath), before); assert.equal(JSON.parse(before.toString('utf8')).capturedNativeDeadline, parent.capturedNativeDeadline);
      for (const cap of ['ttl', 'grant', 'license'] as const) {
        const now = new Date(); const grantExpiry = new Date(now.getTime() + (cap === 'grant' ? 90 : 23 * 60 * 60) * 1000);
        const licenseExpiry = new Date(now.getTime() + (cap === 'license' ? 75 : 24 * 60 * 60) * 1000);
        const licenseId = randomUUID(), grantId = randomUUID(), instanceId = input.instanceId;
        currentLicense = { id: licenseId, instanceId, email: 'owned-issuer@example.test', plan: 'community', status: 'active', hostingMode: 'community', edition: 'team',
          licenseClass: 'test', licenseEnvironment: 'development', claimedByUserId: 'owned-owner', billingOrganizationId: null,
          entitlementsVersion: 1, quotas: { users: 3 }, features: { multiUser: true, teamWorkspace: true }, expiresAt: licenseExpiry,
          activatedAt: now, createdAt: now, updatedAt: now };
        currentGrant = { id: grantId, licenseId, status: 'active', grantType: 'test', licenseClass: 'test', licenseEnvironment: 'development',
          allowedInstanceId: instanceId, allowedUserId: 'owned-owner', expiresAt: grantExpiry, createdAt: now };
        const beforeUpdates = updates.length;
        const result = await licenses.refreshCommunityLicenseCertificate(licenseId, instanceId); assert(result);
        const verified = await jwtVerify(result.license, development.publicKey, { algorithms: ['RS256'], issuer: 'canvas-control-plane', audience: 'canvas-notebook-test' });
        const claims = verified.payload; assert(Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp));
        assert.equal(claims.sub, instanceId); assert.equal(claims.licenseId, licenseId); assert.equal(claims.grantId, grantId);
        assert.equal(claims.licenseClass, 'test'); assert.equal(claims.licenseEnvironment, 'development');
        assert.equal(claims.seatLimit, 3); assert.equal(claims.nonBillable, true); assert.equal(claims.provider, 'test');
        if (cap === 'ttl') assert.equal(claims.exp! - claims.iat!, selected);
        if (cap === 'grant') assert.equal(claims.exp, Math.floor(grantExpiry.getTime() / 1000));
        if (cap === 'license') assert.equal(claims.exp, Math.floor(licenseExpiry.getTime() / 1000));
        assert(claims.exp! <= Math.floor(grantExpiry.getTime() / 1000)); assert(claims.exp! <= Math.floor(licenseExpiry.getTime() / 1000));
        assert.equal(updates.length - beforeUpdates, 2); assert.equal(updates[beforeUpdates].table, tables.licenses); assert.equal(updates[beforeUpdates + 1].table, tables.grants);
        assert.equal(updates[beforeUpdates + 1].values.lastCertificateReissueStatus, 'issued'); count += 1;
      }
    }
    // Parent intent and the trusted native launcher flag must match exactly before the longer certificate is selected.
    for (const [native, flag] of [[true, undefined], [true, '0'], [false, '1'], [false, '0']] as const) {
      await writeParent(native); setGuardEnvironment(flag); await assert.rejects(() => assertIssuerInput(), assert.AssertionError); count += 1;
    }
    // A received grant can shorten either certificate; the actual grant policy still enforces its independent 24-hour/4-seat cap.
    await writeParent(true); setGuardEnvironment('1'); const input: Input = await assertIssuerInput();
    configureIssuerEnvironment(input, 'http://127.0.0.1:1', new URL(`postgresql://owned_fixture@127.0.0.1:1/canvas_issuer_test_${nonce}`), keys);
    Object.assign(process.env, { TEAM_SEAT_CONTROL_PLANE_ENVIRONMENT: 'development', TEAM_SEAT_GRANT_ADMIN_USER_IDS: 'owned-owner', TEAM_SEAT_TEST_ALLOWED_USER_IDS: 'owned-owner' });
    const policy = await import(pathToFileURL(path.join(cpRoot, 'apps/api/src/services/teamSeatGrantPolicy.ts')).href) as CPPolicy;
    const now = new Date(), request = { grantType: 'test' as const, actorUserId: 'owned-owner', allowedUserId: 'owned-owner', licenseEnvironment: 'development' as const,
      seatLimit: 3, expiresAt: new Date(now.getTime() + 23 * 60 * 60_000) };
    assert.doesNotThrow(() => policy.assertTeamSeatGrantPolicy(request, now));
    assert.throws(() => policy.assertTeamSeatGrantPolicy({ ...request, seatLimit: 5 }, now), error => error instanceof policy.TeamSeatGrantPolicyError && error.code === 'TEAM_SEAT_LIMIT_EXCEEDED');
    assert.throws(() => policy.assertTeamSeatGrantPolicy({ ...request, expiresAt: new Date(now.getTime() + 24 * 60 * 60_000 + 1) }, now), error => error instanceof policy.TeamSeatGrantPolicyError && error.code === 'TEAM_SEAT_TTL_EXCEEDED');
    count += 3;
    console.info(JSON.stringify({ gate: 'mobile-native-issuer-certificate', cases: count, signed: 6, externalDatabase: false, nativeAcceptance: false }));
  } catch (error) { failed = true; bodyFailure = error; }
  await withOwnedTestCleanup(async () => { if (failed) throw bodyFailure; }, [
    { label: 'mock-environment', run: () => { moduleMock?.restore(); mock.restoreAll(); globalThis.fetch = originalFetch; process.argv = originalArgv; restoreEnvironment(); } },
    { label: 'private-root', run: async () => { const current = await fs.lstat(root); assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino); assert.equal(current.uid, identity.uid); assert.equal(current.mode & 0o777, 0o700); await fs.rm(root, { recursive: true, force: false }); } },
  ]);
}
void main().catch(error => { console.error(JSON.stringify({ gate: 'mobile-native-issuer-certificate', failed: true, name: error instanceof Error ? error.name : 'unknown' })); process.exitCode = 1; });
