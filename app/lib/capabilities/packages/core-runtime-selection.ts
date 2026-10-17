import { createCapabilityResourceId } from '../reference';
import type { CapabilityCandidate, EffectiveCapability } from '../types';

const creatorId = createCapabilityResourceId({ resourceType: 'skill', scopeType: 'system', sourceType: 'core', name: 'create-plugin' });
const parentId = createCapabilityResourceId({ resourceType: 'plugin', scopeType: 'system', sourceType: 'core', name: 'plugin-creator' });
const visualId = createCapabilityResourceId({ resourceType: 'skill', scopeType: 'system', sourceType: 'plugin', name: 'plugin-visual', sourcePluginName: 'plugin-creator' });

export function corePluginDependencyParent(candidate: CapabilityCandidate, candidates: readonly CapabilityCandidate[]): CapabilityCandidate | undefined {
  if (candidate.ref.resourceId !== visualId || candidate.ref.resourceType !== 'skill' || candidate.ref.scopeType !== 'system'
    || candidate.ref.sourceType !== 'plugin' || candidate.ref.sourcePluginId !== parentId || candidate.pluginResourceId !== parentId) return undefined;
  return candidates.find(parent => parent.ref.resourceId === parentId && parent.ref.resourceType === 'plugin'
    && parent.ref.scopeType === 'system' && parent.ref.sourceType === 'core');
}

/** One declared Core dependency follows an already selected Creator; this changes neither policy nor tools. */
export function includeCorePluginSkillDependencies(candidates: readonly CapabilityCandidate[], selected: readonly CapabilityCandidate[]): CapabilityCandidate[] {
  if (!selected.some(candidate => candidate.ref.resourceId === creatorId && candidate.ref.scopeType === 'system'
    && candidate.ref.resourceType === 'skill' && candidate.ref.sourceType === 'core')) return [...selected];
  const available = (candidate: CapabilityCandidate) => {
    const effective = candidate as Partial<EffectiveCapability>;
    return (effective.effectiveEnabled ?? candidate.enabled) && candidate.resourceAccess?.canUse !== false
      && (effective.readiness === undefined || effective.readiness === 'available');
  };
  const dependency = candidates.find(candidate => {
    const parent = corePluginDependencyParent(candidate, candidates);
    return parent && available(parent) && available(candidate) && Boolean(candidate.runtimePath);
  });
  return dependency ? [...new Map([...selected, dependency].map(candidate => [candidate.ref.resourceId, candidate])).values()] : [...selected];
}
