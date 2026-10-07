import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { chromium, expect } from '@playwright/test';
import type { LocalPreparation } from '../app/lib/dictation/preparation-contract';

async function main() {
  const envFile = process.env.CANVAS_MICROPHONE_TEST_ENV_FILE || path.join(os.homedir(), '.local/state/canvas-local-team-seat/local-dictation-progress-e2e/notebook.env');
  const env = parse(await fs.readFile(envFile, 'utf8'));
  const baseURL = process.env.CANVAS_MICROPHONE_TEST_BASE_URL || env.BASE_URL;
  assert.ok(baseURL && ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname));
  const audio = path.resolve('scripts/fixtures/dictation-self-test.wav');
  const messages = JSON.parse(await fs.readFile('messages/en.json', 'utf8')).dictation;
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-local-dictation-e2e-'));
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${audio}`] });
  const admin = await browser.newContext({ baseURL });
  try {
    assert.equal((await admin.request.post('/api/auth/sign-in/email', {
      data: { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD }, headers: { origin: baseURL },
    })).status(), 200);
    const originalData = (await (await admin.request.get('/api/admin/dictation')).json()).data;
    const originalSettings = originalData.settings;
    const requireDownload = process.env.CANVAS_LOCAL_MODEL_REQUIRE_DOWNLOAD === '1';
    if (requireDownload) assert.ok(!originalData.localInstall.installedModels?.includes('tiny'), 'Fresh-download acceptance requires an absent tiny model.');
    const state = await admin.storageState();
    const observed: LocalPreparation[] = [];
    for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ baseURL, storageState: state, viewport });
      const page = await context.newPage();
      page.on('response', async response => {
        if (response.url().endsWith('/api/admin/dictation/local-test') && response.ok()) {
          const body = await response.json().catch(() => null);
          if (body?.data) observed.push(body.data);
        }
      });
      const openSettings = async () => {
        await page.goto('/en/settings?tab=dictation', { waitUntil: 'domcontentloaded', timeout: 120_000 });
        const panel = page.getByTestId('dictation-settings');
        await expect(panel).toBeVisible({ timeout: 60_000 });
        await panel.locator('#dictation-provider').selectOption('local');
        await panel.locator('#dictation-model').selectOption('tiny');
        await panel.locator('#dictation-language').selectOption('en');
        return panel;
      };
      try {
        let panel = await openSettings();
        const prepare = page.getByTestId('local-model-prepare');
        await expect(prepare).toBeEnabled({ timeout: 30_000 });
        await prepare.click();
        await expect(page.getByRole('progressbar')).toBeVisible({ timeout: 30_000 });
        await page.getByTestId('local-dictation-test').screenshot({ path: path.join(reportDir, `progress-${viewport.width}.png`) });
        // Reload during the real server job. It must continue independently of this page.
        panel = await openSettings();
        await expect(page.getByTestId('local-model-test-transcript')).toContainText(/Americans/iu, { timeout: 180_000 });
        await expect(page.getByTestId('local-model-prepare')).toHaveText('Test model again');
        await expect(page.getByRole('progressbar')).toHaveCount(0);
        await page.getByTestId('local-dictation-test').screenshot({ path: path.join(reportDir, `passed-${viewport.width}.png`) });
        const status = (await (await admin.request.get('/api/admin/dictation/local-test')).json()).data as LocalPreparation;
        assert.equal(status.state, 'succeeded'); assert.equal(status.model, 'tiny');
        assert.ok(status.result?.text.toLowerCase().includes('country'));
        // Change selection; the old model's success must not be presented for another model.
        await panel.locator('#dictation-model').selectOption('base');
        await expect(page.getByTestId('local-model-test-transcript')).toHaveCount(0);
        await panel.locator('#dictation-model').selectOption('tiny');
        await expect(page.getByTestId('local-model-test-transcript')).toContainText(/Americans/iu);
        const microphone = page.getByTestId('local-test-microphone');
        await expect(microphone).toBeEnabled();
        await microphone.click();
        await expect(microphone).toHaveAttribute('aria-label', messages.stopRecording);
        await new Promise(resolve => setTimeout(resolve, 12_000));
        await microphone.click();
        await expect(page.getByTestId('local-recording-transcript')).toContainText(/country/iu, { timeout: 60_000 });
        await page.getByTestId('local-dictation-test').screenshot({ path: path.join(reportDir, `recording-${viewport.width}.png`) });
        assert.deepEqual((await (await admin.request.get('/api/admin/dictation')).json()).data.settings, originalSettings, 'tests never activate the draft provider/model or change microphone enablement');
        console.log(`Real local model preparation, reload recovery, cached retest, selected-model isolation and microphone transcription passed (${viewport.width}px).`);
        // Deterministic transport fixtures cover failure/retry and precise progress rendering.
        // The success/microphone flow above uses the actual server, downloader and ASR.
        let fixture: LocalPreparation = { ...status, state: 'failed', phase: 'failed', message: 'Download interrupted. Please retry.', result: undefined };
        await page.route('**/api/admin/dictation/local-test', async route => {
          if (route.request().method() === 'POST') fixture = { ...fixture, state: 'running', phase: 'downloading', downloadedBytes: 45 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 };
          await route.fulfill({ json: { success: true, data: fixture } });
        });
        await openSettings();
        await expect(page.getByTestId('local-dictation-test').getByText('Download interrupted. Please retry.')).toBeVisible();
        await expect(page.getByTestId('local-model-prepare')).toHaveText(messages.localTestRetry);
        await page.getByTestId('local-model-prepare').click();
        await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '45');
        await expect(page.getByTestId('local-model-prepare')).toBeDisabled();
        fixture = { ...fixture, phase: 'verifying' };
        await expect(page.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow', /.+/u);
        await page.getByTestId('local-dictation-test').screenshot({ path: path.join(reportDir, `retry-${viewport.width}.png`) });
        await page.unroute('**/api/admin/dictation/local-test');
        console.log(`Failure feedback, retry, measured 45% progress and indeterminate verification UI passed (${viewport.width}px; transport fixtures).`);
      } finally { await context.close(); }
    }
    assert.ok(observed.some(job => job.state === 'running'));
    assert.ok(observed.some(job => job.state === 'succeeded'));
    if (requireDownload) assert.ok(observed.some(job => job.phase === 'downloading' && Number(job.totalBytes) > 0 && Number(job.downloadedBytes) > 0), 'Observe actual server-reported download bytes.');
    const anonymous = await browser.newContext({ baseURL });
    try {
      assert.equal((await anonymous.request.get('/api/admin/dictation/local-test')).status(), 401);
      assert.equal((await anonymous.request.post('/api/admin/dictation/local-test', { data: { model: 'tiny' } })).status(), 401);
      assert.equal((await anonymous.request.post('/api/admin/dictation/local-test/recording')).status(), 401);
    } finally { await anonymous.close(); }
    console.log(`local-dictation-browser-test passed. ${requireDownload ? 'Fresh upstream download and ' : ''}actual local ASR were used. Screenshots: ${reportDir}`);
  } finally { await admin.close(); await browser.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
