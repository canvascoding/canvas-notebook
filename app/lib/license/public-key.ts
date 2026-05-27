import 'server-only';

import crypto from 'crypto';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/app/lib/db';
import { licensePublicKeys } from '@/app/lib/db/schema';
import { getControlPlaneLicenseBaseUrl } from './instance';

const CACHE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;
const CONTROL_PLANE_TIMEOUT_MS = 5000;
const LICENSE_KEY_ALG = 'RS256';

const BUNDLED_PUBLIC_KEYS: string[] = [];
const BUNDLED_TRUSTED_FINGERPRINTS: string[] = [];
const LOG_PREFIX = '[license/public-key]';

export type LicensePublicKeySource = 'env' | 'bundled' | 'control_plane' | 'sqlite' | 'none';
export type LicensePublicKeyError = 'unreachable' | 'invalid_response' | 'untrusted_key' | 'db_error';

export interface LicensePublicKey {
  publicKey: string;
  fingerprint: string;
  kid?: string;
  alg: 'RS256';
}

export interface LicensePublicKeyResolution {
  keys: LicensePublicKey[];
  source: LicensePublicKeySource;
  error?: LicensePublicKeyError;
}

let positiveMemoryCache: { resolution: LicensePublicKeyResolution; expiresAt: number } | null = null;
let negativeMemoryCache: { resolution: LicensePublicKeyResolution; expiresAt: number } | null = null;

function normalizePem(value: string): string {
  return value.trim().replace(/\\n/g, '\n');
}

function fingerprintPublicKey(publicKey: string): string | null {
  try {
    const key = crypto.createPublicKey(normalizePem(publicKey));
    const der = key.export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex');
  } catch {
    return null;
  }
}

function toLicensePublicKey(publicKey: string, kid?: string): LicensePublicKey | null {
  const normalized = normalizePem(publicKey);
  const fingerprint = fingerprintPublicKey(normalized);
  if (!fingerprint) return null;
  return {
    publicKey: normalized,
    fingerprint,
    kid: kid || fingerprint.slice(0, 16),
    alg: LICENSE_KEY_ALG,
  };
}

function parseKeyConfig(configured: string): string[] {
  const normalized = configured.trim();
  if (!normalized) return [];

  try {
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    if (decoded.includes('BEGIN PUBLIC KEY')) return [decoded];
  } catch {
  }

  if (normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      }
    } catch {
    }
  }

  return [normalized];
}

function parseFingerprintConfig(configured?: string): string[] {
  const normalized = configured?.trim();
  if (!normalized) return [];

  if (normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim().toLowerCase());
      }
    } catch {
    }
  }

  return normalized.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function resolveFromEnv(): LicensePublicKey[] {
  const configured = process.env.CANVAS_LICENSE_PUBLIC_KEY?.trim();
  if (!configured) return [];
  return parseKeyConfig(configured)
    .map((key) => toLicensePublicKey(key))
    .filter((key): key is LicensePublicKey => Boolean(key));
}

function resolveBundled(): LicensePublicKey[] {
  return BUNDLED_PUBLIC_KEYS
    .map((key) => toLicensePublicKey(key))
    .filter((key): key is LicensePublicKey => Boolean(key));
}

function trustedFingerprintSet(): Set<string> {
  const fingerprints = [
    ...BUNDLED_TRUSTED_FINGERPRINTS,
    ...parseFingerprintConfig(process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS),
  ];
  return new Set(fingerprints.map((entry) => entry.toLowerCase()).filter(Boolean));
}

function isTrustedFetchedKey(key: LicensePublicKey): boolean {
  const trusted = trustedFingerprintSet();
  return trusted.size === 0 || trusted.has(key.fingerprint.toLowerCase());
}

function cacheNegativeResolution(resolution: LicensePublicKeyResolution) {
  negativeMemoryCache = { resolution, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS };
}

async function resolveFromControlPlane(): Promise<LicensePublicKeyResolution> {
  const cachedFailure = negativeMemoryCache;
  if (cachedFailure && Date.now() < cachedFailure.expiresAt) {
    return cachedFailure.resolution;
  }

  try {
    const response = await fetch(`${getControlPlaneLicenseBaseUrl()}/v1/license/public-key`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const resolution: LicensePublicKeyResolution = {
        keys: [],
        source: 'none',
        error: response.status === 404 ? 'invalid_response' : 'unreachable',
      };
      console.warn(`${LOG_PREFIX} control plane public key request failed`, {
        status: response.status,
        error: resolution.error,
      });
      cacheNegativeResolution(resolution);
      return resolution;
    }

    const data = await response.json().catch(() => null) as {
      publicKey?: unknown;
      alg?: unknown;
      kid?: unknown;
      fingerprint?: unknown;
    } | null;

    if (!data || typeof data.publicKey !== 'string' || data.alg !== LICENSE_KEY_ALG) {
      const resolution: LicensePublicKeyResolution = { keys: [], source: 'none', error: 'invalid_response' };
      console.warn(`${LOG_PREFIX} invalid control plane public key response`);
      cacheNegativeResolution(resolution);
      return resolution;
    }

    const key = toLicensePublicKey(data.publicKey, typeof data.kid === 'string' ? data.kid : undefined);
    if (!key || (typeof data.fingerprint === 'string' && data.fingerprint.toLowerCase() !== key.fingerprint)) {
      const resolution: LicensePublicKeyResolution = { keys: [], source: 'none', error: 'invalid_response' };
      console.warn(`${LOG_PREFIX} invalid control plane public key material`);
      cacheNegativeResolution(resolution);
      return resolution;
    }

    if (!isTrustedFetchedKey(key)) {
      const resolution: LicensePublicKeyResolution = { keys: [], source: 'none', error: 'untrusted_key' };
      console.warn(`${LOG_PREFIX} rejected untrusted control plane public key`, {
        kid: key.kid,
        fingerprint: key.fingerprint,
      });
      cacheNegativeResolution(resolution);
      return resolution;
    }

    await persistToSQLite(key).catch((error) => {
      console.warn(`${LOG_PREFIX} failed to persist public key cache`, {
        kid: key.kid,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    console.info(`${LOG_PREFIX} resolved from control plane`, { kid: key.kid });
    return { keys: [key], source: 'control_plane' };
  } catch {
    const resolution: LicensePublicKeyResolution = { keys: [], source: 'none', error: 'unreachable' };
    console.warn(`${LOG_PREFIX} control plane public key request unreachable`);
    cacheNegativeResolution(resolution);
    return resolution;
  }
}

async function resolveFromSQLite(): Promise<LicensePublicKeyResolution> {
  try {
    const [row] = await db
      .select({
        publicKey: licensePublicKeys.publicKey,
        fingerprint: licensePublicKeys.fingerprint,
        kid: licensePublicKeys.kid,
      })
      .from(licensePublicKeys)
      .orderBy(desc(licensePublicKeys.fetchedAt))
      .limit(1);

    if (!row) {
      console.warn(`${LOG_PREFIX} no cached public key available`);
      return { keys: [], source: 'none' };
    }
    const key = toLicensePublicKey(row.publicKey, row.kid || undefined);
    if (!key || key.fingerprint !== row.fingerprint || !isTrustedFetchedKey(key)) {
      console.warn(`${LOG_PREFIX} rejected cached public key`, {
        kid: row.kid,
        error: key ? 'untrusted_key' : 'invalid_response',
      });
      return { keys: [], source: 'none', error: key ? 'untrusted_key' : 'invalid_response' };
    }

    await db
      .update(licensePublicKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(licensePublicKeys.fingerprint, key.fingerprint));

    console.info(`${LOG_PREFIX} resolved from sqlite cache`, { kid: key.kid });
    return { keys: [key], source: 'sqlite' };
  } catch {
    console.warn(`${LOG_PREFIX} sqlite public key lookup failed`);
    return { keys: [], source: 'none', error: 'db_error' };
  }
}

async function persistToSQLite(key: LicensePublicKey): Promise<void> {
  const now = new Date();
  await db
    .insert(licensePublicKeys)
    .values({
      kid: key.kid ?? null,
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
      source: 'control_plane',
      fetchedAt: now,
      lastUsedAt: now,
    })
    .onConflictDoUpdate({
      target: licensePublicKeys.fingerprint,
      set: {
        kid: key.kid ?? null,
        publicKey: key.publicKey,
        fetchedAt: now,
        lastUsedAt: now,
      },
    });
}

export async function resolveLicensePublicKeys(): Promise<LicensePublicKeyResolution> {
  const envKeys = resolveFromEnv();
  if (envKeys.length > 0) return { keys: envKeys, source: 'env' };

  const bundledKeys = resolveBundled();
  if (bundledKeys.length > 0) return { keys: bundledKeys, source: 'bundled' };

  if (positiveMemoryCache && Date.now() < positiveMemoryCache.expiresAt) {
    return positiveMemoryCache.resolution;
  }

  const controlPlane = await resolveFromControlPlane();
  if (controlPlane.keys.length > 0) {
    positiveMemoryCache = { resolution: controlPlane, expiresAt: Date.now() + CACHE_TTL_MS };
    negativeMemoryCache = null;
    return controlPlane;
  }

  const sqlite = await resolveFromSQLite();
  if (sqlite.keys.length > 0) {
    const resolution = controlPlane.error ? { ...sqlite, error: controlPlane.error } : sqlite;
    positiveMemoryCache = { resolution, expiresAt: Date.now() + CACHE_TTL_MS };
    return resolution;
  }

  return controlPlane.error ? controlPlane : sqlite;
}
