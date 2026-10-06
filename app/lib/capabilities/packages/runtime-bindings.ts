import 'server-only';

import path from 'node:path';

import type { AgentExecutionContext } from '@/app/lib/pi/agent-execution-context';
import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { loadCapabilityCandidates, resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import { resolveEffectiveCapabilities } from '@/app/lib/capabilities/effective-resolver';
import { withCapabilityPolicyStore } from '@/app/lib/capabilities/policy-store';
import { resolveCapabilityExecutionContextForUser } from '@/app/lib/capabilities/request-scope';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import type { CapabilityCandidate, EffectiveCapabilitySnapshot } from '@/app/lib/capabilities/types';
import { capabilityResourceStorageBinding } from '../resources/storage-binding';
import { withAuthorizedCapabilityPackageResource } from '../resources/store';
import type { CapabilityResourceStorageBinding } from '../resources/contracts';
import { selectPromptSkillsForAgent } from '@/app/lib/skills/agent-skill-selection';
import { parseSkillFile, type CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
import { getSkillsContext } from '@/app/lib/skills/skill-context';
import { CapabilityPackageError, type CapabilityPackagePublishedLocation, type CapabilityPackagePublishedRevision } from './contracts';
import { findCapabilityPackageStateForStorage, getCapabilityPackagePublishedRevision } from './store';
import { normalizeCapabilityPackageRelativePath, resolveOwnerScopedPackageVersionPath, verifyCapabilityPackageSnapshot } from './io';

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

function actorKey(context: AgentExecutionContext): string {
  return JSON.stringify([context.userId, context.sessionId, context.agentId ?? null, context.workspaceId,
    context.workspaceType, context.organizationId, context.customerId, context.projectId]);
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
      if (parentStorage) normalizeCapabilityPackageRelativePath(relative);
      if (skillRoot !== path.join(parentRoot, ...relative.split('/').filter(Boolean))) {
        throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The selected skill path does not match its published version.', 409);
      }
      const skillFile = relative ? `${relative}/SKILL.md` : 'SKILL.md';
      if (!published.files.some(file => file.path === skillFile)) throw new CapabilityPackageError('PACKAGE_SNAPSHOT_UNAVAILABLE', 'The skill is not in this package version.', 409);
      if (!verified.has(published.revisionRef)) {
        await verifyCapabilityPackageSnapshot(location);
        verified.add(published.revisionRef);
      }
      const skill = await parseSkillFile(path.join(skillRoot, 'SKILL.md'));
      if (!skill || skill.name !== candidate.ref.name) throw new CapabilityPackageError('PACKAGE_INVALID', 'The published skill identity is invalid.', 409);
      return issue(context, { resourceRef: published.resourceRef, publishedRevisionRef: published.revisionRef, checksum: published.checksum,
        childRelativeRoot: relative, skillName: skill.name, resourceId: candidate.ref.resourceId, runtimePath: skill.path },
      { storage: structuredClone(storage), ...(parentStorage ? { parentStorage: structuredClone(parentStorage) } : {}),
        candidate: structuredClone(candidate), ...(parentCandidate ? { parentCandidate: structuredClone(parentCandidate) } : {}), location, published });
    }, { parentStorage });
}

/** One selection creates both the prompt's package receipts and its filesystem read roots. */
export async function captureCapabilityPackageRuntimeBindings(context: AgentExecutionContext): Promise<{
  skillReadRoots: string[]; skillPackageBindings: HeldCapabilityPackageRuntimeBinding[];
}> {
  const [snapshot, profile] = await Promise.all([currentSnapshot(context, true), getAgentProfile(normalizeManagedAgentId(context.agentId))]);
  const selected = selectedSkills(snapshot, context.agentId, profile?.relevantSkills);
  const verified = new Set<string>();
  const skillReadRoots: string[] = [], skillPackageBindings: HeldCapabilityPackageRuntimeBinding[] = [];
  for (const candidate of selected) {
    const binding = await captureSelectedBinding(context, candidate, snapshot.capabilities, verified);
    if (binding) skillPackageBindings.push(binding);
    skillReadRoots.push(path.dirname(path.resolve(binding?.runtimePath ?? candidate.runtimePath!)));
  }
  return { skillReadRoots: [...new Set(skillReadRoots)], skillPackageBindings };
}

/** Current rights and activation are fresh; a valid later head never replaces an issued old version.
 * An unavailable/unconfirmed current resource closes all its held versions until explicit repair. */
export async function revalidateCapabilityPackageRuntimeBindings(context: AgentExecutionContext,
  snapshot: EffectiveCapabilitySnapshot, relevantSkills?: string[] | null,
  selectionAgentId = context.agentId): Promise<HeldCapabilityPackageRuntimeBinding[]> {
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
  const currentIds = new Set(selectedSkills(effective, selectionAgentId, relevantSkills).map(candidate => candidate.ref.resourceId));
  return authorized.filter(binding => currentIds.has(binding.resourceId));
}

/** Child contexts receive a new proof for the same held version, never a copied parent proof. */
export async function reissueCapabilityPackageRuntimeBindings(previous: AgentExecutionContext,
  next: AgentExecutionContext): Promise<AgentExecutionContext> {
  if (previous.userId !== next.userId || previous.workspaceId !== next.workspaceId || previous.organizationId !== next.organizationId) {
    throw new CapabilityPackageError('PACKAGE_ACCESS_DENIED', 'The runtime package actor cannot change.', 403);
  }
  const [snapshot, profile] = await Promise.all([currentSnapshot(previous, false), getAgentProfile(normalizeManagedAgentId(next.agentId))]);
  const retained = await revalidateCapabilityPackageRuntimeBindings(previous, snapshot, profile?.relevantSkills, next.agentId);
  const bindings = retained.map(binding => {
    const proof = registry.proofs.get(binding)!;
    return issue(next, binding, proof);
  });
  const roots = new Set(bindings.map(binding => path.dirname(path.resolve(binding.runtimePath))));
  const managedRoots = new Set((previous.skillPackageBindings ?? []).map(binding => path.dirname(path.resolve(binding.runtimePath))));
  const selectedLegacyRoots = new Set(selectedSkills(snapshot, next.agentId, profile?.relevantSkills)
    .filter(candidate => !candidate.runtimePath!.split(path.sep).join('/').includes('/capability-packages/published/'))
    .map(candidate => path.dirname(path.resolve(candidate.runtimePath!))));
  const legacyRoots = (previous.skillReadRoots ?? []).filter(root => !managedRoots.has(path.resolve(root)) && selectedLegacyRoots.has(path.resolve(root)));
  return { ...next, skillReadRoots: [...new Set([...legacyRoots, ...roots])], skillPackageBindings: bindings };
}

/** Render the same captured version paths used by the file and Bash runtime. */
export async function loadCapabilityPackageRuntimeSkills(context: AgentExecutionContext): Promise<CanvasSkill[]> {
  const [snapshot, profile] = await Promise.all([currentSnapshot(context, false), getAgentProfile(normalizeManagedAgentId(context.agentId))]);
  const bindings = await revalidateCapabilityPackageRuntimeBindings(context, snapshot, profile?.relevantSkills);
  const legacyRoots = new Set((context.skillReadRoots ?? []).map(root => path.resolve(root)));
  for (const binding of context.skillPackageBindings ?? []) legacyRoots.delete(path.dirname(path.resolve(binding.runtimePath)));
  const candidates = selectedSkills(snapshot, context.agentId, profile?.relevantSkills);
  const paths = [...bindings.map(binding => binding.runtimePath), ...candidates.filter(candidate =>
    legacyRoots.has(path.dirname(path.resolve(candidate.runtimePath!)))).map(candidate => candidate.runtimePath!)];
  const skills: CanvasSkill[] = [];
  for (const skillPath of [...new Set(paths)]) {
    const skill = await parseSkillFile(skillPath);
    if (skill) { skill.enabled = true; skills.push(skill); }
  }
  return skills;
}

export async function getCapabilityPackageRuntimeSkillContext(context: AgentExecutionContext): Promise<string> {
  return getSkillsContext(await loadCapabilityPackageRuntimeSkills(context));
}

export function requiresCapabilityPackageBoundPrompt(context: AgentExecutionContext, storedPrompt?: string | null): boolean {
  return Boolean(context.skillPackageBindings?.length || storedPrompt?.includes('/capability-packages/published/'));
}
