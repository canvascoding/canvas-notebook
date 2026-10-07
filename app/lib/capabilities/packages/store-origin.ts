import 'server-only';

import { createHash } from 'node:crypto';

/** Private, server-verified import history. Current package version/digest are independent. */
export type CapabilityStoreOrigin = {
  contractVersion: 1;
  resourceId: string;
  registryId: string;
  /** Includes the complete configured source identity without persisting its credentials. */
  registryIdentity: string;
  kind: 'plugin' | 'skill';
  entryKey: string;
  version: string;
  checksumAlgorithm: 'canvas-package-tree-sha256-v1';
  upstreamChecksum: string;
  baselineChecksum: string | null;
  relation: 'installed' | 'derived';
  verifiedAt: number;
  /** A child is traceable to its parent offering, never a direct standalone offering. */
  componentPath?: string;
};

const digest = /^[a-f0-9]{64}$/u;
const fields = new Set(['contractVersion', 'resourceId', 'registryId', 'registryIdentity', 'kind', 'entryKey', 'version',
  'checksumAlgorithm', 'upstreamChecksum', 'baselineChecksum', 'relation', 'verifiedAt', 'componentPath']);
const issuedKey = Symbol.for('canvas.capability.verified-store-origin.v1');
const runtime = globalThis as typeof globalThis & { [issuedKey]?: WeakSet<object> };
const issued = runtime[issuedKey] ??= new WeakSet<object>();

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

/** Malformed and unbound legacy observations stay unknown; they never become proof. */
export function normalizeCapabilityStoreOrigin(value: unknown, resourceId?: string): CapabilityStoreOrigin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !fields.has(key)) || input.contractVersion !== 1
    || !text(input.resourceId, 2_048) || resourceId !== undefined && input.resourceId !== resourceId
    || !text(input.registryId, 256) || !text(input.registryIdentity, 64) || !digest.test(input.registryIdentity)
    || typeof input.kind !== 'string' || !['plugin', 'skill'].includes(input.kind) || !text(input.entryKey, 200) || !text(input.version, 200)
    || input.checksumAlgorithm !== 'canvas-package-tree-sha256-v1'
    || !text(input.upstreamChecksum, 64) || !digest.test(input.upstreamChecksum)
    || input.baselineChecksum !== null && (!text(input.baselineChecksum, 64) || !digest.test(input.baselineChecksum))
    || typeof input.relation !== 'string' || !['installed', 'derived'].includes(input.relation) || !Number.isSafeInteger(input.verifiedAt) || Number(input.verifiedAt) < 0) return null;
  if (input.componentPath !== undefined && (!text(input.componentPath, 1_024) || String(input.componentPath).includes('\\')
    || String(input.componentPath).split('/').some(segment => !segment || segment === '.' || segment === '..')
    || /^[a-z]:/iu.test(String(input.componentPath)) || String(input.componentPath).split('/').length > 32
    || input.relation !== 'derived')) return null;
  if (input.relation === 'installed' && (input.componentPath !== undefined || input.baselineChecksum === null)) return null;
  return {
    contractVersion: 1, resourceId: input.resourceId, registryId: input.registryId, registryIdentity: input.registryIdentity,
    kind: input.kind as CapabilityStoreOrigin['kind'], entryKey: input.entryKey, version: input.version,
    checksumAlgorithm: 'canvas-package-tree-sha256-v1', upstreamChecksum: input.upstreamChecksum,
    baselineChecksum: input.baselineChecksum as string | null, relation: input.relation as CapabilityStoreOrigin['relation'],
    verifiedAt: Number(input.verifiedAt), ...(input.componentPath === undefined ? {} : { componentPath: String(input.componentPath) }),
  };
}

export function capabilityStoreRegistryIdentity(registryUrl: string): string {
  if (!text(registryUrl, 8_192)) throw new Error('The configured store source is invalid.');
  const url = new URL(registryUrl);
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new Error('The configured store source is invalid.');
  url.hash = '';
  return createHash('sha256').update(JSON.stringify(['canvas-store-registry-v1', url.href])).digest('hex');
}

/** Call only after the configured Store's exact manifest identity/version has been validated. */
export async function issueVerifiedCapabilityStoreOrigin(input: {
  resourceId: string; registryId: string; registryUrl: string; kind: 'plugin' | 'skill'; entryKey: string;
  version: string; upstreamChecksum: string; packageRoot: string;
}): Promise<CapabilityStoreOrigin> {
  const checksum = input.upstreamChecksum.replace(/^sha256:/iu, '').toLowerCase();
  if (!digest.test(checksum)) throw new Error('The store package digest is invalid.');
  const { readExactPackageInventory } = await import('./io');
  const inventory = await readExactPackageInventory(input.packageRoot);
  if (inventory.checksum !== checksum) throw new Error('The complete package does not match the store digest.');
  const origin = normalizeCapabilityStoreOrigin({ contractVersion: 1, resourceId: input.resourceId,
    registryId: input.registryId, registryIdentity: capabilityStoreRegistryIdentity(input.registryUrl), kind: input.kind,
    entryKey: input.entryKey, version: input.version, checksumAlgorithm: 'canvas-package-tree-sha256-v1',
    upstreamChecksum: checksum, baselineChecksum: inventory.checksum, relation: 'installed', verifiedAt: Date.now() });
  if (!origin) throw new Error('The verified store origin is invalid.');
  issued.add(origin);
  return Object.freeze(origin);
}

/** A JSON lookalike from an upload/request is not an import proof. */
export function isIssuedCapabilityStoreOrigin(value: unknown, resourceId: string): boolean {
  return Boolean(value && typeof value === 'object' && issued.has(value) && normalizeCapabilityStoreOrigin(value, resourceId));
}

export function sameCapabilityStoreOrigin(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) return true;
  const a = normalizeCapabilityStoreOrigin(left), b = normalizeCapabilityStoreOrigin(right);
  return Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
}

/** Preserve the original baseline; a renamed fork is derived even if its bytes later match. */
export function deriveCapabilityStoreOrigin(value: unknown, resourceId: string,
  componentPath?: string): CapabilityStoreOrigin | undefined {
  const origin = normalizeCapabilityStoreOrigin(value);
  if (!origin) return undefined;
  const next = normalizeCapabilityStoreOrigin({ ...origin, resourceId, relation: 'derived',
    ...(componentPath === undefined ? {} : { componentPath, baselineChecksum: null }) }, resourceId);
  if (!next) return undefined;
  issued.add(next);
  return Object.freeze(next);
}

/** Unsupported legacy labels are unknown. SemVer build metadata never affects precedence. */
export function compareCapabilityStoreVersions(left: string, right: string): -1 | 0 | 1 | null {
  const parse = (value: string): { core: bigint[]; prerelease: string[] } | null => {
    if (value.length > 200) return null;
    const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
    if (!match) return null;
    const prerelease = match[4]?.split('.') ?? [];
    if (prerelease.some(part => /^[0-9]+$/u.test(part) && part.length > 1 && part.startsWith('0'))) return null;
    return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], prerelease };
  };
  const a = parse(left), b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numericX = /^[0-9]+$/u.test(x), numericY = /^[0-9]+$/u.test(y);
    if (numericX && numericY) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
