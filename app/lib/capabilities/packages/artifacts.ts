import 'server-only';

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { type CapabilityResourceActor, type CapabilityResourceDescriptor,
  type CapabilityResourceStorageBinding } from '@/app/lib/capabilities/resources/contracts';
import type { CapabilityCandidate, CapabilityResourceType } from '@/app/lib/capabilities/types';
import { buildPublishedCanvasPluginRecord, computeCanvasPluginChecksum, parsePluginSkillsFromManifest, readCanvasPluginRegistry, writeCanvasPluginRegistry,
  type CanvasPluginInstallRecord } from '@/app/lib/plugins/canvas-plugin-registry';
import { isValidCanvasPluginVersion, validateCanvasPluginPackage, type CanvasPluginManifest } from '@/app/lib/plugins/canvas-plugin-manifest';
import { CANVAS_SKILL_INTERFACE_PATH, loadCanvasSkillInterface, parseSkillFile, validateStandaloneSkillWorkflow, type CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
import { isWorkflowManifestError, type WorkflowDeclaration } from '@/app/lib/capabilities/workflow-contracts';
import { readCanvasSkillRegistry, writeCanvasSkillRegistry, type CanvasSkillInstallRecord } from '@/app/lib/skills/canvas-skill-store';
import { requirePathInside } from '@/app/lib/security/safe-paths';
import { createCapabilityResourceId } from '@/app/lib/capabilities/reference';
import { createAtomicTempPath, resolveCanvasDataRoot, resolveDataStorageScope, resolveScopedPluginRegistryPath, resolveScopedSkillRegistryPath,
  type CapabilityDataStorageScope } from '@/app/lib/runtime-data-paths';
import { withFileMutationLock } from '@/app/lib/secrets/file-mutation-lock';
import { readExactPackageInventory, resolveOwnerScopedPackageVersionPath, verifyCapabilityPackageSnapshot } from './io';
import { CapabilityPackageError, isCapabilityPackageError, type CapabilityPackageSourceStamp, type CapabilityPackageValidation,
  type CapabilityPackagePrivateLocation, type CapabilityPackagePreparedSnapshot, type AuthorizedCapabilityPackageResource } from './contracts';
import { deriveCapabilityStoreOrigin, isIssuedCapabilityStoreOrigin, normalizeCapabilityStoreOrigin, sameCapabilityStoreOrigin, type CapabilityStoreOrigin } from './store-origin';

export type ResolvedCapabilityPackageArtifact = {
  descriptor: CapabilityResourceDescriptor;
  candidate: CapabilityCandidate;
  candidates: CapabilityCandidate[];
  storage: CapabilityResourceStorageBinding;
  packageRoot: string;
  sourceStamp: CapabilityPackageSourceStamp;
  location: CapabilityPackagePrivateLocation;
  readOnly: boolean;
  defaultEnabled: boolean;
  bundledReferences?: Array<{ source: CapabilityPackagePrivateLocation; relativeTargetRoot: string; checksum: string }>;
};

export type ValidatedCapabilityPackage = {
  kind: CapabilityResourceType;
  name: string;
  version: string;
  description: string;
  checksum: string;
  fileCount: number;
  totalBytes: number;
  manifest?: CanvasPluginManifest;
  skill?: CanvasSkill;
  workflowDeclarations?: WorkflowDeclaration[];
};

function invalid(message: string): never { throw new CapabilityPackageError('PACKAGE_INVALID', message, 400); }

function storage(candidate: CapabilityCandidate): CapabilityResourceStorageBinding {
  const ref = candidate.ref;
  return { resourceType: ref.resourceType, resourceId: ref.resourceId, scopeType: ref.scopeType, name: ref.name,
    sourceType: ref.sourceType, organizationId: ref.organizationId, ownerUserId: ref.ownerUserId, sourcePluginId: ref.sourcePluginId };
}

async function readExactPackagePlugin(actor: CapabilityResourceActor, candidate: CapabilityCandidate,
  candidates: readonly CapabilityCandidate[]) {
  const { assertReadableCapabilityCandidate } = await import('@/app/lib/capabilities/resources/read');
  const { readExactInstalledPlugin } = await import('@/app/lib/plugins/installed-plugin-read');
  await assertReadableCapabilityCandidate(actor, candidate, candidates);
  const plugin = await readExactInstalledPlugin({ name: candidate.ref.name, resourceId: candidate.ref.resourceId,
    scope: candidate.ref.scopeType === 'organization'
      ? { scopeType: 'organization', organizationId: candidate.ref.organizationId! }
      : { scopeType: 'user', userId: candidate.ref.scopeType === 'system' ? actor.userId : candidate.ref.ownerUserId! } });
  if (!plugin) throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The package was not found.', 404);
  await assertReadableCapabilityCandidate(actor, candidate, candidates);
  return plugin;
}

export async function resolveCapabilityPackageArtifact(actor: CapabilityResourceActor, resourceRef: string): Promise<ResolvedCapabilityPackageArtifact> {
  const { inspectCapabilityResource } = await import('@/app/lib/capabilities/resources/actions');
  const { assertReadableCapabilityCandidate, loadCapabilityCandidatesForResourceActor } = await import('@/app/lib/capabilities/resources/read');
  const descriptor = await inspectCapabilityResource(actor, resourceRef);
  if (!descriptor.access.canRead) throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The package was not found.', 404);
  // Explicit package references select an instance, including readable shadowed variants.
  // Runtime name selection is deliberately independent from this management read.
  const candidates = await loadCapabilityCandidatesForResourceActor(actor);
  const matching = candidates.filter(candidate => candidate.ref.resourceType === descriptor.artifact.resourceType
    && ['plugin', 'skill'].includes(candidate.ref.resourceType)
    && candidate.ref.resourceId === descriptor.artifact.resourceId && candidate.resourceAccess?.canRead !== false);
  if (matching.length !== 1) throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The package was not found.', 404);
  const candidate = matching[0];
  await assertReadableCapabilityCandidate(actor, candidate, candidates);
  const resolved = { candidate, candidates };
  let pluginResult = null;
  if (candidate.ref.resourceType === 'plugin') {
    const plugin = await readExactPackagePlugin(actor, candidate, candidates);
    pluginResult = { ...resolved, plugin };
  }
  let defaultEnabled = pluginResult?.plugin.enabled ?? true;
  let storedOrigin = pluginResult?.plugin.storeOrigin;
  if (candidate.ref.resourceType === 'skill' && candidate.ref.sourceType === 'standalone' && candidate.ref.scopeType !== 'system') {
    const record = (await readCanvasSkillRegistry(capabilityPackageRegistryStorage(storage(candidate)))).skills[candidate.ref.name];
    defaultEnabled = record?.packageDefaultEnabled !== false;
    storedOrigin = record?.storeOrigin;
    if (record) await assertCapabilityPackageRegistryPointerCurrent('skill', record, capabilityPackageRegistryStorage(storage(candidate)));
  }
  const packageRoot = pluginResult ? pluginResult.plugin.installDir : candidate.runtimePath ? path.dirname(candidate.runtimePath) : null;
  if (!packageRoot) throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'The package was not found.', 404);
  if (pluginResult && (pluginResult.plugin.packageManaged || pluginResult.plugin.packageResourceRef || pluginResult.plugin.publishedRevisionRef)) {
    await assertCapabilityPackageRegistryPointerCurrent('plugin', pluginResult.plugin, capabilityPackageRegistryStorage(storage(candidate)));
  }
  const inventory = await readExactPackageInventory(packageRoot);
  await assertReadableCapabilityCandidate(actor, candidate, resolved.candidates);
  const sourceStamp: CapabilityPackageSourceStamp = { resourceId: candidate.ref.resourceId, kind: candidate.ref.resourceType,
    name: candidate.ref.name, version: candidate.ref.version, artifactRevision: candidate.ref.revision,
    checksum: inventory.checksum, registryChecksum: candidate.ref.checksum, sourcePluginId: candidate.ref.sourcePluginId };
  const origin = normalizeCapabilityStoreOrigin(storedOrigin, candidate.ref.resourceId);
  if (origin) sourceStamp.storeOrigin = origin;
  const bundledReferences: ResolvedCapabilityPackageArtifact['bundledReferences'] = [];
  const sourceManifest = pluginResult ? (await validateCanvasPluginPackage(packageRoot)).manifest : null;
  if (pluginResult && !sourceManifest) invalid('The installed plugin manifest is unavailable.');
  if (sourceManifest?.skillRefs?.length) {
    const skillsRoot = path.posix.normalize(sourceManifest.skills || 'skills');
    requirePathInside(packageRoot, skillsRoot);
    for (const reference of [...sourceManifest.skillRefs].sort((left, right) => left.name.localeCompare(right.name))) {
      if (reference.source && reference.source !== 'seed') invalid('The plugin contains an unsupported external skill reference.');
      const dependency = resolved.candidates.find(value => value.ref.resourceType === 'skill' && value.ref.sourceType === 'plugin'
        && value.ref.sourcePluginId === candidate.ref.resourceId && value.ref.name === reference.name);
      const seedRoot = requirePathInside(path.join(process.cwd(), 'seed_skills'), reference.name);
      if (!dependency?.runtimePath || path.resolve(dependency.runtimePath) !== path.join(seedRoot, 'SKILL.md')) invalid('The referenced skill source is unavailable.');
      await assertReadableCapabilityCandidate(actor, dependency, resolved.candidates);
      const captured = await readExactPackageInventory(seedRoot);
      await assertReadableCapabilityCandidate(actor, dependency, resolved.candidates);
      const relativeTargetRoot = path.posix.join(skillsRoot, reference.name);
      sourceStamp.dependencies ??= [];
      sourceStamp.dependencies.push({ resourceId: dependency.ref.resourceId, name: dependency.ref.name,
        version: dependency.ref.version, checksum: captured.checksum, relativeRoot: relativeTargetRoot });
      bundledReferences.push({ source: { rootPath: seedRoot, resourceRef: dependency.resourceMetadata?.resourceRef || dependency.ref.resourceId,
        kind: 'skill', name: dependency.ref.name, owner: { type: 'system' } }, relativeTargetRoot, checksum: captured.checksum });
    }
  }
  if (candidate.ref.sourceType === 'plugin') {
    const parent = resolved.candidates.find(value => value.ref.resourceType === 'plugin' && value.ref.resourceId === candidate.ref.sourcePluginId);
    if (!parent) throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The containing plugin is unavailable.', 409);
    const parentResolved = { plugin: await readExactPackagePlugin(actor, parent, candidates) };
    defaultEnabled = parentResolved.plugin.enabled;
    const parentMetadata = parent.resourceMetadata || (await inspectCapabilityResource(actor, parent.ref.resourceId)).metadata;
    const relativeRoot = path.relative(parentResolved.plugin.installDir, packageRoot).split(path.sep).join('/');
    const parentManifest = (await validateCanvasPluginPackage(parentResolved.plugin.installDir)).manifest;
    const externalSeed = parentManifest?.skillRefs?.some(reference => (!reference.source || reference.source === 'seed') && reference.name === candidate.ref.name)
      && path.resolve(packageRoot) === requirePathInside(path.join(process.cwd(), 'seed_skills'), candidate.ref.name);
    if ((!relativeRoot || relativeRoot.startsWith('../') || path.isAbsolute(relativeRoot)) && !externalSeed) invalid('The child skill source is unavailable.');
    sourceStamp.parentResourceRef = parentMetadata.resourceRef;
    sourceStamp.parentRevisionRef = parentResolved.plugin.publishedRevisionRef || null;
    sourceStamp.relativeRoot = externalSeed ? null : relativeRoot;
    // A bundled child is an exact component of its verified parent offering.
    // External seed references have no corresponding upstream component path.
    if (!externalSeed) {
      const parentOrigin = normalizeCapabilityStoreOrigin(parentResolved.plugin.storeOrigin, parent.ref.resourceId);
      const childOrigin = deriveCapabilityStoreOrigin(parentOrigin, candidate.ref.resourceId, relativeRoot);
      if (childOrigin) sourceStamp.storeOrigin = childOrigin;
    }
  }
  return { descriptor, candidate, candidates: resolved.candidates, storage: storage(candidate), packageRoot, sourceStamp,
    location: { rootPath: packageRoot, resourceRef: descriptor.metadata.resourceRef, owner: descriptor.metadata.ownership,
      kind: candidate.ref.resourceType, name: candidate.ref.name },
    readOnly: candidate.ref.sourceType !== 'standalone' || candidate.ref.scopeType === 'system', defaultEnabled,
    ...(bundledReferences.length ? { bundledReferences } : {}) };
}

export async function assertCapabilityPackageArtifactCurrent(actor: CapabilityResourceActor, previous: ResolvedCapabilityPackageArtifact): Promise<void> {
  const current = await resolveCapabilityPackageArtifact(actor, previous.descriptor.metadata.resourceRef);
  const before = previous.descriptor, after = current.descriptor;
  if (after.artifact.resourceId !== before.artifact.resourceId || after.artifact.version !== before.artifact.version
    || after.artifact.checksum !== before.artifact.checksum || after.artifact.revision !== before.artifact.revision
    || after.metadata.metadataRevision !== before.metadata.metadataRevision || after.metadata.grantsRevision !== before.metadata.grantsRevision
    || current.sourceStamp.checksum !== previous.sourceStamp.checksum
    || !sameCapabilityStoreOrigin(current.sourceStamp.storeOrigin, previous.sourceStamp.storeOrigin)
    || JSON.stringify(current.sourceStamp.dependencies || []) !== JSON.stringify(previous.sourceStamp.dependencies || [])
    || path.resolve(current.packageRoot) !== path.resolve(previous.packageRoot)) {
    throw new CapabilityPackageError('PACKAGE_SOURCE_CHANGED', 'The source package or its access changed. Inspect it again.', 409);
  }
}

export async function validateCompleteCapabilityPackage(kind: CapabilityResourceType, packageRoot: string,
  expected?: { name?: string; version?: string }): Promise<ValidatedCapabilityPackage> {
  const inventory = await readExactPackageInventory(packageRoot);
  let name: string, version: string, description: string;
  let manifest: CanvasPluginManifest | undefined, skill: CanvasSkill | undefined;
  const workflowDeclarations: WorkflowDeclaration[] = [];
  if (kind === 'plugin') {
    const result = await validateCanvasPluginPackage(packageRoot);
    if (!result.valid || !result.manifest) invalid(result.errors.join(' ') || 'The plugin package is invalid.');
    manifest = result.manifest;
    if (manifest.skillRefs?.some(reference => reference.source === 'seed')) invalid('Bundle referenced skills inside the package before publishing an immutable version.');
    name = manifest.name; version = manifest.version; description = manifest.description;
    if (!result.skillsDir) invalid('The plugin package must contain bundled skills.');
    const children = await parsePluginSkillsFromManifest(manifest, packageRoot, result.skillsDir);
    if (children.errors.length || !children.records.length) invalid(children.errors.join(' ') || 'The plugin package must contain bundled skills.');
    if (manifest.workflow) workflowDeclarations.push({ declarationPath: '.canvas-plugin/plugin.json', workflow: manifest.workflow });
    for (const child of children.skills) {
      if (!child.workflow) continue;
      const relativePath = path.relative(packageRoot, path.join(child.directory, CANVAS_SKILL_INTERFACE_PATH)).split(path.sep).join('/');
      requirePathInside(packageRoot, relativePath);
      workflowDeclarations.push({ declarationPath: relativePath, workflow: child.workflow });
    }
  } else {
    const diagnostics: string[] = [];
    const parsed = await parseSkillFile(requirePathInside(packageRoot, 'SKILL.md'), { validateDirectoryName: false,
      onDiagnostic: message => diagnostics.push(message) });
    if (!parsed) invalid(diagnostics.join(' ') || 'The skill package is invalid.');
    skill = parsed;
    try { await validateStandaloneSkillWorkflow(skill); }
    catch (error) { if (!isWorkflowManifestError(error)) throw error; invalid(error.message); }
    if (skill.workflow) workflowDeclarations.push({ declarationPath: 'agents/canvas.yaml', workflow: skill.workflow });
    if (!skill.version || !isValidCanvasPluginVersion(skill.version)) invalid('Declare a valid package version in SKILL.md or agents/canvas.yaml.');
    name = skill.name; version = skill.version; description = skill.description;
  }
  if (expected?.name && name !== expected.name || expected?.version && version !== expected.version) invalid('The package name or version does not match its draft.');
  const checksum = await computeCanvasPluginChecksum(packageRoot);
  if (checksum !== inventory.checksum) invalid('The package changed during validation. Validate it again.');
  return { kind, name, version, description, checksum, fileCount: inventory.files.length, totalBytes: inventory.totalBytes,
    ...(manifest ? { manifest } : {}), ...(skill ? { skill } : {}), ...(workflowDeclarations.length ? { workflowDeclarations } : {}) };
}

export async function readCapabilityPackageManifest(kind: CapabilityResourceType, packageRoot: string): Promise<string> {
  return fs.readFile(requirePathInside(packageRoot, kind === 'plugin' ? '.canvas-plugin/plugin.json' : 'SKILL.md'), 'utf8');
}

export async function validateCapabilityPackage(kind: CapabilityResourceType, packageRoot: string,
  expected?: { name?: string; version?: string }): Promise<CapabilityPackageValidation> {
  try {
    const validated = await validateCompleteCapabilityPackage(kind, packageRoot, expected);
    const inventory = await readExactPackageInventory(packageRoot);
    if (inventory.checksum !== validated.checksum) invalid('The package changed during validation. Validate it again.');
    return { valid: true, kind, name: validated.name, version: validated.version, checksum: validated.checksum,
      files: inventory.files.map(file => ({ path: file.relativePath, size: file.size, checksum: file.checksum })),
      totalBytes: inventory.totalBytes, errors: [], warnings: [] };
  } catch (error) {
    if (!isCapabilityPackageError(error) || error.code !== 'PACKAGE_INVALID') throw error;
    return { valid: false, kind, name: null, version: null, checksum: null, files: [], totalBytes: 0,
      errors: [error.message.replaceAll(packageRoot, 'package')], warnings: [] };
  }
}

export function capabilityPackageRegistryStorage(binding: CapabilityResourceStorageBinding): CapabilityDataStorageScope {
  if (binding.scopeType === 'user' && binding.ownerUserId) return { scopeType: 'user', userId: binding.ownerUserId };
  if (binding.scopeType === 'organization' && binding.organizationId) return { scopeType: 'organization', organizationId: binding.organizationId };
  throw new CapabilityPackageError('PACKAGE_READ_ONLY', 'System packages cannot be published in place.', 403);
}

function registryPath(kind: CapabilityResourceType, scope: CapabilityDataStorageScope): string {
  return kind === 'plugin' ? resolveScopedPluginRegistryPath(scope) : resolveScopedSkillRegistryPath(scope);
}

export async function withCapabilityPackageRegistryPublication<T>(binding: CapabilityResourceStorageBinding,
  callback: () => Promise<T>): Promise<T> {
  return withCapabilityPackageRegistryLock(binding.resourceType, capabilityPackageRegistryStorage(binding), callback);
}

export async function withCapabilityPackageRegistryLock<T>(kind: CapabilityResourceType,
  scope: CapabilityDataStorageScope | null | undefined, callback: () => Promise<T>): Promise<T> {
  const digest = createHash('sha256').update(registryPath(kind, scope || {})).digest('hex');
  return withFileMutationLock(path.join(resolveCanvasDataRoot(), 'capability-package-locks', `${digest}.registry`), callback);
}

export function capabilityPackageLegacyStorageBinding(kind: CapabilityResourceType, name: string,
  scope?: CapabilityDataStorageScope | null): CapabilityResourceStorageBinding {
  const storage = resolveDataStorageScope(scope);
  const scopeType = storage.scopeType === 'legacy' ? 'system' : storage.scopeType;
  return { resourceType: kind, name, sourceType: 'standalone', scopeType,
    organizationId: scopeType === 'organization' ? storage.organizationId : null,
    ownerUserId: scopeType === 'user' ? storage.userId : null, sourcePluginId: null,
    resourceId: createCapabilityResourceId({ resourceType: kind, scopeType, name, sourceType: 'standalone',
      organizationId: storage.organizationId, ownerUserId: storage.userId }) };
}

type RegistryPackagePointer = { version: string; checksum: string; installDir: string; resourceId?: string;
  packageManaged?: boolean; packageResourceRef?: string; publishedRevisionRef?: string; enabled?: boolean; packageDefaultEnabled?: boolean; storeOrigin?: CapabilityStoreOrigin };

export async function assertCapabilityPackageRegistryPointerCurrent(kind: CapabilityResourceType,
  record: RegistryPackagePointer & { name: string; resourceId?: string }, scope?: CapabilityDataStorageScope | null): Promise<void> {
  if (!record.packageManaged && !record.packageResourceRef && !record.publishedRevisionRef) return;
  const unavailable = () => { throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The installed package publication is unavailable.', 503); };
  if (!record.packageManaged || !record.packageResourceRef || !record.publishedRevisionRef || !record.resourceId) return unavailable();
  const resolved = resolveDataStorageScope(scope);
  const owner = resolved.scopeType === 'user' && resolved.userId ? { type: 'user' as const, ownerUserId: resolved.userId, organizationId: null }
    : resolved.scopeType === 'organization' && resolved.organizationId ? { type: 'organization' as const, organizationId: resolved.organizationId } : null;
  if (!owner) return unavailable();
  const location = { owner, kind, name: record.name, resourceRef: record.packageResourceRef, revisionRef: record.publishedRevisionRef,
    version: record.version, checksum: record.checksum, rootPath: record.installDir };
  if (path.resolve(record.installDir) !== resolveOwnerScopedPackageVersionPath(location)) return unavailable();
  const store = await import('./store');
  if (!store.isCapabilityPackagePublicationAllowed(capabilityPackageLegacyStorageBinding(kind, record.name, scope), record)) {
    const state = await store.getCapabilityPackageState(record.packageResourceRef);
    const published = state?.currentPublishedRevisionRef === record.publishedRevisionRef
      ? await store.getCapabilityPackagePublishedRevision(record.packageResourceRef, record.publishedRevisionRef) : null;
    if (!state || !published || state.kind !== kind || state.name !== record.name || state.currentSourceStamp.resourceId !== record.resourceId
      || published.kind !== kind || published.name !== record.name || published.version !== record.version || published.checksum !== record.checksum
      || !sameCapabilityStoreOrigin(record.storeOrigin, state.currentSourceStamp.storeOrigin)) return unavailable();
  }
  await verifyCapabilityPackageSnapshot(location, { verifyBytes: true });
}

export async function assertLegacyCapabilityPackageMutationAllowed(kind: CapabilityResourceType, name: string,
  scope?: CapabilityDataStorageScope | null, current?: RegistryPackagePointer): Promise<void> {
  if (!current?.packageManaged && !current?.packageResourceRef && !current?.publishedRevisionRef) return;
  const binding = capabilityPackageLegacyStorageBinding(kind, name, scope);
  const store = await import('./store');
  if (!store.isCapabilityPackagePublicationAllowed(binding)) {
    throw new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'Use the versioned package editor to change this package.', 409);
  }
  await store.assertCapabilityPackageLegacyMutationAllowed(binding);
}

export async function assertCapabilityPackageRegistryWriteAllowed(kind: CapabilityResourceType,
  previous: Record<string, RegistryPackagePointer>, next: Record<string, RegistryPackagePointer>,
  scope?: CapabilityDataStorageScope | null): Promise<void> {
  for (const name of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const before = previous[name], after = next[name];
    if (!before?.packageManaged && !before?.packageResourceRef && !before?.publishedRevisionRef
      && !after?.packageManaged && !after?.packageResourceRef && !after?.publishedRevisionRef) {
      if (after?.storeOrigin !== undefined) {
        const resourceId = after.resourceId ?? capabilityPackageLegacyStorageBinding(kind, name, scope).resourceId;
        if (!normalizeCapabilityStoreOrigin(after.storeOrigin, resourceId)
          || !sameCapabilityStoreOrigin(before?.storeOrigin, after.storeOrigin) && !isIssuedCapabilityStoreOrigin(after.storeOrigin, resourceId)) {
          throw new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'A changed Store origin requires a verified exact import.', 409);
        }
      }
      continue;
    }
    const binding = capabilityPackageLegacyStorageBinding(kind, name, scope);
    const store = await import('./store');
    if (before && after && before.version === after.version && before.checksum === after.checksum
      && before.installDir === after.installDir && before.packageManaged === after.packageManaged
      && before.enabled === after.enabled && before.packageDefaultEnabled === after.packageDefaultEnabled
      && before.packageResourceRef === after.packageResourceRef && before.publishedRevisionRef === after.publishedRevisionRef
      && sameCapabilityStoreOrigin(before.storeOrigin, after.storeOrigin)) {
      if (!store.isCapabilityPackagePublicationAllowed(binding, after)) {
        if (!after.packageManaged || !after.packageResourceRef || !after.publishedRevisionRef) {
          throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The installed package publication is unavailable.', 503);
        }
        await store.assertCapabilityPackageCommittedReference({ resourceRef: after.packageResourceRef,
          revisionRef: after.publishedRevisionRef, version: after.version, checksum: after.checksum, storeOrigin: after.storeOrigin });
      }
      continue;
    }
    if (!after || !store.isCapabilityPackagePublicationAllowed(binding, after)) {
      if (before && after && store.isCapabilityPackageActivationAllowed(binding, before, after)) continue;
      throw new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'The managed package pointer can only change through publication.', 409);
    }
    await store.assertCapabilityPackageLegacyMutationAllowed(binding, after);
  }
}

export async function stageCapabilityPackageRegistryPointer(authorization: AuthorizedCapabilityPackageResource,
  snapshot: CapabilityPackagePreparedSnapshot, input?: { enabled?: boolean; newResource?: boolean }) {
  const binding = authorization.record.storage;
  const store = await import('./store');
  const storeOrigin = store.getCapabilityPackagePublicationStoreOrigin(binding);
  const next = { version: snapshot.location.version, checksum: snapshot.location.checksum, installDir: snapshot.location.rootPath, storeOrigin };
  if (!store.isCapabilityPackagePublicationAllowed(binding, next) || binding.resourceType !== snapshot.location.kind
    || binding.name !== snapshot.location.name || authorization.record.metadata.resourceRef !== snapshot.location.resourceRef) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'An authorized exact package publication is required.', 403);
  }
  const scope = capabilityPackageRegistryStorage(binding);
  await verifyCapabilityPackageSnapshot(snapshot.location);
  const filePath = registryPath(binding.resourceType, scope);
  const original = await fs.readFile(filePath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  const validated = await validateCompleteCapabilityPackage(binding.resourceType, snapshot.location.rootPath,
    { name: binding.name, version: snapshot.location.version });
  if (validated.checksum !== snapshot.location.checksum) invalid('The sealed package checksum does not match its publication.');
  let record: CanvasPluginInstallRecord | CanvasSkillInstallRecord;
  if (binding.resourceType === 'plugin') {
    const registry = await readCanvasPluginRegistry(scope), previous = registry.plugins[binding.name];
    if (input?.newResource && previous) throw new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'A plugin with this name is already installed in the target scope.', 409);
    record = await buildPublishedCanvasPluginRecord(snapshot.location.rootPath, { scope, resourceId: binding.resourceId,
      revision: (previous?.revision || 0) + 1, packageResourceRef: snapshot.location.resourceRef,
      publishedRevisionRef: snapshot.location.revisionRef, enabled: input?.enabled ?? previous?.enabled ?? false,
      installedBy: authorization.actor.userId, previous, storeOrigin });
    registry.plugins[binding.name] = record;
    await writeCanvasPluginRegistry(registry, scope);
  } else {
    const registry = await readCanvasSkillRegistry(scope), previous = registry.skills[binding.name];
    const plugins = await readCanvasPluginRegistry(scope);
    const { isCoreSkillName } = await import('@/app/lib/skills/core-skills');
    if (isCoreSkillName(binding.name) || input?.newResource && (previous || Object.values(plugins.plugins).some(plugin => plugin.skills.some(skill => skill.name === binding.name)))) {
      throw new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'A skill with this name is reserved or already installed in the target scope.', 409);
    }
    const now = new Date().toISOString();
    record = { ...previous, resourceId: binding.resourceId, scopeType: binding.scopeType,
      ...(input?.enabled === undefined ? {} : { packageDefaultEnabled: input.enabled }),
      organizationId: binding.organizationId, ownerUserId: binding.ownerUserId,
      revision: (previous?.revision || 0) + 1, packageManaged: true, packageResourceRef: snapshot.location.resourceRef,
      publishedRevisionRef: snapshot.location.revisionRef, name: binding.name, version: validated.version,
      description: validated.description, license: validated.skill?.license, sourceType: previous?.sourceType || 'local',
      sourcePath: previous?.sourcePath || `capability-package:${snapshot.location.resourceRef}`,
      installedAt: previous?.installedAt || now, updatedAt: now, checksum: validated.checksum, installDir: snapshot.location.rootPath,
      skillPath: requirePathInside(snapshot.location.rootPath, 'SKILL.md'), interface: await loadCanvasSkillInterface(snapshot.location.rootPath), storeOrigin };
    registry.skills[binding.name] = record;
    await writeCanvasSkillRegistry(registry, scope);
  }
  return { record, rollback: async () => {
    const registry = JSON.parse(await fs.readFile(filePath, 'utf8')) as { plugins?: Record<string, RegistryPackagePointer>; skills?: Record<string, RegistryPackagePointer> };
    const current = (binding.resourceType === 'plugin' ? registry.plugins : registry.skills)?.[binding.name];
    if (!current || current.packageResourceRef !== snapshot.location.resourceRef || current.publishedRevisionRef !== snapshot.location.revisionRef
      || current.installDir !== snapshot.location.rootPath || current.checksum !== snapshot.location.checksum) {
      throw new CapabilityPackageError('PACKAGE_REVISION_CONFLICT', 'The staged package pointer changed before rollback.', 409);
    }
    if (original === null) await fs.rm(filePath);
    else {
      const temporary = createAtomicTempPath(filePath);
      try { await fs.writeFile(temporary, original, 'utf8'); await fs.rename(temporary, filePath); }
      finally { await fs.rm(temporary, { force: true }); }
    }
  } };
}
