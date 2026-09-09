import type { PublicShareSecurityMode } from './public-share-security';

/** Omitted fields preserve existing settings; explicit null removes expiry. */
export function parsePublicSharePolicy(body: Record<string, unknown>): {
  expiresAt?: Date | null;
  securityMode?: PublicShareSecurityMode;
  reason?: string | null;
} {
  const result: ReturnType<typeof parsePublicSharePolicy> = {};
  if ('expiresAt' in body && 'expiresInDays' in body) throw new Error('Specify one expiry format.');
  if ('expiresAt' in body) {
    if (body.expiresAt === null || body.expiresAt === 'never') result.expiresAt = null;
    else {
      if (typeof body.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(body.expiresAt)) {
        throw new Error('Expiry must be an ISO date or null.');
      }
      const date = new Date(body.expiresAt);
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error('Expiry must be a future date.');
      result.expiresAt = date;
    }
  }
  if ('expiresInDays' in body) {
    const raw = body.expiresInDays;
    const days = raw === null ? 0 : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > 365) {
      throw new Error('Expiry days must be an integer between 0 and 365.');
    }
    result.expiresAt = days === 0 ? null : new Date(Date.now() + days * 86_400_000);
  }
  if ('securityMode' in body) {
    if (body.securityMode !== 'strict' && body.securityMode !== 'interactive') throw new Error('Invalid security mode.');
    result.securityMode = body.securityMode;
  }
  if ('reason' in body) {
    if (body.reason !== null && typeof body.reason !== 'string') throw new Error('Reason must be text or null.');
    result.reason = body.reason;
  }
  return result;
}

export function requirePublicShareBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A JSON object is required.');
  return value as Record<string, unknown>;
}
