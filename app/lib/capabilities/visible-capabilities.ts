import type { CapabilityReference } from './types';

const SCOPE_PRIORITY = { system: 0, organization: 1, user: 2 } as const;

/**
 * Match the runtime namespace protection without discarding exact identities
 * from the authoritative snapshot. Same-scope collisions remain visible.
 */
export function selectVisibleCapabilities<T extends {
  ref: Pick<CapabilityReference, 'resourceType' | 'scopeType' | 'name' | 'resourceId'>;
}>(capabilities: readonly T[]): T[] {
  const byIdentity = new Map(capabilities.map((entry) => [entry.ref.resourceId, entry]));
  const priorities = new Map<string, number>();
  for (const entry of byIdentity.values()) {
    const key = `${entry.ref.resourceType}:${entry.ref.name.toLowerCase()}`;
    const priority = SCOPE_PRIORITY[entry.ref.scopeType];
    priorities.set(key, Math.min(priorities.get(key) ?? priority, priority));
  }
  return [...byIdentity.values()].filter((entry) => (
    SCOPE_PRIORITY[entry.ref.scopeType] === priorities.get(`${entry.ref.resourceType}:${entry.ref.name.toLowerCase()}`)
  ));
}
