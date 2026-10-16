import 'server-only';

import path from 'node:path';
import type { z } from 'zod';
import { createCapabilityResourceId } from '../reference';
import type { CapabilityResourceActor, CapabilityResourceRecord, CapabilityResourceStorageBinding } from '../resources/contracts';
import { findCapabilityResourceRecord, getCapabilityResourceAccess, withAuthorizedCapabilityPackageResource } from '../resources/store';
import { readCanvasPluginRegistry, type CanvasPluginInstallRecord } from '@/app/lib/plugins/canvas-plugin-registry';
import { readCanvasSkillRegistry, type CanvasSkillInstallRecord } from '@/app/lib/skills/canvas-skill-store';
import { capabilityPackageRegistryStorage, assertCapabilityPackageRegistryPointerCurrent } from './artifacts';
import { getCapabilityPackageState } from './store';
import { readExactPackageInventory, type ExactCapabilityPackageInventory } from './io';
import { CapabilityPackageError } from './contracts';
import { capabilityPackageIconQuerySchema } from './presentation-contracts';
import { assertCapturedCapabilityPackageChild, capturedCapabilityPackageIconDeclarations, type CapturedPackageIconSource } from './package-icon-capture';
import { readFirstCapturedCapabilityPackageImage, type CapabilityPackageDeclaredIcon } from './package-icon-image';

type Pointer = CanvasPluginInstallRecord | CanvasSkillInstallRecord;
type Result = { handled: false } | { handled: true; image: CapabilityPackageDeclaredIcon | null };
const changed = () => new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The package image source changed. Select its current version.', 409);
const notFound = () => new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The declared package image was not found.', 404);

/** A public child identity selects a parametrized parent SQL lookup only. The
 * actual stored parent, scope and round-tripped child identity are checked later. */
function childParentReference(reference: string): { parent: string; child: string } | null {
  const match = /^canvas-capability:v1:skill:(user|org):([^:]+):plugin:([^:]+):([^:]+)$/u.exec(reference);
  if (!match) return null;
  try {
    const owner = decodeURIComponent(match[2]), parent = decodeURIComponent(match[3]), child = decodeURIComponent(match[4]);
    const scope = match[1] === 'org' ? { scopeType: 'organization' as const, organizationId: owner } : { scopeType: 'user' as const, ownerUserId: owner };
    if (createCapabilityResourceId({ resourceType: 'skill', sourceType: 'plugin', sourcePluginName: parent, name: child, ...scope }) !== reference) return null;
    return { parent: createCapabilityResourceId({ resourceType: 'plugin', sourceType: 'standalone', name: parent, ...scope }), child };
  } catch { return null; }
}

function pointerObservation(pointer: Pointer): string {
  return JSON.stringify([pointer.name, pointer.resourceId, pointer.scopeType, pointer.organizationId ?? null, pointer.ownerUserId ?? null,
    pointer.revision ?? 1, pointer.version, pointer.checksum, path.resolve(pointer.installDir), pointer.packageManaged,
    pointer.packageResourceRef, pointer.publishedRevisionRef, pointer.storeOrigin ?? null,
    'skills' in pointer ? pointer.skills.map(child => [child.name, path.resolve(child.path), path.resolve(child.directory), child.sourceType]) : pointer.skillPath]);
}

function exactPointer(pointer: Pointer | undefined, record: CapabilityResourceRecord): pointer is Pointer {
  return Boolean(pointer && pointer.packageManaged && pointer.packageResourceRef === record.metadata.resourceRef && pointer.publishedRevisionRef
    && pointer.resourceId === record.storage.resourceId && pointer.name === record.storage.name && pointer.scopeType === record.storage.scopeType
    && (pointer.organizationId ?? null) === record.storage.organizationId && (pointer.ownerUserId ?? null) === record.storage.ownerUserId);
}

function childCapture(parent: ExactCapabilityPackageInventory, relativeRoot: string): ExactCapabilityPackageInventory {
  if (!relativeRoot) return parent;
  const prefix = `${relativeRoot}/`, files = parent.files.filter(file => file.relativePath.startsWith(prefix))
    .map(file => ({ ...file, path: file.relativePath.slice(prefix.length), relativePath: file.relativePath.slice(prefix.length) }));
  return { files, directories: parent.directories.filter(directory => directory.startsWith(prefix)).map(directory => directory.slice(prefix.length)),
    totalBytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0), checksum: parent.checksum };
}

/** Managed snapshots have an exact SQL resource + registry pointer. Their image
 * does not require loading any other installed package or a user-wide catalogue. */
export async function tryReadManagedCapabilityPackageIcon(actor: CapabilityResourceActor, reference: string,
  query: z.infer<typeof capabilityPackageIconQuerySchema>): Promise<Result> {
  let record = await findCapabilityResourceRecord(reference), childName: string | undefined;
  let childRecord: CapabilityResourceRecord | undefined;
  if (record?.storage.sourceType === 'plugin') {
    childRecord = record;
    childName = record.storage.name;
    record = record.storage.sourcePluginId ? await findCapabilityResourceRecord(record.storage.sourcePluginId) : null;
  } else if (!record) {
    const child = childParentReference(reference);
    if (!child) return { handled: false };
    childName = child.child; record = await findCapabilityResourceRecord(child.parent);
  }
  if (!record || record.storage.sourceType !== 'standalone' || !['user', 'organization'].includes(record.storage.scopeType)) return { handled: false };
  if (childName && query.childName !== undefined) throw notFound();
  childName ??= query.childName;
  const actualRecord = record, storage = record.storage;
  const expected = { expectedMetadataRevision: record.metadata.metadataRevision, expectedGrantsRevision: record.metadata.grantsRevision };
  try {
    return await withAuthorizedCapabilityPackageResource(actor, storage, 'read', expected, async (authorization, database): Promise<Result> => {
      const state = await getCapabilityPackageState(authorization.record.metadata.resourceRef, database);
      if (!state?.currentPublishedRevisionRef) return { handled: false };
      if (childName && storage.resourceType !== 'plugin') throw notFound();
      const scope = capabilityPackageRegistryStorage(storage);
      const readPointer = async () => storage.resourceType === 'plugin'
        ? (await readCanvasPluginRegistry(scope)).plugins[storage.name] : (await readCanvasSkillRegistry(scope)).skills[storage.name];
      const before = await readPointer();
      if (!exactPointer(before, actualRecord)) throw changed();
      if (query.revision !== undefined && query.revision !== (before.revision ?? 1)) throw changed();
      await assertCapabilityPackageRegistryPointerCurrent(storage.resourceType, before, scope, database);
      const capture = await readExactPackageInventory(before.installDir);
      if (capture.checksum !== before.checksum) throw changed();
      const source: CapturedPackageIconSource = { storage, packageRoot: before.installDir, sourceStamp: { version: before.version } };
      let image: CapabilityPackageDeclaredIcon | null;
      let childStorage: CapabilityResourceStorageBinding | undefined;
      if (childName) {
        if (!('skills' in before)) throw notFound();
        const matches = before.skills.filter(child => child.name === childName);
        if (matches.length !== 1) throw notFound();
        const child = matches[0], relative = path.relative(before.installDir, child.directory).split(path.sep).join('/');
        if (relative.startsWith('../') || path.isAbsolute(relative) || path.resolve(child.path) !== path.join(path.resolve(child.directory), 'SKILL.md')) throw notFound();
        const childId = createCapabilityResourceId({ resourceType: 'skill', sourceType: 'plugin', sourcePluginName: storage.name, name: child.name,
          scopeType: storage.scopeType, organizationId: storage.organizationId, ownerUserId: storage.ownerUserId });
        if (childRecord) {
          if (childRecord.storage.resourceType !== 'skill' || childRecord.storage.resourceId !== childId
            || childRecord.storage.sourcePluginId !== storage.resourceId || childRecord.storage.scopeType !== storage.scopeType
            || childRecord.storage.ownerUserId !== storage.ownerUserId || childRecord.storage.organizationId !== storage.organizationId
            || ![childRecord.metadata.resourceRef, childRecord.storage.resourceId].includes(reference)) throw notFound();
        } else if (query.childName === undefined && reference !== childId) throw notFound();
        childStorage = { ...storage, resourceType: 'skill', sourceType: 'plugin', sourcePluginId: storage.resourceId, resourceId: childId, name: child.name };
        const childSource: CapturedPackageIconSource = { storage: childStorage, packageRoot: child.directory, sourceStamp: { version: child.version ?? before.version } };
        const captured = childCapture(capture, relative);
        assertCapturedCapabilityPackageChild(source, capture, childSource, captured);
        image = await withAuthorizedCapabilityPackageResource(actor, childStorage, 'read', expected,
          async () => readFirstCapturedCapabilityPackageImage(captured, capturedCapabilityPackageIconDeclarations(childSource, captured)), { database, parentStorage: storage });
      } else image = readFirstCapturedCapabilityPackageImage(capture, capturedCapabilityPackageIconDeclarations(source, capture));
      const after = await readPointer();
      if (!exactPointer(after, actualRecord) || pointerObservation(after) !== pointerObservation(before)) throw changed();
      await assertCapabilityPackageRegistryPointerCurrent(storage.resourceType, after, scope, database);
      const current = await getCapabilityResourceAccess(actor, storage, database);
      if (!current.access.canRead || current.metadata.metadataRevision !== expected.expectedMetadataRevision
        || current.metadata.grantsRevision !== expected.expectedGrantsRevision) throw notFound();
      if (childStorage) await withAuthorizedCapabilityPackageResource(actor, childStorage, 'read', expected,
        async () => undefined, { database, parentStorage: storage });
      return { handled: true, image };
    });
  } catch (error) {
    if (error instanceof CapabilityPackageError && error.code === 'PACKAGE_ACCESS_DENIED') throw notFound();
    throw error;
  }
}
