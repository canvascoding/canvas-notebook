import { defineConfig } from '@playwright/test';
import path from 'node:path';

const input = process.env.CANVAS_COMPOSIO_LIVE_MODEL_INPUT;
const recovery = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
if (process.env.CANVAS_COMPOSIO_LIVE_MODEL_RUN !== '1' || process.env.BASE_URL !== 'http://127.0.0.1:3001'
  || process.env.E2E_EXTERNAL_SERVER !== '1' || process.env.__NEXT_PROCESSED_ENV !== 'true'
  || !input || !path.isAbsolute(input) || !recovery || !path.isAbsolute(recovery)
  || path.basename(recovery) !== 'recovery.json' || path.dirname(input) !== path.dirname(recovery)
  || process.env.DATA !== path.join(path.dirname(recovery), 'data') || process.env.TMPDIR !== path.join(path.dirname(recovery), 'tmp')
  || process.env.COMPOSIO_BASE_URL || process.env.CANVAS_INTEGRATION_BROWSER_FIXTURE_URL) {
  throw new Error('Live Composio model requires its separate owned production replay fixture.');
}
export default defineConfig({ testDir: '..', testMatch: 'composio-live-model.spec.ts', workers: 1,
  fullyParallel: false, retries: 0, timeout: 20 * 60_000, expect: { timeout: 30_000 },
  outputDir: path.join(path.dirname(recovery), 'live-composio-model-results'), reporter: [['list']],
  use: { baseURL: process.env.BASE_URL, browserName: 'chromium', headless: true,
    viewport: { width: 1280, height: 900 }, trace: 'off', video: 'off', screenshot: 'off',
    actionTimeout: 15_000, navigationTimeout: 45_000 } });
