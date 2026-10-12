import type { IntegrationExecutionContext, IntegrationProviderDescriptor } from '../contracts';
import { integrationConnectionProviderScope, type AuthorizedIntegrationConnection } from './contracts';
import { attachIntegrationProviderAuthorization, createSharedIntegrationProviderRef } from './provider-authorization';

/** Issued common authority provides routing metadata without any provider request. */
export async function createSharedIntegrationPolicyDescriptor(
  context: IntegrationExecutionContext,
  authorization: AuthorizedIntegrationConnection,
): Promise<IntegrationProviderDescriptor> {
  const resource = authorization.resource;
  const provider: IntegrationProviderDescriptor = {
    providerRef: createSharedIntegrationProviderRef(resource), source: resource.source,
    application: resource.application || undefined, displayName: resource.displayName,
    scope: integrationConnectionProviderScope(resource), state: 'unknown', configured: true, requiresAuth: 'unknown',
    authorized: 'unknown', health: 'unknown', canExecute: false, checkedAt: null, statusSource: 'configuration',
    pluginRefs: [], skillRefs: [], matchReasons: [], nextActions: [],
  };
  await attachIntegrationProviderAuthorization(context, provider, authorization);
  return provider;
}
