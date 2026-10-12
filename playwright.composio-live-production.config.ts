import { defineConfig } from '@playwright/test';
import path from 'node:path';

const fixture = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
if (process.env.CANVAS_COMPOSIO_LIVE_BROWSER_RUN !== '1' || process.env.BASE_URL !== 'http://127.0.0.1:3001'
  || process.env.E2E_EXTERNAL_SERVER !== '1' || process.env.__NEXT_PROCESSED_ENV !== 'true'
  || !fixture || !path.isAbsolute(fixture) || path.basename(fixture) !== 'recovery.json'
  || process.env.DATA !== path.join(path.dirname(fixture), 'data')
  || process.env.TMPDIR !== path.join(path.dirname(fixture), 'tmp') || process.env.COMPOSIO_BASE_URL) {
  throw new Error('Live Composio requires the separate owned production fixture.');
}
export default defineConfig({ testDir: 'tests', testMatch: 'composio-live.spec.ts', workers: 1,
  fullyParallel: false, retries: 0, timeout: 20 * 60_000, expect: { timeout: 30_000 },
  outputDir: path.join(path.dirname(fixture), 'results'), reporter: [['list']],
  use: { baseURL: process.env.BASE_URL, browserName: 'chromium', headless: true,
    viewport: { width: 1280, height: 900 }, trace: 'off', video: 'off', screenshot: 'off',
    actionTimeout: 15_000, navigationTimeout: 45_000 } });
