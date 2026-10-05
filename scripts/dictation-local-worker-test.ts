import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import ts from 'typescript';

import type * as Worker from '../app/lib/dictation/local-worker';
import type { LocalDictationRuntimeStatus } from '../app/lib/dictation/runtime-install';

type Message = { id: number; path: string; model: string; language: string; prompt?: string };

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  messages: Message[] = [];
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  autoClose = true;
  stdin = new Writable({ write: (chunk, _encoding, callback) => {
    this.messages.push(JSON.parse(String(chunk)) as Message);
    callback();
  } });

  kill(): boolean {
    this.killed = true;
    if (this.autoClose) setImmediate(() => this.close());
    return true;
  }

  close(): void {
    if (this.signalCode !== null) return;
    this.signalCode = 'SIGTERM';
    this.emit('close', null, this.signalCode);
  }

  reply(index: number, text: string): void {
    this.stdout.write(`${JSON.stringify({ id: this.messages[index].id, text })}\n`);
  }
}

type FakeTimer = { callback: () => void; delay: number; cleared: boolean; unref: () => void };

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(check(), 'Expected worker activity did not occur');
}

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-worker-test-'));
  const children: FakeChild[] = [];
  const timers: FakeTimer[] = [];
  const sharedGlobal = {};
  const runtime: LocalDictationRuntimeStatus = { state: 'installed', path: '/runtime-a', engine: 'faster-whisper' };
  const filename = path.resolve('app/lib/dictation/local-worker.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const compile = (): typeof Worker => {
    const exports = {};
    const mocks: Record<string, unknown> = {
      'server-only': {},
      '@/app/lib/runtime-data-paths': { resolveCanvasDataRoot: () => root },
      './runtime-install': { readLocalDictationRuntimeStatus: async () => ({ ...runtime }) },
      'node:child_process': { spawn: () => {
        const child = new FakeChild();
        children.push(child);
        setImmediate(() => child.stdout.write('{"type":"ready"}\n'));
        return child;
      } },
    };
    new Function('require', 'module', 'exports', 'globalThis', 'setTimeout', 'clearTimeout', source)(
      (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name), { exports }, exports, sharedGlobal,
      (callback: () => void, delay: number) => {
        const timer = { callback, delay, cleared: false, unref: () => {} };
        timers.push(timer);
        return timer;
      },
      (timer: FakeTimer) => { timer.cleared = true; },
    );
    return exports as typeof Worker;
  };
  const api = compile();
  const input = { buffer: Buffer.from('audio'), extension: '.wav', model: 'base', language: 'auto' };
  const cleanup = async () => {
    for (const child of children) child.close();
    await until(() => timers.every((timer) => timer.cleared || timer.delay === 300_000));
    await fs.rm(root, { recursive: true, force: true });
  };
  const fire = (timer: FakeTimer) => { timer.cleared = true; timer.callback(); };
  return { api, compile, input, runtime, children, timers, fire, cleanup };
}

test('UI and agent bundles share one serial worker and forward prompt unchanged', async () => {
  const h = await harness();
  try {
    const first = h.api.transcribeLocally({ ...h.input, prompt: 'Canvas, Weiß, --language de' });
    await until(() => h.children[0]?.messages.length === 1);
    const second = h.compile().transcribeLocally(h.input);
    await assert.rejects(h.api.transcribeLocally(h.input), /busy/u);
    assert.equal(h.children.length, 1);
    assert.equal(h.children[0].messages.length, 1, 'Second job stays outside worker stdin');
    assert.equal(h.children[0].messages[0].prompt, 'Canvas, Weiß, --language de');
    const firstPath = h.children[0].messages[0].path;
    assert.equal((await fs.stat(firstPath)).mode & 0o777, 0o600);
    h.children[0].reply(0, 'first');
    assert.equal(await first, 'first');
    await assert.rejects(fs.stat(firstPath), { code: 'ENOENT' });
    await until(() => h.children[0].messages.length === 2);
    h.children[0].reply(1, 'second');
    assert.equal(await second, 'second');
  } finally { await h.cleanup(); }
});

test('cancelled queued request releases its slot immediately without touching active job', async () => {
  const h = await harness();
  try {
    const active = h.api.transcribeLocally(h.input);
    await until(() => h.children[0]?.messages.length === 1);
    const controller = new AbortController();
    const queued = h.api.transcribeLocally({ ...h.input, signal: controller.signal });
    const rejected = assert.rejects(queued, { name: 'AbortError' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await rejected;
    const replacement = h.api.transcribeLocally(h.input);
    assert.equal(h.children[0].killed, false);
    h.children[0].reply(0, 'active');
    assert.equal(await active, 'active');
    await until(() => h.children[0].messages.length === 2);
    h.children[0].reply(1, 'replacement');
    assert.equal(await replacement, 'replacement');
  } finally { await h.cleanup(); }
});

test('cancelled active request retains audio and capacity until processing finishes', async () => {
  const h = await harness();
  try {
    const controller = new AbortController();
    const active = h.api.transcribeLocally({ ...h.input, signal: controller.signal });
    const rejected = assert.rejects(active, { name: 'AbortError' });
    await until(() => h.children[0]?.messages.length === 1);
    const audio = h.children[0].messages[0].path;
    const queued = h.api.transcribeLocally(h.input);
    controller.abort();
    await rejected;
    assert.equal(h.children[0].killed, false);
    assert.equal(await fs.readFile(audio, 'utf8'), 'audio');
    await assert.rejects(h.api.transcribeLocally(h.input), /busy/u);
    h.children[0].reply(0, 'discarded result');
    await until(() => h.children[0].messages.length === 2);
    await assert.rejects(fs.stat(audio), { code: 'ENOENT' });
    h.children[0].reply(1, 'unrelated job');
    assert.equal(await queued, 'unrelated job');
  } finally { await h.cleanup(); }
});

test('timed out active worker closes before cleanup and queued job restarts successfully', async () => {
  const h = await harness();
  try {
    const active = h.api.transcribeLocally(h.input);
    const rejected = assert.rejects(active, { name: 'TimeoutError', message: 'Local transcription timed out.' });
    await until(() => h.children[0]?.messages.length === 1);
    h.children[0].autoClose = false;
    const audio = h.children[0].messages[0].path;
    const queued = h.api.transcribeLocally(h.input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const activeTimers = h.timers.filter((timer) => !timer.cleared && timer.delay === 180_000);
    h.fire(activeTimers[0]); // Caller deadline detaches the caller.
    await rejected;
    h.fire(activeTimers[1]); // Processing deadline restarts this worker.
    assert.equal(h.children[0].killed, true);
    assert.equal(h.children.length, 1);
    assert.equal(await fs.readFile(audio, 'utf8'), 'audio');
    h.children[0].close();
    await until(() => h.children[1]?.messages.length === 1);
    await assert.rejects(fs.stat(audio), { code: 'ENOENT' });
    h.children[1].reply(0, 'after timeout');
    assert.equal(await queued, 'after timeout');
  } finally { await h.cleanup(); }
});

test('runtime switch waits for active processing before replacing the worker', async () => {
  const h = await harness();
  try {
    const active = h.api.transcribeLocally(h.input);
    await until(() => h.children[0]?.messages.length === 1);
    h.runtime.path = '/runtime-b';
    h.runtime.engine = 'whisper-cpp';
    h.runtime.installedModels = ['base'];
    const queued = h.api.transcribeLocally(h.input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.children[0].killed, false);
    h.children[0].reply(0, 'old runtime');
    assert.equal(await active, 'old runtime');
    await until(() => h.children[1]?.messages.length === 1);
    assert.equal(h.children[0].signalCode, 'SIGTERM');
    h.children[1].reply(0, 'new runtime');
    assert.equal(await queued, 'new runtime');
  } finally { await h.cleanup(); }
});

test('worker timeout code preserves classification without matching error text', async () => {
  const h = await harness();
  try {
    const timedOut = h.api.transcribeLocally(h.input);
    const timeoutRejected = assert.rejects(timedOut, { name: 'TimeoutError', message: 'Processing deadline exceeded.' });
    await until(() => h.children[0]?.messages.length === 1);
    h.children[0].stdout.write(`${JSON.stringify({ id: h.children[0].messages[0].id,
      error: 'Processing deadline exceeded.', code: 'TRANSCRIPTION_TIMEOUT' })}\n`);
    await timeoutRejected;

    const failed = h.api.transcribeLocally(h.input);
    const failureRejected = assert.rejects(failed, { name: 'Error', message: 'Invalid dictation language.' });
    await until(() => h.children[0].messages.length === 2);
    h.children[0].stdout.write(`${JSON.stringify({ id: h.children[0].messages[1].id,
      error: 'Invalid dictation language.' })}\n`);
    await failureRejected;
  } finally { await h.cleanup(); }
});

test('unavailable model and an already aborted caller never create a worker', async () => {
  const h = await harness();
  try {
    h.runtime.engine = 'whisper-cpp';
    h.runtime.installedModels = ['tiny'];
    await assert.rejects(h.api.transcribeLocally(h.input), /not installed/u);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(h.api.transcribeLocally({ ...h.input, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(h.children.length, 0);
  } finally { await h.cleanup(); }
});
