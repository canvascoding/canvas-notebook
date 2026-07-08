import puppeteer, { Browser, Page } from 'puppeteer-core';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';

import {
  buildBrowserLaunchSpec,
  resolveBrowserUserDataDir,
  resolveChromiumExecutable,
} from '@/app/lib/pi/browser/chromium';
import { prepareBrowserProfileForLaunch } from '@/app/lib/pi/browser/runtime';

let browser: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

const EMOJI_FONT_FALLBACK = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';
const PDF_EXPORT_PROFILE_ID = 'pdf-export';
const PDF_RENDERER_CLOSED_MESSAGE = 'PDF renderer closed unexpectedly. Please try again.';

export function findChromiumExecutable(): string {
  return resolveChromiumExecutable().executablePath;
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
  const userDataDir = resolveBrowserUserDataDir(process.env, nodeFs.existsSync, PDF_EXPORT_PROFILE_ID);
  const launchSpec = buildBrowserLaunchSpec({ forceHeadless: true, userDataDir });
  await fs.mkdir(launchSpec.userDataDir, { recursive: true });
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
    args: launchSpec.args,
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

  const currentBrowser = browser;
  browser = null;
  launchPromise = null;

  if (currentBrowser?.connected) {
    await currentBrowser.close().catch(() => undefined);
  }
}

export async function generatePdfFromHtml(html: string): Promise<Buffer> {
  let page: Page | null = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await waitForPdfAssets(page);
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
  try {
    const b = await getBrowser();
    page = await b.newPage();
    if (headers && Object.keys(headers).length > 0) {
      await page.setExtraHTTPHeaders(headers);
    }

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
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
}
