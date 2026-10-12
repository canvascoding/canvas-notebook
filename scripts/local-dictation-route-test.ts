import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { NextRequest, NextResponse } from 'next/server';
import { validateDictationSettings } from '../app/lib/dictation/settings';
import { TranscriptionServiceError } from '../app/lib/transcription/errors';
import { readMobileDictationForm } from '../app/lib/mobile/dictation';

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file), load = createRequire(filename), exports = {};
  const source = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', source)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports);
  return exports as T;
}

async function main() {
  let authorized = true, authenticated = true, limited = false, available = true;
  let preparations = 0, transcripts = 0;
  const mocks = {
    '@/app/lib/admin-auth': { requireInstanceAdmin: async () => authorized && authenticated ? { ok: true } : { ok: false, response: NextResponse.json({ success: false }, { status: authenticated ? 403 : 401 }) } },
    '@/app/lib/utils/rate-limit': { rateLimit: () => limited ? { ok: false, response: NextResponse.json({ success: false }, { status: 429 }) } : { ok: true } },
    '@/app/lib/dictation/local-preparation': {
      readLocalPreparation: async () => ({ model: 'tiny', state: 'running', phase: 'downloading', downloadedBytes: 45, totalBytes: 100 }),
      startLocalPreparation: async (model: string) => { preparations++; assert.equal(model, 'tiny'); return { model, state: 'running' }; },
    },
    '@/app/lib/mobile/dictation': { readMobileDictationForm },
    '@/app/lib/dictation/settings': { validateDictationSettings },
    '@/app/lib/transcription/service': {
      TranscriptionServiceError,
      readTranscriptionAvailability: async () => ({ available, reason: 'Install the selected model.' }),
      transcribeAudio: async (input: { filename: string; signal: AbortSignal }, settings: Record<string, unknown>) => {
        transcripts++; assert.equal(input.filename, 'recording.m4a'); assert.ok(input.signal instanceof AbortSignal);
        assert.deepEqual(settings, { enabled: false, provider: 'local', model: 'tiny', language: 'de' });
        return { text: 'Eigene Testaufnahme.', provider: 'local', model: 'tiny', durationMs: 10 };
      },
    },
  };
  const preparation = await compile<typeof import('../app/api/admin/dictation/local-test/route')>('app/api/admin/dictation/local-test/route.ts', mocks);
  const recording = await compile<typeof import('../app/api/admin/dictation/local-test/recording/route')>('app/api/admin/dictation/local-test/recording/route.ts', mocks);
  const request = (model = 'tiny') => new NextRequest('https://canvas.test/api/admin/dictation/local-test', { method: 'POST', body: JSON.stringify({ model }) });
  const upload = (model = 'tiny', length?: string) => {
    const form = new FormData(); form.set('audio', new File([new Uint8Array([1, 2])], 'recording.m4a', { type: 'audio/mp4' }));
    form.set('model', model); form.set('language', 'de'); form.set('provider', 'gemini');
    return new NextRequest('https://canvas.test/api/admin/dictation/local-test/recording', { method: 'POST', body: form, headers: length ? { 'content-length': length } : undefined });
  };
  for (const authenticatedValue of [false, true]) {
    authorized = false; authenticated = authenticatedValue;
    const status = authenticated ? 403 : 401;
    assert.equal((await preparation.GET(request())).status, status);
    assert.equal((await preparation.POST(request())).status, status);
    assert.equal((await recording.POST(upload())).status, status);
  }
  assert.equal(preparations + transcripts, 0);
  authorized = authenticated = true;
  assert.equal((await preparation.POST(request('unsupported'))).status, 400);
  assert.equal((await recording.POST(upload('unsupported'))).status, 400);
  const status = await preparation.GET(request());
  assert.match(status.headers.get('cache-control')!, /no-store/);
  assert.equal((await status.json()).data.downloadedBytes, 45);
  assert.equal((await preparation.POST(request())).status, 202);
  assert.equal((await recording.POST(upload())).status, 200);
  assert.equal(transcripts, 1);
  available = false;
  assert.equal((await recording.POST(upload())).status, 503);
  assert.equal(transcripts, 1);
  available = true;
  assert.equal((await recording.POST(upload('tiny', String(30 * 1024 * 1024)))).status, 413);
  limited = true;
  assert.equal((await preparation.POST(request())).status, 429);
  assert.equal((await recording.POST(upload())).status, 429);
  console.log('local-dictation-route-test: admin/access gates, progress, shared local service, draft isolation, MIME uploads, limits, quota and readiness passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
