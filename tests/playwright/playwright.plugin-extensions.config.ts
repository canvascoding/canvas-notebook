import { defineConfig } from '@playwright/test';
import path from 'node:path';

if (process.env.CANVAS_PLUGIN_EXTENSION_E2E !== '1' || process.env.E2E_EXTERNAL_SERVER !== '1'
  || process.env.BASE_URL !== 'http://127.0.0.1:3001' || !process.env.PLUGIN_EXTENSION_E2E_ROOT
  || !path.isAbsolute(process.env.PLUGIN_EXTENSION_E2E_ROOT) || !process.env.PLUGIN_EXTENSION_E2E_FIXTURE) {
  throw new Error('Plugin extension acceptance requires its isolated runner and exact loopback production host.');
}
const root = process.env.PLUGIN_EXTENSION_E2E_ROOT;
if (process.env.PLUGIN_EXTENSION_E2E_FIXTURE !== path.join(root, 'fixture.json')) {
  throw new Error('The acceptance fixture must belong to this exact runner.');
}
const mcpSpki = process.env.PLUGIN_EXTENSION_E2E_MCP_SPKI;
if (!mcpSpki || !/^[A-Za-z0-9+/]{43}=$/u.test(mcpSpki)) {
  throw new Error('The browser only trusts the exact owned MCP provider public key.');
}

export default defineConfig({
  testDir: '..', testMatch: process.env.CANVAS_CHAT_MODEL_E2E === '1' ? ['chat-extension-natural-model.e2e.spec.ts']
    : process.env.CANVAS_CHAT_INLINE_E2E === '1' ? ['agent-extension-editor.e2e.spec.ts', 'chat-inline-references.e2e.spec.ts', 'chat-queue-recovery.e2e.spec.ts']
    : ['plugin-extension-search.e2e.spec.ts', 'agent-extension-editor.e2e.spec.ts', 'agent-extension-choice.e2e.spec.ts'],
  outputDir: path.join(root, 'results'), workers: 1, fullyParallel: false, retries: 0,
  timeout: process.env.CANVAS_CHAT_MODEL_E2E === '1' ? 10 * 60_000 : 180_000,
  expect: { timeout: 30_000 }, reporter: [['list'], ['json', { outputFile: path.join(root, 'playwright-results.json') }]],
  use: { baseURL: process.env.BASE_URL, browserName: 'chromium', headless: true,
    launchOptions: {args: [`--ignore-certificate-errors-spki-list=${mcpSpki}`]},
    viewport: { width: 1280, height: 900 }, actionTimeout: 15_000, navigationTimeout: 45_000,
    trace: 'off', video: 'off', screenshot: 'off' },
});
