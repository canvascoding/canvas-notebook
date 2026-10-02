import { defineConfig } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import os from 'node:os';
import path from 'node:path';

const target = new URL(process.env.BASE_URL || 'http://127.0.0.1:3100');
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password
  || target.pathname !== '/' || target.search || target.hash || process.env.E2E_EXTERNAL_SERVER !== '1') {
  throw new Error('Plugins browser acceptance requires the externally managed loopback Notebook stack.');
}
const stateDirectory = path.join(os.homedir(), '.local/state/canvas-local-team-seat');
loadEnv({ path: path.join(stateDirectory, 'notebook.env'), quiet: true });
loadEnv({ path: path.join(stateDirectory, 'fixtures.env'), quiet: true });
process.env.BASE_URL = target.origin;

export default defineConfig({
  testDir: 'tests',
  testMatch: 'plugins-app-local.spec.ts',
  outputDir: path.join(os.tmpdir(), 'canvas-plugins-app-e2e'),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: target.origin,
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
