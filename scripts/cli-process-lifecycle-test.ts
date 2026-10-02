import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SpawnCommandRunner } from '../cli/src/core/process';
import { consumeBoundedJsonLines } from '../cli/src/core/jsonLines';
import { StandaloneUpdater } from '../cli/src/core/standaloneUpdater';

async function main(): Promise<void> {
  const runner = new SpawnCommandRunner();
  const stdinFailure = await runner.run(process.execPath, ['-e', 'process.exit(7)'], { stdin: 'x'.repeat(8 * 1024 * 1024), timeoutMs: 2000 });
  assert.notEqual(stdinFailure.status, 0);
  assert.match(stdinFailure.stderr, /Process stream failed: (EPIPE|ECONNRESET)/u);
  const eof = await runner.run(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log("eof"))'], { timeoutMs: 2000 });
  assert.equal(eof.status, 0);
  assert.equal(eof.stdout.trim(), 'eof');
  if (process.platform !== 'win32') {
    const start = performance.now();
    const descendant = await runner.run(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'inherit'});setInterval(()=>{},1000)"], { timeoutMs: 250 });
    assert.equal(descendant.status, 124);
    assert.ok(performance.now() - start < 2000, 'a descendant must not hold the result open');
  }
  const overflow = await runner.run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({value:"x".repeat(100000)}))'], { capture: 'exact', maxOutputBytes: 4096 });
  assert.notEqual(overflow.status, 0);
  assert.equal(overflow.stdoutTruncated, true);
  assert.ok(Buffer.byteLength(overflow.stdout) <= 4096);
  const abort = new AbortController();
  const canceled = runner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: abort.signal });
  abort.abort();
  assert.notEqual((await canceled).status, 0);
  await assert.rejects(consumeBoundedJsonLines(Readable.from([Buffer.alloc(65536, 120)]), async () => {}), /size limit/u);
  const line = JSON.stringify({ value: 'Grüße 🐳' });
  const encoded = Buffer.from(`${line}\r\n${line}\n`);
  const lines: string[] = [];
  let pending = 0;
  await consumeBoundedJsonLines(Readable.from(Array.from(encoded, byte => Buffer.from([byte]))), async value => {
    pending += 1;
    assert.equal(pending, 1);
    await new Promise(resolve => setTimeout(resolve, 1));
    lines.push(value);
    pending -= 1;
  });
  assert.deepEqual(lines, [line, line]);
  await assert.rejects(consumeBoundedJsonLines(Readable.from([Buffer.from([0xff, 10])]), async () => {}));

  if (process.platform !== 'win32') {
    const root = await mkdtemp(path.join(os.tmpdir(), 'canvas-stream-lifecycle-'));
    try {
      const executable = path.join(root, 'cli.js');
      await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(65536));setTimeout(()=>{},10000);\n', { mode: 0o700 });
      const updater = new StandaloneUpdater({ env: { ...process.env, CANVAS_CLI_PATH: executable, CANVAS_UPDATER_STATE_DIR: root } });
      const controller = new AbortController();
      const transport = updater as unknown as { executeUpdate(operation: unknown, onEvent: () => Promise<void>, release: unknown, signal: AbortSignal): Promise<number> };
      const watchdog = setTimeout(() => controller.abort(), 2000);
      const start = performance.now();
      try {
        await assert.rejects(transport.executeUpdate({ operationId: '00000000-0000-4000-8000-000000000001', targetImageRef: `test@sha256:${'a'.repeat(64)}` }, async () => {}, { signed: { manifest: { backupRequired: false } } }, controller.signal), /size limit/u);
        assert.ok(performance.now() - start < 1500, 'the real updater must reject an oversized partial line before EOF');
      } finally { clearTimeout(watchdog); controller.abort(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  console.log('CLI process lifecycle: stdin failure, EOF, descendant cleanup, exact output, cancellation and bounded updater NDJSON passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
