import { defineConfig } from '@playwright/test';
import path from 'node:path';

const fixture = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
const results = process.env.AGENT_SETTINGS_TOOLS_BROWSER_RESULTS;
if (process.env.CANVAS_AGENT_SETTINGS_BROWSER_RUN !== '1' || process.env.E2E_EXTERNAL_SERVER !== '1'
  || !fixture || !results || !path.isAbsolute(fixture) || !path.isAbsolute(results)
  || process.env.BASE_URL !== 'http://127.0.0.1:3001' || !process.env.DATA || !path.isAbsolute(process.env.DATA)
  || process.env.__NEXT_PROCESSED_ENV !== 'true') {
  throw new Error('Agent settings acceptance requires its private isolated fixture and fixed production host.');
}
export default defineConfig({
  testDir: 'tests', testMatch: 'agent-settings-tools-race-local.spec.ts', outputDir: results,
  workers: 1, fullyParallel: false, retries: 0, timeout: 180_000,
  expect: { timeout: 30_000 }, reporter: [['list']],
  use: { baseURL: process.env.BASE_URL, browserName: 'chromium', headless: true,
    viewport: { width: 1280, height: 900 }, actionTimeout: 15_000, navigationTimeout: 45_000,
    trace: 'off', video: 'off', screenshot: 'off' },
});
