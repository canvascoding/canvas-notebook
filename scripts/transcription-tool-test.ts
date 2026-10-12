import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

import type { DictationSettings } from '../app/lib/dictation/settings';

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const load = createRequire(filename);
  const exports = {};
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', source)(
    (name: string) => {
      assert.notEqual(name, '@/app/lib/integrations/audio-transcription-service', 'agent transcription must not import the legacy Groq service');
      return Object.hasOwn(mocks, name) ? mocks[name] : load(name);
    }, { exports }, exports,
  );
  return exports as T;
}

type LocalInput = { buffer: Buffer; extension: string; model: string; language: string; prompt?: string; signal?: AbortSignal };
type Details = { filePath?: string; provider?: string; model?: string; transcript?: string; durationMs?: number;
  error?: string; code?: string; status?: number };

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-transcription-tool-'));
  const workspace = path.join(root, 'workspace');
  const savedEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const events: string[] = [];
  const cloudCalls: Array<{ url: string; init: RequestInit }> = [];
  const localCalls: LocalInput[] = [];
  const controls = { denied: false, oversize: false, localAvailable: true, cloudText: 'Shared audio transcript.', localText: 'Local audio transcript.' };
  let executionContextReads = 0;
  try {
    process.env.CANVAS_DATA_ROOT = root;
    for (const key of ['DATA', 'INTEGRATIONS_ENV_PATH', 'AGENTS_ENV_PATH', 'INTEGRATIONS_ENV_MASTER_KEY',
      'AGENTS_ENV_MASTER_KEY', 'CANVAS_SECRETS_ENV_PATH', 'CANVAS_SECRETS_MASTER_KEY',
      'OPENAI_API_KEY', 'GROQ_API_KEY', 'GROQ_TRANSCRIPTION_MODEL', 'VOICE_TRANSCRIPTION_MODEL']) delete process.env[key];
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'meeting.ogg'), 'fixture audio bytes');
    await fs.writeFile(path.join(workspace, 'empty.wav'), '');
    await fs.writeFile(path.join(workspace, 'notes.txt'), 'not an audio format');
    const envModule = await import('../app/lib/integrations/env-config');
    const settingsModule = await import('../app/lib/dictation/settings');
    const credentialsModule = await import('../app/lib/dictation/credentials');
    const canonical = await compile<typeof import('../app/lib/transcription/service')>('app/lib/transcription/service.ts', {
      'server-only': {},
      '@/app/lib/dictation/settings': settingsModule,
      '@/app/lib/dictation/credentials': credentialsModule,
      '@/app/lib/dictation/runtime-install': { localDictationRuntimeSupported: () => true },
      '@/app/lib/dictation/local-worker': {
        localDictationAvailable: async () => controls.localAvailable,
        transcribeLocally: async (input: LocalInput) => { events.push('provider'); localCalls.push(input); return controls.localText; },
      },
    });
    const unrelatedStudioModules = Object.fromEntries([
      'studio-generation-service', 'studio-product-service', 'studio-persona-service', 'studio-style-service',
      'studio-workspace', 'studio-bulk-service', 'studio-preset-service', 'studio-scope', 'studio-workspace-file-migration',
    ].map(name => [`@/app/lib/integrations/${name}`, {}]));
    const tools = await compile<typeof import('../app/lib/pi/studio-tools')>('app/lib/pi/studio-tools.ts', {
      ...unrelatedStudioModules,
      '@/app/lib/utils/media-url': {},
      '@/app/lib/transcription/service': canonical,
      '@/app/lib/pi/agent-execution-context': { getAgentExecutionContext: () => {
        executionContextReads++;
        return { userId: 'alice', organizationId: 'organization-a' };
      } },
      fs: { promises: {
        stat: async (filename: string) => {
          events.push('stat');
          if (controls.oversize) return { isFile: () => true, size: canonical.MAX_AUDIO_TRANSCRIPTION_BYTES + 1 };
          return fs.stat(filename);
        },
        readFile: async (filename: string) => { events.push('read'); return fs.readFile(filename); },
      } },
      '@/app/lib/pi/tool-runtime-helpers': {
        resolveAgentPath: (filename: string) => {
          events.push('resolve');
          return path.isAbsolute(filename) ? filename : path.resolve(workspace, filename);
        },
        assertAgentPathAllowed: async (filename: string) => {
          events.push('authorize');
          if (controls.denied || !(filename === workspace || filename.startsWith(`${workspace}${path.sep}`))) {
            throw new Error('Agent file access is limited to the bound workspace.');
          }
        },
        audioMimeTypeForPath: (filename: string) => path.extname(filename) === '.ogg' ? 'audio/ogg'
          : path.extname(filename) === '.wav' ? 'audio/wav' : 'application/octet-stream',
        getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
        normalizeOptionalString: (value: unknown) => typeof value === 'string' ? value.trim() || undefined : undefined,
        throwIfAborted: (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('Operation was aborted.'); },
      },
    });
    const tool = tools.createTranscribeAudioTool();
    assert.equal(tool.name, 'transcribe_audio');
    assert.match(tool.description, /Settings.*Dictation/i);
    assert.doesNotMatch(tool.description, /Telegram/i, 'the current agent tool describes the shared instance service');
    const invoke = async (params: Record<string, unknown> = { file_path: 'meeting.ogg' }, signal?: AbortSignal) => {
      events.length = 0;
      return tool.execute('transcription-fixture', params, signal);
    };
    const configure = async (provider: DictationSettings['provider'], model: string, language: string) =>
      settingsModule.writeDictationSettings({ enabled: false, provider, model, language });
    const systemKeys = async (configured: boolean) => envModule.replaceScopedEnvEntries('integrations', configured ? [
      { key: 'GROQ_API_KEY', value: 'fixture-system-groq' },
      { key: 'OPENAI_API_KEY', value: 'fixture-system-openai' },
    ] : []);
    const details = (result: Awaited<ReturnType<typeof invoke>>) => result.details as Details;
    globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      assert.ok(init);
      events.push('provider');
      cloudCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ text: controls.cloudText }), { status: 200 });
    }) as typeof fetch;
    await systemKeys(true);
    await envModule.replaceScopedEnvEntries('integrations', [
      { key: 'GROQ_API_KEY', value: 'fixture-personal-groq' },
      { key: 'OPENAI_API_KEY', value: 'fixture-personal-openai' },
    ], { secretScope: 'user', userId: 'alice' });
    process.env.GROQ_TRANSCRIPTION_MODEL = 'legacy-model-must-not-win';
    process.env.VOICE_TRANSCRIPTION_MODEL = 'legacy-voice-model-must-not-win';
    await configure('groq', 'whisper-large-v3', 'de');
    const groqResult = await invoke();
    assert.deepEqual(events, ['resolve', 'authorize', 'stat', 'read', 'provider'], 'authorization completes before stat, reading or provider work');
    assert.equal(details(groqResult).provider, 'groq');
    assert.equal(details(groqResult).model, 'whisper-large-v3');
    assert.equal(details(groqResult).transcript, 'Shared audio transcript.');
    assert.equal(details(groqResult).filePath, path.join(workspace, 'meeting.ogg'));
    assert.ok(Number.isFinite(details(groqResult).durationMs));
    const text = groqResult.content.find(block => block.type === 'text');
    assert.ok(text && text.type === 'text');
    assert.match(text.text, /Transcript \(groq\/whisper-large-v3\)/u);
    assert.match(text.text, /Shared audio transcript\./u);
    assert.equal(cloudCalls.at(-1)!.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(new Headers(cloudCalls.at(-1)!.init.headers).get('authorization'), 'Bearer fixture-system-groq');
    const groqForm = cloudCalls.at(-1)!.init.body;
    assert.ok(groqForm instanceof FormData);
    assert.equal(groqForm.get('language'), 'de');
    assert.equal(groqForm.get('model'), 'whisper-large-v3');
    assert.equal(executionContextReads, 0, 'transcription no longer selects a personal credential scope from agent context');

    await configure('openai', 'gpt-4o-mini-transcribe', 'en');
    const openaiResult = await invoke();
    assert.equal(details(openaiResult).provider, 'openai');
    assert.equal(details(openaiResult).model, 'gpt-4o-mini-transcribe');
    assert.equal(cloudCalls.at(-1)!.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(new Headers(cloudCalls.at(-1)!.init.headers).get('authorization'), 'Bearer fixture-system-openai');
    assert.equal((cloudCalls.at(-1)!.init.body as FormData).get('language'), 'en');
    await invoke({ file_path: 'meeting.ogg', language: ' DE ', prompt: '  Canvas vocabulary  ' });
    assert.equal((cloudCalls.at(-1)!.init.body as FormData).get('language'), 'de');
    assert.equal((cloudCalls.at(-1)!.init.body as FormData).get('prompt'), 'Canvas vocabulary');
    await invoke({ file_path: 'meeting.ogg', language: 'auto' });
    assert.equal((cloudCalls.at(-1)!.init.body as FormData).get('language'), null);

    await configure('local', 'small', 'de');
    const beforeLocalCloud = cloudCalls.length;
    const localController = new AbortController();
    const localResult = await invoke({ file_path: 'meeting.ogg', language: 'en', prompt: 'Canvas words' }, localController.signal);
    assert.equal(details(localResult).provider, 'local');
    assert.equal(details(localResult).model, 'small');
    assert.equal(details(localResult).transcript, 'Local audio transcript.');
    assert.equal(localCalls.at(-1)!.language, 'en');
    assert.equal(localCalls.at(-1)!.prompt, 'Canvas words');
    assert.equal(localCalls.at(-1)!.signal, localController.signal);
    assert.equal(cloudCalls.length, beforeLocalCloud, 'local tool execution cannot silently use cloud transcription');
    await invoke();
    assert.equal(localCalls.at(-1)!.language, 'de');

    const providerCalls = () => cloudCalls.length + localCalls.length;
    const beforeDenied = providerCalls();
    controls.denied = true;
    const denied = await invoke();
    assert.match(details(denied).error!, /bound workspace/u);
    assert.deepEqual(events, ['resolve', 'authorize']);
    controls.denied = false;
    const missing = await invoke({ file_path: 'missing.ogg' });
    assert.ok(details(missing).error);
    assert.deepEqual(events, ['resolve', 'authorize', 'stat']);
    const directory = await invoke({ file_path: workspace });
    assert.match(details(directory).error!, /Not a file/u);
    assert.deepEqual(events, ['resolve', 'authorize', 'stat']);
    controls.oversize = true;
    const oversized = await invoke();
    assert.match(details(oversized).error!, /too large|25MB/u);
    assert.deepEqual(events, ['resolve', 'authorize', 'stat']);
    controls.oversize = false;
    const missingPath = await invoke({});
    assert.match(details(missingPath).error!, /file_path.*required/u);
    assert.equal(events.length, 0);
    const preAbort = new AbortController();
    preAbort.abort();
    const cancelled = await invoke({ file_path: 'meeting.ogg' }, preAbort.signal);
    assert.match(details(cancelled).error!, /abort/i);
    assert.equal(events.length, 0, 'pre-cancelled calls do not resolve or read files');
    assert.equal(providerCalls(), beforeDenied);

    const emptyFile = await invoke({ file_path: 'empty.wav' });
    assert.equal(details(emptyFile).code, 'EMPTY_AUDIO');
    assert.equal(details(emptyFile).status, 400);
    const unsupported = await invoke({ file_path: 'notes.txt' });
    assert.equal(details(unsupported).code, 'UNSUPPORTED_AUDIO_FORMAT');
    assert.equal(details(unsupported).status, 400);
    const invalidLanguage = await invoke({ file_path: 'meeting.ogg', language: 'german' });
    assert.equal(details(invalidLanguage).code, 'INVALID_LANGUAGE');
    assert.equal(details(invalidLanguage).status, 400);
    assert.equal(providerCalls(), beforeDenied, 'shared validation still happens before a provider request');

    controls.localAvailable = false;
    const unavailable = await invoke();
    assert.equal(details(unavailable).code, 'TRANSCRIPTION_UNAVAILABLE');
    assert.equal(details(unavailable).status, 503);
    assert.equal(providerCalls(), beforeDenied);
    controls.localAvailable = true;
    controls.localText = ' \n ';
    const emptyLocal = await invoke();
    assert.equal(details(emptyLocal).code, 'EMPTY_TRANSCRIPT');
    assert.equal(details(emptyLocal).status, 502);
    controls.localText = 'Local audio transcript.';
    assert.equal(cloudCalls.length, beforeLocalCloud, 'local errors do not trigger a cloud fallback');

    await configure('groq', 'whisper-large-v3-turbo', 'auto');
    await systemKeys(false);
    const beforeMissingKey = providerCalls();
    const missingKey = await invoke();
    assert.equal(details(missingKey).code, 'TRANSCRIPTION_UNAVAILABLE');
    assert.equal(details(missingKey).status, 503);
    assert.match(details(missingKey).error!, /GROQ_API_KEY/u);
    assert.equal(providerCalls(), beforeMissingKey, 'personal credentials cannot configure the system transcription service');
    await systemKeys(true);
    controls.cloudText = '';
    const emptyCloud = await invoke();
    assert.equal(details(emptyCloud).code, 'EMPTY_TRANSCRIPT');
    assert.equal(details(emptyCloud).status, 502);

    globalThis.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      assert.ok(init?.signal);
      events.push('provider');
      cloudCalls.push({ url: String(url), init });
      return new Promise<Response>((_resolve, reject) => {
        if (init.signal!.aborted) { reject(init.signal!.reason); return; }
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    }) as typeof fetch;
    const inflightAbort = new AbortController();
    const beforeInflight = cloudCalls.length;
    const inflight = invoke({ file_path: 'meeting.ogg' }, inflightAbort.signal);
    for (let attempt = 0; attempt < 2_000 && cloudCalls.length === beforeInflight; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    inflightAbort.abort();
    const aborted = await inflight;
    assert.ok(cloudCalls.length > beforeInflight, 'cancellation occurred after the actual shared provider request started');
    assert.equal(details(aborted).code, 'TRANSCRIPTION_ABORTED');
    assert.equal(details(aborted).status, 499);
    assert.ok(cloudCalls.at(-1)!.init.signal!.aborted);
    assert.equal(executionContextReads, 0);
    console.log('transcription-tool-test: actual Pi tool and shared service use current central settings/system credentials, authorize before reads, and preserve errors/cancellation passed');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
