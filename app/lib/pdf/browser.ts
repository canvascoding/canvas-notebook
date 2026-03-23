import puppeteer, { Browser } from 'puppeteer-core';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

let browser: Browser | null = null;

function findChromiumExecutable(): string {
  // 1. Explicit env override
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }

  // 2. Playwright headless shell (installed by @playwright/test devDependency)
  const playwrightCacheDirs = [
    path.join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright'), // macOS
    path.join(process.env.HOME || '', '.cache', 'ms-playwright'),             // Linux
    path.join(process.env.XDG_CACHE_HOME || '', 'ms-playwright'),
  ];

  for (const cacheDir of playwrightCacheDirs) {
    if (!fs.existsSync(cacheDir)) continue;
    try {
      const entries = fs.readdirSync(cacheDir);
      // Look for chromium_headless_shell-* or chromium-* directories, prefer newest
      const chromiumDirs = entries
        .filter(e => e.startsWith('chromium'))
        .sort()
        .reverse();

      for (const dir of chromiumDirs) {
        const base = path.join(cacheDir, dir);
        // Try common sub-paths
        const candidates = [
          path.join(base, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
          path.join(base, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
          path.join(base, 'chrome-headless-shell-linux-x64', 'chrome-headless-shell'),
          path.join(base, 'chrome-headless-shell-linux-arm64', 'chrome-headless-shell'),
          path.join(base, 'chrome-mac-arm64', 'chrome-headless-shell'),
          path.join(base, 'chrome-mac-x64', 'chrome-headless-shell'),
          path.join(base, 'chrome-linux-x64', 'chrome'),
        ];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. macOS system Chrome
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(macChrome)) return macChrome;

  // 4. Common Linux paths
  const linuxPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  for (const p of linuxPaths) {
    if (fs.existsSync(p)) return p;
  }

  // 5. Try `which` as last resort
  try {
    const result = execSync('which chromium || which chromium-browser || which google-chrome', { encoding: 'utf-8' }).trim();
    if (result) return result.split('\n')[0];
  } catch {
    // ignore
  }

  throw new Error(
    'No Chromium/Chrome executable found. Set CHROMIUM_PATH env var or install Chromium.'
  );
}

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;

  const executablePath = findChromiumExecutable();
  console.log(`[PDF Browser] Launching Chromium: ${executablePath}`);

  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
    ],
  });

  browser.on('disconnected', () => {
    console.warn('[PDF Browser] Browser disconnected, will re-launch on next request');
    browser = null;
  });

  return browser;
}

export async function generatePdfFromHtml(html: string): Promise<Buffer> {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '25mm', right: '20mm', bottom: '25mm', left: '20mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}
