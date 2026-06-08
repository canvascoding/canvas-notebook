import 'server-only';

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

import puppeteer, { type Browser, type Dialog, type HTTPRequest, type Page } from 'puppeteer-core';

import { buildBrowserLaunchSpec, resolveBrowserUserDataDir } from './chromium';
import { BrowserTargetStore } from './targets';
import { isBrowserRequestUrlAllowed } from './url-policy';
import type { BrowserDialogDetails, BrowserProfileDetails, BrowserProfileScope, BrowserStatusDetails, ConsoleEntry } from './types';

const DEFAULT_TIMEOUT_MS = 15_000;
export const IDLE_CLOSE_MS = 5 * 60 * 1000;
const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONCURRENT_BROWSER_PROFILES = parseInt(process.env.CANVAS_BROWSER_MAX_CONCURRENT_PROFILES || process.env.CANVAS_BROWSER_MAX_CONCURRENT_SESSIONS || '', 10) || 8;

export type BrowserRuntimeContext = {
  userId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
};

type BrowserProfileState = {
  browser: Browser | null;
  launchPromise: Promise<Browser> | null;
  sessions: Map<string, BrowserSessionState>;
};

type BrowserSessionState = {
  activePage: Page | null;
  idleTimer: NodeJS.Timeout | null;
  consoleEntries: ConsoleEntry[];
  targetStore: BrowserTargetStore;
  actionLock: Promise<void>;
  pendingDialog: {
    dialog: Dialog;
    details: BrowserDialogDetails;
  } | null;
};

const browserProfiles = new Map<string, BrowserProfileState>();

type ConsoleMessageLike = {
  type(): string;
  text(): string;
  location(): { url?: string; lineNumber?: number; columnNumber?: number };
};

function sanitizeScopeValue(value: string, fallback: string): string {
  return value.trim().toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || fallback;
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

function getSessionKey(context: BrowserRuntimeContext = {}): string {
  return `${getUserScope(context)}__${getAgentScope(context)}__${getSessionScope(context)}`;
}

function getProfileKey(context: BrowserRuntimeContext = {}): string {
  const userId = getUserScope(context);
  const agentId = getAgentScope(context);
  const sessionId = getSessionScope(context);

  switch (getBrowserProfileScope()) {
    case 'session':
      return `${userId}__${agentId}__${sessionId}`;
    case 'user':
      return `${userId}`;
    case 'agent':
    default:
      return `${userId}__${agentId}`;
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
    idleTimer: null,
    consoleEntries: [],
    targetStore: new BrowserTargetStore(),
    actionLock: Promise.resolve(),
    pendingDialog: null,
  };
}

function getProfileUserDataDir(context: BrowserRuntimeContext = {}): string {
  return resolveBrowserUserDataDir(process.env, existsSync, getProfileKey(context));
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
  await fs.mkdir(launchSpec.userDataDir, { recursive: true });

  profile.launchPromise = puppeteer.launch({
    executablePath: launchSpec.executablePath,
    headless: launchSpec.headless,
    args: launchSpec.args,
    defaultViewport: { width: 1280, height: 800 },
  }).then((launchedBrowser) => {
    profile.browser = launchedBrowser;
    profile.browser.on('disconnected', () => {
      profile.browser = null;
      for (const session of profile.sessions.values()) {
        session.activePage = null;
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
  session.activePage.on('console', (message: ConsoleMessageLike) => {
    recordConsoleMessage(session, message);
  });
  session.activePage.on('dialog', (dialog: Dialog) => {
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
  session.activePage.on('close', () => {
    if (session.activePage?.isClosed()) {
      session.activePage = null;
      session.targetStore.clear();
      session.pendingDialog = null;
    }
  });

  return session.activePage;
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

  const currentPage = session.activePage;
  session.activePage = null;
  session.targetStore.clear();
  session.pendingDialog = null;

  if (currentPage && !currentPage.isClosed()) {
    await currentPage.close().catch(() => undefined);
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
    profileDirExists: existsSync(userDataDir),
    running,
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
      const page = session.activePage;
      session.activePage = null;
      if (page && !page.isClosed()) {
        await page.close().catch(() => undefined);
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
