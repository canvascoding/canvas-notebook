import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-local-preparation-'));
  const previous = process.env.CANVAS_APP_ROOT;
  process.env.CANVAS_APP_ROOT = root;
  const runtimePath = path.join(root, 'dictation/whisper-cpp');
  await fs.mkdir(runtimePath, { recursive: true });
  await fs.mkdir(path.join(root, 'docs/compliance'), { recursive: true });
  await fs.mkdir(path.join(root, 'scripts/fixtures'), { recursive: true });
  await fs.mkdir(path.join(root, 'native/dictation'), { recursive: true });
  await fs.writeFile(path.join(root, 'native/dictation/runtime.json'), 'fixture-runtime');
  await fs.writeFile(path.join(root, 'docs/compliance/dictation-cpp-policy.json'), JSON.stringify({ models: { tiny: { sha256: 'fixture-hash' } } }));
  await fs.writeFile(path.join(runtimePath, 'fixture-hash.json'), 'fixture-receipt');
  await fs.writeFile(path.join(root, 'scripts/fixtures/dictation-self-test.wav'), 'fixture-audio');
  let calls = 0, reliable = true;
  const mocks: Record<string, unknown> = {
    '@/app/lib/runtime-data-paths': { resolveCanvasDataRoot: () => root },
    './runtime-install': {
      readLocalDictationRuntimeStatus: async () => ({ state: 'installed', engine: 'whisper-cpp', installedModels: ['tiny'], path: runtimePath }),
      startLocalDictationRuntimeInstall: async () => { throw new Error('must reuse installed model'); },
      ensureHostDictationModel: async () => undefined,
    },
    '@/app/lib/transcription/service': { transcribeAudio: async (input: { signal: AbortSignal }, settings: Record<string, unknown>) => {
      calls++;
      assert.deepEqual(settings, { enabled: false, provider: 'local', model: 'tiny', language: 'en' });
      assert.ok(input.signal instanceof AbortSignal);
      await new Promise(resolve => setTimeout(resolve, 50));
      return { text: reliable ? 'My fellow Americans, ask not what your country can do for you.' : 'unrelated text', durationMs: 50 };
    } },
  };
  const filename = path.resolve('app/lib/dictation/local-preparation.ts'), load = createRequire(filename);
  const exports = {} as typeof import('../app/lib/dictation/local-preparation');
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', source)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports);
  const finish = async () => {
    for (let i = 0; i < 100; i++) {
      const state = await exports.readLocalPreparation();
      if (state?.state !== 'running') { await new Promise(resolve => setTimeout(resolve, 20)); return state; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Preparation did not finish');
  };
  try {
    const job = await exports.startLocalPreparation('tiny');
    assert.equal((await exports.startLocalPreparation('tiny')).id, job.id, 'duplicate request joins the current job');
    await assert.rejects(exports.startLocalPreparation('base'), /Another model/);
    const passed = await finish();
    assert.equal(passed?.state, 'succeeded'); assert.equal(calls, 1); assert.equal(passed?.model, 'tiny');
    assert.ok(passed?.result?.text.includes('Americans'));
    assert.equal((await exports.readLocalPreparation())?.id, job.id, 'result persists across status reads');
    await fs.writeFile(path.join(runtimePath, 'fixture-hash.json'), 'changed-receipt');
    assert.equal((await exports.readLocalPreparation())?.state, 'failed', 'modified model invalidates the previous test');
    reliable = false;
    await exports.startLocalPreparation('tiny');
    assert.equal((await finish())?.state, 'failed', 'nonempty unrelated transcript is not a passing self-test');
    await assert.rejects(exports.startLocalPreparation('../../escape'), /supported/);
    const stale = { ...job, updatedAt: Date.now() - 60_000 };
    await fs.writeFile(path.join(root, 'dictation/preparation.json'), JSON.stringify(stale));
    await fs.mkdir(path.join(root, 'dictation/preparation.lock'));
    assert.equal((await exports.readLocalPreparation())?.state, 'failed', 'orphaned jobs are actionable');
    reliable = true;
    await exports.startLocalPreparation('tiny');
    assert.equal((await finish())?.state, 'succeeded', 'retry replaces an orphaned lock');
    console.log('local-dictation-preparation-test: shared local service, persistent results, duplicate requests, recognition failures, receipt invalidation and restart recovery passed');
  } finally {
    if (previous === undefined) delete process.env.CANVAS_APP_ROOT; else process.env.CANVAS_APP_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
