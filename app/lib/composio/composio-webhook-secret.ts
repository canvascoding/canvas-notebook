import 'server-only';

import crypto from 'crypto';

const ENCRYPTED_PREFIX = 'enc:v1';
const MASTER_KEY_ENV = 'INTEGRATIONS_ENV_MASTER_KEY';

function getMasterSecret(): string {
  const value = process.env[MASTER_KEY_ENV]?.trim();
  if (!value) throw new Error('INTEGRATIONS_ENV_MASTER_KEY is required for webhook secret encryption');
  return value;
}

function deriveEncryptionKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptWebhookSecret(plainText: string): string {
  const secret = getMasterSecret();
  const iv = crypto.randomBytes(12);
  const key = deriveEncryptionKey(secret);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptWebhookSecret(encrypted: string): string {
  if (!encrypted.startsWith(`${ENCRYPTED_PREFIX}:`)) return encrypted;
  const parts = encrypted.split(':');
  if (parts.length !== 5) throw new Error('Invalid encrypted webhook secret format');
  const [, version, ivHex, tagHex, encryptedHex] = parts;
  if (version !== 'v1') throw new Error(`Unsupported encrypted webhook secret version: ${version}`);
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encryptedBuf = Buffer.from(encryptedHex, 'hex');
  const secret = getMasterSecret();
  const key = deriveEncryptionKey(secret);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
  return plain.toString('utf8');
}

export function previewWebhookSecret(secret: string): string {
  if (secret.length <= 4) return '****';
  return `****${secret.slice(-4)}`;
}