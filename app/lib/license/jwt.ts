import 'server-only';

import crypto from 'crypto';
import { resolveLicensePublicKeys } from './public-key';
import type { LicenseCert } from './types';

const LICENSE_ISSUER = 'canvas-control-plane';
const LICENSE_AUDIENCE = 'canvas-notebook';
const MAX_IAT_SKEW_MS = 5 * 60 * 1000;

function base64UrlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
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

export async function verifyLicenseJwt(token: string, expectedInstanceId: string): Promise<LicenseCert | null> {
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
  if (payload.iss !== LICENSE_ISSUER) return null;
  if (payload.aud !== LICENSE_AUDIENCE) return null;
  if (payload.status !== 'active') return null;
  if (payload.iat && payload.iat * 1000 > Date.now() + MAX_IAT_SKEW_MS) return null;
  if (!payload.exp || payload.exp * 1000 <= Date.now()) return null;
  if (!['community', 'pro', 'managed'].includes(payload.plan)) return null;

  const signed = `${encodedHeader}.${encodedPayload}`;
  const signature = base64UrlDecode(encodedSignature);
  const resolution = await resolveLicensePublicKeys();
  for (const publicKey of resolution.keys) {
    try {
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(signed);
      verifier.end();
      if (verifier.verify(publicKey.publicKey, signature)) return payload;
    } catch {
    }
  }

  return null;
}
