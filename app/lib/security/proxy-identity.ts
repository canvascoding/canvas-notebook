import { createHmac, timingSafeEqual } from 'node:crypto';

const PROXY_IDENTITY_PURPOSE = 'canvas-notebook/proxy-client-address/v1';

/** Grants only the right to attest a proxy client address, never internal API access. */
export function deriveProxyIdentityToken(internalApiKey: string | undefined): string | null {
  const key = internalApiKey?.trim();
  return key && key.length >= 32
    ? createHmac('sha256', key).update(PROXY_IDENTITY_PURPOSE).digest('hex')
    : null;
}

export function isTrustedProxyIdentity(provided: string | undefined, internalApiKey: string | undefined): boolean {
  const expected = deriveProxyIdentityToken(internalApiKey);
  if (!expected || !provided || !/^[a-f0-9]{64}$/u.test(provided)) return false;
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}
