import crypto from 'crypto';
import path from 'path';

import { readMcpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import { assertMcpHttpUrlAllowed } from '@/app/lib/mcp/network-policy';
import {
  normalizeMcpScope,
  type McpScope,
} from '@/app/lib/mcp/scope';
import {
  readMcpTextFileIfExists,
  removeMcpStoragePath,
  resolveMcpStoragePath,
  writeMcpTextFileAtomic,
} from '@/app/lib/mcp/storage';

type OAuthServerConfig = {
  issuer?: string;
  resourceMetadataUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  registrationUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  redirectUri?: string;
};

type AuthorizationServerMetadata = Required<Pick<OAuthServerConfig, 'authorizationUrl' | 'tokenUrl'>> & Pick<OAuthServerConfig, 'registrationUrl'> & {
  issuer: string;
  authorizationResponseIssParameterSupported: boolean;
  clientIdMetadataDocumentSupported: boolean;
};

type OAuthResolution = AuthorizationServerMetadata & {
  resource: string;
  scopesSupported: string[];
};

type ProtectedResourceMetadata = {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
};

type OAuthClientRecord = {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  issuer?: string;
  registeredAt?: string;
};

type OAuthScopeChallengeRecord = {
  configHash: string;
  scopes: string[];
  resourceMetadataUrl?: string;
  recordedAt: string;
};

type OAuthStateRecord = {
  state: string;
  serverName: string;
  codeVerifier: string;
  redirectUri: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  serverUrl?: string;
  issuer: string;
  resource: string;
  authorizationResponseIssParameterSupported: boolean;
  configHash: string;
  createdAt: string;
  expiresAt: string;
};

export type OAuthTokenRecord = {
  serverName: string;
  serverUrl?: string;
  issuer: string;
  resource: string;
  configHash: string;
  clientId: string;
  scope?: string;
  tokenType: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  updatedAt: string;
};

export type McpOAuthStatus = {
  serverName: string;
  configured: boolean;
  authorized: boolean;
  requiresAuth: boolean;
  redirectUri: string | null;
  expiresAt: string | null;
  scope: string | null;
  reason?: string;
};

export type McpOAuthStartResult = {
  authorizationUrl: string;
  state: string;
  redirectUri: string;
};

export type McpOAuthClientMetadata = {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
};

class McpOAuthError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'McpOAuthError';
    this.status = status;
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashMcpServerConfig(config: McpServerConfig): string {
  return crypto.createHash('sha256').update(stableStringify(config)).digest('hex');
}

function sanitizeServerName(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'server';
}

function getServerOAuthRelativeDir(serverName: string): string {
  return path.join('mcp-oauth', sanitizeServerName(serverName));
}

function getOAuthTokenRelativePath(serverName: string): string {
  return path.join(getServerOAuthRelativeDir(serverName), 'tokens.json');
}

export function getOAuthTokenPath(serverName: string, scope?: McpScope | null): string {
  return resolveMcpStoragePath(getOAuthTokenRelativePath(serverName), scope);
}

function getOAuthClientRelativePath(serverName: string): string {
  return path.join(getServerOAuthRelativeDir(serverName), 'client.json');
}

function getOAuthScopeChallengeRelativePath(serverName: string): string {
  return path.join(getServerOAuthRelativeDir(serverName), 'scope-challenge.json');
}

function getOAuthStateRelativeDir(): string {
  return path.join('mcp-oauth', '.state');
}

function getOAuthStateRelativePath(state: string): string {
  return path.join(getOAuthStateRelativeDir(), `${sanitizeServerName(state)}.json`);
}

async function writeJsonPrivate(relativePath: string, payload: unknown, scope?: McpScope | null): Promise<void> {
  await writeMcpTextFileAtomic(relativePath, JSON.stringify(payload, null, 2), scope, {
    mode: 0o600,
    directoryMode: 0o700,
  });
}

async function readJsonIfExists<T>(relativePath: string, scope?: McpScope | null): Promise<T | null> {
  try {
    const { content } = await readMcpTextFileIfExists(relativePath, scope);
    return content === null ? null : JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function getOAuthConfig(serverConfig: McpServerConfig): OAuthServerConfig | null {
  const rawOAuth = serverConfig.oauth;
  if (rawOAuth && typeof rawOAuth === 'object' && !Array.isArray(rawOAuth)) {
    return rawOAuth as OAuthServerConfig;
  }
  if (serverConfig.auth === 'oauth') {
    return {};
  }
  return null;
}

function getOriginFromRequest(requestOrigin: string | null | undefined): string {
  const configured = process.env.MCP_OAUTH_BASE_URL;
  const fallback = process.env.BASE_URL || process.env.APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/u, '');
  if (process.env.NODE_ENV === 'production') {
    if (fallback) return fallback.replace(/\/+$/u, '');
    throw new McpOAuthError('MCP_OAUTH_BASE_URL or BASE_URL must be configured in production.');
  }
  return (requestOrigin || fallback || 'http://localhost:3000').replace(/\/+$/u, '');
}

function getRedirectUri(oauth: OAuthServerConfig, requestOrigin: string | null | undefined): string {
  const origin = getOriginFromRequest(requestOrigin);
  return oauth.redirectUri || `${origin}/api/mcp/oauth/callback`;
}

export function getMcpOAuthClientMetadata(requestOrigin?: string | null): McpOAuthClientMetadata {
  const origin = getOriginFromRequest(requestOrigin);
  const clientId = `${origin}/api/mcp/oauth/client-metadata`;
  return {
    client_id: clientId,
    client_name: 'Canvas Notebook MCP',
    client_uri: origin,
    redirect_uris: [`${origin}/api/mcp/oauth/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

function requireAbsoluteUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new McpOAuthError(`${label} must be an absolute URL.`);
  }
  if (parsed.hash) {
    throw new McpOAuthError(`${label} must not contain a fragment.`);
  }
  return value;
}

async function readAuthorizationServerMetadataUrl(metadataUrl: string, expectedIssuer: string): Promise<AuthorizationServerMetadata> {
  const response = await fetch(await assertMcpHttpUrlAllowed(metadataUrl, 'OAuth authorization-server metadata URL'));
  if (!response.ok) {
    throw new McpOAuthError(`OAuth discovery failed with status ${response.status}.`, response.status);
  }
  const metadata = await response.json() as {
    issuer?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
    registration_endpoint?: string;
    code_challenge_methods_supported?: string[];
    authorization_response_iss_parameter_supported?: boolean;
    client_id_metadata_document_supported?: boolean;
  };
  if (metadata.issuer !== expectedIssuer) {
    throw new McpOAuthError('OAuth authorization-server metadata issuer does not exactly match the requested issuer.');
  }
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new McpOAuthError('OAuth discovery response is missing authorization_endpoint or token_endpoint.');
  }
  if (!Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')) {
    throw new McpOAuthError('OAuth authorization server does not advertise required PKCE S256 support.');
  }
  return {
    issuer: expectedIssuer,
    authorizationUrl: metadata.authorization_endpoint,
    tokenUrl: metadata.token_endpoint,
    registrationUrl: metadata.registration_endpoint,
    authorizationResponseIssParameterSupported: metadata.authorization_response_iss_parameter_supported === true,
    clientIdMetadataDocumentSupported: metadata.client_id_metadata_document_supported === true,
  };
}

async function readProtectedResourceMetadataUrl(metadataUrl: string): Promise<ProtectedResourceMetadata> {
  const response = await fetch(await assertMcpHttpUrlAllowed(metadataUrl, 'OAuth protected-resource metadata URL'));
  if (!response.ok) {
    throw new McpOAuthError(`OAuth protected resource discovery failed with status ${response.status}.`, response.status);
  }
  const metadata = await response.json() as ProtectedResourceMetadata;
  const resource = typeof metadata.resource === 'string'
    ? requireAbsoluteUrl(metadata.resource, 'OAuth protected resource identifier')
    : undefined;
  return {
    resource,
    authorization_servers: Array.isArray(metadata.authorization_servers)
      ? metadata.authorization_servers.filter((issuer): issuer is string => typeof issuer === 'string' && issuer.trim().length > 0)
      : undefined,
    scopes_supported: Array.isArray(metadata.scopes_supported)
      ? metadata.scopes_supported.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : undefined,
  };
}

function buildProtectedResourceMetadataUrls(baseUrl: string): string[] {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/u, '');
  const candidates: string[] = [];

  if (pathname) {
    candidates.push(new URL(`/.well-known/oauth-protected-resource${pathname}`, url.origin).toString());
  }
  candidates.push(new URL('/.well-known/oauth-protected-resource', url.origin).toString());
  return Array.from(new Set(candidates));
}

function buildAuthorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(requireAbsoluteUrl(issuer, 'OAuth authorization server issuer'));
  const pathname = url.pathname.replace(/\/+$/u, '');
  const candidates: string[] = [];

  if (pathname) {
    candidates.push(new URL(`/.well-known/oauth-authorization-server${pathname}`, url.origin).toString());
    candidates.push(new URL(`/.well-known/openid-configuration${pathname}`, url.origin).toString());
    candidates.push(`${issuer.replace(/\/+$/u, '')}/.well-known/openid-configuration`);
  } else {
    candidates.push(new URL('/.well-known/oauth-authorization-server', url.origin).toString());
    candidates.push(new URL('/.well-known/openid-configuration', url.origin).toString());
  }

  return Array.from(new Set(candidates));
}

async function readAuthorizationServerMetadata(issuer: string): Promise<AuthorizationServerMetadata> {
  const candidates = buildAuthorizationServerMetadataUrls(issuer);
  let lastError: unknown = null;

  for (const metadataUrl of candidates) {
    try {
      return await readAuthorizationServerMetadataUrl(metadataUrl, issuer);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new McpOAuthError('OAuth discovery failed.');
}

async function discoverProtectedResourceMetadata(serverUrl: string): Promise<ProtectedResourceMetadata | null> {
  const candidates = buildProtectedResourceMetadataUrls(serverUrl);
  let lastNonNotFoundError: unknown = null;

  for (const metadataUrl of candidates) {
    try {
      return await readProtectedResourceMetadataUrl(metadataUrl);
    } catch (error) {
      if (error instanceof McpOAuthError && error.status === 404) continue;
      lastNonNotFoundError = error;
    }
  }

  if (lastNonNotFoundError instanceof Error) {
    throw lastNonNotFoundError;
  }
  return null;
}

async function resolveOAuthEndpoints(oauth: OAuthServerConfig, serverConfig?: McpServerConfig): Promise<OAuthResolution> {
  const issuers: string[] = [];
  let protectedResourceMetadata: ProtectedResourceMetadata | null = null;

  if (oauth.resourceMetadataUrl) {
    protectedResourceMetadata = await readProtectedResourceMetadataUrl(oauth.resourceMetadataUrl);
  }

  const serverUrl = typeof serverConfig?.url === 'string' ? serverConfig.url.trim() : '';
  if (!protectedResourceMetadata && serverUrl) {
    protectedResourceMetadata = await discoverProtectedResourceMetadata(serverUrl).catch((error) => {
      if (oauth.issuer || (oauth.authorizationUrl && oauth.tokenUrl)) return null;
      throw error;
    });
  }

  if (oauth.issuer) issuers.push(oauth.issuer);
  issuers.push(...(protectedResourceMetadata?.authorization_servers || []));
  if (!issuers.length && oauth.authorizationUrl) issuers.push(new URL(oauth.authorizationUrl).origin);
  if (!issuers.length && serverUrl) issuers.push(new URL(serverUrl).origin);

  const resource = protectedResourceMetadata?.resource
    || (serverUrl ? requireAbsoluteUrl(serverUrl, 'MCP server URL') : '');
  if (!resource) {
    throw new McpOAuthError('OAuth MCP server requires an HTTP url or protected resource metadata with a resource identifier.');
  }

  const uniqueIssuers = Array.from(new Set(issuers.filter(Boolean)));
  let lastError: unknown = null;
  for (const issuer of uniqueIssuers) {
    try {
      const metadata = await readAuthorizationServerMetadata(issuer);
      return {
        ...metadata,
        authorizationUrl: oauth.authorizationUrl || metadata.authorizationUrl,
        tokenUrl: oauth.tokenUrl || metadata.tokenUrl,
        registrationUrl: oauth.registrationUrl || metadata.registrationUrl,
        resource,
        scopesSupported: protectedResourceMetadata?.scopes_supported || [],
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (!uniqueIssuers.length) {
    throw new McpOAuthError('OAuth MCP server requires oauth.issuer, protected resource metadata, or an HTTP url for discovery.');
  }

  throw lastError instanceof Error ? lastError : new McpOAuthError('OAuth discovery failed.');
}

function getOAuthApplicationType(redirectUri: string): 'native' | 'web' {
  const hostname = new URL(redirectUri).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
    ? 'native'
    : 'web';
}

async function resolveClient(
  serverName: string,
  oauth: OAuthServerConfig,
  redirectUri: string,
  issuer: string,
  clientIdMetadataDocumentSupported: boolean,
  registrationUrl?: string,
  scope?: McpScope | null,
): Promise<{ clientId: string; clientSecret?: string }> {
  if (oauth.clientId) {
    return { clientId: oauth.clientId, clientSecret: oauth.clientSecret };
  }

  const clientMetadataUrl = new URL('/api/mcp/oauth/client-metadata', redirectUri);
  if (clientIdMetadataDocumentSupported && clientMetadataUrl.protocol === 'https:') {
    return { clientId: clientMetadataUrl.toString() };
  }

  const existing = await readJsonIfExists<OAuthClientRecord>(getOAuthClientRelativePath(serverName), scope);
  if (existing?.clientId && existing.redirectUri === redirectUri && existing.issuer === issuer) {
    return { clientId: existing.clientId, clientSecret: existing.clientSecret };
  }

  if (!registrationUrl) {
    if (existing?.clientId && !existing.redirectUri && existing.issuer === issuer) {
      return { clientId: existing.clientId, clientSecret: existing.clientSecret };
    }
    if (existing?.clientId && existing.issuer !== issuer) {
      throw new McpOAuthError(`Stored OAuth client for MCP server "${serverName}" belongs to a different authorization-server issuer. Clear OAuth credentials and authorize again.`);
    }
    if (existing?.clientId) {
      throw new McpOAuthError(`Stored OAuth client for MCP server "${serverName}" was registered with a different redirect URI. Clear OAuth credentials and authorize again.`);
    }
    throw new McpOAuthError('OAuth MCP server requires oauth.clientId unless Dynamic Client Registration is available.');
  }

  const response = await fetch(await assertMcpHttpUrlAllowed(registrationUrl, 'OAuth dynamic client registration URL'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Canvas Notebook MCP',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: getOAuthApplicationType(redirectUri),
    }),
  });
  if (!response.ok) {
    throw new McpOAuthError(`OAuth dynamic client registration failed with status ${response.status}.`);
  }
  const registered = await response.json() as { client_id?: string; client_secret?: string };
  if (!registered.client_id) {
    throw new McpOAuthError('OAuth dynamic client registration response is missing client_id.');
  }

  const client = {
    clientId: registered.client_id,
    clientSecret: registered.client_secret,
    redirectUri,
    issuer,
    registeredAt: new Date().toISOString(),
  } satisfies OAuthClientRecord;
  await writeJsonPrivate(getOAuthClientRelativePath(serverName), client, scope);
  return client;
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function resolveServerForOAuth(serverName: string, scope?: McpScope | null): Promise<{ serverConfig: McpServerConfig; oauth: OAuthServerConfig; configHash: string }> {
  const config = await readMcpConfig(scope);
  const serverConfig = config.mcpServers[serverName];
  if (!serverConfig) {
    throw new McpOAuthError(`Unknown MCP server "${serverName}".`);
  }
  const oauth = getOAuthConfig(serverConfig);
  if (!oauth) {
    throw new McpOAuthError(`MCP server "${serverName}" is not configured for OAuth.`);
  }
  return { serverConfig, oauth, configHash: hashMcpServerConfig(serverConfig) };
}

export async function getMcpOAuthStatus(serverName: string, requestOrigin?: string | null, scope?: McpScope | null): Promise<McpOAuthStatus> {
  const normalizedScope = normalizeMcpScope(scope);
  try {
    const config = await readMcpConfig(normalizedScope);
    const serverConfig = config.mcpServers[serverName];
    if (!serverConfig) {
      throw new McpOAuthError(`Unknown MCP server "${serverName}".`);
    }

    const oauth = getOAuthConfig(serverConfig);
    if (!oauth) {
      return {
        serverName,
        configured: true,
        requiresAuth: false,
        authorized: false,
        redirectUri: null,
        expiresAt: null,
        scope: null,
      };
    }

    const configHash = hashMcpServerConfig(serverConfig);
    const token = await readJsonIfExists<OAuthTokenRecord>(getOAuthTokenRelativePath(serverName), normalizedScope);
    const serverUrl = typeof serverConfig.url === 'string' ? serverConfig.url : undefined;
    const bound = Boolean(
      token
      && token.configHash === configHash
      && token.issuer
      && token.resource
      && (!serverUrl || token.serverUrl === serverUrl),
    );
    const redirectUri = getRedirectUri(oauth, requestOrigin);
    return {
      serverName,
      configured: true,
      requiresAuth: true,
      authorized: bound,
      redirectUri,
      expiresAt: bound ? token?.expiresAt || null : null,
      scope: bound ? token?.scope || null : null,
      reason: token && !bound ? 'Stored token does not match the current server config.' : undefined,
    };
  } catch (error) {
    return {
      serverName,
      configured: false,
      requiresAuth: false,
      authorized: false,
      redirectUri: null,
      expiresAt: null,
      scope: null,
      reason: error instanceof Error ? error.message : 'OAuth status unavailable.',
    };
  }
}

export async function startMcpOAuth(serverName: string, requestOrigin?: string | null, mcpScope?: McpScope | null): Promise<McpOAuthStartResult> {
  const normalizedScope = normalizeMcpScope(mcpScope);
  const { serverConfig, oauth, configHash } = await resolveServerForOAuth(serverName, normalizedScope);
  const redirectUri = getRedirectUri(oauth, requestOrigin);
  const endpoints = await resolveOAuthEndpoints(oauth, serverConfig);
  const client = await resolveClient(
    serverName,
    oauth,
    redirectUri,
    endpoints.issuer,
    endpoints.clientIdMetadataDocumentSupported,
    endpoints.registrationUrl,
    normalizedScope,
  );
  const pkce = createPkcePair();
  const state = base64Url(crypto.randomBytes(24));
  const requestedScopes = new Set(
    Array.isArray(oauth.scopes) ? oauth.scopes : endpoints.scopesSupported,
  );
  const [existingToken, scopeChallenge] = await Promise.all([
    readJsonIfExists<OAuthTokenRecord>(getOAuthTokenRelativePath(serverName), normalizedScope),
    readJsonIfExists<OAuthScopeChallengeRecord>(getOAuthScopeChallengeRelativePath(serverName), normalizedScope),
  ]);
  if (existingToken?.configHash === configHash && existingToken.scope) {
    existingToken.scope.split(/\s+/u).filter(Boolean).forEach((entry) => requestedScopes.add(entry));
  }
  if (scopeChallenge?.configHash === configHash) {
    scopeChallenge.scopes.forEach((entry) => requestedScopes.add(entry));
  }
  const oauthScope = requestedScopes.size ? Array.from(requestedScopes).join(' ') : undefined;

  const authorizationUrl = new URL(endpoints.authorizationUrl);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', client.clientId);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge', pkce.challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('resource', endpoints.resource);
  if (oauthScope) {
    authorizationUrl.searchParams.set('scope', oauthScope);
  }

  await writeJsonPrivate(getOAuthStateRelativePath(state), {
    state,
    serverName,
    codeVerifier: pkce.verifier,
    redirectUri,
    tokenUrl: endpoints.tokenUrl,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    scope: oauthScope,
    serverUrl: typeof serverConfig.url === 'string' ? serverConfig.url : undefined,
    issuer: endpoints.issuer,
    resource: endpoints.resource,
    authorizationResponseIssParameterSupported: endpoints.authorizationResponseIssParameterSupported,
    configHash,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  } satisfies OAuthStateRecord, normalizedScope);

  return {
    authorizationUrl: authorizationUrl.toString(),
    state,
    redirectUri,
  };
}

function isExpired(token: OAuthTokenRecord): boolean {
  if (!token.expiresAt) return false;
  return Date.parse(token.expiresAt) <= Date.now() + 60_000;
}

async function exchangeToken(params: URLSearchParams, tokenUrl: string, clientSecret?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${params.get('client_id')}:${clientSecret}`).toString('base64')}`;
  }
  const response = await fetch(await assertMcpHttpUrlAllowed(tokenUrl, 'OAuth token URL'), { method: 'POST', headers, body: params });
  if (!response.ok) {
    throw new McpOAuthError(`OAuth token endpoint returned status ${response.status}.`, response.status);
  }
  return await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
}

async function resolveClientSecretForRefresh(
  serverName: string,
  oauth: OAuthServerConfig | null,
  clientId: string,
  issuer: string,
  scope?: McpScope | null,
): Promise<string | undefined> {
  if (oauth?.clientSecret) {
    return oauth.clientSecret;
  }

  const storedClient = await readJsonIfExists<OAuthClientRecord>(getOAuthClientRelativePath(serverName), scope);
  if (storedClient?.clientId === clientId && storedClient.issuer === issuer) {
    return storedClient.clientSecret;
  }

  return undefined;
}

async function consumeOAuthState(state: string, responseIssuer: string | null | undefined, scope?: McpScope | null): Promise<OAuthStateRecord> {
  const normalizedScope = normalizeMcpScope(scope);
  const stateRelativePath = getOAuthStateRelativePath(state);
  const stored = await readJsonIfExists<OAuthStateRecord>(stateRelativePath, normalizedScope);
  if (!stored || stored.state !== state || Date.parse(stored.expiresAt) <= Date.now()) {
    await removeMcpStoragePath(stateRelativePath, normalizedScope).catch(() => undefined);
    throw new McpOAuthError('Invalid or expired OAuth state.');
  }
  await removeMcpStoragePath(stateRelativePath, normalizedScope);

  if (stored.authorizationResponseIssParameterSupported && !responseIssuer) {
    throw new McpOAuthError('OAuth authorization response is missing the required issuer parameter.');
  }
  if (responseIssuer && responseIssuer !== stored.issuer) {
    throw new McpOAuthError('OAuth authorization response issuer does not exactly match the expected issuer.');
  }
  return stored;
}

export async function rejectMcpOAuthCallback(state: string, responseIssuer?: string | null, scope?: McpScope | null): Promise<void> {
  await consumeOAuthState(state, responseIssuer, scope);
}

export async function recordMcpOAuthScopeChallenge(
  serverName: string,
  configHash: string,
  requiredScope: string | undefined,
  resourceMetadataUrl?: string,
  scope?: McpScope | null,
): Promise<string[]> {
  const normalizedScope = normalizeMcpScope(scope);
  const challengePath = getOAuthScopeChallengeRelativePath(serverName);
  const existing = await readJsonIfExists<OAuthScopeChallengeRecord>(challengePath, normalizedScope);
  const scopes = new Set(
    existing?.configHash === configHash ? existing.scopes : [],
  );
  requiredScope?.split(/\s+/u).filter(Boolean).forEach((entry) => scopes.add(entry));
  const accumulated = Array.from(scopes);
  if (!accumulated.length) return accumulated;
  await writeJsonPrivate(challengePath, {
    configHash,
    scopes: accumulated,
    resourceMetadataUrl,
    recordedAt: new Date().toISOString(),
  } satisfies OAuthScopeChallengeRecord, normalizedScope);
  return accumulated;
}

export async function completeMcpOAuthCallback(
  code: string,
  state: string,
  responseIssuer?: string | null,
  scope?: McpScope | null,
): Promise<OAuthTokenRecord> {
  const normalizedScope = normalizeMcpScope(scope);
  const stored = await consumeOAuthState(state, responseIssuer, normalizedScope);

  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('code', code);
  params.set('redirect_uri', stored.redirectUri);
  params.set('client_id', stored.clientId);
  params.set('code_verifier', stored.codeVerifier);
  params.set('resource', stored.resource);
  if (stored.clientSecret) {
    params.set('client_secret', stored.clientSecret);
  }

  const exchanged = await exchangeToken(params, stored.tokenUrl, stored.clientSecret);
  if (!exchanged.access_token) {
    throw new McpOAuthError('OAuth token response is missing access_token.');
  }

  const token: OAuthTokenRecord = {
    serverName: stored.serverName,
    serverUrl: stored.serverUrl,
    issuer: stored.issuer,
    resource: stored.resource,
    configHash: stored.configHash,
    clientId: stored.clientId,
    scope: exchanged.scope || stored.scope,
    tokenType: exchanged.token_type || 'Bearer',
    accessToken: exchanged.access_token,
    refreshToken: exchanged.refresh_token,
    expiresAt: exchanged.expires_in ? new Date(Date.now() + exchanged.expires_in * 1000).toISOString() : undefined,
    updatedAt: new Date().toISOString(),
  };

  await writeJsonPrivate(getOAuthTokenRelativePath(stored.serverName), token, normalizedScope);
  await removeMcpStoragePath(getOAuthScopeChallengeRelativePath(stored.serverName), normalizedScope).catch(() => undefined);
  return token;
}

export async function clearMcpOAuth(serverName: string, scope?: McpScope | null): Promise<void> {
  await removeMcpStoragePath(getServerOAuthRelativeDir(serverName), scope, { recursive: true });
}

export async function getValidMcpAccessToken(serverName: string, serverConfig: McpServerConfig, configHash: string, scope?: McpScope | null): Promise<string | null> {
  const normalizedScope = normalizeMcpScope(scope);
  if (!getOAuthConfig(serverConfig)) return null;
  const tokenRelativePath = getOAuthTokenRelativePath(serverName);
  const token = await readJsonIfExists<OAuthTokenRecord>(tokenRelativePath, normalizedScope);
  const serverUrl = typeof serverConfig.url === 'string' ? serverConfig.url : undefined;
  if (!token || !token.issuer || !token.resource || token.configHash !== configHash || (serverUrl && token.serverUrl !== serverUrl)) {
    throw new McpOAuthError(`MCP server "${serverName}" requires OAuth authorization. Use mcp auth_start.`);
  }
  if (!isExpired(token)) {
    return token.accessToken;
  }
  if (!token.refreshToken) {
    throw new McpOAuthError(`OAuth token for MCP server "${serverName}" expired. Use mcp auth_start.`);
  }

  const oauth = getOAuthConfig(serverConfig);
  const endpoints = await resolveOAuthEndpoints(oauth || {}, serverConfig);
  if (token.issuer !== endpoints.issuer || token.resource !== endpoints.resource) {
    throw new McpOAuthError(`OAuth credentials for MCP server "${serverName}" do not match the current authorization server or resource. Reauthorize the server in Settings > Integrations.`);
  }
  const clientSecret = await resolveClientSecretForRefresh(serverName, oauth, token.clientId, endpoints.issuer, normalizedScope);
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', token.refreshToken);
  params.set('client_id', token.clientId);
  params.set('resource', endpoints.resource);
  if (clientSecret) params.set('client_secret', clientSecret);
  let refreshed: Awaited<ReturnType<typeof exchangeToken>>;
  try {
    refreshed = await exchangeToken(params, endpoints.tokenUrl, clientSecret);
  } catch (error) {
    if (error instanceof McpOAuthError && (error.status === 400 || error.status === 401)) {
      await removeMcpStoragePath(tokenRelativePath, normalizedScope);
      throw new McpOAuthError(`OAuth token for MCP server "${serverName}" could not be refreshed. Reauthorize the server in Settings > Integrations.`);
    }
    throw error;
  }
  if (!refreshed.access_token) {
    throw new McpOAuthError('OAuth refresh response is missing access_token.');
  }

  const updated: OAuthTokenRecord = {
    ...token,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || token.refreshToken,
    tokenType: refreshed.token_type || token.tokenType || 'Bearer',
    scope: refreshed.scope || token.scope,
    expiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : token.expiresAt,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonPrivate(tokenRelativePath, updated, normalizedScope);
  return updated.accessToken;
}
