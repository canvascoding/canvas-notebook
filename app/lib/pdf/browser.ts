import puppeteer, { Browser, Page } from 'puppeteer-core';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildBrowserLaunchSpec,
  resolveBrowserUserDataDir,
  resolveChromiumExecutable,
} from '@/app/lib/pi/browser/chromium';
import { prepareBrowserProfileForLaunch } from '@/app/lib/pi/browser/runtime';
import {
  DEFAULT_BROWSER_EXPORT_TIMEOUT_MS,
  runBrowserExportJob,
  type BrowserExportError,
  type BrowserExportJobContext,
} from '@/app/lib/exports/browser-export-service';
import type { MarkdownPdfRenderOptions } from '@/app/lib/pdf/markdown-brand';

let browser: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

const EMOJI_FONT_FALLBACK = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';
const PDF_EXPORT_PROFILE_ID = 'pdf-export';
const PDF_RENDERER_CLOSED_MESSAGE = 'PDF renderer closed unexpectedly. Please try again.';
const PDF_CHROMIUM_RENDERER_PROCESS_LIMIT = '--renderer-process-limit=1';
const PDF_CHROMIUM_JS_HEAP_LIMIT = '--js-flags=--max-old-space-size=128';

export function findChromiumExecutable(): string {
  return resolveChromiumExecutable().executablePath;
}

/**
 * PDF rendering does not need browser state to survive a Node.js process.
 * Keeping the profile process-scoped prevents multiple app workers from
 * attempting to open Chromium with the same profile directory.
 */
export function getPdfBrowserProfileId(pid: number = process.pid): string {
  return `${PDF_EXPORT_PROFILE_ID}-${pid}`;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
  }
}

export function buildPdfBrowserLaunchSpec({
  env = process.env,
  existsSync = nodeFs.existsSync,
  pid = process.pid,
}: {
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  pid?: number;
} = {}) {
  const userDataDir = resolveBrowserUserDataDir(env, existsSync, getPdfBrowserProfileId(pid));
  return buildBrowserLaunchSpec({ env, existsSync, forceHeadless: true, userDataDir });
}

export async function removeStalePdfBrowserProfiles(
  profileRoot: string,
  currentPid: number = process.pid,
  processRunning: (pid: number) => boolean = isProcessRunning,
): Promise<string[]> {
  const entries = await fs.readdir(profileRoot, { withFileTypes: true });
  const removedProfiles: string[] = [];

  for (const entry of entries) {
    const match = new RegExp(`^${PDF_EXPORT_PROFILE_ID}-(\\d+)$`).exec(entry.name);
    if (!match || !entry.isDirectory()) continue;

    const pid = Number(match[1]);
    if (pid === currentPid || processRunning(pid)) continue;

    await fs.rm(path.join(profileRoot, entry.name), { recursive: true, force: true });
    removedProfiles.push(entry.name);
  }

  return removedProfiles;
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.connected) return browser;

  if (browser && !browser.connected) {
    browser = null;
  }

  if (launchPromise) return launchPromise;

  launchPromise = launchPdfBrowser().finally(() => {
    launchPromise = null;
  });

  return launchPromise;
}

async function launchPdfBrowser(): Promise<Browser> {
  const launchSpec = buildPdfBrowserLaunchSpec();
  await fs.mkdir(launchSpec.userDataDir, { recursive: true });
  const removedProfiles = await removeStalePdfBrowserProfiles(path.dirname(launchSpec.userDataDir));
  if (removedProfiles.length > 0) {
    console.info('[PDF Browser] Removed stale Chromium profiles before launch:', { removedProfiles });
  }
  const preparation = await prepareBrowserProfileForLaunch(launchSpec.userDataDir);
  if (preparation.removedArtifacts.length > 0) {
    console.info('[PDF Browser] Removed stale Chromium profile startup artifacts before launch:', {
      removedArtifacts: preparation.removedArtifacts,
    });
  }

  console.log(`[PDF Browser] Launching Chromium: ${launchSpec.executablePath}`);

  const launchedBrowser = await puppeteer.launch({
    executablePath: launchSpec.executablePath,
    headless: launchSpec.headless,
    args: [
      ...launchSpec.args,
      PDF_CHROMIUM_RENDERER_PROCESS_LIMIT,
      PDF_CHROMIUM_JS_HEAP_LIMIT,
      '--disable-component-update',
      '--disable-extensions',
    ],
    pipe: launchSpec.pipe,
    defaultViewport: { width: 1280, height: 900 },
  });

  browser = launchedBrowser;
  browser.on('disconnected', () => {
    console.warn('[PDF Browser] Browser disconnected, will re-launch on next request');
    browser = null;
  });

  return browser;
}

export function isPdfRendererClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Target\.setDiscoverTargets|Target closed|Protocol error|Session closed|Connection closed|Browser closed/i.test(message);
}

export function getPdfRendererClosedMessage(): string {
  return PDF_RENDERER_CLOSED_MESSAGE;
}

async function discardPdfBrowserAfterError(error: unknown): Promise<void> {
  if (!isPdfRendererClosedError(error)) return;

  await disposePdfBrowser('renderer closed');
}

export async function disposePdfBrowser(reason: string): Promise<void> {
  const currentBrowser = browser;
  browser = null;
  launchPromise = null;
  const browserProcess = currentBrowser?.process();

  if (currentBrowser?.connected) {
    await Promise.race([
      currentBrowser.close(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]).catch(() => undefined);
  }

  if (browserProcess && browserProcess.exitCode === null && !browserProcess.killed) {
    console.warn(`[PDF Browser] Killing Chromium after ${reason}`);
    browserProcess.kill('SIGKILL');
  }
}

async function closePageForTimedOutJob(page: Page | null, error: BrowserExportError, context: BrowserExportJobContext) {
  await page?.close().catch(() => undefined);
  await disposePdfBrowser(`${context.label} timed out (${error.code})`);
}

export async function generatePdfFromHtml(
  html: string,
  options?: Partial<MarkdownPdfRenderOptions>,
): Promise<Buffer> {
  let page: Page | null = null;
  return runBrowserExportJob({
    label: 'pdf-html',
    timeoutMs: DEFAULT_BROWSER_EXPORT_TIMEOUT_MS,
    timeoutErrorMessage: 'PDF_TIMEOUT',
    onTimeout: (error, context) => closePageForTimedOutJob(page, error, context),
    run: async () => {
      try {
        const b = await getBrowser();
        page = await b.newPage();
        page.setDefaultTimeout(15_000);
        page.setDefaultNavigationTimeout(20_000);
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await waitForPdfAssets(page);
        const preferCssPageSize = options?.preferCssPageSize === true;
        const pdf = await page.pdf({
          format: options?.format || 'A4',
          printBackground: true,
          preferCSSPageSize: preferCssPageSize,
          displayHeaderFooter: options?.displayHeaderFooter,
          headerTemplate: options?.headerTemplate,
          footerTemplate: options?.footerTemplate,
          margin: options?.margin || (preferCssPageSize
            ? undefined
            : { top: '25mm', right: '20mm', bottom: '25mm', left: '20mm' }),
        });
        return Buffer.from(pdf);
      } catch (error) {
        await discardPdfBrowserAfterError(error);
        throw error;
      } finally {
        await page?.close().catch(() => undefined);
      }
    },
  });
}

async function waitForPdfAssets(page: Page) {
  await page.evaluate(`
    (async () => {
      const timeout = (ms) => new Promise((resolve) => {
        window.setTimeout(resolve, ms);
      });

      const fontReady = document.fonts?.ready.then(() => undefined).catch(() => undefined) ?? Promise.resolve();
      const imagesReady = Promise.all(
        Array.from(document.images).map((image) => {
          if (image.complete) {
            return Promise.resolve();
          }

          return new Promise((resolve) => {
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener('error', () => resolve(), { once: true });
          });
        })
      ).then(() => undefined);

      await Promise.race([
        Promise.all([fontReady, imagesReady]).then(() => undefined),
        timeout(5000),
      ]);
    })()
  `);
}

async function applyEmojiFontFallback(page: Page) {
  await page.evaluate(`
    (() => {
      const fallbackFonts = ${JSON.stringify(EMOJI_FONT_FALLBACK)};
      const emojiPattern = /\\p{Extended_Pictographic}/u;
      const fallbackNames = fallbackFonts
        .split(',')
        .map((font) => font.replace(/["']/g, '').trim().toLowerCase())
        .filter(Boolean);

      for (const element of Array.from(document.querySelectorAll('body, body *'))) {
        if (!element.textContent || !emojiPattern.test(element.textContent)) {
          continue;
        }

        const currentFamily = window.getComputedStyle(element).fontFamily;
        const currentLower = currentFamily.toLowerCase();
        const hasEmojiFallback = fallbackNames.some((font) => currentLower.includes(font));

        if (!hasEmojiFallback) {
          element.style.fontFamily = \`\${currentFamily}, \${fallbackFonts}\`;
        }
      }
    })()
  `);
  await page.evaluate('(async () => { await document.fonts?.ready; })()');
}

export async function generatePdfFromUrl(url: string, headers?: Record<string, string>): Promise<Buffer> {
  let page: Page | null = null;
  return runBrowserExportJob({
    label: 'pdf-url',
    timeoutMs: DEFAULT_BROWSER_EXPORT_TIMEOUT_MS,
    timeoutErrorMessage: 'PDF_TIMEOUT',
    onTimeout: (error, context) => closePageForTimedOutJob(page, error, context),
    run: async () => {
      try {
        const b = await getBrowser();
        page = await b.newPage();
        page.setDefaultTimeout(15_000);
        page.setDefaultNavigationTimeout(20_000);
        if (headers && Object.keys(headers).length > 0) {
          await page.setExtraHTTPHeaders(headers);
        }

        await page.goto(url, { waitUntil: 'networkidle0', timeout: 20_000 });
        await applyEmojiFontFallback(page);
        const pdf = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '25mm', right: '20mm', bottom: '25mm', left: '20mm' },
        });
        return Buffer.from(pdf);
      } catch (error) {
        await discardPdfBrowserAfterError(error);
        throw error;
      } finally {
        await page?.close().catch(() => undefined);
      }
    },
  });
}
