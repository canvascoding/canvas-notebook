import { defineConfig } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

loadEnv({ path: '.env.local', quiet: true });

const useExternalServer = process.env.E2E_EXTERNAL_SERVER === '1';
const e2eDataRoot = process.env.E2E_DATA_DIR || mkdtempSync(path.join(os.tmpdir(), 'canvas-notebook-e2e-'));

export default defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    viewport: { width: 1280, height: 720 },
  },
  webServer: useExternalServer
    ? undefined
    : {
      command: 'npm run start',
      port: 3000,
      // Onboarding state is persisted in the database. Reusing a developer
      // server here would make first-run assertions depend on its state.
      reuseExistingServer: false,
      env: {
        ...process.env,
        CANVAS_APP_ROOT: process.cwd(),
        DATA: e2eDataRoot,
        CANVAS_DATA_ROOT: e2eDataRoot,
        ONBOARDING: 'true',
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || 'e2e-only-auth-secret-not-for-production-0001',
      },
    },
});
