import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import ts from 'typescript';
import { DICTATION_MODELS, DICTATION_PROVIDERS, type DictationSettings } from '../app/lib/transcription/config';
import { TranscriptionServiceError } from '../app/lib/transcription/errors';

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file), load = createRequire(filename), exports = {};
  const source = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function('require', 'module', 'exports', source)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports);
  return exports as T;
}

async function main() {
  const clientRoot = process.env.CANVAS_MOBILE_CLIENT_DIR || path.join(os.homedir(), 'Documents/canvas-notebook-mobile');
  let clientSource = path.join(clientRoot, 'src/features/chat/dictation-contracts.ts');
  try { await access(clientSource); } catch { clientSource = 'scripts/fixtures/mobile-dictation-v1.ts.txt'; }
  const parser = await compile<{ parseDictationAvailability(value: unknown, workspaceId: string): { available: boolean; provider: string }; parseDictationTranscript(value: unknown, workspaceId: string): string }>(clientSource, {
    '@/lib/mobile-api': { isRecord: (value: unknown) => Boolean(value && typeof value === 'object' && !Array.isArray(value)) },
    '@/features/workspaces/bootstrap': { MobileApiError: class extends Error {} },
  });
  const workspaceId = 'fixture-workspace';
  let selected: DictationSettings = { enabled: true, provider: 'gemini', model: DICTATION_MODELS.gemini[0], language: 'de' };
  let signedIn = true, accessible = true, limited = false, available = true;
  let reason: 'credential_missing' | 'runtime_unavailable' = 'credential_missing';
  let settingsReads = 0, transcriptions = 0;
  let transcript = 'Native M4A transcript.';
  let failure: Error | undefined;
  let received: { file: File; settings: DictationSettings; signal: AbortSignal } | undefined;
  const settings = { readDictationSettings: async () => { settingsReads++; return selected; } };
  const canonical = {
    TranscriptionServiceError, MAX_AUDIO_TRANSCRIPTION_BYTES: 25 * 1024 * 1024,
    readTranscriptionAvailability: async () => ({ available, unavailableReason: available ? null : reason }),
  };
  const mobile = await compile<typeof import('../app/lib/mobile/dictation')>('app/lib/mobile/dictation.ts', {
    '@/app/lib/dictation/settings': settings, '@/app/lib/transcription/service': canonical,
  });
  const mocks = {
    '@/app/lib/mobile/dictation': mobile,
    '@/app/lib/dictation/settings': settings,
    '@/app/lib/transcription/service': canonical,
    '@/app/lib/dictation/service': {
      readDictationAvailability: async () => ({ available: selected.enabled && available }),
      transcribeDictationFile: async (file: File, selected: DictationSettings, signal: AbortSignal) => {
        transcriptions++; received = { file, settings: selected, signal };
        if (failure) throw failure;
        return transcript;
      },
    },
    '@/app/lib/workspaces/request': { requireRequestWorkspace: async (request: NextRequest, options: { permissions: string }) => {
      assert.equal(options.permissions, 'canRead');
      assert.equal(request.headers.get('X-Canvas-Workspace-Id'), workspaceId);
      if (!signedIn || !accessible) return { response: NextResponse.json({ success: false }, { status: signedIn ? 404 : 401 }) };
      return { response: null, workspace: { workspaceId }, session: { user: { id: 'fixture-user' } } };
    } },
    '@/app/lib/utils/rate-limit': { rateLimit: (_request: NextRequest, options: { keyPrefix: string; limit: number }) => {
      assert.ok(['mobile-dictation-status:fixture-user', 'dictation:fixture-user'].includes(options.keyPrefix));
      if (options.keyPrefix === 'dictation:fixture-user') assert.equal(options.limit, 12);
      return limited ? { ok: false, response: NextResponse.json({ success: false }, { status: 429 }) } : { ok: true };
    } },
  };
  const availabilityRoute = await compile<typeof import('../app/api/mobile/v1/dictation/availability/route')>('app/api/mobile/v1/dictation/availability/route.ts', mocks);
  const transcribeRoute = await compile<typeof import('../app/api/mobile/v1/dictation/transcribe/route')>('app/api/mobile/v1/dictation/transcribe/route.ts', mocks);
  const statusRequest = () => new NextRequest('https://canvas.test/api/mobile/v1/dictation/availability', { headers: { 'X-Canvas-Workspace-Id': workspaceId } });
  const upload = (version = '1', type = 'audio/mp4', headers: Record<string, string> = {}) => {
    const form = new FormData(); form.set('contractVersion', version);
    form.set('audio', new File([new Uint8Array([1, 2, 3])], 'dictation.m4a', { type }));
    // Client-supplied provider/model must not select another service.
    form.set('provider', 'groq'); form.set('model', 'whisper-large-v3');
    return new NextRequest('https://canvas.test/api/mobile/v1/dictation/transcribe', { method: 'POST', headers: { 'X-Canvas-Workspace-Id': workspaceId, ...headers }, body: form });
  };
  for (const provider of DICTATION_PROVIDERS) {
    selected = { ...selected, provider, model: DICTATION_MODELS[provider][0] };
    const response = await availabilityRoute.GET(statusRequest());
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /no-store/);
    const body = await response.json();
    assert.equal(body.availability.transcriptionProvider, provider);
    const parsed = parser.parseDictationAvailability(body, workspaceId);
    assert.equal(parsed.available, true, `unchanged Expo parser accepts ${provider}`);
    assert.equal(parsed.provider, provider === 'gemini' || provider === 'wispr' ? 'openai' : provider);
    const request = upload();
    const result = await transcribeRoute.POST(request);
    assert.equal(result.status, 200);
    assert.equal(parser.parseDictationTranscript(await result.json(), workspaceId), transcript);
    assert.equal(received?.settings, selected, 'settings snapshot reaches the canonical dictation adapter');
    assert.equal(received?.signal, request.signal);
    assert.equal(received?.file.type, 'audio/mp4');
    assert.equal(received?.file.name, 'dictation.m4a');
  }
  const before = transcriptions;
  signedIn = false; const previousReads = settingsReads;
  assert.equal((await availabilityRoute.GET(statusRequest())).status, 401);
  assert.equal((await transcribeRoute.POST(upload())).status, 401);
  assert.equal(settingsReads, previousReads);
  signedIn = true; accessible = false;
  assert.equal((await transcribeRoute.POST(upload())).status, 404); accessible = true;
  limited = true; assert.equal((await transcribeRoute.POST(upload())).status, 429); limited = false;
  selected.enabled = false;
  const disabled = await (await availabilityRoute.GET(statusRequest())).json();
  assert.equal(disabled.availability.reasonCode, 'disabled');
  assert.equal(parser.parseDictationAvailability(disabled, workspaceId).available, false);
  assert.equal((await transcribeRoute.POST(upload())).status, 503); selected.enabled = true;
  available = false;
  for (const code of ['credential_missing', 'runtime_unavailable'] as const) {
    reason = code; const result = await (await availabilityRoute.GET(statusRequest())).json();
    assert.equal(result.availability.reasonCode, code);
    assert.equal(parser.parseDictationAvailability(result, workspaceId).available, false);
  }
  assert.equal((await transcribeRoute.POST(upload())).status, 503); available = true;
  assert.equal((await transcribeRoute.POST(upload('2'))).status, 400);
  assert.equal((await transcribeRoute.POST(upload('1', 'image/png'))).status, 400);
  assert.equal((await transcribeRoute.POST(upload('1', 'audio/mp4', { 'content-length': String(26 * 1024 * 1024) }))).status, 413);
  assert.equal(transcriptions, before, 'rejected uploads never invoke transcription');
  const oversizedStream = new Request('https://canvas.test/upload', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: new Uint8Array(26 * 1024 * 1024) });
  await assert.rejects(mobile.readMobileDictationForm(oversizedStream), (error: unknown) => error instanceof TranscriptionServiceError && error.status === 413);
  for (const [code, status] of [['TRANSCRIPTION_ABORTED', 499], ['TRANSCRIPTION_TIMEOUT', 504], ['TRANSCRIPTION_PROVIDER_ACCESS_DENIED', 502], ['AUDIO_TOO_LONG', 413]] as const) {
    failure = new TranscriptionServiceError('Fixture provider error.', code, status);
    const result = await transcribeRoute.POST(upload());
    assert.equal(result.status, status); assert.equal((await result.json()).code, code);
  }
  failure = undefined; transcript = 'x'.repeat(64 * 1024 + 1);
  assert.equal((await transcribeRoute.POST(upload())).status, 413);
  console.log(`mobile-dictation-contract-test: unchanged Expo parser (${clientSource}), all providers, native M4A, workspace/auth, quotas, size limits and errors passed`);
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
