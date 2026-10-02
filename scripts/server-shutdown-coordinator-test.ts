import assert from 'node:assert/strict';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { loadMcpManager } from './mcp-shutdown-ownership-test';

type ChildEvent = { kind: string; pid?: number; uid?: number; nonce?: string };
type CaseKind = 'empty' | 'active-mcp' | 'reject-other' | 'sync-reject-other' | 'force';
const baseline = process.argv.includes('--baseline');

function loadServerShutdown(source: string, server: { close(callback: (error?: Error) => void): void }) {
  const ast = ts.createSourceFile('server.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const start = ast.statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'shutdownInProgress'));
  const end = ast.statements.find(statement => ts.isExpressionStatement(statement)
    && statement.expression.getText(ast).startsWith("process.on('uncaughtException'"));
  assert.ok(start && end, 'exercise the actual shutdown declarations, functions and signal registrations');
  const code = source.slice(start.getStart(ast), end.getStart(ast));
  assert.match(code, /10_000/u, 'keep the real ten-second force-exit boundary');
  return new Function('server', 'process', 'console', 'setTimeout', `${code}
    return {
      shutdownServer,
      setResources(resources) {
        flushCollaborationDocuments = resources.document;
        flushExcalidrawCollaborationDocuments = resources.excalidraw;
        closeChatWebSocketServer = resources.chat;
        closeLiveEventsServer = resources.live;
        ${code.includes('let closeMcpServers') ? 'closeMcpServers = resources.mcp;' : ''}
      }
    };`)(server, process, console, setTimeout) as {
      shutdownServer(signal: NodeJS.Signals): Promise<void>;
      setResources(resources: Record<string, () => Promise<void>>): void;
    };
}

async function runShutdownChild(kind: CaseKind): Promise<void> {
  const send = (event: string) => process.send?.({ kind: event });
  const source = (file: string) => baseline
    ? execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' })
    : readFileSync(path.resolve(file), 'utf8');
  const manager = loadMcpManager({ source: source('app/lib/mcp/manager.ts'), process });
  let releaseDocument!: () => void;
  let releaseMcp!: () => void;
  const documentGate = new Promise<void>(resolve => { releaseDocument = resolve; });
  const mcpGate = new Promise<void>(resolve => { releaseMcp = resolve; });
  const shutdown = loadServerShutdown(source('server.js'), {
    close: callback => { send('http-close'); setImmediate(callback); },
  });
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).startsWith('[Startup] Error while')) send('cleanup-error');
    originalError(...args);
  };
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (String(args[0]).startsWith('[Startup] Forced exit')) send('forced-exit');
    originalWarn(...args);
  };
  shutdown.setResources({
    document: async () => {
      send('document-start');
      if (kind === 'empty' || kind === 'force') await documentGate;
      send('document-finish');
    },
    excalidraw: () => {
      if (kind === 'sync-reject-other') throw new Error('Owned fixture synchronous cleanup rejection');
      return kind === 'reject-other'
        ? Promise.reject(new Error('Owned fixture cleanup rejection'))
        : Promise.resolve();
    },
    chat: async () => {},
    live: async () => {},
    mcp: manager.closeAllMcpServers,
  });
  // Install the real MCP hook before coordination to cover lazy runtime startup.
  manager.startMcpIdleCleanup();
  if (kind === 'active-mcp' || kind === 'reject-other' || kind === 'sync-reject-other') {
    const runtime = globalThis as typeof globalThis & {
      __canvasMcpManagerStore: { entries: Map<string, unknown> };
    };
    runtime.__canvasMcpManagerStore.entries.set('owned-fixture', {
      serverName: 'owned-fixture', transport: 'http', abortController: new AbortController(),
      client: { close: async () => { send('mcp-start'); await mcpGate; send('mcp-finish'); } },
    });
  }
  if (typeof manager.registerMcpShutdownCoordinator === 'function') {
    manager.registerMcpShutdownCoordinator(shutdown.shutdownServer);
  }
  process.on('message', message => {
    if (message === 'release-document') releaseDocument();
    if (message === 'release-mcp') releaseMcp();
  });
  // This owned child remains alive until an actual OS signal starts shutdown.
  setInterval(() => {}, 1_000);
  process.send?.({ kind: 'ready', pid: process.pid, uid: process.getuid?.(), nonce: process.env.CANVAS_SHUTDOWN_CHILD_NONCE });
}

function verifyOwnedChild(child: ChildProcess, identity: string): void {
  assert.ok(child.pid && child.exitCode === null && child.signalCode === null, 'only a live owned child can be signalled');
  const current = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'pid=,ppid=,uid=,lstart='], { encoding: 'utf8' }).trim();
  assert.equal(current, identity, 'PID, parent, UID and birth identity must still match');
}

async function runChildCase(kind: CaseKind, signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
  const nonce = randomUUID();
  const child = fork(__filename, ['--child', kind, ...(baseline ? ['--baseline'] : [])], {
    silent: true,
    env: { PATH: process.env.PATH, NODE_ENV: 'test', CANVAS_SHUTDOWN_CHILD_NONCE: nonce },
  });
  const events: ChildEvent[] = [];
  const notifications = new EventEmitter();
  let output = '';
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let identity: string | undefined;
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  child.on('message', message => { events.push(message as ChildEvent); notifications.emit('update'); });
  const exit = new Promise<void>(resolve => child.once('exit', (code, exitSignal) => {
    exited = { code, signal: exitSignal }; notifications.emit('update'); resolve();
  }));
  child.on('error', error => { output += error.message; notifications.emit('update'); });

  async function waitForEvent(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Owned ${kind}/${signal} child timed out`)); }, timeoutMs);
      const check = () => {
        if (predicate()) { cleanup(); resolve(); }
        else if (exited) { cleanup(); reject(new Error(`Owned ${kind}/${signal} child exited before the required proof: ${JSON.stringify(exited)} ${output}`)); }
      };
      const cleanup = () => { clearTimeout(timer); notifications.removeListener('update', check); };
      notifications.on('update', check);
      check();
    });
  }

  try {
    await waitForEvent(() => events.some(event => event.kind === 'ready'));
    const ready = events.find(event => event.kind === 'ready')!;
    assert.equal(ready.pid, child.pid);
    assert.equal(ready.uid, process.getuid?.());
    assert.equal(ready.nonce, nonce);
    identity = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'pid=,ppid=,uid=,lstart='], { encoding: 'utf8' }).trim();
    const fields = identity.split(/\s+/u);
    assert.equal(Number(fields[1]), process.pid);
    assert.equal(Number(fields[2]), process.getuid?.());
    verifyOwnedChild(child, identity);
    const signalledAt = Date.now();
    assert.equal(child.kill(signal), true);
    await waitForEvent(() => events.some(event => event.kind === 'document-start'));
    if (kind === 'force') {
      await waitForEvent(() => exited !== undefined, 12_000);
      assert.ok(Date.now() - signalledAt >= 9_500, 'the existing ten-second deadline must remain active');
      assert.equal(events.some(event => event.kind === 'forced-exit'), true);
      assert.equal(events.some(event => event.kind === 'http-close'), false);
    } else {
      if (kind !== 'empty') await waitForEvent(() => events.some(event => event.kind === 'mcp-start'));
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.equal(exited, undefined, 'MCP must not terminate the process while a document or MCP cleanup is pending');
      assert.equal(events.some(event => event.kind === 'http-close'), false);
      child.send(kind === 'empty' ? 'release-document' : 'release-mcp');
      await waitForEvent(() => exited !== undefined);
      assert.equal(events.some(event => event.kind === 'document-finish'), true);
      assert.equal(events.some(event => event.kind === 'http-close'), true);
      if (kind !== 'empty') assert.equal(events.some(event => event.kind === 'mcp-finish'), true);
      if (kind === 'reject-other' || kind === 'sync-reject-other') assert.equal(events.some(event => event.kind === 'cleanup-error'), true);
    }
    assert.deepEqual(exited, { code: signal === 'SIGINT' ? 130 : 143, signal: null });
  } finally {
    if (!exited) {
      assert.ok(identity, 'unknown child identity must never be signalled');
      verifyOwnedChild(child, identity);
      child.kill('SIGKILL');
      await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error('Owned child did not exit after bounded cleanup')), 3_000))]);
    }
  }
}

async function runServerShutdownProof(): Promise<void> {
  const source = readFileSync(path.resolve('server.js'), 'utf8');
  const ast = ts.createSourceFile('server.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const start = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'startServer');
  assert.ok(start && ts.isFunctionDeclaration(start) && start.body);
  const registration = start.body.statements.find(statement => statement.getText(ast).includes('mcpManager.registerMcpShutdownCoordinator(shutdownServer)'));
  if (!baseline) {
    assert.ok(registration, 'registration must be a required top-level startup step, outside optional WebSocket catch');
    const startText = start.getText(ast);
    assert.ok(startText.indexOf('await assertDirectMcpStartupReady()') < startText.indexOf('registerMcpShutdownCoordinator(shutdownServer)'));
    assert.ok(startText.indexOf('registerMcpShutdownCoordinator(shutdownServer)') < startText.indexOf("import('./server/websocket-server.ts')"));
  }

  for (const [kind, signal] of [
    ['empty', 'SIGTERM'], ['empty', 'SIGINT'], ['active-mcp', 'SIGTERM'], ['reject-other', 'SIGTERM'], ['sync-reject-other', 'SIGTERM'], ['force', 'SIGTERM'],
  ] as const) {
    await runChildCase(kind, signal);
    console.log(`server-shutdown-coordinator-test: ${kind}/${signal} PASS`);
  }
}

if (require.main === module) {
  const childIndex = process.argv.indexOf('--child');
  void (childIndex >= 0 ? runShutdownChild(process.argv[childIndex + 1] as CaseKind) : runServerShutdownProof())
    .catch(error => { console.error(error); process.exitCode = 1; });
}
