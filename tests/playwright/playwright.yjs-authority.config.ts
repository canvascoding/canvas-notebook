import assert from 'node:assert/strict';
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { assertOrigin } from '../../scripts/lib/owned-yjs-authority-qa';

assert.equal(process.env.CANVAS_YJS_AUTHORITY_E2E, '1');
assert.equal(process.env.E2E_EXTERNAL_SERVER, '1');
assert.equal(process.env.NODE_ENV, 'production');
const origin = assertOrigin(process.env.BASE_URL ?? '').origin;
const receipt = process.env.CANVAS_YJS_QA_RECEIPT ?? '';
const output = process.env.CANVAS_YJS_QA_RESULTS ?? '';
assert(path.isAbsolute(receipt) && path.basename(receipt) === 'recovery.json');
assert(path.isAbsolute(output) && path.relative(path.join(path.dirname(receipt), 'results'), output).split(path.sep).every(part => part !== '..'));

// The supervisor alone starts and restarts the sealed production host. No
// webServer fallback, dotenv loading, shared target or automatic retry is allowed.
export default defineConfig({
  // Playwright removes outputDir at startup. Keep that disposable child apart
  // from the supervisor's private root and numeric acceptance receipt.
  testDir: '..', testMatch: '**/*.spec.ts', outputDir: path.join(output, 'playwright'),
  globalSetup: '../helpers/owned-yjs-authority-global-setup.ts',
  workers: 1, fullyParallel: false, retries: 0, timeout: 180_000,
  expect: { timeout: 30_000 }, reporter: [['list'], ['../helpers/owned-yjs-authority-reporter.ts']],
  use: {
    baseURL: origin, browserName: 'chromium', headless: true,
    viewport: { width: 1440, height: 1000 }, actionTimeout: 15_000, navigationTimeout: 45_000,
    // Credentials and session traffic never enter browser traces or videos.
    trace: 'off', video: 'off', screenshot: 'only-on-failure',
  },
});
