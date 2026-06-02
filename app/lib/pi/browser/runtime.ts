import 'server-only';

import { existsSync, promises as fs } from 'node:fs';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';

import { buildBrowserLaunchSpec, resolveBrowserUserDataDir } from './chromium';
import { BrowserTargetStore } from './targets';
import type { BrowserStatusDetails, ConsoleEntry } from './types';

const DEFAULT_TIMEOUT_MS = 15_000;
export const IDLE_CLOSE_MS = 5 * 60 * 1000;
const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONCURRENT_BROWSER_PROFILES = parseInt(process.env.CANVAS_BROWSER_MAX_CONCURRENT_PROFILES || process.env.CANVAS_BROWSER_MAX_CONCURRENT_SESSIONS || '', 10) || 8;

export type BrowserRuntimeContext = {
  userId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
};

type BrowserProfileScope = 'agent' | 'session' | 'user';

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

async function ensureBrowser(context: BrowserRuntimeContext = {}): Promise<Browser> {
  const profile = getOrCreateProfileState(context);

  if (profile.browser?.connected) {
    scheduleIdleClose(context);
    return profile.browser;
  }

  if (profile.launchPromise) {
    return profile.launchPromise;
  }

  const userDataDir = resolveBrowserUserDataDir(process.env, existsSync, getProfileKey(context));
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
  session.activePage.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  session.activePage.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
  session.activePage.on('console', (message: ConsoleMessageLike) => {
    recordConsoleMessage(session, message);
  });
  session.activePage.on('close', () => {
    if (session.activePage?.isClosed()) {
      session.activePage = null;
      session.targetStore.clear();
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

  if (currentPage && !currentPage.isClosed()) {
    await currentPage.close().catch(() => undefined);
  }

  if (reason !== 'idle timeout') {
    session.consoleEntries.length = 0;
  }

  profile.sessions.delete(sessionKey);
  await closeProfileIfUnused(profileKey, profile);
}

export async function getStatusDetails(context: BrowserRuntimeContext = {}): Promise<BrowserStatusDetails> {
  const profile = browserProfiles.get(getProfileKey(context));
  if (!profile || !profile.browser?.connected) {
    return { running: false };
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
  };
}

export function getConsoleEntries(context: BrowserRuntimeContext = {}, limit: number): ConsoleEntry[] {
  const profile = browserProfiles.get(getProfileKey(context));
  const session = profile?.sessions.get(getSessionKey(context));
  if (!session) {
    return [];
  }
  return session.consoleEntries.slice(-limit);
}
