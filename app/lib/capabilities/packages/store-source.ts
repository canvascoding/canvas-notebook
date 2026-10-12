import 'server-only';
import type { CapabilityPackageValidation } from './contracts';
import { CapabilityPackageError } from './contracts';
import { readExactPackageInventory } from './io';
import { isIssuedCapabilityStoreOrigin, normalizeCapabilityStoreOrigin, type CapabilityStoreOrigin } from './store-origin';
import { capabilityPackageStoreSelectionSchema, type CapabilityPackageStoreSelection } from './store-contracts';

/** Server-issued prepared bytes. Serializing this value intentionally destroys its authority. */
export type PreparedCapabilityStorePackage = Readonly<CapabilityPackageStoreSelection & { resourceId: string; baselineChecksum: string }>;
export type PreparedCapabilityStorePackageInput = {
  kind: 'plugin' | 'skill'; resourceId: string; registryId: string; registryIdentity: string;
  entryKey: string; version: string; upstreamChecksum: string; baselineChecksum: string;
  packageRoot: string; storeOrigin: CapabilityStoreOrigin; validation: CapabilityPackageValidation;
  verifyCurrent: (database?: import('@/app/lib/db').SqlConnection) => Promise<void>; cleanup: () => Promise<void>;
};
type PrivateSource = Readonly<PreparedCapabilityStorePackageInput> & { disposed: boolean };
type Receipts = { sources: WeakMap<object, PrivateSource> };
const key = Symbol.for('canvas.capability.prepared-store-package.v1');
const global = globalThis as typeof globalThis & { [key]?: Receipts };
const receipts = global[key] ??= { sources: new WeakMap() };
const denied = () => new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'A verified Store package is required.', 403);

/** Only configured-Store preparation services may issue this receipt, after validating the complete import. */
export function issuePreparedCapabilityStorePackage(input: PreparedCapabilityStorePackageInput): PreparedCapabilityStorePackage {
  const selection = capabilityPackageStoreSelectionSchema.parse({ kind: input.kind, registryId: input.registryId,
    entryKey: input.entryKey, version: input.version, checksum: input.upstreamChecksum });
  const origin = normalizeCapabilityStoreOrigin(input.storeOrigin, input.resourceId);
  if (!isIssuedCapabilityStoreOrigin(input.storeOrigin, input.resourceId) || !origin || origin.relation !== 'installed'
    || origin.componentPath !== undefined || origin.kind !== selection.kind || origin.entryKey !== selection.entryKey
    || origin.registryId !== selection.registryId || origin.registryIdentity !== input.registryIdentity
    || origin.version !== selection.version || origin.upstreamChecksum !== selection.checksum
    || origin.baselineChecksum !== input.baselineChecksum || !input.validation.valid
    || input.validation.name !== selection.entryKey || input.validation.kind !== selection.kind
    || input.validation.version !== selection.version || input.validation.checksum !== input.baselineChecksum
    || typeof input.verifyCurrent !== 'function' || typeof input.cleanup !== 'function') throw denied();
  const receipt = Object.freeze({ ...selection, resourceId: input.resourceId, baselineChecksum: input.baselineChecksum });
  receipts.sources.set(receipt, { ...input, validation: structuredClone(input.validation), disposed: false });
  return receipt;
}

export function getPreparedCapabilityStorePackage(receipt: PreparedCapabilityStorePackage): Readonly<PreparedCapabilityStorePackageInput> {
  const source = receipts.sources.get(receipt);
  if (!source || source.disposed) throw denied();
  return { ...source, validation: structuredClone(source.validation) };
}

export async function assertPreparedCapabilityStorePackage(receipt: PreparedCapabilityStorePackage,
  expected: CapabilityPackageStoreSelection & { resourceId: string },
  options: { database?: import('@/app/lib/db').SqlConnection } = {}): Promise<void> {
  const source = getPreparedCapabilityStorePackage(receipt);
  if (['kind', 'registryId', 'entryKey', 'version', 'checksum', 'resourceId'].some(field =>
    receipt[field as keyof PreparedCapabilityStorePackage] !== expected[field as keyof typeof expected])) throw denied();
  await source.verifyCurrent(options.database);
  const inventory = await readExactPackageInventory(source.packageRoot);
  if (inventory.checksum !== source.baselineChecksum) {
    throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The prepared Store package changed.', 409);
  }
}

export async function disposePreparedCapabilityStorePackage(receipt: PreparedCapabilityStorePackage): Promise<void> {
  const source = receipts.sources.get(receipt);
  if (!source || source.disposed) return;
  source.disposed = true;
  await source.cleanup();
}
