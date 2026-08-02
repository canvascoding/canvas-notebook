import 'server-only';

import crypto from 'crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import { redactTeamControlPlaneLogText } from '@/app/lib/control-plane/team-client';
import { db } from '@/app/lib/db';
import { licensePublicKeys } from '@/app/lib/db/schema';
import { getControlPlaneLicenseBaseUrl } from './instance';
import { logLicenseInfoThrottled } from './logging';

const CACHE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;
const CONTROL_PLANE_TIMEOUT_MS = 5000;
const LICENSE_KEY_ALG = 'RS256';

const BUNDLED_PUBLIC_KEYS: string[] = [];
const BUNDLED_TRUSTED_FINGERPRINTS: string[] = [
  '5cdaa9e29bb12ad9061c672b5aa547ad777d8095ceb2bd9705c9207e0b2e7133',
];
const LOG_PREFIX = '[license/public-key]';

export type LicensePublicKeySource = 'env' | 'bundled' | 'control_plane' | 'sqlite' | 'none';
export type LicensePublicKeyError = 'unreachable' | 'invalid_response' | 'untrusted_key' | 'db_error';
export type LicensePublicKeySet = 'production' | 'test';

export interface LicensePublicKey {
  publicKey: string;
  fingerprint: string;
  kid?: string;
  alg: 'RS256';
}

export interface LicensePublicKeyResolution {
  keys: LicensePublicKey[];
  source: LicensePublicKeySource;
  keyset: LicensePublicKeySet;
  error?: LicensePublicKeyError;
}

type LicensePublicKeyCache = Partial<Record<
  LicensePublicKeySet,
  { resolution: LicensePublicKeyResolution; expiresAt: number }
>>;

const positiveMemoryCache: LicensePublicKeyCache = {};
const negativeMemoryCache: LicensePublicKeyCache = {};

function getControlPlaneHost(): string {
  try {
    return new URL(getControlPlaneLicenseBaseUrl()).host;
  } catch {
    return 'invalid_control_plane_url';
  }
}

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

function toLicensePublicKey(
  publicKey: string,
  kid?: string,
  keyset: LicensePublicKeySet = 'production',
): LicensePublicKey | null {
  const normalized = normalizePem(publicKey);
  const fingerprint = fingerprintPublicKey(normalized);
  if (!fingerprint) return null;
  return {
    publicKey: normalized,
    fingerprint,
    kid: kid || (
      keyset === 'test'
        ? `test-${fingerprint.slice(0, 16)}`
        : fingerprint.slice(0, 16)
    ),
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

function publicKeyEnvironmentName(keyset: LicensePublicKeySet): string {
  return keyset === 'test'
    ? 'CANVAS_LICENSE_TEST_PUBLIC_KEY'
    : 'CANVAS_LICENSE_PUBLIC_KEY';
}

function trustedFingerprintEnvironmentName(keyset: LicensePublicKeySet): string {
  return keyset === 'test'
    ? 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS'
    : 'CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS';
}

function resolveFromEnv(keyset: LicensePublicKeySet): LicensePublicKeyResolution | null {
  const configured = process.env[publicKeyEnvironmentName(keyset)]?.trim();
  if (!configured) return null;
  const keys = parseKeyConfig(configured)
    .map((key) => toLicensePublicKey(key, undefined, keyset))
    .filter((key): key is LicensePublicKey => Boolean(
      key && isTrustedConfiguredKey(key, keyset),
    ));
  if (keys.length > 0) return { keys, source: 'env', keyset };
  console.warn(`${LOG_PREFIX} rejected untrusted env public key`, { keyset });
  return { keys: [], source: 'none', keyset, error: 'untrusted_key' };
}

function resolveBundled(keyset: LicensePublicKeySet): LicensePublicKey[] {
  if (keyset === 'test') return [];
  return BUNDLED_PUBLIC_KEYS
    .map((key) => toLicensePublicKey(key))
    .filter((key): key is LicensePublicKey => Boolean(
      key && isTrustedConfiguredKey(key, keyset),
    ));
}

function trustedFingerprintSet(keyset: LicensePublicKeySet): Set<string> {
  const fingerprints = keyset === 'production'
    ? [
        ...BUNDLED_TRUSTED_FINGERPRINTS,
        ...parseFingerprintConfig(
          process.env[trustedFingerprintEnvironmentName(keyset)],
        ),
      ]
    : parseFingerprintConfig(
        process.env[trustedFingerprintEnvironmentName(keyset)],
      );
  return new Set(fingerprints.map((entry) => entry.toLowerCase()).filter(Boolean));
}

function isKeysetIsolated(
  key: LicensePublicKey,
  keyset: LicensePublicKeySet,
): boolean {
  const otherKeyset = keyset === 'production' ? 'test' : 'production';
  return !trustedFingerprintSet(otherKeyset).has(key.fingerprint.toLowerCase());
}

function isTrustedFetchedKey(
  key: LicensePublicKey,
  keyset: LicensePublicKeySet,
): boolean {
  const trusted = trustedFingerprintSet(keyset);
  return trusted.has(key.fingerprint.toLowerCase())
    && isKeysetIsolated(key, keyset);
}

function isTrustedConfiguredKey(
  key: LicensePublicKey,
  keyset: LicensePublicKeySet,
): boolean {
  const trusted = trustedFingerprintSet(keyset);
  return trusted.has(key.fingerprint.toLowerCase())
    && isKeysetIsolated(key, keyset);
}

function cacheNegativeResolution(resolution: LicensePublicKeyResolution) {
  negativeMemoryCache[resolution.keyset] = {
    resolution,
    expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
  };
}

async function resolveFromControlPlane(
  keyset: LicensePublicKeySet,
  forceRefresh: boolean,
): Promise<LicensePublicKeyResolution> {
  const cachedFailure = negativeMemoryCache[keyset];
  if (!forceRefresh && cachedFailure && Date.now() < cachedFailure.expiresAt) {
    return cachedFailure.resolution;
  }

  try {
    const endpoint = keyset === 'test'
      ? '/v1/license/public-key/test'
      : '/v1/license/public-key';
    const response = await fetch(`${getControlPlaneLicenseBaseUrl()}${endpoint}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const resolution: LicensePublicKeyResolution = {
        keys: [],
        source: 'none',
        keyset,
        error: response.status === 404 ? 'invalid_response' : 'unreachable',
      };
      console.warn(`${LOG_PREFIX} control plane public key request failed`, {
        status: response.status,
        error: resolution.error,
        keyset,
        controlPlaneHost: getControlPlaneHost(),
      });
      cacheNegativeResolution(resolution);
      return resolution;
    }

    const data = await response.json().catch(() => null) as {
      publicKey?: unknown;
      alg?: unknown;
      kid?: unknown;
      fingerprint?: unknown;
      audience?: unknown;
      licenseClass?: unknown;
    } | null;

    const testMetadataValid = keyset !== 'test'
      || (
        data?.licenseClass === 'test'
        && typeof data.audience === 'string'
        && data.audience === (
          process.env.CANVAS_LICENSE_TEST_AUDIENCE?.trim()
          || 'canvas-notebook-test'
        )
        && data.audience !== 'canvas-notebook'
      );
    const productionMetadataValid = keyset !== 'production'
      || (
        data?.licenseClass !== 'test'
        && data?.audience !== (
          process.env.CANVAS_LICENSE_TEST_AUDIENCE?.trim()
          || 'canvas-notebook-test'
        )
      );
    const keyMetadataValid = typeof data?.kid === 'string'
      && data.kid.trim().length > 0
      && typeof data.fingerprint === 'string'
      && /^[a-f0-9]{64}$/u.test(data.fingerprint)
      && (
        keyset === 'test'
          ? data.kid.startsWith('test-')
          : !data.kid.startsWith('test-')
      );
    if (
      !data
      || typeof data.publicKey !== 'string'
      || data.alg !== LICENSE_KEY_ALG
      || !testMetadataValid
      || !productionMetadataValid
      || !keyMetadataValid
    ) {
      const resolution: LicensePublicKeyResolution = {
        keys: [],
        source: 'none',
        keyset,
        error: 'invalid_response',
      };
      console.warn(`${LOG_PREFIX} invalid control plane public key response`, {
        keyset,
        controlPlaneHost: getControlPlaneHost(),
      });
      cacheNegativeResolution(resolution);
      return resolution;
    }

    const responseKid = data.kid as string;
    const responseFingerprint = data.fingerprint as string;
    const key = toLicensePublicKey(data.publicKey, responseKid);
    if (!key || responseFingerprint.toLowerCase() !== key.fingerprint) {
      const resolution: LicensePublicKeyResolution = {
        keys: [],
        source: 'none',
        keyset,
        error: 'invalid_response',
      };
      console.warn(`${LOG_PREFIX} invalid control plane public key material`, {
        kid: typeof data.kid === 'string' ? data.kid : undefined,
        keyset,
        controlPlaneHost: getControlPlaneHost(),
      });
      cacheNegativeResolution(resolution);
      return resolution;
    }

    if (!isTrustedFetchedKey(key, keyset)) {
      const resolution: LicensePublicKeyResolution = {
        keys: [],
        source: 'none',
        keyset,
        error: 'untrusted_key',
      };
      console.warn(`${LOG_PREFIX} rejected untrusted control plane public key`, {
        kid: key.kid,
        fingerprint: key.fingerprint,
        keyset,
        controlPlaneHost: getControlPlaneHost(),
      });
      cacheNegativeResolution(resolution);
      return resolution;
    }

    await persistToSQLite(key, keyset).catch((error) => {
      console.warn(`${LOG_PREFIX} failed to persist public key cache`, {
        kid: key.kid,
        keyset,
        error: redactTeamControlPlaneLogText(
          error instanceof Error ? error.message : String(error),
        ),
      });
    });
    logLicenseInfoThrottled(LOG_PREFIX, 'resolved from control plane', {
      kid: key.kid,
      keyset,
    });
    return { keys: [key], source: 'control_plane', keyset };
  } catch (error) {
    const resolution: LicensePublicKeyResolution = {
      keys: [],
      source: 'none',
      keyset,
      error: 'unreachable',
    };
    console.warn(`${LOG_PREFIX} control plane public key request unreachable`, {
      keyset,
      controlPlaneHost: getControlPlaneHost(),
      error: redactTeamControlPlaneLogText(
        error instanceof Error ? error.message : String(error),
      ),
    });
    cacheNegativeResolution(resolution);
    return resolution;
  }
}

function persistedSources(keyset: LicensePublicKeySet): string[] {
  return keyset === 'test'
    ? ['control_plane_test']
    : ['control_plane', 'control_plane_production'];
}

async function resolveFromSQLite(
  keyset: LicensePublicKeySet,
): Promise<LicensePublicKeyResolution> {
  try {
    const rows = await db
      .select({
        publicKey: licensePublicKeys.publicKey,
        fingerprint: licensePublicKeys.fingerprint,
        kid: licensePublicKeys.kid,
      })
      .from(licensePublicKeys)
      .where(inArray(licensePublicKeys.source, persistedSources(keyset)))
      .orderBy(desc(licensePublicKeys.fetchedAt))
      .limit(5);

    if (rows.length === 0) {
      console.warn(`${LOG_PREFIX} no cached public key available`, { keyset });
      return { keys: [], source: 'none', keyset };
    }
    const keys = rows.flatMap((row) => {
      const key = toLicensePublicKey(row.publicKey, row.kid || undefined);
      if (
        !key
        || key.fingerprint !== row.fingerprint
        || !isTrustedFetchedKey(key, keyset)
      ) {
        console.warn(`${LOG_PREFIX} rejected cached public key`, {
          kid: row.kid,
          keyset,
          error: key ? 'untrusted_key' : 'invalid_response',
        });
        return [];
      }
      return [key];
    });
    if (keys.length === 0) {
      return { keys: [], source: 'none', keyset, error: 'untrusted_key' };
    }

    await Promise.all(keys.map((key) => db
        .update(licensePublicKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(licensePublicKeys.fingerprint, key.fingerprint))));

    logLicenseInfoThrottled(LOG_PREFIX, 'resolved from sqlite cache', {
      keyset,
      kids: keys.map((key) => key.kid),
    });
    return { keys, source: 'sqlite', keyset };
  } catch {
    console.warn(`${LOG_PREFIX} sqlite public key lookup failed`, { keyset });
    return { keys: [], source: 'none', keyset, error: 'db_error' };
  }
}

async function persistToSQLite(
  key: LicensePublicKey,
  keyset: LicensePublicKeySet,
): Promise<void> {
  const now = new Date();
  await db
    .insert(licensePublicKeys)
    .values({
      kid: key.kid ?? null,
      publicKey: key.publicKey,
      fingerprint: key.fingerprint,
      source: keyset === 'test'
        ? 'control_plane_test'
        : 'control_plane_production',
      fetchedAt: now,
      lastUsedAt: now,
    })
    .onConflictDoUpdate({
      target: licensePublicKeys.fingerprint,
      set: {
        kid: key.kid ?? null,
        publicKey: key.publicKey,
        source: keyset === 'test'
          ? 'control_plane_test'
          : 'control_plane_production',
        fetchedAt: now,
        lastUsedAt: now,
      },
    });
}

function mergeKeys(
  primary: LicensePublicKey[],
  fallback: LicensePublicKey[],
): LicensePublicKey[] {
  const seen = new Set<string>();
  return [...primary, ...fallback].filter((key) => {
    if (seen.has(key.fingerprint)) return false;
    seen.add(key.fingerprint);
    return true;
  });
}

export async function resolveLicensePublicKeys(
  options: {
    keyset?: LicensePublicKeySet;
    forceRefresh?: boolean;
  } = {},
): Promise<LicensePublicKeyResolution> {
  const keyset = options.keyset ?? 'production';
  const forceRefresh = options.forceRefresh === true;
  const env = resolveFromEnv(keyset);
  if (env) {
    if (env.keys.length === 0) return env;
    logLicenseInfoThrottled(LOG_PREFIX, 'resolved from env', {
      keyset,
      count: env.keys.length,
      kids: env.keys.map((key) => key.kid),
    });
    return env;
  }

  const bundledKeys = resolveBundled(keyset);
  if (bundledKeys.length > 0) {
    logLicenseInfoThrottled(LOG_PREFIX, 'resolved from bundled keys', {
      keyset,
      count: bundledKeys.length,
      kids: bundledKeys.map((key) => key.kid),
    });
    return { keys: bundledKeys, source: 'bundled', keyset };
  }

  const cached = positiveMemoryCache[keyset];
  if (!forceRefresh && cached && Date.now() < cached.expiresAt) {
    logLicenseInfoThrottled(LOG_PREFIX, 'resolved from memory cache', {
      keyset,
      source: cached.resolution.source,
      count: cached.resolution.keys.length,
      kids: cached.resolution.keys.map((key) => key.kid),
    });
    return cached.resolution;
  }

  const controlPlane = await resolveFromControlPlane(keyset, forceRefresh);
  if (controlPlane.keys.length > 0) {
    const sqlite = await resolveFromSQLite(keyset);
    const resolution = {
      ...controlPlane,
      keys: mergeKeys(controlPlane.keys, sqlite.keys),
    };
    positiveMemoryCache[keyset] = {
      resolution,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    delete negativeMemoryCache[keyset];
    return resolution;
  }

  const sqlite = await resolveFromSQLite(keyset);
  if (sqlite.keys.length > 0) {
    const resolution = controlPlane.error ? { ...sqlite, error: controlPlane.error } : sqlite;
    positiveMemoryCache[keyset] = {
      resolution,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    return resolution;
  }

  return controlPlane.error ? controlPlane : sqlite;
}
