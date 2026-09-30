import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  return originalLoad(request, parent, isMain);
};

function encryptLegacyPayload(payload: unknown, masterSecret: string): string {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(masterSecret).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

async function main() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-email-unified-secrets-'));
  const envNames = [
    'CANVAS_DATA_ROOT', 'DATA', 'CANVAS_SECRETS_ENV_PATH', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH',
    'CANVAS_SECRETS_MASTER_KEY', 'INTEGRATIONS_ENV_MASTER_KEY', 'EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY',
  ] as const;
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

  try {
    process.env.CANVAS_DATA_ROOT = dataRoot;
    for (const name of envNames.slice(1)) delete process.env[name];
    process.env.CANVAS_SECRETS_MASTER_KEY = 'email-unified-store-fixture';

    const { readUnifiedEnvState, mutateUnifiedSecretValue } = await import('../app/lib/secrets/unified-env-store');
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const {
      deleteEmailAccountSecret,
      emailAccountSecretRef,
      readEmailAccountSecret,
      workspaceEmailAccountSecretRef,
      writeEmailAccountSecret,
    } = await import('../app/lib/email/secret-store');
    const keyFor = (ref: string) => `CANVAS_CREDENTIAL_EMAIL_${crypto.createHash('sha256').update(ref).digest('hex').toUpperCase()}`;

    const oauthRef = emailAccountSecretRef('alice', 'oauth-account');
    const oauth = {
      authType: 'oauth' as const,
      tokenType: 'Bearer',
      accessToken: 'oauth-access-fixture',
      refreshToken: 'oauth-refresh-fixture',
      scope: 'email profile',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const smtpRef = emailAccountSecretRef('alice', 'smtp-account');
    const smtp = {
      authType: 'smtp_imap' as const,
      smtp: { host: 'smtp.example.test', port: 587, secure: false, username: 'smtp-user', password: 'smtp-password-fixture' },
      imap: { host: 'imap.example.test', port: 993, secure: true, username: 'imap-user', password: 'imap-password-fixture' },
    };
    const unrelatedScope = { userId: 'concurrent' };
    await replaceScopedEnvEntries('integrations', [{ key: 'UNRELATED_INTEGRATION_KEY', value: 'preserve-fixture' }], unrelatedScope);
    const concurrentRefs = [emailAccountSecretRef('concurrent', 'one'), emailAccountSecretRef('concurrent', 'two')];
    await Promise.all([
      writeEmailAccountSecret(concurrentRefs[0], oauth),
      writeEmailAccountSecret(concurrentRefs[1], { ...oauth, accessToken: 'parallel-access-fixture' }),
    ]);
    const concurrentState = await readUnifiedEnvState(unrelatedScope);
    assert.equal(concurrentState.entries.find((entry) => entry.key === keyFor(concurrentRefs[0]))?.value.startsWith('enc:v1:'), true);
    assert.equal(concurrentState.entries.find((entry) => entry.key === keyFor(concurrentRefs[1]))?.value.startsWith('enc:v1:'), true);
    assert.equal(concurrentState.entries.find((entry) => entry.key === 'UNRELATED_INTEGRATION_KEY')?.value, 'preserve-fixture');
    assert.ok(concurrentState.entries.some((entry) => entry.key === 'EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY'));

    await writeEmailAccountSecret(oauthRef, oauth);
    await writeEmailAccountSecret(smtpRef, smtp);
    assert.deepEqual(await readEmailAccountSecret(oauthRef), oauth);
    assert.deepEqual(await readEmailAccountSecret(smtpRef), smtp);
    const aliceState = await readUnifiedEnvState({ userId: 'alice' });
    const bobScopedState = await readUnifiedEnvState({ userId: 'bob' });
    assert.equal(aliceState.entries.some((entry) => entry.key === keyFor(oauthRef)), true);
    assert.equal(aliceState.entries.some((entry) => entry.key === keyFor(smtpRef)), true);
    assert.equal(bobScopedState.entries.some((entry) => entry.key === keyFor(oauthRef)), false);

    const workspaceRef = workspaceEmailAccountSecretRef('shared-mailbox');
    await writeEmailAccountSecret(workspaceRef, smtp);
    const systemState = await readUnifiedEnvState({ secretScope: 'system' });
    assert.equal(systemState.entries.some((entry) => entry.key === keyFor(workspaceRef)), true);
    assert.equal(aliceState.entries.some((entry) => entry.key === keyFor(workspaceRef)), false);

    const legacyMaster = 'legacy-inner-master-fixture';
    await replaceScopedEnvEntries('integrations', [{ key: 'EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY', value: legacyMaster }], { secretScope: 'system' });
    const legacyRef = emailAccountSecretRef('bob', 'legacy-source');
    const legacyPath = path.join(dataRoot, 'secrets', 'email-accounts', legacyRef);
    const legacyPayload = {
      authType: 'oauth', tokenType: 'Bearer', accessToken: 'legacy-encrypted-fixture',
      refreshToken: 'legacy-refresh-fixture', scope: 'email',
    };
    const legacyEnvelope = encryptLegacyPayload(legacyPayload, legacyMaster);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, legacyEnvelope, { mode: 0o600 });
    assert.deepEqual(await readEmailAccountSecret(legacyRef), legacyPayload);
    assert.equal(await fs.readFile(legacyPath, 'utf8'), legacyEnvelope);
    const bobState = await readUnifiedEnvState({ userId: 'bob' });
    assert.equal(bobState.entries.find((entry) => entry.key === keyFor(legacyRef))?.value, legacyEnvelope);

    const deletedRef = emailAccountSecretRef('alice', 'deleted-source');
    const deletedLegacyPath = path.join(dataRoot, 'secrets', 'email-accounts', deletedRef);
    const deletedFixture = JSON.stringify({ authType: 'oauth', tokenType: 'Bearer', accessToken: 'old-legacy-fixture' });
    await fs.mkdir(path.dirname(deletedLegacyPath), { recursive: true });
    await fs.writeFile(deletedLegacyPath, deletedFixture, { mode: 0o600 });
    const deletedSecret = await readEmailAccountSecret(deletedRef);
    assert.equal(deletedSecret.authType, 'oauth');
    if (deletedSecret.authType === 'oauth') assert.equal(deletedSecret.accessToken, 'old-legacy-fixture');
    await deleteEmailAccountSecret(deletedRef);
    await assert.rejects(() => readEmailAccountSecret(deletedRef), /missing or deleted/u);
    assert.equal(await fs.readFile(deletedLegacyPath, 'utf8'), deletedFixture);
    await writeEmailAccountSecret(deletedRef, { ...oauth, accessToken: 'reconnected-fixture' });
    const reconnectedSecret = await readEmailAccountSecret(deletedRef);
    assert.equal(reconnectedSecret.authType, 'oauth');
    if (reconnectedSecret.authType === 'oauth') assert.equal(reconnectedSecret.accessToken, 'reconnected-fixture');

    const invalidWriteRef = emailAccountSecretRef('alice', 'invalid-write');
    await assert.rejects(() => writeEmailAccountSecret(invalidWriteRef, {
      authType: 'smtp_imap', smtp: { host: 'smtp.example.test', port: 70_000, secure: false, username: 'user', password: 'pass' },
    } as never), /Invalid SMTP email account secret settings/u);
    const malformedRef = emailAccountSecretRef('alice', 'malformed-payload');
    const malformedPath = path.join(dataRoot, 'users', 'alice', 'secrets', 'email-accounts', 'malformed-payload.json.enc');
    await fs.mkdir(path.dirname(malformedPath), { recursive: true });
    await fs.writeFile(malformedPath, JSON.stringify({ authType: 'oauth', accessToken: 'missing-token-type' }));
    await assert.rejects(() => readEmailAccountSecret(malformedRef), /Invalid OAuth email account secret payload/u);

    const tamperedRef = emailAccountSecretRef('alice', 'tampered-ciphertext');
    await mutateUnifiedSecretValue(keyFor(tamperedRef), async () => 'enc:v1:tampered', { userId: 'alice' });
    await assert.rejects(() => readEmailAccountSecret(tamperedRef), /Invalid email account secret format/u);

    process.env.INTEGRATIONS_ENV_MASTER_KEY = 'wrong-inner-master-fixture';
    await assert.rejects(() => readEmailAccountSecret(oauthRef));
    delete process.env.INTEGRATIONS_ENV_MASTER_KEY;
    process.env.CANVAS_SECRETS_MASTER_KEY = 'wrong-outer-master-fixture';
    await assert.rejects(() => readEmailAccountSecret(oauthRef), /cannot be decrypted safely/u);
    process.env.CANVAS_SECRETS_MASTER_KEY = 'email-unified-store-fixture';

    assert.throws(() => emailAccountSecretRef('alice/other', 'path-alias'), /Invalid email account secret reference segment/u);
    assert.throws(() => emailAccountSecretRef('workspace', 'reserved-owner'), /reserved/u);
    await assert.rejects(() => readEmailAccountSecret('alice/../outside.json.enc'), /Invalid email account secret reference/u);
    await assert.rejects(() => readEmailAccountSecret('alice//account.json.enc'), /Invalid email account secret reference/u);

    console.log('email-unified-secrets-test: ok');
  } finally {
    for (const name of envNames) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(dataRoot, { recursive: true, force: true });
    moduleInternals._load = originalLoad;
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
