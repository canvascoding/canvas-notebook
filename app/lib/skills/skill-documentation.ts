import type { CapabilityCandidate } from '@/app/lib/capabilities/types';

import { parseSkillFile, type CanvasSkill } from './canvas-skill-manifest';

export async function loadCapabilitySkillByReference(
  candidates: CapabilityCandidate[],
  reference: {
    name: string;
    resourceId: string;
  },
): Promise<CanvasSkill | null> {
  const candidate = candidates.find((entry) => (
    entry.ref.resourceType === 'skill'
    && entry.ref.resourceId === reference.resourceId
    && entry.ref.name === reference.name
    && Boolean(entry.runtimePath)
  ));
  if (!candidate?.runtimePath) return null;

  const skill = await parseSkillFile(candidate.runtimePath);
  return skill?.name === reference.name ? skill : null;
}
