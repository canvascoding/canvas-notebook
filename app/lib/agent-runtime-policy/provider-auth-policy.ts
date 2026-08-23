import type { AiCredentialScope, AiProviderSafeConfig } from '@/app/lib/agent-runtime-policy/types';
import { getAuthMethodForProvider } from '@/app/lib/pi/provider-help';

const CANVAS_CONTROL_PLANE_PROVIDER_ID = 'canvas-control-plane';
const STANDARD_CREDENTIAL_SCOPES = ['system', 'organization', 'user'] as const satisfies readonly AiCredentialScope[];
const USER_CREDENTIAL_SCOPE = ['user'] as const satisfies readonly AiCredentialScope[];
const MANAGED_CREDENTIAL_SCOPE = ['managed'] as const satisfies readonly AiCredentialScope[];

export type AiProviderAuthPolicyIssue =
  | 'INVALID_PROVIDER_AUTH_METHOD'
  | 'OAUTH_REQUIRES_USER_SCOPE';

/**
 * Return the effective authentication method for catalog consumers.
 *
 * OAuth-only providers predate the optional catalog `authMethod` field, so
 * migrated installations may correctly store an empty config. Consumers must
 * derive OAuth from the provider contract instead of treating that optional
 * persisted field as the authority.
 */
export function resolveProviderAuthMethod(
  providerId: string,
  configuredAuthMethod?: AiProviderSafeConfig['authMethod'],
): AiProviderSafeConfig['authMethod'] | undefined {
  const providerAuthMethod = getAuthMethodForProvider(providerId.trim().toLowerCase());
  if (providerAuthMethod === 'oauth') return 'oauth';
  if (providerAuthMethod === 'both') return configuredAuthMethod === 'oauth' ? 'oauth' : 'api-key';
  return configuredAuthMethod;
}

export function providerUsesOAuth(input: {
  providerId: string;
  config: Pick<AiProviderSafeConfig, 'authMethod'>;
}): boolean {
  return resolveProviderAuthMethod(input.providerId, input.config.authMethod) === 'oauth';
}

/**
 * Credential scopes that can safely host one provider installation. OAuth
 * tokens belong to an individual account, while managed credentials are
 * exclusively supplied by the Control Plane.
 */
export function getAllowedCredentialScopesForProvider(
  providerId: string,
  configuredAuthMethod?: AiProviderSafeConfig['authMethod'],
): readonly AiCredentialScope[] {
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (normalizedProviderId === CANVAS_CONTROL_PLANE_PROVIDER_ID) return MANAGED_CREDENTIAL_SCOPE;
  if (resolveProviderAuthMethod(normalizedProviderId, configuredAuthMethod) === 'oauth') return USER_CREDENTIAL_SCOPE;
  return STANDARD_CREDENTIAL_SCOPES;
}

/**
 * Validate only provider authentication semantics. Catalog shape validation
 * remains in catalog-service so this policy can also be reused by client UI.
 */
export function validateProviderCatalogAuth(input: {
  providerId: string;
  credentialScope: AiCredentialScope;
  config: Pick<AiProviderSafeConfig, 'authMethod'>;
}): AiProviderAuthPolicyIssue | null {
  const normalizedProviderId = input.providerId.trim().toLowerCase();
  const providerAuthMethod = getAuthMethodForProvider(normalizedProviderId);
  const configuredAuthMethod = input.config.authMethod;

  if (normalizedProviderId === CANVAS_CONTROL_PLANE_PROVIDER_ID) {
    return configuredAuthMethod ? 'INVALID_PROVIDER_AUTH_METHOD' : null;
  }

  if (providerAuthMethod === 'oauth') {
    if (configuredAuthMethod && configuredAuthMethod !== 'oauth') {
      return 'INVALID_PROVIDER_AUTH_METHOD';
    }
    return input.credentialScope === 'user' ? null : 'OAUTH_REQUIRES_USER_SCOPE';
  }

  if (configuredAuthMethod === 'oauth') {
    if (providerAuthMethod !== 'both') return 'INVALID_PROVIDER_AUTH_METHOD';
    if (input.credentialScope !== 'user') return 'OAUTH_REQUIRES_USER_SCOPE';
  }

  return null;
}
