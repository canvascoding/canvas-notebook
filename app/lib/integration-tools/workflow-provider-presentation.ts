import { createHash } from 'node:crypto';
import type { IntegrationProviderDescriptor } from './contracts';
import type { PersonalWorkflowProviderBinding, PersonalWorkflowProviderTargetSnapshot } from './workflow-personal-bindings';

/** A stable metadata identity for a canonically parsed binding; no account, credentials or execution proof. */
export function createPersonalWorkflowProviderMetadataReference(binding: PersonalWorkflowProviderBinding): string {
  return `${binding.source}:v1:personal:${createHash('sha256').update(JSON.stringify(binding)).digest('hex')}`;
}

/** Plain configuration metadata. This neither issues nor attaches provider authority. */
export function presentPersonalWorkflowProvider(target: Pick<PersonalWorkflowProviderTargetSnapshot, 'binding' | 'boundProviderRef'>,
  displayName: string): IntegrationProviderDescriptor {
  return { providerRef: target.boundProviderRef, source: target.binding.source,
    ...(target.binding.source === 'composio' ? { application: target.binding.toolkit } : {}), displayName,
    scope: { type: 'user', resourceId: target.boundProviderRef, ownerUserId: target.binding.ownerUserId },
    state: 'unknown', configured: true, requiresAuth: 'unknown', authorized: 'unknown', health: 'unknown', canExecute: false,
    checkedAt: null, statusSource: 'configuration', pluginRefs: [], skillRefs: [], matchReasons: [], nextActions: [{ kind: 'gateway',
      label: 'Check this workflow connection’s tools', request: { action: 'list', target: 'tools', providerRef: target.boundProviderRef } }] };
}
