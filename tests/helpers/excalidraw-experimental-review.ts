import { expect, test as base, type Browser } from '@playwright/test';
import { open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { authenticateManagedTestPage } from './managed-test-context';

/** Mutation of the instance flag is confined to the attested disposable clone. */
async function verifyPrivateFixture(): Promise<string> {
  const metadataPath = process.env.EXCALIDRAW_E2E_FIXTURE_METADATA;
  expect(metadataPath, 'Review opt-in needs the private fixture receipt.').toBeTruthy();
  const metadata = JSON.parse(await readFile(metadataPath!, 'utf8'));
  expect(metadata.purpose).toBe('isolated-local-Excalidraw-QA-fixture');
  expect(metadata.productionRestoreProof).toBe(false);
  expect(metadata.appRoot).toBe(process.cwd());
  expect(metadata.origin).toBe(process.env.BASE_URL);
  const origin = new URL(metadata.origin);
  expect(origin.hostname).toBe('127.0.0.1');
  expect(origin.protocol).toBe('http:');
  const database = new URL(process.env.DATABASE_URL!);
  expect(database.hostname).toBe('127.0.0.1');
  expect(database.port).toBe('55433');
  expect(database.pathname.slice(1)).toMatch(/^canvas_excalidraw_e2e_[a-f0-9]{16}$/u);
  expect(database.pathname.slice(1)).toBe(metadata.databaseName);
  expect(await realpath(process.env.DATA!)).toBe(await realpath(metadata.dataRoot));
  const directory = await realpath(path.dirname(metadataPath!));
  expect(await realpath(path.dirname(metadata.dataRoot))).toBe(directory);
  const client = new Client({ connectionString: database.toString(), connectionTimeoutMillis: 3_000 });
  await client.connect();
  try {
    const result = await client.query('SELECT oid::text FROM pg_database WHERE datname=current_database()');
    expect(result.rows[0].oid).toBe(metadata.cloneOid);
  } finally { await client.end(); }
  return directory;
}

async function withExperimentalReview(browser: Browser, run: () => Promise<void>) {
  const directory = await verifyPrivateFixture();
  const leasePath = path.join(directory, 'excalidraw-review-qa.lock');
  const lease = await open(leasePath, 'wx', 0o600);
  await lease.writeFile(JSON.stringify({ pid: process.pid, purpose: 'explicit-review-UI-QA' }));
  await lease.sync();
  const context = await browser.newContext({ baseURL: process.env.BASE_URL });
  const page = await context.newPage();
  let initial: boolean | undefined;
  let enabled = false;
  let restoreVerified = true;
  let failure: unknown;
  try {
    await authenticateManagedTestPage(page);
    const session = await page.request.get('/api/auth/get-session');
    expect((await session.json()).user.role).toBe('admin');
    const available = await page.request.get('/api/document-review/availability');
    expect(available.ok()).toBe(true);
    initial = (await available.json()).data.documentReviewEnabled;
    expect(typeof initial).toBe('boolean');
    await page.goto('/en/settings?tab=experimental');
    const toggle = page.locator('#document-review-enabled');
    await expect(toggle).toBeEnabled({ timeout: 30_000 });
    const change = async (value: boolean) => {
      const response = page.waitForResponse(response => response.request().method() === 'PATCH'
        && new URL(response.url()).pathname === '/api/admin/experimental-settings');
      await toggle.click();
      const acknowledged = await response;
      expect(acknowledged.status()).toBe(200);
      expect((await acknowledged.json()).data.documentReviewEnabled).toBe(value);
      await expect(toggle).toHaveAttribute('aria-checked', String(value));
    };
    if (!initial) {
      restoreVerified = false;
      await change(true);
      enabled = true;
    }
    try { await run(); } catch (error) { failure = error; }
    if (enabled) {
      await page.goto('/en/settings?tab=experimental');
      await expect(toggle).toBeEnabled({ timeout: 30_000 });
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await change(false);
    }
    const restored = await page.request.get('/api/document-review/availability');
    expect((await restored.json()).data.documentReviewEnabled).toBe(initial);
    restoreVerified = true;
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Review opt-in and restoration failed.') : error;
  } finally {
    await context.close();
    const held = await lease.stat();
    const current = await open(leasePath, 'r');
    try {
      const stat = await current.stat();
      expect(stat.dev === held.dev && stat.ino === held.ino).toBe(true);
    } finally { await current.close(); }
    // Preserve an unacknowledged flag change and its owner receipt for diagnosis.
    if (restoreVerified) await unlink(leasePath);
    await lease.close();
  }
  if (failure) throw failure;
}

export const test = base.extend<{ explicitExcalidrawReview: void }>({
  explicitExcalidrawReview: [async ({ browser }, run) => {
    if (process.env.EXCALIDRAW_SCENE_E2E !== '1') return run();
    await withExperimentalReview(browser, run);
  }, { auto: true, timeout: 150_000 }],
});
