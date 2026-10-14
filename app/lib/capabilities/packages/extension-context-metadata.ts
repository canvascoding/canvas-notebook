import type { AgentWorkflowVersion } from '@/app/lib/agents/workflow-version';
import type { StoredAgentWorkflowPackage } from '@/app/lib/agents/workflow-contracts';
import type { CapabilityCandidate, CapabilityPolicy, EffectiveCapabilitySnapshot } from '@/app/lib/capabilities/types';
import { createCapabilityReference } from '@/app/lib/capabilities/reference';
import { resolveEffectiveCapabilities } from '@/app/lib/capabilities/effective-resolver';
import type { CapabilityResourceAccess, CapabilityResourceMetadata } from '@/app/lib/capabilities/resources/contracts';
import type { CanvasSkill } from '@/app/lib/skills/canvas-skill-manifest';
import type { CapabilityPackagePublishedRevision } from './contracts';
import type { PackageExtensionSourceMetadata } from './extension-metadata';

/** Presentation only: these values never issue a read root, binding or execution grant. */
export type ExtensionSkillMetadata = Readonly<{
  resourceId: string; name: string; title: string; description: string; runtimePath: string;
  core: boolean; required: boolean; origin: CapabilityCandidate['ref']['sourceType'];
  package?: Readonly<{ resourceRef: string; publishedRevisionRef: string; checksum: string; kind: 'plugin' | 'skill'; relativeRoot: string }>;
}>;
export type ExtensionPackageMetadata = Readonly<{
  resourceRef: string; publishedRevisionRef: string; checksum: string; kind: 'plugin' | 'skill'; name: string; version: string;
  title: string; description: string; defaultPrompts: readonly string[]; skills: readonly ExtensionSkillMetadata[];
  declarations: readonly Readonly<{ declarationPath: string; capabilities: readonly Readonly<{ id: string; application: string; required: boolean;
    alternatives: readonly Readonly<{ source: 'mcp' | 'composio'; connector?: string; toolkit?: string; requiredTools?: readonly string[] }>[] }>[] }>[];
}>;

export function compactExtensionMetadata(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

export type ExtensionSkillMetadataInput = {
  candidate: Pick<CapabilityCandidate, 'ref' | 'runtimePath'>;
  skill: Pick<CanvasSkill, 'name' | 'title' | 'description'>;
  required: boolean;
  runtimePath?: string;
  package?: ExtensionSkillMetadata['package'];
};

/** The caller supplies its actual checked source; no authorization is inferred from this DTO. */
export function projectExtensionSkillMetadata(input: ExtensionSkillMetadataInput): ExtensionSkillMetadata {
  const { candidate, skill } = input;
  return Object.freeze({ resourceId: candidate.ref.resourceId, name: skill.name,
    title: compactExtensionMetadata(skill.title || skill.name, 256), description: compactExtensionMetadata(skill.description, 1_024),
    runtimePath: input.runtimePath ?? candidate.runtimePath!, core: candidate.ref.sourceType === 'core',
    required: input.required, origin: candidate.ref.sourceType,
    ...(input.package ? { package: Object.freeze({ ...input.package }) } : {}) });
}

export type ExtensionPackageMetadataInput = {
  published: Pick<CapabilityPackagePublishedRevision, 'resourceRef' | 'revisionRef' | 'checksum' | 'kind' | 'name' | 'version'>;
  configuration: Pick<StoredAgentWorkflowPackage, 'selectedSkills' | 'skillSelection'>;
  metadata: Pick<PackageExtensionSourceMetadata, 'title' | 'description' | 'defaultPrompts' | 'declarations'>;
  skills: readonly ExtensionSkillMetadata[];
  workflowVersion: AgentWorkflowVersion;
};

/** Preserve the exact V1/V2 declaration mask while sharing compaction with configuration preflight. */
export function projectExtensionPackageMetadata(input: ExtensionPackageMetadataInput): ExtensionPackageMetadata {
  const { published, configuration, metadata } = input;
  const active = new Set(configuration.selectedSkills.map(skill => skill.relativeRoot ? `${skill.relativeRoot}/agents/canvas.yaml` : 'agents/canvas.yaml'));
  if (configuration.skillSelection.kind === 'plugin' || published.kind === 'plugin' && input.workflowVersion !== 1) {
    active.add('.canvas-plugin/plugin.json');
  }
  return Object.freeze({ resourceRef: published.resourceRef, publishedRevisionRef: published.revisionRef,
    checksum: published.checksum, kind: published.kind, name: published.name, version: published.version,
    title: compactExtensionMetadata(metadata.title, 256), description: compactExtensionMetadata(metadata.description, 1_024),
    defaultPrompts: Object.freeze(metadata.defaultPrompts.slice(0, 4).map(value => compactExtensionMetadata(value, 1_024))),
    skills: Object.freeze([...input.skills]),
    declarations: Object.freeze(metadata.declarations.filter(value => active.has(value.declarationPath)).map(declaration => Object.freeze({
      declarationPath: declaration.declarationPath, capabilities: Object.freeze(declaration.workflow.integrationCapabilities.map(capability => Object.freeze({
        id: capability.id, application: capability.application, required: capability.required,
        alternatives: Object.freeze(capability.alternatives.map(alternative => Object.freeze({ ...alternative,
          ...(alternative.requiredTools ? { requiredTools: Object.freeze([...alternative.requiredTools]) } : {}) }))) }))) }))) });
}

export type PinnedExtensionSkillCandidatesInput = {
  candidate: CapabilityCandidate;
  effective: EffectiveCapabilitySnapshot;
  metadata: Pick<PackageExtensionSourceMetadata, 'skills'>;
  published: Pick<CapabilityPackagePublishedRevision, 'kind' | 'version' | 'checksum'>;
  resourceAccess: CapabilityResourceAccess;
  resourceMetadata: CapabilityResourceMetadata;
};

/** Project checked immutable children; callers retain source/root validation and all authorization. */
export function projectPinnedExtensionSkillCandidates(input: PinnedExtensionSkillCandidatesInput): CapabilityCandidate[] {
  const { candidate, effective, published } = input;
  return input.metadata.skills.map(({ skill }) => {
    const ref = published.kind === 'skill' ? { ...candidate.ref, version: skill.version ?? published.version, checksum: published.checksum }
      : createCapabilityReference({ resourceType: 'skill', scopeType: candidate.ref.scopeType, name: skill.name,
        version: skill.version ?? published.version, revision: candidate.ref.revision, checksum: published.checksum, sourceType: 'plugin',
        organizationId: candidate.ref.organizationId, ownerUserId: candidate.ref.ownerUserId,
        sourcePluginId: candidate.ref.resourceId, sourcePluginName: candidate.ref.name });
    const current = effective.capabilities.find(value => value.ref.resourceId === ref.resourceId);
    return { ...(current ?? candidate), ref, description: skill.description, runtimePath: skill.path,
      ...(published.kind === 'plugin' ? { pluginResourceId: candidate.ref.resourceId } : {}),
      resourceAccess: { ...input.resourceAccess, canEdit: false, canManage: false }, resourceMetadata: input.resourceMetadata };
  });
}

export type PinnedExtensionEffectiveCapabilitiesInput = {
  effective: EffectiveCapabilitySnapshot;
  workflowVersion: AgentWorkflowVersion;
  packages: readonly { candidate: CapabilityCandidate; skills: readonly CapabilityCandidate[] }[];
  role?: string | null;
  policies: readonly CapabilityPolicy[];
};

/** Re-evaluate the supplied, checked selection under the supplied fresh policy; this grants no source access. */
export function projectPinnedExtensionEffectiveCapabilities(input: PinnedExtensionEffectiveCapabilitiesInput): EffectiveCapabilitySnapshot {
  const { effective, packages } = input;
  if (input.workflowVersion === null && !packages.length) return effective;
  const selectedIds = new Set(packages.flatMap(entry => [entry.candidate.ref.resourceId, ...entry.skills.map(skill => skill.ref.resourceId)]));
  const additions = packages.flatMap(entry => entry.skills).filter(candidate => !effective.capabilities.some(entry => entry.ref.resourceId === candidate.ref.resourceId));
  return resolveEffectiveCapabilities({ context: { userId: effective.userId, organizationId: effective.organizationId,
    workspaceId: effective.workspaceId, projectId: effective.projectId, role: input.role },
  candidates: [...effective.capabilities, ...additions].map(candidate => selectedIds.has(candidate.ref.resourceId)
    ? { ...candidate, enabled: true, userPreference: 'enabled' as const, connectionRequirementCount: 0 } : candidate), policies: [...input.policies] });
}

export type ExtensionRuntimeSkillCandidatesInput = {
  effective: EffectiveCapabilitySnapshot;
  agentKind: 'main' | 'special';
  relevantSkills?: readonly string[] | null;
  workflowVersion: AgentWorkflowVersion;
  /** Actual checked package candidates, already normalized to the selected child roots. */
  packageSkills: readonly CapabilityCandidate[];
};

/** Pure selection of supplied candidates. No invented Agent/session or runtime issuer is involved. */
export function selectExtensionRuntimeSkillCandidates(input: ExtensionRuntimeSkillCandidatesInput): CapabilityCandidate[] {
  const { effective } = input;
  const requiredNames = new Set(effective.capabilities.filter(candidate => candidate.ref.resourceType === 'skill'
    && candidate.effectivePolicy === 'required' && candidate.effectiveEnabled).map(candidate => candidate.ref.name));
  const relevant = input.relevantSkills == null ? null : new Set(input.relevantSkills);
  const base = effective.capabilities.filter(candidate => candidate.ref.resourceType === 'skill' && candidate.effectiveEnabled
    && candidate.resourceAccess?.canUse !== false && candidate.readiness === 'available' && candidate.runtimePath)
    .filter(candidate => input.agentKind === 'main' || relevant === null || candidate.ref.sourceType === 'core'
      || requiredNames.has(candidate.ref.name) || relevant.has(candidate.ref.name));
  const selected = input.workflowVersion === null ? base : base.filter(candidate => candidate.ref.sourceType === 'core'
    || effective.capabilities.find(value => value.ref.resourceId === candidate.ref.resourceId)?.effectivePolicy === 'required');
  return [...new Map([...selected, ...input.packageSkills].map(candidate => [candidate.ref.resourceId, candidate])).values()];
}
