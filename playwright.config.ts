import { defineConfig } from '@playwright/test';

const useExternalServer = process.env.E2E_EXTERNAL_SERVER === '1';

export default defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3001',
    viewport: { width: 1280, height: 720 },
  },
  webServer: useExternalServer
    ? undefined
    : {
        command: 'PORT=3001 npm run build && PORT=3001 npm run start',
        port: 3001,
        reuseExistingServer: true,
      },
});
