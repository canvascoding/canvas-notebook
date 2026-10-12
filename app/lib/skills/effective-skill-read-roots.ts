import 'server-only';

import path from 'node:path';

import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { loadCapabilityCandidates, resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
import type {
  CapabilityResolutionContext,
  EffectiveCapabilitySnapshot,
} from '@/app/lib/capabilities/types';
import { selectPromptSkillsForAgent } from '@/app/lib/skills/agent-skill-selection';

type EffectiveRuntimeSkill = {
  name: string;
  enabled: true;
  core: boolean;
  runtimePath: string;
};

export function getEffectiveSkillReadRoots(input: {
  snapshot: EffectiveCapabilitySnapshot;
  agentId?: string | null;
  relevantSkills?: string[] | null;
}): string[] {
  const normalizedAgentId = normalizeManagedAgentId(input.agentId);
  const availableSkills = input.snapshot.capabilities
    .filter((entry) => (
      entry.ref.resourceType === 'skill'
      && entry.effectiveEnabled
      && entry.resourceAccess?.canUse !== false
      && entry.readiness === 'available'
      && Boolean(entry.runtimePath)
    ))
    .map((entry): EffectiveRuntimeSkill => ({
      name: entry.ref.name,
      enabled: true,
      core: entry.ref.sourceType === 'core',
      runtimePath: entry.runtimePath!,
    }));
  const requiredSkillNames = input.snapshot.capabilities
    .filter((entry) => (
      entry.ref.resourceType === 'skill'
      && entry.effectivePolicy === 'required'
      && entry.effectiveEnabled
    ))
    .map((entry) => entry.ref.name);
  const selectedSkills = selectPromptSkillsForAgent(
    normalizedAgentId,
    availableSkills,
    input.relevantSkills,
    requiredSkillNames,
  );

  return Array.from(new Set(
    selectedSkills.map((skill) => path.dirname(path.resolve(skill.runtimePath))),
  ));
}

export async function resolveEffectiveSkillReadRoots(input: CapabilityResolutionContext & {
  agentId?: string | null;
}): Promise<string[]> {
  const normalizedAgentId = normalizeManagedAgentId(input.agentId);
  const [snapshot, agentProfile] = await Promise.all([
    resolveEffectiveCapabilitySnapshot({
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    }),
    getAgentProfile(normalizedAgentId),
  ]);

  return getEffectiveSkillReadRoots({
    snapshot,
    agentId: normalizedAgentId,
    relevantSkills: agentProfile?.relevantSkills,
  });
}

export async function resolvePersonalSkillReadRoots(input: {
  userId: string;
  agentId?: string | null;
}): Promise<string[]> {
  const normalizedAgentId = normalizeManagedAgentId(input.agentId);
  const [candidates, agentProfile] = await Promise.all([
    loadCapabilityCandidates({ userId: input.userId, organizationId: '' }, { resolveConnections: false }),
    getAgentProfile(normalizedAgentId),
  ]);
  const skills = candidates.filter(candidate => candidate.ref.resourceType === 'skill' && candidate.enabled
    && candidate.runtimePath && candidate.resourceAccess?.canUse !== false).map(candidate => ({
    name: candidate.ref.name, enabled: true as const, core: candidate.ref.sourceType === 'core', path: candidate.runtimePath!,
  }));
  const selectedSkills = selectPromptSkillsForAgent(
    normalizedAgentId,
    skills,
    agentProfile?.relevantSkills,
  );
  return Array.from(new Set(
    selectedSkills
      .filter((skill) => skill.enabled)
      .map((skill) => path.dirname(path.resolve(skill.path))),
  ));
}
