import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-unified-'));
  const keys = ['CANVAS_DATA_ROOT', 'CANVAS_SECRETS_ENV_PATH', 'CANVAS_SECRETS_MASTER_KEY', 'INTEGRATIONS_ENV_MASTER_KEY'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.CANVAS_DATA_ROOT = root;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.CANVAS_SECRETS_MASTER_KEY = crypto.randomBytes(32).toString('hex');
  delete process.env.CANVAS_SECRETS_ENV_PATH;
  try {
    const store = await import('../app/lib/secrets/unified-env-store');
    const credentials = await import('../app/lib/mcp/credential-storage');
    const { sealMcpSecret } = await import('../app/lib/mcp/secret-store');
    const { resolveMcpStoragePath } = await import('../app/lib/mcp/storage');
    const a = { userId: 'alice', organizationId: 'org-a' };
    const b = { userId: 'bob', organizationId: 'org-a' };
    const system = { legacy: true };
    const relative = 'connections/connection-a/tokens.json';
    const envKey = `CANVAS_CREDENTIAL_MCP_${crypto.createHash('sha256').update(relative).digest('hex')}`;
    const envA = { secretScope: 'user' as const, userId: a.userId };
    const payload = { connectionId: 'connection-a', organizationId: 'org-a', accessToken: 'fixture-access', refreshToken: 'fixture-refresh' };
    await credentials.writeMcpCredentialJson(relative, payload, a);
    assert.deepEqual(await credentials.readMcpCredentialJson(relative, a), payload);
    assert.equal(await credentials.readMcpCredentialJson(relative, b), null);
    assert.equal(await credentials.readMcpCredentialJson(relative, system), null);
    await assert.rejects(() => credentials.readMcpCredentialJson(relative, { ...a, organizationId: 'org-b' }), /organization/i);
    const physical = await fs.readFile(store.getUnifiedEnvFilePath(envA), 'utf8');
    assert.equal(physical.includes('fixture-access'), false);
    assert.equal((await fs.stat(store.getUnifiedEnvFilePath(envA))).mode & 0o777, 0o600);
    await assert.rejects(() => fs.stat(resolveMcpStoragePath(relative, a)), { code: 'ENOENT' });
    const envelope = store.readUnifiedSecretValue(envKey, envA)!;
    await store.mutateUnifiedSecretValue(envKey, async () => envelope, { userId: b.userId });
    await assert.rejects(() => credentials.readMcpCredentialJson(relative, b), /authenticated|binding|decrypt/i);
    const state = await store.readUnifiedEnvState(envA);
    await credentials.readMcpCredentialJson(relative, a);
    assert.equal((await store.readUnifiedEnvState(envA)).revision, state.revision, 'credential reads must keep revisions stable');

    // Bound sealed files are import-only; confirmed canonical values win forever.
    const legacyRelative = 'connections/connection-old/client.json';
    const binding = { ownerUserId: a.userId, organizationId: 'org-a', connectionId: 'connection-old', purpose: legacyRelative };
    const legacyPayload = { connectionId: 'connection-old', organizationId: 'org-a', clientSecret: 'fixture-client-secret' };
    const sealed = await sealMcpSecret(legacyPayload, binding);
    const oldPath = resolveMcpStoragePath(legacyRelative, a);
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    const oldContent = JSON.stringify({ connectionId: 'connection-old', organizationId: 'org-a', sealed });
    await fs.writeFile(oldPath, oldContent);
    assert.deepEqual(await credentials.readMcpCredentialJson(legacyRelative, a), legacyPayload);
    assert.equal(await fs.readFile(oldPath, 'utf8'), oldContent);
    await credentials.writeMcpCredentialJson(legacyRelative, { ...legacyPayload, clientSecret: 'fixture-reconnected' }, a);
    assert.equal((await credentials.readMcpCredentialJson<{ clientSecret: string }>(legacyRelative, a))?.clientSecret, 'fixture-reconnected');
    await credentials.removeMcpCredentialJson(legacyRelative, a);
    assert.equal(await credentials.readMcpCredentialJson(legacyRelative, a), null, 'logout must not replay the legacy file');
    const deleted = await store.readUnifiedEnvState(envA);
    await credentials.removeMcpCredentialJson(legacyRelative, a);
    assert.equal((await store.readUnifiedEnvState(envA)).revision, deleted.revision);
    await credentials.writeMcpCredentialJson(legacyRelative, legacyPayload, a);
    assert.deepEqual(await credentials.readMcpCredentialJson(legacyRelative, a), legacyPayload, 'reconnect replaces tombstone');

    await Promise.all(Array.from({ length: 12 }, (_, index) => credentials.writeMcpCredentialJson(
      `connections/parallel-${index}/tokens.json`, { connectionId: `parallel-${index}`, accessToken: `fixture-${index}` }, a,
    )));
    for (let index = 0; index < 12; index++) assert.equal((await credentials.readMcpCredentialJson<{ accessToken: string }>(`connections/parallel-${index}/tokens.json`, a))?.accessToken, `fixture-${index}`);
    await store.mutateUnifiedSecretValue(envKey, async () => '{broken', envA);
    await assert.rejects(() => credentials.readMcpCredentialJson(relative, a), /envelope/i);
    await assert.rejects(() => credentials.writeMcpCredentialJson('connections/../tokens.json', payload, a), /path/i);
    await store.mutateUnifiedSecretValue(envKey, async () => envelope, envA);
    process.env.CANVAS_SECRETS_MASTER_KEY = crypto.randomBytes(32).toString('hex');
    await assert.rejects(() => credentials.readMcpCredentialJson(relative, a), /decrypt|master/i);
    console.log('mcp-unified-secrets-test: PASS (scopes, AAD, migration, logout, reconnect, revisions, concurrent writes, fail-closed)');
  } finally {
    for (const key of keys) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exit(1); });
