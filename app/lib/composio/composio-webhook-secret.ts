import 'server-only';

import crypto from 'crypto';
import { mutateUnifiedSecretValue, readUnifiedSecretValue } from '../secrets/unified-env-store';

const ENCRYPTED_PREFIX = 'enc:v1';
const MASTER_KEY_ENV = 'INTEGRATIONS_ENV_MASTER_KEY';
const FALLBACK_KEY = 'COMPOSIO_WEBHOOK_SECRET_ENCRYPTION_KEY';
const CREDENTIAL_PREFIX = 'CANVAS_CREDENTIAL_COMPOSIO_WEBHOOK_';
const CREDENTIAL_REFERENCE_PREFIX = 'canvas:env:v1:';
const CREDENTIAL_KEY_PATTERN = /^CANVAS_CREDENTIAL_COMPOSIO_WEBHOOK_[a-f0-9]{64}$/u;
const SYSTEM_SCOPE = { secretScope: 'system' as const };

type StoredWebhookSecret = {
  version: 1;
  encrypted: string;
};

async function getMasterSecret(): Promise<string> {
  const value = process.env[MASTER_KEY_ENV]?.trim();
  if (value) return value;

  const existing = readUnifiedSecretValue(FALLBACK_KEY, SYSTEM_SCOPE)?.trim();
  if (existing === 'null') throw new Error('The webhook secret encryption key was deleted. Restore it before reading webhook secrets.');
  if (existing?.startsWith(`${ENCRYPTED_PREFIX}:`)) throw new Error('The stored webhook secret encryption key is malformed. Restore it before reading webhook secrets.');
  if (existing) return existing;

  const generated = crypto.randomBytes(32).toString('base64url');
  const stored = await mutateUnifiedSecretValue(FALLBACK_KEY, async (current) => {
    const normalized = current?.trim();
    if (normalized === 'null') throw new Error('The webhook secret encryption key was deleted. Restore it before reading webhook secrets.');
    if (normalized?.startsWith(`${ENCRYPTED_PREFIX}:`)) throw new Error('The stored webhook secret encryption key is malformed. Restore it before reading webhook secrets.');
    if (normalized) return normalized;
    return generated;
  }, SYSTEM_SCOPE);
  if (!stored || stored === 'null') throw new Error('Could not load the webhook secret encryption key.');
  return stored;
}

function deriveEncryptionKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptWithMaster(plainText: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveEncryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

async function decryptWithMaster(encrypted: string): Promise<string> {
  const parts = encrypted.split(':');
  if (parts.length !== 5) throw new Error('Invalid encrypted webhook secret format');
  const [, version, ivHex, tagHex, encryptedHex] = parts;
  if (version !== 'v1') throw new Error(`Unsupported encrypted webhook secret version: ${version}`);
  if (!/^(?:[a-f0-9]{24})$/u.test(ivHex) || !/^(?:[a-f0-9]{32})$/u.test(tagHex) || !/^(?:[a-f0-9]{2})*$/u.test(encryptedHex)) {
    throw new Error('Invalid encrypted webhook secret format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encryptedBuf = Buffer.from(encryptedHex, 'hex');
  const secret = await getMasterSecret();
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveEncryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encryptedBuf), decipher.final()]).toString('utf8');
}

function keyForEncryptedValue(encrypted: string): string {
  return `${CREDENTIAL_PREFIX}${crypto.createHash('sha256').update(encrypted, 'utf8').digest('hex')}`;
}

function keyForLegacyPlaintext(plainText: string): string {
  return `${CREDENTIAL_PREFIX}${crypto.createHash('sha256').update(`legacy-plaintext:${plainText}`, 'utf8').digest('hex')}`;
}

function parseReference(value: string): string | null {
  if (!value.startsWith('canvas:env:')) return null;
  if (!value.startsWith(CREDENTIAL_REFERENCE_PREFIX)) throw new Error('Invalid webhook secret ENV reference.');
  const key = value.slice(CREDENTIAL_REFERENCE_PREFIX.length);
  if (!CREDENTIAL_KEY_PATTERN.test(key)) throw new Error('Invalid webhook secret ENV reference.');
  return key;
}

function serializeStoredSecret(encrypted: string): string {
  return JSON.stringify({ version: 1, encrypted } satisfies StoredWebhookSecret);
}

function parseStoredSecret(value: string | null, key: string): StoredWebhookSecret {
  if (!value || value === 'null') throw new Error(`Stored webhook secret is unavailable for ${key}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Stored webhook secret is invalid for ${key}.`);
  }
  if (
    !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).length !== 2
    || (parsed as { version?: unknown }).version !== 1
    || typeof (parsed as { encrypted?: unknown }).encrypted !== 'string'
    || !(parsed as { encrypted: string }).encrypted.startsWith(`${ENCRYPTED_PREFIX}:`)
  ) {
    throw new Error(`Stored webhook secret is invalid for ${key}.`);
  }
  return parsed as StoredWebhookSecret;
}

async function saveEncryptedValue(encrypted: string): Promise<string> {
  const key = keyForEncryptedValue(encrypted);
  const expected = serializeStoredSecret(encrypted);
  const stored = await mutateUnifiedSecretValue(key, async (current) => current ?? expected, SYSTEM_SCOPE);
  const record = parseStoredSecret(stored, key);
  if (record.encrypted !== encrypted) throw new Error(`Stored webhook secret reference collision for ${key}.`);
  return `${CREDENTIAL_REFERENCE_PREFIX}${key}`;
}

async function migrateLegacyEncryptedValue(encrypted: string): Promise<StoredWebhookSecret> {
  const key = keyForEncryptedValue(encrypted);
  const imported = readUnifiedSecretValue(key, SYSTEM_SCOPE);
  if (imported !== null) return parseStoredSecret(imported, key);
  // Validate the database import with the configured original key before
  // writing it into the canonical store.
  await decryptWithMaster(encrypted);
  // The legacy database value is an import source only. The locked ENV record
  // always wins when present, so retries cannot replace a migrated value.
  const stored = await mutateUnifiedSecretValue(key, async (current) => current ?? serializeStoredSecret(encrypted), SYSTEM_SCOPE);
  return parseStoredSecret(stored, key);
}

async function migrateLegacyPlaintextValue(plainText: string): Promise<StoredWebhookSecret> {
  const key = keyForLegacyPlaintext(plainText);
  const stored = await mutateUnifiedSecretValue(key, async (current) => {
    if (current !== null) return current;
    return serializeStoredSecret(encryptWithMaster(plainText, await getMasterSecret()));
  }, SYSTEM_SCOPE);
  return parseStoredSecret(stored, key);
}

export async function encryptWebhookSecret(plainText: string): Promise<string> {
  const encrypted = encryptWithMaster(plainText, await getMasterSecret());
  return saveEncryptedValue(encrypted);
}

export async function decryptWebhookSecret(encrypted: string): Promise<string> {
  const referenceKey = parseReference(encrypted);
  if (referenceKey) {
    const stored = parseStoredSecret(readUnifiedSecretValue(referenceKey, SYSTEM_SCOPE), referenceKey);
    return decryptWithMaster(stored.encrypted);
  }
  if (encrypted.startsWith('canvas:env:')) throw new Error('Invalid webhook secret ENV reference.');
  if (!encrypted.startsWith(`${ENCRYPTED_PREFIX}:`)) {
    const stored = await migrateLegacyPlaintextValue(encrypted);
    return decryptWithMaster(stored.encrypted);
  }

  const stored = await migrateLegacyEncryptedValue(encrypted);
  return decryptWithMaster(stored.encrypted);
}

export function previewWebhookSecret(secret: string): string {
  if (secret.length <= 4) return '****';
  return `****${secret.slice(-4)}`;
}
