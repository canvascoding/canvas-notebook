import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

import { readMcpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import { resolveAgentStorageDir } from '@/app/lib/runtime-data-paths';

type OAuthServerConfig = {
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  registrationUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  redirectUri?: string;
};

type OAuthEndpoints = Required<Pick<OAuthServerConfig, 'authorizationUrl' | 'tokenUrl'>> & Pick<OAuthServerConfig, 'registrationUrl'>;

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
  configHash: string;
  createdAt: string;
};

export type OAuthTokenRecord = {
  serverName: string;
  serverUrl?: string;
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
  tokenPath: string;
  expiresAt: string | null;
  scope: string | null;
  reason?: string;
};

export type McpOAuthStartResult = {
  authorizationUrl: string;
  state: string;
  redirectUri: string;
};

class McpOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpOAuthError';
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

function getOAuthRoot(): string {
  return path.join(resolveAgentStorageDir(), 'mcp-oauth');
}

function getServerOAuthDir(serverName: string): string {
  return path.join(getOAuthRoot(), sanitizeServerName(serverName));
}

export function getOAuthTokenPath(serverName: string): string {
  return path.join(getServerOAuthDir(serverName), 'tokens.json');
}

function getOAuthClientPath(serverName: string): string {
  return path.join(getServerOAuthDir(serverName), 'client.json');
}

function getOAuthStateDir(): string {
  return path.join(getOAuthRoot(), '.state');
}

function getOAuthStatePath(state: string): string {
  return path.join(getOAuthStateDir(), `${sanitizeServerName(state)}.json`);
}

async function ensurePrivateDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700).catch(() => undefined);
}

async function writeJsonPrivate(filePath: string, payload: unknown): Promise<void> {
  await ensurePrivateDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(tmpPath, 0o600).catch(() => undefined);
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
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
  if (serverConfig.bearerTokenEnv) {
    return null;
  }
  if (typeof serverConfig.url === 'string' && serverConfig.url.trim() && serverConfig.auth !== 'none') {
    return {};
  }
  return null;
}

function getOriginFromRequest(requestOrigin: string | null | undefined): string {
  const configured = process.env.BASE_URL || process.env.APP_BASE_URL;
  return (configured || requestOrigin || 'http://localhost:3000').replace(/\/+$/u, '');
}

async function readAuthorizationServerMetadata(metadataUrl: string): Promise<OAuthEndpoints> {
  const response = await fetch(metadataUrl);
  if (!response.ok) {
    throw new McpOAuthError(`OAuth discovery failed with status ${response.status}.`);
  }
  const metadata = await response.json() as {
    authorization_endpoint?: string;
    token_endpoint?: string;
    registration_endpoint?: string;
  };
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new McpOAuthError('OAuth discovery response is missing authorization_endpoint or token_endpoint.');
  }
  return {
    authorizationUrl: metadata.authorization_endpoint,
    tokenUrl: metadata.token_endpoint,
    registrationUrl: metadata.registration_endpoint,
  };
}

async function resolveOAuthEndpoints(oauth: OAuthServerConfig, serverConfig?: McpServerConfig): Promise<OAuthEndpoints> {
  if (oauth.authorizationUrl && oauth.tokenUrl) {
    return {
      authorizationUrl: oauth.authorizationUrl,
      tokenUrl: oauth.tokenUrl,
      registrationUrl: oauth.registrationUrl,
    };
  }

  if (!oauth.issuer) {
    const serverUrl = typeof serverConfig?.url === 'string' ? serverConfig.url.trim() : '';
    if (serverUrl) {
      const origin = new URL(serverUrl).origin;
      return await readAuthorizationServerMetadata(`${origin}/.well-known/oauth-authorization-server`);
    }
    throw new McpOAuthError('OAuth MCP server requires oauth.authorizationUrl and oauth.tokenUrl, oauth.issuer, or an HTTP url for discovery.');
  }

  const issuer = oauth.issuer.replace(/\/+$/u, '');
  return await readAuthorizationServerMetadata(`${issuer}/.well-known/oauth-authorization-server`);
}

async function resolveClient(serverName: string, oauth: OAuthServerConfig, redirectUri: string, registrationUrl?: string): Promise<{ clientId: string; clientSecret?: string }> {
  if (oauth.clientId) {
    return { clientId: oauth.clientId, clientSecret: oauth.clientSecret };
  }

  const existing = await readJsonIfExists<{ clientId?: string; clientSecret?: string }>(getOAuthClientPath(serverName));
  if (existing?.clientId) {
    return { clientId: existing.clientId, clientSecret: existing.clientSecret };
  }

  if (!registrationUrl) {
    throw new McpOAuthError('OAuth MCP server requires oauth.clientId unless Dynamic Client Registration is available.');
  }

  const response = await fetch(registrationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Canvas Notebook MCP',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  if (!response.ok) {
    throw new McpOAuthError(`OAuth dynamic client registration failed with status ${response.status}.`);
  }
  const registered = await response.json() as { client_id?: string; client_secret?: string };
  if (!registered.client_id) {
    throw new McpOAuthError('OAuth dynamic client registration response is missing client_id.');
  }

  const client = { clientId: registered.client_id, clientSecret: registered.client_secret };
  await writeJsonPrivate(getOAuthClientPath(serverName), client);
  return client;
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function resolveServerForOAuth(serverName: string): Promise<{ serverConfig: McpServerConfig; oauth: OAuthServerConfig; configHash: string }> {
  const config = await readMcpConfig();
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

export async function getMcpOAuthStatus(serverName: string): Promise<McpOAuthStatus> {
  try {
    const { serverConfig, configHash } = await resolveServerForOAuth(serverName);
    const token = await readJsonIfExists<OAuthTokenRecord>(getOAuthTokenPath(serverName));
    const serverUrl = typeof serverConfig.url === 'string' ? serverConfig.url : undefined;
    const bound = Boolean(token && token.configHash === configHash && (!serverUrl || token.serverUrl === serverUrl));
    return {
      serverName,
      configured: true,
      requiresAuth: true,
      authorized: bound,
      tokenPath: getOAuthTokenPath(serverName),
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
      tokenPath: getOAuthTokenPath(serverName),
      expiresAt: null,
      scope: null,
      reason: error instanceof Error ? error.message : 'OAuth status unavailable.',
    };
  }
}

export async function startMcpOAuth(serverName: string, requestOrigin?: string | null): Promise<McpOAuthStartResult> {
  const { serverConfig, oauth, configHash } = await resolveServerForOAuth(serverName);
  const origin = getOriginFromRequest(requestOrigin);
  const redirectUri = oauth.redirectUri || `${origin}/api/mcp/oauth/callback`;
  const endpoints = await resolveOAuthEndpoints(oauth, serverConfig);
  const client = await resolveClient(serverName, oauth, redirectUri, endpoints.registrationUrl);
  const pkce = createPkcePair();
  const state = base64Url(crypto.randomBytes(24));
  const scope = Array.isArray(oauth.scopes) ? oauth.scopes.join(' ') : undefined;

  const authorizationUrl = new URL(endpoints.authorizationUrl);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', client.clientId);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge', pkce.challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  if (scope) {
    authorizationUrl.searchParams.set('scope', scope);
  }

  await writeJsonPrivate(getOAuthStatePath(state), {
    state,
    serverName,
    codeVerifier: pkce.verifier,
    redirectUri,
    tokenUrl: endpoints.tokenUrl,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    scope,
    serverUrl: typeof serverConfig.url === 'string' ? serverConfig.url : undefined,
    configHash,
    createdAt: new Date().toISOString(),
  } satisfies OAuthStateRecord);

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
  const response = await fetch(tokenUrl, { method: 'POST', headers, body: params });
  if (!response.ok) {
    throw new McpOAuthError(`OAuth token endpoint returned status ${response.status}.`);
  }
  return await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
}

export async function completeMcpOAuthCallback(code: string, state: string): Promise<OAuthTokenRecord> {
  const statePath = getOAuthStatePath(state);
  const stored = await readJsonIfExists<OAuthStateRecord>(statePath);
  if (!stored || stored.state !== state) {
    throw new McpOAuthError('Invalid or expired OAuth state.');
  }

  const params = new URLSearchParams();
  params.set('grant_type', 'authorization_code');
  params.set('code', code);
  params.set('redirect_uri', stored.redirectUri);
  params.set('client_id', stored.clientId);
  params.set('code_verifier', stored.codeVerifier);
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
    configHash: stored.configHash,
    clientId: stored.clientId,
    scope: exchanged.scope || stored.scope,
    tokenType: exchanged.token_type || 'Bearer',
    accessToken: exchanged.access_token,
    refreshToken: exchanged.refresh_token,
    expiresAt: exchanged.expires_in ? new Date(Date.now() + exchanged.expires_in * 1000).toISOString() : undefined,
    updatedAt: new Date().toISOString(),
  };

  await writeJsonPrivate(getOAuthTokenPath(stored.serverName), token);
  await fs.rm(statePath, { force: true }).catch(() => undefined);
  return token;
}

export async function clearMcpOAuth(serverName: string): Promise<void> {
  await fs.rm(getServerOAuthDir(serverName), { recursive: true, force: true });
}

export async function getValidMcpAccessToken(serverName: string, serverConfig: McpServerConfig, configHash: string): Promise<string | null> {
  if (!getOAuthConfig(serverConfig)) return null;
  const tokenPath = getOAuthTokenPath(serverName);
  const token = await readJsonIfExists<OAuthTokenRecord>(tokenPath);
  const serverUrl = typeof serverConfig.url === 'string' ? serverConfig.url : undefined;
  if (!token || token.configHash !== configHash || (serverUrl && token.serverUrl !== serverUrl)) {
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
  const params = new URLSearchParams();
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', token.refreshToken);
  params.set('client_id', token.clientId);
  const clientSecret = oauth?.clientSecret;
  if (clientSecret) params.set('client_secret', clientSecret);
  const refreshed = await exchangeToken(params, endpoints.tokenUrl, clientSecret);
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
  await writeJsonPrivate(tokenPath, updated);
  return updated.accessToken;
}
