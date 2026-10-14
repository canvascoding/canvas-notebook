import 'server-only';

import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { openDb, type SqlConnection } from '@/app/lib/db';
import { resolveVerifiedAgentActorContextOnConnection } from '@/app/lib/agents/actor-context';
import { readStoredAgentWorkspaceOnConnection, workspaceToAgentExecutionContext } from '@/app/lib/pi/session-workspace-context';
import { readManagedAgentWorkflow } from '@/app/lib/agents/workflow-configuration';
import { resolveSettingsStoragePath, resolveLegacySettingsStoragePath } from '@/app/lib/settings-storage';
import { resolveUserSettingsDir } from '@/app/lib/runtime-data-paths';
import { readIntegrationToolGatewayAvailability } from '@/app/lib/integration-tool-gateway-availability';

import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { loadCapabilityCandidates, resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import { resolveEffectiveCapabilities } from '@/app/lib/capabilities/effective-resolver';
import { CapabilityPolicyStore, withCapabilityPolicyStore } from '@/app/lib/capabilities/policy-store';
import { resolveCapabilityExecutionContextForUser } from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import type { CapabilityCandidate, EffectiveCapabilitySnapshot } from '@/app/lib/capabilities/types';
import { capabilityResourceStorageBinding } from '../resources/storage-binding';
import { findCapabilityResourceRecord, withAuthorizedCapabilityPackageResource } from '../resources/store';
import type { CapabilityResourceStorageBinding } from '../resources/contracts';
import { selectPromptSkillsForAgent } from '@/app/lib/skills/agent-skill-selection';
import { parseSkillFile, type CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
import { getSkillsContext } from '@/app/lib/skills/skill-context';
import { CapabilityPackageError, type CapabilityPackagePublishedLocation, type CapabilityPackagePublishedRevision } from './contracts';
import { findCapabilityPackageStateForStorage, getCapabilityPackagePublishedRevision } from './store';
import { normalizeCapabilityPackageRelativePath, resolveOwnerScopedPackageVersionPath, verifyCapabilityPackageSnapshot } from './io';
import type { AgentWorkflowInternalSnapshot, StoredAgentWorkflowPackage } from '@/app/lib/agents/workflow-contracts';
import { isExplicitAgentWorkflowVersion, type AgentWorkflowVersion } from '@/app/lib/agents/workflow-version';
import { DEFAULT_MANAGED_AGENT_ID } from '@/app/lib/agents/storage';
import { chatExtensionSelectionSchema, type ExtensionSelectionEntry, type ExtensionPackagePin } from '@/app/lib/capabilities/extensions/contracts';
import type { StoredPackageExtensionSelectionEntry } from '@/app/lib/capabilities/extensions/stored-package-contracts';
import { applyPackageExtensionTurnFocus, projectPackageExtensionSelection } from './extension-projection';
import { readPackageExtensionSourceMetadata, type PackageExtensionSourceMetadata } from './extension-metadata';
import { projectExtensionSkillMetadata, projectExtensionPackageMetadata, projectPinnedExtensionSkillCandidates, selectExtensionRuntimeSkillCandidates,
  projectPinnedExtensionEffectiveCapabilities, compactExtensionMetadata as compactMetadata,
  type ExtensionSkillMetadata, type ExtensionPackageMetadata } from './extension-context-metadata';
import type { HeldDelegatedExtensionSource } from '@/app/lib/capabilities/extensions/delegation-source';

/** Server-only receipt. Its strings are not authority; the private issued proof is required. */
export type HeldCapabilityPackageRuntimeBinding = Readonly<{
  resourceRef: string;
  publishedRevisionRef: string;
  checksum: string;
  childRelativeRoot: string;
  skillName: string;
  resourceId: string;
  runtimePath: string;
}>;

type BindingProof = {
  actorKey: string;
  storage: CapabilityResourceStorageBinding;
  parentStorage?: CapabilityResourceStorageBinding;
  candidate: CapabilityCandidate;
  parentCandidate?: CapabilityCandidate;
  location: CapabilityPackagePublishedLocation;
  published: CapabilityPackagePublishedRevision;
};
type RuntimeBindingRegistry = { issued: WeakSet<object>; proofs: WeakMap<object, BindingProof> };
const registryKey = Symbol.for('canvas.capability.package-runtime-bindings.v1');
const shared = globalThis as typeof globalThis & { [registryKey]?: RuntimeBindingRegistry };
const registry = shared[registryKey] ??= { issued: new WeakSet(), proofs: new WeakMap() };

/** Private server-only selection; package strings alone never authorize execution. */
export type AuthorizedAgentWorkflowPackageSelections = Readonly<{
  workflowVersion: AgentWorkflowVersion;
  workflowRevision: number;
  packages: readonly StoredAgentWorkflowPackage[];
  fingerprint: string;
  snapshot: AgentWorkflowInternalSnapshot;
}>;
type PinnedPackage = { configuration: StoredAgentWorkflowPackage; sourceConfiguration: StoredAgentWorkflowPackage; candidate: CapabilityCandidate;
  storage: CapabilityResourceStorageBinding; location: CapabilityPackagePublishedLocation;
  published: CapabilityPackagePublishedRevision; skills: CapabilityCandidate[]; metadata: PackageExtensionSourceMetadata;
  extensionSelections?: readonly StoredPackageExtensionSelectionEntry[]; turnSelections: readonly ExtensionSelectionEntry[] };
type WorkflowSelectionProof = { actorKey: string; effective: EffectiveCapabilitySnapshot; pinned: PinnedPackage[];
  delegatedSource?: HeldDelegatedExtensionSource; admissionStamp?: string };
const workflowRegistryKey = Symbol.for('canvas.capability.workflow-package-selections.v1');
const workflowGlobal = globalThis as typeof globalThis & { [workflowRegistryKey]?: WeakMap<object, WorkflowSelectionProof> };
const workflowRegistry = workflowGlobal[workflowRegistryKey] ??= new WeakMap<object, WorkflowSelectionProof>();

export type AuthorizedAgentWorkflowSkillMetadata = ExtensionSkillMetadata;
export type AuthorizedAgentWorkflowPackageMetadata = ExtensionPackageMetadata;
export type AuthorizedAgentWorkflowDiscoveryPackage = Readonly<{
  resourceId: string; resourceRef?: string; name: string; title: string; description: string;
  status: 'ready' | 'setup_required' | 'unavailable';
  package?: Readonly<{ resourceRef: string; publishedRevisionRef: string; checksum: string }>;
}>;

function freezeProjection<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeProjection(child);
    Object.freeze(value);
  }
  return value;
}
function requireWorkflowProof(selection: AuthorizedAgentWorkflowPackageSelections, context: AgentExecutionContext): WorkflowSelectionProof {
  const proof = workflowRegistry.get(selection);
  if (!proof || proof.actorKey !== actorKey(context) || proof.delegatedSource !== context.delegatedExtensionSource) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The issued package selection is unavailable for this context.', 403);
  }
  return proof;
}
function frozenSkillMetadata(candidate: CapabilityCandidate, skill: CanvasSkill, proof: WorkflowSelectionProof,
  binding?: HeldCapabilityPackageRuntimeBinding): AuthorizedAgentWorkflowSkillMetadata {
  const held = proof.pinned.find(entry => entry.skills.some(value => value.ref.resourceId === candidate.ref.resourceId));
  const root = held?.configuration.selectedSkills.find(value => value.name === candidate.ref.name)?.relativeRoot;
  const bindingProof = binding && registry.proofs.get(binding);
  const source = bindingProof?.published ?? held?.published;
  const relativeRoot = binding?.childRelativeRoot ?? root;
  return projectExtensionSkillMetadata({ candidate, skill, runtimePath: binding?.runtimePath,
    required: proof.effective.capabilities.find(value => value.ref.resourceId === candidate.ref.resourceId)?.effectivePolicy === 'required',
    ...(source && relativeRoot !== undefined ? { package: { resourceRef: source.resourceRef,
      publishedRevisionRef: source.revisionRef, checksum: source.checksum, kind: source.kind, relativeRoot } } : {}) });
}

/** Exact held source only: a newer mutable package head never supplies this connector template. */
export async function getAuthorizedAgentWorkflowMcpTemplate(selection: AuthorizedAgentWorkflowPackageSelections,
  context: AgentExecutionContext, pin: ExtensionPackagePin, connectorName: string): Promise<import('./presentation-contracts').CapabilityPackageMcpTemplate> {
  const proof = requireWorkflowProof(selection, context);
  const entry = proof.pinned.find(pkg => pkg.published.resourceRef === pin.resourceRef
    && pkg.published.revisionRef === pin.publishedRevisionRef && pkg.published.checksum === pin.checksum);
  if (!entry) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'A held package source is required.', 403);
  const [{ validateCanvasPluginPackage }, { normalizeMcpConnectors }, { readPluginMcpTemplateFile },
    { projectCapabilityPackageMcpTemplateConfig }] = await Promise.all([
    import('@/app/lib/plugins/canvas-plugin-manifest'), import('@/app/lib/plugins/plugin-connection-readiness'),
    import('@/app/lib/plugins/plugin-mcp-template-service'), import('./mcp-template-projection'),
  ]);
  let connectors: readonly import('@/app/lib/plugins/canvas-plugin-manifest').CanvasPluginMcpConnector[];
  if (entry.published.kind === 'plugin') {
    const manifest = await validateCanvasPluginPackage(entry.location.rootPath);
    if (!manifest.valid || !manifest.manifest) throw new CapabilityPackageError('PACKAGE_INVALID', 'The held plugin is invalid.', 409);
    connectors = normalizeMcpConnectors(manifest.manifest.connectors);
  } else {
    connectors = (entry.metadata.skills[0]?.skill.workflow as import('@/app/lib/capabilities/workflow-contracts').SkillWorkflowManifestV1 | undefined)
      ?.mcpConnectors?.map(connector => ({ ...connector, env: connector.env ? [...connector.env] : undefined })) ?? [];
  }
  const matches = connectors.filter(connector => connector.name === connectorName);
  if (matches.length !== 1 || !matches[0].configPath) {
    throw new CapabilityPackageError('PACKAGE_NOT_FOUND', 'An exact MCP template is required to link this connection.', 409);
  }
  const connector = matches[0];
  const template = await readPluginMcpTemplateFile({ rootDir: entry.location.rootPath, configPath: connector.configPath! });
  if (!template.config) throw new CapabilityPackageError('PACKAGE_INVALID', 'The held MCP template is invalid.', 409);
  const projected = projectCapabilityPackageMcpTemplateConfig(template.config, connector.name);
  await verifyCapabilityPackageSnapshot(entry.location);
  requireWorkflowProof(selection, context);
  return { resourceRef: pin.resourceRef, source: { resourceRef: pin.resourceRef, version: entry.published.version,
    checksum: pin.checksum, artifactRevision: null }, declaredBy: { kind: entry.published.kind, name: entry.published.name },
    connector: { name: connector.name, ...(connector.oauth ? { oauth: true } : {}) }, ...projected };
}

/** Metadata and read roots use the same issued source; this helper performs no new workflow or provider discovery. */
export async function getAuthorizedAgentWorkflowSkillMetadata(selection: AuthorizedAgentWorkflowPackageSelections,
  context: AgentExecutionContext, options: { bindings?: readonly HeldCapabilityPackageRuntimeBinding[] } = {}): Promise<readonly AuthorizedAgentWorkflowSkillMetadata[]> {
  const proof = requireWorkflowProof(selection, context), result: AuthorizedAgentWorkflowSkillMetadata[] = [];
  const captured = options.bindings ?? (await captureCapabilityPackageRuntimeBindings(context, { selection })).skillPackageBindings;
  for (const candidate of selectedRuntimeSkills(proof.effective, context.agentId, selection.snapshot.agent.relevantSkills, selection)) {
    const held = proof.pinned.find(entry => entry.skills.some(value => value.ref.resourceId === candidate.ref.resourceId));
    const binding = captured.find(value => value.resourceId === candidate.ref.resourceId && isHeldCapabilityPackageRuntimeBinding(value, context)
      && (!held || value.resourceRef === held.published.resourceRef && value.publishedRevisionRef === held.published.revisionRef
        && value.checksum === held.published.checksum));
    const bindingProof = binding && registry.proofs.get(binding);
    if (!binding && (held || candidate.runtimePath!.split(path.sep).join('/').includes('/capability-packages/published/'))) continue;
    const child = held?.metadata.skills.find(value => value.skill.path === (binding?.runtimePath ?? candidate.runtimePath));
    const declaredRoot = binding?.childRelativeRoot === '' && Boolean(bindingProof?.parentStorage) && bindingProof?.published.kind === 'plugin';
    const skill = child?.skill ?? await parseSkillFile(binding?.runtimePath ?? candidate.runtimePath!, { validateDirectoryName: !declaredRoot });
    if (skill && skill.name === candidate.ref.name) result.push(frozenSkillMetadata(candidate, skill, proof, binding));
  }
  return Object.freeze(result);
}

/** Compact exact instructions are projected only for configured or explicitly referenced packages. */
export function getAuthorizedAgentWorkflowPackageMetadata(selection: AuthorizedAgentWorkflowPackageSelections,
  context: AgentExecutionContext): readonly AuthorizedAgentWorkflowPackageMetadata[] {
  const proof = requireWorkflowProof(selection, context);
  return Object.freeze(proof.pinned.map(entry => projectExtensionPackageMetadata({ published: entry.published,
    configuration: entry.configuration, metadata: entry.metadata, workflowVersion: selection.workflowVersion,
    skills: entry.skills.map(candidate => frozenSkillMetadata(candidate,
      entry.metadata.skills.find(value => value.skill.name === candidate.ref.name)!.skill, proof)) })));
}

/** Local discovery is separate from the explicit instruction index; no external catalogue or account is read. */
export async function getAuthorizedAgentWorkflowDiscoveryPackages(selection: AuthorizedAgentWorkflowPackageSelections,
  context: AgentExecutionContext): Promise<readonly AuthorizedAgentWorkflowDiscoveryPackage[]> {
  const proof = requireWorkflowProof(selection, context);
  const metadata = getAuthorizedAgentWorkflowPackageMetadata(selection, context);
  if (isExplicitAgentWorkflowVersion(selection.workflowVersion)) return Object.freeze(proof.pinned
    .filter(entry => entry.published.kind === 'plugin' && entry.configuration.skillSelection.kind === 'plugin')
    .map(entry => {
      const current = metadata.find(value => value.resourceRef === entry.published.resourceRef)!;
      return Object.freeze({ resourceId: entry.candidate.ref.resourceId, resourceRef: entry.published.resourceRef, name: current.name,
        title: current.title, description: current.description, status: 'ready' as const,
        package: Object.freeze({ resourceRef: current.resourceRef, publishedRevisionRef: current.publishedRevisionRef, checksum: current.checksum }) });
    }));
  const result: AuthorizedAgentWorkflowDiscoveryPackage[] = [];
  const selectedIds = new Set(selectedRuntimeSkills(proof.effective, context.agentId, selection.snapshot.agent.relevantSkills, selection).map(skill => skill.ref.resourceId));
  for (const candidate of proof.effective.capabilities) {
    if (candidate.ref.resourceType !== 'plugin' || !candidate.effectiveEnabled || candidate.readiness !== 'available'
      || candidate.resourceAccess?.canUse === false || !candidate.runtimePath) continue;
    if (proof.effective.capabilities.some(child => child.ref.resourceType === 'skill'
      && (child.pluginResourceId === candidate.ref.resourceId || child.ref.sourcePluginId === candidate.ref.resourceId)
      && !selectedIds.has(child.ref.resourceId))) continue;
    const base = { resourceId: candidate.ref.resourceId, ...(candidate.resourceMetadata?.resourceRef ? { resourceRef: candidate.resourceMetadata.resourceRef } : {}),
      name: candidate.ref.name, title: candidate.ref.name, description: compactMetadata(candidate.description || '', 1_024) };
    if (!base.resourceRef) { result.push(Object.freeze({ ...base, status: 'setup_required' })); continue; }
    const resourceRef = base.resourceRef;
    try {
      const published = await withAuthorizedCapabilityPackageResource({ userId: context.userId, workspaceId: context.workspaceId },
        capabilityResourceStorageBinding(candidate.ref), 'use', undefined, async (_authorization, database) => {
          const state = await findCapabilityPackageStateForStorage(capabilityResourceStorageBinding(candidate.ref), database);
          return state && state.resourceRef === resourceRef && state.currentPublishedRevisionRef
            ? await getCapabilityPackagePublishedRevision(resourceRef, state.currentPublishedRevisionRef, database) : null;
        });
      if (published && published.checksum !== candidate.ref.checksum) {
        result.push(Object.freeze({ ...base, status: 'unavailable' })); continue;
      }
      result.push(Object.freeze({ ...base, status: published ? 'ready' : 'setup_required', ...(published ? { package: Object.freeze({
        resourceRef: published.resourceRef, publishedRevisionRef: published.revisionRef, checksum: published.checksum }) } : {}) }));
    } catch {
      result.push(Object.freeze({ ...base, status: 'unavailable' }));
    }
  }
  return Object.freeze(result);
}

export function isAuthorizedAgentWorkflowPackageSelections(value: unknown,
  context: AgentExecutionContext): value is AuthorizedAgentWorkflowPackageSelections {
  if (!value || typeof value !== 'object') return false;
  const proof = workflowRegistry.get(value);
  return Boolean(proof && proof.actorKey === actorKey(context) && proof.delegatedSource === context.delegatedExtensionSource);
}

/** One fresh reader and the same local package authority serve prompt, script and integration projection. */
export async function getAuthorizedAgentWorkflowPackageSelections(
  context: AgentExecutionContext,
  options: { turnSelections?: readonly ExtensionSelectionEntry[]; delegationPackageSource?: HeldDelegatedExtensionSource } = {},
): Promise<AuthorizedAgentWorkflowPackageSelections> {
  const delegatedSource = options.delegationPackageSource ?? context.delegatedExtensionSource;
  if (delegatedSource !== context.delegatedExtensionSource) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The package source must match the actual delegated child frame.', 403);
  }
  const delegated = delegatedSource ? (await import('@/app/lib/capabilities/extensions/delegation-source'))
    .readDelegatedExtensionPackageSource(delegatedSource, context) : null;
  if (delegated && !isAuthorizedAgentWorkflowPackageSelections(delegated.selection, delegated.context)) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'An actual parent package source is required.', 403);
  }
  const { readManagedAgentWorkflow, isManagedAgentWorkflowSnapshot } = await import('@/app/lib/agents/workflow-configuration');
  const snapshot = await readManagedAgentWorkflow({ userId: context.userId, sessionId: context.sessionId,
    source: 'system', sourceAgentId: normalizeManagedAgentId(context.agentId),
    organizationId: context.organizationId, workspaceId: context.workspaceId, projectId: context.projectId },
  normalizeManagedAgentId(context.agentId));
  if (!isManagedAgentWorkflowSnapshot(snapshot) || !snapshot.access.canUse
    || snapshot.agent.agentId !== normalizeManagedAgentId(context.agentId)
    || (snapshot.workflowVersion !== null && !isExplicitAgentWorkflowVersion(snapshot.workflowVersion))) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The runtime workflow cannot be verified.', 403);
  }
  const effective = await currentSnapshot(context, false), pinned: PinnedPackage[] = [];
  const verified = new Set<string>();
  let turnSelections: ExtensionSelectionEntry[];
  try { turnSelections = chatExtensionSelectionSchema.parse(options.turnSelections !== undefined
    ? { version: 1, origin: 'turn_reference', selections: options.turnSelections }
    : context.turnExtensions ?? { version: 1, origin: 'turn_reference', selections: [] }).selections; }
  catch { throw new CapabilityPackageError('PACKAGE_INVALID', 'The turn extension selection is invalid.', 409); }
  const packageTurns = turnSelections.filter(entry => entry.selection.kind === 'plugin' || entry.selection.kind === 'skill');
  const loadPinned = async (configuration: StoredAgentWorkflowPackage, extensionSelections?: readonly StoredPackageExtensionSelectionEntry[],
    resourceId?: string, turn: readonly ExtensionSelectionEntry[] = []): Promise<PinnedPackage> => {
      const record = await findCapabilityResourceRecord(configuration.resourceRef);
      const candidate = record && effective.capabilities.find(entry => entry.ref.resourceId === record.storage.resourceId);
      if (!record || !candidate || !candidate.runtimePath || candidate.ref.sourceType === 'core'
        || candidate.ref.sourceType === 'plugin' || resourceId !== undefined && candidate.ref.resourceId !== resourceId) {
        throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The configured package is unavailable.', 403);
      }
      const storage = capabilityResourceStorageBinding(record.storage);
      const entry = await withAuthorizedCapabilityPackageResource({ userId: context.userId, workspaceId: context.workspaceId }, storage, 'use', undefined,
        async (authorization, database): Promise<PinnedPackage> => {
          const state = await findCapabilityPackageStateForStorage(storage, database);
          const published = state?.resourceRef === configuration.resourceRef
            ? await getCapabilityPackagePublishedRevision(configuration.resourceRef, configuration.publishedRevisionRef, database) : null;
          if (!published || published.checksum !== configuration.checksum || published.kind !== candidate.ref.resourceType) {
            throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The configured package revision is unavailable.', 409);
          }
          const location: CapabilityPackagePublishedLocation = { ...published, owner: authorization.record.metadata.ownership,
            rootPath: resolveOwnerScopedPackageVersionPath({ ...published, owner: authorization.record.metadata.ownership }) };
          if (!verified.has(published.revisionRef)) { await verifyCapabilityPackageSnapshot(location); verified.add(published.revisionRef); }
          const metadata = await readPackageExtensionSourceMetadata(location);
          const inventory = metadata.skills.map(child => ({ name: child.skill.name, relativeRoot: child.relativeRoot }));
          const seen = new Set<string>(), names = new Set<string>();
          for (const child of metadata.skills) {
            const selected = { name: child.skill.name, relativeRoot: child.relativeRoot };
            const relative = child.relativeRoot;
            if (relative) normalizeCapabilityPackageRelativePath(relative);
            if ((published.kind === 'skill' && relative !== '')
              || seen.has(relative) || names.has(selected.name) || !published.files.some(file => file.path === (relative ? `${relative}/SKILL.md` : 'SKILL.md'))) {
              throw new CapabilityPackageError('PACKAGE_INVALID', 'The configured skill selection is invalid.', 409);
            }
            seen.add(relative);
            names.add(selected.name);
            const skill = child.skill;
            if (!skill || skill.name !== selected.name) throw new CapabilityPackageError('PACKAGE_INVALID', 'The configured skill identity is invalid.', 409);
          }
          const allSkills = projectPinnedExtensionSkillCandidates({ candidate, effective, metadata, published,
            resourceAccess: authorization.access, resourceMetadata: authorization.record.metadata });
          const requiredRoots = configuration.skillSelection.kind === 'plugin' ? metadata.skills.filter(child => {
            const candidate = allSkills.find(value => value.ref.name === child.skill.name);
            return effective.capabilities.find(value => value.ref.resourceId === candidate?.ref.resourceId)?.effectivePolicy === 'required';
          }).map(child => child.relativeRoot) : [];
          const projection = projectPackageExtensionSelection({ source: configuration, kind: published.kind, inventory,
            selections: extensionSelections, requiredRoots });
          const selected = freezeProjection(turn.length ? applyPackageExtensionTurnFocus(projection.configuration, published.kind, turn) : projection.configuration);
          const selectedRoots = new Set(projection.selectedRoots);
          const rootsByName = new Map(inventory.map(skill => [skill.name, skill.relativeRoot]));
          return { configuration: selected, sourceConfiguration: configuration, extensionSelections, turnSelections: turn,
            candidate: { ...candidate, resourceAccess: authorization.access, resourceMetadata: authorization.record.metadata },
            storage, location, published, skills: allSkills.filter(skill => {
              const root = rootsByName.get(skill.ref.name); return root !== undefined && selectedRoots.has(root);
            }), metadata };
        });
      return entry;
  };
  if (isExplicitAgentWorkflowVersion(snapshot.workflowVersion)) {
    for (const binding of snapshot.bindings) {
      if (binding.resourceType === 'connection') continue;
      if (!binding.configuration) throw new CapabilityPackageError('PACKAGE_INVALID', 'The runtime workflow package is invalid.', 409);
      const turns = packageTurns.filter(entry => (entry.selection.kind === 'plugin' || entry.selection.kind === 'skill')
        && entry.selection.package.resourceRef === binding.configuration!.resourceRef);
      pinned.push(await loadPinned(binding.configuration, binding.extensionSelections, binding.resourceId, turns));
    }
  }
  // A managed general worker can retain many actual parent pins without
  // fabricating a >5 chat selection. Every held source is freshly authorized
  // for the real child actor and checked against this child's legacy ceiling.
  // Fixed workers retain only their own configured package sources.
  const legacyIds = new Set(selectedSkills(effective, context.agentId, snapshot.agent.relevantSkills).map(candidate => candidate.ref.resourceId));
  if (snapshot.workflowVersion === null && delegated) {
    const parent = requireWorkflowProof(delegated.selection, delegated.context);
    for (const inherited of parent.pinned) {
      const collision = pinned.find(pkg => pkg.published.resourceRef === inherited.published.resourceRef);
      if (collision) {
        if (collision.published.revisionRef !== inherited.published.revisionRef || collision.published.checksum !== inherited.published.checksum) {
          throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'Delegation cannot replace a configured package pin.', 403);
        }
        continue;
      }
      const selected = await loadPinned(inherited.configuration, undefined, inherited.storage.resourceId);
      if (normalizeManagedAgentId(context.agentId) !== DEFAULT_MANAGED_AGENT_ID
        && selected.skills.some(skill => !legacyIds.has(skill.ref.resourceId))) {
        throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'A delegated source cannot expand this agent’s inherited skill selection.', 403);
      }
      pinned.push(selected);
    }
  }
  for (const entry of packageTurns) {
    const selection = entry.selection;
    if (selection.kind !== 'plugin' && selection.kind !== 'skill' || pinned.some(pkg => pkg.configuration.resourceRef === selection.package.resourceRef)) continue;
    if (isExplicitAgentWorkflowVersion(snapshot.workflowVersion)) {
      throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'A turn cannot add a package to this fixed agent.', 403);
    }
    const record = await findCapabilityResourceRecord(selection.package.resourceRef);
    const candidate = record && effective.capabilities.find(value => value.ref.resourceId === record.storage.resourceId);
    if (!candidate?.effectiveEnabled || candidate.readiness !== 'available' || candidate.resourceAccess?.canUse === false) {
      throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'This turn package is disabled or unavailable.', 403);
    }
    const turns = packageTurns.filter(value => (value.selection.kind === 'plugin' || value.selection.kind === 'skill')
      && value.selection.package.resourceRef === selection.package.resourceRef);
    const kind = turns.some(value => value.selection.kind === 'plugin') ? 'plugin' : 'skills';
    // The actor-authorized published source supplies these skills, never a fake workflow snapshot.
    const empty: StoredAgentWorkflowPackage = { ...selection.package, version: 1,
      skillSelection: kind === 'plugin' ? { kind: 'plugin' } : { kind: 'skills', relativeRoots: [] }, selectedSkills: [], declarations: [] };
    const recordStorage = capabilityResourceStorageBinding(record!.storage);
    const source = await withAuthorizedCapabilityPackageResource({ userId: context.userId, workspaceId: context.workspaceId }, recordStorage, 'use', undefined,
      async (authorization, database) => {
        const state = await findCapabilityPackageStateForStorage(recordStorage, database);
        const published = state?.resourceRef === selection.package.resourceRef
          ? await getCapabilityPackagePublishedRevision(selection.package.resourceRef, selection.package.publishedRevisionRef, database) : null;
        if (!published || published.checksum !== selection.package.checksum) throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The turn package pin is unavailable.', 409);
        const location = { ...published, owner: authorization.record.metadata.ownership,
          rootPath: resolveOwnerScopedPackageVersionPath({ ...published, owner: authorization.record.metadata.ownership }) };
        await verifyCapabilityPackageSnapshot(location);
        const metadata = await readPackageExtensionSourceMetadata(location);
        const selectedSkills = kind === 'plugin' ? metadata.skills.map(child => ({ name: child.skill.name, relativeRoot: child.relativeRoot }))
          : metadata.skills.filter(child => turns.some(value => value.selection.kind === 'skill' && value.selection.relativeRoot === child.relativeRoot))
            .map(child => ({ name: child.skill.name, relativeRoot: child.relativeRoot }));
        return { ...empty, selectedSkills, skillSelection: kind === 'plugin' ? { kind: 'plugin' as const }
          : { kind: 'skills' as const, relativeRoots: selectedSkills.map(child => child.relativeRoot) } };
      });
    const selected = await loadPinned(source, turns as StoredPackageExtensionSelectionEntry[], record!.storage.resourceId);
    if (normalizeManagedAgentId(context.agentId) !== DEFAULT_MANAGED_AGENT_ID && selected.skills.some(skill => !legacyIds.has(skill.ref.resourceId))) {
      throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'A turn cannot expand this agent’s inherited skill selection.', 403);
    }
    pinned.push(selected);
  }
  const selectedIds = new Set(pinned.flatMap(entry => [entry.candidate.ref.resourceId, ...entry.skills.map(skill => skill.ref.resourceId)]));
  const state = await readOrganizationPermissionForUser(context.userId);
  const policies = context.organizationId ? await withCapabilityPolicyStore(store => store.listOrganizationPolicies(context.organizationId!)) : [];
  if (snapshot.workflowVersion === null && pinned.some(entry => entry.skills.some(skill => {
    const current = effective.capabilities.find(value => value.ref.resourceId === skill.ref.resourceId);
    return current && (!current.effectiveEnabled || current.readiness !== 'available' || current.resourceAccess?.canUse === false);
  }))) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'An explicitly referenced skill is disabled or unavailable.', 403);
  const projected = projectPinnedExtensionEffectiveCapabilities({ effective, workflowVersion: snapshot.workflowVersion,
    packages: pinned, role: state.permission?.role, policies });
  for (const entry of pinned) {
    for (const candidate of [entry.candidate, ...entry.skills]) {
      const current = projected.capabilities.find(value => value.ref.resourceId === candidate.ref.resourceId);
      if (!current?.effectiveEnabled || current.readiness !== 'available' || current.resourceAccess?.canUse === false) {
        throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The configured package is blocked or unavailable.', 403);
      }
    }
  }
  const result: AuthorizedAgentWorkflowPackageSelections = Object.freeze({ workflowVersion: snapshot.workflowVersion,
    workflowRevision: snapshot.workflowRevision, packages: Object.freeze(pinned.map(entry => entry.configuration)), snapshot,
    fingerprint: createHash('sha256').update(JSON.stringify([snapshot.agent.revision, snapshot.workflowVersion, snapshot.workflowRevision,
      snapshot.preferenceRevision, snapshot.choices, delegatedSource?.fingerprint ?? null, snapshot.workflowVersion === null ? projected.snapshotId
        : projected.capabilities.filter(candidate => selectedIds.has(candidate.ref.resourceId)).map(candidate => [candidate.ref.resourceId,
          candidate.effectiveEnabled, candidate.readiness, candidate.effectivePolicy, candidate.resourceAccess?.canUse,
          candidate.matchedPolicies.map(policy => [policy.id, policy.revision, policy.effect])]), packageTurns, pinned.map(entry => [entry.published.resourceRef,
        entry.published.revisionRef, entry.published.checksum, entry.candidate.resourceMetadata?.metadataRevision,
        entry.candidate.resourceMetadata?.grantsRevision, entry.extensionSelections, entry.configuration.selectedSkills, entry.configuration.declarations])])).digest('hex') });
  const admissionDatabase = await openDb();
  let admissionStamp: string;
  try { admissionStamp = await readWorkflowAdmissionStamp(admissionDatabase, context); }
  finally { await admissionDatabase.close(); }
  workflowRegistry.set(result, { actorKey: actorKey(context), effective: projected, pinned, delegatedSource, admissionStamp });
  return result;
}

async function existingAdmissionFile(file: string): Promise<string | null> {
  try { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Compare actual native/model/policy inputs; never bootstrap config or borrow SQL under a held frame. */
async function readWorkflowAdmissionStamp(database: SqlConnection, context: AgentExecutionContext, lock = false): Promise<string> {
  const organizationId = context.organizationId ?? '', suffix = lock ? ' FOR SHARE' : '';
  const values = [
    await database.all(`SELECT * FROM capability_policies WHERE organization_id=$1 ORDER BY id${suffix}`, [organizationId]),
    await database.all(`SELECT * FROM ai_runtime_defaults WHERE organization_id=$1 ORDER BY organization_id${suffix}`, [organizationId]),
    await database.all(`SELECT * FROM ai_provider_installations WHERE organization_id=$1 ORDER BY id${suffix}`, [organizationId]),
    await database.all(`SELECT * FROM ai_provider_models WHERE organization_id=$1 ORDER BY provider_installation_id,model_id${suffix}`, [organizationId]),
    await database.all(`SELECT * FROM ai_workspace_model_policies WHERE organization_id=$1 AND workspace_id=$2 ORDER BY workspace_id${suffix}`,
      [organizationId, context.workspaceId ?? '']),
    await database.all(`SELECT * FROM ai_user_model_preferences WHERE organization_id=$1 AND user_id=$2 ORDER BY workspace_id,agent_id${suffix}`,
      [organizationId, context.userId]),
    await database.all(`SELECT * FROM ai_user_workspace_provider_grants WHERE organization_id=$1 AND user_id=$2 ORDER BY id${suffix}`,
      [organizationId, context.userId]),
    await database.all(`SELECT * FROM ai_user_provider_verifications WHERE organization_id=$1 AND user_id=$2 ORDER BY provider_installation_id${suffix}`,
      [organizationId, context.userId]),
    ...await Promise.all([
      existingAdmissionFile(resolveSettingsStoragePath('pi-runtime-config.json')),
      existingAdmissionFile(resolveLegacySettingsStoragePath('pi-runtime-config.json')),
      existingAdmissionFile(path.join(resolveUserSettingsDir(context.userId), 'capabilities.json')),
    ]),
  ];
  return createHash('sha256').update(JSON.stringify([values, readIntegrationToolGatewayAvailability()])).digest('hex');
}

function workflowAdmissionActorKey(context: AgentExecutionContext): string {
  return JSON.stringify([actorKey(context), context.workspaceRoot, context.workspaceRootRelativePath,
    context.canWrite, context.canDelete, context.canShare, context.legacy]);
}

function workflowAdmissionSnapshotKey(snapshot: AgentWorkflowInternalSnapshot): string {
  return JSON.stringify([snapshot.agent, snapshot.workflowVersion, snapshot.workflowRevision, snapshot.bindings,
    snapshot.preferenceRevision, snapshot.choices]);
}

function workflowAdmissionSkillKey(effective: EffectiveCapabilitySnapshot, agentId: string | null | undefined,
  snapshot: AgentWorkflowInternalSnapshot, pinned: readonly PinnedPackage[]): string {
  const skills = selectExtensionRuntimeSkillCandidates({ effective,
    agentKind: normalizeManagedAgentId(agentId) === DEFAULT_MANAGED_AGENT_ID ? 'main' : 'special',
    relevantSkills: snapshot.agent.relevantSkills, workflowVersion: snapshot.workflowVersion,
    packageSkills: pinned.flatMap(entry => entry.skills) });
  return JSON.stringify(skills.map(skill => {
    const current = effective.capabilities.find(candidate => candidate.ref.resourceId === skill.ref.resourceId);
    return [skill.ref.resourceId, skill.ref.name, skill.ref.checksum, skill.runtimePath,
      current?.effectiveEnabled, current?.readiness, current?.effectivePolicy, skill.resourceAccess?.canUse,
      skill.resourceMetadata?.grantsRevision, skill.resourceMetadata?.ownership,
      current?.matchedPolicies.map(policy => [policy.id, policy.revision, policy.effect])];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/** Keep exact package Use sources and current masks until the caller's admission write finishes.
 * Only the original issued selection is accepted. No snapshot DTO, default-head substitution,
 * checkout or transaction lifecycle belongs to this borrowed-connection boundary. */
export async function withRevalidatedAgentWorkflowPackageSelectionOnConnection<T>(database: SqlConnection,
  contextInput: AgentExecutionContext, selection: AuthorizedAgentWorkflowPackageSelections,
  callback: () => Promise<T>): Promise<T> {
  const context = { ...contextInput, ...(contextInput.turnExtensions ? { turnExtensions: structuredClone(contextInput.turnExtensions) } : {}) };
  const namespace = workflowAdmissionActorKey(context), proof = requireWorkflowProof(selection, context);
  if (!proof.admissionStamp || !context.agentId || !context.workspaceId) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'A genuine prepared package selection and stored session are required.', 403);
  }
  const actor = { userId: context.userId, source: 'system' as const, sourceAgentId: context.agentId, sessionId: context.sessionId,
    organizationId: context.organizationId, workspaceId: context.workspaceId, projectId: context.projectId };
  const transactionId = String((await database.get('SELECT txid_current()::text AS transaction_id') as { transaction_id?: string } | undefined)?.transaction_id ?? '');
  const verifyTransaction = async () => {
    const current = String((await database.get('SELECT txid_current()::text AS transaction_id') as { transaction_id?: string } | undefined)?.transaction_id ?? '');
    if (!transactionId || current !== transactionId) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The actual admission transaction changed.', 403);
  };
  const verifyActor = async () => {
    const current = await resolveVerifiedAgentActorContextOnConnection(actor, database, { lock: true });
    const workspace = await readStoredAgentWorkspaceOnConnection(database, { userId: context.userId, sessionId: context.sessionId,
      agentId: context.agentId!, workspaceId: context.workspaceId!, permissions: ['canRead', 'canRunAgent'] });
    const fresh = { ...context, ...workspaceToAgentExecutionContext({ workspace, userId: context.userId,
      sessionId: context.sessionId, agentId: context.agentId }) };
    if (current.organizationId !== context.organizationId || workflowAdmissionActorKey(fresh) !== namespace
      || workflowAdmissionActorKey(contextInput) !== namespace) {
      throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The originating actor, session or workspace changed.', 403);
    }
    requireWorkflowProof(selection, contextInput);
    return current;
  };
  const verified = await verifyActor();
  await verifyTransaction();
  const sources = [...proof.pinned].sort((left, right) => left.storage.resourceId.localeCompare(right.storage.resourceId));
  const currentSources = new Map<string, PinnedPackage>();
  const verify = async () => {
    await verifyTransaction();
    await verifyActor();
    if (await readWorkflowAdmissionStamp(database, context, true) !== proof.admissionStamp) {
      throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'Native tools, model configuration or source policies changed.', 409);
    }
    const snapshot = await readManagedAgentWorkflow(actor, context.agentId!, { database });
    if (!snapshot.access.canUse || workflowAdmissionSnapshotKey(snapshot) !== workflowAdmissionSnapshotKey(selection.snapshot)) {
      throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The Agent configuration or personal choices changed.', 409);
    }
    const input = { userId: context.userId, organizationId: context.organizationId ?? '',
      role: verified.organizationRole, workspaceId: context.workspaceId, projectId: context.projectId };
    const candidates = await loadCapabilityCandidates(input, { resolveConnections: false, database });
    const policies = context.organizationId ? await new CapabilityPolicyStore(database).listOrganizationPolicies(context.organizationId) : [];
    const effective = resolveEffectiveCapabilities({ context: input, candidates: candidates.map(candidate => candidate.ref.resourceType === 'plugin'
      ? { ...candidate, connectionRequirementCount: 0 } : candidate), policies });
    const pinned: PinnedPackage[] = [];
    for (const original of proof.pinned) {
      const held = currentSources.get(original.storage.resourceId)!;
      const published = await getCapabilityPackagePublishedRevision(original.published.resourceRef, original.published.revisionRef, database);
      if (!published || JSON.stringify(published) !== JSON.stringify(original.published)) {
        throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The immutable selected revision changed.', 409);
      }
      await verifyCapabilityPackageSnapshot(original.location);
      const candidate = effective.capabilities.find(row => row.ref.resourceId === original.candidate.ref.resourceId);
      if (!candidate || selection.workflowVersion === null && (!candidate.effectiveEnabled || candidate.readiness !== 'available'
        || candidate.resourceAccess?.canUse === false)) {
        throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'A selected package is no longer enabled or available.', 403);
      }
      const all = projectPinnedExtensionSkillCandidates({ candidate, effective, metadata: held.metadata, published: held.published,
        resourceAccess: held.candidate.resourceAccess!, resourceMetadata: held.candidate.resourceMetadata! });
      const selected = new Set(original.configuration.selectedSkills.map(skill => skill.name));
      pinned.push({ ...held, skills: all.filter(skill => selected.has(skill.ref.name)) });
    }
    const projected = projectPinnedExtensionEffectiveCapabilities({ effective, workflowVersion: selection.workflowVersion,
      packages: pinned, role: verified.organizationRole, policies });
    if (workflowAdmissionSkillKey(projected, context.agentId, snapshot, pinned)
      !== workflowAdmissionSkillKey(proof.effective, context.agentId, selection.snapshot, proof.pinned)) {
      throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The selected, required or inherited skill mask changed.', 409);
    }
  };
  const hold = async (index: number): Promise<T> => {
    if (index === sources.length) {
      await verify();
      const result = await callback();
      await verify();
      return result;
    }
    const original = sources[index];
    return withAuthorizedCapabilityPackageResource({ userId: context.userId, workspaceId: context.workspaceId }, original.storage, 'use', undefined,
      async (authorization, connection) => {
        const state = await findCapabilityPackageStateForStorage(original.storage, connection);
        const published = state?.resourceRef === original.published.resourceRef
          ? await getCapabilityPackagePublishedRevision(original.published.resourceRef, original.published.revisionRef, connection) : null;
        if (!published || published.checksum !== original.published.checksum || published.kind !== original.published.kind
          || JSON.stringify(authorization.record.metadata.ownership) !== JSON.stringify(original.candidate.resourceMetadata?.ownership)
          || authorization.record.metadata.grantsRevision !== original.candidate.resourceMetadata?.grantsRevision) {
          throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The exact published package or its grants changed.', 409);
        }
        await verifyCapabilityPackageSnapshot(original.location);
        const metadata = await readPackageExtensionSourceMetadata(original.location);
        currentSources.set(original.storage.resourceId, { ...original, published, metadata,
          candidate: { ...original.candidate, resourceAccess: authorization.access, resourceMetadata: authorization.record.metadata } });
        return hold(index + 1);
      }, { database });
  };
  return hold(0);
}

function selectedRuntimeSkills(snapshot: EffectiveCapabilitySnapshot, agentId: string | null | undefined,
  relevantSkills: string[] | null | undefined, workflow: AuthorizedAgentWorkflowPackageSelections): CapabilityCandidate[] {
  const proof = workflowRegistry.get(workflow)!;
  return selectExtensionRuntimeSkillCandidates({ effective: snapshot,
    agentKind: normalizeManagedAgentId(agentId) === DEFAULT_MANAGED_AGENT_ID ? 'main' : 'special', relevantSkills,
    workflowVersion: workflow.workflowVersion, packageSkills: proof.pinned.flatMap(entry => entry.skills) });
}

function issuePinnedSkill(context: AgentExecutionContext, entry: PinnedPackage, candidate: CapabilityCandidate): HeldCapabilityPackageRuntimeBinding {
  const selected = entry.configuration.selectedSkills.find(skill => skill.name === candidate.ref.name)!;
  const parentStorage = entry.published.kind === 'plugin' ? entry.storage : undefined;
  return issue(context, { resourceRef: entry.published.resourceRef, publishedRevisionRef: entry.published.revisionRef,
    checksum: entry.published.checksum, childRelativeRoot: selected.relativeRoot, skillName: candidate.ref.name,
    resourceId: candidate.ref.resourceId, runtimePath: candidate.runtimePath! },
  { storage: capabilityResourceStorageBinding(candidate.ref), ...(parentStorage ? { parentStorage } : {}), candidate,
    ...(parentStorage ? { parentCandidate: entry.candidate } : {}), location: entry.location, published: entry.published });
}

function actorKey(context: AgentExecutionContext): string {
  return JSON.stringify([context.userId, context.sessionId, context.agentId ?? null, context.workspaceId,
    context.workspaceType, context.organizationId, context.customerId, context.projectId, context.turnExtensions ?? null]);
}

export function isHeldCapabilityPackageRuntimeBinding(value: unknown,
  context: AgentExecutionContext): value is HeldCapabilityPackageRuntimeBinding {
  return Boolean(value && typeof value === 'object' && registry.issued.has(value)
    && registry.proofs.get(value)?.actorKey === actorKey(context));
}

function issue(context: AgentExecutionContext, binding: HeldCapabilityPackageRuntimeBinding,
  proof: Omit<BindingProof, 'actorKey'>): HeldCapabilityPackageRuntimeBinding {
  const frozen = Object.freeze({ ...binding });
  registry.issued.add(frozen);
  registry.proofs.set(frozen, { ...proof, actorKey: actorKey(context) });
  return frozen;
}

function selectedSkills(snapshot: EffectiveCapabilitySnapshot, agentId?: string | null,
  relevantSkills?: string[] | null): CapabilityCandidate[] {
  const skills = snapshot.capabilities.filter(entry => entry.ref.resourceType === 'skill' && entry.effectiveEnabled
    && entry.resourceAccess?.canUse !== false && entry.readiness === 'available' && entry.runtimePath)
    .map(candidate => ({ candidate, name: candidate.ref.name, enabled: true, core: candidate.ref.sourceType === 'core' }));
  const required = snapshot.capabilities.filter(entry => entry.ref.resourceType === 'skill'
    && entry.effectivePolicy === 'required' && entry.effectiveEnabled).map(entry => entry.ref.name);
  return selectPromptSkillsForAgent(normalizeManagedAgentId(agentId), skills, relevantSkills, required).map(skill => skill.candidate);
}

async function currentSnapshot(context: AgentExecutionContext, discoverConnections: boolean): Promise<EffectiveCapabilitySnapshot> {
  const state = await readOrganizationPermissionForUser(context.userId);
  if ((state.configured && state.permission?.status !== 'active') || (state.organizationId ?? null) !== context.organizationId) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The runtime package actor is unavailable.', 403);
  }
  const actor = state.organizationId && state.permission?.status === 'active'
    ? await resolveCapabilityExecutionContextForUser({ userId: context.userId, organizationId: state.organizationId,
      role: state.permission.role, requestedWorkspaceId: context.workspaceId })
    : { userId: context.userId, organizationId: '', ...(await (await import('@/app/lib/pi/session-workspace-context')).resolveAgentSessionWorkspaceForUser({
      userId: context.userId, workspaceId: context.workspaceId, permissions: ['canRead', 'canRunAgent'],
    })) };
  if (actor.workspaceId !== context.workspaceId || (actor.organizationId || null) !== context.organizationId) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The runtime package workspace changed.', 403);
  }
  if (discoverConnections && context.organizationId) return resolveEffectiveCapabilitySnapshot({
    ...actor, organizationId: context.organizationId,
  });
  const input = { ...actor, organizationId: context.organizationId ?? '' };
  const [candidates, policies] = await Promise.all([
    loadCapabilityCandidates(input, { resolveConnections: false }),
    context.organizationId ? withCapabilityPolicyStore(store => store.listOrganizationPolicies(context.organizationId!)) : [],
  ]);
  return resolveEffectiveCapabilities({ context: input, candidates: candidates.map(candidate => candidate.ref.resourceType === 'plugin'
    ? { ...candidate, connectionRequirementCount: 0 } : candidate), policies });
}

function parentFor(candidate: CapabilityCandidate, candidates: readonly CapabilityCandidate[]): CapabilityCandidate | undefined {
  if (candidate.ref.sourceType !== 'plugin') return undefined;
  const parent = candidates.find(entry => entry.ref.resourceType === 'plugin'
    && entry.ref.resourceId === candidate.pluginResourceId && entry.ref.resourceId === candidate.ref.sourcePluginId);
  if (!parent) throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The source plugin is unavailable.', 403);
  return parent;
}

async function captureSelectedBinding(context: AgentExecutionContext, candidate: CapabilityCandidate,
  candidates: readonly CapabilityCandidate[], verified: Set<string>): Promise<HeldCapabilityPackageRuntimeBinding | null> {
  if (candidate.ref.sourceType === 'core') return null;
  const storage = capabilityResourceStorageBinding(candidate.ref), parentCandidate = parentFor(candidate, candidates);
  const parentStorage = parentCandidate ? capabilityResourceStorageBinding(parentCandidate.ref) : undefined;
  return withAuthorizedCapabilityPackageResource({ userId: context.userId, workspaceId: context.workspaceId }, storage, 'use', undefined,
    async (authorization, database) => {
      const state = await findCapabilityPackageStateForStorage(parentStorage ?? storage, database);
      if (!state) {
        if (candidate.runtimePath?.split(path.sep).join('/').includes('/capability-packages/published/')) {
          throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The published package authority is unavailable.', 409);
        }
        return null;
      }
      const published = await getCapabilityPackagePublishedRevision(state.resourceRef, state.currentPublishedRevisionRef, database);
      if (!published) throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The published package is unavailable.', 409);
      const location: CapabilityPackagePublishedLocation = { ...published, owner: authorization.record.metadata.ownership,
        rootPath: resolveOwnerScopedPackageVersionPath({ ...published, owner: authorization.record.metadata.ownership }) };
      const parentRoot = path.resolve(location.rootPath), skillRoot = path.dirname(path.resolve(candidate.runtimePath!));
      const relative = parentStorage ? path.relative(parentRoot, skillRoot).split(path.sep).join('/') : '';
      if (parentStorage && relative) normalizeCapabilityPackageRelativePath(relative);
      if (skillRoot !== path.join(parentRoot, ...relative.split('/').filter(Boolean))) {
        throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The selected skill path does not match its published version.', 409);
      }
      const skillFile = relative ? `${relative}/SKILL.md` : 'SKILL.md';
      if (!published.files.some(file => file.path === skillFile)) throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The skill is not in this package version.', 409);
      if (!verified.has(published.revisionRef)) {
        await verifyCapabilityPackageSnapshot(location);
        verified.add(published.revisionRef);
      }
      if (parentStorage && !relative) {
        const metadata = await readPackageExtensionSourceMetadata(location);
        if (!metadata.skills.some(child => child.relativeRoot === '' && child.skill.name === candidate.ref.name)) {
          throw new CapabilityPackageError('PACKAGE_INVALID', 'The root skill is not declared by the held plugin manifest.', 409);
        }
      }
      const skill = await parseSkillFile(path.join(skillRoot, 'SKILL.md'), { validateDirectoryName: !(parentStorage && !relative) });
      if (!skill || skill.name !== candidate.ref.name) throw new CapabilityPackageError('PACKAGE_INVALID', 'The published skill identity is invalid.', 409);
      return issue(context, { resourceRef: published.resourceRef, publishedRevisionRef: published.revisionRef, checksum: published.checksum,
        childRelativeRoot: relative, skillName: skill.name, resourceId: candidate.ref.resourceId, runtimePath: skill.path },
      { storage: structuredClone(storage), ...(parentStorage ? { parentStorage: structuredClone(parentStorage) } : {}),
        candidate: structuredClone(candidate), ...(parentCandidate ? { parentCandidate: structuredClone(parentCandidate) } : {}), location, published });
    }, { parentStorage });
}

/** One selection creates both the prompt's package receipts and its filesystem read roots. */
export async function captureCapabilityPackageRuntimeBindings(context: AgentExecutionContext,
  options: { selection?: AuthorizedAgentWorkflowPackageSelections } = {}): Promise<{
  skillReadRoots: string[]; skillPackageBindings: HeldCapabilityPackageRuntimeBinding[];
  selection: AuthorizedAgentWorkflowPackageSelections;
}> {
  const workflow = options.selection ?? await getAuthorizedAgentWorkflowPackageSelections(context);
  if (!isAuthorizedAgentWorkflowPackageSelections(workflow, context)) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The captured package selection does not belong to this execution context.', 403);
  }
  const proof = workflowRegistry.get(workflow)!;
  const snapshot = proof.effective;
  const selected = selectedRuntimeSkills(snapshot, context.agentId, workflow.snapshot.agent.relevantSkills, workflow);
  const verified = new Set<string>();
  const skillReadRoots: string[] = [], skillPackageBindings: HeldCapabilityPackageRuntimeBinding[] = [];
  for (const candidate of selected) {
    const pinned = proof.pinned.find(entry => entry.skills.some(skill => skill.ref.resourceId === candidate.ref.resourceId));
    const binding = pinned ? issuePinnedSkill(context, pinned, candidate)
      : await captureSelectedBinding(context, candidate, snapshot.capabilities, verified);
    if (binding) skillPackageBindings.push(binding);
    skillReadRoots.push(path.dirname(path.resolve(binding?.runtimePath ?? candidate.runtimePath!)));
  }
  const result = { skillReadRoots: [...new Set(skillReadRoots)], skillPackageBindings };
  // Existing context spreads must not serialize the private workflow snapshot.
  return Object.defineProperty(result, 'selection', { value: workflow, enumerable: false }) as typeof result & { selection: AuthorizedAgentWorkflowPackageSelections };
}

/** Server-derived current selection and private issued proofs; callers cannot supply an authorization snapshot. */
export async function getAuthorizedCapabilityPackageRuntimeBindings(context:AgentExecutionContext,
  options: { selection?: AuthorizedAgentWorkflowPackageSelections } = {}):Promise<HeldCapabilityPackageRuntimeBinding[]>{
  const captured={...context,skillPackageBindings:[...(context.skillPackageBindings??[])]};
  if (options.selection) {
    const proof = requireWorkflowProof(options.selection, captured);
    return revalidateCapabilityPackageRuntimeBindings(captured, proof.effective, options.selection.snapshot.agent.relevantSkills,
      captured.agentId, options);
  }
  const [snapshot,profile]=await Promise.all([currentSnapshot(captured,false),getAgentProfile(normalizeManagedAgentId(captured.agentId))]);
  return revalidateCapabilityPackageRuntimeBindings(captured,snapshot,profile?.relevantSkills);
}

/** Current rights and activation are fresh; a valid later head never replaces an issued old version.
 * An unavailable/unconfirmed current resource closes all its held versions until explicit repair. */
export async function revalidateCapabilityPackageRuntimeBindings(context: AgentExecutionContext,
  snapshot: EffectiveCapabilitySnapshot, relevantSkills?: string[] | null,
  selectionAgentId = context.agentId,
  options: { selection?: AuthorizedAgentWorkflowPackageSelections } = {}): Promise<HeldCapabilityPackageRuntimeBinding[]> {
  const selectionContext = { ...context, agentId: selectionAgentId ?? null };
  const workflow = options.selection ?? await getAuthorizedAgentWorkflowPackageSelections(selectionContext);
  requireWorkflowProof(workflow, selectionContext);
  let workflowIds: Set<string> | undefined;
  const workflowPinned = workflowRegistry.get(workflow)!.pinned.flatMap(entry => entry.skills.map(skill => ({ entry, skill })));
  if (isExplicitAgentWorkflowVersion(workflow.workflowVersion) || context.turnExtensions?.selections.length) {
    const proof = workflowRegistry.get(workflow)!;
    workflowIds = new Set(selectedRuntimeSkills(proof.effective, selectionAgentId, workflow.snapshot.agent.relevantSkills, workflow)
      .map(candidate => candidate.ref.resourceId));
    snapshot = proof.effective;
  }
  const authorized: HeldCapabilityPackageRuntimeBinding[] = [];
  const additions: CapabilityCandidate[] = [];
  const verified = new Set<string>();
  for (const binding of context.skillPackageBindings ?? []) {
    if (!isHeldCapabilityPackageRuntimeBinding(binding, context)) continue;
    const proof = registry.proofs.get(binding)!;
    try {
      const candidate = await withAuthorizedCapabilityPackageResource({ userId: context.userId, workspaceId: context.workspaceId },
        proof.storage, 'use', undefined, async (authorization, database) => {
          const state = await findCapabilityPackageStateForStorage(proof.parentStorage ?? proof.storage, database);
          const version = state?.resourceRef === binding.resourceRef
            ? await getCapabilityPackagePublishedRevision(binding.resourceRef, binding.publishedRevisionRef, database) : null;
          if (!version || version.checksum !== binding.checksum || version.version !== proof.published.version) {
            throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The held package revision is unavailable.', 409);
          }
          if (!verified.has(version.revisionRef)) {
            await verifyCapabilityPackageSnapshot(proof.location);
            verified.add(version.revisionRef);
          }
          return { ...proof.candidate, runtimePath: binding.runtimePath, resourceAccess: authorization.access, resourceMetadata: authorization.record.metadata };
        }, { parentStorage: proof.parentStorage });
      // A child removed from the latest package still belongs to this issued
      // old parent version. Current policy, parent activation and namespace
      // protections apply to that exact child identity before retaining it.
      if (!snapshot.capabilities.some(entry => entry.ref.resourceId === candidate.ref.resourceId)) {
        if (proof.parentStorage && !snapshot.capabilities.some(entry => entry.ref.resourceId === proof.parentStorage!.resourceId)) continue;
        additions.push(candidate);
      }
      authorized.push(binding);
    } catch {
      // Denial never grants a replacement or a legacy root. Bash subsequently
      // rejects the whole launch if any captured root lost its authority.
    }
  }
  let effective = snapshot;
  if (additions.length) {
    const state = await readOrganizationPermissionForUser(context.userId);
    const policies = context.organizationId ? await withCapabilityPolicyStore(store => store.listOrganizationPolicies(context.organizationId!)) : [];
    effective = resolveEffectiveCapabilities({ context: { userId: snapshot.userId, organizationId: snapshot.organizationId,
      workspaceId: snapshot.workspaceId, projectId: snapshot.projectId, role: state.permission?.role },
    candidates: [...snapshot.capabilities, ...additions], policies });
  }
  const currentIds = workflowIds ?? new Set(selectedSkills(effective, selectionAgentId, relevantSkills).map(candidate => candidate.ref.resourceId));
  return authorized.filter(binding => {
    if (!currentIds.has(binding.resourceId)) return false;
    const match = workflowPinned.find(value => value.skill.ref.resourceId === binding.resourceId);
    return !match || (match.entry.published.resourceRef === binding.resourceRef
      && match.entry.published.revisionRef === binding.publishedRevisionRef && match.entry.published.checksum === binding.checksum
      && match.skill.runtimePath === binding.runtimePath
      && match.entry.configuration.selectedSkills.some(skill => skill.name === binding.skillName && skill.relativeRoot === binding.childRelativeRoot));
  });
}

/** Child contexts receive a new proof for the same held version, never a copied parent proof. */
export async function reissueCapabilityPackageRuntimeBindings(previous: AgentExecutionContext,
  next: AgentExecutionContext): Promise<AgentExecutionContext> {
  if (previous.userId !== next.userId || previous.workspaceId !== next.workspaceId || previous.organizationId !== next.organizationId) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The runtime package actor cannot change.', 403);
  }
  const workflow = await getAuthorizedAgentWorkflowPackageSelections(next);
  const snapshot = workflowRegistry.get(workflow)!.effective, profile = workflow.snapshot.agent;
  const retained = await revalidateCapabilityPackageRuntimeBindings(previous, snapshot, profile?.relevantSkills, next.agentId);
  const bindings = retained.map(binding => {
    const proof = registry.proofs.get(binding)!;
    return issue(next, binding, proof);
  });
  const roots = new Set(bindings.map(binding => path.dirname(path.resolve(binding.runtimePath))));
  const managedRoots = new Set((previous.skillPackageBindings ?? []).map(binding => path.dirname(path.resolve(binding.runtimePath))));
  const selectedLegacyRoots = new Set(selectedRuntimeSkills(snapshot, next.agentId, profile?.relevantSkills, workflow)
    .filter(candidate => !candidate.runtimePath!.split(path.sep).join('/').includes('/capability-packages/published/'))
    .map(candidate => path.dirname(path.resolve(candidate.runtimePath!))));
  const legacyRoots = (previous.skillReadRoots ?? []).filter(root => !managedRoots.has(path.resolve(root)) && selectedLegacyRoots.has(path.resolve(root)));
  return { ...next, skillReadRoots: [...new Set([...legacyRoots, ...roots])], skillPackageBindings: bindings };
}

/** Render the same captured version paths used by the file and Bash runtime. */
export async function loadCapabilityPackageRuntimeSkills(context: AgentExecutionContext,
  options: { selection?: AuthorizedAgentWorkflowPackageSelections } = {}): Promise<CanvasSkill[]> {
  if (options.selection) {
    const proof = requireWorkflowProof(options.selection, context), skills: CanvasSkill[] = [];
    for (const candidate of selectedRuntimeSkills(proof.effective, context.agentId, options.selection.snapshot.agent.relevantSkills, options.selection)) {
      const held = proof.pinned.find(entry => entry.skills.some(value => value.ref.resourceId === candidate.ref.resourceId));
      const skill = held?.metadata.skills.find(child => child.skill.name === candidate.ref.name)?.skill ?? await parseSkillFile(candidate.runtimePath!);
      if (skill && skill.name === candidate.ref.name) skills.push({ ...skill, enabled: true });
    }
    return skills;
  }
  const workflow = await getAuthorizedAgentWorkflowPackageSelections(context);
  const snapshot = workflowRegistry.get(workflow)!.effective, profile = workflow.snapshot.agent;
  const bindings = await revalidateCapabilityPackageRuntimeBindings(context, snapshot, profile?.relevantSkills);
  const legacyRoots = new Set((context.skillReadRoots ?? []).map(root => path.resolve(root)));
  for (const binding of context.skillPackageBindings ?? []) legacyRoots.delete(path.dirname(path.resolve(binding.runtimePath)));
  const candidates = selectedRuntimeSkills(snapshot, context.agentId, profile?.relevantSkills, workflow);
  const paths = [...bindings.map(binding => binding.runtimePath), ...candidates.filter(candidate =>
    legacyRoots.has(path.dirname(path.resolve(candidate.runtimePath!)))).map(candidate => candidate.runtimePath!)];
  const skills: CanvasSkill[] = [];
  for (const skillPath of [...new Set(paths)]) {
    const held = bindings.find(binding => binding.runtimePath === skillPath);
    const declaredRoot = held?.childRelativeRoot === '' && Boolean(registry.proofs.get(held)?.parentStorage);
    const skill = await parseSkillFile(skillPath, { validateDirectoryName: !declaredRoot });
    if (skill) { skill.enabled = true; skills.push(skill); }
  }
  return skills;
}

export async function getCapabilityPackageRuntimeSkillContext(context: AgentExecutionContext): Promise<string> {
  return getSkillsContext(await loadCapabilityPackageRuntimeSkills(context));
}

export function requiresCapabilityPackageBoundPrompt(context: AgentExecutionContext, storedPrompt?: string | null): boolean {
  return Boolean(context.effectiveExtensions || context.skillPackageBindings?.length || storedPrompt?.includes('/capability-packages/published/'));
}
