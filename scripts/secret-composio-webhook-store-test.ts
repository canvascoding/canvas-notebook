import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SYSTEM_SCOPE = { secretScope: 'system' as const };
const CREDENTIAL_PREFIX = 'CANVAS_CREDENTIAL_COMPOSIO_WEBHOOK_';
const REFERENCE_PREFIX = 'canvas:env:v1:';
const MASTER_KEY = 'fixture-composio-webhook-master-key';
const SECRET_STORE_KEY = 'fixture-canvas-secret-store-master-key';

function encryptedFixture(plainText: string, masterSecret: string): string {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(masterSecret).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function credentialKey(ciphertext: string): string {
  return `${CREDENTIAL_PREFIX}${crypto.createHash('sha256').update(ciphertext, 'utf8').digest('hex')}`;
}

function legacyPlaintextKey(plaintext: string): string {
  return `${CREDENTIAL_PREFIX}${crypto.createHash('sha256').update(`legacy-plaintext:${plaintext}`, 'utf8').digest('hex')}`;
}

async function main() {
  const environmentBefore = { ...process.env };
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-composio-webhook-secret-'));
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_SECRETS_MASTER_KEY = SECRET_STORE_KEY;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = MASTER_KEY;
  delete process.env.AGENTS_ENV_MASTER_KEY;
  delete process.env.CANVAS_SECRETS_ENV_PATH;

  try {
    const { decryptWebhookSecret, encryptWebhookSecret } = await import('../app/lib/composio/composio-webhook-secret');
    const { getUnifiedEnvFilePath, mutateUnifiedSecretValue, readUnifiedEnvState, readUnifiedSecretValue } = await import('../app/lib/secrets/unified-env-store');

    await mutateUnifiedSecretValue('WEBHOOK_UNRELATED_FIXTURE', async () => 'preserve-this-setting', SYSTEM_SCOPE);
    const plaintextFixture = 'composio-webhook-secret-fixture-only';
    const reference = await encryptWebhookSecret(plaintextFixture);
    assert.match(reference, /^canvas:env:v1:CANVAS_CREDENTIAL_COMPOSIO_WEBHOOK_[a-f0-9]{64}$/u);
    const referenceKey = reference.slice(REFERENCE_PREFIX.length);
    const serializedRecord = readUnifiedSecretValue(referenceKey, SYSTEM_SCOPE);
    assert.ok(serializedRecord);
    const record = JSON.parse(serializedRecord) as { version?: unknown; encrypted?: unknown };
    assert.deepEqual(Object.keys(record).sort(), ['encrypted', 'version']);
    assert.equal(record.version, 1);
    assert.equal(typeof record.encrypted, 'string');
    assert.match(record.encrypted as string, /^enc:v1:/u, 'canonical ENV stores the existing encrypted payload inside a typed record');
    assert.equal(serializedRecord.includes(plaintextFixture), false);
    assert.equal(await decryptWebhookSecret(reference), plaintextFixture);
    const referenceRevision = (await readUnifiedEnvState(SYSTEM_SCOPE)).revision;
    assert.equal(await decryptWebhookSecret(reference), plaintextFixture);
    assert.equal((await readUnifiedEnvState(SYSTEM_SCOPE)).revision, referenceRevision, 'reading a canonical reference does not mutate the ENV store');
    const physicalEnv = await fs.readFile(getUnifiedEnvFilePath(SYSTEM_SCOPE), 'utf8');
    assert.equal(physicalEnv.includes(plaintextFixture), false, 'the on-disk ENV file never contains the webhook secret plaintext');

    const legacyCiphertext = encryptedFixture('legacy-database-secret-fixture', MASTER_KEY);
    const legacyKey = credentialKey(legacyCiphertext);
    const legacyReference = `${REFERENCE_PREFIX}${legacyKey}`;
    const legacyValues = await Promise.all(Array.from({ length: 12 }, () => decryptWebhookSecret(legacyCiphertext)));
    assert.deepEqual(legacyValues, Array(12).fill('legacy-database-secret-fixture'), 'concurrent legacy reads import and decrypt through canonical ENV');
    const importedLegacyRecord = readUnifiedSecretValue(legacyKey, SYSTEM_SCOPE);
    assert.deepEqual(JSON.parse(importedLegacyRecord || 'null'), { version: 1, encrypted: legacyCiphertext });
    assert.equal(await decryptWebhookSecret(legacyReference), 'legacy-database-secret-fixture');
    const afterLegacyRevision = (await readUnifiedEnvState(SYSTEM_SCOPE)).revision;
    await decryptWebhookSecret(legacyCiphertext);
    assert.equal((await readUnifiedEnvState(SYSTEM_SCOPE)).revision, afterLegacyRevision, 'a migrated legacy cipher is imported only once');
    assert.equal(readUnifiedSecretValue('WEBHOOK_UNRELATED_FIXTURE', SYSTEM_SCOPE), 'preserve-this-setting', 'concurrent imports preserve unrelated settings');

    const oldDatabaseCipher = encryptedFixture('imported-canonical-secret-fixture', 'old-database-master-fixture');
    const oldDatabaseKey = credentialKey(oldDatabaseCipher);
    const preferredImportedCipher = encryptedFixture('imported-canonical-secret-fixture', MASTER_KEY);
    const preferredRecord = JSON.stringify({ version: 1, encrypted: preferredImportedCipher });
    await mutateUnifiedSecretValue(oldDatabaseKey, async (current) => current ?? preferredRecord, SYSTEM_SCOPE);
    assert.equal(await decryptWebhookSecret(oldDatabaseCipher), 'imported-canonical-secret-fixture', 'an already imported ENV ciphertext takes precedence over the old database ciphertext');
    assert.equal(readUnifiedSecretValue(oldDatabaseKey, SYSTEM_SCOPE), preferredRecord, 'legacy fallback never overwrites the imported ENV record');

    const missingReference = `${REFERENCE_PREFIX}${CREDENTIAL_PREFIX}${'f'.repeat(64)}`;
    await assert.rejects(() => decryptWebhookSecret(missingReference), /unavailable/u, 'missing references fail closed');
    await assert.rejects(() => decryptWebhookSecret(`${REFERENCE_PREFIX}../../COMPOSIO_API_KEY`), /Invalid webhook secret ENV reference/u);
    await assert.rejects(() => decryptWebhookSecret(`${REFERENCE_PREFIX}${CREDENTIAL_PREFIX}${'e'.repeat(64)}:suffix`), /Invalid webhook secret ENV reference/u);

    const tombstoneCipher = encryptedFixture('deleted-secret-fixture', MASTER_KEY);
    const tombstoneKey = credentialKey(tombstoneCipher);
    await mutateUnifiedSecretValue(tombstoneKey, async () => null, SYSTEM_SCOPE);
    await assert.rejects(() => decryptWebhookSecret(`${REFERENCE_PREFIX}${tombstoneKey}`), /unavailable/u, 'credential tombstones fail closed');

    const configuredMaster = process.env.INTEGRATIONS_ENV_MASTER_KEY;
    process.env.INTEGRATIONS_ENV_MASTER_KEY = 'wrong-composio-webhook-master-fixture';
    await assert.rejects(() => decryptWebhookSecret(reference), (error: unknown) => error instanceof Error, 'an incorrect inner encryption key cannot decrypt the stored record');
    process.env.INTEGRATIONS_ENV_MASTER_KEY = configuredMaster;
    assert.equal(await decryptWebhookSecret(reference), plaintextFixture);

    await mutateUnifiedSecretValue('COMPOSIO_WEBHOOK_SECRET_ENCRYPTION_KEY', async () => 'enc:v1:malformed-fixture', SYSTEM_SCOPE);
    delete process.env.INTEGRATIONS_ENV_MASTER_KEY;
    await assert.rejects(() => decryptWebhookSecret(reference), /encryption key is malformed/u, 'a malformed persisted fallback key must fail closed');
    assert.equal(readUnifiedSecretValue('COMPOSIO_WEBHOOK_SECRET_ENCRYPTION_KEY', SYSTEM_SCOPE), 'enc:v1:malformed-fixture', 'a malformed fallback is preserved for repair rather than replaced');
    process.env.INTEGRATIONS_ENV_MASTER_KEY = configuredMaster;

    const legacyPlaintext = 'legacy-plaintext-webhook-fixture';
    const legacyPlaintextKeyValue = legacyPlaintextKey(legacyPlaintext);
    assert.equal(await decryptWebhookSecret(legacyPlaintext), legacyPlaintext, 'legacy plaintext is imported and resolved from canonical ENV');
    const legacyPlaintextRecord = readUnifiedSecretValue(legacyPlaintextKeyValue, SYSTEM_SCOPE);
    assert.ok(legacyPlaintextRecord);
    const legacyPlaintextStored = JSON.parse(legacyPlaintextRecord) as { version?: unknown; encrypted?: unknown };
    assert.equal(legacyPlaintextStored.version, 1);
    assert.match(legacyPlaintextStored.encrypted as string, /^enc:v1:/u);
    assert.equal(legacyPlaintextRecord.includes(legacyPlaintext), false, 'canonical plaintext migration stores only ciphertext');
    const legacyPlaintextRevision = (await readUnifiedEnvState(SYSTEM_SCOPE)).revision;
    assert.equal(await decryptWebhookSecret(legacyPlaintext), legacyPlaintext);
    assert.equal((await readUnifiedEnvState(SYSTEM_SCOPE)).revision, legacyPlaintextRevision, 'plaintext migration is a stable read after first import');

    const canonicalReplacement = encryptedFixture('canonical-plaintext-winner-fixture', MASTER_KEY);
    const canonicalReplacementRecord = JSON.stringify({ version: 1, encrypted: canonicalReplacement });
    await mutateUnifiedSecretValue(legacyPlaintextKeyValue, async () => canonicalReplacementRecord, SYSTEM_SCOPE);
    assert.equal(await decryptWebhookSecret(legacyPlaintext), 'canonical-plaintext-winner-fixture', 'canonical record wins over replayed legacy plaintext');
    assert.equal(readUnifiedSecretValue(legacyPlaintextKeyValue, SYSTEM_SCOPE), canonicalReplacementRecord);

    const deletedLegacyPlaintext = 'deleted-legacy-webhook-fixture';
    const deletedLegacyKey = legacyPlaintextKey(deletedLegacyPlaintext);
    await mutateUnifiedSecretValue(deletedLegacyKey, async () => null, SYSTEM_SCOPE);
    await assert.rejects(() => decryptWebhookSecret(deletedLegacyPlaintext), /unavailable/u, 'a tombstone blocks legacy plaintext replay');

    console.log('secret-composio-webhook-store-test: ok');
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in environmentBefore)) delete process.env[key];
    Object.assign(process.env, environmentBefore);
  }
}

main().catch(error => { console.error(error); process.exit(1); });
