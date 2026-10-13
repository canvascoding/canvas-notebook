import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

if (!process.env.BASE_URL || process.env.E2E_EXTERNAL_SERVER !== '1' || !process.env.CAPABILITY_STORE_E2E_FIXTURE
  || !path.isAbsolute(process.env.CAPABILITY_STORE_E2E_FIXTURE)) {
  throw new Error('Store read acceptance requires an explicit managed loopback host and owned private Store fixture.');
}
const target = new URL(process.env.BASE_URL);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol)
  || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('Store read acceptance only supports an explicit loopback host.');
}

export default defineConfig({
  testDir: '..', testMatch: 'capability-package-store-reads-local.spec.ts',
  outputDir: path.join(os.tmpdir(), 'canvas-package-store-reads-e2e'),
  workers: 1, fullyParallel: false, retries: 0, timeout: 120_000,
  expect: { timeout: 30_000 }, reporter: [['list']],
  use: { baseURL: target.origin, browserName: 'chromium', headless: true,
    trace: 'off', video: 'off', screenshot: 'off' },
});
