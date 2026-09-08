import { defineConfig } from '@playwright/test';

// Real UI components with deterministic status events; no server or containers.
export default defineConfig({
  testDir: 'tests',
  testMatch: 'context-status-consistency.spec.ts',
  workers: 1,
  timeout: 45_000,
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true } },
  ],
});
