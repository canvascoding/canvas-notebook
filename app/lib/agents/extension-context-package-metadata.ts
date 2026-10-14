import 'server-only';

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { loadCapabilityCandidates } from '@/app/lib/capabilities/catalog';
import { resolveEffectiveCapabilities } from '@/app/lib/capabilities/effective-resolver';
import { CapabilityPolicyStore } from '@/app/lib/capabilities/policy-store';
import type { CapabilityCandidate, CapabilityPolicy, EffectiveCapabilitySnapshot } from '@/app/lib/capabilities/types';
import { capabilityResourceStorageBinding } from '@/app/lib/capabilities/resources/storage-binding';
import { withAuthorizedCapabilityPackageResource } from '@/app/lib/capabilities/resources/store';
import type { CapabilityResourceStorageBinding } from '@/app/lib/capabilities/resources/contracts';
import { findCapabilityPackageStateForStorage, getCapabilityPackagePublishedRevision } from '@/app/lib/capabilities/packages/store';
import type { CapabilityPackagePublishedRevision, CapabilityPackagePublishedLocation } from '@/app/lib/capabilities/packages/contracts';
import { readPackageExtensionSourceMetadata, type PackageExtensionSourceMetadata } from '@/app/lib/capabilities/packages/extension-metadata';
import { normalizeCapabilityPackageRelativePath, resolveOwnerScopedPackageVersionPath, verifyCapabilityPackageSnapshot } from '@/app/lib/capabilities/packages/io';
import { projectPackageExtensionSelection } from '@/app/lib/capabilities/packages/extension-projection';
import type { StoredPackageExtensionSelectionEntry } from '@/app/lib/capabilities/extensions/stored-package-contracts';
import { projectExtensionPackageMetadata, projectExtensionSkillMetadata, projectPinnedExtensionSkillCandidates,
  projectPinnedExtensionEffectiveCapabilities, selectExtensionRuntimeSkillCandidates,
  type ExtensionPackageMetadata, type ExtensionSkillMetadata } from '@/app/lib/capabilities/packages/extension-context-metadata';
import { parseSkillFile } from '@/app/lib/skills/canvas-skill-manifest';
import { resolveVerifiedAgentActorContextOnConnection } from './actor-context';
import type { AgentManagementActor } from './management-actions';
import { AgentWorkflowError, type AgentWorkflowInternalSnapshot, type StoredAgentWorkflowPackage } from './workflow-contracts';
import type { ExplicitAgentWorkflowVersion } from './workflow-version';

/** Server-resolved inputs, never source authority by themselves. */
export type AgentExtensionPackageContextSelection = {
  stored: StoredAgentWorkflowPackage;
  storage: CapabilityResourceStorageBinding;
  extensionSelections?: readonly StoredPackageExtensionSelectionEntry[];
};
export type PreparedAgentExtensionContextPackageSource = AgentExtensionPackageContextSelection & {
  published: CapabilityPackagePublishedRevision;
};
export type AgentExtensionPackageContext = {
  packages: ExtensionPackageMetadata[];
  skills: ExtensionSkillMetadata[];
  configurations: readonly StoredAgentWorkflowPackage[];
  fingerprint: string;
};
type SourceState = { effective: EffectiveCapabilitySnapshot; policies: CapabilityPolicy[]; role: string | null };
type Guard = { storage: CapabilityResourceStorageBinding; parentStorage?: CapabilityResourceStorageBinding };
type HeldSources = { database: SqlConnection; actorScope: string; transactionId: string;
  sourceKeys: ReadonlySet<string>; active: boolean };
const sourceGuardKey = Symbol.for('canvas.agent.extension-context-source-guards.v1');
const sourceGuardHost = globalThis as typeof globalThis & { [sourceGuardKey]?: AsyncLocalStorage<HeldSources> };
// Static and dynamic Next server chunks must share the same private transaction context.
const heldSources = sourceGuardHost[sourceGuardKey] ??= new AsyncLocalStorage<HeldSources>();
type Pinned = PreparedAgentExtensionContextPackageSource & { candidate: CapabilityCandidate;
  location: CapabilityPackagePublishedLocation; metadata: PackageExtensionSourceMetadata; skills: CapabilityCandidate[] };
const resourceActor = (actor: AgentManagementActor) => ({ userId: actor.userId, workspaceId: actor.workspaceId });
function fail(message: string): never { throw new AgentWorkflowError('AGENT_EXTENSION_CONTEXT_SOURCE_CHANGED', message, 409); }

function actorScope(actor: AgentManagementActor, effective: EffectiveCapabilitySnapshot): string {
  return JSON.stringify([actor.userId, effective.organizationId || null, effective.workspaceId ?? null,
    effective.projectId ?? null, actor.sourceAgentId ?? null, actor.sessionId ?? null]);
}
function sourceKey(storage: CapabilityResourceStorageBinding, parentStorage?: CapabilityResourceStorageBinding): string {
  return JSON.stringify([capabilityResourceStorageBinding(storage),
    parentStorage ? capabilityResourceStorageBinding(parentStorage) : null]);
}
async function transactionId(database: SqlConnection): Promise<string> {
  const row = await database.get('SELECT txid_current()::text AS transaction_id') as { transaction_id?: unknown } | undefined;
  if (typeof row?.transaction_id !== 'string' || !/^[0-9]+$/u.test(row.transaction_id)) fail('The source lock transaction is unavailable.');
  return row.transaction_id;
}
async function requireHeldSources(database: SqlConnection, actor: AgentManagementActor,
  effective?: EffectiveCapabilitySnapshot, storage?: CapabilityResourceStorageBinding,
  parentStorage?: CapabilityResourceStorageBinding): Promise<void> {
  const held = heldSources.getStore();
  if (!held?.active || held.database !== database
    || effective && held.actorScope !== actorScope(actor, effective)
    || storage && !held.sourceKeys.has(sourceKey(storage, parentStorage))) {
    fail('The current package sources were not held before the Agent lock. Retry the configuration.');
  }
  if (await transactionId(database) !== held.transactionId || !held.active) fail('The source lock transaction changed. Retry the configuration.');
}

async function readSourceState(database: SqlConnection, actor: AgentManagementActor): Promise<SourceState> {
  const verified = await resolveVerifiedAgentActorContextOnConnection(actor, database);
  const context = { userId: actor.userId, organizationId: verified.organizationId ?? '', role: verified.organizationRole,
    workspaceId: verified.context.workspaceId, projectId: verified.context.projectId };
  const candidates = await loadCapabilityCandidates(context, { resolveConnections: false, database });
  const policies = verified.organizationId ? await new CapabilityPolicyStore(database).listOrganizationPolicies(verified.organizationId) : [];
  return { role: verified.organizationRole, policies, effective: resolveEffectiveCapabilities({ context,
    candidates: candidates.map(candidate => candidate.ref.resourceType === 'plugin' ? { ...candidate, connectionRequirementCount: 0 } : candidate), policies }) };
}

function sourceCandidate(effective: EffectiveCapabilitySnapshot,
  binding: Pick<CapabilityResourceStorageBinding, 'resourceId' | 'resourceType' | 'scopeType' | 'name'>): CapabilityCandidate {
  const candidate = effective.capabilities.find(candidate => candidate.ref.resourceId === binding.resourceId);
  if (!candidate || !candidate.runtimePath || candidate.ref.resourceType !== binding.resourceType || candidate.ref.scopeType !== binding.scopeType
    || candidate.ref.name !== binding.name || candidate.ref.sourceType === 'core' || candidate.ref.sourceType === 'plugin') {
    return fail('The exact configured package source is unavailable.');
  }
  return candidate;
}

async function readPublished(database: SqlConnection, storage: CapabilityResourceStorageBinding,
  stored: StoredAgentWorkflowPackage): Promise<CapabilityPackagePublishedRevision> {
  const state = await findCapabilityPackageStateForStorage(storage, database);
  const published = state?.resourceRef === stored.resourceRef
    ? await getCapabilityPackagePublishedRevision(stored.resourceRef, stored.publishedRevisionRef, database) : null;
  if (!published || published.checksum !== stored.checksum || published.kind !== storage.resourceType) {
    return fail('The exact configured package pin changed.');
  }
  return published;
}

/** Preparation only; these source facts are freshly authorized again under the caller's write transaction. */
export async function prepareAgentExtensionContextPackageSources(actor: AgentManagementActor,
  snapshot: AgentWorkflowInternalSnapshot): Promise<PreparedAgentExtensionContextPackageSource[]> {
  if (snapshot.workflowVersion === null) return [];
  const database = await openDb();
  let state: SourceState;
  try { state = await readSourceState(database, actor); } finally { await database.close(); }
  const result: PreparedAgentExtensionContextPackageSource[] = [];
  for (const binding of snapshot.bindings) {
    const { resourceType, resourceId, scopeType, name } = binding;
    if (resourceType === 'connection') continue;
    if (!binding.configuration) fail('An explicit package binding has no exact configuration.');
    const candidate = sourceCandidate(state.effective, { resourceType, resourceId, scopeType, name });
    const storage = capabilityResourceStorageBinding(candidate.ref);
    const stored = binding.configuration;
    const published = await withAuthorizedCapabilityPackageResource(resourceActor(actor), storage, 'use', undefined,
      async (authorization, connection) => {
        if (authorization.record.metadata.resourceRef !== stored.resourceRef) fail('The exact package resource changed.');
        return readPublished(connection, storage, stored);
      });
    result.push({ stored, storage, published,
      ...(binding.extensionSelections ? { extensionSelections: binding.extensionSelections } : {}) });
  }
  return result.sort((left, right) => left.storage.resourceId.localeCompare(right.storage.resourceId));
}

/** Caller owns BEGIN/COMMIT. Hold sources before locking an Agent row; never borrow another lock transaction. */
export async function withAgentExtensionContextPackageSources<T>(database: SqlConnection, actor: AgentManagementActor,
  sources: readonly PreparedAgentExtensionContextPackageSource[], callback: () => Promise<T>): Promise<T> {
  if (heldSources.getStore()?.active) fail('Package source guards cannot acquire a new source set inside an active callback.');
  const actualTransactionId = await transactionId(database);
  const state = await readSourceState(database, actor), guards = new Map<string, Guard>();
  const add = (input: Guard) => {
    const guard = { storage: capabilityResourceStorageBinding(input.storage),
      ...(input.parentStorage ? { parentStorage: capabilityResourceStorageBinding(input.parentStorage) } : {}) };
    const previous = guards.get(guard.storage.resourceId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(guard)) fail('A source storage binding changed.');
    guards.set(guard.storage.resourceId, guard);
  };
  for (const source of sources) add({ storage: source.storage });
  for (const candidate of state.effective.capabilities) {
    if (candidate.ref.resourceType !== 'skill' || candidate.ref.sourceType === 'core' || candidate.effectivePolicy !== 'required'
      || !candidate.effectiveEnabled || candidate.readiness !== 'available' || candidate.resourceAccess?.canUse === false || !candidate.runtimePath) continue;
    const storage = capabilityResourceStorageBinding(candidate.ref);
    if (candidate.ref.sourceType === 'plugin') {
      const parent = state.effective.capabilities.find(value => value.ref.resourceType === 'plugin'
        && value.ref.resourceId === candidate.ref.sourcePluginId && value.ref.resourceId === candidate.pluginResourceId);
      if (!parent) fail('The required skill parent is unavailable.');
      const parentStorage = capabilityResourceStorageBinding(parent.ref);
      add({ storage: parentStorage }); add({ storage, parentStorage });
    } else add({ storage });
  }
  const ordered = [...guards.values()].sort((left, right) => left.storage.resourceId.localeCompare(right.storage.resourceId));
  const hold = async (index: number): Promise<T> => {
    if (index === ordered.length) {
      if (await transactionId(database) !== actualTransactionId) fail('Package sources require the same active write transaction.');
      const held: HeldSources = { database, actorScope: actorScope(actor, state.effective), transactionId: actualTransactionId,
        sourceKeys: new Set(ordered.map(guard => sourceKey(guard.storage, guard.parentStorage))), active: true };
      try { return await heldSources.run(held, callback); } finally { held.active = false; }
    }
    const guard = ordered[index];
    return withAuthorizedCapabilityPackageResource(resourceActor(actor), guard.storage, 'use', undefined,
      async (authorization, connection) => {
        for (const source of sources.filter(source => source.storage.resourceId === guard.storage.resourceId)) {
          if (authorization.record.metadata.resourceRef !== source.stored.resourceRef) fail('The configured source resource changed.');
          await readPublished(connection, guard.storage, source.stored);
        }
        return hold(index + 1);
      }, { database, ...(guard.parentStorage ? { parentStorage: guard.parentStorage } : {}) });
  };
  return hold(0);
}

function validateInventory(metadata: PackageExtensionSourceMetadata, published: CapabilityPackagePublishedRevision): void {
  const names = new Set<string>(), roots = new Set<string>();
  for (const child of metadata.skills) {
    if (child.relativeRoot) normalizeCapabilityPackageRelativePath(child.relativeRoot);
    if (published.kind === 'skill' && child.relativeRoot !== '' || roots.has(child.relativeRoot) || names.has(child.skill.name)
      || !published.files.some(file => file.path === (child.relativeRoot ? `${child.relativeRoot}/SKILL.md` : 'SKILL.md'))) fail('The immutable package skill inventory changed.');
    names.add(child.skill.name); roots.add(child.relativeRoot);
  }
}

async function presentAdditionalSkill(database: SqlConnection, actor: AgentManagementActor, candidate: CapabilityCandidate,
  effective: EffectiveCapabilitySnapshot): Promise<ExtensionSkillMetadata> {
  const required = effective.capabilities.find(value => value.ref.resourceId === candidate.ref.resourceId)?.effectivePolicy === 'required';
  if (candidate.ref.sourceType === 'core') {
    const skill = await parseSkillFile(candidate.runtimePath!);
    if (!skill || skill.name !== candidate.ref.name) return fail('A bundled skill source changed.');
    return projectExtensionSkillMetadata({ candidate, skill, required });
  }
  const storage = capabilityResourceStorageBinding(candidate.ref);
  const parent = candidate.ref.sourceType === 'plugin' ? effective.capabilities.find(value => value.ref.resourceType === 'plugin'
    && value.ref.resourceId === candidate.ref.sourcePluginId && value.ref.resourceId === candidate.pluginResourceId) : undefined;
  if (candidate.ref.sourceType === 'plugin' && !parent) return fail('A required skill parent changed.');
  const parentStorage = parent ? capabilityResourceStorageBinding(parent.ref) : undefined;
  // A new required policy can appear after the initial sorted locks and Agent row
  // lock. Refuse that source before SourceUse can acquire any additional lock.
  await requireHeldSources(database, actor, effective, storage, parentStorage);
  return withAuthorizedCapabilityPackageResource(resourceActor(actor), storage, 'use', undefined, async (authorization, connection) => {
    const state = await findCapabilityPackageStateForStorage(parentStorage ?? storage, connection);
    if (!state) {
      if (candidate.runtimePath!.split(path.sep).join('/').includes('/capability-packages/published/')) return fail('The published skill authority is unavailable.');
      const skill = await parseSkillFile(candidate.runtimePath!);
      if (!skill || skill.name !== candidate.ref.name) return fail('The required skill source changed.');
      return projectExtensionSkillMetadata({ candidate, skill, required });
    }
    const published = await getCapabilityPackagePublishedRevision(state.resourceRef, state.currentPublishedRevisionRef, connection);
    if (!published) return fail('The current required skill pin is unavailable.');
    const location: CapabilityPackagePublishedLocation = { ...published, owner: authorization.record.metadata.ownership,
      rootPath: resolveOwnerScopedPackageVersionPath({ ...published, owner: authorization.record.metadata.ownership }) };
    const relativeRoot = parentStorage ? path.relative(location.rootPath, path.dirname(candidate.runtimePath!)).split(path.sep).join('/') : '';
    if (parentStorage && relativeRoot) normalizeCapabilityPackageRelativePath(relativeRoot);
    if (path.dirname(path.resolve(candidate.runtimePath!)) !== path.resolve(location.rootPath, ...relativeRoot.split('/').filter(Boolean))
      || !published.files.some(file => file.path === (relativeRoot ? `${relativeRoot}/SKILL.md` : 'SKILL.md'))) return fail('The required skill path no longer matches its actual pin.');
    await verifyCapabilityPackageSnapshot(location);
    if (parentStorage && relativeRoot === '' && !(await readPackageExtensionSourceMetadata(location)).skills.some(child =>
      child.relativeRoot === '' && child.skill.name === candidate.ref.name)) return fail('The required root skill is not declared by its held parent.');
    const skill = await parseSkillFile(candidate.runtimePath!, { validateDirectoryName: !(parentStorage && relativeRoot === '') });
    if (!skill || skill.name !== candidate.ref.name) return fail('The required skill identity changed.');
    await verifyCapabilityPackageSnapshot(location);
    return projectExtensionSkillMetadata({ candidate, skill, required, runtimePath: skill.path, package: { resourceRef: published.resourceRef,
      publishedRevisionRef: published.revisionRef, checksum: published.checksum, kind: published.kind, relativeRoot } });
  }, { database, ...(parentStorage ? { parentStorage } : {}) });
}

/** Exact pending SQL configuration -> presentation, without an Agent session or issued runtime selection. */
export async function buildAgentExtensionPackageContextOnConnection(input: { database: SqlConnection; actor: AgentManagementActor;
  snapshot: AgentWorkflowInternalSnapshot }): Promise<AgentExtensionPackageContext> {
  const { database, actor, snapshot } = input;
  await requireHeldSources(database, actor);
  const { readManagedAgentWorkflowOnConnection } = await import('./workflow-configuration');
  const current = await readManagedAgentWorkflowOnConnection(database, snapshot.agent.agentId);
  if (current.agent.id !== snapshot.agent.id || current.agent.revision !== snapshot.agent.revision
    || current.workflowRevision !== snapshot.workflowRevision || JSON.stringify(current.bindings) !== JSON.stringify(snapshot.bindings)) fail('The pending Agent configuration changed.');
  if (current.workflowVersion === null) fail('This preflight requires an explicit package configuration.');
  const state = await readSourceState(database, actor);
  await requireHeldSources(database, actor, state.effective);
  const packageSelections = current.bindings.flatMap(binding => {
    const { resourceType, resourceId, scopeType, name } = binding;
    if (resourceType === 'connection') return [];
    if (!binding.configuration) return fail('An explicit binding has no exact package configuration.');
    const candidate = sourceCandidate(state.effective, { resourceType, resourceId, scopeType, name });
    return [{ stored: binding.configuration, storage: capabilityResourceStorageBinding(candidate.ref),
      ...(binding.extensionSelections ? { extensionSelections: binding.extensionSelections } : {}) }];
  });
  const assembled = await assembleAgentExtensionPackageContextOnConnection({ database, actor,
    workflowVersion: current.workflowVersion, packageSelections, relevantSkills: current.agent.relevantSkills,
    agentKind: current.agent.type === 'main' ? 'main' : 'special' });
  const fingerprint = createHash('sha256').update(JSON.stringify([current.agent.id, current.agent.revision,
    current.workflowRevision, snapshot.preferenceRevision, snapshot.choices, assembled.fingerprint])).digest('hex');
  return { ...assembled, fingerprint };
}

/**
 * Assemble exact, server-resolved package selections without an Agent or session.
 * Presentation only: the caller must already hold the genuine sources in this
 * same transaction. The supplied storage facts never replace fresh SourceUse.
 */
export async function assembleAgentExtensionPackageContextOnConnection(input: {
  database: SqlConnection;
  actor: AgentManagementActor;
  workflowVersion: ExplicitAgentWorkflowVersion;
  packageSelections: readonly AgentExtensionPackageContextSelection[];
  relevantSkills: readonly string[] | null;
  agentKind: 'special' | 'main';
}): Promise<AgentExtensionPackageContext> {
  const { database, workflowVersion, agentKind } = input;
  const actor = { ...input.actor };
  const packageSelections = structuredClone(input.packageSelections);
  const relevantSkills = input.relevantSkills === null ? null : [...input.relevantSkills];
  await requireHeldSources(database, actor);
  if (workflowVersion !== 1 && workflowVersion !== 2 || agentKind !== 'special' && agentKind !== 'main') {
    fail('An explicit workflow version and actual Agent kind are required.');
  }
  const state = await readSourceState(database, actor), pinned: Pinned[] = [];
  await requireHeldSources(database, actor, state.effective);
  const seen = new Set<string>();
  for (const selection of packageSelections) {
    const candidate = sourceCandidate(state.effective, selection.storage);
    const storage = capabilityResourceStorageBinding(candidate.ref), stored = selection.stored;
    if (sourceKey(storage) !== sourceKey(selection.storage) || seen.has(storage.resourceId)) {
      fail('The exact package storage binding is inconsistent or duplicated.');
    }
    seen.add(storage.resourceId);
    await requireHeldSources(database, actor, state.effective, storage);
    pinned.push(await withAuthorizedCapabilityPackageResource(resourceActor(actor), storage, 'use', undefined, async (authorization, connection) => {
      if (authorization.record.metadata.resourceRef !== stored.resourceRef) fail('The selected package resource changed.');
      const published = await readPublished(connection, storage, stored);
      const location: CapabilityPackagePublishedLocation = { ...published, owner: authorization.record.metadata.ownership,
        rootPath: resolveOwnerScopedPackageVersionPath({ ...published, owner: authorization.record.metadata.ownership }) };
      await verifyCapabilityPackageSnapshot(location);
      const metadata = await readPackageExtensionSourceMetadata(location); validateInventory(metadata, published);
      const all = projectPinnedExtensionSkillCandidates({ candidate, effective: state.effective, metadata, published,
        resourceAccess: authorization.access, resourceMetadata: authorization.record.metadata });
      const requiredRoots = stored.skillSelection.kind === 'plugin' ? metadata.skills.filter(child => state.effective.capabilities.find(value =>
        value.ref.resourceId === all.find(value => value.ref.name === child.skill.name)?.ref.resourceId)?.effectivePolicy === 'required').map(child => child.relativeRoot) : [];
      const projection = projectPackageExtensionSelection({ source: stored, kind: published.kind,
        inventory: metadata.skills.map(child => ({ name: child.skill.name, relativeRoot: child.relativeRoot })), selections: selection.extensionSelections, requiredRoots });
      const skills = all.filter(candidate => metadata.skills.some(child => child.skill.name === candidate.ref.name && projection.selectedRoots.includes(child.relativeRoot)));
      await verifyCapabilityPackageSnapshot(location);
      return { stored: projection.configuration, storage, published, location, metadata, skills,
        candidate: { ...candidate, resourceAccess: authorization.access, resourceMetadata: authorization.record.metadata } };
    }, { database }));
  }
  const effective = projectPinnedExtensionEffectiveCapabilities({ effective: state.effective, workflowVersion,
    packages: pinned, role: state.role, policies: state.policies });
  for (const source of pinned) for (const candidate of [source.candidate, ...source.skills]) {
    const actual = effective.capabilities.find(value => value.ref.resourceId === candidate.ref.resourceId);
    if (!actual?.effectiveEnabled || actual.readiness !== 'available' || actual.resourceAccess?.canUse === false) fail('A configured package or child is no longer usable.');
  }
  const presentPinnedSkill = (source: Pinned, candidate: CapabilityCandidate) => {
    const child = source.metadata.skills.find(child => child.skill.name === candidate.ref.name)!;
    return projectExtensionSkillMetadata({ candidate, skill: child.skill,
      required: effective.capabilities.find(value => value.ref.resourceId === candidate.ref.resourceId)?.effectivePolicy === 'required',
      package: { resourceRef: source.published.resourceRef, publishedRevisionRef: source.published.revisionRef,
        checksum: source.published.checksum, kind: source.published.kind, relativeRoot: child.relativeRoot } });
  };
  const packages = pinned.map(source => projectExtensionPackageMetadata({ published: source.published, configuration: source.stored,
    metadata: source.metadata, skills: source.skills.map(candidate => presentPinnedSkill(source, candidate)), workflowVersion }));
  const selected = selectExtensionRuntimeSkillCandidates({ effective, agentKind,
    relevantSkills, workflowVersion, packageSkills: pinned.flatMap(source => source.skills) });
  const skills: ExtensionSkillMetadata[] = [];
  for (const candidate of selected) {
    const source = pinned.find(source => source.skills.some(value => value.ref.resourceId === candidate.ref.resourceId));
    skills.push(source ? presentPinnedSkill(source, candidate) : await presentAdditionalSkill(database, actor, candidate, effective));
  }
  for (const source of pinned) await verifyCapabilityPackageSnapshot(source.location);
  await requireHeldSources(database, actor, effective);
  const fingerprint = createHash('sha256').update(JSON.stringify([actorScope(actor, effective), workflowVersion,
    agentKind, relevantSkills, effective.snapshotId, pinned.map(source => source.stored), packages, skills])).digest('hex');
  return { packages, skills, configurations: Object.freeze(pinned.map(source => source.stored)), fingerprint };
}
