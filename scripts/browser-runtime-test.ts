import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import {
  buildBrowserLaunchSpec,
  checkChromiumExecutable,
  resolveChromiumExecutable,
  resolveBrowserUserDataDir,
} from '../app/lib/pi/browser/chromium';

function makeExistsSync(existingPaths: string[]) {
  const existing = new Set(existingPaths);
  return (candidate: string) => existing.has(candidate);
}

function makeEnv(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

async function pathEntryExists(filePath: string): Promise<boolean> {
  return lstat(filePath)
    .then(() => true)
    .catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    });
}

function testEnvOverrideWins() {
  const result = resolveChromiumExecutable({
    env: makeEnv({ CHROMIUM_PATH: '/custom/chromium' }),
    existsSync: makeExistsSync(['/custom/chromium']),
    execSyncImpl: (() => '') as never,
  });

  assert.equal(result.executablePath, '/custom/chromium');
  assert.equal(result.source, 'env');
}

function testSystemFallbackWorks() {
  const result = resolveChromiumExecutable({
    env: makeEnv({}),
    existsSync: makeExistsSync(['/usr/bin/chromium']),
    execSyncImpl: (() => '') as never,
  });

  assert.equal(result.executablePath, '/usr/bin/chromium');
  assert.equal(result.source, 'system');
}

function testWhichFallbackWorks() {
  const result = resolveChromiumExecutable({
    env: makeEnv({}),
    existsSync: makeExistsSync(['/opt/bin/chromium']),
    execSyncImpl: (() => '/opt/bin/chromium\n') as never,
  });

  assert.equal(result.executablePath, '/opt/bin/chromium');
  assert.equal(result.source, 'which');
}

function testErrorListsAttemptedPaths() {
  assert.throws(
    () =>
      resolveChromiumExecutable({
        env: makeEnv({ CHROMIUM_PATH: '/missing/custom' }),
        existsSync: makeExistsSync([]),
        execSyncImpl: (() => '') as never,
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes('/missing/custom') &&
      error.message.includes('/usr/bin/chromium'),
  );
}

function testNonThrowingExecutableStatus() {
  const missing = checkChromiumExecutable({
    env: makeEnv({ CHROMIUM_PATH: '/missing/custom' }),
    existsSync: makeExistsSync([]),
    execSyncImpl: (() => '') as never,
  });

  assert.equal(missing.available, false);
  assert.ok(missing.error.includes('No Chromium/Chrome executable found'));
  assert.ok(missing.attemptedPaths.includes('/missing/custom'));

  const available = checkChromiumExecutable({
    env: makeEnv({ CHROMIUM_PATH: '/custom/chromium' }),
    existsSync: makeExistsSync(['/custom/chromium']),
    execSyncImpl: (() => '') as never,
  });
  assert.equal(available.available, true);
  assert.equal(available.executablePath, '/custom/chromium');
}

function testContainerLaunchFlags() {
  const spec = buildBrowserLaunchSpec({
    env: {
      NODE_ENV: 'test',
      CANVAS_RUNTIME_ENV: 'docker',
      CHROMIUM_PATH: '/usr/bin/chromium',
      DATA: '/data',
    } as NodeJS.ProcessEnv,
    platform: 'linux',
    existsSync: makeExistsSync(['/usr/bin/chromium']),
    execSyncImpl: (() => '') as never,
  });

  assert.equal(spec.headless, true);
  assert.ok(spec.args.includes('--headless=new'));
  assert.ok(spec.args.includes('--no-sandbox'));
  assert.ok(spec.args.includes('--disable-dev-shm-usage'));
  assert.ok(spec.args.includes('--disable-crashpad'));
  assert.equal(spec.pipe, true);
  assert.equal(spec.userDataDir, '/data/cache/browser-runtime');
}

function testDesktopVisibleLaunch() {
  const spec = buildBrowserLaunchSpec({
    env: {
      NODE_ENV: 'test',
      CHROMIUM_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      DATA: '/tmp/canvas-data',
    } as NodeJS.ProcessEnv,
    platform: 'darwin',
    existsSync: makeExistsSync([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]),
    execSyncImpl: (() => '') as never,
  });

  assert.equal(spec.headless, false);
  assert.ok(!spec.args.includes('--headless=new'));
  assert.equal(spec.pipe, true);
  assert.equal(spec.userDataDir, '/tmp/canvas-data/cache/browser-runtime');
}

function testForcedHeadlessLaunch() {
  const spec = buildBrowserLaunchSpec({
    env: {
      NODE_ENV: 'test',
      CHROMIUM_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      DATA: '/tmp/canvas-data',
    } as NodeJS.ProcessEnv,
    platform: 'darwin',
    existsSync: makeExistsSync([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]),
    execSyncImpl: (() => '') as never,
    forceHeadless: true,
  });

  assert.equal(spec.headless, true);
  assert.ok(spec.args.includes('--headless=new'));
  assert.ok(spec.args.includes('--no-sandbox'));
  assert.equal(spec.pipe, true);
}

function testSessionUserDataDir() {
  const dir = resolveBrowserUserDataDir(
    makeEnv({ DATA: '/tmp/canvas-data' }),
    makeExistsSync([]),
    'User 1 / Agent:Main / Sess_ABC',
  );

  assert.equal(dir, '/tmp/canvas-data/cache/browser-runtime/user-1-agent-main-sess_abc');
}

function testLaunchSpecUsesResolvedUserDataDirFlag() {
  const spec = buildBrowserLaunchSpec({
    env: {
      NODE_ENV: 'test',
      CANVAS_RUNTIME_ENV: 'docker',
      CHROMIUM_PATH: '/usr/bin/chromium',
      DATA: '/data',
    } as NodeJS.ProcessEnv,
    platform: 'linux',
    existsSync: makeExistsSync(['/usr/bin/chromium']),
    execSyncImpl: (() => '') as never,
    userDataDir: '/data/cache/browser-runtime/session-a',
  });

  assert.equal(spec.userDataDir, '/data/cache/browser-runtime/session-a');
  assert.ok(spec.args.includes('--user-data-dir=/data/cache/browser-runtime/session-a'));
  assert.ok(!spec.args.includes('--user-data-dir=undefined'));
}

async function importBrowserRuntime() {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    return await import('../app/lib/pi/browser/runtime');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function importPdfBrowser() {
  const moduleInternals = Module as typeof Module & {
    _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
  };
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'server-only') {
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    return await import('../app/lib/pdf/browser');
  } finally {
    moduleInternals._load = originalLoad;
  }
}

async function testRuntimeProfileKeys() {
  const originalProfileScope = process.env.CANVAS_BROWSER_PROFILE_SCOPE;
  try {
    const {
      getBrowserProfileContextKey,
      getBrowserRuntimeContextKey,
    } = await importBrowserRuntime();

    delete process.env.CANVAS_BROWSER_PROFILE_SCOPE;
    const sessionA = { userId: 'User 1', agentId: 'Agent:Main', sessionId: 'Sess A' };
    const sessionB = { userId: 'User 1', agentId: 'Agent:Main', sessionId: 'Sess B' };
    assert.equal(getBrowserProfileContextKey(sessionA), 'user-1__agent-main');
    assert.equal(getBrowserProfileContextKey(sessionB), 'user-1__agent-main');
    assert.notEqual(getBrowserRuntimeContextKey(sessionA), getBrowserRuntimeContextKey(sessionB));

    process.env.CANVAS_BROWSER_PROFILE_SCOPE = 'session';
    assert.equal(getBrowserProfileContextKey(sessionA), getBrowserRuntimeContextKey(sessionA));

    delete process.env.CANVAS_BROWSER_PROFILE_SCOPE;
    const teamWorkspace = { ...sessionA, workspaceId: 'Team Workspace 1' };
    const personalWorkspace = { ...sessionA, workspaceId: 'Personal Workspace 1' };
    assert.equal(getBrowserProfileContextKey(teamWorkspace), 'user-1__agent-main__ws-team-workspace-1');
    assert.notEqual(getBrowserProfileContextKey(teamWorkspace), getBrowserProfileContextKey(personalWorkspace));
    assert.notEqual(
      getBrowserRuntimeContextKey({ ...teamWorkspace, userId: 'User 2' }),
      getBrowserRuntimeContextKey(teamWorkspace),
    );
  } finally {
    if (originalProfileScope === undefined) {
      delete process.env.CANVAS_BROWSER_PROFILE_SCOPE;
    } else {
      process.env.CANVAS_BROWSER_PROFILE_SCOPE = originalProfileScope;
    }
  }
}

async function testStaleProfileArtifactsAreCleanedBeforeLaunch() {
  const { prepareBrowserProfileForLaunch } = await importBrowserRuntime();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'canvas-browser-profile-test-'));
  try {
    await symlink(`${os.hostname()}-999999999`, path.join(dir, 'SingletonLock'));
    await symlink('/tmp/missing-canvas-browser-socket', path.join(dir, 'SingletonSocket'));
    await symlink('stale-cookie', path.join(dir, 'SingletonCookie'));
    await writeFile(path.join(dir, 'DevToolsActivePort'), '12345\n');

    const result = await prepareBrowserProfileForLaunch(dir);
    assert.deepEqual(
      new Set(result.removedArtifacts),
      new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']),
    );
    assert.equal(existsSync(path.join(dir, 'SingletonLock')), false);
    assert.equal(existsSync(path.join(dir, 'DevToolsActivePort')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testActiveProfileLockIsPreserved() {
  const { prepareBrowserProfileForLaunch } = await importBrowserRuntime();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'canvas-browser-profile-test-'));
  try {
    await symlink(`${os.hostname()}-${process.pid}`, path.join(dir, 'SingletonLock'));
    await writeFile(path.join(dir, 'DevToolsActivePort'), '12345\n');

    const result = await prepareBrowserProfileForLaunch(dir);
    assert.equal(result.skippedActiveSingletonLock, true);
    assert.deepEqual(result.removedArtifacts, []);
    assert.equal(await pathEntryExists(path.join(dir, 'SingletonLock')), true);
    assert.equal(existsSync(path.join(dir, 'DevToolsActivePort')), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testPdfRendererClosedErrorsAreClassified() {
  const {
    getPdfBrowserProfileId,
    getPdfRendererClosedMessage,
    isPdfRendererClosedError,
  } = await importPdfBrowser();

  assert.equal(getPdfBrowserProfileId(1234), 'pdf-export-1234');
  assert.notEqual(getPdfBrowserProfileId(1234), getPdfBrowserProfileId(5678));
  assert.equal(
    isPdfRendererClosedError(new Error('Protocol error (Target.setDiscoverTargets): Target closed')),
    true,
  );
  assert.equal(isPdfRendererClosedError(new Error('File not found')), false);
  assert.match(getPdfRendererClosedMessage(), /PDF renderer closed unexpectedly/);
}

async function main() {
  testEnvOverrideWins();
  testSystemFallbackWorks();
  testWhichFallbackWorks();
  testErrorListsAttemptedPaths();
  testNonThrowingExecutableStatus();
  testContainerLaunchFlags();
  testDesktopVisibleLaunch();
  testForcedHeadlessLaunch();
  testSessionUserDataDir();
  testLaunchSpecUsesResolvedUserDataDirFlag();
  await testRuntimeProfileKeys();
  await testStaleProfileArtifactsAreCleanedBeforeLaunch();
  await testActiveProfileLockIsPreserved();
  await testPdfRendererClosedErrorsAreClassified();

  console.log('browser-runtime-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
