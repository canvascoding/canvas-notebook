export const DIRECT_MCP_FEATURE_ENV = 'CANVAS_MCP_DIRECT_ENABLED';

export const DIRECT_MCP_OAUTH_SCOPES = [
  'openid',
  'offline_access',
  'workspace:list',
  'knowledge:tree',
  'knowledge:search',
  'knowledge:read',
] as const;

export const DIRECT_MCP_RESOURCE_SCOPES = [
  'workspace:list',
  'knowledge:tree',
  'knowledge:search',
  'knowledge:read',
] as const;

export type DirectMcpOAuthScope = (typeof DIRECT_MCP_OAUTH_SCOPES)[number];
export type DirectMcpResourceScope = (typeof DIRECT_MCP_RESOURCE_SCOPES)[number];

type DirectMcpEnvironment = Record<string, string | undefined>;

export type DirectMcpServerConfig = {
  enabled: true;
  origin: string;
  issuer: string;
  resource: string;
  authorizationServerMetadataUrl: string;
  authorizationServerMetadataAliasUrl: string;
  protectedResourceMetadataUrl: string;
  protectedResourceMetadataAliasUrl: string;
};

function readFeatureFlag(environment: DirectMcpEnvironment): boolean {
  const value = environment[DIRECT_MCP_FEATURE_ENV]?.trim().toLowerCase();
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${DIRECT_MCP_FEATURE_ENV} must be either "true" or "false".`);
}

function resolveConfiguredOrigin(environment: DirectMcpEnvironment): string {
  const betterAuthBaseUrl = environment.BETTER_AUTH_BASE_URL?.trim();
  const baseUrl = environment.BASE_URL?.trim();
  if (!betterAuthBaseUrl && !baseUrl) {
    throw new Error(
      `${DIRECT_MCP_FEATURE_ENV}=true requires BETTER_AUTH_BASE_URL or BASE_URL.`,
    );
  }

  const selected = betterAuthBaseUrl || baseUrl || '';
  let parsed: URL;
  try {
    parsed = new URL(selected);
  } catch {
    throw new Error('The configured Better Auth base URL must be an absolute HTTP(S) URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('The configured Better Auth base URL must use HTTP or HTTPS.');
  }
  if (
    parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(
      'The configured Better Auth base URL must contain only the public instance origin.',
    );
  }

  const nodeEnvironment = environment.NODE_ENV?.trim().toLowerCase();
  const isProductionRuntime = nodeEnvironment === 'production'
    && environment.NEXT_PHASE !== 'phase-production-build';
  if (isProductionRuntime && parsed.protocol !== 'https:') {
    throw new Error('Direct MCP OAuth requires an HTTPS public origin in production.');
  }
  if (
    parsed.protocol === 'http:'
    && parsed.hostname !== 'localhost'
    && parsed.hostname !== '127.0.0.1'
    && parsed.hostname !== '[::1]'
  ) {
    throw new Error('Direct MCP OAuth permits HTTP only on a local development origin.');
  }

  if (betterAuthBaseUrl && baseUrl) {
    let normalizedBaseUrl: string;
    try {
      normalizedBaseUrl = new URL(baseUrl).origin;
    } catch {
      throw new Error('BASE_URL must be an absolute HTTP(S) URL when Direct MCP is enabled.');
    }
    if (normalizedBaseUrl !== parsed.origin) {
      throw new Error(
        'BETTER_AUTH_BASE_URL and BASE_URL must use the same public origin for Direct MCP.',
      );
    }
  }

  return parsed.origin;
}

export function isDirectMcpEnabled(
  environment: DirectMcpEnvironment = process.env,
): boolean {
  return readFeatureFlag(environment);
}

export function resolveDirectMcpServerConfig(
  environment: DirectMcpEnvironment = process.env,
): DirectMcpServerConfig {
  if (!readFeatureFlag(environment)) {
    throw new Error(`${DIRECT_MCP_FEATURE_ENV} is not enabled.`);
  }

  const origin = resolveConfiguredOrigin(environment);
  const issuer = `${origin}/api/auth`;
  const resource = `${origin}/mcp`;

  return {
    enabled: true,
    origin,
    issuer,
    resource,
    authorizationServerMetadataUrl: `${origin}/.well-known/oauth-authorization-server/api/auth`,
    authorizationServerMetadataAliasUrl: `${issuer}/.well-known/oauth-authorization-server`,
    protectedResourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
    protectedResourceMetadataAliasUrl: `${origin}/.well-known/oauth-protected-resource`,
  };
}
