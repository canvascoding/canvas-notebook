import { defineConfig } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import os from 'node:os';
import path from 'node:path';

const target = new URL(process.env.BASE_URL || 'http://127.0.0.1:3000');
if (!['127.0.0.1', 'localhost'].includes(target.hostname)
  || !['http:', 'https:'].includes(target.protocol)
  || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('File discovery E2E requires the loopback-only managed Notebook origin.');
}
if (process.env.E2E_EXTERNAL_SERVER !== '1') {
  throw new Error('Start the managed Notebook host first and set E2E_EXTERNAL_SERVER=1.');
}
const stateDirectory = path.join(os.homedir(), '.local/state/canvas-local-team-seat');
loadEnv({ path: process.env.FILE_DISCOVERY_HOST_ENV || path.join(stateDirectory, 'notebook-host-dev.env'), quiet: true });
process.env.BASE_URL = target.origin;

export default defineConfig({
  testDir: '..',
  testMatch: 'workspace-file-discovery.spec.ts',
  outputDir: path.join(os.tmpdir(), 'canvas-workspace-file-discovery-e2e'),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 360_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: target.origin,
    browserName: 'chromium',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
