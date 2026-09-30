import { defineConfig } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import os from 'node:os';

const target = new URL(process.env.BASE_URL || 'http://127.0.0.1:3000');
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !['http:', 'https:'].includes(target.protocol)
  || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('Document review production E2E requires a loopback-only managed host origin.');
}
// Validate before reading private fixture credentials or creating any context.
const baseURL = target.origin;
const stateDirectory = path.join(os.homedir(), '.local/state/canvas-local-team-seat');
loadEnv({ path: process.env.DOCUMENT_REVIEW_HOST_ENV || path.join(stateDirectory, 'notebook-host-dev.env'), quiet: true });
loadEnv({ path: process.env.DOCUMENT_REVIEW_FIXTURE_ENV || path.join(stateDirectory, 'fixtures.env'), quiet: true });
process.env.BASE_URL = baseURL;

// The supervisor starts the current production build. This config never starts
// a dev host, container, provider fixture, or an application test endpoint.
export default defineConfig({
  testDir: 'tests',
  testMatch: 'document-review-production.spec.ts',
  outputDir: 'test-results/document-review-production',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 900_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL,
    browserName: 'chromium',
    viewport: { width: 1480, height: 1000 },
    // OAuth tokens and auth cookies must not enter a trace or network archive.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
