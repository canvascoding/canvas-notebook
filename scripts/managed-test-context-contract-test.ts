import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  authenticateManagedTestPage,
  createAuthenticatedContext,
  requestManagedTestSession,
  runManagedTestPreflight,
} from '../tests/helpers/managed-test-context';

type Reply = { ok: () => boolean; status: () => number; json: () => Promise<unknown>; headers: () => Record<string, string> };

function response(payload: unknown, status = 200): Reply {
  return { ok: () => status >= 200 && status < 300, status: () => status, json: async () => payload,
    headers: () => ({ 'retry-after': '0' }) };
}

function requestFor(routes: Record<string, Reply | Reply[]>) {
  return { get: async (url: string) => {
    const route = routes[new URL(url).pathname];
    return Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]!) : route || response({}, 404);
  } };
}

function contextFor(routes: Record<string, Reply | Reply[]>) {
  return { request: requestFor(routes) } as never;
}

async function rejectsMessage(action: () => Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof Error && message.test(error.message));
}

async function rejectsAuthAndCleanup(action: () => Promise<unknown>, primary: RegExp): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof AggregateError
    && error.errors.length === 2
    && error.errors[0] instanceof Error && primary.test(error.errors[0].message)
    && error.errors[1] instanceof Error && error.errors[1].message === 'Synthetic context close failure.');
}

async function preflightCases(): Promise<void> {
  await rejectsMessage(
    () => runManagedTestPreflight(contextFor({}), { baseURL: 'not-a-url' }),
    /must be valid URLs/,
  );
  await rejectsMessage(
    () => runManagedTestPreflight(contextFor({}), { baseURL: 'file:///tmp/canvas' }),
    /BASE_URL must use http or https/,
  );
  await rejectsMessage(
    () => runManagedTestPreflight(contextFor({ '/api/auth/get-session': response({}, 401) })),
    /session check returned 401/,
  );
  await rejectsMessage(
    () => runManagedTestPreflight(contextFor({ '/api/auth/get-session': response({ user: null }) })),
    /authenticated session is missing/,
  );
  await rejectsMessage(
    () => runManagedTestPreflight(contextFor({
      '/api/auth/get-session': response({ user: { id: 'user-1' } }),
      '/api/workspaces': response({ workspaces: [] }),
    }), { workspaceId: 'missing-workspace' }),
    /workspace fixture was not found/,
  );
  await rejectsMessage(
    () => runManagedTestPreflight(contextFor({
      '/api/auth/get-session': response({ user: { id: 'user-1' } }),
      '/api/workspaces': response({ workspaces: [{ id: 'workspace-1', permissions: { canRead: true, canWrite: false } }] }),
    }), { workspaceId: 'workspace-1', requireWorkspacePermission: 'write' }),
    /lacks write permission/,
  );
  await rejectsMessage(
    () => runManagedTestPreflight(contextFor({ '/api/auth/get-session': response({ user: { id: 'user-1' } }) }), {
      fixtureIdentity: '   ',
    }),
    /fixture identity is empty/,
  );

  const result = await runManagedTestPreflight(contextFor({
    '/api/auth/get-session': response({ user: { id: 'user-1' } }),
    '/api/workspaces': response({ workspaces: [{ id: 'workspace-1', permissions: { canRead: true, canWrite: true } }] }),
  }), {
    baseURL: 'http://canvas.test/',
    authOrigin: 'https://auth.canvas.test/',
    workspaceId: 'workspace-1',
    requireWorkspacePermission: 'write',
    fixtureIdentity: 'fvrc-1005',
    buildMarker: 'build-1',
    serverMarker: 'server-1',
  });
  assert.deepEqual(result, {
    baseURL: 'http://canvas.test',
    authOrigin: 'https://auth.canvas.test',
    workspaceId: 'workspace-1',
    requireWorkspacePermission: 'write',
    fixtureIdentity: 'fvrc-1005',
    buildMarker: 'build-1',
    serverMarker: 'server-1',
  });

  let throttledBodyReads = 0;
  const throttled = { ...response({}, 429), json: async () => {
    throttledBodyReads += 1;
    throw new Error('A throttled auth body must never be read.');
  } };
  await runManagedTestPreflight(contextFor({ '/api/auth/get-session': [throttled,
    response({ user: { id: 'user-1' } })] }));
  await rejectsMessage(() => runManagedTestPreflight(contextFor({ '/api/auth/get-session': throttled })),
    /session check failed \(429\)/);
  assert.equal(throttledBodyReads, 0);

  let boundedRequests = 0;
  const boundedRequest = { get: async (_url: string, options: { timeout: number }) => {
    boundedRequests += 1;
    assert.equal(options.timeout, 5_000);
    return response({ user: { id: 'user-1' } });
  } } as never;
  await requestManagedTestSession(boundedRequest, { requestTimeoutMs: 5_000 });
  for (const requestTimeoutMs of [0, -1, 15_001, Number.NaN]) {
    await rejectsMessage(() => requestManagedTestSession(boundedRequest, { requestTimeoutMs }), /between 1 and 15000ms/);
  }
  assert.equal(boundedRequests, 1, 'invalid request bounds must fail before transport');
}

async function authCacheRenewalCase(): Promise<void> {
  const baseURL = `http://managed-test-${process.pid}.test`;
  const email = `fvrc-${process.pid}@example.test`;
  const password = 'not-persisted';
  const credentialHash = createHash('sha256').update(password).digest('hex');
  const cacheDir = path.join(os.tmpdir(), 'canvas-playwright-auth');
  const cachePath = path.join(cacheDir, `${createHash('sha256').update(`${baseURL}\0${email}\0${credentialHash}`).digest('hex').slice(0, 24)}.json`);
  const wrongPassword = 'incorrect-fixture-password';
  const wrongCredentialHash = createHash('sha256').update(wrongPassword).digest('hex');
  const wrongCachePath = path.join(cacheDir, `${createHash('sha256').update(`${baseURL}\0${email}\0${wrongCredentialHash}`).digest('hex').slice(0, 24)}.json`);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath, '{not-json', 'utf8');
  let signIns = 0;
  let stateWrites = 0;
  let closedContexts = 0;
  let createdContexts = 0;
  let tamperContext = -1;
  let signInStatuses: number[] = [];
  let sessionStatuses: number[] = [];
  let sessionReads = 0;
  let throttledBodyReads = 0;
  let invalidJsonContext = -1;
  let failingCloseContext = -1;
  let failingTransportContext = -1;
  let advanceOnSessionContext = -1;
  let advanceOnSessionMs = 0;
  const sessionTimeouts: number[] = [];
  let retryAfter = '0';
  const browser = {
    newContext: async (options: { storageState?: string }) => {
      const contextNumber = ++createdContexts;
      let currentUser = options.storageState
        ? JSON.parse(await fs.readFile(options.storageState, 'utf8')).user
        : null;
      const request = {
        get: async (_url: string, input: { timeout: number }) => {
          assert.ok(input.timeout > 0 && input.timeout <= 15_000);
          sessionTimeouts.push(input.timeout);
          sessionReads += 1;
          if (contextNumber === failingTransportContext) throw new Error('Synthetic secret transport detail.');
          if (contextNumber === advanceOnSessionContext) controlledNow += advanceOnSessionMs;
          const status = sessionStatuses.shift() ?? 200;
          return { ...response({ user: contextNumber === tamperContext ? { id: 'wrong-user', email: 'other@example.test' } : currentUser }, status),
            headers: () => ({ 'x-retry-after': retryAfter }), json: async () => {
              if (status === 429) { throttledBodyReads += 1; throw new Error('A throttled auth body must never be read.'); }
              if (contextNumber === invalidJsonContext) throw new Error('Synthetic invalid session JSON.');
              return { user: contextNumber === tamperContext ? { id: 'wrong-user', email: 'other@example.test' } : currentUser };
            } };
        },
        post: async (_url: string, input: { data: { password: string }; timeout: number }) => {
          assert.ok(input.timeout > 0 && input.timeout <= 15_000, 'each real auth request must retain its bounded timeout');
          signIns += 1;
          const status = input.data.password !== password ? 401 : (signInStatuses.shift() ?? 200);
          if (status === 200) currentUser = { id: 'user-1', email };
          return { ...response({}, status), headers: () => ({ 'x-retry-after': retryAfter }) };
        },
      };
      return {
        request,
        cookies: async () => [{ name: 'fixture-auth', value: 'synthetic', domain: 'managed.test', path: '/' }],
        storageState: async ({ path: target }: { path: string }) => { stateWrites += 1; await fs.writeFile(target, JSON.stringify({ user: currentUser }), 'utf8'); },
        close: async () => {
          closedContexts += 1;
          if (contextNumber === failingCloseContext) throw new Error('Synthetic context close failure.');
        },
      };
    },
  } as never;
  const previousBaseURL = process.env.BASE_URL;
  const originalNow = Date.now;
  let controlledNow = originalNow();
  process.env.BASE_URL = baseURL;
  try {
    const context = await createAuthenticatedContext(browser, {}, { email, password });
    assert.equal(signIns, 1, 'corrupt cache must trigger exactly one sign-in');
    assert.equal(stateWrites, 1, 'renewed state must be written atomically');
    await context.close();

    const reused = await createAuthenticatedContext(browser, {}, { email, password });
    await reused.close();
    assert.equal(signIns, 1, 'an exact authenticated identity must reuse its private state');

    let beforeSignIns = signIns;
    let beforeContexts = createdContexts;
    let beforeSessionReads = sessionReads;
    let beforeWrites = stateWrites;
    const savedCache = await fs.readFile(cachePath, 'utf8');
    sessionStatuses = [429, 200];
    const throttledCache = await createAuthenticatedContext(browser, {}, { email, password });
    await throttledCache.close();
    assert.equal(signIns, beforeSignIns, 'temporary session throttling must not trigger sign-in');
    assert.equal(stateWrites, beforeWrites, 'temporary session throttling must not rewrite an exact cache');
    assert.equal(createdContexts, beforeContexts + 2, 'retry the session in the same verification context without taking the renewal lock');
    assert.equal(sessionReads, beforeSessionReads + 2);
    assert.equal(await fs.readFile(cachePath, 'utf8'), savedCache);

    sessionStatuses = [429, 429, 429];
    beforeSessionReads = sessionReads;
    await rejectsMessage(() => createAuthenticatedContext(browser, {}, { email, password }), /session check failed \(429\)/);
    assert.equal(sessionReads, beforeSessionReads + 3, 'session throttling stops after two retries');
    assert.equal(signIns, beforeSignIns, 'persistent session throttling must not attempt sign-in');
    assert.equal(await fs.readFile(cachePath, 'utf8'), savedCache);
    sessionStatuses = [429, 429, 429];
    failingCloseContext = createdContexts + 1;
    await rejectsAuthAndCleanup(() => createAuthenticatedContext(browser, {}, { email, password }), /session check failed \(429\)/);
    assert.equal(signIns, beforeSignIns);
    assert.equal(await fs.readFile(cachePath, 'utf8'), savedCache);
    failingCloseContext = -1;
    sessionStatuses = [];
    failingTransportContext = createdContexts + 1;
    beforeSessionReads = sessionReads;
    const beforeTransportClose = closedContexts;
    await assert.rejects(() => createAuthenticatedContext(browser, {}, { email, password }),
      (error: unknown) => error instanceof Error && /session check failed before receiving an HTTP response/.test(error.message)
        && !error.message.includes('Synthetic secret'));
    assert.equal(sessionReads, beforeSessionReads + 1, 'transport failures must never retry');
    assert.equal(signIns, beforeSignIns, 'transport failures must not trigger sign-in');
    assert.equal(closedContexts, beforeTransportClose + 1);
    assert.equal(await fs.readFile(cachePath, 'utf8'), savedCache);
    failingTransportContext = -1;
    sessionStatuses = [429];
    retryAfter = '60';
    await rejectsMessage(() => createAuthenticatedContext(browser, {}, { email, password }), /retry exceeds its bounded deadline/);
    assert.equal(signIns, beforeSignIns);
    retryAfter = '0';
    sessionStatuses = [];

    await rejectsMessage(() => createAuthenticatedContext(browser, {}, { email, password: wrongPassword }), /authentication failed \(401\)/);
    assert.equal(signIns, 2, 'incorrect credentials must perform a real failing login instead of reusing a valid cache');
    assert.equal(stateWrites, 1, 'incorrect credentials must never publish a cache');

    await fs.writeFile(cachePath, JSON.stringify({ user: { id: 'foreign-user', email: 'other@example.test' } }), 'utf8');
    const repaired = await createAuthenticatedContext(browser, {}, { email, password });
    await repaired.close();
    assert.equal(signIns, 3, 'a foreign cached identity must trigger a fresh verified sign-in');
    assert.equal(stateWrites, 2);

    let cookieTransfers = 0;
    const page = { context: () => ({ browser: () => browser, addCookies: async () => { cookieTransfers += 1; } }) } as never;
    const beforeClose = closedContexts;
    await authenticateManagedTestPage(page, { email, password });
    assert.equal(cookieTransfers, 1, 'the exact identity must transfer cookies into the existing page');
    assert.ok(closedContexts >= beforeClose + 2, 'cache validation and temporary auth context must both close');
    tamperContext = createdContexts + 2;
    const beforeFailureClose = closedContexts;
    await rejectsMessage(() => authenticateManagedTestPage(page, { email, password }), /session identity does not match/);
    assert.equal(cookieTransfers, 1, 'an incorrect temporary identity must not transfer cookies');
    assert.ok(closedContexts >= beforeFailureClose + 2, 'the rejected temporary auth context must close');
    tamperContext = -1;

    beforeContexts = createdContexts;
    sessionStatuses = [200, 429, 200];
    await authenticateManagedTestPage(page, { email, password });
    assert.equal(cookieTransfers, 2, 'page cookies transfer only after the session retry proves the exact identity');
    assert.equal(createdContexts, beforeContexts + 2);
    sessionStatuses = [200, 429, 429, 429];
    await rejectsMessage(() => authenticateManagedTestPage(page, { email, password }), /session check failed \(429\)/);
    assert.equal(cookieTransfers, 2, 'failed page verification must never transfer cookies');

    tamperContext = createdContexts + 2;
    failingCloseContext = tamperContext;
    await rejectsAuthAndCleanup(() => authenticateManagedTestPage(page, { email, password }), /session identity does not match/);
    assert.equal(cookieTransfers, 2);
    tamperContext = -1;
    failingCloseContext = -1;

    invalidJsonContext = createdContexts + 2;
    await rejectsMessage(() => authenticateManagedTestPage(page, { email, password }), /session check returned invalid JSON/);
    assert.equal(cookieTransfers, 2);
    invalidJsonContext = -1;

    Date.now = () => controlledNow;
    advanceOnSessionContext = createdContexts + 1;
    advanceOnSessionMs = 36_000;
    sessionStatuses = [200, 429];
    retryAfter = '10';
    await rejectsMessage(() => authenticateManagedTestPage(page, { email, password }), /retry exceeds its bounded deadline/);
    assert.ok(sessionTimeouts.at(-1)! <= 9_000, 'page verification must share the elapsed cache-check deadline');
    assert.equal(cookieTransfers, 2);
    Date.now = originalNow;
    advanceOnSessionContext = -1;
    retryAfter = '0';
    sessionStatuses = [];

    await fs.rm(cachePath);
    beforeSignIns = signIns;
    beforeWrites = stateWrites;
    sessionStatuses = [429, 200];
    const verifiedAfterLogin = await createAuthenticatedContext(browser, {}, { email, password });
    await verifiedAfterLogin.close();
    assert.equal(signIns, beforeSignIns + 1);
    assert.equal(stateWrites, beforeWrites + 1, 'post-login retries publish only verified state');
    await fs.rm(cachePath);
    sessionStatuses = [429, 429, 429];
    beforeWrites = stateWrites;
    await rejectsMessage(() => createAuthenticatedContext(browser, {}, { email, password }), /session check failed \(429\)/);
    assert.equal(stateWrites, beforeWrites);
    assert.equal(await fs.access(cachePath).then(() => true, () => false), false);
    sessionStatuses = [];
    invalidJsonContext = createdContexts + 1;
    await rejectsMessage(() => createAuthenticatedContext(browser, {}, { email, password }), /session check returned invalid JSON/);
    assert.equal(stateWrites, beforeWrites);
    invalidJsonContext = -1;
    tamperContext = createdContexts + 1;
    await rejectsMessage(() => createAuthenticatedContext(browser, {}, { email, password }), /session identity does not match/);
    assert.equal(stateWrites, beforeWrites);
    tamperContext = -1;

    tamperContext = createdContexts + 1;
    failingCloseContext = tamperContext;
    await rejectsAuthAndCleanup(() => createAuthenticatedContext(browser, {}, { email, password }), /session identity does not match/);
    assert.equal(stateWrites, beforeWrites);
    assert.equal(await fs.access(`${cachePath}.lock`).then(() => true, () => false), false,
      'context cleanup failure must still release the owned renewal lock');
    assert.deepEqual((await fs.readdir(cacheDir)).filter(name => name.startsWith(`${path.basename(cachePath)}.`)), [],
      'context cleanup failure must still remove its own temporary state files');
    tamperContext = -1;
    failingCloseContext = -1;
    assert.equal(throttledBodyReads, 0);

    beforeSignIns = signIns;
    signInStatuses = [429, 200];
    const retried = await createAuthenticatedContext(browser, {}, { email, password });
    await retried.close();
    assert.equal(signIns, beforeSignIns + 2, '429 may retry into a real verified successful login');

    await fs.rm(cachePath);
    beforeSignIns = signIns;
    signInStatuses = [429, 429, 429];
    await rejectsMessage(() => createAuthenticatedContext(browser, {}, { email, password }), /authentication failed \(429\)/);
    assert.equal(signIns, beforeSignIns + 3, '429 must stop after two retries');
    assert.equal(await fs.access(cachePath).then(() => true, () => false), false, 'failed retries must not publish a cache');

    beforeSignIns = signIns;
    signInStatuses = [429];
    retryAfter = '60';
    await rejectsMessage(() => createAuthenticatedContext(browser, {}, { email, password }), /retry exceeds its bounded deadline/);
    assert.equal(signIns, beforeSignIns + 1, 'a retry beyond the deadline must fail without another request');
  } finally {
    Date.now = originalNow;
    if (previousBaseURL === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previousBaseURL;
    for (const ownedPath of [cachePath, wrongCachePath]) {
      await fs.rm(ownedPath, { force: true });
      await fs.rm(`${ownedPath}.lock`, { force: true });
    }
  }
}

async function main(): Promise<void> {
  await preflightCases();
  await authCacheRenewalCase();
  console.log('managed-test-context-contract-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
