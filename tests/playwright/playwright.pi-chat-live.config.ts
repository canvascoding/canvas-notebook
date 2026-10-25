import { defineConfig } from '@playwright/test';
import { requireLivePiChatTarget } from '../helpers/managed-acceptance-suites.mjs';

// Validate the opt-in before loading tests or credentials. This config owns no
// server and never falls back to another running development environment.
const baseURL = requireLivePiChatTarget();
export default defineConfig({
  testDir: '..', testMatch: 'pi-chat.spec.ts', grep: /@live-model/u,
  workers: 1, fullyParallel: false, retries: 0, timeout: 180_000,
  reporter: [['list']],
  use: { baseURL, viewport: { width: 1280, height: 720 }, trace: 'off', video: 'off', screenshot: 'off' },
});
