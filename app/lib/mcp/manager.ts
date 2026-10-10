import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { expandMcpEnvValue, mcpConfigUsesChangedEnv } from '@/app/lib/mcp/env-references';
import { assertMcpConnectionAccess, requireMcpUserAccess, McpAccessError } from './access';
import { resolveMcpCredentialScope } from './credential-storage';
import { fetchMcpHttp } from '@/app/lib/mcp/http';
import { hashMcpAuthConfig } from '@/app/lib/mcp/connection-identity';
import { classifyMcpConnectionFailure, recordMcpConnectionObservation, type McpConnectionObservation } from '@/app/lib/mcp/connection-health';
import { readMcpOAuthLifecycle } from '@/app/lib/mcp/oauth-lifecycle';
import { readMcpConnectionStatus } from '@/app/lib/mcp/connection-status';
import {
  MCP_APP_RESOURCE_MIME_TYPE,
  isMcpAppResourceMimeType,
  isMcpAppToolVisibleToApp,
  isMcpAppToolVisibleToModel,
  readMcpAppToolMetadata,
} from '@/app/lib/mcp/apps-metadata';
import { isMcpAppsEnabled } from '@/app/lib/mcp/apps-config';
import { integrationMetadataCache } from '@/app/lib/integration-tools/metadata-cache';
import { validateIntegrationArguments } from '@/app/lib/integration-tools/schema';
import { authorizeSharedMcpScope } from './shared-access';
import { runMobileRenderReproSubphase } from './mobile-render-repro-trace';

import {
  Client,
  InsufficientScopeError,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type ReadResourceResult,
  type Tool,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { readMcpAvailableEnv as readAvailableEnv, readMcpAvailableEnvSnapshot, resolveMcpSnapshotTransportValues } from '@/app/lib/mcp/env-runtime';
import { isMcpServerEnabled, readMcpConfig, resolveMcpConfigPath, type McpConfig, type McpServerConfig } from '@/app/lib/mcp/config';
import {
  getValidMcpAccessToken,
  recordMcpOAuthScopeChallenge,
} from '@/app/lib/mcp/oauth';
import { assertMcpHttpUrlAllowed } from '@/app/lib/mcp/network-policy';
import {
  getMcpScopeKey,
  normalizeMcpScope,
  type McpScope,
} from '@/app/lib/mcp/scope';
import {
  readMcpTextFileIfExists,
  resolveMcpStoragePath,
  writeMcpTextFileAtomic,
} from '@/app/lib/mcp/storage';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_IDLE_TIMEOUT_MINUTES = 10;
const CACHE_FILE = 'mcp-cache.json';

type TransportType = 'stdio' | 'http' | 'unsupported';

type ManagedConnection = {
  key: string;
  scope: McpScope | null;
  serverName: string;
  configHash: string;
  transport: TransportType;
  config: McpServerConfig;
  authGeneration?: number;
  authorizationState?: string;
  environmentRevision?: string;
  abortController: AbortController;
  closed?: boolean;
  client?: Client;
  connectingClient?: Client;
  connecting?: Promise<Client>;
  activeCalls: number;
  lastUsedAt: number;
  lastSuccessfulToolListAt?: number;
  lastError?: string;
  processPid?: number | null;
  stderrTail?: string;
};

type McpCacheFile = {
  version: 1;
  updatedAt: string;
  servers: Record<string, {
    configHash: string;
    tools: Tool[];
    lastRefreshedAt: string;
  }>;
};

type McpInvocationBinding = {
  entry: ManagedConnection;
  client: Client;
  environmentRevision: string;
  beforeDispatch?: () => Promise<void>;
};
type McpInvocationAuthority = { bindings: AsyncLocalStorage<McpInvocationBinding | null>; sharedScopes: AsyncLocalStorage<McpScope | null> };
const invocationGlobal = globalThis as typeof globalThis & { __canvasMcpInvocationAuthorityV1?: McpInvocationAuthority };
// Managed clients are process-global; their first module's transport closures
// must see the current invocation even when a later Next bundle reuses them.
const invocationAuthority = invocationGlobal.__canvasMcpInvocationAuthorityV1 ??= {
  bindings: new AsyncLocalStorage<McpInvocationBinding | null>(), sharedScopes: new AsyncLocalStorage<McpScope | null>(),
};
const mcpInvocationBindings = invocationAuthority.bindings;
const sharedMcpInvocationScopes = invocationAuthority.sharedScopes;

function currentManagedScope(entry: ManagedConnection): McpScope | null {
  if (!entry.scope?.shared) return entry.scope;
  const current = sharedMcpInvocationScopes.getStore();
  if (!current?.shared || getMcpScopeKey(current) !== getMcpScopeKey(entry.scope)) {
    throw Object.assign(new Error('Shared MCP execution requires its current authorized caller.'), { code: 'mcp_connection_changed', status: 403 });
  }
  return current;
}

function changedInvocationEnvironment(): Error {
  return Object.assign(new Error('MCP credentials or the selected client changed before dispatch.'), { code: 'mcp_environment_binding_changed', status: 409 });
}

function assertInvocationClient(entry: ManagedConnection, binding: McpInvocationBinding): void {
  if (binding.entry !== entry || binding.client !== entry.client || entry.closed
    || entry.environmentRevision !== binding.environmentRevision) throw changedInvocationEnvironment();
}

type McpManagerStore = {
  entries: Map<string, ManagedConnection>;
  cleanupStarted: boolean;
  shutdownHooksStarted: boolean;
  shuttingDown: boolean;
  shutdownCoordinator?: (signal: NodeJS.Signals) => void | Promise<void>;
};

const globalStore = globalThis as typeof globalThis & {
  __canvasMcpManagerStore?: McpManagerStore;
};

function getStore(): McpManagerStore {
  if (!globalStore.__canvasMcpManagerStore) {
    globalStore.__canvasMcpManagerStore = {
      entries: new Map(),
      cleanupStarted: false,
      shutdownHooksStarted: false,
      shuttingDown: false,
    };
  }
  return globalStore.__canvasMcpManagerStore;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown MCP error';
}

function logMcp(level: 'info' | 'warn' | 'error', message: string, details: Record<string, unknown> = {}): void {
  const payload = Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : '';
  console[level](`[MCP] ${message}${payload}`);
}

function appendStderrTail(entry: ManagedConnection, chunk: string): void {
  const next = `${entry.stderrTail || ''}${entry.stderrTail ? '\n' : ''}${chunk}`.trim();
  entry.stderrTail = next.length > 4000 ? next.slice(-4000) : next;
}

function enhanceMcpError(error: unknown): Error {
  const baseMessage = getErrorMessage(error);
  return error instanceof Error ? error : new Error(baseMessage);
}

function summarizeCommand(config: McpServerConfig): { command?: string; args?: string[]; cwd?: string } {
  return {
    command: config.command,
    args: Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
    cwd: typeof config.cwd === 'string' && config.cwd.trim() ? config.cwd : undefined,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashMcpServerConfig(config: McpServerConfig): string {
  return crypto.createHash('sha256').update(stableStringify(config)).digest('hex');
}

export function getServerTransport(config: McpServerConfig): TransportType {
  if (typeof config.command === 'string' && config.command.trim()) return 'stdio';
  if (typeof config.url === 'string' && config.url.trim()) return 'http';
  return 'unsupported';
}

function getEntryKey(scope: McpScope | null | undefined, serverName: string, configHash: string): string {
  return `${getMcpScopeKey(scope)}:${serverName}:${configHash}`;
}

function getTimeoutMs(config: McpServerConfig): number {
  return typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs)
    ? Math.max(1000, Math.trunc(config.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
}

function getIdleTimeoutMs(config: McpConfig): number {
  const minutes = typeof config.settings?.idleTimeout === 'number' && Number.isFinite(config.settings.idleTimeout)
    ? config.settings.idleTimeout
    : DEFAULT_IDLE_TIMEOUT_MINUTES;
  return Math.max(0, minutes) * 60_000;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new Error('MCP operation aborted.'));
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`MCP operation timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const onAbort = () => {
      cleanup();
      reject(new Error('MCP operation aborted.'));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function getSafeStdioBaseEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const value = process.env[key];
    if (value) safe[key] = value;
  }
  return safe;
}

function expandEnvValue(value: string, availableEnv: Record<string, string>, missing: Set<string>): string {
  return expandMcpEnvValue(value, availableEnv, missing);
}

async function resolveServerEnv(config: McpServerConfig, scope?: McpScope | null, snapshotValues?: Record<string, string>): Promise<Record<string, string>> {
  const availableEnv = snapshotValues || await readAvailableEnv(scope);
  const missing = new Set<string>();
  const resolved: Record<string, string> = getSafeStdioBaseEnv();
  for (const [key, value] of Object.entries(config.env || {})) {
    if (typeof value === 'string') {
      resolved[key] = expandEnvValue(value, availableEnv, missing);
    }
  }
  for (const key of config.envPassthrough || []) {
    if (typeof key !== 'string' || !key.trim()) continue;
    const value = availableEnv[key.trim()];
    if (value === undefined) {
      missing.add(key.trim());
    } else {
      resolved[key.trim()] = value;
    }
  }
  if (missing.size > 0) {
    throw new Error(`Missing MCP environment variable(s): ${Array.from(missing).sort().join(', ')}. Configure them in /settings?tab=secrets.`);
  }
  return resolved;
}

async function resolveHttpHeaders(config: McpServerConfig, accessToken: string | null, scope?: McpScope | null, snapshotValues?: Record<string, string>): Promise<Record<string, string> | undefined> {
  const availableEnv = snapshotValues || await readAvailableEnv(scope);
  const missing = new Set<string>();
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(config.headers || {})) {
    if (typeof value === 'string' && key.trim()) {
      headers[key.trim()] = expandEnvValue(value, availableEnv, missing);
    }
  }
  for (const [key, envKey] of Object.entries(config.headersFromEnv || {})) {
    if (typeof envKey !== 'string' || !key.trim()) continue;
    const value = availableEnv[envKey.trim()];
    if (value === undefined) {
      missing.add(envKey.trim());
    } else {
      headers[key.trim()] = value;
    }
  }
  if (config.bearerTokenEnv) {
    const value = availableEnv[config.bearerTokenEnv];
    if (value === undefined) {
      missing.add(config.bearerTokenEnv);
    } else {
      headers.Authorization = `Bearer ${value}`;
    }
  }
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  if (missing.size > 0) {
    throw new Error(`Missing MCP environment variable(s): ${Array.from(missing).sort().join(', ')}. Configure them in /settings?tab=secrets.`);
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

async function createClient(entry: ManagedConnection, signal?: AbortSignal): Promise<Client> {
  const timeoutMs = getTimeoutMs(entry.config);
  const environment = await readMcpAvailableEnvSnapshot(entry.scope);
  entry.environmentRevision = environment.revision;
  const client = new Client(
    { name: 'canvas-notebook-mcp-proxy', version: '1.0.0' },
    {
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => integrationMetadataCache.clear() } },
      capabilities: isMcpAppsEnabled() ? {
        extensions: {
          'io.modelcontextprotocol/ui': {
            mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE],
          },
        },
      } as never : undefined,
      versionNegotiation: {
        mode: 'auto',
        probe: {
          timeoutMs: Math.min(timeoutMs, 5_000),
        },
      },
    },
  );
  entry.connectingClient = client;

  if (entry.transport === 'stdio') {
    if (process.env.MCP_ALLOW_STDIO !== 'true') {
      throw new Error('STDIO MCP servers are disabled by instance policy. Set MCP_ALLOW_STDIO=true only for trusted, sandboxed deployments.');
    }
    const command = entry.config.command?.trim();
    if (!command) throw new Error(`MCP server "${entry.serverName}" is missing command.`);
    logMcp('info', 'Starting stdio server', {
      server: entry.serverName,
      timeoutMs,
      ...summarizeCommand(entry.config),
    });
    const transport = new StdioClientTransport({
      command,
      args: resolveMcpSnapshotTransportValues({ args: entry.config.args }, environment).args,
      env: await resolveServerEnv(entry.config, entry.scope, environment.values),
      cwd: typeof entry.config.cwd === 'string' && entry.config.cwd.trim() ? entry.config.cwd : undefined,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const trimmed = text.trim();
      if (trimmed) {
        appendStderrTail(entry, trimmed);
        logMcp('warn', 'Server wrote to stderr', { server: entry.serverName, pid: transport.pid, bytes: Buffer.byteLength(trimmed, 'utf8') });
      }
    });
    try {
      await withTimeout(client.connect(transport), timeoutMs, signal);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw enhanceMcpError(error);
    }
    entry.processPid = transport.pid;
    logMcp('info', 'Connected stdio server', {
      server: entry.serverName,
      pid: transport.pid,
      protocolVersion: client.getNegotiatedProtocolVersion(),
    });
    return client;
  }

  if (entry.transport === 'http') {
    const url = resolveMcpSnapshotTransportValues({ url: entry.config.url }, environment).url?.trim();
    if (!url) throw new Error(`MCP server "${entry.serverName}" is missing url.`);
    const validatedUrl = await assertMcpHttpUrlAllowed(url, `MCP server "${entry.serverName}" URL`);
    logMcp('info', 'Connecting HTTP server', { server: entry.serverName, url: entry.config.url, timeoutMs });
    try {
      await withTimeout(client.connect(new StreamableHTTPClientTransport(validatedUrl, {
        fetch: (input, init) => fetchManagedMcpRequest(entry, input, init),
        onInsufficientScope: 'throw',
      })), timeoutMs, signal);
    } catch (error) {
      entry.abortController.abort(error);
      await client.close().catch(() => undefined);
      throw error;
    }
    logMcp('info', 'Connected HTTP server', {
      server: entry.serverName,
      url: entry.config.url,
      protocolVersion: client.getNegotiatedProtocolVersion(),
    });
    return client;
  }

  throw new Error(`MCP server "${entry.serverName}" must define a stdio command or unauthenticated HTTP url.`);
}

async function readCurrentMcpConnection(entry: ManagedConnection): Promise<McpServerConfig> {
  entry.abortController.signal.throwIfAborted();
  const scope = currentManagedScope(entry);
  const { connection: current } = await assertMcpConnectionAccess(entry.config.connectionId || entry.serverName, scope);
  if (!current || !isMcpServerEnabled(current) || hashMcpAuthConfig(current) !== hashMcpAuthConfig(entry.config)
    || current.authVersion !== entry.config.authVersion) {
    throw new Error('MCP connection was removed, disabled or changed. Reconnect before continuing.');
  }
  if (current.connectionId && (scope?.userId || scope?.shared)) {
    const lifecycle = await readMcpOAuthLifecycle(current.connectionId, resolveMcpCredentialScope({ ...current, connectionId: current.connectionId }, scope));
    if (lifecycle.generation !== entry.authGeneration || lifecycle.lastCompletedState !== entry.authorizationState) {
      throw Object.assign(new Error('MCP authorization changed. Reconnect the client and retry explicitly.'), { code: 'mcp_connection_changed', status: 409 });
    }
  }
  return current;
}

async function observeManagedConnection(entry: ManagedConnection, observation: McpConnectionObservation): Promise<void> {
  await recordMcpConnectionObservation(entry.config, currentManagedScope(entry), observation, { generation: entry.authGeneration })
    .catch(() => logMcp('warn', 'Could not persist connection status', { server: entry.serverName }));
}

async function observeManagedFailure(entry: ManagedConnection, error: unknown): Promise<void> {
  let code = classifyMcpConnectionFailure(error);
  if (code === 'reauth_required' && entry.config.auth !== 'oauth' && !entry.config.oauth) code = 'configuration_error';
  if (code) await observeManagedConnection(entry, { kind: 'failure', code });
}

async function fetchManagedMcpRequest(entry: ManagedConnection, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const invocation = mcpInvocationBindings.getStore();
  if (invocation) assertInvocationClient(entry, invocation);
  const current = await readCurrentMcpConnection(entry);
  const scope = currentManagedScope(entry);
  const identity = current.connectionId || entry.serverName;
  const expectedAuthorizationState = scope?.userId || scope?.shared ? entry.authorizationState ?? null : undefined;
  const token = await getValidMcpAccessToken(identity, current, entry.configHash, scope, { expectedAuthorizationState });
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  const environment = invocation ? await readMcpAvailableEnvSnapshot(scope) : undefined;
  if (invocation && environment?.revision !== invocation.environmentRevision) throw changedInvocationEnvironment();
  const authenticatedHeaders = await resolveHttpHeaders(current, token, scope, environment?.values);
  for (const [name, value] of Object.entries(authenticatedHeaders || {})) headers.set(name, value);
  // Token refresh and secret loading may yield to a concurrent config change.
  await readCurrentMcpConnection(entry);
  if (invocation) {
    const latestEnvironment = await readMcpAvailableEnvSnapshot(scope);
    if (latestEnvironment.revision !== invocation.environmentRevision) throw changedInvocationEnvironment();
    assertInvocationClient(entry, invocation);
  }
  await invocation?.beforeDispatch?.();
  if (invocation) assertInvocationClient(entry, invocation);
  entry.abortController.signal.throwIfAborted();
  const response = await fetchMcpHttp(input, {
    ...init, headers,
    signal: AbortSignal.any([
      entry.abortController.signal,
      ...(init?.signal ? [init.signal] : input instanceof Request ? [input.signal] : []),
    ]),
  }, { timeoutMs: getTimeoutMs(current) });
  if (response.status === 401 && token) {
    await response.body?.cancel();
    // Refresh is safe to perform here; the rejected operation is never replayed.
    await getValidMcpAccessToken(identity, current, entry.configHash, scope, { forceRefresh: true, rejectedAccessToken: token, expectedAuthorizationState });
    const error = new Error('MCP authorization was renewed. The previous operation was not replayed; reconnect and retry it explicitly.');
    Object.assign(error, { code: 'mcp_auth_renewed', status: 409 });
    throw error;
  }
  if (response.status === 401 || response.status === 429 || response.status >= 500) {
    await observeManagedFailure(entry, { status: response.status });
  }
  return response;
}

async function getManagedConnection(serverName: string, signal?: AbortSignal, scope?: McpScope | null): Promise<ManagedConnection> {
  const selected = await assertMcpConnectionAccess(serverName, scope);
  serverName = selected.serverName;
  const normalizedScope = normalizeMcpScope(scope);
  const serverConfig = selected.connection;

  const configHash = hashMcpServerConfig(serverConfig);
  const key = getEntryKey(normalizedScope, serverName, configHash);
  const lifecycle = serverConfig.connectionId && (normalizedScope?.userId || normalizedScope?.shared)
    ? await readMcpOAuthLifecycle(serverConfig.connectionId, resolveMcpCredentialScope({ ...serverConfig, connectionId: serverConfig.connectionId }, normalizedScope)) : undefined;
  const authGeneration = lifecycle?.generation;
  const environment = await readMcpAvailableEnvSnapshot(normalizedScope);
  const store = getStore();
  let entry = store.entries.get(key);
  if (entry && (entry.authGeneration !== authGeneration || entry.authorizationState !== lifecycle?.lastCompletedState
    || entry.environmentRevision !== environment.revision)) {
    await closeManagedEntries([[key, entry]]);
    // Another caller may have replaced the old entry while its client closed.
    // Resolve current access, configuration, OAuth and ENV before reusing it.
    return getManagedConnection(serverName, signal, normalizedScope);
  }

  if (!entry) {
    entry = {
      key,
      scope: normalizedScope,
      serverName,
      configHash,
      transport: getServerTransport(serverConfig),
      config: serverConfig,
      authGeneration,
      authorizationState: lifecycle?.lastCompletedState,
      environmentRevision: environment.revision,
      abortController: new AbortController(),
      activeCalls: 0,
      lastUsedAt: Date.now(),
    };
    store.entries.set(key, entry);
    logMcp('info', 'Registered server config', { server: serverName, transport: entry.transport, configHash });
  }

  entry.lastUsedAt = Date.now();
  if (!entry.client) {
    entry.connecting ??= createClient(entry, signal)
      .then(async (client) => {
        if (entry.closed || entry.abortController.signal.aborted) {
          await client.close().catch(() => undefined);
          throw new Error('MCP connection was closed while connecting.');
        }
        entry.client = client;
        entry.lastError = undefined;
        return client;
      })
      .catch(async (error) => {
        entry.closed = true;
        entry.abortController.abort(error);
        if (store.entries.get(key) === entry) store.entries.delete(key);
        entry.lastError = getErrorMessage(error);
        await observeManagedFailure(entry, error);
        logMcp('error', 'Connection failed', {
          server: entry.serverName,
          transport: entry.transport,
          error: entry.lastError,
        });
        throw error;
      })
      .finally(() => {
        entry.connecting = undefined;
        entry.connectingClient = undefined;
      });
    await entry.connecting;
  }

  return entry;
}

async function withManagedConnection<T>(
  serverName: string,
  fn: (entry: ManagedConnection, client: Client) => Promise<T>,
  signal?: AbortSignal,
  scope?: McpScope | null,
): Promise<T> {
  return sharedMcpInvocationScopes.run(scope?.shared ? normalizeMcpScope(scope) : null, async () => {
  const entry = await runMobileRenderReproSubphase('managed-acquire', () => getManagedConnection(serverName, signal, scope));
  if (!entry.client) throw new Error(`MCP server "${serverName}" is not connected.`);

  entry.activeCalls += 1;
  entry.lastUsedAt = Date.now();
  try {
    await runMobileRenderReproSubphase('managed-current', () => readCurrentMcpConnection(entry));
    const result = await fn(entry, entry.client);
    entry.lastError = undefined;
    await runMobileRenderReproSubphase('managed-health', () => observeManagedConnection(entry, { kind: 'success' }));
    return result;
  } catch (error) {
    const hasOAuthConfig = entry.config.auth === 'oauth'
      || Boolean(entry.config.oauth && typeof entry.config.oauth === 'object' && !Array.isArray(entry.config.oauth));
    if (error instanceof InsufficientScopeError && hasOAuthConfig) {
      const challengedScopes = await recordMcpOAuthScopeChallenge(
        entry.serverName,
        entry.configHash,
        error.requiredScope,
        error.resourceMetadataUrl?.toString(),
        currentManagedScope(entry),
      );
      await runMobileRenderReproSubphase('managed-close', () => closeManagedEntries([[entry.key, entry]]));
      const scopeText = challengedScopes.length ? ` Required scopes: ${challengedScopes.join(' ')}.` : '';
      const stepUpError = new Error(
        `MCP server "${serverName}" requires additional OAuth authorization.${scopeText} Use mcp auth_start to continue.`,
      );
      Object.assign(stepUpError, { code: 'insufficient_scope', status: 403 });
      await runMobileRenderReproSubphase('managed-failure-health', () => observeManagedFailure(entry, stepUpError));
      entry.lastError = stepUpError.message;
      throw stepUpError;
    }
    const enhanced = enhanceMcpError(error);
    entry.lastError = enhanced.message;
    await runMobileRenderReproSubphase('managed-failure-health', () => observeManagedFailure(entry, enhanced));
    // Transport/auth failures must not leave a stale session available for reuse.
    await runMobileRenderReproSubphase('managed-close', () => closeManagedEntries([[entry.key, entry]]));
    throw enhanced;
  } finally {
    entry.activeCalls = Math.max(0, entry.activeCalls - 1);
    entry.lastUsedAt = Date.now();
  }
  });
}

function resolveCachePath(scope?: McpScope | null): string {
  return resolveMcpStoragePath(CACHE_FILE, scope);
}

async function readCache(scope?: McpScope | null): Promise<McpCacheFile> {
  try {
    const { content } = await readMcpTextFileIfExists(CACHE_FILE, scope);
    if (!content) {
      return { version: 1, updatedAt: new Date(0).toISOString(), servers: {} };
    }
    return JSON.parse(content) as McpCacheFile;
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), servers: {} };
  }
}

async function writeCache(cache: McpCacheFile, scope?: McpScope | null): Promise<void> {
  await writeMcpTextFileAtomic(CACHE_FILE, JSON.stringify(cache, null, 2), scope);
}

export async function readCachedTools(serverName: string, configHash: string, scope?: McpScope | null): Promise<Tool[] | null> {
  const selected = await assertMcpConnectionAccess(serverName, scope);
  if (hashMcpServerConfig(selected.connection) !== configHash) return null;
  const cache = await readCache(scope);
  const entry = cache.servers[selected.serverName];
  return entry?.configHash === configHash ? entry.tools : null;
}

async function writeCachedTools(serverName: string, configHash: string, tools: Tool[], scope?: McpScope | null): Promise<void> {
  const cache = await readCache(scope);
  cache.version = 1;
  cache.updatedAt = new Date().toISOString();
  cache.servers[serverName] = {
    configHash,
    tools,
    lastRefreshedAt: new Date().toISOString(),
  };
  await writeCache(cache, scope);
}

export async function listConfiguredMcpServers(scope?: McpScope | null) {
  const actor = await requireMcpUserAccess(scope);
  const config = await readMcpConfig(scope);
  const entries = await Promise.all(Object.entries(config.mcpServers).map(async ([name, serverConfig]) => {
    try { await assertMcpConnectionAccess(name, scope, { allowDisabled: true, actor }); } catch { return null; }
    return { name, connectionId: serverConfig.connectionId || null, displayName: serverConfig.displayName || name,
      transport: getServerTransport(serverConfig), configHash: hashMcpServerConfig(serverConfig),
      enabled: isMcpServerEnabled(serverConfig), configured: true };
  }));
  return entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

export async function listMcpTools(serverName: string, options: { preferCache?: boolean; signal?: AbortSignal; scope?: McpScope | null } = {}): Promise<Tool[]> {
  const selected = await assertMcpConnectionAccess(serverName, options.scope);
  serverName = selected.serverName;
  const scope = normalizeMcpScope(options.scope);
  const serverConfig = selected.connection;
  const configHash = hashMcpServerConfig(serverConfig);

  if (options.preferCache) {
    const cached = await readCachedTools(serverName, configHash, scope);
    if (cached) return cached;
  }

  return withManagedConnection(serverName, async (entry, client) => {
    logMcp('info', 'Listing tools', { server: serverName });
    const result = await withTimeout(client.listTools(), getTimeoutMs(entry.config), options.signal);
    entry.lastSuccessfulToolListAt = Date.now();
    await writeCachedTools(serverName, entry.configHash, result.tools, scope);
    logMcp('info', 'Listed tools', { server: serverName, count: result.tools.length });
    return result.tools;
  }, options.signal, scope);
}

/** Readiness metadata retains resource access guards but cannot inherit a pending business-call guard. */
export async function listMcpToolsForReadiness(serverName: string, options: { signal?: AbortSignal; scope?: McpScope | null } = {}): Promise<Tool[]> {
  return mcpInvocationBindings.run(null, () => listMcpTools(serverName, options));
}

export async function callMcpTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  scope?: McpScope | null,
): Promise<CallToolResult> {
  return (await callMcpToolWithCurrentMetadata(serverName, toolName, args, signal, scope)).result;
}

export type McpToolCallWithCurrentMetadata = {
  result: CallToolResult;
  tool: Tool;
  connectionId: string | null;
  sharedConnectionRef?: string;
};

/** Executes a model-visible tool and returns the exact, live tool metadata. */
export async function callMcpToolWithCurrentMetadata(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  scope?: McpScope | null,
  options: {
    validateTool?: (tool: Tool, connection: Readonly<McpServerConfig>) => void | Promise<void>;
    expectedEnvironmentRevision?: string;
    beforeDispatch?: () => Promise<void>;
  } = {},
): Promise<McpToolCallWithCurrentMetadata> {
  if (scope?.shared) scope = normalizeMcpScope({ ...scope, shared: { ...scope.shared, operation: 'use', toolName } });
  return mcpInvocationBindings.run(null, () => withManagedConnection(serverName, async (entry, client) => {
    const currentTools = await withTimeout(client.listTools(), getTimeoutMs(entry.config), signal);
    const currentTool = currentTools.tools.find((tool) => tool.name === toolName);
    if (!currentTool) throw new Error(`Unknown MCP tool "${toolName}" on server "${entry.serverName}".`);
    if (!isMcpAppToolVisibleToModel(currentTool)) {
      throw new Error(`MCP tool "${toolName}" is available only to its MCP App and cannot be called by a model.`);
    }
    if (options.validateTool) await options.validateTool(currentTool, entry.config);
    const invocation = options.expectedEnvironmentRevision
      ? { entry, client, environmentRevision: options.expectedEnvironmentRevision, beforeDispatch: options.beforeDispatch } : null;
    if (invocation) {
      assertInvocationClient(entry, invocation);
      const environment = await readMcpAvailableEnvSnapshot(currentManagedScope(entry));
      if (environment.revision !== invocation.environmentRevision) throw changedInvocationEnvironment();
    }
    await options.beforeDispatch?.();
    if (invocation) assertInvocationClient(entry, invocation);
    signal?.throwIfAborted();
    logMcp('info', 'Calling tool', { server: serverName, tool: toolName });
    const result = await mcpInvocationBindings.run(invocation, () => withTimeout(
      client.callTool({ name: toolName, arguments: args }), getTimeoutMs(entry.config), signal,
    )) as CallToolResult;
    logMcp(result.isError ? 'warn' : 'info', 'Tool call finished', { server: serverName, tool: toolName, isError: Boolean(result.isError) });
    return { result, tool: currentTool, connectionId: entry.config.connectionId || null,
      ...(scope?.shared ? { sharedConnectionRef: scope.shared.connectionRef } : {}) };
  }, signal, scope));
}

function requireMcpAppsEnabled(): void {
  if (!isMcpAppsEnabled()) throw new Error('MCP Apps are disabled by instance policy.');
}

function assertCurrentMcpAppSourceTool(
  tools: readonly Tool[],
  sourceToolName: string,
  resourceUri: string,
): Tool {
  const sourceTool = tools.find((tool) => tool.name === sourceToolName);
  const metadata = sourceTool ? readMcpAppToolMetadata(sourceTool) : null;
  if (!sourceTool || !metadata || metadata.resourceUri !== resourceUri
    || (!isMcpAppToolVisibleToApp(sourceTool) && !isMcpAppToolVisibleToModel(sourceTool))) {
    throw new Error('The MCP App resource is not currently bound to the selected source tool.');
  }
  return sourceTool;
}

export type McpAppCallMetadata = {
  authVersion: number; configHash: string; environmentRevision: string; sourceTool: Tool; targetTool: Tool;
};
export type McpAppDispatchGuard = {
  beforeDispatch: (metadata: McpAppCallMetadata) => Promise<void | false>;
  onDispatch: () => void;
};
type McpAppDispatchOptions = {
  beforeDispatch?: () => Promise<void>; expectedEnvironmentRevision?: string; approval?: McpAppDispatchGuard;
};

function readMcpAppCallMetadataFromTools(entry: ManagedConnection, tools: readonly Tool[], sourceToolName: string,
  resourceUri: string, targetToolName: string, environmentRevision: string): McpAppCallMetadata {
  const sourceTool = assertCurrentMcpAppSourceTool(tools, sourceToolName, resourceUri);
  const targetTool = tools.find(tool => tool.name === targetToolName);
  if (!targetTool || !isMcpAppToolVisibleToApp(targetTool)) {
    throw new McpAccessError(`MCP App tool "${targetToolName}" is not visible to the selected app.`, 403);
  }
  return { authVersion: entry.config.authVersion ?? 1, configHash: entry.configHash, environmentRevision, sourceTool, targetTool };
}

/** Approval metadata retains independent source and target Use checks and cannot dispatch an action. */
export async function readMcpAppCallMetadata(connectionId: string, sourceToolName: string, resourceUri: string,
  targetToolName: string, scope?: McpScope | null): Promise<McpAppCallMetadata> {
  requireMcpAppsEnabled();
  if (scope?.shared) {
    const sourceScope = normalizeMcpScope({ ...scope, shared: { ...scope.shared, operation: 'use', toolName: sourceToolName } })!;
    await authorizeSharedMcpScope(sourceScope, 'use', sourceToolName);
    scope = normalizeMcpScope({ ...sourceScope, shared: { ...sourceScope.shared!, toolName: targetToolName } });
  }
  return mcpInvocationBindings.run(null, () => withManagedConnection(connectionId, async (entry, client) => {
    const tools = await withTimeout(client.listTools(), getTimeoutMs(entry.config));
    const environment = await readMcpAvailableEnvSnapshot(currentManagedScope(entry));
    return readMcpAppCallMetadataFromTools(entry, tools.tools, sourceToolName, resourceUri, targetToolName, environment.revision);
  }, undefined, scope));
}

/** Reuse the business transport's credential-generation fence for shared UI dispatch. */
async function dispatchMcpAppInvocation<T>(entry: ManagedConnection, client: Client, options: McpAppDispatchOptions,
  dispatch: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const invocation = options.expectedEnvironmentRevision ? { entry, client,
    environmentRevision: options.expectedEnvironmentRevision, beforeDispatch: options.beforeDispatch } : null;
  if (invocation) {
    assertInvocationClient(entry, invocation);
    if ((await readMcpAvailableEnvSnapshot(currentManagedScope(entry))).revision !== invocation.environmentRevision) throw changedInvocationEnvironment();
  }
  await options.beforeDispatch?.();
  if (invocation) assertInvocationClient(entry, invocation);
  signal?.throwIfAborted();
  return mcpInvocationBindings.run(invocation, dispatch);
}

/** Reads only the UI resource currently bound to an app-visible source tool. */
export async function readMcpAppResource(
  connectionId: string,
  sourceToolName: string,
  resourceUri: string,
  scope?: McpScope | null,
  options: McpAppDispatchOptions & { signal?: AbortSignal } = {},
): Promise<ReadResourceResult> {
  requireMcpAppsEnabled();
  if (scope?.shared) scope = normalizeMcpScope({ ...scope, shared: { ...scope.shared, operation: 'use', toolName: sourceToolName } });
  const beforeDispatch = options.beforeDispatch;
  const tracedOptions = beforeDispatch ? { ...options, beforeDispatch: () => runMobileRenderReproSubphase('dispatch-guard', beforeDispatch) } : options;
  return mcpInvocationBindings.run(null, () => withManagedConnection(connectionId, async (entry, client) => {
    const tools = await runMobileRenderReproSubphase('tools-list', () => withTimeout(client.listTools(), getTimeoutMs(entry.config), options.signal));
    assertCurrentMcpAppSourceTool(tools.tools, sourceToolName, resourceUri);
    const result = await dispatchMcpAppInvocation(entry, client, tracedOptions,
      () => runMobileRenderReproSubphase('resource-rpc', () => withTimeout(client.readResource({ uri: resourceUri }), getTimeoutMs(entry.config), options.signal)), options.signal);
    const contents = Array.isArray(result.contents) ? result.contents : [];
    if (!contents.some((content) => content.uri === resourceUri && isMcpAppResourceMimeType(content.mimeType))) {
      throw new Error('The MCP server did not return the requested MCP App HTML resource.');
    }
    return result;
  }, options.signal, scope));
}

/**
 * Executes an app-visible tool after revalidating the source UI binding and
 * target visibility on the live connection. This is separate from model tool
 * invocation, which always rejects app-only tools.
 */
export async function callMcpAppTool(
  connectionId: string,
  sourceToolName: string,
  resourceUri: string,
  targetToolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  scope?: McpScope | null,
  options: McpAppDispatchOptions = {},
): Promise<CallToolResult> {
  requireMcpAppsEnabled();
  if (scope?.shared) {
    const sourceScope = normalizeMcpScope({ ...scope, shared: { ...scope.shared, operation: 'use', toolName: sourceToolName } })!;
    await authorizeSharedMcpScope(sourceScope, 'use', sourceToolName);
    scope = normalizeMcpScope({ ...sourceScope, shared: { ...sourceScope.shared!, toolName: targetToolName } });
  }
  return mcpInvocationBindings.run(null, () => withManagedConnection(connectionId, async (entry, client) => {
    const tools = await withTimeout(client.listTools(), getTimeoutMs(entry.config), signal);
    const environment = await readMcpAvailableEnvSnapshot(currentManagedScope(entry));
    const metadata = readMcpAppCallMetadataFromTools(entry, tools.tools, sourceToolName, resourceUri, targetToolName, environment.revision);
    await validateIntegrationArguments(metadata.targetTool.inputSchema, args);
    return dispatchMcpAppInvocation(entry, client, options, async () => {
      if (options.approval) {
        if (await options.approval.beforeDispatch(metadata) === false) return { content: [], isError: true };
        signal?.throwIfAborted();
        options.approval.onDispatch();
      }
      return withTimeout(client.callTool({ name: targetToolName, arguments: args }),
        getTimeoutMs(entry.config), signal) as Promise<CallToolResult>;
    }, signal);
  }, signal, scope));
}

/** Legacy ping or stateless discovery; never executes a business tool. */
export async function probeMcpConnection(serverName: string, scope: McpScope, signal?: AbortSignal): Promise<void> {
  await withManagedConnection(serverName, async (entry, client) => {
    const check = (client.getNegotiatedProtocolVersion() || '') >= '2026-07-28' ? client.discover({ signal }) : client.ping({ signal });
    await withTimeout(check, Math.min(5000, getTimeoutMs(entry.config)), signal);
  }, signal, scope);
}

export async function cleanupIdleMcpServers(now = Date.now(), scope?: McpScope | null): Promise<number> {
  const hasExplicitScope = scope !== undefined;
  const normalizedScope = normalizeMcpScope(scope);
  const idleTimeoutByScope = new Map<string, number>();
  const store = getStore();
  let closed = 0;

  for (const [key, entry] of store.entries) {
    if (hasExplicitScope && getMcpScopeKey(entry.scope) !== getMcpScopeKey(normalizedScope)) continue;
    if (!entry.client || entry.activeCalls > 0) continue;
    const entryScopeKey = getMcpScopeKey(entry.scope);
    let idleTimeoutMs = idleTimeoutByScope.get(entryScopeKey);
    if (idleTimeoutMs === undefined) {
      const config = await readMcpConfig(entry.scope);
      idleTimeoutMs = getIdleTimeoutMs(config);
      idleTimeoutByScope.set(entryScopeKey, idleTimeoutMs);
    }
    if (idleTimeoutMs > 0 && now - entry.lastUsedAt < idleTimeoutMs) continue;
    logMcp('info', 'Closing idle server', { server: entry.serverName, transport: entry.transport, pid: entry.processPid });
    await entry.client.close().catch(() => undefined);
    entry.client = undefined;
    entry.processPid = undefined;
    store.entries.delete(key);
    closed += 1;
  }

  return closed;
}

function matchesManagedOwner(entry: ManagedConnection, scope: McpScope | null): boolean {
  if (!scope?.userId) return !entry.scope?.userId;
  return entry.scope?.userId === scope.userId
    && (!scope.organizationId || entry.config.organizationId === scope.organizationId);
}

function configReferencesAnyEnvKey(config: McpServerConfig, changedEnvKeys: Set<string>, availableEnv: Record<string, string>): boolean {
  return mcpConfigUsesChangedEnv(config, changedEnvKeys, availableEnv);
}

async function closeManagedEntries(targets: Array<[string, ManagedConnection]>): Promise<void> {
  const store = getStore();
  // Remove every captured entry before awaiting transport close. A concurrent
  // replacement is a distinct connection and must survive this close request.
  for (const [key, entry] of targets) {
    if (store.entries.get(key) === entry) store.entries.delete(key);
    entry.closed = true;
    entry.abortController.abort(new Error('MCP connection closed.'));
  }
  for (const [, entry] of targets) {
    logMcp('info', 'Closing server', { server: entry.serverName, transport: entry.transport, pid: entry.processPid });
    await (entry.client || entry.connectingClient)?.close().catch(() => undefined);
  }
}

export async function closeMcpServer(serverName: string, scope?: McpScope | null): Promise<void> {
  const normalizedScope = normalizeMcpScope(scope);
  const targets = [...getStore().entries].filter(([, entry]) => matchesManagedOwner(entry, normalizedScope)
    && (entry.serverName === serverName || entry.config.connectionId === serverName));
  await closeManagedEntries(targets);
}

export async function closeMcpServersForScope(scope?: McpScope | null, changedEnvKeys?: string[]): Promise<void> {
  const normalizedScope = normalizeMcpScope(scope);
  const changedKeys = changedEnvKeys === undefined ? null : new Set(changedEnvKeys);
  const availableEnv = changedKeys ? await readAvailableEnv(normalizedScope) : {};
  const targets = [...getStore().entries].filter(([, entry]) => matchesManagedOwner(entry, normalizedScope)
    && (!changedKeys || configReferencesAnyEnvKey(entry.config, changedKeys, availableEnv)));
  await closeManagedEntries(targets);
}

export async function closeAllMcpServers(): Promise<void> {
  await closeManagedEntries([...getStore().entries]);
}

/** The app server owns its resource drain and final process exit. */
export function registerMcpShutdownCoordinator(coordinator: (signal: NodeJS.Signals) => void | Promise<void>): void {
  if (typeof coordinator !== 'function') {
    throw new TypeError('MCP shutdown coordinator must be a function.');
  }
  const store = getStore();
  if (store.shutdownCoordinator && store.shutdownCoordinator !== coordinator) {
    throw new Error('MCP shutdown is already coordinated by another owner.');
  }
  store.shutdownCoordinator = coordinator;
}

function startMcpShutdownHooks(): void {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const store = getStore();
  if (store.shutdownHooksStarted) return;
  store.shutdownHooksStarted = true;

  const shutdown = (signal: NodeJS.Signals) => {
    const coordinator = store.shutdownCoordinator;
    if (coordinator) {
      void Promise.resolve().then(() => coordinator(signal)).catch((error) => {
        logMcp('error', 'Error while delegating shutdown to the app server', { signal, error: getErrorMessage(error) });
      });
      return;
    }
    if (store.shuttingDown) return;
    store.shuttingDown = true;
    logMcp('info', 'Shutdown signal received, closing MCP servers', { signal });
    void closeAllMcpServers()
      .catch((error) => {
        logMcp('error', 'Error while closing MCP servers during shutdown', { signal, error: getErrorMessage(error) });
      })
      .finally(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.once('beforeExit', () => {
    if (store.entries.size === 0) return;
    logMcp('info', 'Process beforeExit, closing MCP servers');
    void closeAllMcpServers().catch((error) => {
      logMcp('error', 'Error while closing MCP servers before exit', { error: getErrorMessage(error) });
    });
  });
}

export function startMcpIdleCleanup(): void {
  const store = getStore();
  startMcpShutdownHooks();
  if (store.cleanupStarted) return;
  store.cleanupStarted = true;
  setInterval(() => {
    void cleanupIdleMcpServers().catch(() => undefined);
  }, 60_000).unref?.();
}

export async function getMcpRuntimeStatus(serverName?: string, scope?: McpScope | null) {
  const actor = await requireMcpUserAccess(scope);
  const normalizedScope = normalizeMcpScope(scope);
  const config = await readMcpConfig(normalizedScope);
  const cache = await readCache(normalizedScope);
  const store = getStore();
  const entries = await Promise.all(Object.entries(config.mcpServers)
    .filter(([name, item]) => !serverName || name === serverName || item.connectionId === serverName)
    .map(async ([name, serverConfig]) => {
      let accessAllowed = true;
      try { await assertMcpConnectionAccess(name, normalizedScope, { allowDisabled: true, actor }); } catch { accessAllowed = false; }
      const configHash = hashMcpServerConfig(serverConfig);
      const managed = store.entries.get(getEntryKey(normalizedScope, name, configHash));
      const cached = cache.servers[name]?.configHash === configHash ? cache.servers[name] : undefined;
      const health = accessAllowed && serverConfig.connectionId && normalizedScope?.userId
        ? await readMcpConnectionStatus(name, serverConfig as McpServerConfig & { connectionId: string }, normalizedScope) : null;
      return {
        name,
        connectionId: serverConfig.connectionId || null,
        displayName: serverConfig.displayName || name,
        accessAllowed,
        accessError: accessAllowed ? null : 'MCP_ACCESS_DENIED',
        health,
        transport: getServerTransport(serverConfig),
        configHash,
        enabled: isMcpServerEnabled(serverConfig),
        connected: accessAllowed && isMcpServerEnabled(serverConfig) && Boolean(managed?.client),
        protocolVersion: managed?.client?.getNegotiatedProtocolVersion() || null,
        activeCalls: managed?.activeCalls || 0,
        lastUsedAt: managed?.lastUsedAt ? new Date(managed.lastUsedAt).toISOString() : null,
        lastSuccessfulToolListAt: managed?.lastSuccessfulToolListAt ? new Date(managed.lastSuccessfulToolListAt).toISOString() : null,
        lastError: health?.lastErrorCode || managed?.lastError || null,
        cachedToolCount: cached?.tools.length || 0,
        cacheRefreshedAt: cached?.lastRefreshedAt || null,
      };
    }));

  return {
    canManageDefinitions: actor?.canManageDefinitions ?? true,
    configPath: resolveMcpConfigPath(normalizedScope),
    cachePath: resolveCachePath(normalizedScope),
    servers: entries,
  };
}
