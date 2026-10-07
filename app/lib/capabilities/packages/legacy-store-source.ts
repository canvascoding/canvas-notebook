import 'server-only';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SqlConnection } from '@/app/lib/db';
import type { CapabilityResourceActor, CapabilityResourceStorageBinding } from '../resources/contracts';
import { withAuthorizedCapabilityPackageResource } from '../resources/store';
import { assertCapabilityPackageArtifactCurrent, resolveCapabilityPackageArtifact, validateCapabilityPackage } from './artifacts';
import { CAPABILITY_PACKAGE_LIMITS, CapabilityPackageError, type AuthorizedCapabilityPackageResource, type CapabilityPackageSourceStamp,
  type CapabilityPackageValidation } from './contracts';
import { copyCapabilityPackageSourceWithReferences, readExactPackageInventory } from './io';
import { assertPreparedStoreSeedSource, prepareStoreSeedSource, type PreparedStoreSeedSource } from '@/app/lib/plugins/store-seed-source';

export type PreparedLegacyCapabilityStoreHistory = Readonly<{ version: string; checksum: string }>;
type Source = { actor: CapabilityResourceActor; storage: CapabilityResourceStorageBinding; originalRoot: string;
  originalStamp: CapabilityPackageSourceStamp; rootPath: string; validation: CapabilityPackageValidation;
  dependencies: PreparedStoreSeedSource[]; cleanup: () => Promise<void>; disposed: boolean };
const key = Symbol.for('canvas.capability.legacy-store-history.v1');
const global = globalThis as typeof globalThis & { [key]?: WeakMap<object, Source> };
const sources = global[key] ??= new WeakMap<object, Source>();
const changed = () => new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The legacy package changed before update.', 409);
const denied = () => new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'A verified legacy package history is required.', 403);
function sameStorage(left: CapabilityResourceStorageBinding, right: CapabilityResourceStorageBinding): boolean {
  return ['resourceType', 'resourceId', 'scopeType', 'name', 'sourceType', 'organizationId', 'ownerUserId', 'sourcePluginId']
    .every(field => left[field as keyof CapabilityResourceStorageBinding] === right[field as keyof CapabilityResourceStorageBinding]);
}

/** Resolve the original source again; caller-provided paths, ownership and buffers never authorize capture. */
export async function prepareLegacyCapabilityStoreHistory(actorInput: CapabilityResourceActor, reference: string,
  expected: { storage: CapabilityResourceStorageBinding; stamp: CapabilityPackageSourceStamp }): Promise<PreparedLegacyCapabilityStoreHistory> {
  const actor = Object.freeze({ ...actorInput }), source = await resolveCapabilityPackageArtifact(actor, reference);
  if (source.readOnly || !sameStorage(source.storage, expected.storage)
    || source.sourceStamp.checksum !== expected.stamp.checksum || source.sourceStamp.version !== expected.stamp.version) throw changed();
  const dependencies: PreparedStoreSeedSource[] = [];
  for (const reference of source.bundledReferences ?? []) {
    const dependency = await prepareStoreSeedSource(actor, reference.source.name,
      { maxFiles: CAPABILITY_PACKAGE_LIMITS.maxFiles, maxTotalBytes: CAPABILITY_PACKAGE_LIMITS.maxTotalBytes });
    if (dependency.checksum !== reference.checksum) throw changed();
    dependencies.push(dependency);
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-legacy-store-history-'));
  const observed = await fs.lstat(temporary, { bigint: true }), rootPath = path.join(temporary, source.storage.name);
  const cleanup = async () => {
    const current = await fs.lstat(temporary, { bigint: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;
    });
    if (!current) return;
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== observed.dev || current.ino !== observed.ino) throw changed();
    await fs.rm(temporary, { recursive: true });
  };
  try {
    await withAuthorizedCapabilityPackageResource(actor, source.storage, 'read', {
      expectedMetadataRevision: source.descriptor.metadata.metadataRevision, expectedGrantsRevision: source.descriptor.metadata.grantsRevision,
    }, async (_authorization, database) => {
      for (const dependency of dependencies) await assertPreparedStoreSeedSource(dependency, database);
      await copyCapabilityPackageSourceWithReferences(source.location, rootPath,
        { expectedSourceChecksum: source.sourceStamp.checksum, bundledReferences: source.bundledReferences });
    });
    const validation = await validateCapabilityPackage(source.storage.resourceType, rootPath,
      { name: source.storage.name, version: source.sourceStamp.version });
    if (!validation.valid || !validation.checksum) throw new CapabilityPackageError('PACKAGE_INVALID', 'The legacy package cannot be preserved as an immutable version.', 400);
    await assertCapabilityPackageArtifactCurrent(actor, source);
    const receipt = Object.freeze({ version: source.sourceStamp.version, checksum: validation.checksum });
    sources.set(receipt, { actor, storage: Object.freeze({ ...source.storage }), originalRoot: source.location.rootPath,
      originalStamp: structuredClone(source.sourceStamp), rootPath, validation: structuredClone(validation), dependencies, cleanup, disposed: false });
    return receipt;
  } catch (error) { await cleanup(); throw error; }
}

export async function readHeldLegacyCapabilityStoreHistory(receipt: PreparedLegacyCapabilityStoreHistory,
  authorization: AuthorizedCapabilityPackageResource, database: SqlConnection,
): Promise<{ rootPath: string; checksum: string; validation: CapabilityPackageValidation; stamp: CapabilityPackageSourceStamp }> {
  const source = sources.get(receipt);
  const { isHeldCapabilityPackageResource } = await import('../resources/store');
  if (!source || source.disposed || !isHeldCapabilityPackageResource(authorization, database)
    || authorization.actor.userId !== source.actor.userId || (authorization.actor.workspaceId ?? null) !== (source.actor.workspaceId ?? null)
    || !sameStorage(authorization.record.storage, source.storage)) throw denied();
  if ((await readExactPackageInventory(source.originalRoot)).checksum !== source.originalStamp.checksum) throw changed();
  for (const dependency of source.dependencies) await assertPreparedStoreSeedSource(dependency, database);
  if ((await readExactPackageInventory(source.rootPath)).checksum !== receipt.checksum) throw changed();
  return { rootPath: source.rootPath, checksum: receipt.checksum, validation: structuredClone(source.validation), stamp: structuredClone(source.originalStamp) };
}

export async function disposeLegacyCapabilityStoreHistory(receipt: PreparedLegacyCapabilityStoreHistory): Promise<void> {
  const source = sources.get(receipt);
  if (!source || source.disposed) return;
  source.disposed = true;
  await source.cleanup();
}
