import { defineConfig } from '@playwright/test';

// These fixtures bundle the current production components; no app server or
// container is started and no existing local test stack is reused.
export default defineConfig({
  testDir: '..', testMatch: 'editor-mobile-viewport.spec.ts', workers: 1,
  outputDir: '../../test-results',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
