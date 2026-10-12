import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type * as TraceModule from '../app/lib/mcp/mobile-render-repro-trace';

/** Synthetic private filesystem only: never creates a DB, HTTP listener, subprocess or provider. */
async function runMobileRenderReproTracePrivacyCases() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-render-trace-unit-')));
  await fs.chmod(root, 0o700);
  const loader = createRequire(path.join(process.cwd(), 'package.json'));
  const moduleFile = loader.resolve('./app/lib/mcp/mobile-render-repro-trace.ts');
  const runtimeKey = Symbol.for('canvas.mobile.mcp.render-repro.trace.v1'), originalRuntime = Reflect.get(globalThis, runtimeKey);
  const load = (reset = true): typeof TraceModule => {
    if (reset) Reflect.deleteProperty(globalThis, runtimeKey); // Isolate only this synthetic fixture's diagnostic state; no product reset API.
    delete loader.cache[moduleFile]; return loader(moduleFile) as typeof TraceModule;
  };
  const environment = { CANVAS_AGENT_SETTINGS_BROWSER_RUN: '1', CANVAS_AGENT_WORKFLOW_MULTIUSER_BROWSER_RUN: '1',
    CANVAS_SHARED_MCP_APPS_BROWSER_RUN: '1', CANVAS_MOBILE_MCP_RENDER_REPRO_RUN: '1', __NEXT_PROCESSED_ENV: 'true',
    BASE_URL: 'http://127.0.0.1:3001', DATA: path.join(root, 'data'), CANVAS_DATA_ROOT: path.join(root, 'data'), TMPDIR: path.join(root, 'tmp'),
    DATABASE_URL: `postgresql://fixture:DO_NOT_LOG_PASSWORD@127.0.0.1:55433/canvas_connection_test_${'a'.repeat(32)}`,
    AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE: path.join(root, 'recovery.json') };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  let cases = 0;
  try {
    Object.assign(process.env, environment);
    delete process.env.CANVAS_MOBILE_MCP_RENDER_REPRO_RUN;
    const disabled = load(); assert.equal(await disabled.startMobileRenderReproTrace(), null);
    let disabledOperations = 0;
    assert.equal(await disabled.runMobileRenderReproSubphase('source-auth', async () => { disabledOperations++; return 42; }), 42);
    const disabledError = new Error('A disabled diagnostic must preserve this error.');
    await assert.rejects(disabled.runMobileRenderReproSubphase('source-auth', async () => { disabledOperations++; throw disabledError; }), error => error === disabledError);
    assert.equal(disabledOperations, 2);
    assert.deepEqual(await fs.readdir(root), []); cases++;
    Object.assign(process.env, environment);
    const rootStat = await fs.lstat(root), marker = randomBytes(24).toString('hex');
    const receipt = { version: 1, nonce: 'a'.repeat(32), repo: process.cwd(), fixtureRoot: root,
      databaseName: `canvas_connection_test_${'a'.repeat(32)}`, mobileRenderRepro: true, mobileRenderReproDeadline: Date.now() + 29 * 60_000,
      phase: 'browser', createAcknowledged: true, listenerVerified: true, uncertain: false, serverPid: process.pid,
      rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), ownerMarker: marker };
    await fs.writeFile(path.join(root, '.fixture-owner'), marker, { mode: 0o600 });
    await fs.writeFile(environment.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE, JSON.stringify(receipt), { mode: 0o600 });
    const output = path.join(root, 'render-repro-phases.jsonl');
    for (const mutation of [ { serverPid: process.pid + 1 }, { mobileRenderRepro: false }, { phase: 'preserved' },
      { nonce: 'not-owned' }, { rootInode: 'not-owned' }, { mobileRenderReproDeadline: Date.now() - 1 }, { ownerMarker: 'wrong' },
      { mobileRenderReproDeadline: Date.now() + 31 * 60_000 } ]) {
      await fs.writeFile(environment.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE, JSON.stringify({ ...receipt, ...mutation }), { mode: 0o600 });
      assert.equal(await load().startMobileRenderReproTrace(), null); await assert.rejects(fs.lstat(output), { code: 'ENOENT' }); cases++;
    }
    await fs.writeFile(environment.AGENT_SETTINGS_TOOLS_BROWSER_FIXTURE, JSON.stringify(receipt), { mode: 0o600 });
    const traceModule = load(), trace = await traceModule.startMobileRenderReproTrace(); assert(trace);
    let issued = 1;
    const nextTrace = async () => { const value = await traceModule.startMobileRenderReproTrace(); assert(value); issued++; return value; };
    const canary = 'DO_NOT_LOG_COOKIE_URL_REF_HTML_ARGUMENT';
    const returned = { url: `https://${canary}.test`, cookie: canary, connectionRef: canary, html: `<p>${canary}</p>`, argument: canary };
    assert.equal(await trace.run('initial-source', async () => returned), returned);
    const original = Object.assign(new Error(canary), { name: canary, code: canary });
    await assert.rejects(trace.run('resource-read', async () => { throw original; }), error => error === original);
    const invalidBefore = await fs.readFile(output, 'utf8');
    assert.equal(await trace.run(canary as never, async () => 42), 42);
    assert.equal(await fs.readFile(output, 'utf8'), invalidBefore); cases++;
    await trace.finish(original);
    const lines = (await fs.readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 5); assert(!JSON.stringify(lines).includes(canary)); assert(!JSON.stringify(lines).includes('DO_NOT_LOG_PASSWORD'));
    for (const row of lines) {
      assert.deepEqual(Object.keys(row).sort(), ['elapsedMs', ...(row.outcome === 'failed' ? ['errorClass'] : []), 'ordinal', 'outcome', 'phase', 'request', 'version'].sort());
      assert.equal(row.version, 1); assert(Number.isSafeInteger(row.ordinal)); assert(Number(row.elapsedMs) >= 0 && Number(row.elapsedMs) <= 1_800_000);
      if (row.outcome === 'failed') assert.equal(row.errorClass, 'OtherError');
    }
    assert.equal((await fs.lstat(output)).mode & 0o777, 0o600); cases++;
    // Requiring a second copy must retain the issued context and sink, as happens with separate Next server bundles.
    const otherModule = load(false), nested = await nextTrace();
    let operations = 0;
    const nestedStart = (await fs.readFile(output, 'utf8')).trim().split('\n').length;
    assert.equal(await nested.run('initial-source', () => otherModule.runMobileRenderReproSubphase('managed-acquire',
      () => otherModule.runMobileRenderReproSubphase('source-auth', async () => { operations++; return returned; }))), returned);
    assert.equal(operations, 1);
    const nestedRows = (await fs.readFile(output, 'utf8')).trim().split('\n').slice(nestedStart).map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(nestedRows.length, 6);
    assert.deepEqual(nestedRows.filter(row => row.subphase).map(row => [row.subphase, row.span, row.parentSpan, row.outcome]), [
      ['managed-acquire', 1, null, 'start'], ['source-auth', 2, 1, 'start'], ['source-auth', 2, 1, 'completed'], ['managed-acquire', 1, null, 'completed'],
    ]);
    assert(nestedRows.every(row => row.request === nestedRows[0].request && row.phase === 'initial-source')); cases++;
    // Both dispatch guards are observed, once before dispatch and once nested inside the actual resource operation.
    let guards = 0;
    assert.equal(await nested.run('resource-read', async () => {
      await otherModule.runMobileRenderReproSubphase('dispatch-guard', async () => { guards++; });
      return otherModule.runMobileRenderReproSubphase('resource-rpc', async () => {
        await otherModule.runMobileRenderReproSubphase('dispatch-guard', async () => { guards++; }); return returned;
      });
    }), returned);
    assert.equal(guards, 2); cases++;
    await assert.rejects(nested.run('resource-read', () => otherModule.runMobileRenderReproSubphase('tools-list', async () => {
      operations++; throw original;
    })), error => error === original);
    assert.equal(operations, 2); cases++;
    const hostile = new Error(canary), classifierFailure = new Error('The classifier must not replace an operation error.');
    Object.defineProperty(hostile, 'name', { get: () => { throw classifierFailure; } });
    await assert.rejects(nested.run('resource-read', () => otherModule.runMobileRenderReproSubphase('tools-list', async () => { throw hostile; })), error => error === hostile);
    const hostileRows = (await fs.readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(hostileRows.at(-1)?.errorClass, 'OtherError'); cases++;
    const beforeInvalidSubphase = await fs.readFile(output, 'utf8');
    assert.equal(await nested.run('host-bundle', () => otherModule.runMobileRenderReproSubphase(canary as never, async () => returned)), returned);
    const invalidSubphaseRows = (await fs.readFile(output, 'utf8')).slice(beforeInvalidSubphase.length);
    assert(!invalidSubphaseRows.includes(canary) && !invalidSubphaseRows.includes('subphase')); cases++;
    // Async work inherits the real ALS store, but completion ends its diagnostic lease synchronously.
    let wake!: () => void, background!: Promise<unknown>;
    const held = new Promise<void>(resolve => { wake = resolve; });
    await nested.run('final-source', async () => {
      background = (async () => { await held; return otherModule.runMobileRenderReproSubphase('source-final-auth', async () => {
        operations++; return returned;
      }); })();
    });
    await nested.finish(); const completedRows = await fs.readFile(output, 'utf8'); wake();
    assert.equal(await background, returned); assert.equal(operations, 3);
    assert.equal(await fs.readFile(output, 'utf8'), completedRows); cases++;
    // Outside an issued scope, exact callbacks still execute while no diagnostics or private source are borrowed.
    assert.equal(await otherModule.runMobileRenderReproSubphase('source-auth', async () => returned), returned);
    assert.equal(await fs.readFile(output, 'utf8'), completedRows); cases++;
    const changedSource = await nextTrace(); const beforeChangedSource = await fs.readFile(output, 'utf8');
    const originalData = process.env.DATA;
    try {
      process.env.DATA = path.join(root, 'other-source');
      assert.equal(await otherModule.startMobileRenderReproTrace(), null);
      assert.equal(await changedSource.run('initial-source', () => otherModule.runMobileRenderReproSubphase('source-auth', async () => returned)), returned);
      await changedSource.finish(); assert.equal(await fs.readFile(output, 'utf8'), beforeChangedSource);
    } finally { process.env.DATA = originalData; }
    cases++;
    const expired = await nextTrace(), beforeExpired = await fs.readFile(output, 'utf8'), originalNow = Date.now;
    try {
      Date.now = () => receipt.mobileRenderReproDeadline + 1;
      assert.equal(await expired.run('initial-source', () => otherModule.runMobileRenderReproSubphase('source-auth', async () => returned)), returned);
      await expired.finish(); assert.equal(await fs.readFile(output, 'utf8'), beforeExpired);
    } finally { Date.now = originalNow; }
    cases++;
    const capTrace = await nextTrace();
    // Exercise NOFOLLOW while the sink is still below its cap, then restore its original inode.
    const retained = path.join(root, 'retained-sink'), other = path.join(root, 'unrelated');
    const beforeSymlink = await fs.readFile(output, 'utf8');
    await fs.rename(output, retained); await fs.writeFile(other, canary, { mode: 0o600 }); await fs.symlink(other, output);
    assert.equal(await capTrace.run('host-bundle', async () => returned), returned); assert.equal(await fs.readFile(other, 'utf8'), canary);
    await fs.unlink(output); await fs.rename(retained, output); assert.equal(await fs.readFile(output, 'utf8'), beforeSymlink); cases++;
    // One noisy diagnostic cannot grow an unbounded file or caller-controlled payload.
    for (let index = 0; index < 600; index++) await capTrace.run('host-bundle', async () => canary);
    const finalRows = (await fs.readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(finalRows.length, 510); assert((await fs.lstat(output)).size <= 512 * 1024);
    assert.equal(finalRows.at(-1)?.ordinal, 512); assert.equal(finalRows.at(-1)?.rowLimitReached, true);
    assert.equal(finalRows.filter(row => row.rowLimitReached).length, 1);
    for (const row of finalRows) {
      assert.deepEqual(Object.keys(row).sort(), ['elapsedMs', ...(row.outcome === 'failed' ? ['errorClass'] : []), 'ordinal', 'outcome', 'phase', 'request', 'version',
        ...(row.subphase ? ['subphase', 'span', 'parentSpan'] : []), ...(row.rowLimitReached ? ['rowLimitReached'] : [])].sort());
      assert(Number.isSafeInteger(row.request) && Number(row.request) >= 1 && Number(row.request) <= 32);
      assert(Number(row.elapsedMs) >= 0 && Number(row.elapsedMs) <= 1_800_000);
      assert(['start', 'completed', 'failed'].includes(String(row.outcome)));
      if (row.subphase) {
        assert(Number.isSafeInteger(row.span) && Number(row.span) >= 1 && Number(row.span) <= 256);
        assert(row.parentSpan === null || Number.isSafeInteger(row.parentSpan) && Number(row.parentSpan) > 0 && Number(row.parentSpan) < Number(row.span));
      }
    }
    assert(!JSON.stringify(finalRows).includes(canary) && !JSON.stringify(finalRows).includes('DO_NOT_LOG_PASSWORD') && !JSON.stringify(finalRows).includes(root)); cases++;
    for (let index = issued; index < 32; index++) assert(await traceModule.startMobileRenderReproTrace());
    assert.equal(await traceModule.startMobileRenderReproTrace(), null); cases++;
    console.log(`MOBILE_RENDER_REPRO_TRACE_PRIVACY_PASS cases=${cases}`);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (originalRuntime === undefined) Reflect.deleteProperty(globalThis, runtimeKey); else Reflect.set(globalThis, runtimeKey, originalRuntime);
    delete loader.cache[moduleFile]; await fs.rm(root, { recursive: true, force: true });
  }
}

void runMobileRenderReproTracePrivacyCases().catch(() => { console.error('MOBILE_RENDER_REPRO_TRACE_PRIVACY_FAILED'); process.exitCode = 1; });
