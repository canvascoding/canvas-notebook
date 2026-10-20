import { defineConfig } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';

if (process.env.EXPORT_MIGRATION_ACCEPTANCE !== '1') {
  throw new Error('Set EXPORT_MIGRATION_ACCEPTANCE=1 after preparing the private source/target snapshots.');
}
const root = process.env.EXPORT_MIGRATION_STATE_DIR
  || path.join(os.homedir(), '.local/state/canvas-local-team-seat/export-migration-99b4');

export default defineConfig({
  testDir: '..', testMatch: 'export-migration-acceptance.spec.ts', workers: 1, fullyParallel: false, retries: 0,
  timeout: 240_000, expect: { timeout: 20_000 },
  outputDir: path.join(root, 'playwright-results'),
  reporter: [['list'], ['json', { outputFile: path.join(root, 'playwright-results.json') }]],
  use: { baseURL: 'http://127.0.0.1:3001', browserName: 'chromium', actionTimeout: 20_000,
    trace: 'off', screenshot: 'off', video: 'off' },
});
