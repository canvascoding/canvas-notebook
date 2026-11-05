import { defineConfig } from '@playwright/test';
import ordinary from '../../playwright.config';
import { regularCollaborationFiles, deferredReviewAndUndoFiles } from '../helpers/regular-collaboration-suites.mjs';

export default defineConfig({
  ...ordinary, testDir: '..',
  use: { ...ordinary.use, actionTimeout: 15_000, navigationTimeout: 45_000 },
  testMatch: regularCollaborationFiles.map(file => '**/' + file),
  testIgnore: deferredReviewAndUndoFiles,
  grepInvert: /@owned-yjs|@experimental-review|@experimental-undo|@live-model/u,
  globalSetup: '../helpers/regular-collaboration-global-setup.ts',
  workers: 1, retries: 0,
});
