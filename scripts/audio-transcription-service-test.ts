import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-audio-transcription-'));
  const originalFetch = globalThis.fetch;
  const originalCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  const originalIntegrationsEnvPath = process.env.INTEGRATIONS_ENV_PATH;
  const originalGroqApiKey = process.env.GROQ_API_KEY;
  const originalGroqModel = process.env.GROQ_TRANSCRIPTION_MODEL;
  const envPath = path.join(tempRoot, 'secrets', 'Canvas-Integrations.env');

  try {
    process.env.CANVAS_DATA_ROOT = tempRoot;
    process.env.INTEGRATIONS_ENV_PATH = envPath;
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_TRANSCRIPTION_MODEL;

    await fs.mkdir(path.dirname(envPath), { recursive: true });
    await fs.writeFile(envPath, 'GROQ_API_KEY=test-groq-key\nGROQ_TRANSCRIPTION_MODEL=whisper-large-v3\n', 'utf8');

    const { transcribeAudio } = await import('../app/lib/integrations/audio-transcription-service');

    let capturedUrl = '';
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody: BodyInit | null | undefined;
    globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = init?.headers;
      capturedBody = init?.body;
      return new Response(JSON.stringify({ text: 'Hallo Welt.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await transcribeAudio({
      buffer: Buffer.from('fake audio bytes'),
      filename: 'voice.ogg',
      mimeType: 'audio/ogg',
      language: 'de',
      prompt: 'Canvas vocabulary',
    });

    assert.equal(result.text, 'Hallo Welt.');
    assert.equal(result.provider, 'groq');
    assert.equal(result.model, 'whisper-large-v3');
    assert.equal(capturedUrl, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.deepEqual(capturedHeaders, { Authorization: 'Bearer test-groq-key' });
    assert.ok(capturedBody instanceof FormData);
    const formData = capturedBody;
    assert.equal(formData.get('model'), 'whisper-large-v3');
    assert.equal(formData.get('response_format'), 'json');
    assert.equal(formData.get('language'), 'de');
    assert.equal(formData.get('prompt'), 'Canvas vocabulary');
    assert.ok(formData.get('file') instanceof Blob);

    await fs.writeFile(envPath, '', 'utf8');
    await assert.rejects(
      () => transcribeAudio({
        buffer: Buffer.from('fake audio bytes'),
        filename: 'voice.ogg',
        mimeType: 'audio/ogg',
      }),
      /GROQ_API_KEY/,
    );

    console.log('audio transcription service tests passed');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('CANVAS_DATA_ROOT', originalCanvasDataRoot);
    restoreEnv('INTEGRATIONS_ENV_PATH', originalIntegrationsEnvPath);
    restoreEnv('GROQ_API_KEY', originalGroqApiKey);
    restoreEnv('GROQ_TRANSCRIPTION_MODEL', originalGroqModel);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
