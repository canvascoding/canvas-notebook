import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { transformSync } from 'esbuild';
import { createCapabilityPackageStoreApplicationFixture } from './helpers/capability-package-store-application-fixture';
import type { ApiKeyCredential } from '../app/lib/api-keys/authentication';

async function main() {
  const native = process.argv.includes('--native');
  const fixture = await createCapabilityPackageStoreApplicationFixture({ native, ...(native ? { nativePoolMax: 10 as const } : {}) });
  try {
    const management = await import('../app/lib/api-keys/management');
    const authentication = await import('../app/lib/api-keys/authentication');
    const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === expected);
    const request = (key?: string, extra: Record<string, string> = {}) => new Request('https://notebook.example.test/api/documents/read',
      { headers: { ...(key === undefined ? {} : { 'X-Canvas-API-Key': key }), ...extra } });
    const create = () => management.createApiIntegration(fixture.headers('owner'), { requestId: randomUUID(), name: 'Authentication test',
      workspaceIds: ['personal-owner'], expiresAt: Date.now() + 3_600_000 });
    const first = await create();
    const credential = await authentication.authenticateApiKeyRequest(request(first.key));
    const database = await fixture.openObserverConnection();
    try {
      const current = await authentication.readCurrentApiKeyIdentityOnConnection(database, credential);
      assert.equal(current.credentialId, first.credential.id); assert.equal(current.integrationId, first.integration.id);
      assert.equal(current.userId, 'owner'); assert.deepEqual(current.actions, ['read']);
      assert.deepEqual(current.workspaceIds, ['personal-owner']); assert.equal(current.realm.schema, 'public');
      assert(!JSON.stringify(current).includes(first.key)); assert(!JSON.stringify(current).includes('secret_hash'));
      assert(Object.isFrozen(current) && Object.isFrozen(current.workspaceIds) && Object.isFrozen(current.actions));
      const source = path.resolve('app/lib/api-keys/authentication.ts');
      const compiled = transformSync(fs.readFileSync(source, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code;
      const secondModule = new Module(source + '.independent.cjs') as Module & { _compile: (code: string, filename: string) => void; paths: string[] };
      secondModule.paths = (Module as typeof Module & { _nodeModulePaths: (directory: string) => string[] })._nodeModulePaths(path.dirname(source));
      secondModule.filename = source + '.independent.cjs'; secondModule._compile(compiled, secondModule.filename);
      const independent = secondModule.exports as typeof authentication;
      assert.equal((await independent.readCurrentApiKeyIdentityOnConnection(database, credential)).credentialId, first.credential.id,
        'A second independently compiled module recognizes the genuine handle without serializing a grant.');
      for (const fake of [{}, JSON.parse(JSON.stringify(credential)), structuredClone(current), new Proxy(credential, {})]) {
        await assert.rejects(authentication.readCurrentApiKeyIdentityOnConnection(database, fake as ApiKeyCredential), code('API_KEY_INVALID'));
      }
      const changed = await management.updateApiIntegration(fixture.headers('owner'), first.integration.id,
        { expectedRevision: 1, name: 'Changed grants', workspaceIds: ['personal-owner'], actions: ['read', 'edit'] });
      assert.equal(changed.integration.revision, 2);
      assert.deepEqual((await authentication.readCurrentApiKeyIdentityOnConnection(database, credential)).actions, ['read', 'edit'],
        'Credential captures must not cache positive action or workspace grants.');
      const rotated = await management.rotateApiKey(fixture.headers('owner'), first.integration.id,
        { requestId: randomUUID(), expectedRevision: 2, expiresAt: Date.now() + 3_600_000 });
      await assert.rejects(authentication.readCurrentApiKeyIdentityOnConnection(database, credential), code('API_KEY_INVALID'));
      await assert.rejects(authentication.authenticateApiKeyRequest(request(first.key)), code('API_KEY_INVALID'));
      const currentCredential = await authentication.authenticateApiKeyRequest(request(rotated.key));
      const afterRotation = await authentication.readCurrentApiKeyIdentityOnConnection(database, currentCredential);
      assert.equal(afterRotation.integrationId, current.integrationId); assert.notEqual(afterRotation.credentialId, current.credentialId);

      assert.equal(authentication.hasApiKeyCredential(request()), false);
      assert.equal(authentication.hasApiKeyCredential(request('')), true);
      for (const value of ['', 'invalid', `${rotated.key},${rotated.key}`,
        `cnk_${rotated.credential.id}.${randomBytes(32).toString('base64url')}`,
        `cnk_${randomUUID()}.${randomBytes(32).toString('base64url')}`]) {
        await assert.rejects(authentication.authenticateApiKeyRequest(request(value)), code('API_KEY_INVALID'));
      }
      await assert.rejects(authentication.authenticateApiKeyRequest(request(rotated.key, { Authorization: 'Bearer unrelated' })), code('API_KEY_CREDENTIALS_CONFLICT'));
      await assert.rejects(authentication.authenticateApiKeyRequest(request(rotated.key, { Cookie: 'better-auth.session_token=unrelated' })), code('API_KEY_CREDENTIALS_CONFLICT'));
      const harmless = await authentication.authenticateApiKeyRequest(request(rotated.key, { Cookie: 'locale=en' }));
      assert.equal((await authentication.readCurrentApiKeyIdentityOnConnection(database, harmless)).integrationId, first.integration.id);

      await fixture.sql.run("UPDATE \"user\" SET banned=1 WHERE id='owner'");
      await assert.rejects(authentication.authenticateApiKeyRequest(request(rotated.key)), code('API_KEY_ACCOUNT_INACTIVE'));
      await assert.rejects(authentication.readCurrentApiKeyIdentityOnConnection(database, currentCredential), code('API_KEY_ACCOUNT_INACTIVE'));
      await fixture.sql.run("UPDATE \"user\" SET banned=0 WHERE id='owner'");
      const instanceId = process.env.CANVAS_INSTANCE_ID;
      try {
        process.env.CANVAS_INSTANCE_ID = 'foreign-instance';
        await assert.rejects(authentication.authenticateApiKeyRequest(request(rotated.key)), code('API_KEY_INVALID'));
        await assert.rejects(authentication.readCurrentApiKeyIdentityOnConnection(database, currentCredential), code('API_KEY_INVALID'));
      } finally { process.env.CANVAS_INSTANCE_ID = instanceId; }

      const keyBucket = `document-api-key:key:${rotated.credential.id}`;
      await fixture.sql.run('UPDATE security_public_rate_limits SET count=240,reset_at=$2 WHERE bucket_key=$1', [keyBucket, Date.now() + 60_000]);
      await assert.rejects(authentication.authenticateApiKeyRequest(request(rotated.key)), code('API_KEY_RATE_LIMITED'));
      await fixture.sql.run('UPDATE security_public_rate_limits SET count=0 WHERE bucket_key=$1', [keyBucket]);
      const userBucket = `document-api-key:user:${createHash('sha256').update('owner').digest('hex')}`;
      await fixture.sql.run('UPDATE security_public_rate_limits SET count=600,reset_at=$2 WHERE bucket_key=$1', [userBucket, Date.now() + 60_000]);
      await assert.rejects(authentication.authenticateApiKeyRequest(request(rotated.key)), code('API_KEY_RATE_LIMITED'));
      await fixture.sql.run('UPDATE security_public_rate_limits SET count=0 WHERE bucket_key=$1', [userBucket]);
      const beforeUsage = await database.get('SELECT last_used_at,xmin::text AS xmin FROM canvas_api_keys WHERE id=$1', [rotated.credential.id]);
      const warmStatements: string[] = [];
      fixture.setBeforeRead(async query => { warmStatements.push(query); });
      fixture.setAfterQuery(async query => { warmStatements.push(query); });
      await authentication.authenticateApiKeyRequest(request(rotated.key));
      fixture.setBeforeRead(undefined); fixture.setAfterQuery(undefined);
      assert.equal(warmStatements.length, 5, 'Warm entry authentication, including shared client/global/key/user limits and usage, uses five SQL statements.');
      assert.equal(warmStatements.filter(query => query.startsWith('WITH selected_credential')).length, 1);
      await authentication.readCurrentApiKeyIdentityOnConnection(database, currentCredential);
      await authentication.readCurrentApiKeyIdentityOnConnection(database, currentCredential);
      assert.deepEqual(await database.get('SELECT last_used_at,xmin::text AS xmin FROM canvas_api_keys WHERE id=$1', [rotated.credential.id]), beforeUsage,
        'Repeated admission within the window and inner checks must not rewrite the credential statistic.');

      if (native) {
        await database.get("SELECT pg_catalog.set_config('search_path',$1,false)", ['public, pg_catalog, public']);
        try { await assert.rejects(authentication.readCurrentApiKeyIdentityOnConnection(database, currentCredential), code('API_KEY_INVALID')); }
        finally { await database.get("SELECT pg_catalog.set_config('search_path',$1,false)", [current.realm.searchPath]); }
        await database.run('CREATE TEMP TABLE canvas_api_keys AS SELECT * FROM public.canvas_api_keys');
        try { await assert.rejects(authentication.readCurrentApiKeyIdentityOnConnection(database, currentCredential), code('API_KEY_STATE_INVALID')); }
        finally { await database.run('DROP TABLE pg_temp.canvas_api_keys'); }
      }
      const other = await create();
      const otherCredential = await authentication.authenticateApiKeyRequest(request(other.key));
      assert.notEqual((await authentication.readCurrentApiKeyIdentityOnConnection(database, otherCredential)).integrationId, afterRotation.integrationId);
      await management.revokeApiKey(fixture.headers('owner'), first.integration.id, { expectedRevision: 3, credentialId: rotated.credential.id });
      await assert.rejects(authentication.readCurrentApiKeyIdentityOnConnection(database, currentCredential), code('API_KEY_INVALID'));
      await fixture.sql.run("DELETE FROM session WHERE id='session-owner'");
      const afterLogout = await authentication.authenticateApiKeyRequest(request(other.key));
      assert.equal((await authentication.readCurrentApiKeyIdentityOnConnection(database, afterLogout)).integrationId, other.integration.id,
        'Programmatic access is independent of a logged-out browser session.');
      await fixture.sql.run('UPDATE canvas_api_keys SET expires_at=created_at+1 WHERE id=$1', [other.credential.id]);
      await assert.rejects(authentication.authenticateApiKeyRequest(request(other.key)), code('API_KEY_INVALID'));
      await assert.rejects(authentication.readCurrentApiKeyIdentityOnConnection(database, afterLogout), code('API_KEY_INVALID'));
      console.log(`API-key authentication ${native ? 'PostgreSQL' : 'PGlite'} passed: real issuance, opaque proof, fresh grants, rotation/revocation/expiry, account/instance checks, mixed credentials, shared key/user limits, bounded usage and browser-logout independence. Document authorization remains a separate required phase.`);
    } finally { await database.close(); }
  } finally { fixture.setBeforeRead(undefined); fixture.setAfterQuery(undefined); await fixture.close(); }
}

main().catch(error => {
  const message = error instanceof Error ? error.message.split('\n')[0].replace(/cnk_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}/gu, '[redacted-api-key]') : 'Unknown failure';
  console.error('API-key authentication test failed:', message); process.exitCode = 1;
});
