import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import Module from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type FixtureMode = 'success' | 'invalid_grant' | 'rate_limited' | 'server_error' | 'delayed';

type StoredToken = {
  lifecycleGeneration?: number;
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

type Membership = { organizationId: string; role: 'admin' | 'member'; status: 'active' | 'suspended' };
const memberships = new Map<string, Membership>();
const moduleInternals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = moduleInternals._load;

function mockedModule(request: string): unknown | null {
  if (request.includes('license/seat-limit')) return {
    assertUserSeatAccess: async ({ userId }: { userId: string }) => {
      const membership = memberships.get(userId);
      if (!membership || membership.status !== 'active') throw Object.assign(new Error('Seat access is inactive.'), { status: 403 });
      return { userId, mode: 'team', organizationId: membership.organizationId };
    },
  };
  if (request.includes('organization/permissions')) return {
    readOrganizationPermissionForUser: async (userId: string) => {
      const membership = memberships.get(userId);
      return membership
        ? { configured: true, organizationId: membership.organizationId, permission: { role: membership.role, status: membership.status } }
        : { configured: false, organizationId: null, permission: null };
    },
    assertUserOrganizationAdmin: async (userId: string) => {
      if (memberships.get(userId)?.role !== 'admin') throw new Error('Admin required.');
    },
  };
  if (request === 'server-only') return {};
  return null;
}

moduleInternals._load = (request, parent, isMain) => mockedModule(request) ?? originalLoad(request, parent, isMain);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function readForm(request: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    request.on('error', reject);
  });
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<string> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`OAuth refresh worker exited ${code}: ${stderr}`));
    });
  });
}

async function settlesWithin<T>(operation: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    operation,
    delay(2_000).then(() => { throw new Error(`${label} did not settle within two seconds.`); }),
  ]);
}

async function refreshWorker(): Promise<void> {
  const scope = { userId: process.env.MCP_OAUTH_LIFECYCLE_USER_ID || '' };
  memberships.set(scope.userId, { organizationId: 'fixture-org-b', role: 'admin', status: 'active' });
  const { readMcpConfig } = await import('../app/lib/mcp/config');
  const { hashMcpAuthConfig } = await import('../app/lib/mcp/connection-identity');
  const { getValidMcpAccessToken } = await import('../app/lib/mcp/oauth');
  const server = (await readMcpConfig(scope)).mcpServers.remote;
  assert.ok(server, 'worker must receive the configured connection');
  const accessToken = await getValidMcpAccessToken('remote', server, hashMcpAuthConfig(server), scope);
  process.stdout.write(`${accessToken}\n`);
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mcp-oauth-lifecycle-'));
  const userScope = { userId: 'oauth-lifecycle-user' };
  const userScopeOther = { userId: 'oauth-lifecycle-other-user' };
  memberships.set(userScope.userId, { organizationId: 'fixture-org-b', role: 'admin', status: 'active' });
  const originalEnv = {
    CANVAS_DATA_ROOT: process.env.CANVAS_DATA_ROOT,
    DATA: process.env.DATA,
    INTEGRATIONS_ENV_MASTER_KEY: process.env.INTEGRATIONS_ENV_MASTER_KEY,
    MCP_ALLOW_PRIVATE_NETWORK: process.env.MCP_ALLOW_PRIVATE_NETWORK,
    MCP_ALLOW_INSECURE_HTTP: process.env.MCP_ALLOW_INSECURE_HTTP,
    BASE_URL: process.env.BASE_URL,
  };
  process.env.CANVAS_DATA_ROOT = tempRoot;
  process.env.DATA = tempRoot;
  process.env.INTEGRATIONS_ENV_MASTER_KEY = crypto.randomBytes(48).toString('hex');
  process.env.MCP_ALLOW_PRIVATE_NETWORK = 'true';
  process.env.MCP_ALLOW_INSECURE_HTTP = 'true';
  process.env.BASE_URL = 'http://localhost:3000';

  let baseUrl = '';
  let refreshMode: FixtureMode = 'success';
  let callbackMode: FixtureMode = 'success';
  let refreshCalls = 0;
  let callbackCalls = 0;
  let refreshEntered = deferred<void>();
  let releaseRefresh = deferred<void>();
  let callbackEntered = deferred<void>();
  let releaseCallback = deferred<void>();
  const fixture = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', baseUrl);
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
      }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      const form = await readForm(request);
      response.setHeader('Content-Type', 'application/json');
      const isRefresh = form.get('grant_type') === 'refresh_token';
      if (isRefresh) {
        refreshCalls += 1;
        if (refreshMode === 'delayed') {
          refreshEntered.resolve();
          await releaseRefresh.promise;
        }
        if (refreshMode === 'invalid_grant') {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        if (refreshMode === 'rate_limited') {
          response.statusCode = 429;
          response.end(JSON.stringify({ error: 'temporarily_unavailable' }));
          return;
        }
        if (refreshMode === 'server_error') {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: 'server_error' }));
          return;
        }
        response.end(JSON.stringify({
          access_token: `rotated-access-${refreshCalls}`,
          refresh_token: `rotated-refresh-${refreshCalls}`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp',
        }));
        return;
      }

      callbackCalls += 1;
      if (callbackMode === 'delayed') {
        callbackEntered.resolve();
        await releaseCallback.promise;
      }
      response.end(JSON.stringify({
        access_token: `callback-access-${callbackCalls}`,
        refresh_token: `callback-refresh-${callbackCalls}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp',
      }));
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await listen(fixture);
  const address = fixture.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const { readMcpConfig, writeMcpConfigRaw } = await import('../app/lib/mcp/config');
    const { hashMcpAuthConfig } = await import('../app/lib/mcp/connection-identity');
    const { readMcpCredentialJson, resolveMcpCredentialConnection, writeMcpCredentialJson } = await import('../app/lib/mcp/credential-storage');
    const { readMcpOAuthLifecycle } = await import('../app/lib/mcp/oauth-lifecycle');
    const { resolveMcpStoragePath } = await import('../app/lib/mcp/storage');
    const {
      clearMcpOAuth,
      completeMcpOAuthCallback,
      getMcpOAuthStatus,
      getValidMcpAccessToken,
      startMcpOAuth,
    } = await import('../app/lib/mcp/oauth');

    async function writeConfig(resourceSuffix = '') {
      await writeMcpConfigRaw(JSON.stringify({
        settings: { toolPrefix: 'fixture', idleTimeout: 10 },
        mcpServers: {
          remote: {
            url: `${baseUrl}/resource${resourceSuffix}`,
            auth: 'oauth',
            oauth: {
              issuer: baseUrl,
              authorizationUrl: `${baseUrl}/authorize`,
              tokenUrl: `${baseUrl}/token`,
              clientId: 'fixture-client',
              scopes: ['mcp'],
            },
          },
        },
      }), userScope);
      const server = (await readMcpConfig(userScope)).mcpServers.remote;
      assert.ok(server);
      return server;
    }

    async function credentialPath() {
      const connection = await resolveMcpCredentialConnection('remote', userScope);
      return `connections/${connection.connectionId}/tokens.json`;
    }

    async function seedExpired(server: Awaited<ReturnType<typeof writeConfig>>, refreshToken?: string): Promise<StoredToken> {
      const connection = await resolveMcpCredentialConnection('remote', userScope);
      const token: StoredToken = {
        lifecycleGeneration: (await readMcpOAuthLifecycle(connection.connectionId, userScope)).generation,
        connectionId: connection.connectionId,
        authVersion: server.authVersion,
        serverName: 'remote',
        serverUrl: server.url,
        issuer: baseUrl,
        resource: String(server.url),
        configHash: hashMcpAuthConfig(server),
        clientId: 'fixture-client',
        scope: 'mcp',
        tokenType: 'Bearer',
        accessToken: 'expired-access',
        refreshToken,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeMcpCredentialJson(await credentialPath(), token, userScope);
      return token;
    }

    async function readToken(): Promise<StoredToken | null> {
      return readMcpCredentialJson<StoredToken>(await credentialPath(), userScope);
    }

    async function waitForGeneration(connectionId: string, priorGeneration: number, label: string): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await readMcpOAuthLifecycle(connectionId, userScope)).generation > priorGeneration) return;
        await delay(10);
      }
      throw new Error(`${label} did not invalidate the OAuth generation before the token endpoint was released.`);
    }

    let server = await writeConfig();
    const connection = await resolveMcpCredentialConnection('remote', userScope);
    refreshMode = 'success';
    refreshCalls = 0;
    await seedExpired(server, 'parallel-refresh');
    const parallel = await Promise.all(Array.from({ length: 24 }, () => (
      getValidMcpAccessToken('remote', server, hashMcpAuthConfig(server), userScope)
    )));
    assert.deepEqual(new Set(parallel), new Set(['rotated-access-1']));
    assert.equal(refreshCalls, 1, 'all in-process callers must share one token refresh');
    assert.equal((await readToken())?.refreshToken, 'rotated-refresh-1', 'rotated refresh credentials must be persisted');
    const rejectedTokenReplacement = await getValidMcpAccessToken(
      'remote', server, hashMcpAuthConfig(server), userScope, { rejectedAccessToken: 'rotated-access-1' },
    );
    assert.equal(rejectedTokenReplacement, 'rotated-access-2', 'a rejected current access token must force one replacement refresh');
    assert.equal(refreshCalls, 2);

    refreshCalls = 0;
    await seedExpired(server, 'child-refresh');
    const children = Array.from({ length: 4 }, () => spawn(process.execPath, [
      '--import', 'tsx', '--conditions', 'react-server', path.resolve('scripts/mcp-oauth-lifecycle-test.ts'), '--refresh-worker',
    ], {
      env: {
        ...process.env,
        MCP_OAUTH_LIFECYCLE_USER_ID: userScope.userId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const childTokens = await Promise.all(children.map(waitForChild));
    assert.deepEqual(new Set(childTokens), new Set(['rotated-access-1']));
    assert.equal(refreshCalls, 1, 'all Node processes must share one token refresh');
    assert.equal((await readToken())?.refreshToken, 'rotated-refresh-1');

    for (const [mode, pattern, shouldRemove] of [
      ['invalid_grant', /reauthorize|refresh/i, true],
      ['rate_limited', /rate_limited|429|token endpoint/i, false],
      ['server_error', /provider_unavailable|503|token endpoint/i, false],
    ] as const) {
      refreshMode = mode;
      const expected = await seedExpired(server, `${mode}-refresh`);
      await assert.rejects(
        getValidMcpAccessToken('remote', server, hashMcpAuthConfig(server), userScope, { forceRefresh: true }),
        pattern,
      );
      const stored = await readToken();
      if (shouldRemove) assert.equal(stored, null, 'invalid_grant must discard unusable credentials');
      else assert.deepEqual(stored, expected, `${mode} must preserve credentials for retry`);
    }

    await seedExpired(server);
    await assert.rejects(
      getValidMcpAccessToken('remote', server, hashMcpAuthConfig(server), userScope),
      /expired|authorize/i,
    );
    assert.equal((await getMcpOAuthStatus('remote', undefined, userScope)).authStatus, 'reauth_required');

    refreshMode = 'success';
    const firstAuthorization = await startMcpOAuth('remote', 'http://localhost:3000', userScope);
    callbackCalls = 0;
    const concurrentCallbacks = await Promise.allSettled([
      completeMcpOAuthCallback('first-code', firstAuthorization.state, baseUrl, userScope),
      completeMcpOAuthCallback('first-code', firstAuthorization.state, baseUrl, userScope),
    ]);
    assert.equal(concurrentCallbacks.filter((result) => result.status === 'fulfilled').length, 1, 'OAuth state may only be consumed once');
    assert.equal(callbackCalls, 1, 'replayed callbacks must not exchange another authorization code');
    const completedStatus = await getMcpOAuthStatus('remote', undefined, userScope);
    assert.equal(completedStatus.authStatus, 'authorized');
    assert.equal(completedStatus.lastCompletedState, firstAuthorization.state, 'successful reauthorization must record the completed state');
    await assert.rejects(completeMcpOAuthCallback('replay-code', firstAuthorization.state, baseUrl, userScope), /invalid|expired/i);

    const scopedAuthorization = await startMcpOAuth('remote', 'http://localhost:3000', userScope);
    await assert.rejects(completeMcpOAuthCallback('other-user-code', scopedAuthorization.state, baseUrl, userScopeOther), /invalid|expired/i);
    await completeMcpOAuthCallback('correct-user-code', scopedAuthorization.state, baseUrl, userScope);

    await clearMcpOAuth('remote', userScope);
    callbackMode = 'delayed';
    callbackEntered = deferred<void>();
    releaseCallback = deferred<void>();
    const staleConfigAuthorization = await startMcpOAuth('remote', 'http://localhost:3000', userScope);
    const staleCallback = completeMcpOAuthCallback('stale-config-code', staleConfigAuthorization.state, baseUrl, userScope);
    await callbackEntered.promise;
    const concurrentConfigChange = writeConfig('?changed=1');
    releaseCallback.resolve();
    const [staleCallbackResult, configChangeResult] = await settlesWithin(
      Promise.allSettled([staleCallback, concurrentConfigChange]),
      'concurrent callback completion and config mutation',
    );
    assert.equal(configChangeResult.status, 'fulfilled');
    assert.equal(staleCallbackResult.status, 'rejected');
    server = (await readMcpConfig(userScope)).mcpServers.remote!;
    assert.equal(await readToken(), null, 'a callback started before an auth-version change must not write a token');

    callbackMode = 'success';
    server = await writeConfig();
    await seedExpired(server, 'config-change-refresh');
    refreshMode = 'delayed';
    refreshEntered = deferred<void>();
    releaseRefresh = deferred<void>();
    const staleRefresh = getValidMcpAccessToken('remote', server, hashMcpAuthConfig(server), userScope, { forceRefresh: true });
    await refreshEntered.promise;
    const generationBeforeConfigChange = (await readMcpOAuthLifecycle(connection.connectionId, userScope)).generation;
    const configChangeDuringRefresh = writeConfig('?refresh-changed=1');
    await waitForGeneration(connection.connectionId, generationBeforeConfigChange, 'config mutation');
    releaseRefresh.resolve();
    const [staleRefreshResult] = await settlesWithin(
      Promise.allSettled([staleRefresh, configChangeDuringRefresh]),
      'config mutation during token refresh',
    );
    assert.equal(staleRefreshResult.status, 'rejected', 'a refresh invalidated by a config change must reject');
    assert.equal(await readToken(), null, 'an expired token refresh started before a config auth-version change must not persist credentials');

    server = await writeConfig();
    await seedExpired(server, 'disconnect-refresh');
    refreshMode = 'delayed';
    refreshEntered = deferred<void>();
    releaseRefresh = deferred<void>();
    const delayedRefresh = getValidMcpAccessToken('remote', server, hashMcpAuthConfig(server), userScope, { forceRefresh: true });
    await refreshEntered.promise;
    const generationBeforeDisconnect = (await readMcpOAuthLifecycle(connection.connectionId, userScope)).generation;
    const disconnectRefresh = clearMcpOAuth(connection.connectionId, userScope);
    try {
      await waitForGeneration(connection.connectionId, generationBeforeDisconnect, 'disconnect');
    } finally {
      releaseRefresh.resolve();
    }
    const [delayedRefreshResult] = await settlesWithin(
      Promise.allSettled([delayedRefresh, disconnectRefresh]),
      'disconnect during token refresh',
    );
    assert.equal(delayedRefreshResult.status, 'rejected', 'a refresh invalidated by disconnect must reject');
    assert.equal(await readToken(), null, 'disconnect during refresh must not resurrect credentials');

    callbackMode = 'delayed';
    callbackEntered = deferred<void>();
    releaseCallback = deferred<void>();
    const delayedAuthorization = await startMcpOAuth('remote', 'http://localhost:3000', userScope);
    const delayedCallback = completeMcpOAuthCallback('disconnect-callback-code', delayedAuthorization.state, baseUrl, userScope);
    await callbackEntered.promise;
    await clearMcpOAuth(connection.connectionId, userScope);
    releaseCallback.resolve();
    await assert.rejects(delayedCallback, /disconnect|changed|authorize|invalid/i);
    assert.equal(await readToken(), null, 'disconnect during callback must not resurrect credentials');

    await seedExpired(await writeConfig(), 'clear-before-config-removal');
    await clearMcpOAuth(connection.connectionId, userScope);
    await writeMcpConfigRaw(JSON.stringify({ settings: { toolPrefix: 'fixture', idleTimeout: 10 }, mcpServers: {} }), userScope);
    assert.equal(await readMcpCredentialJson<StoredToken>(`connections/${connection.connectionId}/tokens.json`, userScope), null, 'credentials must be cleared before the connection configuration is removed');

    await writeMcpConfigRaw(JSON.stringify({
      settings: { toolPrefix: 'fixture', idleTimeout: 10 },
      mcpServers: {
        orgBound: {
          url: `${baseUrl}/resource-org-bound`,
          auth: 'oauth',
          organizationId: 'fixture-org-b',
          oauth: {
            issuer: baseUrl,
            authorizationUrl: `${baseUrl}/authorize`,
            tokenUrl: `${baseUrl}/token`,
            clientId: 'fixture-client',
            scopes: ['mcp'],
          },
        },
      },
    }), userScope);
    const orgBound = (await readMcpConfig(userScope)).mcpServers.orgBound!;
    assert.ok(orgBound.connectionId);
    const orgBoundAuthorization = await startMcpOAuth('orgBound', 'http://localhost:3000', userScope);
    await assert.rejects(
      completeMcpOAuthCallback('foreign-org-code', orgBoundAuthorization.state, baseUrl, { userId: userScope.userId, organizationId: 'fixture-org-a' }),
      /organization|invalid|expired/i,
      'a callback cannot use a state sealed for a different connection organization',
    );
    await completeMcpOAuthCallback('bound-org-code', orgBoundAuthorization.state, baseUrl, userScope);
    const orgBoundTokenPath = `connections/${orgBound.connectionId}/tokens.json`;
    const orgBoundToken = await readMcpCredentialJson<StoredToken>(orgBoundTokenPath, userScope);
    assert.ok(orgBoundToken?.accessToken, 'the correctly bound callback persists a token');
    assert.equal((await readMcpCredentialJson<StoredToken>(orgBoundTokenPath, { userId: userScope.userId, organizationId: 'fixture-org-b' }))?.accessToken, orgBoundToken.accessToken);
    await assert.rejects(
      readMcpCredentialJson(orgBoundTokenPath, { userId: userScope.userId, organizationId: 'fixture-org-a' }),
      /organization/i,
    );

    await clearMcpOAuth('orgBound', userScope);
    const legacyRoutedAuthorization = await startMcpOAuth('orgBound', 'http://localhost:3000', userScope);
    const legacyStatePath = resolveMcpStoragePath(`oauth-states/${legacyRoutedAuthorization.state}.json`, userScope);
    const legacyStateEnvelope = JSON.parse(await fs.readFile(legacyStatePath, 'utf8')) as Record<string, unknown>;
    delete legacyStateEnvelope.organizationId;
    await fs.writeFile(legacyStatePath, JSON.stringify(legacyStateEnvelope), { mode: 0o600 });
    await completeMcpOAuthCallback('legacy-routed-org-code', legacyRoutedAuthorization.state, baseUrl, userScope);
    assert.ok(
      (await readMcpCredentialJson<StoredToken>(orgBoundTokenPath, userScope))?.accessToken,
      'a user-only callback can route an old state envelope using the connection association',
    );

    await clearMcpOAuth('orgBound', userScope);
    const roleChangedAuthorization = await startMcpOAuth('orgBound', 'http://localhost:3000', userScope);
    memberships.set(userScope.userId, { organizationId: 'fixture-org-b', role: 'member', status: 'active' });
    await assert.rejects(
      completeMcpOAuthCallback('demoted-member-code', roleChangedAuthorization.state, baseUrl, userScope),
      /approved|access|organization/i,
      'callback persistence rechecks a role change after authorization begins',
    );
    assert.equal(await readMcpCredentialJson<StoredToken>(orgBoundTokenPath, userScope), null, 'a demoted member cannot persist an OAuth callback token');
    await assert.rejects(
      startMcpOAuth('orgBound', 'http://localhost:3000', userScope),
      /approved|access|organization/i,
      'authorization cannot begin for a connection the current role is no longer approved to use',
    );
    memberships.set(userScope.userId, { organizationId: 'fixture-org-b', role: 'admin', status: 'active' });

    console.log('mcp-oauth-lifecycle-test: ok');
  } finally {
    await close(fixture).catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    moduleInternals._load = originalLoad;
  }
}

if (process.argv.includes('--refresh-worker')) {
  void refreshWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
