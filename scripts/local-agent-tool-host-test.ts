import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import ts from 'typescript';

const HOST_FILE = path.resolve('scripts/collaboration-agent-test-host.ts');
const SESSION_ID = 'session-1';
const USER_ID = 'user-1';
const AGENT_ID = 'agent-1';
const WORKSPACE_ID = 'workspace-1';
const FIXTURE_PATH = 'fvrc-1008-ordinary-00000000-0000-4000-8000-000000000001.md';
const TOOL_CALL_ID = 'ordinary-edit-00000000-0000-4000-8000-000000000001';
const QA_TARGET = { baseURL: 'http://localhost:4126', port: 4126, bindingHash: 'a'.repeat(64) };
type TestSocket = EventEmitter & { setTimeout(): void; destroy(): void; end(value: string): void };

type HostExports = {
  __test: {
    executeFixtureTool(value: unknown): Promise<unknown>;
    main(): Promise<void>;
    startOwnedCollaborationAgentTestHost(): Promise<{ socketPath: string; receiptPath: string; close(): Promise<void> }>;
  };
};

type TestState = {
  environment: Record<string, string>;
  serverImports: number;
  tempDirectoryCreates: number;
  serverCreates: number;
  portProbes: number;
  dbOpens: number;
  dbQueries: Array<{ sql: string; values: unknown[] }>;
  sessionRow: boolean;
  resolvedRequests: Array<Record<string, unknown>>;
  executionAuthorities: unknown[];
  toolExecutions: Array<{ name: string; callId: string; params: unknown }>;
  authority: Record<string, unknown>;
  events: string[];
  receipts: Array<{ path: string; data: string; options: Record<string, unknown> }>;
  connectionHandler?: (socket: TestSocket) => void;
  listened: boolean;
  closeCalls: number;
  ownSignals: string[];
  processEvents: EventEmitter;
  fireDrainDeadline?: () => void;
  removedFiles: string[];
};

const canonicalEnvironment = {
  NODE_ENV: 'development',
  COLLABORATION_E2E: '1',
  CANVAS_PROPOSAL_REVIEW_LOCAL_TEST: '1',
  HOSTNAME: '127.0.0.1',
  PORT: '3000',
  CANVAS_DATABASE_PROVIDER: 'postgres',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:55433/canvas_notebook',
};

function fixtureInput(overrides: Record<string, unknown> = {}) {
  return {
    toolName: 'edit_file',
    toolCallId: TOOL_CALL_ID,
    params: { path: FIXTURE_PATH },
    context: { sessionId: SESSION_ID, userId: USER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID },
    ...overrides,
  };
}

async function loadHost(options: {
  environment?: Record<string, string>;
  sessionRow?: boolean;
  occupiedPort?: boolean;
  authority?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  qaGuardError?: Error;
  startReady?: boolean;
  bridgeReady?: boolean;
  deferredTool?: Promise<unknown>;
  receiptWriteError?: boolean;
  firstApplicationShutdown?: Promise<void>;
} = {}): Promise<{ host: HostExports; state: TestState }> {
  const source = await readFile(HOST_FILE, 'utf8');
  const ast = ts.createSourceFile(HOST_FILE, source, ts.ScriptTarget.Latest, true);
  const entries = ast.statements.filter(statement => ts.isIfStatement(statement)
    && statement.expression.getText(ast) === 'require.main === module');
  assert.equal(entries.length, 1, 'host has one explicit CLI-only entry');
  const entry = entries[0];
  assert.match(entry.getText(ast), /void main\(\)\.catch/u);
  const testableSource = `${source.slice(0, entry.pos)}${source.slice(entry.end)}\nexports.__test = { main, executeFixtureTool, startOwnedCollaborationAgentTestHost };\n`;
  const compiled = ts.transpileModule(testableSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });

  const state: TestState = {
    environment: { ...canonicalEnvironment, ...options.environment },
    serverImports: 0,
    tempDirectoryCreates: 0,
    serverCreates: 0,
    portProbes: 0,
    dbOpens: 0,
    dbQueries: [] as Array<{ sql: string; values: unknown[] }>,
    sessionRow: options.sessionRow ?? true,
    resolvedRequests: [] as Array<Record<string, unknown>>,
    executionAuthorities: [] as unknown[],
    toolExecutions: [] as Array<{ name: string; callId: string; params: unknown }>,
    authority: (options.authority ?? {
      userId: USER_ID, sessionId: SESSION_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID,
      rootPath: '/server-authority', legacy: false, permissions: { canRead: true, canWrite: true },
    }) as Record<string, unknown>,
    events: [], receipts: [], listened: false, closeCalls: 0, ownSignals: [],
    processEvents: new EventEmitter(), removedFiles: [],
  };
  const bridge: { __canvasCollaborationDirectConnection?: () => void } = {};
  let clock = Date.now();
  const testDate = class extends Date { static now() { return clock; } };

  const dependencies: Record<string, unknown> = {
    'node:crypto': { randomUUID },
    'node:child_process': { execFileSync() { return '501 Fri Oct 2 10:00:00 2026'; } },
    './lib/owned-collaboration-qa': {
      async requireOwnedCollaborationQaTarget() {
        state.events.push('qa-target');
        if (options.qaGuardError) throw options.qaGuardError;
        return QA_TARGET;
      },
    },
    '../app/lib/db': {
      async openDb() {
        state.dbOpens += 1;
        return {
          async get(sql: string, values: unknown[]) {
            state.dbQueries.push({ sql, values });
            if (sql.includes('created_at >= $6')) {
              assert.equal(typeof values[5], 'number', 'bigint timestamp comparison uses a numeric millisecond value');
              assert.ok(Number.isSafeInteger(values[5]));
            }
            return state.sessionRow ? { found: 1 } : undefined;
          },
          async close() {},
        };
      },
    },
    '../app/lib/pi/session-workspace-context': {
      async resolveAgentExecutionContextForStoredSession(request: Record<string, unknown>) {
        state.resolvedRequests.push(request);
        return state.authority;
      },
    },
    '../app/lib/pi/agent-execution-context': {
      async runWithAgentExecutionContext(authority: unknown, run: () => Promise<unknown>) {
        state.executionAuthorities.push(authority);
        return run();
      },
    },
    '../app/lib/pi/core-tools': {
      piTools: ['read', 'write', 'edit_file', 'apply_patch', 'shell', 'write_file'].map((name) => ({
        name,
        async execute(callId: string, params: unknown) {
          state.toolExecutions.push({ name, callId, params });
          return options.deferredTool ? await options.deferredTool : { name, callId, params };
        },
      })),
    },
    'node:fs/promises': {
      async mkdtemp() { state.tempDirectoryCreates += 1; return '/tmp/never-created'; },
      async chmod() {}, async rm() {},
      async writeFile(filename: string, data: string, writeOptions: Record<string, unknown>) {
        if (filename.endsWith('host-binding.json') && options.receiptWriteError) throw new Error('Receipt failed');
        state.events.push(filename.endsWith('drain-failed.json') ? 'drain-failure' : 'receipt');
        state.receipts.push({ path: filename, data, options: writeOptions });
      },
    },
    'node:fs': { unlinkSync(filename: string) { state.removedFiles.push(filename); }, rmdirSync() {} },
    'node:net': {
      createConnection() {
        state.portProbes += 1;
        state.events.push('port-preflight');
        if (!options.occupiedPort && !options.startReady) throw new Error('Unexpected port preflight');
        const socket = new EventEmitter() as EventEmitter & { setTimeout: () => void; destroy: () => void };
        socket.setTimeout = () => {};
        socket.destroy = () => {};
        queueMicrotask(() => options.occupiedPort ? socket.emit('connect') : socket.emit('error', { code: 'ECONNREFUSED' }));
        return socket;
      },
      createServer(handler: (socket: TestSocket) => void) {
        state.serverCreates += 1;
        if (!options.startReady) throw new Error('test must not start a server');
        state.connectionHandler = handler;
        const server = new EventEmitter() as EventEmitter & {
          listen(socket: string, ready: () => void): void; close(done: () => void): void;
        };
        server.listen = (_socket, ready) => { state.listened = true; state.events.push('socket-ready'); ready(); };
        server.close = (done) => { state.closeCalls += 1; done(); };
        return server;
      },
    },
    'node:path': path,
    'node:module': {
      createRequire() {
        return (request: string) => {
          if (request === '../server.js') {
            state.serverImports = Number(state.serverImports) + 1;
            if (!options.startReady) throw new Error('test must not import the application server');
            state.events.push('server-import');
            for (const signal of ['SIGTERM', 'SIGINT']) {
              if (options.firstApplicationShutdown) state.processEvents.on(signal, () => {
                state.events.push(`earlier-shutdown-start:${signal}`);
                return options.firstApplicationShutdown!.then(() => { state.events.push(`earlier-shutdown-finish:${signal}`); });
              });
              state.processEvents.on(signal, () => { state.events.push(`app-shutdown:${signal}`); });
            }
            if (options.bridgeReady !== false) bridge.__canvasCollaborationDirectConnection = () => {};
            return {};
          }
          if (Object.hasOwn(dependencies, request)) return dependencies[request];
          if (Object.hasOwn(options.dependencies ?? {}, request)) return options.dependencies?.[request];
          throw new Error(`Unexpected host dependency: ${request}`);
        };
      },
    },
  };
  const exports = {};
  const fakeProcess = Object.assign(state.processEvents, { env: state.environment, exitCode: undefined as number | undefined,
    pid: 12345, getuid: () => 501, kill(_pid: number, signal: string) { state.ownSignals.push(signal); } });
  for (const signal of ['SIGTERM', 'SIGINT']) fakeProcess.on(signal, () => state.events.push(`preexisting:${signal}`));
  const fakeRequire = (request: string) => {
    if (!Object.hasOwn(dependencies, request)) throw new Error(`Unexpected host import: ${request}`);
    return dependencies[request];
  };
  const fakeFetch = async () => {
    state.events.push('health');
    if (options.bridgeReady === false) clock += 130_000;
    return { ok: true, json: async () => ({ status: 'healthy', collaboration: { websocketReady: true, persistenceReady: true } }) };
  };
  new Function('require', 'module', 'exports', '__filename', 'process', 'globalThis', 'fetch', 'Date', 'setTimeout', compiled.outputText)(
    fakeRequire, { exports }, exports, HOST_FILE, fakeProcess, bridge, fakeFetch, testDate,
    (callback: () => void, delay: number) => {
      if (delay !== 10_000) return setTimeout(callback, 0);
      const timer = setTimeout(callback, delay);
      state.fireDrainDeadline = () => { clearTimeout(timer); callback(); };
      return timer;
    },
  );
  return { host: exports as HostExports, state };
}

test('startup gates refuse production, missing opt-ins, and remote databases before importing server', async () => {
  const refusedEnvironments: Array<Record<string, string>> = [
    { NODE_ENV: 'production' },
    { COLLABORATION_E2E: '0' },
    { CANVAS_PROPOSAL_REVIEW_LOCAL_TEST: '0' },
    { HOSTNAME: '0.0.0.0' },
    { PORT: '3001' },
    { CANVAS_DATABASE_PROVIDER: 'sqlite' },
    { DATABASE_URL: 'postgres://test:test@192.0.2.10:5432/test' },
    { DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/canvas_notebook' },
    { DATABASE_URL: 'postgres://test:test@127.0.0.1:55433/other_database' },
  ];
  for (const environment of refusedEnvironments) {
    const { host, state } = await loadHost({ environment });
    await assert.rejects(host.__test.main());
    assert.equal(state.serverImports, 0, JSON.stringify(environment));
    assert.equal(state.serverCreates, 0, JSON.stringify(environment));
    assert.equal(state.tempDirectoryCreates, 0, JSON.stringify(environment));
    assert.equal(state.portProbes, 0, JSON.stringify(environment));
  }
});

test('occupied application port is refused before temporary files or server import', async () => {
  const { host, state } = await loadHost({ occupiedPort: true });
  await assert.rejects(host.__test.main(), /Port occupied/u);
  assert.equal(state.portProbes, 1);
  assert.equal(state.serverImports, 0);
  assert.equal(state.serverCreates, 0);
  assert.equal(state.tempDirectoryCreates, 0);
});

test('fixture validation allows scoped file tools and rejects invalid tool names and traversal paths', async () => {
  for (const value of [
    fixtureInput({ toolName: 'shell' }),
    fixtureInput({ toolName: 'write_file' }),
    fixtureInput({ params: { path: '../../etc/passwd' } }),
    fixtureInput({ params: { path: '/tmp/fvrc-1008-ordinary-00000000-0000-4000-8000-000000000001.md' } }),
    fixtureInput({ toolName: 'apply_patch', params: { files: [{ path: '../../etc/passwd', edits: [] }] } }),
    fixtureInput({ toolName: 'apply_patch', params: { files: [
      { path: FIXTURE_PATH, edits: [] }, { path: FIXTURE_PATH, edits: [] },
    ] } }),
  ]) {
    const { host, state } = await loadHost();
    await assert.rejects(host.__test.executeFixtureTool(value));
    assert.equal(state.dbOpens, 0, 'syntactically invalid fixture requests fail before database access');
    assert.equal(state.resolvedRequests.length, 0);
  }
});

test('stored session query requires exact fixture title and excludes archived sessions', async () => {
  const { host, state } = await loadHost({ sessionRow: false });
  await assert.rejects(host.__test.executeFixtureTool(fixtureInput()));
  assert.equal(state.dbOpens, 1);
  assert.equal(state.dbQueries.length, 1);
  const [{ sql, values }] = state.dbQueries;
  assert.match(sql, /title = \$5/u);
  assert.match(sql, /archived_at IS NULL/u);
  assert.match(sql, /created_at >= \$6/u);
  assert.deepEqual(values.slice(0, 5), [SESSION_ID, USER_ID, AGENT_ID, WORKSPACE_ID,
    `FVRC ordinary graph tool acceptance:${FIXTURE_PATH}`]);
  assert.equal(typeof values[5], 'number');
  assert.ok(Number.isSafeInteger(values[5]), 'created_at cutoff uses the bigint millisecond representation');
  assert.equal(state.resolvedRequests.length, 0);
});

test('execution authority is freshly resolved from stored session and caller permissions/paths are ignored', async () => {
  for (const toolName of ['read', 'write', 'edit_file']) {
    const authority = { userId: USER_ID, sessionId: SESSION_ID, agentId: AGENT_ID,
      workspaceId: WORKSPACE_ID, rootPath: '/server-current-root', legacy: false,
      permissions: { canRead: true, canWrite: false, canRunAgent: false } };
    const { host, state } = await loadHost({ authority });
    const result = await host.__test.executeFixtureTool(fixtureInput({ toolName, context: {
      sessionId: SESSION_ID, userId: USER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID,
      permissions: ['canWrite', 'canRunAgent'], rootPath: '/caller-root',
      path: '/caller-context-path',
    } }));

    assert.deepEqual(state.resolvedRequests, [{
      sessionId: SESSION_ID, userId: USER_ID, agentId: AGENT_ID,
      permissions: ['canRead', 'canWrite', 'canRunAgent'],
    }]);
    assert.deepEqual(state.executionAuthorities, [authority]);
    assert.deepEqual(state.toolExecutions, [{ name: toolName, callId: TOOL_CALL_ID, params: { path: FIXTURE_PATH } }]);
    assert.deepEqual(result, { name: toolName, callId: TOOL_CALL_ID, params: { path: FIXTURE_PATH } });
  }
  const { host, state } = await loadHost();
  const patchParams = { files: [{ path: FIXTURE_PATH, edits: [{ oldText: 'a', newText: 'b' }] }] };
  const patch = await host.__test.executeFixtureTool(fixtureInput({ toolName: 'apply_patch', params: patchParams }));
  assert.deepEqual(state.toolExecutions, [{ name: 'apply_patch', callId: TOOL_CALL_ID, params: patchParams }]);
  assert.deepEqual(patch, { name: 'apply_patch', callId: TOOL_CALL_ID, params: patchParams });
});

test('missing stored session and legacy or wrong-workspace authority fail closed before a tool executes', async () => {
  for (const options of [
    { sessionRow: false },
    { authority: { workspaceId: WORKSPACE_ID, legacy: true } },
    { authority: { workspaceId: 'foreign-workspace', legacy: false } },
  ]) {
    const { host, state } = await loadHost(options);
    await assert.rejects(host.__test.executeFixtureTool(fixtureInput()));
    assert.equal(state.toolExecutions.length, 0);
  }
});

test('the host issues turn IDs and carries them only across the scoped fixture lifecycle', async () => {
  const events: Array<{ action: string; identity: Record<string, unknown> }> = [];
  const service = Object.fromEntries(['begin', 'touch', 'finish'].map(action => [action,
    async (identity: Record<string, unknown>) => { events.push({ action, identity }); },
  ]));
  const { host, state } = await loadHost({ dependencies: {
    '../app/lib/file-version-center/agent-turn-history': { agentTurnHistoryService: service },
  } });
  const control = (turnAction: string) => host.__test.executeFixtureTool(fixtureInput({ turnAction }));
  await assert.rejects(control('finish'), /lifecycle/u);
  const begin = await control('begin') as { details: { agentTurnId: string } };
  const firstTurn = begin.details.agentTurnId;
  await assert.rejects(control('begin'), /lifecycle/u);
  await host.__test.executeFixtureTool(fixtureInput({ context: {
    sessionId: SESSION_ID, userId: USER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID,
    agentTurnId: 'caller-controlled-turn',
  } }));
  assert.equal((state.executionAuthorities[0] as Record<string, unknown>).agentTurnId, firstTurn);
  await control('finish');
  const next = await control('begin') as { details: { agentTurnId: string } };
  assert.notEqual(next.details.agentTurnId, firstTurn);
  assert.deepEqual(events.map(event => event.action), ['begin', 'touch', 'finish', 'begin']);
  assert.deepEqual(events[0].identity, { turnId: firstTurn, workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId: SESSION_ID });
});

test('QA target refusal happens before port probing, temporary files and application imports', async () => {
  const { host, state } = await loadHost({ environment: { NODE_ENV: 'production' }, qaGuardError: new Error('target rejected') });
  await assert.rejects(host.__test.startOwnedCollaborationAgentTestHost(), /target rejected/u);
  assert.deepEqual(state.events, ['qa-target']);
  assert.equal(state.portProbes, 0); assert.equal(state.tempDirectoryCreates, 0);
  assert.equal(state.serverCreates, 0); assert.equal(state.serverImports, 0);
});

test('QA readiness publishes an owned process binding only after real server health and its direct bridge', async () => {
  const { host, state } = await loadHost({ environment: { NODE_ENV: 'production' }, startReady: true });
  const running = await host.__test.startOwnedCollaborationAgentTestHost();
  assert.equal(state.serverImports, 1);
  assert.deepEqual(state.events, ['qa-target', 'port-preflight', 'server-import', 'health', 'socket-ready', 'receipt']);
  assert.equal(state.receipts.length, 1);
  assert.equal(state.receipts[0].path, running.receiptPath);
  assert.deepEqual(state.receipts[0].options, { mode: 0o600, flag: 'wx' });
  const receipt = JSON.parse(state.receipts[0].data);
  assert.equal(receipt.pid, 12345); assert.equal(receipt.port, QA_TARGET.port);
  assert.equal(receipt.bindingHash, QA_TARGET.bindingHash);
  assert.equal(receipt.processStartIdentity, '501 Fri Oct 2 10:00:00 2026');
  await running.close(); await running.close();
  assert.equal(state.closeCalls, 1);
});

test('healthy HTTP without the same-process collaboration bridge never publishes the tool socket', async () => {
  const { host, state } = await loadHost({ startReady: true, bridgeReady: false });
  await assert.rejects(host.__test.startOwnedCollaborationAgentTestHost(), /did not become ready/u);
  assert.equal(state.listened, false); assert.equal(state.receipts.length, 0);
  assert.deepEqual(state.ownSignals, ['SIGTERM']);
});

test('shared close rejects new work and waits for the actual pending tool before destroying connections', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const { host, state } = await loadHost({ startReady: true, deferredTool: pending });
  const running = await host.__test.startOwnedCollaborationAgentTestHost();
  const replies: string[] = [];
  const socket = new EventEmitter() as TestSocket;
  socket.setTimeout = () => {};
  socket.end = value => { replies.push(value); };
  let destroyed = false;
  socket.destroy = () => { destroyed = true; socket.emit('close'); };
  state.connectionHandler!(socket);
  socket.emit('data', Buffer.from(`${JSON.stringify({ input: fixtureInput() })}\n`));
  for (let round = 0; round < 10 && !state.toolExecutions.length; round += 1) await Promise.resolve();
  assert.equal(state.toolExecutions.length, 1);
  let closed = false;
  const closing = running.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.equal(destroyed, false);
  const refused = new EventEmitter() as TestSocket;
  refused.setTimeout = () => {}; refused.destroy = () => refused.emit('close');
  refused.end = value => { replies.push(value); };
  state.connectionHandler!(refused);
  refused.emit('data', Buffer.from(`${JSON.stringify({ input: fixtureInput() })}\n`));
  assert.deepEqual(JSON.parse(replies[0]), { error: 'unavailable' });
  release({ accepted: true }); await closing;
  assert.equal(closed, true); assert.equal(destroyed, true);
  assert.equal(state.toolExecutions.length, 1);
  assert.deepEqual(JSON.parse(replies[1]), { result: { accepted: true } });
});

test('app signal handlers wait for the pending real tool while preexisting handlers remain untouched', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const { host, state } = await loadHost({ startReady: true, deferredTool: pending });
  const running = await host.__test.startOwnedCollaborationAgentTestHost();
  const socket = new EventEmitter() as TestSocket;
  socket.setTimeout = () => {};
  socket.end = () => { state.events.push('tool-reply'); };
  socket.destroy = () => { state.events.push('tool-disconnect'); socket.emit('close'); };
  state.connectionHandler!(socket);
  socket.emit('data', Buffer.from(`${JSON.stringify({ input: fixtureInput() })}\n`));
  for (let round = 0; round < 10 && !state.toolExecutions.length; round += 1) await Promise.resolve();
  assert.equal(state.toolExecutions.length, 1);
  state.processEvents.emit('SIGTERM');
  state.processEvents.emit('SIGINT');
  await Promise.resolve();
  assert.ok(state.events.includes('preexisting:SIGTERM'));
  assert.ok(state.events.includes('preexisting:SIGINT'));
  assert.equal(state.events.some(event => event.startsWith('app-shutdown:')), false);
  assert.equal(state.events.includes('tool-disconnect'), false);
  const refused = new EventEmitter() as TestSocket;
  refused.setTimeout = () => {}; refused.destroy = () => refused.emit('close');
  const refusedReplies: string[] = []; refused.end = value => { refusedReplies.push(value); };
  state.connectionHandler!(refused);
  refused.emit('data', Buffer.from(`${JSON.stringify({ input: fixtureInput() })}\n`));
  assert.deepEqual(JSON.parse(refusedReplies[0]), { error: 'unavailable' });
  release({ accepted: true });
  await running.close(); await Promise.resolve();
  assert.equal(state.closeCalls, 1);
  assert.deepEqual(state.events.filter(event => event.startsWith('app-shutdown:')), ['app-shutdown:SIGTERM']);
  assert.ok(state.events.indexOf('tool-reply') < state.events.indexOf('app-shutdown:SIGTERM'));
  assert.ok(state.events.indexOf('tool-disconnect') < state.events.indexOf('app-shutdown:SIGTERM'));
});

test('signal drain deadline rejects without app shutdown and retains the exact private receipt evidence', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const { host, state } = await loadHost({ startReady: true, deferredTool: pending });
  const running = await host.__test.startOwnedCollaborationAgentTestHost();
  const socket = new EventEmitter() as TestSocket;
  socket.setTimeout = () => {}; socket.end = () => {}; socket.destroy = () => socket.emit('close');
  state.connectionHandler!(socket);
  socket.emit('data', Buffer.from(`${JSON.stringify({ input: fixtureInput() })}\n`));
  for (let round = 0; round < 10 && !state.toolExecutions.length; round += 1) await Promise.resolve();
  state.processEvents.emit('SIGTERM');
  assert.ok(state.fireDrainDeadline);
  state.fireDrainDeadline();
  await assert.rejects(running.close(), /did not drain within 10000ms/u);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(state.events.some(event => event.startsWith('app-shutdown:')), false);
  const marker = state.receipts.find(receipt => receipt.path.endsWith('drain-failed.json'));
  assert.ok(marker);
  assert.deepEqual(marker.options, { mode: 0o600, flag: 'wx' });
  assert.equal(JSON.parse(marker.data).activeExecutionPending, true);
  assert.equal(JSON.parse(marker.data).deadlineMs, 10_000);
  assert.equal((state.processEvents as EventEmitter & { exitCode: number }).exitCode, 1);
  state.processEvents.emit('exit');
  assert.deepEqual(state.removedFiles, [], 'a failed drain never removes its receipt or socket evidence');
  release({ accepted: true }); await Promise.resolve(); await Promise.resolve();
  assert.equal(state.events.some(event => event.startsWith('app-shutdown:')), false);
});

test('all captured original signal handlers start synchronously before an earlier async shutdown resolves', async () => {
  let finishEarlier!: () => void;
  const firstApplicationShutdown = new Promise<void>(resolve => { finishEarlier = resolve; });
  const { host, state } = await loadHost({ startReady: true, firstApplicationShutdown });
  const running = await host.__test.startOwnedCollaborationAgentTestHost();
  state.processEvents.emit('SIGTERM');
  try {
    await running.close(); await Promise.resolve();
    assert.deepEqual(state.events.filter(event => event.includes('shutdown')), [
      'earlier-shutdown-start:SIGTERM', 'app-shutdown:SIGTERM',
    ], 'the later HTTP flush must start while the earlier asynchronous shutdown is still pending');
    assert.ok(state.events.includes('preexisting:SIGTERM'));
    assert.equal(state.closeCalls, 1);
  } finally { finishEarlier(); await Promise.resolve(); await Promise.resolve(); }
});

test('a late original once handler is adopted after ready and cannot bypass pending tool drain', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const { host, state } = await loadHost({ startReady: true, deferredTool: pending });
  const running = await host.__test.startOwnedCollaborationAgentTestHost();
  const socket = new EventEmitter() as TestSocket;
  socket.setTimeout = () => {};
  socket.end = () => { state.events.push('tool-reply'); };
  socket.destroy = () => { state.events.push('tool-disconnect'); socket.emit('close'); };
  state.connectionHandler!(socket);
  socket.emit('data', Buffer.from(`${JSON.stringify({ input: fixtureInput() })}\n`));
  for (let round = 0; round < 10 && !state.toolExecutions.length; round += 1) await Promise.resolve();
  assert.equal(state.toolExecutions.length, 1);
  const lateOriginal = (signal: string) => { state.events.push(`late-shutdown:${signal}`); };
  state.processEvents.once('SIGTERM', lateOriginal);
  const rawOnce = state.processEvents.rawListeners('SIGTERM').at(-1)!;
  assert.equal((rawOnce as { listener?: unknown }).listener, lateOriginal);
  state.processEvents.once('non-signal-event', () => state.events.push('non-signal-retained'));
  await Promise.resolve(); // Like the kernel signal callback, dispatch after registration's microtasks.
  state.processEvents.emit('non-signal-event');
  assert.ok(state.events.includes('non-signal-retained'));
  state.processEvents.emit('SIGTERM', 'SIGTERM');
  try {
    await Promise.resolve();
    assert.equal(state.events.some(event => event.includes('shutdown:')), false,
      'neither early nor late original handler may start before the pending tool finishes');
    assert.ok(state.events.includes('preexisting:SIGTERM'));
  } finally { release({ accepted: true }); await running.close(); await Promise.resolve(); }
  assert.deepEqual(state.events.filter(event => event.includes('shutdown:')), [
    'app-shutdown:SIGTERM', 'late-shutdown:SIGTERM',
  ]);
  assert.ok(state.events.indexOf('tool-reply') < state.events.indexOf('app-shutdown:SIGTERM'));
  assert.ok(state.events.indexOf('tool-disconnect') < state.events.indexOf('late-shutdown:SIGTERM'));
  rawOnce.call(state.processEvents, 'SIGTERM');
  assert.equal(state.events.filter(event => event === 'late-shutdown:SIGTERM').length, 1,
    'the captured raw once wrapper still invokes its exact original callback once');
});

test('the original development launcher does not install the QA late-listener observer', async () => {
  const { host, state } = await loadHost({ startReady: true });
  await host.__test.main();
  assert.equal(state.processEvents.listenerCount('newListener'), 0);
});

test('post-listen receipt failure never returns a discoverable owned host', async () => {
  const { host, state } = await loadHost({ startReady: true, receiptWriteError: true });
  await assert.rejects(host.__test.startOwnedCollaborationAgentTestHost(), /Receipt failed/u);
  assert.equal(state.listened, true);
  assert.equal(state.receipts.length, 0);
});

test('importing either isolated launcher does not start an application server', async () => {
  const source = await readFile(path.resolve('scripts/collaboration-agent-qa-test-host.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  let starts = 0;
  const exports = {} as { main(): Promise<void> };
  const fakeRequire = () => ({ async startOwnedCollaborationAgentTestHost() { starts += 1; } });
  new Function('require', 'module', 'exports', 'process', compiled.outputText)(fakeRequire, { exports }, exports, { exitCode: 0 });
  assert.equal(starts, 0);
  await exports.main(); assert.equal(starts, 1);
});

test('QA entry exits unsuccessfully when a post-listen startup step rejects', async () => {
  const source = await readFile(path.resolve('scripts/collaboration-agent-qa-test-host.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exits: number[] = [];
  const fakeModule = { exports: {} };
  const fakeRequire = Object.assign(() => ({ async startOwnedCollaborationAgentTestHost() {
    throw new Error('Post-listen private receipt failed');
  } }), { main: fakeModule });
  new Function('require', 'module', 'exports', 'process', compiled.outputText)(fakeRequire, fakeModule,
    fakeModule.exports, { exit(code: number) { exits.push(code); } });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(exits, [1], 'the owned entry does not leave a half-started source alive');
});

type OrdinaryClient = {
  requireOwnedQaAgentToolSocket(socketPath: string): Promise<void>;
  runOrdinaryAgentTool(input: unknown, options?: { inProcess?: boolean; graphMode?: 'off' }): Promise<unknown>;
};

async function loadOrdinaryClient(socketPath: string) {
  const filename = path.resolve('tests/helpers/ordinary-agent-tool.ts');
  const compiled = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const environment: Record<string, string | undefined> = { NODE_ENV: 'production', COLLABORATION_E2E: '1',
    CANVAS_COLLABORATION_QA: '1', CANVAS_LOCAL_AGENT_TOOL_SOCKET: socketPath };
  const state = { guardCalls: 0, socketCalls: 0, cliCalls: 0, cliMode: undefined as string | undefined };
  const dependencies: Record<string, unknown> = {
    'node:child_process': { execFile }, 'node:path': path,
    'node:fs': await import('node:fs'), 'node:fs/promises': await import('node:fs/promises'),
    'node:util': { promisify: () => async (command: string, args: string[], options: import('node:child_process').ExecFileOptionsWithStringEncoding) => {
      if (command === '/bin/ps') return promisify(execFile)(command, args, options);
      state.cliCalls += 1; state.cliMode = options.env?.CANVAS_PROPOSAL_GRAPH_MODE;
      return { stdout: JSON.stringify({ details: { outcome: 'unchanged' } }), stderr: '' };
    } },
    '../../scripts/lib/owned-collaboration-qa': { async requireOwnedCollaborationQaTarget() {
      state.guardCalls += 1;
      if (environment.CANVAS_COLLABORATION_QA !== '1') throw new Error('explicit QA rejected');
      return QA_TARGET;
    } },
    './local-agent-tool-client': { async runLocalAgentTool() { state.socketCalls += 1; return { details: { outcome: 'applied' } }; } },
  };
  const exports = {};
  const fakeRequire = (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected client import: ${name}`);
    return dependencies[name];
  };
  const fakeProcess = { env: environment, getuid: process.getuid, kill: process.kill, cwd: () => process.cwd() };
  new Function('require', 'module', 'exports', 'process', compiled.outputText)(fakeRequire, { exports }, exports, fakeProcess);
  return { client: exports as OrdinaryClient, environment, state };
}

async function ownedSocketFixture() {
  const directory = await mkdtemp('/tmp/canvas-agent-qa-e2e-');
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, 'tools.sock');
  const receiptPath = path.join(directory, 'host-binding.json');
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  const receipt = { version: 1, pid: process.pid, port: QA_TARGET.port, bindingHash: QA_TARGET.bindingHash,
    startedAt: Date.now(), processStartIdentity: execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'uid=', '-o', 'lstart='],
      { encoding: 'utf8' }).trim().replace(/\s+/gu, ' ') };
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
  return { directory, socketPath, receiptPath, receipt, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true });
  } };
}

test('production in-process calls require live UID/start identity and exact private socket/target receipts', async () => {
  const fixture = await ownedSocketFixture();
  try {
    const { client, state } = await loadOrdinaryClient(fixture.socketPath);
    await client.runOrdinaryAgentTool(fixtureInput(), { inProcess: true });
    assert.equal(state.guardCalls, 1); assert.equal(state.socketCalls, 1); assert.equal(state.cliCalls, 0);
    for (const change of [
      { bindingHash: 'b'.repeat(64) }, { port: 3000 }, { pid: 2147483647 },
      { processStartIdentity: `${process.getuid?.()} Thu Jan 1 00:00:00 1970` }, { startedAt: Date.now() + 60_000 },
    ]) {
      await writeFile(fixture.receiptPath, JSON.stringify({ ...fixture.receipt, ...change }));
      await assert.rejects(client.runOrdinaryAgentTool(fixtureInput(), { inProcess: true }),
        { message: 'The explicit local in-process tool harness is required.' });
    }
    assert.equal(state.socketCalls, 1, 'rejected receipts never reach the tool transport');
  } finally { await fixture.close(); }
});

test('QA client rejects public or linked files and missing opt-in without opening its transport', async () => {
  const fixture = await ownedSocketFixture();
  try {
    const { client, environment, state } = await loadOrdinaryClient(fixture.socketPath);
    for (const [filename, publicMode, privateMode] of [
      [fixture.directory, 0o755, 0o700], [fixture.socketPath, 0o666, 0o600], [fixture.receiptPath, 0o644, 0o600],
    ] as const) {
      await chmod(filename, publicMode);
      await assert.rejects(client.requireOwnedQaAgentToolSocket(fixture.socketPath));
      await chmod(filename, privateMode);
    }
    const realReceipt = path.join(fixture.directory, 'saved-receipt.json');
    await writeFile(realReceipt, JSON.stringify(fixture.receipt), { mode: 0o600, flag: 'wx' });
    await unlink(fixture.receiptPath); await symlink(realReceipt, fixture.receiptPath);
    assert.equal((await lstat(fixture.receiptPath)).isSymbolicLink(), true);
    await assert.rejects(client.requireOwnedQaAgentToolSocket(fixture.socketPath));
    await unlink(fixture.receiptPath); await writeFile(fixture.receiptPath, JSON.stringify(fixture.receipt), { mode: 0o600, flag: 'wx' });
    delete environment.CANVAS_COLLABORATION_QA;
    await assert.rejects(client.runOrdinaryAgentTool(fixtureInput(), { inProcess: true }));
    assert.equal(state.socketCalls, 0);
  } finally { await fixture.close(); }
});

test('development and separate graph-off CLI paths preserve their existing transport contracts', async () => {
  const { client, environment, state } = await loadOrdinaryClient('/legacy/private/tools.sock');
  environment.NODE_ENV = 'development'; delete environment.CANVAS_COLLABORATION_QA;
  await client.runOrdinaryAgentTool(fixtureInput(), { inProcess: true });
  assert.equal(state.socketCalls, 1); assert.equal(state.guardCalls, 0);
  await assert.rejects(client.runOrdinaryAgentTool(fixtureInput(), { inProcess: true, graphMode: 'off' }));
  await client.runOrdinaryAgentTool(fixtureInput(), { graphMode: 'off' });
  assert.equal(state.cliCalls, 1); assert.equal(state.cliMode, 'off'); assert.equal(state.guardCalls, 0);
});
