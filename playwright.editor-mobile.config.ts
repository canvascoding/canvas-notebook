import { defineConfig } from '@playwright/test';

// These fixtures bundle the current production components; no app server or
// container is started and no existing local test stack is reused.
export default defineConfig({
  testDir: 'tests', testMatch: 'editor-mobile-viewport.spec.ts', workers: 1,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
