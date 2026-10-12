import { defineConfig } from '@playwright/test';
import path from 'node:path';

if (!process.env.BASE_URL || process.env.E2E_EXTERNAL_SERVER !== '1' || !process.env.DATA || !path.isAbsolute(process.env.DATA)) {
  throw new Error('Connection form acceptance requires the explicit managed host and existing managed DATA.');
}
const target = new URL(process.env.BASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.port !== '3001' || target.protocol !== 'http:'
  || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('Connection form acceptance only supports the explicitly managed loopback Notebook host on port 3001.');
}

export default defineConfig({
  testDir: 'tests', testMatch: 'plugin-connection-form-navigation-local.spec.ts',
  outputDir: '/tmp/canvas-plugin-connection-form-browser/results', workers: 1, fullyParallel: false, retries: 0, timeout: 180_000,
  expect: { timeout: 45_000 }, reporter: [['list']],
  use: { baseURL: target.origin, browserName: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    actionTimeout: 15_000, navigationTimeout: 45_000, trace: 'off', video: 'off', screenshot: 'off' },
});
