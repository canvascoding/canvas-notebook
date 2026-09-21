import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  APIRequestContext,
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
  const identityHash = createHash('sha256').update(`${baseUrl}\0${identity.email}`).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), 'canvas-playwright-auth', `${identityHash}.json`);
}

async function sleep(durationMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}

async function stateIsAuthorized(browser: Browser, storageStatePath: string): Promise<boolean> {
  try {
    await fs.access(storageStatePath);
    const context = await browser.newContext({
      baseURL: process.env.BASE_URL || 'http://localhost:3000',
      storageState: storageStatePath,
    });
    try {
      const response = await context.request.get('/api/auth/get-session');
      if (!response.ok()) return false;
      const payload = await response.json() as { user?: { id?: string } | null };
      return Boolean(payload.user?.id);
    } finally {
      await context.close();
    }
  } catch {
    return false;
  }
}

async function ensureAuthenticatedState(browser: Browser, identity: ResolvedIdentity): Promise<string> {
  const storageStatePath = authStatePath(identity);
  if (await stateIsAuthorized(browser, storageStatePath)) return storageStatePath;
  await fs.mkdir(path.dirname(storageStatePath), { recursive: true, mode: 0o700 });
  const lockPath = `${storageStatePath}.lock`;

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    let lock: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      lock = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockAge = await fs.stat(lockPath).then((stat) => Date.now() - stat.mtimeMs).catch(() => 0);
      if (lockAge > LOCK_STALE_MS) await fs.unlink(lockPath).catch(() => undefined);
      await sleep(LOCK_WAIT_MS);
      if (await stateIsAuthorized(browser, storageStatePath)) return storageStatePath;
      continue;
    }

    try {
      if (await stateIsAuthorized(browser, storageStatePath)) return storageStatePath;
      const baseURL = process.env.BASE_URL || 'http://localhost:3000';
      const context = await browser.newContext({ baseURL });
      const temporaryPath = `${storageStatePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        const response = await context.request.post('/api/auth/sign-in/email', {
          headers: { Origin: baseURL },
          data: {
            email: identity.email,
            password: identity.password,
          },
        });
        if (!response.ok()) {
          // Never include response bodies: auth endpoints can echo credentials or tokens.
          throw new Error(`Playwright authentication failed (${response.status()}).`);
        }
        await context.storageState({ path: temporaryPath });
        await fs.chmod(temporaryPath, 0o600);
        await fs.rename(temporaryPath, storageStatePath);
      } finally {
        await context.close();
        await fs.unlink(temporaryPath).catch(() => undefined);
      }
      return storageStatePath;
    } finally {
      await lock.close();
      await fs.unlink(lockPath).catch(() => undefined);
    }
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

  const session = await context.request.get(new URL('/api/auth/get-session', authOrigin).toString());
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

export async function createAuthenticatedContext(
  browser: Browser,
  options: BrowserContextOptions = {},
  identityInput: AuthenticatedContextIdentity = {},
): Promise<BrowserContext> {
  const storageState = await ensureAuthenticatedState(browser, resolveIdentity(identityInput));
  return browser.newContext({
    ...options,
    baseURL: options.baseURL || process.env.BASE_URL || 'http://localhost:3000',
    storageState,
  });
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
