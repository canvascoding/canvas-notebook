import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { chromium, expect } from '@playwright/test';
import { DICTATION_MODELS, TRANSCRIPTION_API_KEYS, type DictationSettings, type CloudDictationProvider } from '../app/lib/transcription/config';

async function main() {
  const envPath = process.env.CANVAS_MICROPHONE_TEST_ENV_FILE || path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env');
  const env = parse(await fs.readFile(envPath, 'utf8'));
  const baseURL = process.env.CANVAS_MICROPHONE_TEST_BASE_URL || env.BASE_URL;
  assert.ok(baseURL && ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname));
  assert.ok(env.BOOTSTRAP_ADMIN_EMAIL && env.BOOTSTRAP_ADMIN_PASSWORD);
  const browser = await chromium.launch({ headless: true });
  const admin = await browser.newContext({ baseURL });
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-transcription-settings-'));
  try {
    assert.equal((await admin.request.post('/api/auth/sign-in/email', {
      data: { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD }, headers: { origin: baseURL },
    })).status(), 200);
    const bootstrapResponse = await admin.request.get('/api/mobile/v1/bootstrap');
    assert.equal(bootstrapResponse.status(), 200);
    const bootstrap = await bootstrapResponse.json();
    assert.ok(bootstrap.mobileApi.capabilities.includes('chat.dictation.v1'));
    assert.ok((await (await admin.request.get('/api/mobile/v1/compatibility')).json()).mobileApi.capabilities.includes('chat.dictation.v1'));
    const workspaceId = bootstrap.workspace.defaultWorkspaceId || bootstrap.workspace.activeWorkspaceId;
    assert.ok(workspaceId);
    const availabilityResponse = await admin.request.get('/api/mobile/v1/dictation/availability', {
      headers: { 'X-Canvas-Workspace-Id': workspaceId },
    });
    assert.equal(availabilityResponse.status(), 200);
    assert.match(availabilityResponse.headers()['cache-control'], /no-store/);
    const availability = await availabilityResponse.json();
    assert.equal(availability.contractVersion, 1);
    assert.equal(availability.workspaceId, workspaceId);
    assert.equal(typeof availability.availability.available, 'boolean');
    assert.ok(['local', 'openai', 'groq', 'gemini', 'wispr'].includes(availability.availability.transcriptionProvider));
    const anonymous = await browser.newContext({ baseURL });
    try { assert.equal((await anonymous.request.get('/api/mobile/v1/dictation/availability')).status(), 401); }
    finally { await anonymous.close(); }
    console.log('Live mobile bootstrap capability, workspace-scoped availability and authentication passed.');
    const storageState = await admin.storageState();
    for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ baseURL, storageState, viewport });
      const page = await context.newPage();
      let settings: DictationSettings = { enabled: false, provider: 'openai', model: 'whisper-1', language: 'auto' };
      const credentials = Object.fromEntries(Object.keys(TRANSCRIPTION_API_KEYS).map(provider => [provider, { configured: false, source: null as string | null }]));
      const saved: DictationSettings[] = [];
      const keys: string[] = [];
      const data = () => ({ settings, status: { available: false, reason: null },
        transcriptionStatus: { available: settings.provider !== 'local' && credentials[settings.provider].configured, reason: 'Missing system key. Configure it in /settings?tab=secrets.' },
        credentials, localInstall: { state: 'missing' },
      });
      try {
        // All settings/key writes are fixtures. Never modify the shared instance or call providers.
        await page.route('**/api/admin/dictation', async route => {
          if (route.request().method() === 'PATCH') {
            settings = route.request().postDataJSON(); saved.push(settings);
            assert.ok(DICTATION_MODELS[settings.provider].includes(settings.model));
          } else assert.equal(route.request().method(), 'GET');
          await route.fulfill({ json: { success: true, data: data() } });
        });
        await page.route('**/api/admin/dictation/credential', async route => {
          const body = route.request().postDataJSON() as { provider: CloudDictationProvider; apiKey: string };
          assert.equal(route.request().method(), 'PUT');
          assert.equal(body.apiKey, 'fixture-api-key-never-stored');
          keys.push(body.provider); credentials[body.provider] = { configured: true, source: 'integrations' };
          await route.fulfill({ json: { success: true, data: { credentials, status: data().status, transcriptionStatus: data().transcriptionStatus } } });
        });
        await page.goto('/en/settings?tab=dictation', { waitUntil: 'domcontentloaded', timeout: 120_000 });
        const panel = page.getByTestId('dictation-settings');
        await expect(panel).toBeVisible({ timeout: 60_000 });
        const provider = panel.locator('#dictation-provider');
        await provider.selectOption('gemini');
        await expect(panel.locator('#dictation-model')).toHaveValue('gemini-3.5-transcribe');
        await expect(panel.locator('#dictation-mode')).toHaveValue('smart');
        await panel.locator('#dictation-mode').selectOption('verbatim');
        await panel.locator('#dictation-language').selectOption('de');
        await expect(panel.getByText('GEMINI_API_KEY', { exact: true })).toBeVisible();
        await expect(panel.getByRole('link', { name: 'Manage Secrets' })).toHaveAttribute('href', '/settings?tab=secrets');
        await panel.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(panel.getByText('Saved', { exact: true })).toBeVisible();
        assert.equal(saved.at(-1)?.provider, 'gemini'); assert.equal(saved.at(-1)?.mode, 'verbatim');
        await panel.locator('#dictation-api-key').fill('fixture-api-key-never-stored');
        await expect(panel.locator('#dictation-api-key')).toHaveAttribute('type', 'password');
        await panel.getByRole('button', { name: 'Save API key', exact: true }).click();
        await expect(panel.getByText('System key saved.', { exact: true })).toBeVisible();
        await expect(panel.locator('#dictation-api-key')).toHaveValue('');
        await provider.selectOption('wispr');
        await expect(panel.locator('#dictation-mode')).toHaveCount(0);
        await expect(panel.locator('#dictation-model')).toHaveValue('flow');
        await expect(panel.getByText('WISPR_API_KEY', { exact: true })).toBeVisible();
        await expect(panel.getByRole('link', { name: 'Request API access' })).toHaveAttribute('href', 'https://api-docs.wisprflow.ai/quickstart');
        await expect(panel.getByText(/requires approval from Wispr/)).toBeVisible();
        await panel.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(panel.getByText('Saved', { exact: true })).toBeVisible();
        assert.equal(saved.at(-1)?.provider, 'wispr');
        await panel.locator('#dictation-api-key').fill('fixture-api-key-never-stored');
        await panel.getByRole('button', { name: 'Save API key', exact: true }).click();
        await expect(panel.getByText('System key saved.', { exact: true })).toBeVisible();
        assert.deepEqual(keys, ['gemini', 'wispr']);
        await panel.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(panel.getByText(/API access is checked/)).toBeVisible();
        await expect(panel.locator('#dictation-enabled')).toHaveAttribute('aria-checked', 'false');
        await panel.screenshot({ path: path.join(reportDir, `settings-${viewport.width}.png`) });
        console.log(`Gemini/Wispr settings, modes and central key UX passed (${viewport.width}px).`);
      } finally { await context.close(); }
    }
    console.log(`transcription-settings-browser-test passed. Screenshots: ${reportDir}`);
  } finally { await admin.close(); await browser.close(); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
