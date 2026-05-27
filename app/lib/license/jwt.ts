import 'server-only';

import crypto from 'crypto';
import type { LicenseCert } from './types';

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function resolvePublicKeys(): string[] {
  const configured = process.env.CANVAS_LICENSE_PUBLIC_KEY?.trim();
  if (!configured) return [];

  try {
    const decoded = Buffer.from(configured, 'base64').toString('utf8');
    if (decoded.includes('BEGIN PUBLIC KEY')) return [decoded];
  } catch {
  }

  if (configured.startsWith('[')) {
    try {
      const parsed = JSON.parse(configured);
      if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    } catch {
    }
  }

  return [configured.replace(/\\n/g, '\n')];
}

export function decodeLicenseJwt(token: string): LicenseCert | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as LicenseCert;
  } catch {
    return null;
  }
}

export function verifyLicenseJwt(token: string, expectedInstanceId: string): LicenseCert | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: { alg?: string };
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')) as { alg?: string };
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;

  const payload = decodeLicenseJwt(token);
  if (!payload || payload.sub !== expectedInstanceId) return null;
  if (payload.aud && payload.aud !== 'canvas-notebook') return null;
  if (payload.exp && payload.exp * 1000 <= Date.now()) return null;
  if (!['community', 'pro', 'managed'].includes(payload.plan)) return null;

  const signed = `${encodedHeader}.${encodedPayload}`;
  const signature = base64UrlDecode(encodedSignature);
  for (const publicKey of resolvePublicKeys()) {
    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(signed);
      verifier.end();
      if (verifier.verify(publicKey, signature)) return payload;
    } catch {
    }
  }

  return null;
}
