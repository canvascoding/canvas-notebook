import 'server-only';

import { randomUUID } from 'node:crypto';
import { openDb } from '@/app/lib/db';
import type { CapabilityResourceActor, CapabilityResourceStorageBinding } from '../resources/contracts';
import { authority } from '../scope-authority';
import { authorizeCapabilityPackageTarget, withAuthorizedCapabilityPackageResource } from '../resources/store';
import { refreshCapabilityRuntimeForScope } from '../activation-actions';
import { CapabilityPackageError, type CapabilityPackagePublishedRevision, type CapabilityPackageState, type CapabilityPackageSourceStamp } from './contracts';
import { assertCapabilityPackageArtifactCurrent, capabilityPackageRegistryStorage,
  resolveCapabilityPackageArtifact, stageCapabilityPackageRegistryPointer,
  withCapabilityPackageRegistryLock, withCapabilityPackageRegistryPublication, type ResolvedCapabilityPackageArtifact } from './artifacts';
import { prepareHeldStorePackageSnapshot, readExactPackageInventory } from './io';
import { getCapabilityPackagePublishedRevision, getCapabilityPackageState, publishCapabilityPackageFromStore,
  withCapabilityPackagePublication, type CapabilityStorePublicationInput } from './store';
import { assertPreparedCapabilityStorePackage, disposePreparedCapabilityStorePackage, getPreparedCapabilityStorePackage,
  type PreparedCapabilityStorePackage } from './store-source';
import { capabilityStoreRegistryIdentity, compareCapabilityStoreVersions, normalizeCapabilityStoreOrigin, sameCapabilityStoreOrigin } from './store-origin';
import { capabilityPackageStoreInstallSchema, capabilityPackageStoreListSchema, capabilityPackageStoreUpdateReviewSchema,
  capabilityPackageStoreUpdateSchema, type CapabilityPackageStoreApplicationResult,
  type CapabilityPackageStoreSelection, type CapabilityPackageStoreUpdateReview } from './store-contracts';
import { disposeLegacyCapabilityStoreHistory, prepareLegacyCapabilityStoreHistory } from './legacy-store-source';
import { readInstalledStoreResources } from '@/app/lib/plugins/store-installed-resource';
import { resolvePluginWorkspaceCatalogScopeContext } from '@/app/lib/plugins/plugin-workspace-selection';
import { selectPluginWorkspaceCatalogResources } from '@/app/lib/plugins/plugin-workspace-catalog';
import { capabilityPackageStoreCatalogQuery, prioritizeScopedStoreResources, projectScopedCapabilityPackageStore,
  retainCurrentScopedStoreObservations, type CapabilityPackageStoreSources } from './store-scoped-projection';
import { resolvedOwnership, storageForOwner } from './store-target';

function snapshotActor(actor: CapabilityResourceActor): CapabilityResourceActor {
  return Object.freeze({ userId: actor.userId, workspaceId: actor.workspaceId ?? null });
}
async function assertActor(actor: CapabilityResourceActor): Promise<void> {
  const database = await openDb();
  try {
    const current = await authority(database, actor);
    if (!current.valid || !current.contextValid) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'An active actor and workspace are required.', 403);
  } finally { await database.close(); }
}
async function readOffering(source: CapabilityPackageStoreSelection) {
  try {
    const registry = source.kind === 'plugin'
      ? await (await import('@/app/lib/plugins/canvas-plugin-store')).readCanvasPluginStoreRegistry()
      : await (await import('@/app/lib/skills/canvas-skill-store')).readCanvasSkillStoreRegistry();
    const offerings = 'plugins' in registry ? registry.plugins : registry.skills;
    const offering = offerings.find(value => value.name === source.entryKey);
    const selected = offering?.versions[source.version];
    if (registry.id !== source.registryId || !offering || !selected
      || selected.checksum.replace(/^sha256:/iu, '').toLowerCase() !== source.checksum) {
      throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The selected Store offering changed. Review it again.', 409);
    }
    return { registry, offering, identity: capabilityStoreRegistryIdentity(registry.registryUrl) };
  } catch (error) {
    if (error instanceof CapabilityPackageError) throw error;
    throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The configured Store is unavailable.', 503);
  }
}
function currentOrigin(source: ResolvedCapabilityPackageArtifact, selected: CapabilityPackageStoreSelection,
  offering: Awaited<ReturnType<typeof readOffering>>) {
  const origin = normalizeCapabilityStoreOrigin(source.sourceStamp.storeOrigin, source.storage.resourceId);
  const baseline = origin ? offering.offering.versions[origin.version] : undefined;
  if (source.readOnly || source.storage.sourceType !== 'standalone' || !origin || origin.relation !== 'installed' || origin.componentPath
    || source.storage.resourceType !== selected.kind || source.storage.name !== selected.entryKey
    || origin.registryId !== selected.registryId || origin.registryIdentity !== offering.identity
    || origin.kind !== selected.kind || origin.entryKey !== selected.entryKey || !baseline
    || baseline.checksum.replace(/^sha256:/iu, '').toLowerCase() !== origin.upstreamChecksum
    || compareCapabilityStoreVersions(selected.version, origin.version) !== 1) {
    throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'This instance has no verified newer Store update.', 409);
  }
  return origin;
}
async function prepareSource(actor: CapabilityResourceActor, storage: CapabilityResourceStorageBinding,
  selection: CapabilityPackageStoreSelection, expectedOrigin?: { registryIdentity: string; version: string; upstreamChecksum: string }) {
  const preparations = await import('@/app/lib/plugins/store-package-preparation');
  const input = { ...selection, resourceId: storage.resourceId, actor, ...(expectedOrigin ? { expectedOrigin } : {}) };
  return selection.kind === 'plugin' ? preparations.prepareVerifiedCanvasPluginStorePackage(input)
    : preparations.prepareVerifiedCanvasSkillStorePackage(input);
}
function applicationResult(resource: CapabilityPackageStoreApplicationResult['resource'],
  result: { state: CapabilityPackageState; published: CapabilityPackagePublishedRevision }): CapabilityPackageStoreApplicationResult {
  const { published } = result;
  return { schemaVersion: 1, resource, state: result.state, published: { resourceRef: published.resourceRef,
    revisionRef: published.revisionRef, kind: published.kind, name: published.name, version: published.version,
    checksum: published.checksum, publishedByUserId: published.publishedByUserId, publishedAt: published.publishedAt,
    baseRevisionRef: published.baseRevisionRef, fileCount: published.files.length, totalBytes: published.totalBytes } };
}
async function withRegistryLocks<T>(storage: CapabilityResourceStorageBinding, operation: () => Promise<T>): Promise<T> {
  return withCapabilityPackageRegistryPublication(storage, () => storage.resourceType === 'plugin'
    ? withCapabilityPackageRegistryLock('skill', capabilityPackageRegistryStorage(storage), operation) : operation());
}
function sameSourceStamp(left: CapabilityPackageSourceStamp, right: CapabilityPackageSourceStamp): boolean {
  const canonical = (stamp: CapabilityPackageSourceStamp) => JSON.stringify([stamp.resourceId, stamp.kind, stamp.name, stamp.version,
    stamp.checksum, stamp.registryChecksum, stamp.sourcePluginId, stamp.parentResourceRef ?? null,
    stamp.parentRevisionRef ?? null, stamp.relativeRoot ?? null, (stamp.dependencies ?? []).map(dependency =>
      [dependency.resourceId, dependency.name, dependency.version, dependency.checksum, dependency.relativeRoot])]);
  return canonical(left) === canonical(right) && sameCapabilityStoreOrigin(left.storeOrigin, right.storeOrigin);
}

/** Store discovery uses existing fresh actor projections and returns only safe, bounded metadata. */
export async function listCapabilityPackageStoreAction(actorInput: CapabilityResourceActor, value: unknown = {}) {
  const actor = snapshotActor(actorInput), query = capabilityPackageStoreListSchema.parse(structuredClone(value));
  const scopeQuery = capabilityPackageStoreCatalogQuery(query);
  const initialContext = await resolvePluginWorkspaceCatalogScopeContext(actor);
  // Reject inaccessible teams before opening a remote registry or reading package bytes.
  selectPluginWorkspaceCatalogResources([], initialContext, scopeQuery);
  const { listCapabilityResources } = await import('../resources/actions');
  const initial = await listCapabilityResources(actor);
  const selected = selectPluginWorkspaceCatalogResources(initial, initialContext, { ...scopeQuery, q: '' });
  const visible = selectPluginWorkspaceCatalogResources(initial, initialContext, scopeQuery);
  const sources: CapabilityPackageStoreSources = { plugin: null, skill: null };
  for (const kind of query.kind ? [query.kind] : ['plugin', 'skill'] as const) {
    try {
      if (kind === 'plugin') sources.plugin = await (await import('@/app/lib/plugins/canvas-plugin-store')).readCanvasPluginStoreRegistry();
      else sources.skill = await (await import('@/app/lib/skills/canvas-skill-store')).readCanvasSkillStoreRegistry();
    } catch { /* An unavailable registry never removes current readable installed metadata. */ }
  }
  const observations = await readInstalledStoreResources(actor, prioritizeScopedStoreResources(selected, scopeQuery, visible), { preserveInputOrder: true });
  // Re-read both scope and resource authority after every kind/read await. No earlier DTO is returned verbatim.
  const current = await listCapabilityResources(actor), context = await resolvePluginWorkspaceCatalogScopeContext(actor);
  const currentSelected = selectPluginWorkspaceCatalogResources(current, context, { ...scopeQuery, q: '' });
  return projectScopedCapabilityPackageStore(current, context, query, sources,
    retainCurrentScopedStoreObservations(selected, currentSelected, observations));
}

/** Review fetches registry metadata only; it does not download or publish an archive. */
export async function inspectCapabilityPackageStoreUpdateAction(actorInput: CapabilityResourceActor, reference: string,
  value: unknown): Promise<CapabilityPackageStoreUpdateReview> {
  const actor = snapshotActor(actorInput), { source: selection } = capabilityPackageStoreUpdateReviewSchema.parse(structuredClone(value));
  await assertActor(actor);
  const source = await resolveCapabilityPackageArtifact(actor, reference), offering = await readOffering(selection);
  const origin = currentOrigin(source, selection, offering);
  return withRegistryLocks(source.storage, async () => {
    await assertCapabilityPackageArtifactCurrent(actor, source);
    return withAuthorizedCapabilityPackageResource(actor, source.storage, 'read', {
      expectedMetadataRevision: source.descriptor.metadata.metadataRevision, expectedGrantsRevision: source.descriptor.metadata.grantsRevision,
    }, async (authorization, database) => {
      const inventory = await readExactPackageInventory(source.location.rootPath);
      if (inventory.checksum !== source.sourceStamp.checksum) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The installed package changed during review.', 409);
      const state = await getCapabilityPackageState(authorization.record.metadata.resourceRef, database);
      if (state && !sameSourceStamp(state.currentSourceStamp, source.sourceStamp)) {
        throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The installed package publication changed during review.', 409);
      }
      const localChanges = source.sourceStamp.checksum === origin.baselineChecksum ? 'unchanged' as const : 'modified' as const;
      return { schemaVersion: 1, resourceRef: authorization.record.metadata.resourceRef, source: selection,
        current: { version: source.sourceStamp.version, checksum: source.sourceStamp.checksum, upstreamVersion: origin.version },
        localChanges, expectedMetadataRevision: authorization.record.metadata.metadataRevision,
        expectedGrantsRevision: authorization.record.metadata.grantsRevision, expectedPackageRevision: state?.packageRevision ?? 0,
        expectedPublishedRevisionRef: state?.currentPublishedRevisionRef ?? null, expectedLocalChecksum: source.sourceStamp.checksum,
        requiresLocalChangesConfirmation: localChanges === 'modified', canUpdate: authorization.access.canManage && authorization.access.canEdit };
    });
  });
}

async function applyPrepared(actor: CapabilityResourceActor, input: CapabilityStorePublicationInput,
  before: (() => Promise<void>) | undefined): Promise<CapabilityPackageStoreApplicationResult> {
  return withRegistryLocks(input.storage, async () => {
    if (before) await before();
    const prepared = getPreparedCapabilityStorePackage(input.prepared);
    await assertPreparedCapabilityStorePackage(input.prepared, { kind: prepared.kind, registryId: prepared.registryId,
      entryKey: prepared.entryKey, version: prepared.version, checksum: prepared.upstreamChecksum, resourceId: input.storage.resourceId });
    let staged: Awaited<ReturnType<typeof stageCapabilityPackageRegistryPointer>> | null = null;
    let stagedRef: string | null = null, canonicalRef = input.resourceRef;
    let resource: CapabilityPackageStoreApplicationResult['resource'] | null = null;
    let result: Awaited<ReturnType<typeof publishCapabilityPackageFromStore>>;
    try {
      result = await publishCapabilityPackageFromStore(actor, input, async (context, database) => {
        canonicalRef = context.authorization.record.metadata.resourceRef;
        resource = context.authorization.record.metadata;
        const validation = context.legacyHistory ? context.validation : prepared.validation;
        if (!validation) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'A verified legacy history is required.', 403);
        const snapshot = await prepareHeldStorePackageSnapshot(context.authorization, { resourceRef: canonicalRef,
          revisionRef: context.revisionRef, kind: input.storage.resourceType, name: input.storage.name,
          version: context.version, checksum: context.checksum, owner: context.authorization.record.metadata.ownership }, validation, database);
        let artifactRevision = input.operation === 'update' ? input.currentSource.stamp.artifactRevision : null;
        if (!context.legacyHistory) {
          stagedRef = context.revisionRef;
          staged = await withCapabilityPackagePublication(context.authorization, { revisionRef: context.revisionRef,
            version: context.version, checksum: context.checksum, rootPath: snapshot.location.rootPath, storeOrigin: context.storeOrigin }, database,
          () => stageCapabilityPackageRegistryPointer(context.authorization, snapshot, context.newResource ? { enabled: false, newResource: true } : undefined));
          artifactRevision = staged.record.revision ?? null;
        }
        return { snapshot, sourceStamp: { resourceId: input.storage.resourceId, kind: input.storage.resourceType,
          name: input.storage.name, version: context.version, checksum: context.checksum, registryChecksum: context.checksum,
          artifactRevision, sourcePluginId: null, storeOrigin: context.storeOrigin } };
      });
    } catch (error) {
      if (!staged) throw error;
      const state = await getCapabilityPackageState(canonicalRef);
      if (state?.currentPublishedRevisionRef === stagedRef) {
        const published = await getCapabilityPackagePublishedRevision(canonicalRef, stagedRef);
        if (!published) throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The Store publication requires inspection.', 503);
        result = { state, published };
      } else {
        const previousRef = input.operation === 'update' ? input.request.expectedPublishedRevisionRef : null;
        if ((state?.currentPublishedRevisionRef ?? null) !== previousRef) {
          throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The Store publication requires inspection.', 503);
        }
        await (staged as Awaited<ReturnType<typeof stageCapabilityPackageRegistryPointer>>).rollback();
        throw error;
      }
    }
    if (!resource) throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The Store publication requires inspection.', 503);
    await refreshCapabilityRuntimeForScope({ actorUserId: actor.userId, scope: capabilityPackageRegistryStorage(input.storage) });
    return applicationResult(resource, result);
  });
}

export async function installCapabilityPackageFromStoreAction(actorInput: CapabilityResourceActor, value: unknown) {
  const actor = snapshotActor(actorInput), input = capabilityPackageStoreInstallSchema.parse(structuredClone(value));
  await assertActor(actor);
  const owner = await resolvedOwnership(actor, input.ownership), storage = storageForOwner(input.source.kind, input.source.entryKey, owner);
  await authorizeCapabilityPackageTarget(actor, storage, owner);
  await readOffering(input.source);
  const receipt = await prepareSource(actor, storage, input.source);
  try {
    return await applyPrepared(actor, { operation: 'install', storage, ownership: owner, resourceRef: `canvas-resource:${randomUUID()}`,
      prepared: receipt, grants: input.grants, responsibleUserId: input.responsibleUserId }, undefined);
  } finally { await disposePreparedCapabilityStorePackage(receipt); }
}

export async function updateCapabilityPackageFromStoreAction(actorInput: CapabilityResourceActor, reference: string, value: unknown) {
  const actor = snapshotActor(actorInput), input = capabilityPackageStoreUpdateSchema.parse(structuredClone(value));
  await assertActor(actor);
  const source = await resolveCapabilityPackageArtifact(actor, reference), offering = await readOffering(input.source);
  const origin = currentOrigin(source, input.source, offering);
  await withAuthorizedCapabilityPackageResource(actor, source.storage, 'publish', input, async authorization => {
    if (!authorization.access.canManage) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'Store updates require management and editing permission.', 403);
  });
  if (source.sourceStamp.checksum !== input.expectedLocalChecksum) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The installed package changed after review.', 409);
  if (source.sourceStamp.checksum !== origin.baselineChecksum && !input.replaceLocalChanges) {
    throw new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'Confirm replacement of the reviewed local changes before updating.', 409);
  }
  const receipt: PreparedCapabilityStorePackage = await prepareSource(actor, source.storage, input.source, origin);
  let legacyHistory: Awaited<ReturnType<typeof prepareLegacyCapabilityStoreHistory>> | undefined;
  try {
    if (input.expectedPackageRevision === 0 && input.expectedPublishedRevisionRef === null) {
      legacyHistory = await prepareLegacyCapabilityStoreHistory(actor, source.descriptor.metadata.resourceRef,
        { storage: source.storage, stamp: source.sourceStamp });
    }
    return await applyPrepared(actor, { operation: 'update', storage: source.storage, resourceRef: source.descriptor.metadata.resourceRef,
      prepared: receipt, request: input, currentSource: { rootPath: source.location.rootPath, stamp: source.sourceStamp }, legacyHistory },
    () => assertCapabilityPackageArtifactCurrent(actor, source));
  } finally {
    try { if (legacyHistory) await disposeLegacyCapabilityStoreHistory(legacyHistory); }
    finally { await disposePreparedCapabilityStorePackage(receipt); }
  }
}
