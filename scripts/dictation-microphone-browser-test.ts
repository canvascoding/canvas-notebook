import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

async function main() {
  const envPath = process.env.CANVAS_MICROPHONE_TEST_ENV_FILE
    || path.join(os.homedir(), '.local/state/canvas-local-team-seat/notebook-host-dev.env');
  const env = parse(await fs.readFile(envPath, 'utf8'));
  const baseURL = process.env.CANVAS_MICROPHONE_TEST_BASE_URL || env.BASE_URL;
  assert.ok(baseURL && ['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Use the managed local test app.');
  assert.ok(env.BOOTSTRAP_ADMIN_EMAIL && env.BOOTSTRAP_ADMIN_PASSWORD, 'Bootstrap test credentials are required.');
  const messages = JSON.parse(await fs.readFile(new URL('../messages/en.json', import.meta.url), 'utf8')).dictation;
  const reportDir = process.env.CANVAS_MICROPHONE_TEST_REPORT_DIR || await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-microphone-browser-'));
  await fs.mkdir(reportDir, { recursive: true });
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const admin = await browser.newContext({ baseURL });
  try {
    const signIn = await admin.request.post('/api/auth/sign-in/email', {
      data: { email: env.BOOTSTRAP_ADMIN_EMAIL, password: env.BOOTSTRAP_ADMIN_PASSWORD },
      headers: { origin: baseURL },
    });
    assert.equal(signIn.status(), 200, 'Bootstrap test login must succeed.');
    const storageState = await admin.storageState();
    const newPage = async (viewport = { width: 1280, height: 900 }): Promise<{ context: BrowserContext; page: Page }> => {
      const context = await browser.newContext({ baseURL, storageState, viewport });
      const page = await context.newPage();
      await page.route('**/api/dictation/status', route => route.fulfill({
        json: { success: true, data: { available: true } },
      }));
      return { context, page };
    };
    const openChat = async (page: Page) => {
      const response = await page.goto('/en/notebook?chat=open', { waitUntil: 'domcontentloaded', timeout: 120_000 });
      assert.equal(response?.status(), 200);
      const mic = page.getByTestId('chat-dictation');
      await expect(mic).toBeEnabled({ timeout: 60_000 });
      return { response: response!, mic };
    };

    // Exercise the real app header, MediaRecorder and upload callback with fake audio.
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const { context, page } = await newPage(viewport);
      try {
        let uploadedBytes = 0;
        await page.route('**/api/dictation/transcribe', async route => {
          const request = route.request();
          const body = request.postDataBuffer();
          assert.ok(body);
          const form = await new Request(`${baseURL}/api/dictation/transcribe`, {
            method: 'POST',
            headers: { 'content-type': request.headers()['content-type'] },
            body: new Uint8Array(body),
          }).formData();
          const audio = form.get('audio');
          assert.ok(audio instanceof Blob);
          assert.ok(audio.type.startsWith('audio/'));
          uploadedBytes = audio.size;
          await route.fulfill({ json: { success: true, data: { text: 'Microphone browser regression passed.' } } });
        });
        const { response, mic } = await openChat(page);
        assert.equal(response.headers()['permissions-policy'], 'camera=(), microphone=(self), geolocation=()');
        const policy = await page.evaluate(() => {
          const documentPolicy = (document as Document & { featurePolicy: { allowsFeature(feature: string): boolean } }).featurePolicy;
          return { microphone: documentPolicy.allowsFeature('microphone'), camera: documentPolicy.allowsFeature('camera'), geolocation: documentPolicy.allowsFeature('geolocation') };
        });
        assert.deepEqual(policy, { microphone: true, camera: false, geolocation: false });
        await mic.click();
        await expect(mic).toHaveAttribute('aria-label', messages.stopRecording);
        await mic.click();
        await expect(page.getByTestId('chat-input')).toHaveValue('Microphone browser regression passed.', { timeout: 15_000 });
        assert.ok(uploadedBytes > 0, 'The browser must upload actual recorded fake audio.');
        await expect(mic).toBeEnabled();
        await expect(page.getByRole('alert').filter({ hasText: messages.microphoneError })).toHaveCount(0);
        await page.screenshot({ path: path.join(reportDir, `recording-${viewport.width}.png`) });
        console.log(`Recording, upload and transcript insertion passed (${viewport.width}px).`);
      } finally { await context.close(); }
    }

    // A same-origin parent reproduces the old policy without rewriting Next's streaming HTML.
    {
      const { context, page } = await newPage();
      try {
        await page.route('**/__microphone-policy-fixture', route => route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html', 'permissions-policy': 'camera=(), microphone=(), geolocation=()' },
          body: '<!doctype html><html><body><iframe title="Policy fixture" src="/en/notebook?chat=open" style="width:100%;height:900px"></iframe></body></html>',
        }));
        await page.goto('/__microphone-policy-fixture');
        const frameUI = page.frameLocator('iframe');
        const mic = frameUI.getByTestId('chat-dictation');
        await expect(mic).toBeEnabled({ timeout: 60_000 });
        const frame = page.frames().find(candidate => new URL(candidate.url()).pathname === '/en/notebook');
        assert.ok(frame);
        assert.equal(await frame.evaluate(() => (document as Document & { featurePolicy: { allowsFeature(feature: string): boolean } }).featurePolicy.allowsFeature('microphone')), false);
        await mic.click();
        await expect(frameUI.getByRole('alert').filter({ hasText: messages.microphonePolicyBlocked })).toBeVisible();
        assert.equal(await frame.evaluate(async () => (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state), 'denied');
        assert.equal(await frame.evaluate(async () => {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            return 'unexpectedly granted';
          } catch (error) { return error instanceof DOMException ? error.name : 'unexpected error'; }
        }), 'NotAllowedError');
        console.log('Original microphone=() policy reproduced and explained in the UI.');
      } finally { await context.close(); }
    }

    {
      const { context, page } = await newPage();
      try {
        await page.addInitScript(() => {
          navigator.mediaDevices.getUserMedia = () => new Promise((_resolve, reject) => {
            window.addEventListener('canvas-test-deny-microphone', () => reject(new DOMException('Fixture capture failure', 'NotAllowedError')), { once: true });
          });
        });
        const { mic } = await openChat(page);
        await mic.click();
        await expect(mic).toBeDisabled();
        await expect(mic).toHaveAttribute('aria-label', messages.microphoneRequesting);
        await page.evaluate(() => window.dispatchEvent(new Event('canvas-test-deny-microphone')));
        await expect(page.getByRole('alert').filter({ hasText: messages.microphonePermissionDenied })).toBeVisible();
        await expect(mic).toBeEnabled();
        console.log('Pending permission has a disabled loading state and recovers after denial.');
      } finally { await context.close(); }
    }

    for (const [errorName, messageKey] of [
      ['NotAllowedError', 'microphonePermissionDenied'],
      ['NotFoundError', 'microphoneNotFound'],
      ['NotReadableError', 'microphoneBusy'],
    ]) {
      const { context, page } = await newPage();
      try {
        await page.addInitScript((name) => {
          navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Fixture capture failure', name); };
        }, errorName);
        const { mic } = await openChat(page);
        await mic.click();
        await expect(page.getByRole('alert').filter({ hasText: messages[messageKey] })).toBeVisible();
        await expect(mic).toBeEnabled();
        await expect(mic).toHaveAttribute('aria-label', messages.startRecording);
      } finally { await context.close(); }
    }
    console.log(`Microphone browser regression passed: desktop/mobile recording, blocked policy and capture errors. Screenshots: ${reportDir}`);
  } finally {
    await admin.close();
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
