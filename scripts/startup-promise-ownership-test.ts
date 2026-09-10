import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { betterAuth } from 'better-auth';
import { oauthProvider } from '@better-auth/oauth-provider';
import { observeStartupTask } from '../app/lib/startup/observed-task';
import { evaluateIsolatedModule, loadIsolatedModule, sourceFunction } from './helpers/isolated-source-module';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function testAuthModule(unhandled: unknown[]) {
  for (const enabled of ['true', 'false']) {
    const initialization = deferred<void>();
    let creations = 0;
    const instance = {
      $context: initialization.promise,
      api: { getSession: async () => { await initialization.promise; } },
    };
    const plugin = () => ({});
    const exported = loadIsolatedModule<{
      auth: typeof instance; ensureAuthReady: () => Promise<void>;
    }>('app/lib/auth.ts', {
      'better-auth': { betterAuth: () => { creations++; return instance; } },
      'better-auth/api': { createAuthMiddleware: plugin },
      'better-auth/adapters/drizzle': { drizzleAdapter: plugin },
      'drizzle-orm': {},
      '@/app/lib/db': { db: {} },
      '@/app/lib/db/schema': {},
      '@/app/lib/auth-cookie': { canvasAuthCookieOptions: plugin, usesSecureAuthCookies: () => false },
      'better-auth/next-js': { nextCookies: plugin },
      'better-auth/plugins': { admin: plugin, bearer: plugin, jwt: plugin },
      '@better-auth/oauth-provider': { oauthProvider: plugin },
      '@better-auth/expo': { expo: plugin },
      '@/app/lib/security/auth-secret': { resolveAuthSecret: () => 'offline-fixture' },
      '@/app/lib/security/trusted-origins': { getConfiguredTrustedOrigins: () => [] },
      '@/app/lib/security/request-identity': {},
      '@/app/lib/organization/membership-ban-reasons': {},
      '@/app/lib/mcp/server/config': { DIRECT_MCP_OAUTH_SCOPES: [], resolveDirectMcpOAuthConfig: () => ({}) },
      '@/app/lib/mcp/server/diagnostics': {},
      '@/app/lib/mcp/server/oauth-resource-config': { directMcpOAuthResourceOptions: () => ({}) },
      '@/app/lib/startup/observed-task': { observeStartupTask },
      '@/app/lib/license/seat-limit': {},
    }, { process: { env: { CANVAS_MCP_DIRECT_ENABLED: enabled } } });
    const failure = new Error(`OAuth init failed, MCP enabled=${enabled}`);
    initialization.reject(failure);
    await delay(20); // Simulate a consumer that is still busy in another startup phase.
    assert.deepEqual(unhandled, []);
    assert.equal(exported.auth, instance, 'do not replace the Better Auth API object');
    await Promise.all(Array.from({ length: 3 }, () => assert.rejects(exported.ensureAuthReady(), (error) => error === failure)));
    await assert.rejects(exported.auth.api.getSession(), (error) => error === failure);
    assert.equal(creations, 1, 'waiting must not reinitialize/reseed Auth');
  }
}

async function testRealOAuthInitialization(unhandled: unknown[]) {
  const failure = new Error('Connection terminated due to connection timeout');
  let reads = 0;
  const plugin = oauthProvider({
    loginPage: '/login', consentPage: '/consent', disableJwtPlugin: true,
    resources: ['http://localhost:3000/mcp'], silenceWarnings: { oauthAuthServerConfig: true },
  });
  const initialize = plugin.init!;
  plugin.init = (context) => initialize({
    ...context,
    adapter: {
      ...context.adapter,
      findOne: async (query) => { assert.equal(query.model, 'oauthResource'); reads++; throw failure; },
    },
  });
  const auth = betterAuth({
    baseURL: 'http://localhost:3000', secret: 'offline-startup-test-secret-at-least-32-characters',
    plugins: [plugin], logger: { disabled: true }, telemetry: { enabled: false },
  });
  const wait = observeStartupTask(auth.$context);
  await delay(30);
  assert.deepEqual(unhandled, []);
  await assert.rejects(wait(), (error) => error === failure);
  await assert.rejects(wait(), (error) => error === failure);
  await assert.rejects(auth.$context, (error) => error === failure);
  assert.equal(reads, 1);
}

async function testServerSequencing(unhandled: unknown[]) {
  for (const scenario of ['success', 'auth-failure', 'schema-failure', 'warmup-failure'] as const) {
    const events: string[] = [];
    const authGate = deferred<void>();
    const channelGate = deferred<void>();
    const failure = new Error(scenario);
    const noop = () => {};
    const ws = { createWebSocketServer: noop, closeWebSocketServer: noop, isChatWebSocketRequest: noop };
    const exported = evaluateIsolatedModule<{ startServer: () => Promise<void> }>(sourceFunction('server.js', 'startServer'), {
      './app/lib/auth': { ensureAuthReady: async () => { events.push('auth'); await authGate.promise; } },
      './app/lib/mcp/server/readiness': { assertDirectMcpStartupReady: async () => {
        events.push('schema');
        if (scenario === 'schema-failure') throw failure;
      } },
      './server/websocket-server.ts': ws,
      './server/browser-view-server.ts': { createBrowserViewServer: noop },
      './server/collaboration-server.ts': { createCollaborationServer: noop },
      './server/excalidraw-collaboration/server.ts': { createExcalidrawCollaborationServer: noop },
      './server/agent-runtime-loader.ts': { preloadAgentRuntimeModules: async () => {
        events.push('warmup');
        if (scenario === 'warmup-failure') throw failure;
      } },
      './app/lib/managed/control-plane-models.ts': { primeCanvasControlPlaneCatalog: async () => ({ models: [] }) },
      './app/lib/channels/manager.ts': { getChannelManager: () => ({ start: async () => {
        events.push('channel'); await channelGate.promise;
      } }) },
    }, {
      runStartupDatabaseMigrations: async () => { events.push('migrations'); },
      observeStartupTask,
      console: { log: noop, error: noop }, process: { env: {} },
      resolveImportedServerModule: (module: unknown) => module,
      closeChatWebSocketServer: null, flushCollaborationDocuments: null,
      flushExcalidrawCollaborationDocuments: null, isCanvasWebSocketRequest: null,
      installChatUpgradeGuard: noop, port: 3000, hostname: 'localhost',
      app: { prepare: async () => { events.push('prepare'); } },
      server: { listen: () => { events.push('listen'); } },
      scheduleBackgroundMaintenance: noop, recoverStaleAutomationRuns: noop,
    });
    const result = observeStartupTask(exported.startServer());
    await delay(10);
    assert.deepEqual(events, ['migrations', 'auth'], 'Auth must finish before schema/import/warmup work');
    if (scenario === 'auth-failure') authGate.reject(failure);
    else authGate.resolve();
    await delay(20);
    assert.deepEqual(unhandled, [], 'an early warmup rejection must already be owned while channels wait');
    assert.ok(!events.includes('listen'));
    channelGate.resolve();
    if (scenario === 'success') { await result(); assert.equal(events.at(-1), 'listen'); }
    else { await assert.rejects(result(), (error) => error === failure); assert.ok(!events.includes('listen')); }
    if (scenario === 'auth-failure') assert.ok(!events.includes('schema'));
    if (scenario === 'schema-failure') assert.ok(!events.includes('warmup'));
  }
}

async function main() {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    const ready = observeStartupTask(Promise.resolve('ready'));
    assert.deepEqual(await Promise.all([ready(), ready()]), ['ready', 'ready']);
    await testAuthModule(unhandled);
    await testRealOAuthInitialization(unhandled);
    await testServerSequencing(unhandled);
    assert.deepEqual(unhandled, []);
    console.log('Startup ownership: real OAuth failure, Auth module wiring, MCP on/off and delayed warmup consumers passed.');
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
