import 'server-only';

import { existsSync, promises as fs } from 'node:fs';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';

import { buildBrowserLaunchSpec, resolveBrowserUserDataDir } from './chromium';
import { BrowserTargetStore } from './targets';
import type { BrowserStatusDetails, ConsoleEntry } from './types';

const DEFAULT_TIMEOUT_MS = 15_000;
export const IDLE_CLOSE_MS = 5 * 60 * 1000;
const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONCURRENT_BROWSER_RUNTIMES = parseInt(process.env.CANVAS_BROWSER_MAX_CONCURRENT_SESSIONS || '', 10) || 8;

export type BrowserRuntimeContext = {
  userId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
};

type RuntimeState = {
  browser: Browser | null;
  activePage: Page | null;
  launchPromise: Promise<Browser> | null;
  idleTimer: NodeJS.Timeout | null;
  consoleEntries: ConsoleEntry[];
  targetStore: BrowserTargetStore;
  actionLock: Promise<void>;
};

const browserRuntimes = new Map<string, RuntimeState>();

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

function getRuntimeKey(context: BrowserRuntimeContext = {}): string {
  const userId = sanitizeScopeValue(context.userId?.trim() || 'anon', 'anon');
  const agentId = sanitizeScopeValue(context.agentId?.trim() || 'default', 'default');
  const sessionId = sanitizeScopeValue(context.sessionId?.trim() || 'shared', 'shared');
  return `${userId}__${agentId}__${sessionId}`;
}

export function getBrowserRuntimeContextKey(context: BrowserRuntimeContext = {}): string {
  return getRuntimeKey(context);
}

function getOrCreateRuntimeState(context: BrowserRuntimeContext = {}): RuntimeState {
  const key = getRuntimeKey(context);
  const existing = browserRuntimes.get(key);
  if (existing) {
    return existing;
  }

  const activeCount = Array.from(browserRuntimes.values())
    .filter((item) => item.browser || item.launchPromise).length;
  const maxConcurrent = clampMaxConcurrent(MAX_CONCURRENT_BROWSER_RUNTIMES);
  if (activeCount >= maxConcurrent) {
    throw new Error(
      `Browser concurrency limit reached (${activeCount}/${maxConcurrent}). ` +
      'Close existing browser sessions with action: close.',
    );
  }

  const state: RuntimeState = {
    browser: null,
    activePage: null,
    launchPromise: null,
    idleTimer: null,
    consoleEntries: [],
    targetStore: new BrowserTargetStore(),
    actionLock: Promise.resolve(),
  };
  browserRuntimes.set(key, state);
  return state;
}

export function getTargetStore(context: BrowserRuntimeContext = {}): BrowserTargetStore {
  return getOrCreateRuntimeState(context).targetStore;
}

export async function withBrowserRuntimeLock<T>(
  context: BrowserRuntimeContext = {},
  fn: () => Promise<T>,
): Promise<T> {
  const state = getOrCreateRuntimeState(context);
  const previousLock = state.actionLock;
  let releaseCurrentLock: () => void = () => undefined;
  const currentLock = new Promise<void>((resolve) => {
    releaseCurrentLock = resolve;
  });

  state.actionLock = previousLock.then(() => currentLock, () => currentLock);
  await previousLock.catch(() => undefined);

  try {
    return await fn();
  } finally {
    releaseCurrentLock();
  }
}

function clearTargetStore(context: BrowserRuntimeContext = {}): void {
  const state = browserRuntimes.get(getRuntimeKey(context));
  state?.targetStore.clear();
}

export function scheduleIdleClose(context: BrowserRuntimeContext = {}): void {
  const state = getOrCreateRuntimeState(context);

  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
  }
  state.idleTimer = setTimeout(() => {
    void closeBrowserRuntime(context, 'idle timeout');
  }, IDLE_CLOSE_MS);
  state.idleTimer.unref?.();
}

function recordConsoleMessage(state: RuntimeState, message: ConsoleMessageLike): void {
  const location = message.location();
  const renderedLocation = location.url
    ? `${location.url}${location.lineNumber !== undefined ? `:${location.lineNumber}` : ''}`
    : undefined;
  state.consoleEntries.push({
    level: message.type(),
    text: message.text(),
    location: renderedLocation,
    timestamp: new Date().toISOString(),
  });
  if (state.consoleEntries.length > MAX_CONSOLE_ENTRIES) {
    state.consoleEntries.splice(0, state.consoleEntries.length - MAX_CONSOLE_ENTRIES);
  }
}

async function ensureBrowser(context: BrowserRuntimeContext = {}): Promise<Browser> {
  const state = getOrCreateRuntimeState(context);

  if (state.browser?.connected) {
    scheduleIdleClose(context);
    return state.browser;
  }

  if (state.launchPromise) {
    return state.launchPromise;
  }

  const userDataDir = resolveBrowserUserDataDir(process.env, existsSync, getRuntimeKey(context));
  const launchSpec = buildBrowserLaunchSpec({ userDataDir });
  await fs.mkdir(launchSpec.userDataDir, { recursive: true });

  state.launchPromise = puppeteer.launch({
    executablePath: launchSpec.executablePath,
    headless: launchSpec.headless,
    args: launchSpec.args,
    defaultViewport: { width: 1280, height: 800 },
  }).then((launchedBrowser) => {
    state.browser = launchedBrowser;
    state.browser.on('disconnected', () => {
      state.browser = null;
      state.activePage = null;
    });
    scheduleIdleClose(context);
    return launchedBrowser;
  }).finally(() => {
    state.launchPromise = null;
  });

  return state.launchPromise;
}

export async function ensurePage(context: BrowserRuntimeContext = {}): Promise<Page> {
  const state = getOrCreateRuntimeState(context);
  const b = await ensureBrowser(context);
  if (state.activePage && !state.activePage.isClosed()) {
    return state.activePage;
  }

  const pages = await b.pages();
  state.activePage = pages.find((page) => !page.isClosed()) || await b.newPage();
  state.activePage.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  state.activePage.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
  state.activePage.on('console', (message: ConsoleMessageLike) => {
    recordConsoleMessage(state, message);
  });

  for (const page of pages) {
    if (page !== state.activePage && !page.isClosed()) {
      await page.close().catch(() => undefined);
    }
  }

  return state.activePage;
}

export async function closeBrowserRuntime(
  context: BrowserRuntimeContext = {},
  reason: string,
): Promise<void> {
  const key = getRuntimeKey(context);
  const state = browserRuntimes.get(key);
  if (!state) {
    return;
  }

  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }

  const currentBrowser = state.browser;
  state.browser = null;
  state.activePage = null;
  state.launchPromise = null;
  clearTargetStore(context);

  if (currentBrowser?.connected) {
    await currentBrowser.close().catch(() => undefined);
  }

  if (reason !== 'idle timeout') {
    state.consoleEntries.length = 0;
  }

  browserRuntimes.delete(key);
}

export async function getStatusDetails(context: BrowserRuntimeContext = {}): Promise<BrowserStatusDetails> {
  const state = browserRuntimes.get(getRuntimeKey(context));
  if (!state || !state.browser?.connected) {
    return { running: false };
  }

  const pages = await state.browser.pages().catch(() => []);
  const page = state.activePage && !state.activePage.isClosed() ? state.activePage : pages[0];
  return {
    running: true,
    pageCount: pages.length,
    activeUrl: page?.url() || null,
    activeTitle: page ? await page.title().catch(() => null) : null,
    idleCloseMs: IDLE_CLOSE_MS,
  };
}

export function getConsoleEntries(context: BrowserRuntimeContext = {}, limit: number): ConsoleEntry[] {
  const state = browserRuntimes.get(getRuntimeKey(context));
  if (!state) {
    return [];
  }
  return state.consoleEntries.slice(-limit);
}
