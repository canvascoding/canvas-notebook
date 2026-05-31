import assert from 'node:assert/strict';

import {
  buildBrowserLaunchSpec,
  resolveChromiumExecutable,
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

testEnvOverrideWins();
testSystemFallbackWorks();
testWhichFallbackWorks();
testErrorListsAttemptedPaths();
testContainerLaunchFlags();
testDesktopVisibleLaunch();

console.log('browser-runtime-test: ok');
