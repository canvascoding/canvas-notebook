import { defineConfig } from '@playwright/test';
import path from 'node:path';

const fixture = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
const results = process.env.AGENT_SETTINGS_TOOLS_BROWSER_RESULTS;
if (process.env.CANVAS_SHARED_COMPOSIO_DESKTOP_CLIENT_BROWSER_RUN !== '1'
  || process.env.CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN !== '1'
  || process.env.CANVAS_AGENT_SETTINGS_BROWSER_RUN !== '1'
  || process.env.CANVAS_SHARED_MCP_OAUTH_BROWSER_RUN !== undefined
  || process.env.CANVAS_SHARED_MCP_DESKTOP_OAUTH_BROWSER_RUN !== undefined
  || process.env.E2E_EXTERNAL_SERVER !== '1' || process.env.BASE_URL !== 'http://127.0.0.1:3001'
  || process.env.__NEXT_PROCESSED_ENV !== 'true' || !fixture || !path.isAbsolute(fixture)
  || path.basename(fixture) !== 'recovery.json' || results !== path.join(path.dirname(fixture), 'results')
  || process.env.DATA !== path.join(path.dirname(fixture), 'data')
  || process.env.TMPDIR !== path.join(path.dirname(fixture), 'tmp')) {
  throw new Error('Controlled shared Composio client acceptance requires its fixed owned production fixture.');
}

export default defineConfig({
  testDir: 'tests', testMatch: 'shared-composio-desktop-client-local.spec.ts', outputDir: results,
  workers: 1, fullyParallel: false, retries: 0, timeout: 120_000,
  expect: { timeout: 30_000 }, reporter: [['list']],
  use: { baseURL: process.env.BASE_URL, browserName: 'chromium', headless: true,
    viewport: { width: 1280, height: 900 }, actionTimeout: 15_000, navigationTimeout: 45_000,
    trace: 'off', video: 'off', screenshot: 'off' },
});
