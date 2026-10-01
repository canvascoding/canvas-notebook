import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function legacyCiphertext(value: string, key: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${body.toString('hex')}`;
}

async function writeFixture(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { mode: 0o600 });
}

async function main(): Promise<void> {
  if (process.argv.includes('--initialize-child')) {
    const { ensureMcpCredentialKey } = await import('../app/lib/mcp/encryption-readiness');
    await ensureMcpCredentialKey();
    return;
  }
  const original = { ...process.env };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-encryption-readiness-'));
  const cleanEnv = () => {
    for (const key of ['DATA', 'CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH', 'CANVAS_SECRETS_MASTER_KEY', 'INTEGRATIONS_ENV_MASTER_KEY', 'AGENTS_ENV_MASTER_KEY', 'MCP_CREDENTIAL_PREVIOUS_KEYS', 'EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY']) delete process.env[key];
  };
  try {
    cleanEnv();
    process.env.CANVAS_DATA_ROOT = root;
    const store = await import('../app/lib/secrets/unified-env-store');
    const env = await import('../app/lib/integrations/env-config');
    const email = await import('../app/lib/email/secret-store');
    const mcp = await import('../app/lib/mcp/encryption-readiness');
    const { openMcpSecret, sealMcpSecret } = await import('../app/lib/mcp/secret-store');
    const actor = { userId: 'alice' };
    const payload = { authType: 'oauth' as const, tokenType: 'Bearer', accessToken: 'email-fixture', refreshToken: 'refresh-fixture' };
    const ref = email.emailAccountSecretRef('alice', 'existing');
    await email.writeEmailAccountSecret(ref, payload);
    const state = await store.readUnifiedEnvState(actor);
    const emailEntry = state.entries.find(entry => entry.key.startsWith('CANVAS_CREDENTIAL_EMAIL_'))!;
    assert.ok(emailEntry.value.startsWith('enc:v1:'));
    assert.equal(state.readable, true, 'adapter ciphertext is readable with no outer ENV key');
    assert.deepEqual(await email.readEmailAccountSecret(ref), payload);
    assert.equal((await env.readScopedEnvState('integrations', actor)).readable, true, 'email credentials must not poison MCP/environment reads');
    const bytes = await fs.readFile(state.path);
    assert.equal((await store.readUnifiedEnvState(actor)).revision, state.revision);
    assert.deepEqual(await fs.readFile(state.path), bytes, 'diagnostics preserve adapter ciphertext and file bytes');
    const fresh = await mcp.getMcpEncryptionReadiness(actor);
    assert.equal(fresh.status, 'mcp_credential_key_missing');
    assert.equal(fresh.canInitialize, true);
    await mcp.assertMcpEncryptionReady(actor, { provision: true });
    assert.equal((await mcp.getMcpEncryptionReadiness(actor)).status, 'ready');
    const key = store.readUnifiedSecretValue('MCP_CREDENTIAL_KEY', { secretScope: 'system' })!;
    await Promise.all(Array.from({ length: 8 }, () => mcp.ensureMcpCredentialKey()));
    assert.equal(store.readUnifiedSecretValue('MCP_CREDENTIAL_KEY', { secretScope: 'system' }), key);
    const binding = { ownerUserId: 'alice', connectionId: 'fixture', purpose: 'test' };
    const sealed = await sealMcpSecret({ accessToken: 'mcp-fixture' }, binding);
    assert.deepEqual(await openMcpSecret(sealed, binding), { accessToken: 'mcp-fixture' });
    await assert.rejects(() => openMcpSecret(JSON.stringify({ ...JSON.parse(sealed), keyId: '0'.repeat(64) }), binding), { code: 'decryption_failed' });
    await assert.rejects(() => openMcpSecret(sealed, { ...binding, ownerUserId: 'another-user' }), { code: 'decryption_failed' });
    await assert.rejects(() => openMcpSecret('{malformed', binding), { code: 'invalid_secret_format' });
    await store.patchUnifiedEnvEntries([{ key: 'MCP_CREDENTIAL_KEY', value: null }], { secretScope: 'system' });
    assert.equal((await mcp.getMcpEncryptionReadiness(actor)).canInitialize, false, 'durable marker prevents replacing a removed key even before token creation');
    await assert.rejects(() => mcp.ensureMcpCredentialKey(), { code: 'mcp_credential_key_missing' });
    await store.patchUnifiedEnvEntries([{ key: 'MCP_CREDENTIAL_KEY', value: key }], { secretScope: 'system' });

    const fallback = { userId: 'fallback' };
    const fallbackRef = email.emailAccountSecretRef('fallback', 'imported');
    const fallbackKey = `CANVAS_CREDENTIAL_EMAIL_${crypto.createHash('sha256').update(fallbackRef).digest('hex').toUpperCase()}`;
    const systemEmailKey = crypto.randomBytes(32).toString('base64url');
    await store.patchUnifiedEnvEntries([{ key: 'EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY', value: systemEmailKey }], { secretScope: 'system' });
    const fallbackEnvelope = legacyCiphertext(JSON.stringify(payload), systemEmailKey);
    await writeFixture(store.getUnifiedEnvFilePath(fallback), `${fallbackKey}=${fallbackEnvelope}\n`);
    assert.equal(store.readUnifiedSecretValue(fallbackKey, fallback), fallbackEnvelope, 'legacy email adapter system-key fallback remains valid');
    assert.deepEqual(await email.readEmailAccountSecret(fallbackRef), payload);

    // Old outer envelopes remain supported, including doubly wrapped email data.
    process.env.CANVAS_SECRETS_MASTER_KEY = 'outer-fixture';
    const legacy = { userId: 'legacy' };
    await writeFixture(store.getUnifiedEnvFilePath(legacy), `EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY=${legacyCiphertext(systemEmailKey, 'outer-fixture')}\n${fallbackKey}=${legacyCiphertext(fallbackEnvelope, 'outer-fixture')}\nREGULAR=${legacyCiphertext('ordinary-fixture', 'outer-fixture')}\n`);
    assert.equal(store.readUnifiedSecretValue(fallbackKey, legacy), fallbackEnvelope);
    assert.equal(store.readUnifiedSecretValue('REGULAR', legacy), 'ordinary-fixture');
    const oldBytes = await fs.readFile(store.getUnifiedEnvFilePath(legacy));
    assert.equal((await store.getUnifiedEnvReadiness(legacy)).status, 'ready');
    assert.deepEqual(await fs.readFile(store.getUnifiedEnvFilePath(legacy)), oldBytes);
    await store.patchUnifiedEnvEntries([{ key: 'REGULAR', value: 'changed-fixture' }], legacy);
    assert.match(await fs.readFile(store.getUnifiedEnvFilePath(legacy), 'utf8'), /enc:env:v1:/u);
    assert.equal(store.readUnifiedSecretValue(fallbackKey, legacy), fallbackEnvelope);
    const protectedBytes = await fs.readFile(store.getUnifiedEnvFilePath(legacy));
    process.env.CANVAS_SECRETS_MASTER_KEY = 'wrong-fixture';
    assert.equal((await store.getUnifiedEnvReadiness(legacy)).status, 'decryption_failed');
    await assert.rejects(() => store.patchUnifiedEnvEntries([{ key: 'REGULAR', value: 'unsafe-overwrite' }], legacy), { code: 'decryption_failed' });
    assert.deepEqual(await fs.readFile(store.getUnifiedEnvFilePath(legacy)), protectedBytes);
    delete process.env.CANVAS_SECRETS_MASTER_KEY;
    assert.equal((await store.getUnifiedEnvReadiness(legacy)).status, 'master_key_missing');
    await assert.rejects(() => store.patchUnifiedEnvEntries([], legacy), { code: 'master_key_missing' });
    assert.deepEqual(await fs.readFile(store.getUnifiedEnvFilePath(legacy)), protectedBytes);
    const invalid = { userId: 'invalid' };
    await writeFixture(store.getUnifiedEnvFilePath(invalid), 'REGULAR=enc:env:v1:invalid\n');
    assert.equal((await store.getUnifiedEnvReadiness(invalid)).status, 'invalid_secret_format');
    const fakeEmail = { userId: 'fake-email' };
    await writeFixture(store.getUnifiedEnvFilePath(fakeEmail), `EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY=${systemEmailKey}\n${fallbackKey}=${legacyCiphertext(JSON.stringify({ arbitrary: true }), systemEmailKey)}\n`);
    assert.equal((await store.readUnifiedEnvState(fakeEmail)).readable, false, 'reserved prefix alone never bypasses outer authentication');
    const missingEmailKey = { userId: 'missing-email-key' };
    await writeFixture(store.getUnifiedEnvFilePath(missingEmailKey), `${fallbackKey}=${legacyCiphertext(JSON.stringify(payload), 'unavailable-email-key')}\n`);
    assert.equal((await store.readUnifiedEnvState(missingEmailKey)).readable, false, 'unknown inner key never makes a sealed record readable');

    // Every fresh-root initializer shares the existing cross-process ENV lock.
    const concurrentRoot = path.join(root, 'fresh-parallel');
    process.env.CANVAS_DATA_ROOT = concurrentRoot;
    await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--conditions', 'react-server', path.resolve('scripts/secret-encryption-readiness-test.ts'), '--initialize-child'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Initialization child failed (${code}): ${output}`)));
    })));
    const concurrentKey = store.readUnifiedSecretValue('MCP_CREDENTIAL_KEY', { secretScope: 'system' });
    assert.ok(concurrentKey);
    await mcp.ensureMcpCredentialKey();
    assert.equal(store.readUnifiedSecretValue('MCP_CREDENTIAL_KEY', { secretScope: 'system' }), concurrentKey);
    assert.equal((await fs.stat(store.getUnifiedEnvFilePath({ secretScope: 'system' }))).mode & 0o777, 0o600);

    for (const evidence of ['canonical', 'legacy-file', 'pending-state', 'backup', 'previous-keys', 'legacy-key', 'user-key', 'org-key', 'integrations-override', 'agents-override']) {
      delete process.env.INTEGRATIONS_ENV_PATH;
      delete process.env.AGENTS_ENV_PATH;
      process.env.CANVAS_DATA_ROOT = path.join(root, `history-${evidence}`);
      const systemPath = store.getUnifiedEnvFilePath({ secretScope: 'system' });
      await writeFixture(systemPath, '# Active canonical store intentionally has no MCP key\n');
      if (evidence === 'canonical') await writeFixture(systemPath, 'CANVAS_CREDENTIAL_MCP_previous=null\n');
      if (evidence === 'legacy-file') await writeFixture(path.join(process.env.CANVAS_DATA_ROOT, 'users/alice/mcp/connections/old/tokens.json'), JSON.stringify({ sealed }));
      if (evidence === 'pending-state') await writeFixture(path.join(process.env.CANVAS_DATA_ROOT, 'users/alice/mcp/mcp-oauth/.state/pending.json'), JSON.stringify({ sealed }));
      if (evidence === 'backup') await writeFixture(path.join(process.env.CANVAS_DATA_ROOT, 'system/backups/retained.tar.gz'), 'backup-fixture');
      if (evidence === 'previous-keys') await writeFixture(systemPath, 'MCP_CREDENTIAL_PREVIOUS_KEYS=[]\n');
      if (evidence === 'legacy-key') await writeFixture(path.join(process.env.CANVAS_DATA_ROOT, 'secrets/Canvas-Integrations.env'), `MCP_CREDENTIAL_KEY=${key}\n`);
      if (evidence === 'user-key') await writeFixture(path.join(process.env.CANVAS_DATA_ROOT, 'users/alice/secrets/Canvas-Secrets.env'), `MCP_CREDENTIAL_KEY=${key}\n`);
      if (evidence === 'org-key') await writeFixture(path.join(process.env.CANVAS_DATA_ROOT, 'organizations/org/secrets/Canvas-Secrets.env'), `MCP_CREDENTIAL_KEY=${key}\n`);
      if (evidence.endsWith('-override')) {
        const overridePath = path.join(process.env.CANVAS_DATA_ROOT, 'external/original.env');
        process.env[evidence === 'integrations-override' ? 'INTEGRATIONS_ENV_PATH' : 'AGENTS_ENV_PATH'] = overridePath;
        await writeFixture(overridePath, `MCP_CREDENTIAL_KEY=${key}\n`);
      }
      const readiness = await mcp.getMcpEncryptionReadiness(actor);
      assert.equal(readiness.status, 'mcp_credential_key_missing');
      assert.equal(readiness.canInitialize, false, `${evidence} must block random key generation`);
      const before = await fs.readFile(systemPath).catch(() => null);
      await assert.rejects(() => mcp.assertMcpEncryptionReady(actor, { provision: true }), { code: 'mcp_credential_key_missing' });
      assert.deepEqual(await fs.readFile(systemPath).catch(() => null), before);
    }
    delete process.env.INTEGRATIONS_ENV_PATH;
    delete process.env.AGENTS_ENV_PATH;
    process.env.CANVAS_DATA_ROOT = root;
    process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(32).toString('base64url');
    assert.equal((await mcp.getMcpEncryptionReadiness({ userId: 'new-external' })).status, 'ready');
    const external = await sealMcpSecret({ fixture: true }, binding);
    assert.equal(JSON.parse(external).keyId, crypto.createHash('sha256').update(process.env.INTEGRATIONS_ENV_MASTER_KEY).digest('hex'), 'legacy external key retains priority');
    console.log('secret-encryption-readiness-test: PASS (actual email-prefix collision, legacy wrapping, fail-closed diagnostics, no overwrites, scoped fallback, first-use provisioning, durable history and concurrent processes)');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
