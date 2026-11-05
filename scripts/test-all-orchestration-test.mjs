import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { independentTestScripts, serverTestScripts } from './helpers/test-all-results.mjs';

const runner = fileURLToPath(new URL('./test-all.mjs', import.meta.url));
const fixtureExecutable = `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const stage = name === 'npx' ? 'playwright' : args[1];
console.log('Fixture command: ' + stage);
appendFileSync('commands.jsonl', JSON.stringify({ name, args, env: {
  PORT: process.env.PORT, HOSTNAME: process.env.HOSTNAME, NODE_ENV: process.env.NODE_ENV,
  BASE_URL: process.env.BASE_URL, BETTER_AUTH_BASE_URL: process.env.BETTER_AUTH_BASE_URL,
  CANVAS_APP_ROOT: process.env.CANVAS_APP_ROOT,
  CANVAS_TERMINAL_SOCKET: process.env.CANVAS_TERMINAL_SOCKET,
  TEST_LOGIN_EMAIL: process.env.TEST_LOGIN_EMAIL, TEST_LOGIN_PASSWORD: process.env.TEST_LOGIN_PASSWORD,
  E2E_EXTERNAL_SERVER: process.env.E2E_EXTERNAL_SERVER,
} }) + '\\n');
if (stage === 'playwright') {
  const skipped = { title: 'explicit skip', file: 'fixture.spec.ts', line: 2, tests: [{ status: 'skipped', expectedStatus: 'skipped', annotations: [{ type: 'skip', description: 'Fixture capability disabled' }], results: [] }] };
  const passed = { title: 'passed case', file: 'fixture.spec.ts', line: 1, tests: [{ status: 'expected', expectedStatus: 'passed', results: [{ status: 'passed', errors: [] }] }] };
  const specs = [passed, skipped];
  if (process.env.FIXTURE_BROWSER_FAILURE === '1') specs.push({ title: 'failed case', file: 'fixture.spec.ts', line: 3,
    tests: [{ status: 'unexpected', expectedStatus: 'passed', results: [{ status: 'failed', errors: [{ message: 'Synthetic browser assertion' }] }] }] });
  if (process.env.FIXTURE_BROWSER_BLOCKED === '1') specs.push({ title: 'interrupted case', file: 'fixture.spec.ts', line: 4,
    tests: [{ status: 'unexpected', expectedStatus: 'passed', results: [{ status: 'interrupted', errors: [] }] }] });
  if (process.env.FIXTURE_BROWSER_BLOCKED === '1') specs.push({ title: 'serial case never started', file: 'fixture.spec.ts', line: 5, tests: [{ status: 'skipped', expectedStatus: 'passed', results: [] }] });
  if (process.env.FIXTURE_MISSING_BROWSER_REPORT !== '1') writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({
    suites: [{ title: 'fixture', specs }], stats: { expected: 1, skipped: 1 }, errors: [] }));
}
if (stage === 'start') {
  writeFileSync('server-owner.pid', String(process.pid));
  if (process.env.FIXTURE_EXIT_START === '1') process.exit(19);
  const child = spawn(process.execPath, [path.join(process.cwd(), 'server-fixture.mjs')], {
    env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  writeFileSync('server.pid', String(child.pid));
  // npm is allowed to leave a descendant behind: runner must clean the entire owned group.
  process.on('SIGTERM', () => process.exit(0));
  if (process.env.FIXTURE_SUPPRESS_READY_LOG === '1') setTimeout(() => process.exit(19), 1000);
  setInterval(() => {}, 1000);
} else if (stage === 'test:smoke' && process.env.FIXTURE_DIE_DURING_SUITE === '1') {
  await fetch(new URL('/exit-owner', process.env.BASE_URL));
  setInterval(() => {}, 1000);
} else if (stage === 'test:smoke' && process.env.FIXTURE_HOLD_SUITE === '1') {
  writeFileSync('suite.pid', String(process.pid));
  setInterval(() => {}, 1000);
} else if ((process.env.FIXTURE_FAIL_STAGE || '').split(',').includes(stage)) {
  process.exit(23);
}
`;
const fixtureServer = `import http from 'node:http';
import { appendFileSync } from 'node:fs';
// Deliberately ignore TERM so successful cleanup must reach descendant KILL.
process.on('SIGTERM', () => {});
const server = http.createServer((request, response) => {
  appendFileSync('requests.jsonl', JSON.stringify({ url: request.url }) + '\\n');
  if (request.url === '/exit-owner') {
    response.end('ok');
    setTimeout(() => process.kill(process.ppid, 'SIGTERM'), 10);
    return;
  }
  if (process.env.FIXTURE_HANG_HEALTH === '1') return;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ status: 'healthy' }));
});
server.listen(Number(process.env.PORT), '127.0.0.1', () => {
  if (process.env.FIXTURE_SUPPRESS_READY_LOG !== '1') console.log('> Ready on http://localhost:' + process.env.PORT);
});
`;

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(t, extraEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'canvas-runner-test-'));
  await writeFile(path.join(directory, 'npm'), fixtureExecutable, { mode: 0o700 });
  await writeFile(path.join(directory, 'npx'), fixtureExecutable, { mode: 0o700 });
  await writeFile(path.join(directory, 'server-fixture.mjs'), fixtureServer, { mode: 0o600 });
  const port = await availablePort();
  const env = {
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    HOME: directory,
    PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`,
    TEST_LOGIN_EMAIL: 'runner@example.invalid', TEST_LOGIN_PASSWORD: 'local-fixture-password',
    CANVAS_APP_ROOT: '/wrong-checkout', HOSTNAME: 'foreign-host.invalid',
    NODE_ENV: 'development', CANVAS_TERMINAL_SOCKET: '/foreign/active-terminal.sock',
    BETTER_AUTH_BASE_URL: 'http://foreign-host.invalid',
    TEST_ALL_REPORT_DIR: path.join(directory, 'report'),
    ...extraEnv,
  };
  if (extraEnv.FIXTURE_ACCELERATED_CLOCK === '1') {
    const preload = path.join(directory, 'clock-preload.mjs');
    await writeFile(preload, `Object.defineProperty(globalThis.performance, 'now', {
      value: (() => { let clock = 0; return () => clock += 30_000; })(),
    });\n`);
    env.NODE_OPTIONS = `--import=${preload}`;
  }
  let output = '';
  const child = spawn(process.execPath, [runner], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
  t.after(async () => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await completion;
    await rm(directory, { recursive: true, force: true });
  });
  return {
    child, completion, directory, env, output: () => output,
    report: async () => JSON.parse(await readFile(path.join(directory, 'report/results.json'), 'utf8')),
    commands: async () => {
      try { return (await readFile(path.join(directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
  };
}

async function waitUntil(check) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Fixture did not reach its expected boundary');
}

async function assertPidStopped(pid) {
  await waitUntil(async () => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  });
}

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return server.address().port;
}

test('external mode uses the supplied live server without build/start or killing it', async t => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: 'healthy' }));
  });
  const port = await listen(t, server);
  const run = await fixture(t, { E2E_EXTERNAL_SERVER: '1', BASE_URL: `http://127.0.0.1:${port}`, PORT: '3000' });
  assert.equal((await run.completion).code, 0, run.output());
  const commands = await run.commands();
  assert.deepEqual(commands.map(command => command.name === 'npx' ? 'playwright' : command.args[1]),
    [...independentTestScripts, ...serverTestScripts, 'playwright']);
  assert.match(run.output(), /Build this checkout before starting/);
  assert.deepEqual(requests, ['/api/health']);
  assert.equal(server.listening, true);
  const playwright = commands.at(-1);
  assert.deepEqual(playwright.args, ['--no-install', 'playwright', 'test', '--workers=1', '--max-failures=0', '--reporter=line,json', '--output=' + path.join(run.directory, 'report/playwright-artifacts')]);
  assert.equal(playwright.env.TEST_LOGIN_EMAIL, run.env.TEST_LOGIN_EMAIL);
  assert.equal(playwright.env.TEST_LOGIN_PASSWORD, run.env.TEST_LOGIN_PASSWORD);
  assert.equal(playwright.env.BASE_URL, `http://127.0.0.1:${port}`);
  assert.equal(playwright.env.NODE_ENV, 'development');
});

test('normal mode builds once, uses the exact checkout and cleans its whole process group', async t => {
  const run = await fixture(t);
  assert.equal((await run.completion).code, 0, run.output());
  const commands = await run.commands();
  assert.deepEqual(commands.map(command => command.name === 'npx' ? 'playwright' : command.args[1]),
    [...independentTestScripts, 'build', 'start', ...serverTestScripts, 'playwright']);
  const start = commands.find(command => command.args[1] === 'start');
  assert.equal(start.env.HOSTNAME, '127.0.0.1');
  assert.equal(start.env.NODE_ENV, 'production');
  assert.equal(start.env.CANVAS_APP_ROOT, await realpath(run.directory));
  assert.notEqual(start.env.CANVAS_TERMINAL_SOCKET, '/tmp/canvas-terminal.sock');
  assert.notEqual(start.env.CANVAS_TERMINAL_SOCKET, run.env.CANVAS_TERMINAL_SOCKET);
  assert.equal(start.env.BETTER_AUTH_BASE_URL, start.env.BASE_URL);
  await assert.rejects(access(path.dirname(start.env.CANVAS_TERMINAL_SOCKET)), { code: 'ENOENT' });
  assert.equal(commands.at(-1).env.E2E_EXTERNAL_SERVER, '1');
  assert.equal(commands.at(-1).env.TEST_LOGIN_PASSWORD, run.env.TEST_LOGIN_PASSWORD);
  await assertPidStopped(Number(await readFile(path.join(run.directory, 'server.pid'), 'utf8')));
});

for (const external of [false, true]) {
  test(`independent failures do not suppress later checks or ${external ? 'external' : 'owned'} server suites`, async t => {
    const server = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ status: 'healthy' }));
    });
    const port = await listen(t, server);
    const failed = ['test:browser:environment:unit', 'test:api-keys:management'];
    const run = await fixture(t, { FIXTURE_FAIL_STAGE: failed.join(','),
      ...(external ? { E2E_EXTERNAL_SERVER: '1', BASE_URL: `http://127.0.0.1:${port}` } : {}) });
    assert.equal((await run.completion).code, 1, run.output());
    const commands = await run.commands();
    for (const script of [...independentTestScripts, ...serverTestScripts]) assert(commands.some(command => command.args[1] === script), script);
    assert(commands.some(command => command.name === 'npx'));
    const report = await run.report();
    assert.deepEqual(report.stages.filter(stage => stage.status === 'failed').map(stage => stage.id), failed);
    assert.equal(report.stages.find(stage => stage.id === 'playwright').status, 'passed');
    assert.equal(report.stages.find(stage => stage.id === 'build').status, external ? 'skipped' : 'passed');
    assert.equal(report.stages.find(stage => stage.id === 'cleanup').status, 'passed');
    assert.equal(report.browser.counts.skipped, 1);
    assert.equal(server.listening, true);
  });
}

test('build failure blocks only dependent runtime checks and is not reported as success', async t => {
  const run = await fixture(t, { FIXTURE_FAIL_STAGE: 'build' });
  assert.equal((await run.completion).code, 1, run.output());
  const report = await run.report();
  assert.equal(report.stages.find(stage => stage.id === 'build').status, 'failed');
  for (const id of ['server-start', 'server-health', ...serverTestScripts, 'playwright']) {
    assert.equal(report.stages.find(stage => stage.id === id).status, 'blocked', id);
  }
  for (const id of independentTestScripts) assert.equal(report.stages.find(stage => stage.id === id).status, 'passed', id);
  assert.equal((await run.commands()).some(command => command.args[1] === 'start'), false);
});

test('browser report preserves failed, skipped and interrupted case details without hiding a nonzero exit', async t => {
  const run = await fixture(t, { FIXTURE_FAIL_STAGE: 'playwright', FIXTURE_BROWSER_FAILURE: '1', FIXTURE_BROWSER_BLOCKED: '1' });
  assert.equal((await run.completion).code, 1, run.output());
  const report = await run.report();
  assert.deepEqual(report.browser.counts, { passed: 1, failed: 1, skipped: 1, blocked: 2 });
  assert.equal(report.stages.find(stage => stage.id === 'playwright').status, 'failed');
  assert.match(await readFile(path.join(run.directory, 'report/summary.md'), 'utf8'), /Fixture capability disabled/);
  assert.match(await readFile(path.join(run.directory, 'report/playwright.log'), 'utf8'), /./u);
});

test('missing browser JSON cannot turn a nominally successful command into a green run', async t => {
  const run = await fixture(t, { FIXTURE_MISSING_BROWSER_REPORT: '1' });
  assert.equal((await run.completion).code, 1, run.output());
  assert.equal((await run.report()).stages.find(stage => stage.id === 'playwright').status, 'failed');
});

for (const url of ['http://example.invalid:3000', 'http://runner:secret@localhost:3000',
  'http://localhost:3000/other', 'http://localhost:3000?other=1', 'http://localhost:3000#other',
  'ftp://localhost:3000', 'http://[::1]:3000']) {
  test(`normal mode rejects unsafe or unsupported origin ${url.replace('runner:secret@', '')}`, async t => {
    const run = await fixture(t, { BASE_URL: url, PORT: '3000' });
    assert.equal((await run.completion).code, 1);
    assert.deepEqual(await run.commands(), []);
    assert.doesNotMatch(run.output(), /secret/);
  });
}

test('normal mode rejects mismatched URL/PORT and malformed PORT before build', async t => {
  for (const env of [{ BASE_URL: 'http://127.0.0.1:3000', PORT: '3001' }, { PORT: '3000garbage' }, { PORT: '65536' }]) {
    const run = await fixture(t, env);
    assert.equal((await run.completion).code, 1);
    assert.deepEqual(await run.commands(), []);
  }
});

for (const httpListener of [false, true]) {
  test(`occupied ${httpListener ? 'HTTP 503' : 'non-HTTP TCP'} port is rejected without touching its listener`, async t => {
    const server = httpListener ? http.createServer((_, response) => { response.writeHead(503); response.end(); })
      : net.createServer(socket => { socket.on('error', () => {}); });
    const port = await listen(t, server);
    const run = await fixture(t, { PORT: String(port), BASE_URL: `http://127.0.0.1:${port}` });
    assert.equal((await run.completion).code, 1);
    assert.match(run.output(), /already occupied/);
    assert.deepEqual(await run.commands(), []);
    assert.equal(server.listening, true);
  });
}

test('external mode requires existing credentials', async t => {
  const run = await fixture(t, { E2E_EXTERNAL_SERVER: '1', TEST_LOGIN_EMAIL: '', TEST_LOGIN_PASSWORD: '' });
  assert.equal((await run.completion).code, 1);
  assert.match(run.output(), /requires existing/);
  assert.deepEqual(await run.commands(), []);
});

test('an exited owned server cannot pass readiness', async t => {
  const run = await fixture(t, { FIXTURE_EXIT_START: '1' });
  assert.equal((await run.completion).code, 1);
  assert.match(run.output(), /owned test server exited/);
  assert.equal((await run.commands()).some(command => command.args[1] === 'test:smoke'), false);
});

test('healthy HTTP during startup cannot pass without the owned listen callback', async t => {
  const run = await fixture(t, { FIXTURE_SUPPRESS_READY_LOG: '1' });
  assert.equal((await run.completion).code, 1, run.output());
  assert.match(run.output(), /owned test server exited/);
  assert.match(await readFile(path.join(run.directory, 'requests.jsonl'), 'utf8'), /api\/health/);
  assert.equal((await run.commands()).some(command => command.args[1] === 'test:smoke'), false);
  await assertPidStopped(Number(await readFile(path.join(run.directory, 'server.pid'), 'utf8')));
});

test('owned server death during a suite fails and stops the ongoing suite and descendants', async t => {
  const run = await fixture(t, { FIXTURE_DIE_DURING_SUITE: '1' });
  assert.equal((await run.completion).code, 1, run.output());
  assert.match(run.output(), /owned test server exited/);
  assert.equal((await run.commands()).some(command => command.name === 'npx'), false);
  await assertPidStopped(Number(await readFile(path.join(run.directory, 'server.pid'), 'utf8')));
});

test('suite failure cleans owned descendants and leaves an unrelated listener alive', async t => {
  const unrelated = http.createServer((_, response) => response.end('unrelated'));
  const port = await listen(t, unrelated);
  const run = await fixture(t, { FIXTURE_FAIL_STAGE: 'test:integration' });
  assert.equal((await run.completion).code, 1);
  assert.equal((await run.commands()).some(command => command.name === 'npx'), true);
  const report = await run.report();
  assert.equal(report.stages.find(stage => stage.id === 'test:integration').status, 'failed');
  assert.equal(report.stages.find(stage => stage.id === 'test:integration:pi').status, 'passed');
  await assertPidStopped(Number(await readFile(path.join(run.directory, 'server.pid'), 'utf8')));
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'unrelated');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
test(`${signal} cleans the owned server and currently running suite`, async t => {
  const run = await fixture(t, { FIXTURE_HOLD_SUITE: '1' });
  await waitUntil(async () => { try { await readFile(path.join(run.directory, 'suite.pid')); return true; } catch { return false; } });
  run.child.kill(signal);
  assert.equal((await run.completion).code, 1, run.output());
  assert.ok(run.output().includes(`interrupted by ${signal}`));
  for (const file of ['server.pid', 'suite.pid']) {
    await assertPidStopped(Number(await readFile(path.join(run.directory, file), 'utf8')));
  }
});
}

test('hanging readiness fetch is interrupted when the owned server dies', async t => {
  const run = await fixture(t, { FIXTURE_HANG_HEALTH: '1' });
  await waitUntil(async () => { try { return (await readFile(path.join(run.directory, 'requests.jsonl'), 'utf8')).includes('/api/health'); } catch { return false; } });
  // Only signal this fixture's npm parent: no listener lookup or foreign process kill.
  process.kill(Number(await readFile(path.join(run.directory, 'server-owner.pid'), 'utf8')), 'SIGTERM');
  const started = Date.now();
  assert.equal((await run.completion).code, 1);
  assert.match(run.output(), /owned test server exited/);
  assert.ok(Date.now() - started < 5_000);
  await assertPidStopped(Number(await readFile(path.join(run.directory, 'server.pid'), 'utf8')));
});

test('readiness budget includes a hung response and never starts suites after timeout', async t => {
  let requests = 0;
  const server = http.createServer(() => { requests += 1; });
  const port = await listen(t, server);
  const started = Date.now();
  const run = await fixture(t, { E2E_EXTERNAL_SERVER: '1', BASE_URL: `http://127.0.0.1:${port}`,
    FIXTURE_ACCELERATED_CLOCK: '1' });
  assert.equal((await run.completion).code, 1, run.output());
  assert.match(run.output(), /within 120 seconds/);
  assert.ok(requests >= 1);
  assert.ok(Date.now() - started < 8_000, 'Per-fetch abort must also bound an unresponsive endpoint');
  assert.deepEqual((await run.commands()).map(command => command.args[1]),
    independentTestScripts);
  assert.equal(server.listening, true);
});

test('independent plan preserves every original aggregate leaf without executing an aggregate twice', async () => {
  const scripts = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  const expand = name => scripts[name].split(' && ').flatMap(command => {
    const match = /^npm run ([\w:-]+)$/u.exec(command);
    return match ? expand(match[1]) : [command];
  });
  const groups = ['test:browser:environment', 'test:browser:lifecycle', 'test:server:shutdown',
    'test:internal:scheduler', 'test:cli:portable', 'test:api-keys', 'test:prompt-builder'];
  const expected = groups.flatMap(expand);
  const actual = independentTestScripts.flatMap(expand);
  assert.equal(new Set(independentTestScripts).size, independentTestScripts.length);
  assert.deepEqual(actual, expected);
  assert.equal(scripts['test:all'], 'node scripts/test-all.mjs', 'no outer && chain may short-circuit the report');
});
