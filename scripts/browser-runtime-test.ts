import assert from 'node:assert/strict';
import Module from 'node:module';

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
  assert.equal(spec.userDataDir, '/tmp/canvas-data/cache/browser-runtime');
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

async function testRuntimeProfileKeys() {
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

  const originalProfileScope = process.env.CANVAS_BROWSER_PROFILE_SCOPE;
  try {
    const {
      getBrowserProfileContextKey,
      getBrowserRuntimeContextKey,
    } = await import('../app/lib/pi/browser/runtime');

    delete process.env.CANVAS_BROWSER_PROFILE_SCOPE;
    const sessionA = { userId: 'User 1', agentId: 'Agent:Main', sessionId: 'Sess A' };
    const sessionB = { userId: 'User 1', agentId: 'Agent:Main', sessionId: 'Sess B' };
    assert.equal(getBrowserProfileContextKey(sessionA), 'user-1__agent-main');
    assert.equal(getBrowserProfileContextKey(sessionB), 'user-1__agent-main');
    assert.notEqual(getBrowserRuntimeContextKey(sessionA), getBrowserRuntimeContextKey(sessionB));

    process.env.CANVAS_BROWSER_PROFILE_SCOPE = 'session';
    assert.equal(getBrowserProfileContextKey(sessionA), getBrowserRuntimeContextKey(sessionA));
  } finally {
    if (originalProfileScope === undefined) {
      delete process.env.CANVAS_BROWSER_PROFILE_SCOPE;
    } else {
      process.env.CANVAS_BROWSER_PROFILE_SCOPE = originalProfileScope;
    }
    moduleInternals._load = originalLoad;
  }
}

async function main() {
  testEnvOverrideWins();
  testSystemFallbackWorks();
  testWhichFallbackWorks();
  testErrorListsAttemptedPaths();
  testNonThrowingExecutableStatus();
  testContainerLaunchFlags();
  testDesktopVisibleLaunch();
  testSessionUserDataDir();
  testLaunchSpecUsesResolvedUserDataDirFlag();
  await testRuntimeProfileKeys();

  console.log('browser-runtime-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
