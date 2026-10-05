import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';

import type { DictationSettings } from '../app/lib/dictation/settings';
import type { TranscribeAudioRequest } from '../app/lib/transcription/service';

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const exports = {};
  const source = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports,
  );
  return exports as T;
}

async function main(): Promise<void> {
  const { TranscriptionServiceError, MAX_AUDIO_TRANSCRIPTION_BYTES } = await import('../app/lib/transcription/service');
  const settings: DictationSettings = { enabled: true, provider: 'groq', model: 'whisper-large-v3', language: 'de' };
  const controls = { signedIn: true, limited: false, available: true, error: null as Error | null };
  let settingsReads = 0;
  let availabilityReads = 0;
  const calls: Array<{ request: TranscribeAudioRequest; settings: DictationSettings }> = [];
  const settingsModule = { readDictationSettings: async () => { settingsReads++; return settings; } };
  const canonicalService = {
    MAX_AUDIO_TRANSCRIPTION_BYTES,
    TranscriptionServiceError,
    readTranscriptionAvailability: async (selected: DictationSettings) => {
      availabilityReads++;
      return { available: controls.available, provider: selected.provider, model: selected.model,
        reason: controls.available ? null : 'Install the selected model.', code: controls.available ? null : 'TRANSCRIPTION_UNAVAILABLE' };
    },
    transcribeAudio: async (request: TranscribeAudioRequest, selected: DictationSettings) => {
      calls.push({ request, settings: selected });
      if (controls.error) throw controls.error;
      return { text: 'Shared transcript.', provider: selected.provider, model: selected.model, durationMs: 12 };
    },
  };
  const adapter = await compile<typeof import('../app/lib/dictation/service')>('app/lib/dictation/service.ts', {
    'server-only': {}, './settings': settingsModule,
    '@/app/lib/transcription/service': canonicalService,
  });
  const route = await compile<typeof import('../app/api/dictation/transcribe/route')>('app/api/dictation/transcribe/route.ts', {
    '@/app/lib/auth': { auth: { api: { getSession: async () => controls.signedIn ? { user: { id: 'fixture-user' } } : null } } },
    '@/app/lib/dictation/settings': settingsModule,
    '@/app/lib/dictation/service': adapter,
    '@/app/lib/transcription/service': canonicalService,
    '@/app/lib/utils/rate-limit': { rateLimit: (_request: NextRequest, options: { keyPrefix: string }) => {
      assert.equal(options.keyPrefix, 'dictation:fixture-user', 'dictation retains its authenticated per-user rate limit');
      return controls.limited ? { ok: false, response: NextResponse.json({ success: false }, { status: 429 }) } : { ok: true };
    } },
  });
  const audio = (size = 5, name = 'meeting.webm', type = 'audio/webm;codecs=opus') =>
    new File([new Uint8Array(size)], name, { type });
  const request = (file?: File, headers?: HeadersInit) => {
    const form = new FormData();
    if (file) form.set('audio', file);
    return new NextRequest('https://canvas.example.test/api/dictation/transcribe', { method: 'POST', body: form, headers });
  };

  controls.signedIn = false;
  assert.equal((await route.POST(request(audio()))).status, 401);
  assert.equal(settingsReads, 0, 'anonymous uploads never load instance settings');
  assert.equal(calls.length, 0);
  controls.signedIn = true;

  settings.enabled = false;
  assert.equal((await route.POST(request(audio()))).status, 503);
  assert.equal(availabilityReads, 0, 'microphone disable is handled by the adapter before core availability');
  await assert.rejects(adapter.transcribeDictationFile(audio(), settings), (error: unknown) => {
    assert.ok(error instanceof TranscriptionServiceError);
    assert.equal(error.code, 'DICTATION_DISABLED');
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(calls.length, 0, 'disabled microphone cannot invoke the canonical service');
  settings.enabled = true;

  controls.available = false;
  assert.equal((await route.POST(request(audio()))).status, 503);
  assert.equal(calls.length, 0, 'unavailable providers reject before reading/transcribing an upload');
  controls.available = true;
  controls.limited = true;
  assert.equal((await route.POST(request(audio()))).status, 429);
  assert.equal(calls.length, 0);
  controls.limited = false;
  assert.equal((await route.POST(request())).status, 400);
  assert.equal((await route.POST(request(audio(), { 'content-length': String(MAX_AUDIO_TRANSCRIPTION_BYTES + 100_001) }))).status, 413);
  assert.equal(calls.length, 0, 'missing and oversized request bodies never reach transcription');

  const successRequest = request(audio());
  const success = await route.POST(successRequest);
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await success.json(), { success: true, data: { text: 'Shared transcript.' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].settings, settings, 'the route passes its settings snapshot through the real adapter');
  assert.equal(calls[0].request.filename, 'meeting.webm');
  assert.equal(calls[0].request.mimeType, 'audio/webm;codecs=opus');
  assert.deepEqual(calls[0].request.buffer, Buffer.alloc(5));
  assert.equal(calls[0].request.signal, successRequest.signal, 'request cancellation reaches the canonical service');

  const bodyAbort = new AbortController();
  const abortedUpload = new NextRequest('https://canvas.example.test/api/dictation/transcribe', {
    method: 'POST', body: new FormData(), signal: bodyAbort.signal,
  });
  Object.defineProperty(abortedUpload, 'formData', { value: async () => {
    bodyAbort.abort();
    throw new DOMException('Fixture multipart upload was cancelled.', 'AbortError');
  } });
  const beforeBodyAbort = calls.length;
  const bodyAbortResponse = await route.POST(abortedUpload);
  assert.equal(bodyAbortResponse.status, 499, 'cancellation while parsing multipart input is not a provider failure');
  assert.equal((await bodyAbortResponse.json()).code, 'TRANSCRIPTION_ABORTED');
  assert.equal(calls.length, beforeBodyAbort, 'a cancelled upload never invokes the canonical service');

  const beforeSizeChecks = calls.length;
  for (const [file, expectedStatus] of [[audio(0), 400], [audio(MAX_AUDIO_TRANSCRIPTION_BYTES + 1), 413]] as const) {
    const response = await route.POST(request(file));
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).code, 'INVALID_AUDIO_SIZE');
  }
  assert.equal(calls.length, beforeSizeChecks, 'the adapter rejects empty and oversized files before allocating provider buffers');

  for (const [code, status, message] of [
    ['UNSUPPORTED_AUDIO_FORMAT', 400, 'Unsupported audio format.'],
    ['AUDIO_TOO_LARGE', 413, 'Audio file is too large.'],
    ['TRANSCRIPTION_ABORTED', 499, 'Transcription was cancelled.'],
    ['TRANSCRIPTION_TIMEOUT', 504, 'Transcription timed out.'],
    ['EMPTY_TRANSCRIPT', 502, 'Transcription completed without transcript text.'],
  ] as const) {
    controls.error = new TranscriptionServiceError(message, code, status);
    const response = await route.POST(request(audio()));
    assert.equal(response.status, status, `the route preserves canonical ${code} status`);
    assert.deepEqual(await response.json(), { success: false, error: message, code });
  }
  console.log('transcription-route-test: authentication, microphone gate, readiness/rate limits, actual adapter dispatch, signal and shared error mapping passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
