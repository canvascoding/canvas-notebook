import 'server-only';

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const keyPattern = /^cnk_([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.([A-Za-z0-9_-]{43})$/u;

export function hashApiKeySecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function parseApiKey(value: string): { id: string; secret: string } | null {
  const match = keyPattern.exec(value);
  if (!match || Buffer.from(match[2], 'base64url').toString('base64url') !== match[2]) return null;
  return { id: match[1], secret: match[2] };
}

export function issueApiKeySecret() {
  const id = randomUUID(), secret = randomBytes(32).toString('base64url');
  const prefix = `cnk_${id}`;
  return { id, prefix, secretHash: hashApiKeySecret(secret), key: `${prefix}.${secret}` };
}

export function verifyApiKeySecret(secret: string, expectedHash: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(expectedHash)) return false;
  return timingSafeEqual(Buffer.from(hashApiKeySecret(secret), 'hex'), Buffer.from(expectedHash, 'hex'));
}
