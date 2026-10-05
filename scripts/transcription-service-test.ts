import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

import type { DictationSettings } from '../app/lib/dictation/settings';

async function loadService(mocks: Record<string, unknown>): Promise<typeof import('../app/lib/transcription/service')> {
  const filename = path.resolve('app/lib/transcription/service.ts');
  const load = createRequire(filename);
  const exports = {};
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', source)(
    (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports,
  );
  return exports as typeof import('../app/lib/transcription/service');
}

type LocalInput = { buffer: Buffer; extension: string; model: string; language: string; prompt?: string; signal?: AbortSignal };
type CloudCall = { url: string; init: RequestInit };

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-transcription-service-'));
  const savedEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  let localAvailable = true;
  let localText = '  Local transcript.  ';
  let localError: Error | null = null;
  const localCalls: LocalInput[] = [];
  const cloudCalls: CloudCall[] = [];
  let cloudResponse = async (): Promise<Response> => new Response(JSON.stringify({ text: '  Shared transcript.  ' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  try {
    process.env.CANVAS_DATA_ROOT = dataRoot;
    for (const key of ['DATA', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH', 'INTEGRATIONS_ENV_MASTER_KEY',
      'AGENTS_ENV_MASTER_KEY', 'CANVAS_SECRETS_ENV_PATH', 'CANVAS_SECRETS_MASTER_KEY',
      'OPENAI_API_KEY', 'GROQ_API_KEY', 'GROQ_TRANSCRIPTION_MODEL', 'VOICE_TRANSCRIPTION_MODEL']) delete process.env[key];
    const { replaceScopedEnvEntries } = await import('../app/lib/integrations/env-config');
    const settingsModule = await import('../app/lib/dictation/settings');
    const credentialsModule = await import('../app/lib/dictation/credentials');
    const localWorker = {
      localDictationAvailable: async () => localAvailable,
      transcribeLocally: async (input: LocalInput) => {
        localCalls.push(input);
        if (localError) throw localError;
        return localText;
      },
    };
    const runtime = { localDictationRuntimeSupported: () => true };
    const service = await loadService({
      'server-only': {},
      '@/app/lib/dictation/local-worker': localWorker,
      '../dictation/local-worker': localWorker,
      '@/app/lib/dictation/runtime-install': runtime,
      '../dictation/runtime-install': runtime,
      '@/app/lib/dictation/settings': settingsModule,
      '../dictation/settings': settingsModule,
      '@/app/lib/dictation/credentials': credentialsModule,
      '../dictation/credentials': credentialsModule,
    });
    const sample = { buffer: Buffer.from('fixture audio bytes'), filename: 'meeting.ogg', mimeType: 'audio/ogg' };
    const configure = async (provider: DictationSettings['provider'], model: string, language = 'de', enabled = false) =>
      settingsModule.writeDictationSettings({ enabled, provider, model, language });
    const systemKeys = async (openai: string | null, groq: string | null) => replaceScopedEnvEntries('integrations', [
      ...(openai ? [{ key: 'OPENAI_API_KEY', value: openai }] : []),
      ...(groq ? [{ key: 'GROQ_API_KEY', value: groq }] : []),
    ]);
    globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      assert.ok(init, 'transcription sends an explicit request');
      cloudCalls.push({ url: String(url), init });
      return cloudResponse();
    }) as typeof fetch;

    await systemKeys('fixture-system-openai', 'fixture-system-groq');
    await replaceScopedEnvEntries('integrations', [{ key: 'GROQ_API_KEY', value: 'fixture-personal-groq' },
      { key: 'OPENAI_API_KEY', value: 'fixture-personal-openai' }], { secretScope: 'user', userId: 'alice' });
    process.env.GROQ_TRANSCRIPTION_MODEL = 'legacy-model-must-not-win';
    process.env.VOICE_TRANSCRIPTION_MODEL = 'legacy-voice-model-must-not-win';
    await configure('groq', 'whisper-large-v3', 'de');
    const groq = await service.transcribeAudio(sample);
    assert.equal(groq.text, 'Shared transcript.');
    assert.equal(groq.provider, 'groq');
    assert.equal(groq.model, 'whisper-large-v3', 'central model selection supersedes legacy model ENV');
    assert.ok(Number.isFinite(groq.durationMs) && groq.durationMs >= 0);
    const groqCall = cloudCalls.at(-1)!;
    assert.equal(groqCall.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(new Headers(groqCall.init.headers).get('authorization'), 'Bearer fixture-system-groq');
    assert.ok(groqCall.init.body instanceof FormData);
    assert.equal(groqCall.init.body.get('language'), 'de', 'all callers inherit the central language');
    assert.equal(groqCall.init.body.get('model'), 'whisper-large-v3');
    assert.ok(groqCall.init.body.get('file') instanceof Blob);
    assert.ok(groqCall.init.signal instanceof AbortSignal, 'cloud requests have a timeout even without caller cancellation');
    assert.equal((await service.readTranscriptionAvailability()).available, true,
      'disabling the microphone does not disable the agent transcription capability');

    await configure('openai', 'gpt-4o-mini-transcribe', 'auto');
    const openai = await service.transcribeAudio({ ...sample, language: ' EN ', prompt: '  Canvas vocabulary  ' });
    assert.equal(openai.provider, 'openai', 'a settings change reaches the next request');
    assert.equal(openai.model, 'gpt-4o-mini-transcribe');
    const openaiCall = cloudCalls.at(-1)!;
    assert.equal(openaiCall.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(new Headers(openaiCall.init.headers).get('authorization'), 'Bearer fixture-system-openai');
    assert.ok(openaiCall.init.body instanceof FormData);
    assert.equal(openaiCall.init.body.get('language'), 'en');
    assert.equal(openaiCall.init.body.get('prompt'), 'Canvas vocabulary');
    await service.transcribeAudio(sample);
    assert.ok(cloudCalls.at(-1)!.init.body instanceof FormData);
    assert.equal((cloudCalls.at(-1)!.init.body as FormData).get('language'), null, 'auto language leaves detection to the provider');

    const caller = new AbortController();
    await configure('local', 'small', 'de');
    const beforeLocalCloud = cloudCalls.length;
    const local = await service.transcribeAudio({ ...sample, language: 'en', prompt: 'Canvas words', signal: caller.signal });
    assert.equal(local.provider, 'local');
    assert.equal(local.model, 'small');
    assert.equal(local.text, 'Local transcript.');
    assert.equal(cloudCalls.length, beforeLocalCloud, 'local selection never sends audio to a cloud provider');
    assert.equal(localCalls.at(-1)!.language, 'en');
    assert.equal(localCalls.at(-1)!.prompt, 'Canvas words');
    assert.equal(localCalls.at(-1)!.signal, caller.signal);
    assert.deepEqual(localCalls.at(-1)!.buffer, sample.buffer);
    await service.transcribeAudio(sample);
    assert.equal(localCalls.at(-1)!.language, 'de', 'local requests inherit the same configured language');

    const formats = [
      ['audio/webm;codecs=opus', 'recording.webm'], ['video/webm', 'recording.webm'],
      ['audio/ogg; codecs=opus', 'recording.ogg'], ['audio/opus', 'recording.opus'],
      ['audio/aac', 'recording.aac'], ['audio/flac', 'recording.flac'], ['audio/x-flac', 'recording.flac'],
      ['audio/mp4', 'recording.m4a'], ['audio/mpeg', 'recording.mp3'],
      ['audio/wav', 'recording.wav'], ['audio/x-wav', 'recording.wav'],
      ['application/octet-stream', 'recording.oga'],
    ];
    for (const [mimeType, filename] of formats) {
      await service.transcribeAudio({ ...sample, mimeType, filename });
      assert.match(localCalls.at(-1)!.extension, /^\.(webm|ogg|opus|aac|flac|m4a|mp3|wav)$/u,
        `${mimeType} has a supported local audio extension`);
    }

    const beforeInvalid = localCalls.length + cloudCalls.length;
    for (const [request, status] of [
      [{ ...sample, buffer: Buffer.alloc(0) }, 400],
      [{ ...sample, buffer: Buffer.alloc(25 * 1024 * 1024 + 1) }, 413],
      [{ ...sample, filename: 'notes.txt', mimeType: 'text/plain' }, 400],
      [{ ...sample, language: 'german' }, 400],
      [{ ...sample, language: 'en-US' }, 400],
    ] as const) await assert.rejects(service.transcribeAudio(request), (error: unknown) => {
      assert.ok(error instanceof service.TranscriptionServiceError);
      assert.equal(error.status, status);
      return true;
    });
    await assert.rejects(service.transcribeAudio(sample, { enabled: false, provider: 'groq', model: 'bogus', language: 'auto' }));
    assert.equal(localCalls.length + cloudCalls.length, beforeInvalid, 'invalid input is rejected before provider invocation');

    localAvailable = false;
    const unavailable = await service.readTranscriptionAvailability();
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.provider, 'local');
    assert.ok(unavailable.reason);
    const beforeUnavailable = cloudCalls.length;
    await assert.rejects(service.transcribeAudio(sample), (error: unknown) => {
      assert.ok(error instanceof service.TranscriptionServiceError);
      assert.equal(error.status, 503);
      return true;
    });
    assert.equal(cloudCalls.length, beforeUnavailable, 'missing local models never trigger cloud fallback');
    localAvailable = true;
    localText = ' \n ';
    await assert.rejects(service.transcribeAudio(sample), /text|transcript/i, 'empty local transcripts use the shared failure contract');
    localText = 'Local transcript.';
    localError = Object.assign(new Error('Local transcription timed out.'), { name: 'TimeoutError' });
    await assert.rejects(service.transcribeAudio(sample), (error: unknown) => {
      assert.ok(error instanceof service.TranscriptionServiceError);
      assert.equal(error.status, 504, 'local timeouts use the same service timeout contract as cloud requests');
      assert.equal(error.code, 'TRANSCRIPTION_TIMEOUT');
      return true;
    });
    localError = null;

    await configure('openai', 'whisper-1', 'auto');
    await systemKeys(null, 'fixture-system-groq');
    const missingKey = await service.readTranscriptionAvailability();
    assert.equal(missingKey.available, false, 'a personal OpenAI key cannot configure the system service');
    assert.equal(missingKey.provider, 'openai');
    assert.match(missingKey.reason!, /OPENAI_API_KEY|credential/i);
    const beforeMissingKey = cloudCalls.length;
    await assert.rejects(service.transcribeAudio(sample), /OPENAI_API_KEY|configured|credential/i);
    assert.equal(cloudCalls.length, beforeMissingKey, 'a configured alternate provider is not a fallback');

    await systemKeys('fixture-system-openai', 'fixture-system-groq');
    cloudResponse = async () => new Response(JSON.stringify({ text: '  ' }), { status: 200 });
    await assert.rejects(service.transcribeAudio(sample), /text|transcript/i);
    cloudResponse = async () => new Response(JSON.stringify({ error: { message: 'Fixture provider failure' } }), { status: 429 });
    await assert.rejects(service.transcribeAudio(sample), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /429|Fixture provider failure|failed/i);
      return true;
    });

    const preAborted = new AbortController();
    preAborted.abort();
    const beforeAbort = cloudCalls.length;
    await assert.rejects(service.transcribeAudio({ ...sample, signal: preAborted.signal }), (error: unknown) => {
      assert.ok(error instanceof service.TranscriptionServiceError);
      assert.equal(error.status, 499);
      return true;
    });
    assert.equal(cloudCalls.length, beforeAbort, 'pre-aborted calls never invoke the provider');

    globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      assert.ok(init?.signal);
      cloudCalls.push({ url: String(url), init });
      return new Promise<Response>((_resolve, reject) => {
        if (init.signal!.aborted) { reject(init.signal!.reason); return; }
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    }) as typeof fetch;
    const activeAbort = new AbortController();
    const activeRequest = service.transcribeAudio({ ...sample, signal: activeAbort.signal });
    void activeRequest.catch(() => undefined);
    // Reach the provider request before canceling so this verifies in-flight propagation.
    for (let attempt = 0; attempt < 2_000 && cloudCalls.length === beforeAbort; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    activeAbort.abort();
    await assert.rejects(activeRequest, (error: unknown) => {
      assert.ok(error instanceof service.TranscriptionServiceError);
      assert.equal(error.status, 499);
      return true;
    });
    assert.ok(cloudCalls.length > beforeAbort, 'the configured request reached the cloud transport before cancellation');
    assert.ok(cloudCalls.at(-1)!.init.signal!.aborted);
    AbortSignal.timeout = (milliseconds: number) => {
      assert.equal(milliseconds, 90_000, 'cloud requests retain the shared 90-second budget');
      return originalTimeout(10);
    };
    const keepAlive = setTimeout(() => {}, 1_000);
    try {
      await assert.rejects(service.transcribeAudio(sample), (error: unknown) => {
        assert.ok(error instanceof service.TranscriptionServiceError);
        assert.equal(error.status, 504);
        return true;
      });
      assert.ok(cloudCalls.at(-1)!.init.signal!.aborted, 'timeout reaches the cloud transport');
    } finally { clearTimeout(keepAlive); }
    console.log('transcription-service-test: central provider/model/language, system credentials, local isolation, formats, validation and cancellation passed');
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
