import { defineConfig } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

loadEnv({ path: '.env.local', quiet: true });

const useExternalServer = process.env.E2E_EXTERNAL_SERVER === '1';
const e2eDataRoot = process.env.E2E_DATA_DIR || mkdtempSync(path.join(os.tmpdir(), 'canvas-notebook-e2e-'));
const e2eBaseUrl = process.env.BASE_URL || 'http://localhost:3000';
const e2eCredentialSuffix = randomBytes(8).toString('hex');
const e2eAdminEmail = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || `canvas-e2e-${e2eCredentialSuffix}@local.test`;
const e2eAdminPassword = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || randomBytes(24).toString('base64url');
const e2eAuthSecret = process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET || randomBytes(32).toString('base64url');

// The test server owns an isolated DATA directory, so it needs its own
// per-run credentials. Mirror them into the test workers as well so every
// login helper targets the account created at startup. Explicit test values
// from the environment take precedence for externally managed E2E servers.
process.env.BASE_URL = e2eBaseUrl;
process.env.BETTER_AUTH_BASE_URL ||= e2eBaseUrl;
process.env.BETTER_AUTH_SECRET ||= e2eAuthSecret;
process.env.BOOTSTRAP_ADMIN_EMAIL ||= e2eAdminEmail;
process.env.BOOTSTRAP_ADMIN_PASSWORD ||= e2eAdminPassword;
process.env.TEST_LOGIN_EMAIL ||= e2eAdminEmail;
process.env.TEST_LOGIN_PASSWORD ||= e2eAdminPassword;

export default defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: e2eBaseUrl,
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
        ONBOARDING: process.env.ONBOARDING || 'false',
        BETTER_AUTH_SECRET: e2eAuthSecret,
      },
    },
});
