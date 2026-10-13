import { defineConfig } from '@playwright/test';
import path from 'node:path';

if (!process.env.BASE_URL || process.env.E2E_EXTERNAL_SERVER !== '1' || !process.env.DATA
  || !process.env.CAPABILITY_STORE_E2E_FIXTURE || !path.isAbsolute(process.env.CAPABILITY_STORE_E2E_FIXTURE)
  || !process.env.CAPABILITY_FULLCLICK_SOURCE_PROOF || !path.isAbsolute(process.env.CAPABILITY_FULLCLICK_SOURCE_PROOF)) {
  throw new Error('Full-click package acceptance requires the explicit managed host, DATA, owned private Store fixture and source proof.');
}
const target = new URL(process.env.BASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.port !== '3001' || target.protocol !== 'http:'
  || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('Full-click package acceptance only supports the explicitly managed loopback Notebook host on port 3001.');
}
export default defineConfig({
  testDir: '..', testMatch: 'plugin-workspace-fullclick-local.spec.ts',
  outputDir: '/tmp/canvas-plugin-ui-6ac3-browser/results', workers: 1, fullyParallel: false, retries: 0, timeout: 480_000,
  expect: { timeout: 45_000 }, reporter: [['list']],
  use: { baseURL: target.origin, browserName: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    actionTimeout: 15_000, navigationTimeout: 45_000, trace: 'off', video: 'off', screenshot: 'off' },
});
