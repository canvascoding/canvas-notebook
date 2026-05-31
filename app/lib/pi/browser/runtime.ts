import 'server-only';

import { promises as fs } from 'node:fs';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';

import { buildBrowserLaunchSpec } from './chromium';
import type { BrowserStatusDetails, ConsoleEntry } from './types';

const DEFAULT_TIMEOUT_MS = 15_000;
export const IDLE_CLOSE_MS = 5 * 60 * 1000;
const MAX_CONSOLE_ENTRIES = 200;

let browser: Browser | null = null;
let activePage: Page | null = null;
let launchPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const consoleEntries: ConsoleEntry[] = [];

type ConsoleMessageLike = {
  type(): string;
  text(): string;
  location(): { url?: string; lineNumber?: number; columnNumber?: number };
};

export function scheduleIdleClose(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    void closeBrowserRuntime('idle timeout');
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

function recordConsoleMessage(message: ConsoleMessageLike): void {
  const location = message.location();
  const renderedLocation = location.url
    ? `${location.url}${location.lineNumber !== undefined ? `:${location.lineNumber}` : ''}`
    : undefined;
  consoleEntries.push({
    level: message.type(),
    text: message.text(),
    location: renderedLocation,
    timestamp: new Date().toISOString(),
  });
  if (consoleEntries.length > MAX_CONSOLE_ENTRIES) {
    consoleEntries.splice(0, consoleEntries.length - MAX_CONSOLE_ENTRIES);
  }
}

async function ensureBrowser(): Promise<Browser> {
  if (browser?.connected) {
    scheduleIdleClose();
    return browser;
  }

  if (launchPromise) {
    return launchPromise;
  }

  const launchSpec = buildBrowserLaunchSpec();
  await fs.mkdir(launchSpec.userDataDir, { recursive: true });

  launchPromise = puppeteer.launch({
    executablePath: launchSpec.executablePath,
    headless: launchSpec.headless,
    args: launchSpec.args,
    defaultViewport: { width: 1280, height: 800 },
  }).then((launchedBrowser) => {
    browser = launchedBrowser;
    browser.on('disconnected', () => {
      browser = null;
      activePage = null;
    });
    scheduleIdleClose();
    return browser;
  }).finally(() => {
    launchPromise = null;
  });

  return launchPromise;
}

export async function ensurePage(): Promise<Page> {
  const b = await ensureBrowser();
  if (activePage && !activePage.isClosed()) {
    return activePage;
  }

  const pages = await b.pages();
  activePage = pages.find((page) => !page.isClosed()) || await b.newPage();
  activePage.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  activePage.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);
  activePage.on('console', recordConsoleMessage);

  for (const page of pages) {
    if (page !== activePage && !page.isClosed()) {
      await page.close().catch(() => undefined);
    }
  }

  return activePage;
}

export async function closeBrowserRuntime(reason: string): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  const currentBrowser = browser;
  browser = null;
  activePage = null;

  if (currentBrowser?.connected) {
    await currentBrowser.close().catch(() => undefined);
  }

  if (reason !== 'idle timeout') {
    consoleEntries.length = 0;
  }
}

export async function getStatusDetails(): Promise<BrowserStatusDetails> {
  if (!browser?.connected) {
    return { running: false };
  }

  const pages = await browser.pages().catch(() => []);
  const page = activePage && !activePage.isClosed() ? activePage : pages[0];
  return {
    running: true,
    pageCount: pages.length,
    activeUrl: page?.url() || null,
    activeTitle: page ? await page.title().catch(() => null) : null,
    idleCloseMs: IDLE_CLOSE_MS,
  };
}

export function getConsoleEntries(limit: number): ConsoleEntry[] {
  return consoleEntries.slice(-limit);
}
