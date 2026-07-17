import 'server-only';

import path from 'node:path';

import { getAgentProfile, normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { resolveEffectiveCapabilitySnapshot } from '@/app/lib/capabilities/catalog';
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
