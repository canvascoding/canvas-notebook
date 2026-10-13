import { defineConfig } from '@playwright/test';
import path from 'node:path';

const fixture = process.env.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE;
const results = process.env.AGENT_SETTINGS_TOOLS_BROWSER_RESULTS;
const input = process.env.CANVAS_NATURAL_MODEL_INPUT;
if (process.env.CANVAS_AGENT_SETTINGS_BROWSER_RUN !== '1' || process.env.CANVAS_AGENT_WORKFLOW_NATURAL_MODEL_RUN !== '1'
  || process.env.CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN !== '1' || process.env.E2E_EXTERNAL_SERVER !== '1'
  || !fixture || !results || !input || ![fixture, results, input].every(value => path.isAbsolute(value))
  || process.env.BASE_URL !== 'http://127.0.0.1:3001' || process.env.__NEXT_PROCESSED_ENV !== 'true'
  || !process.env.INTEGRATION_BROWSER_FIXTURE_URL || process.env.COMPOSIO_BASE_URL !== process.env.INTEGRATION_BROWSER_FIXTURE_URL) {
  throw new Error('Natural shared-workflow acceptance requires its fixed private production-host fixture.');
}
export default defineConfig({
  testDir: '..', testMatch: 'agent-workflow-natural-model-local.spec.ts', outputDir: results,
  workers: 1, fullyParallel: false, retries: 0, timeout: 20 * 60_000, expect: { timeout: 30_000 }, reporter: [['list']],
  use: { baseURL: process.env.BASE_URL, browserName: 'chromium', headless: true,
    viewport: { width: 1280, height: 900 }, actionTimeout: 15_000, navigationTimeout: 45_000,
    trace: 'off', video: 'off', screenshot: 'off' },
});
