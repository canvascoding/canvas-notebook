import 'server-only';

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

import puppeteer, { type Browser, type Dialog, type HTTPRequest, type Page, type Target } from 'puppeteer-core';

import { requirePathInside } from '@/app/lib/security/safe-paths';

import { buildBrowserLaunchSpec, resolveBrowserUserDataDir } from './chromium';
import { BrowserTargetStore } from './targets';
import { isBrowserRequestUrlAllowed } from './url-policy';
import type {
  BrowserDialogDetails,
  BrowserProfileDetails,
  BrowserProfileScope,
  BrowserRuntimeTab,
  BrowserStatusDetails,
  ConsoleEntry,
} from './types';

const DEFAULT_TIMEOUT_MS = 15_000;
export const IDLE_CLOSE_MS = 5 * 60 * 1000;
const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONCURRENT_BROWSER_PROFILES = parseInt(process.env.CANVAS_BROWSER_MAX_CONCURRENT_PROFILES || process.env.CANVAS_BROWSER_MAX_CONCURRENT_SESSIONS || '', 10) || 8;

export type BrowserRuntimeContext = {
  userId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  workspaceId?: string | null;
  workspaceType?: string | null;
  organizationId?: string | null;
};

type BrowserProfileState = {
  browser: Browser | null;
  launchPromise: Promise<Browser> | null;
  sessions: Map<string, BrowserSessionState>;
};

type BrowserSessionState = {
  activePage: Page | null;
  pages: Map<string, Page>;
  nextTabId: number;
  idleTimer: NodeJS.Timeout | null;
  consoleEntries: ConsoleEntry[];
  targetStore: BrowserTargetStore;
  actionLock: Promise<void>;
  pendingDialog: {
    dialog: Dialog;
    details: BrowserDialogDetails;
  } | null;
};

type BrowserRuntimeGlobal = typeof globalThis & {
  __canvasBrowserProfilesV1?: Map<string, BrowserProfileState>;
};

// The custom WebSocket server and Next.js route handlers can load this module
// through separate bundle graphs in the same Node.js process. Keep the runtime
// registry process-global so status APIs and browser controls observe one state.
const runtimeGlobal = globalThis as BrowserRuntimeGlobal;
const browserProfiles = runtimeGlobal.__canvasBrowserProfilesV1 ?? new Map<string, BrowserProfileState>();
runtimeGlobal.__canvasBrowserProfilesV1 = browserProfiles;
const requestPolicyPages = new WeakSet<Page>();
const CHROME_PROFILE_STARTUP_ARTIFACTS = [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  'DevToolsActivePort',
] as const;

export type BrowserProfileLaunchPreparation = {
  removedArtifacts: string[];
  skippedActiveSingletonLock: boolean;
};

type ConsoleMessageLike = {
  type(): string;
  text(): string;
  location(): { url?: string; lineNumber?: number; columnNumber?: number };
};

function sanitizeScopeValue(value: string, fallback: string): string {
  const sanitized = value.trim().toLowerCase()
    .split('')
    .map((char) => /[a-z0-9._-]/u.test(char) ? char : '-')
    .join('')
    .slice(0, 96);
  const collapsed = sanitized.split('').reduce((next, char) => {
    if (char === '-' && next.endsWith('-')) return next;
    return `${next}${char}`;
  }, '');
  const trimmed = collapsed.split('').reduce((next, char, index, chars) => {
    if (char === '-' && (index === 0 || index === chars.length - 1)) return next;
    return `${next}${char}`;
  }, '');
  return trimmed || fallback;
}

function clampMaxConcurrent(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 8;
  }
  return Math.min(Math.max(Math.floor(value), 1), 200);
}

function getBrowserProfileScope(): BrowserProfileScope {
  const configured = process.env.CANVAS_BROWSER_PROFILE_SCOPE?.trim().toLowerCase();
  if (configured === 'session' || configured === 'user') {
    return configured;
  }
  return 'agent';
}

function getUserScope(context: BrowserRuntimeContext = {}): string {
  return sanitizeScopeValue(context.userId?.trim() || 'anon', 'anon');
}

function getAgentScope(context: BrowserRuntimeContext = {}): string {
  return sanitizeScopeValue(context.agentId?.trim() || 'default', 'default');
}

function getSessionScope(context: BrowserRuntimeContext = {}): string {
  return sanitizeScopeValue(context.sessionId?.trim() || 'shared', 'shared');
}

function getWorkspaceScope(context: BrowserRuntimeContext = {}): string | null {
  const workspaceId = context.workspaceId?.trim();
  if (!workspaceId) {
    return null;
  }
  return `ws-${sanitizeScopeValue(workspaceId, 'workspace')}`;
}

function appendWorkspaceScope(scopes: string[], context: BrowserRuntimeContext = {}): string[] {
  const workspaceScope = getWorkspaceScope(context);
  if (workspaceScope) {
    scopes.push(workspaceScope);
  }
  return scopes;
}

function getSessionKey(context: BrowserRuntimeContext = {}): string {
  return appendWorkspaceScope([
    getUserScope(context),
    getAgentScope(context),
  ], context).concat(getSessionScope(context)).join('__');
}

function getProfileKey(context: BrowserRuntimeContext = {}): string {
  const userId = getUserScope(context);
  const agentId = getAgentScope(context);
  const sessionId = getSessionScope(context);

  switch (getBrowserProfileScope()) {
    case 'session':
      return appendWorkspaceScope([userId, agentId], context).concat(sessionId).join('__');
    case 'user':
      return appendWorkspaceScope([userId], context).join('__');
    case 'agent':
    default:
      return appendWorkspaceScope([userId, agentId], context).join('__');
  }
}

export function getBrowserRuntimeContextKey(context: BrowserRuntimeContext = {}): string {
  return getSessionKey(context);
}

export function getBrowserProfileContextKey(context: BrowserRuntimeContext = {}): string {
  return getProfileKey(context);
}

function createSessionState(): BrowserSessionState {
  return {
    activePage: null,
    pages: new Map(),
    nextTabId: 1,
    idleTimer: null,
    consoleEntries: [],
    targetStore: new BrowserTargetStore(),
    actionLock: Promise.resolve(),
    pendingDialog: null,
  };
}

function getProfileUserDataDir(context: BrowserRuntimeContext = {}): string {
  const profileRoot = resolveBrowserUserDataDir(process.env, existsSync, getProfileKey(context));
  return requirePathInside(profileRoot, '.');
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function processExists(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function parseChromeSingletonPid(value: string): number | null {
  const match = /(?:^|[-_])(\d+)$/u.exec(path.basename(value.trim()));
  if (!match) {
    return null;
  }

  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

async function isStaleSingletonLock(lockPath: string): Promise<{ stale: boolean; activePid: number | null }> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(lockPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { stale: false, activePid: null };
    }
    throw error;
  }

  let lockReference = '';
  if (stat.isSymbolicLink()) {
    lockReference = await fs.readlink(lockPath).catch(() => '');
  } else if (stat.isFile()) {
    lockReference = await fs.readFile(lockPath, 'utf8').catch(() => '');
  }

  const pid = parseChromeSingletonPid(lockReference);
  if (pid && processExists(pid)) {
    return { stale: false, activePid: pid };
  }

  return { stale: true, activePid: pid };
}

async function removeProfileArtifact(userDataDir: string, artifact: string): Promise<boolean> {
  const artifactPath = requirePathInside(userDataDir, artifact);
  try {
    await fs.rm(artifactPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function prepareBrowserProfileForLaunch(userDataDir: string): Promise<BrowserProfileLaunchPreparation> {
  await fs.mkdir(userDataDir, { recursive: true });
  const removedArtifacts: string[] = [];
  const singletonLockPath = requirePathInside(userDataDir, 'SingletonLock');
  const singletonLock = await isStaleSingletonLock(singletonLockPath);

  if (singletonLock.stale) {
    for (const artifact of CHROME_PROFILE_STARTUP_ARTIFACTS) {
      if (await removeProfileArtifact(userDataDir, artifact)) {
        removedArtifacts.push(artifact);
      }
    }
  } else if (!singletonLock.activePid && await removeProfileArtifact(userDataDir, 'DevToolsActivePort')) {
    removedArtifacts.push('DevToolsActivePort');
  }

  return {
    removedArtifacts,
    skippedActiveSingletonLock: Boolean(singletonLock.activePid && !singletonLock.stale),
  };
}

function getOrCreateProfileState(context: BrowserRuntimeContext = {}): BrowserProfileState {
  const profileKey = getProfileKey(context);
  const existing = browserProfiles.get(profileKey);
  if (existing) {
    return existing;
  }

  const activeCount = Array.from(browserProfiles.values())
    .filter((item) => item.browser || item.launchPromise).length;
  const maxConcurrent = clampMaxConcurrent(MAX_CONCURRENT_BROWSER_PROFILES);
  if (activeCount >= maxConcurrent) {
    throw new Error(
      `Browser profile concurrency limit reached (${activeCount}/${maxConcurrent}). ` +
      'Close existing browser sessions with action: close.',
    );
  }

  const profile: BrowserProfileState = {
    browser: null,
    launchPromise: null,
    sessions: new Map(),
  };
  browserProfiles.set(profileKey, profile);
  return profile;
}

function getOrCreateSessionState(context: BrowserRuntimeContext = {}): BrowserSessionState {
  const profile = getOrCreateProfileState(context);
  const sessionKey = getSessionKey(context);
  const existing = profile.sessions.get(sessionKey);
  if (existing) {
    return existing;
  }

  const session = createSessionState();
  profile.sessions.set(sessionKey, session);
  return session;
}

export function getTargetStore(context: BrowserRuntimeContext = {}): BrowserTargetStore {
  return getOrCreateSessionState(context).targetStore;
}

export async function withBrowserRuntimeLock<T>(
  context: BrowserRuntimeContext = {},
  fn: () => Promise<T>,
): Promise<T> {
  const session = getOrCreateSessionState(context);
  const previousLock = session.actionLock;
  let releaseCurrentLock: () => void = () => undefined;
  const currentLock = new Promise<void>((resolve) => {
    releaseCurrentLock = resolve;
  });

  session.actionLock = previousLock.then(() => currentLock, () => currentLock);
  await previousLock.catch(() => undefined);

  try {
    return await fn();
  } finally {
    releaseCurrentLock();
  }
}

export function scheduleIdleClose(context: BrowserRuntimeContext = {}): void {
  const session = getOrCreateSessionState(context);

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
  }
  session.idleTimer = setTimeout(() => {
    void closeBrowserRuntime(context, 'idle timeout');
  }, IDLE_CLOSE_MS);
  session.idleTimer.unref?.();
}

function recordConsoleMessage(session: BrowserSessionState, message: ConsoleMessageLike): void {
  const location = message.location();
  const renderedLocation = location.url
    ? `${location.url}${location.lineNumber !== undefined ? `:${location.lineNumber}` : ''}`
    : undefined;
  session.consoleEntries.push({
    level: message.type(),
    text: message.text(),
    location: renderedLocation,
    timestamp: new Date().toISOString(),
  });
  if (session.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
    session.consoleEntries.splice(0, session.consoleEntries.length - MAX_CONSOLE_ENTRIES);
  }
}

function findSessionTabId(session: BrowserSessionState, page: Page): string | null {
  for (const [tabId, candidate] of session.pages) {
    if (candidate === page) return tabId;
  }
  return null;
}

function bindSessionPage(session: BrowserSessionState, page: Page): string {
  const existingTabId = findSessionTabId(session, page);
  if (existingTabId) return existingTabId;

  const tabId = `tab-${session.nextTabId++}`;
  session.pages.set(tabId, page);
  page.on('console', (message: ConsoleMessageLike) => {
    recordConsoleMessage(session, message);
  });
  page.on('dialog', (dialog: Dialog) => {
    session.pendingDialog = {
      dialog,
      details: {
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
        openedAt: new Date().toISOString(),
      },
    };
  });
  page.on('popup', (popup: Page | null) => {
    if (!popup) return;
    void configureRequestPolicy(popup).then(() => {
      popup.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
      popup.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
      bindSessionPage(session, popup);
      session.activePage = popup;
    }).catch(() => {
      void popup.close().catch(() => undefined);
    });
  });
  page.on('close', () => {
    session.pages.delete(tabId);
    if (session.activePage === page) {
      session.activePage = Array.from(session.pages.values()).find((candidate) => !candidate.isClosed()) ?? null;
    }
    session.targetStore.clear();
    session.pendingDialog = null;
  });
  return tabId;
}

async function closeProfileIfUnused(profileKey: string, profile: BrowserProfileState): Promise<void> {
  if (profile.sessions.size > 0) {
    return;
  }

  const currentBrowser = profile.browser;
  profile.browser = null;
  profile.launchPromise = null;
  browserProfiles.delete(profileKey);

  if (currentBrowser?.connected) {
    await currentBrowser.close().catch(() => undefined);
  }
}

async function configureRequestPolicy(page: Page): Promise<void> {
  if (requestPolicyPages.has(page)) return;
  requestPolicyPages.add(page);
  await page.setRequestInterception(true).catch(() => undefined);
  page.on('request', (request: HTTPRequest) => {
    void (async () => {
      const handled = (request as HTTPRequest & { isInterceptResolutionHandled?: () => boolean }).isInterceptResolutionHandled?.();
      if (handled) return;

      const resourceType = request.resourceType();
      const lookupDns = request.isNavigationRequest() || resourceType === 'document' || resourceType === 'xhr' || resourceType === 'fetch';
      const result = await isBrowserRequestUrlAllowed(request.url(), { lookupDns }).catch((error) => ({
        allowed: false,
        url: request.url(),
        hostname: null,
        category: 'policy-error',
        reason: error instanceof Error ? error.message : 'Browser request URL policy failed.',
      }));

      if (!result.allowed) {
        await request.abort('blockedbyclient').catch(() => undefined);
        return;
      }

      await request.continue().catch(() => undefined);
    })();
  });
}

function bindCreatedTargetToSession(profile: BrowserProfileState, target: Target): void {
  const opener = target.opener();
  if (!opener || target.type() !== 'page') return;
  const session = Array.from(profile.sessions.values()).find((candidate) => (
    Array.from(candidate.pages.values()).some((page) => page.target() === opener)
  ));
  if (!session) return;

  void target.page().then(async (page) => {
    if (!page) return;
    await configureRequestPolicy(page);
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
    bindSessionPage(session, page);
    session.activePage = page;
  }).catch(() => undefined);
}

async function ensureBrowser(context: BrowserRuntimeContext = {}): Promise<Browser> {
  const profile = getOrCreateProfileState(context);

  if (profile.browser?.connected) {
    scheduleIdleClose(context);
    return profile.browser;
  }

  if (profile.launchPromise) {
    return profile.launchPromise;
  }

  const userDataDir = getProfileUserDataDir(context);
  const launchSpec = buildBrowserLaunchSpec({ userDataDir });
  const preparation = await prepareBrowserProfileForLaunch(launchSpec.userDataDir);
  if (preparation.removedArtifacts.length > 0) {
    console.info('[BrowserRuntime] Removed stale Chromium profile startup artifacts before launch:', {
      profileKey: getProfileKey(context),
      removedArtifacts: preparation.removedArtifacts,
    });
  }

  profile.launchPromise = puppeteer.launch({
    executablePath: launchSpec.executablePath,
    headless: launchSpec.headless,
    args: launchSpec.args,
    pipe: launchSpec.pipe,
    defaultViewport: { width: 1280, height: 800 },
  }).then((launchedBrowser) => {
    profile.browser = launchedBrowser;
    profile.browser.on('targetcreated', (target) => bindCreatedTargetToSession(profile, target));
    profile.browser.on('disconnected', () => {
      profile.browser = null;
      for (const session of profile.sessions.values()) {
        session.activePage = null;
        session.pages.clear();
        session.targetStore.clear();
      }
    });
    scheduleIdleClose(context);
    return launchedBrowser;
  }).finally(() => {
    profile.launchPromise = null;
  });

  return profile.launchPromise;
}

export async function ensurePage(context: BrowserRuntimeContext = {}): Promise<Page> {
  const session = getOrCreateSessionState(context);
  const browser = await ensureBrowser(context);
  if (session.activePage && !session.activePage.isClosed()) {
    return session.activePage;
  }

  session.activePage = await browser.newPage();
  await configureRequestPolicy(session.activePage);
  session.activePage.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  session.activePage.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
  bindSessionPage(session, session.activePage);

  return session.activePage;
}

export async function getBrowserRuntimeTabs(
  context: BrowserRuntimeContext = {},
): Promise<BrowserRuntimeTab[]> {
  const profile = browserProfiles.get(getProfileKey(context));
  const session = profile?.sessions.get(getSessionKey(context));
  if (!session) return [];

  const tabs = await Promise.all(Array.from(session.pages.entries()).map(async ([id, page]) => {
    if (page.isClosed()) return null;
    return {
      id,
      title: await page.title().catch(() => ''),
      url: page.url(),
      active: session.activePage === page,
    } satisfies BrowserRuntimeTab;
  }));
  return tabs.filter((tab): tab is BrowserRuntimeTab => Boolean(tab));
}

export function getActiveBrowserRuntimeTabId(context: BrowserRuntimeContext = {}): string | null {
  const profile = browserProfiles.get(getProfileKey(context));
  const session = profile?.sessions.get(getSessionKey(context));
  if (!session?.activePage) return null;
  return findSessionTabId(session, session.activePage);
}

export async function activateBrowserRuntimeTab(
  context: BrowserRuntimeContext = {},
  tabId: string,
): Promise<Page> {
  const session = getOrCreateSessionState(context);
  const page = session.pages.get(tabId);
  if (!page || page.isClosed()) {
    throw new Error('Browser tab is no longer available.');
  }
  session.activePage = page;
  session.targetStore.clear();
  scheduleIdleClose(context);
  return page;
}

export async function createBrowserRuntimeTab(
  context: BrowserRuntimeContext = {},
): Promise<Page> {
  const session = getOrCreateSessionState(context);
  const browser = await ensureBrowser(context);
  const page = await browser.newPage();
  await configureRequestPolicy(page);
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
  bindSessionPage(session, page);
  session.activePage = page;
  session.targetStore.clear();
  scheduleIdleClose(context);
  return page;
}

export async function closeActiveBrowserRuntimeTab(
  context: BrowserRuntimeContext = {},
): Promise<Page> {
  const session = getOrCreateSessionState(context);
  const activePage = session.activePage;
  if (activePage && !activePage.isClosed()) {
    const tabId = findSessionTabId(session, activePage);
    if (tabId) session.pages.delete(tabId);
    session.activePage = Array.from(session.pages.values()).find((candidate) => !candidate.isClosed()) ?? null;
    await activePage.close().catch(() => undefined);
  }
  session.targetStore.clear();
  const nextPage = await ensurePage(context);
  scheduleIdleClose(context);
  return nextPage;
}

export async function closeBrowserRuntime(
  context: BrowserRuntimeContext = {},
  reason: string,
): Promise<void> {
  const profileKey = getProfileKey(context);
  const sessionKey = getSessionKey(context);
  const profile = browserProfiles.get(profileKey);
  const session = profile?.sessions.get(sessionKey);
  if (!profile || !session) {
    return;
  }

  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  const pages = Array.from(session.pages.values());
  session.activePage = null;
  session.pages.clear();
  session.targetStore.clear();
  session.pendingDialog = null;

  for (const page of pages) {
    if (!page.isClosed()) {
      await page.close().catch(() => undefined);
    }
  }

  if (reason !== 'idle timeout') {
    session.consoleEntries.length = 0;
  }

  profile.sessions.delete(sessionKey);
  await closeProfileIfUnused(profileKey, profile);
}

export async function resetBrowserSessionPage(
  context: BrowserRuntimeContext = {},
): Promise<boolean> {
  const profile = browserProfiles.get(getProfileKey(context));
  const session = profile?.sessions.get(getSessionKey(context));
  const currentPage = session?.activePage;
  if (!session || !currentPage) {
    return false;
  }

  session.activePage = null;
  const activeTabId = findSessionTabId(session, currentPage);
  if (activeTabId) session.pages.delete(activeTabId);
  session.targetStore.clear();
  session.pendingDialog = null;

  if (currentPage.isClosed()) {
    return true;
  }

  let timeoutId: NodeJS.Timeout | null = null;
  await Promise.race([
    currentPage.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, 2_000);
      timeoutId.unref?.();
    }),
  ]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });

  return true;
}

export async function getStatusDetails(context: BrowserRuntimeContext = {}): Promise<BrowserStatusDetails> {
  const profile = browserProfiles.get(getProfileKey(context));
  if (!profile || !profile.browser?.connected) {
    return { running: false, pendingDialog: null };
  }

  const session = profile.sessions.get(getSessionKey(context));
  const pages = await profile.browser.pages().catch(() => []);
  const page = session?.activePage && !session.activePage.isClosed() ? session.activePage : null;
  return {
    running: true,
    pageCount: pages.length,
    activeUrl: page?.url() || null,
    activeTitle: page ? await page.title().catch(() => null) : null,
    idleCloseMs: IDLE_CLOSE_MS,
    pendingDialog: session?.pendingDialog?.details ?? null,
  };
}

export async function getBrowserProfileDetails(context: BrowserRuntimeContext = {}): Promise<BrowserProfileDetails> {
  const profileKey = getProfileKey(context);
  const sessionKey = getSessionKey(context);
  const userDataDir = getProfileUserDataDir(context);
  const profile = browserProfiles.get(profileKey);
  const session = profile?.sessions.get(sessionKey);
  const running = Boolean(profile?.browser?.connected);
  const pages = profile?.browser?.connected ? await profile.browser.pages().catch(() => []) : [];
  const page = session?.activePage && !session.activePage.isClosed() ? session.activePage : null;

  return {
    scope: getBrowserProfileScope(),
    profileKey,
    sessionKey,
    userDataDir,
    workspaceId: context.workspaceId ?? null,
    workspaceType: context.workspaceType ?? null,
    organizationId: context.organizationId ?? null,
    profileDirExists: existsSync(userDataDir),
    running,
    sessionRunning: Boolean(running && page),
    activeSessionCount: profile?.sessions.size ?? 0,
    pageCount: running ? pages.length : undefined,
    activeUrl: page?.url() || null,
    activeTitle: page ? await page.title().catch(() => null) : null,
    idleCloseMs: IDLE_CLOSE_MS,
    pendingDialog: session?.pendingDialog?.details ?? null,
  };
}

export async function deleteBrowserProfile(context: BrowserRuntimeContext = {}): Promise<BrowserProfileDetails> {
  const profileKey = getProfileKey(context);
  const userDataDir = getProfileUserDataDir(context);
  const profile = browserProfiles.get(profileKey);

  if (profile) {
    for (const session of profile.sessions.values()) {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
      session.targetStore.clear();
      session.consoleEntries.length = 0;
      session.pendingDialog = null;
      const pages = Array.from(session.pages.values());
      session.activePage = null;
      session.pages.clear();
      for (const page of pages) {
        if (!page.isClosed()) {
          await page.close().catch(() => undefined);
        }
      }
    }

    const browser = profile.browser;
    profile.browser = null;
    profile.launchPromise = null;
    profile.sessions.clear();
    browserProfiles.delete(profileKey);
    if (browser?.connected) {
      await browser.close().catch(() => undefined);
    }
  }

  await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(path.dirname(userDataDir), { recursive: true }).catch(() => undefined);
  return getBrowserProfileDetails(context);
}

export function getPendingDialogDetails(context: BrowserRuntimeContext = {}): BrowserDialogDetails | null {
  const profile = browserProfiles.get(getProfileKey(context));
  const session = profile?.sessions.get(getSessionKey(context));
  return session?.pendingDialog?.details ?? null;
}

export async function acceptPendingDialog(context: BrowserRuntimeContext = {}, promptText?: string): Promise<BrowserDialogDetails | null> {
  const profile = browserProfiles.get(getProfileKey(context));
  const session = profile?.sessions.get(getSessionKey(context));
  const pending = session?.pendingDialog;
  if (!pending) {
    return null;
  }
  session.pendingDialog = null;
  await pending.dialog.accept(promptText).catch((error) => {
    throw new Error(error instanceof Error ? error.message : 'Failed to accept browser dialog.');
  });
  return pending.details;
}

export async function dismissPendingDialog(context: BrowserRuntimeContext = {}): Promise<BrowserDialogDetails | null> {
  const profile = browserProfiles.get(getProfileKey(context));
  const session = profile?.sessions.get(getSessionKey(context));
  const pending = session?.pendingDialog;
  if (!pending) {
    return null;
  }
  session.pendingDialog = null;
  await pending.dialog.dismiss().catch((error) => {
    throw new Error(error instanceof Error ? error.message : 'Failed to dismiss browser dialog.');
  });
  return pending.details;
}

export function getConsoleEntries(context: BrowserRuntimeContext = {}, limit: number): ConsoleEntry[] {
  const profile = browserProfiles.get(getProfileKey(context));
  const session = profile?.sessions.get(getSessionKey(context));
  if (!session) {
    return [];
  }
  return session.consoleEntries.slice(-limit);
}
