import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';

// Actual isolated SQL, signed certificates, JWT/trust/claims/expiry/monotonic
// policy and real lease. Only forbidden global SQL/network boundaries are
// instrumented. No LicenseStatus, Seat, Actor or authority result is mocked.
async function main() {
  const fixture = await createCapabilityPackageStoreApplicationFixture();
  const previousFetch = globalThis.fetch;
  const names = ['CANVAS_LICENSE_CERT', 'CANVAS_LICENSE_PUBLIC_KEY', 'CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS'] as const;
  const previousEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const kid = fingerprint.slice(0, 16), now = Math.floor(Date.now() / 1000);
  const originalPayload = JSON.parse(Buffer.from(process.env.CANVAS_LICENSE_CERT!.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  const instanceId = process.env.CANVAS_INSTANCE_ID!;
  const certificate = (overrides: Record<string, unknown> = {}, keyId = kid) => {
    const encoded = [JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: keyId }), JSON.stringify({ ...originalPayload,
      iat: now - 600, exp: now + 3600, entitlementsVersion: 1, ...overrides })].map(value => Buffer.from(value).toString('base64url')).join('.');
    return `${encoded}.${sign('RSA-SHA256', Buffer.from(encoded), privateKey).toString('base64url')}`;
  };
  const actualOpen = fixture.database.openDb;
  const database = await actualOpen();
  const globalDatabase = fixture.database.db;
  const originalMethods = { select: globalDatabase.select, insert: globalDatabase.insert, update: globalDatabase.update, delete: globalDatabase.delete };
  let forbiddenSQL = 0, forbiddenNetwork = 0, certReads = 0, keyReads = 0, closes = 0;
  const leased = { ...database,
    get: async (query: string, params: unknown[] = []) => { if (/FROM license_certs/u.test(query)) certReads++; return database.get(query, params); },
    all: async (query: string, params: unknown[] = []) => { if (/FROM license_public_keys/u.test(query)) keyReads++; return database.all(query, params); },
    close: async () => { closes++; throw new Error('A borrowed license reader must not close its lease.'); },
  };
  try {
    process.env.CANVAS_LICENSE_PUBLIC_KEY = pem;
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    process.env.CANVAS_LICENSE_CERT = certificate();
    const { getLicenseStatus, getLicenseStatusOnConnection } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT, instanceId)).ok);
    const setHead = async (cert: string) => {
      await fixture.sql.run('DELETE FROM license_certs WHERE instance_id=$1', [instanceId]);
      await fixture.sql.run('INSERT INTO license_certs(cert,plan,instance_id,created_at,updated_at) VALUES($1,$2,$3,$4,$4)',
        [cert, 'managed', instanceId, Date.now()]);
    };
    const newer = certificate({ entitlementsVersion: 2 });
    await setHead(newer);
    const ordinary = await getLicenseStatus();
    assert.equal(ordinary.licensed, true); assert.equal(ordinary.entitlementsVersion, 2);
    fixture.database.openDb = async () => { forbiddenSQL++; throw new Error('No new license connection is permitted.'); };
    const forbidden = () => { forbiddenSQL++; throw new Error('No global Drizzle license checkout/write is permitted.'); };
    globalDatabase.select = forbidden; globalDatabase.insert = forbidden; globalDatabase.update = forbidden; globalDatabase.delete = forbidden;
    globalThis.fetch = async () => { forbiddenNetwork++; throw new Error('A held license reader cannot fetch keys or refresh a certificate.'); };
    const read = async () => {
      const before = await fixture.sql.all('SELECT cert FROM license_certs WHERE instance_id=$1 ORDER BY id', [instanceId]);
      await database.run('BEGIN');
      try {
        const status = await getLicenseStatusOnConnection(leased);
        await database.run('COMMIT');
        assert.deepEqual(await fixture.sql.all('SELECT cert FROM license_certs WHERE instance_id=$1 ORDER BY id', [instanceId]), before);
        return status;
      } catch (error) { await database.run('ROLLBACK'); throw error; }
    };
    const fresh = await read();
    assert.equal(fresh.licensed, true); assert.equal(fresh.entitlementsVersion, 2); assert.equal(fresh.source, 'stored');
    assert.equal(certReads, 1);

    await setHead(certificate({ entitlementsVersion: 2, iat: now - 7200, exp: now - 60 }));
    const expired = await read();
    assert.equal(expired.licensed, false, 'A valid old ENV certificate cannot reactivate a newer expired stored entitlement.');
    assert.equal(expired.licenseState, 'grace_required'); assert.equal(expired.entitlementsVersion, 2); assert.equal(expired.code, 'LICENSE_CERT_EXPIRED');
    await setHead(certificate({ entitlementsVersion: 3, edition: 'invalid-product' }));
    const invalid = await read();
    assert.equal(invalid.licensed, false, 'A newer invalid-product head still prevents downgrade to old active ENV.');
    assert.equal(invalid.code, 'LICENSE_CERT_CLAIMS_INVALID');

    await setHead(newer);
    // No ENV key and no memory-cache authority: trust the real current database
    // key only. Reads must not update last_used_at or persist fetched keys.
    delete process.env.CANVAS_LICENSE_PUBLIC_KEY;
    const timestamp = 1_000;
    await fixture.sql.run('INSERT INTO license_public_keys(kid,public_key,fingerprint,source,fetched_at,last_used_at) VALUES($1,$2,$3,$4,$5,$5)',
      [kid, pem, fingerprint, 'control_plane_production', timestamp]);
    const trusted = await read();
    assert.equal(trusted.licensed, true); assert.equal(trusted.entitlementsVersion, 2); assert(keyReads >= 2);
    assert.equal(Number((await fixture.sql.get('SELECT last_used_at FROM license_public_keys WHERE fingerprint=$1', [fingerprint]) as { last_used_at: string }).last_used_at), 1_000);
    await fixture.sql.run('DELETE FROM license_public_keys WHERE fingerprint=$1', [fingerprint]);
    const removed = await read();
    assert.equal(removed.licensed, false, 'A warm normal resolver cannot replace a revoked current database key.');
    await fixture.sql.run('INSERT INTO license_public_keys(kid,public_key,fingerprint,source,fetched_at) VALUES($1,$2,$3,$4,$5)',
      [kid, pem, fingerprint, 'control_plane_test', timestamp]);
    assert.equal((await read()).licensed, false, 'A trusted test-source key cannot authorize a production certificate.');
    await fixture.sql.run('UPDATE license_public_keys SET source=$1 WHERE fingerprint=$2', ['control_plane_production', fingerprint]);
    await setHead(certificate({ entitlementsVersion: 4 }, 'unknown-current-kid'));
    const unknown = await read();
    assert.equal(unknown.licensed, false); assert.equal(unknown.code, 'LICENSE_CERT_KEY_ID_UNKNOWN');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = 'invalid explicitly configured PEM';
    assert.equal((await read()).licensed, false, 'An explicitly invalid ENV key must not fall back to a valid stored key.');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = pem;
    await setHead(newer);
    const broken = { ...leased, get: async () => { throw new Error('Owned storage read failure.'); } };
    assert.equal((await getLicenseStatusOnConnection(broken)).licensed, false, 'Unreadable stored revision cannot fall back to an unchecked active ENV certificate.');
    assert.equal(forbiddenSQL, 0); assert.equal(forbiddenNetwork, 0); assert.equal(closes, 0);
    console.log('PASS real SQL/signed-license borrowed reader: newer valid, expired/invalid monotonic head, current trusted database key, removed/test/unknown/invalid key, storage failure; zero global SQL, writes, refresh, network or borrowed close.');
  } finally {
    globalThis.fetch = previousFetch;
    fixture.database.openDb = actualOpen;
    Object.assign(globalDatabase, originalMethods);
    await database.close();
    for (const name of names) if (previousEnv[name] === undefined) delete process.env[name]; else process.env[name] = previousEnv[name];
    await fixture.close();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
