import { defineConfig } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import os from 'node:os';
import path from 'node:path';

const target = new URL(process.env.BASE_URL || 'http://127.0.0.1:3000');
if (!['http:', 'https:'].includes(target.protocol) || !['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/' || target.search || target.hash || target.username || target.password) {
  throw new Error('404 UI checks require the loopback dev server.');
}
loadEnv({ path: process.env.CANVAS_ENV_FILE || path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env'), quiet: true });

export default defineConfig({
  testDir: '..',
  testMatch: 'not-found-local.spec.ts',
  outputDir: '../../test-results/not-found-local',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: target.origin,
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
