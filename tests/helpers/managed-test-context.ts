import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  APIRequestContext,
  APIResponse,
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Page,
} from '@playwright/test';

const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 100;
const LOCK_ATTEMPTS = 300;

export type AuthenticatedContextIdentity = {
  email?: string;
  password?: string;
};

export type ManagedTestPreflightOptions = {
  /** Optional values make the preflight opt-in and keep existing callers compatible. */
  baseURL?: string;
  authOrigin?: string;
  workspaceId?: string;
  requireWorkspacePermission?: 'read' | 'write';
  fixtureIdentity?: string;
  buildMarker?: string;
  serverMarker?: string;
};

export type ManagedTestPreflightResult = {
  baseURL: string;
  authOrigin: string;
  workspaceId?: string;
  requireWorkspacePermission?: 'read' | 'write';
  fixtureIdentity?: string;
  buildMarker?: string;
  serverMarker?: string;
};

type ResolvedIdentity = {
  email: string;
  password: string;
};

function resolveIdentity(identity: AuthenticatedContextIdentity = {}): ResolvedIdentity {
  const email = identity.email || process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = identity.password || process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email?.trim() || !password?.trim()) {
    throw new Error('Email and password must be configured for authenticated Playwright tests.');
  }
  return { email, password };
}

function authStatePath(identity: ResolvedIdentity): string {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const credentialHash = createHash('sha256').update(identity.password).digest('hex');
  const identityHash = createHash('sha256').update(`${baseUrl}\0${identity.email}\0${credentialHash}`).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), 'canvas-playwright-auth', `${identityHash}.json`);
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}

function authRequestTimeout(deadline: number, phase: string): number {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error(`${phase} exceeded its bounded deadline.`);
  return Math.min(15_000, remainingMs);
}

async function waitForAuthRetry(response: APIResponse, deadline: number, phase: string, retries: number): Promise<void> {
  const retryAfter = response.headers()['x-retry-after'] || response.headers()['retry-after'];
  const seconds = Number(retryAfter);
  const requestedMs = retryAfter && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1_000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 10_000;
  const waitMs = Math.max(1_000, Number.isFinite(requestedMs) ? requestedMs : 10_000);
  if (Date.now() + waitMs >= deadline) throw new Error(`${phase} failed (429): retry exceeds its bounded deadline.`);
  console.info(`[managed-test] ${phase} returned 429; waiting ${waitMs}ms before retry ${retries}/2.`);
  await sleep(waitMs);
}

/** Retry only throttled session transport; callers still verify the returned identity. */
export async function requestManagedTestSession(request: APIRequestContext, options: {
  url?: string;
  deadline?: number;
  requestTimeoutMs?: number;
  phase?: 'Playwright authentication' | 'Managed page authentication' | 'Managed test preflight' | 'Managed fixture identity';
} = {}): Promise<APIResponse> {
  const deadline = options.deadline ?? Date.now() + 45_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 15_000) {
    throw new Error('Managed session request timeout must be between 1 and 15000ms.');
  }
  const phase = options.phase ?? 'Playwright authentication';
  let retries = 0;
  while (true) {
    const response = await request.get(options.url ?? '/api/auth/get-session', {
      timeout: Math.min(requestTimeoutMs, authRequestTimeout(deadline, phase)),
    }).catch(() => { throw new Error(`${phase} session check failed before receiving an HTTP response.`); });
    if (response.status() !== 429) return response;
    if (retries >= 2) throw new Error(`${phase} session check failed (429).`);
    retries += 1;
    await waitForAuthRetry(response, deadline, `${phase} session check`, retries);
  }
}

async function withManagedAuthCleanup<T>(work: () => Promise<T>, cleanup: ReadonlyArray<() => Promise<unknown>>,
  phase: string): Promise<T> {
  let result!: T;
  let primaryError: unknown;
  let failed = false;
  try { result = await work(); } catch (error) { failed = true; primaryError = error; }
  const cleanupErrors: unknown[] = [];
  for (const finish of cleanup) {
    try { await finish(); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError(failed ? [primaryError, ...cleanupErrors] : cleanupErrors,
    `${phase} cleanup failed.`);
  if (failed) throw primaryError;
  return result;
}

async function removeAuthTemporaryPath(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
}

async function stateIsAuthorized(browser: Browser, storageStatePath: string, identity: ResolvedIdentity,
  deadline: number): Promise<boolean> {
  let context: BrowserContext;
  try {
    await fs.access(storageStatePath);
    context = await browser.newContext({
      baseURL: process.env.BASE_URL || 'http://localhost:3000',
      storageState: storageStatePath,
    });
  } catch {
    return false;
  }
  // Throttling, transport and deadline failures must not invalidate credentials or start a new login.
  return withManagedAuthCleanup(async () => {
    const response = await requestManagedTestSession(context.request, { deadline });
    if (response.status() !== 200) return false;
    const payload = await response.json().catch(() => null) as { user?: { id?: string; email?: string } | null } | null;
    return typeof payload?.user?.id === 'string' && payload.user.id.length > 0
      && payload.user.email === identity.email;
  }, [() => context.close()], 'Playwright cached authentication');
}

async function ensureAuthenticatedState(browser: Browser, identity: ResolvedIdentity, deadline: number): Promise<string> {
  const storageStatePath = authStatePath(identity);
  if (await stateIsAuthorized(browser, storageStatePath, identity, deadline)) return storageStatePath;
  await fs.mkdir(path.dirname(storageStatePath), { recursive: true, mode: 0o700 });
  const lockPath = `${storageStatePath}.lock`;

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    authRequestTimeout(deadline, 'Playwright authentication');
    let lock: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      lock = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockAge = await fs.stat(lockPath).then((stat) => Date.now() - stat.mtimeMs).catch(() => 0);
      if (lockAge > LOCK_STALE_MS) await fs.unlink(lockPath).catch(() => undefined);
      await sleep(Math.min(LOCK_WAIT_MS, deadline - Date.now()));
      if (await stateIsAuthorized(browser, storageStatePath, identity, deadline)) return storageStatePath;
      continue;
    }

    return withManagedAuthCleanup(async () => {
      if (await stateIsAuthorized(browser, storageStatePath, identity, deadline)) return storageStatePath;
      const baseURL = process.env.BASE_URL || 'http://localhost:3000';
      const context = await browser.newContext({ baseURL });
      const temporaryPath = `${storageStatePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await withManagedAuthCleanup(async () => {
        let retries = 0;
        while (true) {
          const response = await context.request.post('/api/auth/sign-in/email', {
            headers: { Origin: baseURL },
            data: {
              email: identity.email,
              password: identity.password,
            },
            timeout: authRequestTimeout(deadline, 'Playwright authentication'),
          }).catch(() => { throw new Error('Playwright authentication failed before receiving an HTTP response.'); });
          if (response.status() === 200) break;
          if (response.status() !== 429 || retries >= 2) {
            // Never include response bodies: auth endpoints can echo credentials or tokens.
            throw new Error(`Playwright authentication failed (${response.status()}).`);
          }
          retries += 1;
          await waitForAuthRetry(response, deadline, 'Playwright authentication', retries);
        }
        const sessionResponse = await requestManagedTestSession(context.request, { deadline });
        if (sessionResponse.status() !== 200) throw new Error(`Playwright authentication session check failed (${sessionResponse.status()}).`);
        const session = await sessionResponse.json()
          .catch(() => { throw new Error('Playwright authentication session check returned invalid JSON.'); }) as { user?: { id?: string; email?: string } | null } | null;
        if (typeof session?.user?.id !== 'string' || !session.user.id || session.user.email !== identity.email) {
          throw new Error('Playwright authentication session identity does not match the configured account.');
        }
        await context.storageState({ path: temporaryPath });
        await fs.chmod(temporaryPath, 0o600);
        await fs.rename(temporaryPath, storageStatePath);
      }, [() => context.close(), () => removeAuthTemporaryPath(temporaryPath)], 'Playwright authentication context');
      return storageStatePath;
    }, [() => lock!.close(), () => removeAuthTemporaryPath(lockPath)], 'Playwright authentication lock');
  }
  throw new Error('Timed out waiting for the shared Playwright authentication state.');
}

/**
 * Validate the managed test environment using an already authenticated context.
 * This is deliberately explicit: callers only get checks they requested, while
 * failures remain actionable and never disclose secrets.
 */
export async function runManagedTestPreflight(
  context: BrowserContext,
  options: ManagedTestPreflightOptions = {},
): Promise<ManagedTestPreflightResult> {
  const baseURL = options.baseURL || process.env.BASE_URL || 'http://localhost:3000';
  const authOrigin = options.authOrigin || process.env.AUTH_ORIGIN || baseURL;
  let parsedBase: URL;
  let parsedAuth: URL;
  try {
    parsedBase = new URL(baseURL);
    parsedAuth = new URL(authOrigin);
  } catch {
    throw new Error('Managed test preflight failed: BASE_URL/AUTH_ORIGIN must be valid URLs.');
  }
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    throw new Error('Managed test preflight failed: BASE_URL must use http or https.');
  }
  if (parsedAuth.protocol !== 'http:' && parsedAuth.protocol !== 'https:') {
    throw new Error('Managed test preflight failed: AUTH_ORIGIN must use http or https.');
  }

  const session = await requestManagedTestSession(context.request, {
    url: new URL('/api/auth/get-session', authOrigin).toString(), phase: 'Managed test preflight',
  });
  if (!session.ok()) throw new Error(`Managed test preflight failed: session check returned ${session.status()}.`);
  const sessionPayload = await session.json() as { user?: { id?: string } | null };
  if (!sessionPayload.user?.id) throw new Error('Managed test preflight failed: authenticated session is missing.');

  if (options.workspaceId) {
    const response = await context.request.get(new URL('/api/workspaces', baseURL).toString());
    if (!response.ok()) throw new Error(`Managed test preflight failed: workspace check returned ${response.status()}.`);
    const payload = await response.json() as { workspaces?: Array<{ id?: string; permissions?: { canRead?: boolean; canWrite?: boolean } }> };
    const workspace = payload.workspaces?.find((entry) => entry.id === options.workspaceId);
    if (!workspace) throw new Error('Managed test preflight failed: requested workspace fixture was not found.');
    const permission = options.requireWorkspacePermission || 'read';
    if (!workspace.permissions?.[permission === 'write' ? 'canWrite' : 'canRead']) {
      throw new Error(`Managed test preflight failed: workspace lacks ${permission} permission.`);
    }
  }

  const markerChecks: Array<[string, string | undefined]> = [
    ['fixture identity', options.fixtureIdentity],
    ['build marker', options.buildMarker],
    ['server marker', options.serverMarker],
  ];
  for (const [label, expected] of markerChecks) {
    if (expected !== undefined && !expected.trim()) throw new Error(`Managed test preflight failed: ${label} is empty.`);
  }
  const { baseURL: _baseURL, authOrigin: _authOrigin, ...resultOptions } = options;
  return {
    ...resultOptions,
    baseURL: parsedBase.toString().replace(/\/$/, ''),
    authOrigin: parsedAuth.toString().replace(/\/$/, ''),
  };
}

export const preflightManagedTestContext = runManagedTestPreflight;

async function createAuthenticatedContextBeforeDeadline(browser: Browser, options: BrowserContextOptions,
  identity: ResolvedIdentity, deadline: number): Promise<BrowserContext> {
  const storageState = await ensureAuthenticatedState(browser, identity, deadline);
  authRequestTimeout(deadline, 'Playwright authentication');
  return browser.newContext({
    ...options,
    baseURL: options.baseURL || process.env.BASE_URL || 'http://localhost:3000',
    storageState,
  });
}

export async function createAuthenticatedContext(
  browser: Browser,
  options: BrowserContextOptions = {},
  identityInput: AuthenticatedContextIdentity = {},
): Promise<BrowserContext> {
  return createAuthenticatedContextBeforeDeadline(browser, options, resolveIdentity(identityInput), Date.now() + 45_000);
}

/** Authenticate an existing page through the private, identity-checked test cache. */
export async function authenticateManagedTestPage(
  page: Page,
  identityInput: AuthenticatedContextIdentity = {},
): Promise<void> {
  const browser = page.context().browser();
  if (!browser) throw new Error('Managed page authentication requires a browser context.');
  const identity = resolveIdentity(identityInput);
  const deadline = Date.now() + 45_000;
  const authenticated = await createAuthenticatedContextBeforeDeadline(browser, {}, identity, deadline);
  await withManagedAuthCleanup(async () => {
    const response = await requestManagedTestSession(authenticated.request, { deadline, phase: 'Managed page authentication' });
    if (response.status() !== 200) throw new Error(`Managed page authentication session check failed (${response.status()}).`);
    const payload = await response.json()
      .catch(() => { throw new Error('Managed page authentication session check returned invalid JSON.'); }) as { user?: { id?: string; email?: string } | null } | null;
    if (typeof payload?.user?.id !== 'string' || !payload.user.id || payload.user.email !== identity.email) {
      throw new Error('Managed page authentication session identity does not match the configured account.');
    }
    await page.context().addCookies(await authenticated.cookies());
  }, [() => authenticated.close()], 'Managed page authentication');
}

export async function uploadWorkspaceTextFile(input: {
  request: APIRequestContext;
  workspaceId: string;
  filePath: string;
  content: string;
  mimeType?: string;
}): Promise<void> {
  const directory = path.posix.dirname(input.filePath);
  const response = await input.request.post('/api/files/upload', {
    headers: { [WORKSPACE_ID_HEADER]: input.workspaceId },
    multipart: {
      path: directory === '.' ? '.' : directory,
      files: {
        name: path.posix.basename(input.filePath),
        mimeType: input.mimeType || 'text/markdown',
        buffer: Buffer.from(input.content),
      },
    },
  });
  if (!response.ok()) {
    throw new Error(`Atomic workspace fixture upload failed (${response.status()}): ${await response.text()}`);
  }
}

export async function enterMarkdownEditMode(page: Page): Promise<void> {
  const editButton = page.getByRole('button', { name: /^(?:Edit|Bearbeiten)$/i }).first();
  await editButton.waitFor({ state: 'visible' });
  await editButton.click();
}
