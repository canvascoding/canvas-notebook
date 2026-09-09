import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'node:fs';

import { type McpServerConfig } from '@/app/lib/mcp/config';
import { hashMcpAuthConfig, hashMcpLegacyConfig } from '@/app/lib/mcp/connection-identity';
import { migrateMcpConnectionCredentials, readMcpCredentialJson, resolveMcpCredentialConnection, writeMcpCredentialJson } from '@/app/lib/mcp/credential-storage';
import { commitMcpOAuthLifecycle, fencedMcpOAuthWrite, invalidateMcpOAuthLifecycle, readMcpOAuthLifecycle, withMcpOAuthLifecycleLock } from '@/app/lib/mcp/oauth-lifecycle';
import { withMcpStorageLock } from '@/app/lib/mcp/storage-lock';
import { fetchMcpHttp } from '@/app/lib/mcp/http';
import {
  normalizeMcpScope,
  requireMcpCredentialScope,
  type McpScope,
} from '@/app/lib/mcp/scope';
import {
  removeMcpStoragePath,
  readMcpTextFileIfExists,
  resolveMcpStoragePath,
} from '@/app/lib/mcp/storage';

type OAuthServerConfig = {
  issuer?: string;
  resourceMetadataUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  registrationUrl?: string;
  revocationUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  redirectUri?: string;
};

type AuthorizationServerMetadata = Required<Pick<OAuthServerConfig, 'authorizationUrl' | 'tokenUrl'>> & Pick<OAuthServerConfig, 'registrationUrl' | 'revocationUrl'> & {
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
  lifecycleGeneration?: number;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  issuer?: string;
  registeredAt?: string;
};

type OAuthScopeChallengeRecord = {
  lifecycleGeneration?: number;
  configHash: string;
  scopes: string[];
  resourceMetadataUrl?: string;
  recordedAt: string;
};

type OAuthStateRecord = {
  connectionId: string;
  authVersion: number;
  lifecycleGeneration: number;
  state: string;
  serverName: string;
  codeVerifier: string;
  redirectUri: string;
  tokenUrl: string;
  revocationUrl?: string;
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

type OAuthConnectionSnapshot = Pick<OAuthStateRecord, 'connectionId' | 'authVersion' | 'configHash' | 'lifecycleGeneration'>;

export type OAuthTokenRecord = {
  lifecycleGeneration?: number;
  revocationUrl?: string;
  connectionId?: string;
  authVersion?: number;
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
  authVersion: number;
  authStatus: 'not_authorized' | 'authorized' | 'refreshing' | 'reauth_required';
  lastCompletedState?: string;
  code?: string;
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

export class McpOAuthError extends Error {
  status?: number;
  code?: 'invalid_grant' | 'invalid_token' | 'insufficient_scope' | 'rate_limited' | 'provider_unavailable' | 'network_error' | 'reauth_required';

  constructor(message: string, status?: number, code?: McpOAuthError['code']) {
    super(message);
    this.name = 'McpOAuthError';
    this.status = status;
    this.code = code;
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function hashMcpServerConfig(config: McpServerConfig): string {
  return hashMcpAuthConfig(config);
}

function sanitizeServerName(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_.-]/g, '_') || 'server';
}

async function getServerOAuthRelativeDir(serverName: string, scope?: McpScope | null): Promise<string> {
  return migrateMcpConnectionCredentials(serverName, scope);
}

async function getOAuthTokenRelativePath(serverName: string, scope?: McpScope | null): Promise<string> {
  return path.posix.join(await getServerOAuthRelativeDir(serverName, scope), 'tokens.json');
}

export async function getOAuthTokenPath(serverName: string, scope?: McpScope | null): Promise<string> {
  return resolveMcpStoragePath(await getOAuthTokenRelativePath(serverName, scope), scope);
}

async function getOAuthClientRelativePath(serverName: string, scope?: McpScope | null): Promise<string> {
  return path.posix.join(await getServerOAuthRelativeDir(serverName, scope), 'client.json');
}

async function getOAuthScopeChallengeRelativePath(serverName: string, scope?: McpScope | null): Promise<string> {
  return path.posix.join(await getServerOAuthRelativeDir(serverName, scope), 'scope-challenge.json');
}

function getOAuthStateRelativeDir(): string {
  return 'oauth-states';
}

function getOAuthStateRelativePath(state: string): string {
  return path.join(getOAuthStateRelativeDir(), `${sanitizeServerName(state)}.json`);
}

async function writeJsonPrivate(relativePath: string, payload: unknown, scope?: McpScope | null): Promise<void> {
  await writeMcpCredentialJson(relativePath, payload, scope);
}

async function readJsonIfExists<T>(relativePath: string, scope?: McpScope | null): Promise<T | null> {
  return readMcpCredentialJson<T>(relativePath, scope);
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
  const response = await fetchMcpHttp(metadataUrl, undefined, { purpose: 'OAuth authorization-server metadata URL', maxBytes: 1024 * 1024 });
  if (!response.ok) {
    throw new McpOAuthError(`OAuth discovery failed with status ${response.status}.`, response.status);
  }
  const metadata = await response.json() as {
    issuer?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
    registration_endpoint?: string;
    revocation_endpoint?: string;
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
    revocationUrl: metadata.revocation_endpoint,
    authorizationResponseIssParameterSupported: metadata.authorization_response_iss_parameter_supported === true,
    clientIdMetadataDocumentSupported: metadata.client_id_metadata_document_supported === true,
  };
}

async function readProtectedResourceMetadataUrl(metadataUrl: string): Promise<ProtectedResourceMetadata> {
  const response = await fetchMcpHttp(metadataUrl, undefined, { purpose: 'OAuth protected-resource metadata URL', maxBytes: 1024 * 1024 });
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
  else issuers.push(...(protectedResourceMetadata?.authorization_servers || []));
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
        revocationUrl: oauth.revocationUrl || metadata.revocationUrl,
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
  snapshot: OAuthConnectionSnapshot,
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

  const clientPath = await getOAuthClientRelativePath(serverName, scope);
  const stored = await readJsonIfExists<OAuthClientRecord>(clientPath, scope);
  const existing = stored && (stored.lifecycleGeneration ?? 0) === snapshot.lifecycleGeneration ? stored : null;
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

  const response = await fetchMcpHttp(registrationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Canvas Notebook MCP',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: getOAuthApplicationType(redirectUri),
    }),
  }, { purpose: 'OAuth registration URL', maxBytes: 1024 * 1024 });
  if (!response.ok) {
    throw new McpOAuthError(`OAuth dynamic client registration failed with status ${response.status}.`);
  }
  const registered = await response.json() as { client_id?: string; client_secret?: string };
  if (typeof registered.client_id !== 'string' || !registered.client_id.trim()
    || (registered.client_secret !== undefined && typeof registered.client_secret !== 'string')) {
    throw new McpOAuthError('OAuth dynamic client registration response is missing client_id.');
  }

  const client = {
    lifecycleGeneration: snapshot.lifecycleGeneration,
    clientId: registered.client_id,
    clientSecret: registered.client_secret,
    redirectUri,
    issuer,
    registeredAt: new Date().toISOString(),
  } satisfies OAuthClientRecord;
  await assertCurrentOAuthState(snapshot, scope);
  await fencedMcpOAuthWrite(snapshot.connectionId, snapshot.lifecycleGeneration, scope, () => writeJsonPrivate(clientPath, client, scope));
  return client;
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function resolveServerForOAuth(serverName: string, scope?: McpScope | null): Promise<{ serverConfig: McpServerConfig & { connectionId: string }; oauth: OAuthServerConfig; configHash: string }> {
  const serverConfig = await resolveMcpCredentialConnection(serverName, scope);
  if (serverConfig.enabled === false) throw new McpOAuthError('MCP connection is disabled.', 409);
  const oauth = getOAuthConfig(serverConfig);
  if (!oauth) throw new McpOAuthError(`MCP server "${serverName}" is not configured for OAuth.`);
  return { serverConfig, oauth, configHash: hashMcpServerConfig(serverConfig) };
}

export async function getMcpOAuthStatus(serverName: string, requestOrigin?: string | null, scope?: McpScope | null): Promise<McpOAuthStatus> {
  const normalizedScope = normalizeMcpScope(scope);
  let configured = false;
  let requiresAuth = false;
  let authVersion = 0;
  try {
    const serverConfig = await resolveMcpCredentialConnection(serverName, normalizedScope);
    configured = true;
    authVersion = serverConfig.authVersion || 1;

    const oauth = getOAuthConfig(serverConfig);
    requiresAuth = Boolean(oauth);
    if (!oauth) {
      return {
        serverName,
        configured: true,
        requiresAuth: false,
        authorized: false,
        redirectUri: null,
        expiresAt: null,
        scope: null,
        authVersion: serverConfig.authVersion || 1,
        authStatus: 'not_authorized',
      };
    }

    const lifecycle = await readMcpOAuthLifecycle(serverConfig.connectionId, normalizedScope);
    const token = await readJsonIfExists<OAuthTokenRecord>((await getOAuthTokenRelativePath(serverName, scope)), normalizedScope);
    const bound = isBoundOAuthToken(token, serverConfig, lifecycle.generation);
    const authorized = bound && (!isExpired(token) || Boolean(token.refreshToken));
    const redirectUri = getRedirectUri(oauth, requestOrigin);
    return {
      serverName,
      configured: true,
      requiresAuth: true,
      authorized,
      redirectUri,
      expiresAt: bound ? token?.expiresAt || null : null,
      scope: bound ? token?.scope || null : null,
      authVersion: serverConfig.authVersion || 1,
      authStatus: authorized ? 'authorized' : token ? 'reauth_required' : 'not_authorized',
      lastCompletedState: lifecycle.lastCompletedState,
      code: authorized ? undefined : 'reauth_required',
      reason: token && !bound ? 'Stored token does not match the current server config.' : undefined,
    };
  } catch (error) {
    return {
      serverName,
      configured,
      requiresAuth,
      authorized: false,
      redirectUri: null,
      expiresAt: null,
      scope: null,
      authVersion,
      authStatus: 'not_authorized',
      code: 'unavailable',
      reason: error instanceof Error ? error.message : 'OAuth status unavailable.',
    };
  }
}

export async function startMcpOAuth(serverName: string, requestOrigin?: string | null, mcpScope?: McpScope | null): Promise<McpOAuthStartResult> {
  const normalizedScope = requireMcpCredentialScope(mcpScope);
  const scope = normalizedScope;
  const { serverConfig, oauth, configHash } = await resolveServerForOAuth(serverName, normalizedScope);
  const lifecycle = await readMcpOAuthLifecycle(serverConfig.connectionId, normalizedScope);
  const snapshot: OAuthConnectionSnapshot = {
    connectionId: serverConfig.connectionId, authVersion: serverConfig.authVersion || 1,
    configHash, lifecycleGeneration: lifecycle.generation,
  };
  return withMcpOAuthLifecycleLock(serverConfig.connectionId, normalizedScope, async () => {
    await assertCurrentOAuthState(snapshot, normalizedScope);
    const redirectUri = getRedirectUri(oauth, requestOrigin);
    const endpoints = await resolveOAuthEndpoints(oauth, serverConfig);
    const client = await resolveClient(
      serverName,
      oauth,
      redirectUri,
      endpoints.issuer,
      endpoints.clientIdMetadataDocumentSupported,
      snapshot,
      endpoints.registrationUrl,
      normalizedScope,
    );
    const pkce = createPkcePair();
    const state = base64Url(crypto.randomBytes(24));
    const requestedScopes = new Set(
      Array.isArray(oauth.scopes) ? oauth.scopes : endpoints.scopesSupported,
    );
    const [existingToken, scopeChallenge] = await Promise.all([
      readJsonIfExists<OAuthTokenRecord>((await getOAuthTokenRelativePath(serverName, scope)), normalizedScope),
      readJsonIfExists<OAuthScopeChallengeRecord>((await getOAuthScopeChallengeRelativePath(serverName, scope)), normalizedScope),
    ]);
    if (existingToken?.configHash === configHash && (existingToken.lifecycleGeneration ?? 0) === lifecycle.generation && existingToken.scope) {
      existingToken.scope.split(/\s+/u).filter(Boolean).forEach((entry) => requestedScopes.add(entry));
    }
    if (scopeChallenge?.configHash === configHash && (scopeChallenge.lifecycleGeneration ?? 0) === lifecycle.generation) {
      scopeChallenge.scopes.forEach((entry) => requestedScopes.add(entry));
    }
    const oauthScope = requestedScopes.size ? Array.from(requestedScopes).join(' ') : undefined;

    const authorizationUrl = new URL(endpoints.authorizationUrl);
    if (!['https:', ...(process.env.NODE_ENV === 'production' ? [] : ['http:'])].includes(authorizationUrl.protocol)
      || authorizationUrl.username || authorizationUrl.password) throw new McpOAuthError('OAuth authorization URL must use HTTPS.');
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

    await assertCurrentOAuthState(snapshot, normalizedScope);
    await fencedMcpOAuthWrite(snapshot.connectionId, snapshot.lifecycleGeneration, normalizedScope, () => writeJsonPrivate(getOAuthStateRelativePath(state), {
      state,
      serverName,
      connectionId: serverConfig.connectionId,
      authVersion: serverConfig.authVersion || 1,
      lifecycleGeneration: lifecycle.generation,
      codeVerifier: pkce.verifier,
      redirectUri,
      tokenUrl: endpoints.tokenUrl,
      revocationUrl: endpoints.revocationUrl,
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
    } satisfies OAuthStateRecord, normalizedScope));

    return {
      authorizationUrl: authorizationUrl.toString(),
      state,
      redirectUri,
    };
  });
}

function isExpired(token: OAuthTokenRecord): boolean {
  if (token.expiresAt === undefined) return false;
  const expiry = Date.parse(token.expiresAt);
  return !Number.isFinite(expiry) || expiry <= Date.now() + 60_000;
}

function isBoundOAuthToken(token: OAuthTokenRecord | null, connection: McpServerConfig & { connectionId: string }, generation: number): token is OAuthTokenRecord {
  return Boolean(token && typeof token.accessToken === 'string' && token.accessToken.length > 0
    && typeof token.issuer === 'string' && token.issuer && typeof token.resource === 'string' && token.resource
    && typeof token.clientId === 'string' && token.clientId
    && typeof token.tokenType === 'string' && token.tokenType.toLowerCase() === 'bearer'
    && (token.connectionId === undefined || token.connectionId === connection.connectionId)
    && (token.authVersion ?? 1) === (connection.authVersion || 1)
    && (token.lifecycleGeneration ?? 0) === generation
    && token.configHash === hashMcpAuthConfig(connection)
    && (!connection.url || token.serverUrl === connection.url));
}

async function exchangeToken(params: URLSearchParams, tokenUrl: string, clientSecret?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(params.get('client_id') || '')}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
    params.delete('client_secret');
  }
  const response = await fetchMcpHttp(tokenUrl, { method: 'POST', headers, body: params }, { purpose: 'OAuth token URL', maxBytes: 1024 * 1024 })
    .catch(() => { throw new McpOAuthError('OAuth token endpoint could not be reached. Retry later.', 503, 'network_error'); });
  if (!response.ok) {
    const status = response.status;
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    const providerCode = typeof body?.error === 'string' ? body.error : undefined;
    const code = status === 429 ? 'rate_limited' : status >= 500 ? 'provider_unavailable'
      : providerCode === 'invalid_grant' || providerCode === 'invalid_token' || providerCode === 'insufficient_scope' ? providerCode : undefined;
    throw new McpOAuthError(code ? `OAuth token request failed: ${code}.` : `OAuth token endpoint returned status ${status}.`, status, code);
  }
  const result = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!result || typeof result.access_token !== 'string' || !/^[\x21-\x7e]+$/u.test(result.access_token)
    || (result.token_type !== undefined && (typeof result.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer'))
    || (result.refresh_token !== undefined && (typeof result.refresh_token !== 'string' || !result.refresh_token))
    || (result.scope !== undefined && typeof result.scope !== 'string')
    || (result.expires_in !== undefined && (typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in)
      || result.expires_in < 0 || result.expires_in * 1000 + Date.now() > 8.64e15))) {
    throw new McpOAuthError('OAuth provider returned an invalid token response.', 502, 'provider_unavailable');
  }
  return {
    access_token: result.access_token,
    refresh_token: result.refresh_token as string | undefined,
    expiresAt: result.expires_in === undefined ? undefined : new Date(Date.now() + Number(result.expires_in) * 1000).toISOString(),
    token_type: 'Bearer',
    scope: result.scope as string | undefined,
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

  const storedClient = await readJsonIfExists<OAuthClientRecord>((await getOAuthClientRelativePath(serverName, scope)), scope);
  if (storedClient?.clientId === clientId && storedClient.issuer === issuer) {
    return storedClient.clientSecret;
  }

  return undefined;
}

async function consumeOAuthState(state: string, responseIssuer: string | null | undefined, scope?: McpScope | null): Promise<OAuthStateRecord> {
  const normalizedScope = requireMcpCredentialScope(scope);
  if (!/^[A-Za-z0-9_-]{32}$/u.test(state)) throw new McpOAuthError('Invalid or expired OAuth state.');
  const stateRelativePath = getOAuthStateRelativePath(state);
  return withMcpStorageLock(`oauth-state-${state}`, normalizedScope, async () => {
    const stored = await readJsonIfExists<OAuthStateRecord>(stateRelativePath, normalizedScope);
    const expiry = stored ? Date.parse(stored.expiresAt) : Number.NaN;
    if (!stored || stored.state !== state || !Number.isFinite(expiry) || expiry <= Date.now()) {
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
  });
}

export async function rejectMcpOAuthCallback(state: string, responseIssuer?: string | null, scope?: McpScope | null): Promise<void> {
  await consumeOAuthState(state, responseIssuer, scope);
}

async function assertCurrentOAuthState(stored: OAuthConnectionSnapshot, scope?: McpScope | null): Promise<void> {
  const current = await resolveMcpCredentialConnection(stored.connectionId, scope);
  if (
    current.connectionId !== stored.connectionId
    || current.enabled === false
    || (current.authVersion || 1) !== stored.authVersion
    || hashMcpAuthConfig(current) !== stored.configHash
  ) throw new McpOAuthError('OAuth authorization state no longer matches the current MCP connection.');
  const lifecycle = await readMcpOAuthLifecycle(stored.connectionId, scope);
  if (lifecycle.generation !== stored.lifecycleGeneration) throw new McpOAuthError('OAuth authorization state was invalidated.');
}

export async function recordMcpOAuthScopeChallenge(
  serverName: string,
  configHash: string,
  requiredScope: string | undefined,
  resourceMetadataUrl?: string,
  scope?: McpScope | null,
): Promise<string[]> {
  const normalizedScope = requireMcpCredentialScope(scope);
  const connection = await resolveMcpCredentialConnection(serverName, normalizedScope);
  if (configHash !== hashMcpAuthConfig(connection) && configHash !== hashMcpLegacyConfig(connection)) {
    throw new McpOAuthError('MCP connection changed before its scope challenge could be saved.', 409);
  }
  configHash = hashMcpAuthConfig(connection);
  const lifecycle = await readMcpOAuthLifecycle(connection.connectionId, normalizedScope);
  const snapshot: OAuthConnectionSnapshot = { connectionId: connection.connectionId, authVersion: connection.authVersion || 1, configHash, lifecycleGeneration: lifecycle.generation };
  const challengePath = (await getOAuthScopeChallengeRelativePath(serverName, scope));
  return withMcpOAuthLifecycleLock(connection.connectionId, normalizedScope, async () => {
    await assertCurrentOAuthState(snapshot, normalizedScope);
    const existing = await readJsonIfExists<OAuthScopeChallengeRecord>(challengePath, normalizedScope);
    const scopes = new Set(
      existing?.configHash === configHash && (existing.lifecycleGeneration ?? 0) === lifecycle.generation ? existing.scopes : [],
    );
    requiredScope?.split(/\s+/u).filter(Boolean).forEach((entry) => scopes.add(entry));
    const accumulated = Array.from(scopes);
    if (!accumulated.length) return accumulated;
    await fencedMcpOAuthWrite(connection.connectionId, lifecycle.generation, normalizedScope, () => writeJsonPrivate(challengePath, {
      lifecycleGeneration: lifecycle.generation,
      configHash,
      scopes: accumulated,
      resourceMetadataUrl,
      recordedAt: new Date().toISOString(),
    } satisfies OAuthScopeChallengeRecord, normalizedScope));
    return accumulated;
  });
}

export async function completeMcpOAuthCallback(
  code: string,
  state: string,
  responseIssuer?: string | null,
  scope?: McpScope | null,
): Promise<OAuthTokenRecord> {
  const normalizedScope = normalizeMcpScope(scope);
  const stored = await consumeOAuthState(state, responseIssuer, normalizedScope);
  await assertCurrentOAuthState(stored, normalizedScope);

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
    lifecycleGeneration: stored.lifecycleGeneration,
    revocationUrl: stored.revocationUrl,
    serverName: stored.serverName,
    connectionId: stored.connectionId,
    authVersion: stored.authVersion,
    serverUrl: stored.serverUrl,
    issuer: stored.issuer,
    resource: stored.resource,
    configHash: stored.configHash,
    clientId: stored.clientId,
    scope: exchanged.scope || stored.scope,
    tokenType: exchanged.token_type || 'Bearer',
    accessToken: exchanged.access_token,
    refreshToken: exchanged.refresh_token,
    expiresAt: exchanged.expiresAt,
    updatedAt: new Date().toISOString(),
  };
  const callbackTokenPath = path.posix.join('connections', stored.connectionId, 'tokens.json');
  const callbackChallengePath = path.posix.join('connections', stored.connectionId, 'scope-challenge.json');

  try {
    await withMcpOAuthLifecycleLock(stored.connectionId, normalizedScope, async () => {
      await assertCurrentOAuthState(stored, normalizedScope);
      await commitMcpOAuthLifecycle(stored.connectionId, stored.lifecycleGeneration, state, normalizedScope, async () => {
        await writeJsonPrivate(callbackTokenPath, token, normalizedScope);
      });
      await removeMcpStoragePath(callbackChallengePath, normalizedScope).catch(() => undefined);
    });
  } catch (error) {
    await revokeOAuthTokens(token, stored.clientSecret);
    throw error;
  }
  return token;
}

export async function clearMcpOAuth(
  serverName: string,
  scope?: McpScope | null,
  options?: { connectionSnapshot?: McpServerConfig & { connectionId: string }; alreadyInvalidated?: boolean; invalidatedGeneration?: number },
): Promise<void> {
  const normalizedScope = requireMcpCredentialScope(scope);
  const connection = options?.connectionSnapshot || await resolveMcpCredentialConnection(serverName, normalizedScope);
  const cutoff = options?.alreadyInvalidated
    ? options.invalidatedGeneration
    : (await invalidateMcpOAuthLifecycle(connection.connectionId, normalizedScope)).generation;
  if (!Number.isSafeInteger(cutoff) || Number(cutoff) < 1) throw new McpOAuthError('Missing OAuth invalidation generation.');
  // Invalidate before waiting for an in-flight provider request to finish.
  const { closeMcpServer } = await import('@/app/lib/mcp/manager');
  await closeMcpServer(connection.connectionId, normalizedScope);
  let tokenToRevoke: OAuthTokenRecord | null = null;
  let clientSecret: string | undefined;
  await withMcpOAuthLifecycleLock(connection.connectionId, normalizedScope, async () => {
    const directory = `connections/${connection.connectionId}`;
    const client = await readJsonIfExists<OAuthClientRecord>(`${directory}/client.json`, normalizedScope).catch(() => null);
    clientSecret = client?.clientSecret;
    for (const file of ['tokens.json', 'client.json', 'scope-challenge.json']) {
      const relativePath = `${directory}/${file}`;
      const artifact = await readJsonIfExists<{ lifecycleGeneration?: number }>(relativePath, normalizedScope).catch(() => null);
      if (artifact && (artifact.lifecycleGeneration ?? 0) >= Number(cutoff)) continue;
      if (file === 'tokens.json') tokenToRevoke = artifact as OAuthTokenRecord | null;
      await removeMcpStoragePath(relativePath, normalizedScope);
    }
    if (connection.legacyOAuthName && !connection.legacyOAuthAmbiguous) {
      await removeMcpStoragePath(`mcp-oauth/${sanitizeServerName(connection.legacyOAuthName)}`, normalizedScope, { recursive: true });
    }
    // Pre-upgrade PKCE states are not valid in the bound connection format.
    await removeMcpStoragePath('mcp-oauth/.state', normalizedScope, { recursive: true });
    const files = await fs.readdir(resolveMcpStoragePath(getOAuthStateRelativeDir(), normalizedScope)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const file of files) {
      if (!/^[A-Za-z0-9_-]{32}\.json$/u.test(file)) continue;
      const statePath = path.posix.join(getOAuthStateRelativeDir(), file);
      const raw = (await readMcpTextFileIfExists(statePath, normalizedScope)).content;
      if (!raw) continue;
      let envelope: { connectionId?: string };
      try { envelope = JSON.parse(raw); } catch { continue; }
      if (envelope.connectionId !== connection.connectionId) continue;
      const pending = await readJsonIfExists<OAuthStateRecord>(statePath, normalizedScope).catch(() => null);
      if (!pending || pending.lifecycleGeneration < Number(cutoff)) await removeMcpStoragePath(statePath, normalizedScope);
    }
  });
  // Local invalidation is authoritative; provider failures cannot undo it.
  await revokeOAuthTokens(tokenToRevoke, clientSecret);
}

async function revokeOAuthTokens(token: OAuthTokenRecord | null, clientSecret?: string): Promise<void> {
  if (!token?.revocationUrl) return;
  for (const [value, hint] of [[token.refreshToken, 'refresh_token'], [token.accessToken, 'access_token']]) {
    if (!value) continue;
    const body = new URLSearchParams({ token: value, token_type_hint: hint!, client_id: token.clientId });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (clientSecret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(token.clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
    await fetchMcpHttp(token.revocationUrl, { method: 'POST', headers, body }, { purpose: 'OAuth revocation URL', maxBytes: 64 * 1024, timeoutMs: 3000 })
      .then((response) => response.body?.cancel()).catch(() => undefined);
  }
}

export async function getValidMcpAccessToken(serverName: string, serverConfig: McpServerConfig, _configHash: string, scope?: McpScope | null, options?: { forceRefresh?: boolean; rejectedAccessToken?: string }): Promise<string | null> {
  if (!getOAuthConfig(serverConfig)) return null;
  const normalizedScope = requireMcpCredentialScope(scope);
  const connection = await resolveMcpCredentialConnection(serverName, normalizedScope);
  const configHash = hashMcpAuthConfig(serverConfig);
  if (connection.enabled === false || hashMcpAuthConfig(connection) !== configHash
    || (connection.authVersion || 1) !== (serverConfig.authVersion || 1)) {
    throw new McpOAuthError('MCP connection is disabled or changed. Reconnect before continuing.', 409);
  }
  const tokenRelativePath = await getOAuthTokenRelativePath(serverName, normalizedScope);
  const lifecycle = await readMcpOAuthLifecycle(connection.connectionId, normalizedScope);
  const token = await readJsonIfExists<OAuthTokenRecord>(tokenRelativePath, normalizedScope);
  if (!isBoundOAuthToken(token, connection, lifecycle.generation)) {
    throw new McpOAuthError(`MCP server "${serverName}" requires OAuth authorization. Use mcp auth_start.`, 401, 'reauth_required');
  }
  const needsRefresh = (value: OAuthTokenRecord) => isExpired(value)
    || Boolean(options?.rejectedAccessToken ? value.accessToken === options.rejectedAccessToken : options?.forceRefresh);
  if (!needsRefresh(token)) return token.accessToken;

  return withMcpOAuthLifecycleLock(connection.connectionId, normalizedScope, async () => {
    const snapshot: OAuthConnectionSnapshot = {
      connectionId: connection.connectionId, authVersion: connection.authVersion || 1,
      configHash, lifecycleGeneration: lifecycle.generation,
    };
    await assertCurrentOAuthState(snapshot, normalizedScope);
    const current = await readJsonIfExists<OAuthTokenRecord>(tokenRelativePath, normalizedScope);
    if (!isBoundOAuthToken(current, connection, lifecycle.generation)) {
      throw new McpOAuthError(`MCP server "${serverName}" requires OAuth authorization. Use mcp auth_start.`, 401, 'reauth_required');
    }
    if (!needsRefresh(current)) return current.accessToken;
    if (!current.refreshToken) {
      throw new McpOAuthError(`OAuth token for MCP server "${serverName}" expired. Use mcp auth_start.`, 401, 'reauth_required');
    }
    const oauth = getOAuthConfig(connection);
    const endpoints = await resolveOAuthEndpoints(oauth || {}, connection);
    if (current.issuer !== endpoints.issuer || current.resource !== endpoints.resource) {
      throw new McpOAuthError(`OAuth credentials for MCP server "${serverName}" do not match the current authorization server or resource. Reauthorize in Settings > Integrations.`, 401, 'reauth_required');
    }
    const clientSecret = await resolveClientSecretForRefresh(serverName, oauth, current.clientId, endpoints.issuer, normalizedScope);
    await assertCurrentOAuthState(snapshot, normalizedScope);
    const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: current.clientId, resource: endpoints.resource });
    let refreshed: Awaited<ReturnType<typeof exchangeToken>>;
    try {
      refreshed = await exchangeToken(params, endpoints.tokenUrl, clientSecret);
    } catch (error) {
      if (error instanceof McpOAuthError && (error.code === 'invalid_grant' || error.code === 'invalid_token')) {
        await fencedMcpOAuthWrite(connection.connectionId, lifecycle.generation, normalizedScope, () => removeMcpStoragePath(tokenRelativePath, normalizedScope));
        throw new McpOAuthError(`OAuth token for MCP server "${serverName}" could not be refreshed. Reauthorize in Settings > Integrations.`, 401, 'reauth_required');
      }
      throw error;
    }
    const updated: OAuthTokenRecord = {
      ...current, lifecycleGeneration: lifecycle.generation, revocationUrl: endpoints.revocationUrl,
      accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || current.refreshToken,
      tokenType: refreshed.token_type, scope: refreshed.scope ?? current.scope,
      expiresAt: refreshed.expiresAt, updatedAt: new Date().toISOString(),
    };
    try {
      await assertCurrentOAuthState(snapshot, normalizedScope);
      await fencedMcpOAuthWrite(connection.connectionId, lifecycle.generation, normalizedScope, () => writeJsonPrivate(tokenRelativePath, updated, normalizedScope));
    } catch (error) {
      await revokeOAuthTokens(updated, clientSecret);
      throw error;
    }
    return updated.accessToken;
  });
}
