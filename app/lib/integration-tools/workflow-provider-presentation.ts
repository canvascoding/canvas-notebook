import type { IntegrationProviderDescriptor } from './contracts';
import type { PersonalWorkflowProviderTargetSnapshot } from './workflow-personal-bindings';

/** Plain configuration metadata. This neither issues nor attaches provider authority. */
export function presentPersonalWorkflowProvider(target: PersonalWorkflowProviderTargetSnapshot,
  displayName: string): IntegrationProviderDescriptor {
  return { providerRef: target.boundProviderRef, source: target.binding.source,
    ...(target.binding.source === 'composio' ? { application: target.binding.toolkit } : {}), displayName,
    scope: { type: 'user', resourceId: target.boundProviderRef, ownerUserId: target.binding.ownerUserId },
    state: 'unknown', configured: true, requiresAuth: 'unknown', authorized: 'unknown', health: 'unknown', canExecute: false,
    checkedAt: null, statusSource: 'configuration', pluginRefs: [], skillRefs: [], matchReasons: [], nextActions: [{ kind: 'gateway',
      label: 'Check this workflow connection’s tools', request: { action: 'list', target: 'tools', providerRef: target.boundProviderRef } }] };
}
