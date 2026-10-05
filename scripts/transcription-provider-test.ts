import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';
import { DICTATION_MODELS, type DictationSettings } from '../app/lib/transcription/config';
import { validateDictationSettings } from '../app/lib/dictation/settings';
import { TranscriptionServiceError } from '../app/lib/transcription/errors';
import { convertWisprAudio, wisprAudioConversionAvailable } from '../app/lib/transcription/wav';

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file), load = createRequire(filename), exports = {};
  const source = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', source)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports);
  return exports as T;
}

async function main() {
  let selected: DictationSettings = { enabled: false, provider: 'gemini', model: DICTATION_MODELS.gemini[0], language: 'de' };
  let key: string | null = 'fixture-system-key';
  let status = 200;
  let empty = false;
  let processing = false;
  let conversionAvailable = true;
  let cleanupFailed = false;
  let cancelledOnUpload = false;
  let controller: AbortController | undefined;
  const uploads: unknown[] = [], interactions: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const deletions: unknown[] = [];
  let conversions = 0, requests = 0;
  const fixtureWav = Buffer.alloc(44 + 16_000);
  fixtureWav.write('RIFF', 0); fixtureWav.writeUInt32LE(fixtureWav.length - 8, 4); fixtureWav.write('WAVEfmt ', 8);
  fixtureWav.writeUInt32LE(16, 16); fixtureWav.writeUInt16LE(1, 20); fixtureWav.writeUInt16LE(1, 22);
  fixtureWav.writeUInt32LE(16_000, 24); fixtureWav.writeUInt32LE(32_000, 28); fixtureWav.writeUInt16LE(2, 32);
  fixtureWav.writeUInt16LE(16, 34); fixtureWav.write('data', 36); fixtureWav.writeUInt32LE(16_000, 40);
  const google = { GoogleGenAI: class {
    constructor(options: { apiKey: string }) { assert.equal(options.apiKey, key); }
    files = {
      upload: async (input: { config: { abortSignal: AbortSignal } }) => {
        uploads.push(input);
        if (cancelledOnUpload) controller!.abort();
        return { name: 'files/fixture', uri: 'https://example.test/audio', state: processing ? 'PROCESSING' : 'ACTIVE' };
      },
      get: async () => ({ name: 'files/fixture', uri: 'https://example.test/audio', state: 'ACTIVE' }),
      delete: async (input: unknown) => { deletions.push(input); if (cleanupFailed) throw new Error('fixture cleanup error'); },
    };
    interactions = { create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
      interactions.push({ params, options });
      if (status !== 200) throw Object.assign(new Error('fixture upstream failure; must not expose body'), { status });
      return { output_text: empty ? '' : '  Gemini transcript.  ' };
    } };
  } };
  const providers = await compile<typeof import('../app/lib/transcription/cloud-providers')>('app/lib/transcription/cloud-providers.ts', {
    '@google/genai': google,
    './wav': { convertWisprAudio: async () => { conversions++; return fixtureWav; } },
  });
  const service = await compile<typeof import('../app/lib/transcription/service')>('app/lib/transcription/service.ts', {
    '@/app/lib/dictation/settings': { readDictationSettings: async () => selected, validateDictationSettings },
    '@/app/lib/dictation/credentials': { resolveDictationCredential: async () => ({ value: key }) },
    '@/app/lib/dictation/local-worker': { localDictationAvailable: async () => true },
    '@/app/lib/dictation/runtime-install': { localDictationRuntimeSupported: () => true },
    './cloud-providers': providers,
    './wav': { wisprAudioConversionAvailable: async () => conversionAvailable },
  });
  const sample = { buffer: Buffer.from('fixture browser m4a'), filename: 'dictation.m4a', mimeType: 'audio/mp4' };
  const originalFetch = globalThis.fetch;
  let wisprBody: Record<string, unknown> = {};
  try {
    globalThis.fetch = (async (url, init) => {
      requests++;
      assert.equal(String(url), 'https://platform-api.wisprflow.ai/api/v1/dash/api');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-system-key');
      wisprBody = JSON.parse(String(init?.body));
      assert.deepEqual(Buffer.from(String(wisprBody.audio), 'base64'), fixtureWav);
      return Response.json({ text: empty ? '' : '  Wispr transcript.  ', error: 'untrusted provider body' }, { status });
    }) as typeof fetch;
    for (const provider of ['gemini', 'wispr'] as const) {
      assert.equal(validateDictationSettings({ ...selected, provider, model: DICTATION_MODELS[provider][0] }).provider, provider);
    }
    assert.throws(() => validateDictationSettings({ ...selected, mode: 'unsupported' }));
    assert.throws(() => validateDictationSettings({ ...selected, model: 'gemini-3.5-transcribe-live' }));
    assert.throws(() => validateDictationSettings({ ...selected, provider: 'wispr', model: 'canto' }));
    assert.deepEqual(validateDictationSettings(selected), selected, 'legacy settings need no migration');
    const gemini = await service.transcribeAudio({ ...sample, prompt: ' Canvas, Project X ' });
    assert.equal(gemini.text, 'Gemini transcript.');
    assert.equal(gemini.provider, 'gemini');
    assert.equal((await service.readTranscriptionAvailability()).available, true, 'agent capability works with microphone off');
    assert.equal(interactions[0].params.store, false);
    assert.deepEqual(interactions[0].params.generation_config, { transcription_config: { mode: 'smart', language_codes: ['de'], custom_vocabulary: ['Canvas', 'Project X'] } });
    assert.equal(interactions[0].options.maxRetries, 0);
    assert.ok(interactions[0].options.signal instanceof AbortSignal);
    assert.deepEqual(interactions[0].params.input, [{ type: 'audio', uri: 'https://example.test/audio', mime_type: 'audio/m4a' }]);
    assert.equal(deletions.length, 1);
    selected = { ...selected, mode: 'verbatim', language: 'auto' };
    processing = true;
    await service.transcribeAudio(sample);
    assert.deepEqual(interactions.at(-1)!.params.generation_config, { transcription_config: { mode: 'verbatim' } });
    processing = false;
    for (const code of [401, 403, 429, 500]) {
      status = code;
      const before: number = deletions.length;
      await assert.rejects(service.transcribeAudio(sample), (error: unknown) => {
        assert.ok(error instanceof TranscriptionServiceError);
        assert.equal(error.status, code === 429 ? 429 : 502);
        assert.doesNotMatch(error.message, /untrusted|fixture upstream/);
        return true;
      });
      assert.equal(deletions.length, before + 1, 'failed requests still delete uploaded audio');
    }
    status = 200;
    controller = new AbortController(); cancelledOnUpload = true;
    await assert.rejects(service.transcribeAudio({ ...sample, signal: controller.signal }), (error: unknown) => error instanceof TranscriptionServiceError && error.code === 'TRANSCRIPTION_ABORTED');
    cancelledOnUpload = false;
    empty = true;
    await assert.rejects(service.transcribeAudio(sample), (error: unknown) => error instanceof TranscriptionServiceError && error.code === 'EMPTY_TRANSCRIPT');
    empty = false;
    cleanupFailed = true;
    assert.equal((await service.transcribeAudio(sample)).text, 'Gemini transcript.', 'cleanup failure must not lose a transcript');
    cleanupFailed = false;

    selected = { enabled: false, provider: 'wispr', model: 'flow', language: 'de' };
    assert.equal((await service.transcribeAudio({ ...sample, prompt: 'Canvas; Notebook' })).text, 'Wispr transcript.');
    assert.deepEqual(wisprBody.language, ['de']);
    assert.deepEqual(wisprBody.context, { dictionary_context: ['Canvas', 'Notebook'] });
    assert.equal(wisprBody.model, undefined, 'never invent a selectable Canto ID');
    selected.language = 'auto';
    await service.transcribeAudio(sample);
    assert.equal(wisprBody.language, undefined);
    assert.equal(wisprBody.context, undefined);
    for (const code of [401, 403, 429, 500]) {
      status = code;
      await assert.rejects(service.transcribeAudio(sample), (error: unknown) => error instanceof TranscriptionServiceError && error.status === (code === 429 ? 429 : 502) && !error.message.includes('untrusted'));
    }
    status = 200; empty = true;
    await assert.rejects(service.transcribeAudio(sample), (error: unknown) => error instanceof TranscriptionServiceError && error.code === 'EMPTY_TRANSCRIPT');
    empty = false;
    key = null;
    const before = uploads.length + conversions + requests;
    for (const provider of ['gemini', 'wispr'] as const) {
      selected = { ...selected, provider, model: DICTATION_MODELS[provider][0] };
      assert.equal((await service.readTranscriptionAvailability()).unavailableReason, 'credential_missing');
      await assert.rejects(service.transcribeAudio(sample), /settings\?tab=secrets/);
    }
    assert.equal(uploads.length + conversions + requests, before, 'missing keys never send audio or run conversion');
    key = 'fixture-system-key'; conversionAvailable = false;
    assert.equal((await service.readTranscriptionAvailability()).unavailableReason, 'runtime_unavailable');
  } finally { globalThis.fetch = originalFetch; }

  assert.equal(await wisprAudioConversionAvailable(), true, 'FFmpeg is required for the conversion acceptance test');
  const wav = await convertWisprAudio(fixtureWav, AbortSignal.timeout(10_000));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'canvas-audio-formats-'));
  try {
    const input = path.join(fixtureDir, 'input.wav');
    await writeFile(input, fixtureWav);
    for (const format of ['m4a', 'webm'] as const) {
      const output = path.join(fixtureDir, `recording.${format}`);
      await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', input, '-c:a', format === 'm4a' ? 'aac' : 'libopus', output], { timeout: 10_000 });
      const converted = await convertWisprAudio(await readFile(output), AbortSignal.timeout(10_000));
      assert.equal(converted.readUInt16LE(22), 1, `${format} decodes to mono`);
      assert.equal(converted.readUInt32LE(24), 16_000);
      assert.ok(converted.length > 44, `${format} has audio samples`);
    }
  } finally { await rm(fixtureDir, { recursive: true, force: true }); }
  await assert.rejects(convertWisprAudio(Buffer.from('not audio'), AbortSignal.timeout(10_000)), (error: unknown) => error instanceof TranscriptionServiceError && error.code === 'INVALID_AUDIO');
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(convertWisprAudio(fixtureWav, cancel.signal));
  console.log('transcription-provider-test: Gemini/Wispr dispatch, modes, language, secrets, cleanup, failures and real FFmpeg conversion passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
