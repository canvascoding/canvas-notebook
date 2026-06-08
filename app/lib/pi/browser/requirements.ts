import 'server-only';

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import puppeteer from 'puppeteer-core';

import {
  buildBrowserLaunchSpec,
  checkChromiumExecutable,
  getRuntimeMode,
  type BrowserRuntimeMode,
  type ChromiumExecutableResolution,
} from './chromium';

const REQUIREMENT_CACHE_MS = 30_000;

export type BrowserRequirementStatus = {
  available: boolean;
  checkedAt: string;
  runtime: BrowserRuntimeMode;
  executablePath: string | null;
  executableSource: ChromiumExecutableResolution['source'] | null;
  attemptedPaths: string[];
  reason: string | null;
};

export type BrowserLaunchProbeStatus = BrowserRequirementStatus & {
  launchProbe: {
    checked: true;
    ok: boolean;
    reason: string | null;
    userDataDir: string;
  };
};

let cachedRequirementStatus: {
  expiresAt: number;
  status: BrowserRequirementStatus;
} | null = null;

function buildRequirementStatus(): BrowserRequirementStatus {
  const executable = checkChromiumExecutable();
  const runtime = getRuntimeMode();
  const checkedAt = new Date().toISOString();

  if (!executable.available) {
    return {
      available: false,
      checkedAt,
      runtime,
      executablePath: null,
      executableSource: null,
      attemptedPaths: executable.attemptedPaths,
      reason: executable.error,
    };
  }

  return {
    available: true,
    checkedAt,
    runtime,
    executablePath: executable.executablePath,
    executableSource: executable.source,
    attemptedPaths: executable.attemptedPaths,
    reason: null,
  };
}

export function getBrowserRequirementStatus(options: { cache?: boolean } = {}): BrowserRequirementStatus {
  const useCache = options.cache !== false;
  const now = Date.now();
  if (useCache && cachedRequirementStatus && cachedRequirementStatus.expiresAt > now) {
    return cachedRequirementStatus.status;
  }

  const status = buildRequirementStatus();
  cachedRequirementStatus = {
    expiresAt: now + REQUIREMENT_CACHE_MS,
    status,
  };
  return status;
}

export function isBrowserRuntimeAvailable(): boolean {
  return getBrowserRequirementStatus({ cache: true }).available;
}

export function invalidateBrowserRequirementCache(): void {
  cachedRequirementStatus = null;
}

export async function runBrowserLaunchProbe(): Promise<BrowserLaunchProbeStatus> {
  invalidateBrowserRequirementCache();
  const requirement = getBrowserRequirementStatus({ cache: false });
  const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-browser-probe-'));

  if (!requirement.available) {
    await fs.rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      ...requirement,
      launchProbe: {
        checked: true,
        ok: false,
        reason: requirement.reason,
        userDataDir: probeDir,
      },
    };
  }

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    const launchSpec = buildBrowserLaunchSpec({ userDataDir: probeDir });
    browser = await puppeteer.launch({
      executablePath: launchSpec.executablePath,
      headless: launchSpec.headless,
      args: launchSpec.args,
      defaultViewport: { width: 640, height: 480 },
    });
    return {
      ...requirement,
      launchProbe: {
        checked: true,
        ok: true,
        reason: null,
        userDataDir: probeDir,
      },
    };
  } catch (error) {
    return {
      ...requirement,
      available: false,
      reason: error instanceof Error ? error.message : 'Chromium launch probe failed.',
      launchProbe: {
        checked: true,
        ok: false,
        reason: error instanceof Error ? error.message : 'Chromium launch probe failed.',
        userDataDir: probeDir,
      },
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await fs.rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
    invalidateBrowserRequirementCache();
  }
}
