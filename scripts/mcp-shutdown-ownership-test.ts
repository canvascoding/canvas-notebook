import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

export type McpShutdownCoordinator = (signal: NodeJS.Signals) => void | Promise<void>;
type ManagerModule = Pick<typeof import('../app/lib/mcp/manager'), 'startMcpIdleCleanup' | 'closeAllMcpServers'> & {
  registerMcpShutdownCoordinator: (coordinator: McpShutdownCoordinator) => void;
};
type LoaderOptions = {
  source?: string;
  global?: object;
  process?: object;
  setInterval?: (callback: () => void, delay: number) => object;
  console?: Pick<Console, 'info' | 'warn' | 'error'>;
};

/** Load the complete actual manager without loading its DB, config or transport dependencies. */
export function loadMcpManager(options: LoaderOptions = {}): ManagerModule {
  const filename = path.resolve(__dirname, '../app/lib/mcp/manager.ts');
  const source = options.source ?? readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }, fileName: filename }).outputText;
  const exports = {};
  new Function('require', 'module', 'exports', 'globalThis', 'process', 'setInterval', 'console', compiled)(
    () => ({}), { exports }, exports, options.global ?? globalThis,
    options.process ?? process, options.setInterval ?? setInterval, options.console ?? console,
  );
  return exports as ManagerModule;
}

type FixtureEntry = {
  serverName: string;
  transport: 'stdio';
  abortController: AbortController;
  client: { close: () => Promise<void> };
  closed?: boolean;
};
type FixtureGlobal = {
  __canvasMcpManagerStore?: { entries: Map<string, FixtureEntry>; shuttingDown: boolean };
};

function createManagerHarness() {
  const sharedGlobal: FixtureGlobal = {};
  const events = new EventEmitter();
  const exits: number[] = [];
  const logs: string[] = [];
  const intervals: Array<{ delay: number; unrefs: number }> = [];
  const fixtureProcess = Object.assign(events, {
    env: {}, exit: (code?: number) => { exits.push(code ?? 0); },
  });
  const record = (message: unknown) => { logs.push(String(message)); };
  const options: LoaderOptions = {
    global: sharedGlobal, process: fixtureProcess,
    console: { info: record, warn: record, error: record },
    setInterval: (_callback, delay) => {
      const interval = { delay, unrefs: 0 };
      intervals.push(interval);
      return { unref: () => { interval.unrefs += 1; } };
    },
  };
  return { a: loadMcpManager(options), b: loadMcpManager(options), sharedGlobal, events, exits, logs, intervals };
}

async function drainMicrotasks() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

type OwnedChildIdentity = { pid: number; ppid: number; uid: number; birth: string };

function readOwnedChildIdentity(child: ChildProcess): OwnedChildIdentity {
  assert.ok(child.pid, 'The owned child must have a PID');
  assert.equal(typeof process.getuid, 'function', 'The test must be able to verify its native UID');
  const snapshot = execFileSync('ps', ['-p', String(child.pid), '-o', 'pid=,ppid=,uid=,lstart='], {
    encoding: 'utf8', timeout: 1_000, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(snapshot);
  assert.ok(match, 'Cannot prove the child identity; retain the process without signaling it');
  const identity = { pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), birth: match[4] };
  assert.equal(identity.pid, child.pid, 'The exact child PID must match');
  assert.equal(identity.ppid, process.pid, 'The child must still belong to this test parent');
  assert.equal(identity.uid, process.getuid!(), 'The child must still belong to this test UID');
  assert.match(identity.birth, /^[A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u,
    'The native child birth identity must be known');
  return identity;
}

function signalVerifiedChild(child: ChildProcess, expected: OwnedChildIdentity | undefined, signal: NodeJS.Signals) {
  assert.ok(expected, 'No original child identity is known; retain the process without signaling it');
  assert.deepEqual(readOwnedChildIdentity(child), expected,
    'The child identity changed; retain the process without signaling it');
  assert.equal(child.kill(signal), true, 'The verified owned child must receive its signal');
}

function retainUnknownChild(child: ChildProcess) {
  child.unref();
  for (const stream of [child.stdout, child.stderr]) {
    (stream as { unref?: () => void } | null)?.unref?.();
  }
}

function registerTests() {
  test('separate actual manager bundles observe a coordinator registered after their shared hooks', async () => {
    const fixture = createManagerHarness();
    fixture.a.startMcpIdleCleanup();
    fixture.b.startMcpIdleCleanup();
    for (const event of ['SIGTERM', 'SIGINT', 'beforeExit']) assert.equal(fixture.events.listenerCount(event), 1);
    assert.deepEqual(fixture.intervals, [{ delay: 60_000, unrefs: 1 }]);
    assert.equal(typeof fixture.b.registerMcpShutdownCoordinator, 'function', 'The shutdown owner API must be exported');
    const signals: NodeJS.Signals[] = [];
    const coordinator: McpShutdownCoordinator = signal => { signals.push(signal); };
    fixture.b.registerMcpShutdownCoordinator(coordinator);
    fixture.a.registerMcpShutdownCoordinator(coordinator);
    fixture.events.emit('SIGTERM', 'SIGTERM');
    fixture.events.emit('SIGINT', 'SIGINT');
    await drainMicrotasks();
    assert.deepEqual(signals, ['SIGTERM', 'SIGINT']);
    assert.deepEqual(fixture.exits, [], 'The library must leave process exit to its registered owner');
    assert.equal(fixture.events.listenerCount('beforeExit'), 1);
  });

  test('same coordinator registration is idempotent and a different owner cannot replace it', () => {
    const fixture = createManagerHarness();
    assert.equal(typeof fixture.a.registerMcpShutdownCoordinator, 'function', 'The shutdown owner API must be exported');
    const first: McpShutdownCoordinator = () => {};
    fixture.a.registerMcpShutdownCoordinator(first);
    assert.doesNotThrow(() => fixture.b.registerMcpShutdownCoordinator(first));
    assert.throws(() => fixture.b.registerMcpShutdownCoordinator(() => {}));
  });

  test('nonfunction coordinator inputs neither create a store nor replace its existing owner', async () => {
    const fixture = createManagerHarness();
    assert.equal(typeof fixture.a.registerMcpShutdownCoordinator, 'function', 'The shutdown owner API must be exported');
    const register = fixture.a.registerMcpShutdownCoordinator as (value: unknown) => void;
    for (const invalid of [undefined, null, 'not a coordinator', 1, {}]) {
      assert.throws(() => register(invalid), { name: 'TypeError', message: 'MCP shutdown coordinator must be a function.' });
      assert.equal(fixture.sharedGlobal.__canvasMcpManagerStore, undefined, 'Invalid input must not create manager state');
    }
    const signals: NodeJS.Signals[] = [];
    fixture.b.registerMcpShutdownCoordinator(signal => { signals.push(signal); });
    fixture.a.startMcpIdleCleanup();
    for (const invalid of [undefined, null, false, {}]) {
      assert.throws(() => register(invalid), { name: 'TypeError', message: 'MCP shutdown coordinator must be a function.' });
    }
    fixture.events.emit('SIGTERM', 'SIGTERM');
    await drainMicrotasks();
    assert.deepEqual(signals, ['SIGTERM'], 'Invalid input must not replace the valid shutdown owner');
    assert.deepEqual(fixture.exits, []);
  });

  for (const failure of ['throw', 'reject'] as const) {
    test(`coordinator ${failure} is observed without independent MCP cleanup or process exit`, async () => {
      const fixture = createManagerHarness();
      fixture.a.startMcpIdleCleanup();
      assert.equal(typeof fixture.b.registerMcpShutdownCoordinator, 'function', 'The shutdown owner API must be exported');
      let closes = 0;
      const entry: FixtureEntry = { serverName: 'owned-fixture', transport: 'stdio', abortController: new AbortController(),
        client: { close: async () => { closes += 1; } } };
      fixture.sharedGlobal.__canvasMcpManagerStore!.entries.set('owned-fixture', entry);
      fixture.b.registerMcpShutdownCoordinator(() => {
        if (failure === 'throw') throw new Error('synthetic coordinator failure');
        return Promise.reject(new Error('synthetic coordinator failure'));
      });
      fixture.events.emit('SIGTERM', 'SIGTERM');
      await drainMicrotasks();
      assert.deepEqual(fixture.exits, []);
      assert.equal(closes, 0, 'The coordinator remains responsible for its resource shutdown');
      assert.equal(entry.abortController.signal.aborted, false);
      assert.ok(fixture.logs.some(message => message.includes('synthetic coordinator failure')),
        'The rejected or thrown coordinator operation must be observed');
    });
  }

  test('beforeExit still closes actual manager entries and idle cleanup remains unreferenced', async () => {
    const fixture = createManagerHarness();
    fixture.a.startMcpIdleCleanup();
    let closes = 0;
    const entry: FixtureEntry = { serverName: 'before-exit-fixture', transport: 'stdio', abortController: new AbortController(),
      client: { close: async () => { closes += 1; } } };
    fixture.sharedGlobal.__canvasMcpManagerStore!.entries.set('before-exit-fixture', entry);
    fixture.events.emit('beforeExit', 0);
    await drainMicrotasks();
    assert.equal(closes, 1);
    assert.equal(entry.closed, true);
    assert.equal(entry.abortController.signal.aborted, true);
    assert.equal(fixture.sharedGlobal.__canvasMcpManagerStore!.entries.size, 0);
    assert.deepEqual(fixture.exits, []);
    assert.deepEqual(fixture.intervals, [{ delay: 60_000, unrefs: 1 }]);
  });

  test('production build phase registers no process shutdown hooks', () => {
    const events = new EventEmitter();
    const fixtureProcess = Object.assign(events, { env: { NEXT_PHASE: 'phase-production-build' }, exit: () => {} });
    loadMcpManager({ global: {}, process: fixtureProcess, setInterval: () => ({ unref() {} }) }).startMcpIdleCleanup();
    for (const event of ['SIGTERM', 'SIGINT', 'beforeExit']) assert.equal(events.listenerCount(event), 0);
  });

  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
    test(`standalone actual manager receives native ${signal} and exits ${code}`, { timeout: 10_000 }, async t => {
      const child = spawn(process.execPath, ['--import', 'tsx', __filename, '--standalone-signal-fixture'], {
        cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NEXT_PHASE: '' },
      });
      let output = '';
      let signalSent = false;
      let identity: OwnedChildIdentity | undefined;
      let retained = false;
      let rejectIdentityFailure!: (error: Error) => void;
      const identityFailure = new Promise<never>((_resolve, reject) => { rejectIdentityFailure = reject; });
      const failAndRetain = (error: unknown) => {
        retained = true;
        retainUnknownChild(child);
        rejectIdentityFailure(new Error(`Child ${child.pid} retained without signal: ${String(error)}`));
      };
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (!retained && !signalSent && output.includes('fixture-ready\n')) {
          try {
            signalVerifiedChild(child, identity, signal);
            signalSent = true;
          } catch (error) { failAndRetain(error); }
        }
      });
      child.stderr.on('data', chunk => { output += chunk.toString(); });
      const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
      });
      const timeout = setTimeout(() => {
        if (!retained && child.exitCode === null && child.signalCode === null) {
          try { signalVerifiedChild(child, identity, 'SIGKILL'); }
          catch (error) { failAndRetain(error); }
        }
      }, 8_000);
      t.after(async () => {
        clearTimeout(timeout);
        if (retained) throw new Error(`Child ${child.pid} retained because its ownership could not be proven`);
        if (child.exitCode === null && child.signalCode === null) {
          try { signalVerifiedChild(child, identity, 'SIGKILL'); }
          catch (error) { failAndRetain(error); throw error; }
        }
        await completion;
      });
      try { identity = readOwnedChildIdentity(child); }
      catch (error) { failAndRetain(error); }
      assert.deepEqual(await Promise.race([completion, identityFailure]), { code, signal: null }, output);
      assert.equal(signalSent, true, output);
    });
  }
}

if (require.main === module) {
  if (process.argv.includes('--standalone-signal-fixture')) {
    loadMcpManager({ global: {} }).startMcpIdleCleanup();
    // Keep only this private child alive until its parent sends the native signal.
    setInterval(() => {}, 1_000);
    process.stdout.write('fixture-ready\n');
  } else {
    registerTests();
  }
}
