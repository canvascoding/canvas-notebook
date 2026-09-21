import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
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
  const cacheDir = path.join(os.tmpdir(), 'canvas-playwright-auth');
  const cachePath = path.join(cacheDir, `${createHash('sha256').update(`${baseURL}\0${email}`).digest('hex').slice(0, 24)}.json`);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath, '{not-json', 'utf8');
  let signIns = 0;
  let stateWrites = 0;
  const browser = {
    newContext: async (options: { storageState?: string }) => {
      const request = {
        get: async () => options.storageState === cachePath ? response({}, 200) : response({ user: { id: 'user-1' } }),
        post: async () => { signIns += 1; return response({ ok: true }); },
      };
      return {
        request,
        storageState: async ({ path: target }: { path: string }) => { stateWrites += 1; await fs.writeFile(target, '{}', 'utf8'); },
        close: async () => undefined,
      };
    },
  } as never;
  const previousBaseURL = process.env.BASE_URL;
  process.env.BASE_URL = baseURL;
  try {
    const context = await createAuthenticatedContext(browser, {}, { email, password: 'not-persisted' });
    assert.equal(signIns, 1, 'corrupt cache must trigger exactly one sign-in');
    assert.equal(stateWrites, 1, 'renewed state must be written atomically');
    await context.close();
  } finally {
    if (previousBaseURL === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previousBaseURL;
    await fs.rm(cachePath, { force: true });
    await fs.rm(`${cachePath}.lock`, { force: true });
  }
}

async function main(): Promise<void> {
  await preflightCases();
  await authCacheRenewalCase();
  console.log('managed-test-context-contract-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
