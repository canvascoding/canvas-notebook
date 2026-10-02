import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  authenticateManagedTestPage,
  createAuthenticatedContext,
  runManagedTestPreflight,
} from '../tests/helpers/managed-test-context';

type Reply = { ok: () => boolean; status: () => number; json: () => Promise<unknown> };

function response(payload: unknown, status = 200): Reply {
  return { ok: () => status >= 200 && status < 300, status: () => status, json: async () => payload };
}

function requestFor(routes: Record<string, Reply>) {
  return { get: async (url: string) => routes[new URL(url).pathname] || response({}, 404) };
}

function contextFor(routes: Record<string, Reply>) {
  return { request: requestFor(routes) } as never;
}

async function rejectsMessage(action: () => Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof Error && message.test(error.message));
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
  let retryAfter = '0';
  const browser = {
    newContext: async (options: { storageState?: string }) => {
      const contextNumber = ++createdContexts;
      let currentUser = options.storageState
        ? JSON.parse(await fs.readFile(options.storageState, 'utf8')).user
        : null;
      const request = {
        get: async () => response({ user: contextNumber === tamperContext ? { id: 'wrong-user', email: 'other@example.test' } : currentUser }),
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
        close: async () => { closedContexts += 1; },
      };
    },
  } as never;
  const previousBaseURL = process.env.BASE_URL;
  process.env.BASE_URL = baseURL;
  try {
    const context = await createAuthenticatedContext(browser, {}, { email, password });
    assert.equal(signIns, 1, 'corrupt cache must trigger exactly one sign-in');
    assert.equal(stateWrites, 1, 'renewed state must be written atomically');
    await context.close();

    const reused = await createAuthenticatedContext(browser, {}, { email, password });
    await reused.close();
    assert.equal(signIns, 1, 'an exact authenticated identity must reuse its private state');
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

    await fs.rm(cachePath);
    let beforeSignIns = signIns;
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
