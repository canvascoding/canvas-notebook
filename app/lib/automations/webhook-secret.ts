import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';

export function generateAutomationWebhookSecret(): {
  secret: string;
  secretHash: string;
  secretPreview: string;
} {
  const secret = `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    secret,
    secretHash: hashAutomationWebhookSecret(secret),
    secretPreview: previewAutomationWebhookSecret(secret),
  };
}

export function hashAutomationWebhookSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function previewAutomationWebhookSecret(secret: string): string {
  const normalized = secret.trim();
  if (normalized.length <= 14) return normalized;
  return `${normalized.slice(0, 10)}...${normalized.slice(-4)}`;
}

export function verifyAutomationWebhookSecret(secret: string, expectedHash: string): boolean {
  const normalized = secret.trim();
  if (!normalized || !expectedHash) return false;

  const actual = Buffer.from(hashAutomationWebhookSecret(normalized), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
