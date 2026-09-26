import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const HOST_FILE = path.resolve('scripts/collaboration-agent-test-host.ts');
const SESSION_ID = 'session-1';
const USER_ID = 'user-1';
const AGENT_ID = 'agent-1';
const WORKSPACE_ID = 'workspace-1';
const FIXTURE_PATH = 'fvrc-1008-ordinary-00000000-0000-4000-8000-000000000001.md';
const TOOL_CALL_ID = 'ordinary-edit-00000000-0000-4000-8000-000000000001';

type HostExports = {
  __test: {
    executeFixtureTool(value: unknown): Promise<unknown>;
    main(): Promise<void>;
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
} = {}): Promise<{ host: HostExports; state: TestState }> {
  const autoEntryPoint = "\nvoid main().catch(() => { console.error('Local agent E2E launcher refused startup.'); process.exitCode = 1; });\n";
  const source = await readFile(HOST_FILE, 'utf8');
  assert.ok(source.endsWith(autoEntryPoint), 'host keeps the expected isolated auto-entrypoint');
  const testableSource = `${source.slice(0, -autoEntryPoint.length)}\nexports.__test = { main, executeFixtureTool };\n`;
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
  };

  const dependencies: Record<string, unknown> = {
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
      piTools: ['read', 'edit_file', 'shell', 'write_file'].map((name) => ({
        name,
        async execute(callId: string, params: unknown) {
          state.toolExecutions.push({ name, callId, params });
          return { name, callId, params };
        },
      })),
    },
    'node:fs/promises': {
      async mkdtemp() { state.tempDirectoryCreates += 1; return '/tmp/never-created'; },
      async chmod() {}, async rm() {},
    },
    'node:fs': { unlinkSync() {}, rmdirSync() {} },
    'node:net': {
      createConnection() {
        state.portProbes += 1;
        if (!options.occupiedPort) throw new Error('Unexpected port preflight');
        const socket = new EventEmitter() as EventEmitter & { setTimeout: () => void; destroy: () => void };
        socket.setTimeout = () => {};
        socket.destroy = () => {};
        queueMicrotask(() => socket.emit('connect'));
        return socket;
      },
      createServer() { state.serverCreates += 1; throw new Error('test must not start a server'); },
    },
    'node:path': path,
    'node:module': {
      createRequire() {
        return (request: string) => {
          if (request === '../server.js') {
            state.serverImports = Number(state.serverImports) + 1;
            throw new Error('test must not import the application server');
          }
          if (Object.hasOwn(dependencies, request)) return dependencies[request];
          if (Object.hasOwn(options.dependencies ?? {}, request)) return options.dependencies?.[request];
          throw new Error(`Unexpected host dependency: ${request}`);
        };
      },
    },
  };
  const exports = {};
  const fakeProcess = { env: state.environment, exitCode: undefined as number | undefined, once() {} };
  const fakeRequire = (request: string) => {
    if (!Object.hasOwn(dependencies, request)) throw new Error(`Unexpected host import: ${request}`);
    return dependencies[request];
  };
  new Function('require', 'module', 'exports', '__filename', 'process', compiled.outputText)(
    fakeRequire, { exports }, exports, HOST_FILE, fakeProcess,
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

test('fixture validation allows only read/edit_file and rejects invalid tool names and traversal paths', async () => {
  for (const value of [
    fixtureInput({ toolName: 'shell' }),
    fixtureInput({ toolName: 'write_file' }),
    fixtureInput({ params: { path: '../../etc/passwd' } }),
    fixtureInput({ params: { path: '/tmp/fvrc-1008-ordinary-00000000-0000-4000-8000-000000000001.md' } }),
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
  for (const toolName of ['read', 'edit_file']) {
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
