import 'server-only';

import { openDb } from '@/app/lib/db';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { configureCapabilityResource } from '../resources/actions';
import { capabilityResourceStorageBinding } from '../resources/storage-binding';
import { authorizeCapabilityPackageResource, authorizeCapabilityPackageTarget, withAuthorizedCapabilityPackageResource } from '../resources/store';
import { authority } from '../scope-authority';
import type { CapabilityResourceActor, CapabilityResourceOwnerScope, CapabilityResourceStorageBinding } from '../resources/contracts';
import { isValidCanvasPluginName } from '@/app/lib/plugins/canvas-plugin-manifest';
import { isValidAgentSkillName } from '@/app/lib/skills/canvas-skill-manifest';
import { refreshCapabilityRuntimeForScope } from '../activation-actions';
import { CapabilityPackageError, type AuthorizedCapabilityPackageResource, type AuthorizedCapabilityPackageSource, type CapabilityPackageDescriptor,
  type CapabilityPackageDraft, type CapabilityPackageDraftLocation, type CapabilityPackagePublishedLocation,
  type CapabilityPackageSourceStamp, type CapabilityPackageOwnedDraftListQuery } from './contracts';
import { resolveCapabilityPackageArtifact, assertCapabilityPackageArtifactCurrent, validateCapabilityPackage,
  capabilityPackageLegacyStorageBinding, stageCapabilityPackageRegistryPointer, withCapabilityPackageRegistryPublication,
  type ResolvedCapabilityPackageArtifact } from './artifacts';
import { createCapabilityPackageDraft, deleteCapabilityPackageDraftFile, listCapabilityPackageFiles, preparePublishedSnapshot,
  readCapabilityPackageFile, removeCapabilityPackageDraft, resolveCapabilityPackageDraftLocation,
  resolveOwnerScopedPackageVersionPath, verifyCapabilityPackageSnapshot, writeCapabilityPackageDraftFile } from './io';
import { beginCapabilityPackageDraft, discardCapabilityPackageDraft, getCapabilityPackageDraftRecord,
  getCapabilityPackagePublishedRevision, listCapabilityPackagePublishedRevisions, getCapabilityPackageState,
  getCapabilityPackageOwnedDraftStatus, listCapabilityPackageOwnedDraftStatuses, mutateCapabilityPackageDraft, publishCapabilityPackageDraft,
  withCapabilityPackageDraftRead, withCapabilityPackagePublication, type CapabilityPackageDraftRecord } from './store';
import { capabilityPackageDiscardSchema, capabilityPackageDraftCreationSchema, capabilityPackageDraftReferenceSchema,
  capabilityPackageFileDeleteSchema, capabilityPackageFileReadSchema, capabilityPackageFileWriteSchema,
  capabilityPackagePublishedFileSchema, capabilityPackagePublishedTreeSchema, capabilityPackagePublishSchema,
  capabilityPackageReferenceSchema } from './schemas';
import { deriveCapabilityStoreOrigin, normalizeCapabilityStoreOrigin, sameCapabilityStoreOrigin } from './store-origin';

function parentStorage(source: ResolvedCapabilityPackageArtifact): CapabilityResourceStorageBinding | undefined {
  if (source.storage.sourceType !== 'plugin') return undefined;
  const parent = source.candidates.find(candidate => candidate.ref.resourceType === 'plugin'
    && candidate.ref.resourceId === source.storage.sourcePluginId);
  if (!parent) throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The source plugin is unavailable.', 404);
  return capabilityResourceStorageBinding(parent.ref);
}

async function authorizedSource(actor: CapabilityResourceActor, source: ResolvedCapabilityPackageArtifact,
  operation: 'read' | 'edit'): Promise<AuthorizedCapabilityPackageSource> {
  const parent = parentStorage(source);
  const authorization = await authorizeCapabilityPackageResource(actor, source.storage, operation, {
    ...(parent ? { parentStorage: parent } : {}), expectedRevisions: {
      expectedMetadataRevision: source.descriptor.metadata.metadataRevision,
      expectedGrantsRevision: source.descriptor.metadata.grantsRevision,
    },
  });
  return { authorization, storage: source.storage, sourceStamp: source.sourceStamp, location: source.location,
    readOnly: source.readOnly, ...(parent ? { parentStorage: parent } : {}) };
}

function draftLocation(draft: CapabilityPackageDraft, owner: CapabilityResourceOwnerScope): CapabilityPackageDraftLocation {
  return resolveCapabilityPackageDraftLocation({ draftRef: draft.draftRef, resourceRef: draft.resourceRef,
    kind: draft.kind, name: draft.name, actorUserId: draft.actorUserId, draftRevision: draft.draftRevision, owner });
}

async function targetOwnership(actor: CapabilityResourceActor,
  choice: { type: 'user' } | { type: 'organization' } | { type: 'team'; workspaceId: string }): Promise<Exclude<CapabilityResourceOwnerScope, { type: 'system' }>> {
  const organization = await readOrganizationPermissionForUser(actor.userId);
  if (choice.type === 'user') return { type: 'user', ownerUserId: actor.userId, organizationId: organization.organizationId ?? null };
  if (!organization.configured || !organization.organizationId || organization.permission?.status !== 'active') {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'An active organization membership is required.', 403);
  }
  return choice.type === 'organization' ? { type: 'organization', organizationId: organization.organizationId }
    : { type: 'team', organizationId: organization.organizationId, workspaceId: choice.workspaceId };
}

export async function listCapabilityPackageCreationScopes(actor: CapabilityResourceActor): Promise<Array<{
  type: 'user' | 'organization' | 'team'; workspaceId?: string; label: string;
}>> {
  await readOrganizationPermissionForUser(actor.userId);
  const database = await openDb();
  try {
    const access = await authority(database, actor);
    if (!access.valid || !access.contextValid) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'An active actor and workspace are required.', 403);
    const result: Array<{ type: 'user' | 'organization' | 'team'; workspaceId?: string; label: string }> = [{ type: 'user', label: 'Personal' }];
    for (const [organizationId, membership] of access.memberships) {
      if (membership.status !== 'active') continue;
      const admin = ['owner', 'admin'].includes(membership.role) && membership.canShare;
      if (admin) result.push({ type: 'organization', label: 'Organization' });
      for (const workspace of access.workspaces.values()) {
        if (workspace.organizationId !== organizationId || workspace.type !== 'team' || !workspace.canRead || !admin && !workspace.canManage) continue;
        const row = await database.get('SELECT display_name FROM canvas_workspaces WHERE id=$1 AND status=\'active\'', [workspace.id]) as { display_name: string } | undefined;
        if (row) result.push({ type: 'team', workspaceId: workspace.id, label: String(row.display_name) });
      }
    }
    return result;
  } finally { await database.close(); }
}

export async function inspectCapabilityPackage(actor: CapabilityResourceActor, reference: string): Promise<CapabilityPackageDescriptor> {
  const source = await resolveCapabilityPackageArtifact(actor, capabilityPackageReferenceSchema.parse(reference));
  return withAuthorizedCapabilityPackageResource(actor, source.storage, 'read', {
    expectedMetadataRevision: source.descriptor.metadata.metadataRevision, expectedGrantsRevision: source.descriptor.metadata.grantsRevision,
  }, async (authorization, database) => {
    const state = await getCapabilityPackageState(authorization.record.metadata.resourceRef, database);
    const published = state ? await getCapabilityPackagePublishedRevision(state.resourceRef, state.currentPublishedRevisionRef, database) : null;
    return { resource: authorization.record.metadata, access: authorization.access, state, published, sourceStamp: source.sourceStamp,
      readOnly: source.readOnly, defaultEnabled: source.defaultEnabled };
  }, { parentStorage: parentStorage(source) });
}

export async function createCapabilityPackageDraftAction(actor: CapabilityResourceActor, value: unknown): Promise<CapabilityPackageDraft> {
  let input = capabilityPackageDraftCreationSchema.parse(structuredClone(value));
  let source = await resolveCapabilityPackageArtifact(actor, input.resourceRef);
  if (input.operation === 'edit' && source.readOnly) throw new CapabilityPackageError('PACKAGE_READ_ONLY', 'Edit the owning plugin or create a distinct variant.', 403);
  if (input.operation === 'edit' && source.descriptor.metadata.metadataRevision === 0) {
    if (input.expectedMetadataRevision !== 0 || input.expectedGrantsRevision !== 0) {
      throw new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'The resource metadata changed. Inspect it again.', 409);
    }
    if (input.expectedPackageRevision !== 0 || input.expectedPublishedRevisionRef !== null) {
      throw new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'The selected package revision changed. Inspect it again.', 409);
    }
    await configureCapabilityResource(actor, input.resourceRef, { expectedMetadataRevision: 0, expectedGrantsRevision: 0, accessMode: 'inherit' });
    source = await resolveCapabilityPackageArtifact(actor, input.resourceRef);
    input = { ...input, resourceRef: source.descriptor.metadata.resourceRef,
      expectedMetadataRevision: source.descriptor.metadata.metadataRevision, expectedGrantsRevision: source.descriptor.metadata.grantsRevision };
  } else input = { ...input, resourceRef: source.descriptor.metadata.resourceRef };
  const seed = await authorizedSource(actor, source, input.operation === 'edit' ? 'edit' : 'read');
  let target: AuthorizedCapabilityPackageResource | undefined;
  if (input.operation === 'fork') {
    if (!(source.storage.resourceType === 'skill' ? isValidAgentSkillName(input.targetName) : isValidCanvasPluginName(input.targetName))) {
      throw new CapabilityPackageError('PACKAGE_REQUEST_INVALID', 'Choose a valid package name.');
    }
    const owner = await targetOwnership(actor, input.ownership);
    const storage = capabilityPackageLegacyStorageBinding(source.storage.resourceType, input.targetName, owner.type === 'user'
      ? { scopeType: 'user', userId: owner.ownerUserId } : { scopeType: 'organization', organizationId: owner.organizationId });
    target = await authorizeCapabilityPackageTarget(actor, storage, owner);
  }
  const run = async () => {
    // Canonical permission refreshes happen before taking any SQL authority locks.
    await assertCapabilityPackageArtifactCurrent(actor, source);
    return beginCapabilityPackageDraft(actor, input, { source: seed, ...(target ? { target } : {}) }, async draft => {
      await createCapabilityPackageDraft(seed.location, draftLocation(draft, target?.record.metadata.ownership ?? seed.authorization.record.metadata.ownership),
        { expectedSourceChecksum: seed.sourceStamp.checksum, bundledReferences: source.bundledReferences });
    });
  };
  return source.readOnly ? run() : withCapabilityPackageRegistryPublication(source.storage, run);
}

function publicDraft(record: CapabilityPackageDraftRecord, metadata: { metadataRevision: number; grantsRevision: number }) {
  return { draft: record.draft, target: { resourceRef: record.draft.resourceRef, name: record.draft.name, ownership: record.targetOwnership,
    expectedMetadataRevision: metadata.metadataRevision, expectedGrantsRevision: metadata.grantsRevision } };
}

export async function readCapabilityPackageDraftAction(actor: CapabilityResourceActor, reference: string) {
  return withCapabilityPackageDraftRead(actor, capabilityPackageDraftReferenceSchema.parse(reference), async record =>
    publicDraft(record, record.authorization.record.metadata));
}

export async function readCapabilityPackageOwnedDraftStatusAction(actor: CapabilityResourceActor, reference: string) {
  return { status: await getCapabilityPackageOwnedDraftStatus(actor, capabilityPackageDraftReferenceSchema.parse(reference)) };
}

/** Listing recovery metadata does not resolve or read the source package. */
export async function listCapabilityPackageOwnedDraftStatusesAction(actor: CapabilityResourceActor, value: unknown = {}) {
  return listCapabilityPackageOwnedDraftStatuses(actor, value as CapabilityPackageOwnedDraftListQuery);
}

export async function listCapabilityPackageDraftFilesAction(actor: CapabilityResourceActor, reference: string) {
  return withCapabilityPackageDraftRead(actor, capabilityPackageDraftReferenceSchema.parse(reference), async record => ({
    ...publicDraft(record, record.authorization.record.metadata), files: await listCapabilityPackageFiles(draftLocation(record.draft, record.targetOwnership)),
  }));
}

export async function readCapabilityPackageDraftFileAction(actor: CapabilityResourceActor, reference: string, value: unknown) {
  const input = capabilityPackageFileReadSchema.parse(structuredClone(value));
  return withCapabilityPackageDraftRead(actor, capabilityPackageDraftReferenceSchema.parse(reference), async record => ({
    ...publicDraft(record, record.authorization.record.metadata), file: await readCapabilityPackageFile(draftLocation(record.draft, record.targetOwnership), input),
  }));
}

export async function writeCapabilityPackageDraftFileAction(actor: CapabilityResourceActor, reference: string, value: unknown) {
  const input = capabilityPackageFileWriteSchema.parse(structuredClone(value));
  const record = await getCapabilityPackageDraftRecord(actor, capabilityPackageDraftReferenceSchema.parse(reference));
  const { draft } = await mutateCapabilityPackageDraft(actor, reference, input.expectedDraftRevision, async current =>
    writeCapabilityPackageDraftFile(draftLocation(current, record.targetOwnership), input));
  return { draft };
}

export async function deleteCapabilityPackageDraftFileAction(actor: CapabilityResourceActor, reference: string, value: unknown) {
  const input = capabilityPackageFileDeleteSchema.parse(structuredClone(value));
  const record = await getCapabilityPackageDraftRecord(actor, capabilityPackageDraftReferenceSchema.parse(reference));
  const { draft } = await mutateCapabilityPackageDraft(actor, reference, input.expectedDraftRevision, async current =>
    deleteCapabilityPackageDraftFile(draftLocation(current, record.targetOwnership), input));
  return { draft };
}

export async function validateCapabilityPackageDraftAction(actor: CapabilityResourceActor, reference: string) {
  return withCapabilityPackageDraftRead(actor, capabilityPackageDraftReferenceSchema.parse(reference), async record => ({
    ...publicDraft(record, record.authorization.record.metadata),
    validation: await validateCapabilityPackage(record.draft.kind, draftLocation(record.draft, record.targetOwnership).rootPath, { name: record.draft.name }),
  }));
}

export async function discardCapabilityPackageDraftAction(actor: CapabilityResourceActor, reference: string, value: unknown) {
  const input = capabilityPackageDiscardSchema.parse(structuredClone(value));
  // Discard still works after source access was revoked. Its exact actor path is server derived.
  await discardCapabilityPackageDraft(actor, capabilityPackageDraftReferenceSchema.parse(reference), input.expectedDraftRevision, async draft => {
    await removeCapabilityPackageDraft(draftLocation(draft, { type: 'user', ownerUserId: actor.userId, organizationId: null }));
  });
  return { discarded: true };
}

function sameSource(left: CapabilityPackageSourceStamp, right: CapabilityPackageSourceStamp): boolean {
  return left.resourceId === right.resourceId && left.kind === right.kind && left.name === right.name && left.version === right.version
    && left.artifactRevision === right.artifactRevision && left.checksum === right.checksum && left.registryChecksum === right.registryChecksum
    && left.sourcePluginId === right.sourcePluginId
    && sameCapabilityStoreOrigin(left.storeOrigin, right.storeOrigin)
    && JSON.stringify(left.dependencies || []) === JSON.stringify(right.dependencies || []);
}

export async function publishCapabilityPackageDraftAction(actor: CapabilityResourceActor, value: unknown) {
  const input = capabilityPackagePublishSchema.parse(structuredClone(value));
  const record = await getCapabilityPackageDraftRecord(actor, input.draftRef);
  return withCapabilityPackageRegistryPublication(record.targetStorage, async () => {
    if (record.draft.operation === 'edit') {
      const current = await resolveCapabilityPackageArtifact(actor, record.draft.resourceRef);
      if (!sameSource(current.sourceStamp, record.draft.baseSourceStamp)) {
        throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The installed source changed. Keep the draft and inspect its base again.', 409);
      }
    }
    let staged: Awaited<ReturnType<typeof stageCapabilityPackageRegistryPointer>> | undefined;
    let stagedRef: string | undefined;
    let result;
    try {
      result = await publishCapabilityPackageDraft(actor, input, async (context, database) => {
        const location = draftLocation(context.draft, context.authorization.record.metadata.ownership);
        const validation = await validateCapabilityPackage(context.draft.kind, location.rootPath, { name: context.draft.name });
        if (!validation.valid || !validation.version || !validation.checksum) throw new CapabilityPackageError('PACKAGE_INVALID', validation.errors.join(' ') || 'The package is invalid.');
        const snapshot = await preparePublishedSnapshot(location, { resourceRef: context.draft.resourceRef, revisionRef: context.revisionRef,
          kind: context.draft.kind, name: context.draft.name, owner: context.authorization.record.metadata.ownership,
          version: validation.version, checksum: validation.checksum }, validation);
        stagedRef = context.revisionRef;
        const sourceOrigin = normalizeCapabilityStoreOrigin(context.draft.baseSourceStamp.storeOrigin, context.draft.baseSourceStamp.resourceId) ?? undefined;
        const storeOrigin = context.draft.operation === 'fork' ? deriveCapabilityStoreOrigin(sourceOrigin, context.authorization.record.storage.resourceId) : sourceOrigin;
        staged = await withCapabilityPackagePublication(context.authorization, { revisionRef: context.revisionRef,
          version: validation.version, checksum: validation.checksum, rootPath: snapshot.location.rootPath, storeOrigin }, database,
        () => stageCapabilityPackageRegistryPointer(context.authorization, snapshot, context.draft.operation === 'fork' ? { enabled: false, newResource: true } : undefined));
        const pointer = staged.record;
        return { snapshot, sourceStamp: { resourceId: context.authorization.record.storage.resourceId, kind: context.draft.kind,
          name: context.draft.name, version: validation.version, artifactRevision: pointer.revision ?? null,
          checksum: validation.checksum, registryChecksum: validation.checksum, sourcePluginId: null,
          ...(storeOrigin ? { storeOrigin } : {}) } };
      });
    } catch (error) {
      if (!staged) throw error;
      // COMMIT acknowledgement can fail after a real commit. Verify before restoring a file pointer.
      const state = await getCapabilityPackageState(record.draft.resourceRef);
      if (state && state.currentPublishedRevisionRef === stagedRef) {
        const published = await getCapabilityPackagePublishedRevision(state.resourceRef, stagedRef);
        if (!published) throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The publication requires inspection.', 503);
        result = { state, published };
      } else {
        await staged.rollback();
        throw error;
      }
    }
    const storage = record.targetStorage;
    await refreshCapabilityRuntimeForScope({ actorUserId: actor.userId, scope: storage.scopeType === 'organization'
      ? { scopeType: 'organization', organizationId: storage.organizationId! } : { scopeType: 'user', userId: storage.ownerUserId! } });
    return result;
  });
}

async function withPublishedPackage<T>(actor: CapabilityResourceActor, reference: string, selectedRevision: string | undefined,
  callback: (location: CapabilityPackagePublishedLocation | ResolvedCapabilityPackageArtifact['location']) => Promise<T>): Promise<T> {
  const source = await resolveCapabilityPackageArtifact(actor, capabilityPackageReferenceSchema.parse(reference));
  return withAuthorizedCapabilityPackageResource(actor, source.storage, 'read', undefined, async (authorization, database) => {
    const published = await getCapabilityPackagePublishedRevision(authorization.record.metadata.resourceRef, selectedRevision, database);
    if (!published) {
      if (selectedRevision) throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The selected package version was not found.', 404);
      return callback(source.location);
    }
    const identity = { ...published, owner: authorization.record.metadata.ownership };
    const location = { ...identity, rootPath: resolveOwnerScopedPackageVersionPath(identity) };
    await verifyCapabilityPackageSnapshot(location);
    return callback(location);
  }, { parentStorage: parentStorage(source) });
}

export async function listCapabilityPackageFilesAction(actor: CapabilityResourceActor, reference: string, value: unknown = {}) {
  const input = capabilityPackagePublishedTreeSchema.parse(structuredClone(value));
  return withPublishedPackage(actor, reference, input.revisionRef, async location => ({ files: await listCapabilityPackageFiles(location) }));
}

export async function listCapabilityPackageVersionsAction(actor: CapabilityResourceActor, reference: string) {
  const source = await resolveCapabilityPackageArtifact(actor, capabilityPackageReferenceSchema.parse(reference));
  return withAuthorizedCapabilityPackageResource(actor, source.storage, 'read', undefined, async (authorization, database) => ({
    versions: await listCapabilityPackagePublishedRevisions(authorization.record.metadata.resourceRef, database),
  }), { parentStorage: parentStorage(source) });
}

export async function readCapabilityPackageFileAction(actor: CapabilityResourceActor, reference: string, value: unknown) {
  const { revisionRef, ...input } = capabilityPackagePublishedFileSchema.parse(structuredClone(value));
  return withPublishedPackage(actor, reference, revisionRef, async location => ({ file: await readCapabilityPackageFile(location, input) }));
}
