import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv'];

const COMMON_BROWSER_PATHS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

type RuntimeModeOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  existsSync?: (path: string) => boolean;
};

export type BrowserRuntimeMode = {
  container: boolean;
  displayAvailable: boolean;
  headless: boolean;
};

export type ChromiumExecutableResolution = {
  executablePath: string;
  source: 'env' | 'playwright' | 'system' | 'which';
  attemptedPaths: string[];
};

export type BrowserLaunchSpec = {
  executablePath: string;
  executableSource: ChromiumExecutableResolution['source'];
  attemptedPaths: string[];
  userDataDir: string;
  args: string[];
  headless: boolean;
  runtime: BrowserRuntimeMode;
};

function sanitizeBrowserSessionId(sessionId: string): string {
  return sessionId
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'default';
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function hasDisplay(env = process.env, platform = process.platform): boolean {
  if (platform === 'darwin') {
    return true;
  }

  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export function isContainerRuntime({
  env = process.env,
  existsSync = fs.existsSync,
}: RuntimeModeOptions = {}): boolean {
  if (env.CANVAS_RUNTIME_ENV === 'docker') {
    return true;
  }

  if (env.CONTAINER?.toLowerCase() === 'true') {
    return true;
  }

  return CONTAINER_MARKERS.some((marker) => existsSync(marker));
}

export function getRuntimeMode(options: RuntimeModeOptions = {}): BrowserRuntimeMode {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const displayAvailable = hasDisplay(env, platform);
  const container = isContainerRuntime(options);

  return {
    container,
    displayAvailable,
    headless: container || !displayAvailable,
  };
}

function getPlaywrightBrowserCandidates(env: NodeJS.ProcessEnv): string[] {
  const cacheDirs = [
    path.join(env.HOME || '', 'Library', 'Caches', 'ms-playwright'),
    path.join(env.HOME || '', '.cache', 'ms-playwright'),
    path.join(env.XDG_CACHE_HOME || '', 'ms-playwright'),
  ];

  const candidates: string[] = [];
  for (const cacheDir of cacheDirs) {
    if (!cacheDir || !fs.existsSync(cacheDir)) {
      continue;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(cacheDir);
    } catch {
      continue;
    }

    const chromiumDirs = entries
      .filter((entry) => entry.startsWith('chromium'))
      .sort()
      .reverse();

    for (const dir of chromiumDirs) {
      const base = path.join(cacheDir, dir);
      candidates.push(
        path.join(base, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
        path.join(base, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'),
        path.join(base, 'chrome-headless-shell-linux-x64', 'chrome-headless-shell'),
        path.join(base, 'chrome-headless-shell-linux-arm64', 'chrome-headless-shell'),
        path.join(base, 'chrome-mac-arm64', 'chrome-headless-shell'),
        path.join(base, 'chrome-mac-x64', 'chrome-headless-shell'),
        path.join(base, 'chrome-linux-x64', 'chrome'),
      );
    }
  }

  return candidates;
}

function findExecutableOnPath(
  execSyncImpl: typeof execSync,
  env: NodeJS.ProcessEnv,
): string | null {
  try {
    const result = execSyncImpl(
      'which chromium || which chromium-browser || which google-chrome || which google-chrome-stable',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env },
    )
      .trim()
      .split('\n')
      .map((entry) => entry.trim())
      .find(Boolean);
    return result || null;
  } catch {
    return null;
  }
}

export function resolveChromiumExecutable({
  env = process.env,
  existsSync = fs.existsSync,
  execSyncImpl = execSync,
}: {
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  execSyncImpl?: typeof execSync;
} = {}): ChromiumExecutableResolution {
  const attemptedPaths: string[] = [];

  const configuredPath = env.CHROMIUM_PATH?.trim();
  if (configuredPath) {
    attemptedPaths.push(configuredPath);
    if (existsSync(configuredPath)) {
      return {
        executablePath: configuredPath,
        source: 'env',
        attemptedPaths,
      };
    }
  }

  for (const candidate of getPlaywrightBrowserCandidates(env)) {
    attemptedPaths.push(candidate);
    if (existsSync(candidate)) {
      return {
        executablePath: candidate,
        source: 'playwright',
        attemptedPaths,
      };
    }
  }

  for (const candidate of COMMON_BROWSER_PATHS) {
    attemptedPaths.push(candidate);
    if (existsSync(candidate)) {
      return {
        executablePath: candidate,
        source: 'system',
        attemptedPaths,
      };
    }
  }

  const whichPath = findExecutableOnPath(execSyncImpl, env);
  if (whichPath) {
    attemptedPaths.push(whichPath);
    if (existsSync(whichPath)) {
      return {
        executablePath: whichPath,
        source: 'which',
        attemptedPaths,
      };
    }
  }

  const lookupSummary = unique(attemptedPaths).join(', ');
  throw new Error(
    `No Chromium/Chrome executable found. Checked: ${lookupSummary || 'no candidate paths'}. ` +
      'Set CHROMIUM_PATH or install Chromium.',
  );
}

function resolveBrowserDataRoot(env: NodeJS.ProcessEnv, existsSync: (path: string) => boolean): string {
  const configuredRoot = env.CANVAS_DATA_ROOT?.trim() || env.DATA?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  if (existsSync('/data')) {
    return '/data';
  }

  return path.resolve(process.cwd(), 'data');
}

export function resolveBrowserUserDataDir(
  env: NodeJS.ProcessEnv = process.env,
  existsSync: (path: string) => boolean = fs.existsSync,
  sessionId?: string,
): string {
  const dataRoot = resolveBrowserDataRoot(env, existsSync);
  const cacheRoot = env.XDG_CACHE_HOME || path.join(dataRoot, 'cache');
  const baseDir = path.join(cacheRoot, 'browser-runtime');
  if (!sessionId) {
    return baseDir;
  }

  return path.join(baseDir, sanitizeBrowserSessionId(sessionId));
}

export function buildBrowserLaunchSpec({
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  userDataDir,
  execSyncImpl = execSync,
}: RuntimeModeOptions & {
  userDataDir?: string;
  execSyncImpl?: typeof execSync;
} = {}): BrowserLaunchSpec {
  const runtime = getRuntimeMode({ env, platform, existsSync });
  const { executablePath, source, attemptedPaths } = resolveChromiumExecutable({
    env,
    existsSync,
    execSyncImpl,
  });
  const resolvedUserDataDir = userDataDir ?? resolveBrowserUserDataDir(env, existsSync);

  const args = [
    `--user-data-dir=${resolvedUserDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--metrics-recording-only',
  ];

  if (runtime.headless) {
    args.push(
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
    );
  }

  return {
    executablePath,
    executableSource: source,
    attemptedPaths,
    userDataDir: resolvedUserDataDir,
    args,
    headless: runtime.headless,
    runtime,
  };
}
