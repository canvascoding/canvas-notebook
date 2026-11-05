import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { createTestAllReport, independentTestScripts, serverTestScripts, readPlaywrightResults } from './helpers/test-all-results.mjs';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const defaultPorts = [3000, 3001, 3002];
const ownedProcesses = new Set();
const interruption = new AbortController();
const readinessTimeoutMs = 120_000;
const fetchTimeoutMs = 5_000;

function resolveTestCredentials() {
  const testEmail = process.env.TEST_LOGIN_EMAIL;
  const testPassword = process.env.TEST_LOGIN_PASSWORD;
  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if ((testEmail && !testPassword) || (!testEmail && testPassword)) {
    throw new Error('Set TEST_LOGIN_EMAIL and TEST_LOGIN_PASSWORD together');
  }

  if ((bootstrapEmail && !bootstrapPassword) || (!bootstrapEmail && bootstrapPassword)) {
    throw new Error('Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD together');
  }

  if (testEmail && testPassword) {
    return { email: testEmail, password: testPassword };
  }

  if (bootstrapEmail && bootstrapPassword) {
    return { email: bootstrapEmail, password: bootstrapPassword };
  }

  const suffix = randomBytes(6).toString('hex');
  return {
    email: `test-admin-${suffix}@local.test`,
    password: `T3st!${randomBytes(12).toString('base64url')}`,
  };
}

function startOwnedProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit', ...options, detached: process.platform !== 'win32',
  });
  const owned = { child, exited: false, stopped: false, completion: null };
  owned.completion = new Promise((resolve) => {
    child.once('error', (error) => {
      owned.exited = true;
      resolve({ error });
    });
    child.once('exit', (code, signal) => {
      owned.exited = true;
      resolve({ code, signal });
    });
  });
  ownedProcesses.add(owned);
  return owned;
}

function assertRunning(server) {
  interruption.signal.throwIfAborted();
  if (server?.exited) throw new Error('The owned test server exited before validation completed');
}

async function supervise(operation, server) {
  assertRunning(server);
  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(interruption.signal.reason);
    interruption.signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    const result = await Promise.race([
      operation,
      aborted,
      ...(server ? [server.completion.then(() => {
        throw new Error('The owned test server exited before validation completed');
      })] : []),
    ]);
    assertRunning(server);
    return result;
  } finally {
    interruption.signal.removeEventListener('abort', abortListener);
  }
}

async function stopOwnedProcess(owned) {
  if (owned.stopped) return;
  owned.stopped = true;
  ownedProcesses.delete(owned);
  const pid = owned.child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    // taskkill targets only the process created by this runner and its children.
    if (!owned.exited) {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      await new Promise(resolve => { killer.once('error', resolve); killer.once('exit', resolve); });
    }
    return;
  }
  const signalGroup = (signal) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      return false;
    }
  };
  if (!signalGroup('SIGTERM')) return;
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline && signalGroup(0)) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (signalGroup(0)) signalGroup('SIGKILL');
  await Promise.race([owned.completion, new Promise(resolve => setTimeout(resolve, 500))]);
}

async function runCommand(command, args, options = {}, server) {
  assertRunning(server);
  const { logFile, ...processOptions } = options;
  const log = logFile ? createWriteStream(logFile, { flags: 'wx', mode: 0o600 }) : null;
  log?.on('error', () => {});
  const owned = startOwnedProcess(command, args, {
    ...processOptions, ...(log ? { stdio: ['inherit', 'pipe', 'pipe'] } : {}),
  });
  if (log) {
    owned.child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
    owned.child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
  }
  const closed = new Promise(resolve => owned.child.once('close', resolve));
  try {
    const result = await supervise(owned.completion, server);
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.signal || result.code})`);
  } finally {
    await stopOwnedProcess(owned);
    await closed;
    if (log) { log.end(); await finished(log); }
  }
}

function parsePort(value) {
  if (!/^[1-9]\d*$/u.test(String(value)) || Number(value) > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return Number(value);
}

function resolveBaseUrl(value, external) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('BASE_URL must be a plain loopback HTTP(S) origin');
  }
  // start-services.sh performs its own readiness probe over IPv4 HTTP.
  if (!external && (url.protocol !== 'http:' || url.hostname === '[::1]')) {
    throw new Error('An owned test server requires an IPv4 loopback HTTP origin');
  }
  return url;
}

async function isPortAvailable(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const available = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', error => {
        if (['EADDRINUSE', 'EACCES'].includes(error.code)) resolve(false);
        else if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) resolve(true);
        else reject(error);
      });
      probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
    });
    if (!available) return false;
  }
  return true;
}

async function findAvailablePort() {
  for (const port of defaultPorts) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error('No free loopback test port is available');
}

async function waitForServer(baseUrl, server) {
  const deadline = performance.now() + readinessTimeoutMs;
  while (performance.now() < deadline) {
    assertRunning(server);
    const remaining = Math.max(1, Math.floor(deadline - performance.now()));
    const request = new AbortController();
    try {
      const ready = await supervise((async () => {
        const response = await fetch(new URL('/api/health', baseUrl), {
          signal: AbortSignal.any([interruption.signal, request.signal, AbortSignal.timeout(Math.min(fetchTimeoutMs, remaining))]),
          redirect: 'error',
        });
        const health = await response.json();
        return response.ok && (health.status === 'healthy' || health.ok === true);
      })(), server);
      if (ready && (!server || server.listening) && performance.now() < deadline) return;
    } catch {
      assertRunning(server);
    } finally {
      request.abort();
    }
    const delay = Math.min(250, Math.max(0, deadline - performance.now()));
    await supervise(new Promise(resolve => setTimeout(resolve, delay)), server);
  }
  throw new Error('Test server did not become healthy within 120 seconds');
}

async function run() {
  const results = await createTestAllReport();
  const external = process.env.E2E_EXTERNAL_SERVER === '1';
  let env, port, baseUrl, credentials, socketDirectory, server, serverLog;
  const onInterrupt = () => interruption.abort(new Error('Validation interrupted by SIGINT'));
  const onTerminate = () => interruption.abort(new Error('Validation interrupted by SIGTERM'));
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  async function stage(id, action, { dependencies = ['configuration'], skipReason, always = false } = {}) {
    if (skipReason) { await results.update(id, { status: 'skipped', reason: skipReason }); return false; }
    const blockers = dependencies.filter(dependency => results.report.stages.find(row => row.id === dependency)?.status !== 'passed');
    const reason = !always && interruption.signal.aborted ? interruption.signal.reason.message
      : blockers.length ? 'Prerequisite did not pass: ' + blockers.join(', ') : null;
    if (reason) { await results.update(id, { status: 'blocked', reason }); return false; }
    const started = performance.now();
    await results.update(id, { status: 'running', startedAt: new Date().toISOString() });
    console.log(`[test:all] START ${id}`);
    try {
      await action();
      await results.update(id, { status: 'passed', durationMs: performance.now() - started });
      console.log(`[test:all] PASSED ${id}`);
      return true;
    } catch (error) {
      const status = interruption.signal.aborted && !always ? 'blocked' : 'failed';
      await results.update(id, { status, reason: error.message, durationMs: performance.now() - started });
      console.error(`[test:all] ${status.toUpperCase()} ${id}: ${error.message}`);
      return false;
    }
  }
  const command = async (id, executable, args, serverRequired = false, extraEnvironment = {}) => {
    if (serverRequired) assertRunning(server);
    const logFile = path.join(results.directory, id.replaceAll(':', '-') + '.log');
    await results.update(id, { command: [executable, ...args], log: logFile });
    await runCommand(executable, args, { env: { ...env, ...extraEnvironment, TEST_ALL_STAGE_ID: id }, logFile }, serverRequired ? server : undefined);
  };

  try {
    await stage('configuration', async () => {
      if (external && !(process.env.TEST_LOGIN_EMAIL && process.env.TEST_LOGIN_PASSWORD)
        && !(process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD)) {
        throw new Error('External validation requires existing TEST_LOGIN_* or BOOTSTRAP_ADMIN_* credentials');
      }
      credentials = resolveTestCredentials();
      const configuredUrl = process.env.BASE_URL ? resolveBaseUrl(process.env.BASE_URL, external) : null;
      const configuredPort = process.env.PORT ? parsePort(process.env.PORT) : null;
      const urlPort = configuredUrl ? Number(configuredUrl.port || (configuredUrl.protocol === 'https:' ? 443 : 80)) : null;
      if (!external && configuredPort && urlPort && configuredPort !== urlPort) throw new Error('BASE_URL and PORT must identify the same test instance');
      port = (external ? urlPort || configuredPort : configuredPort || urlPort) || (external ? 3000 : await findAvailablePort());
      baseUrl = configuredUrl?.origin || `http://127.0.0.1:${port}`;
      if (!external && !(await isPortAvailable(port))) throw new Error(`Test port ${port} is already occupied`);
      env = { ...process.env, NODE_ENV: external ? process.env.NODE_ENV || 'production' : 'production',
        CANVAS_APP_ROOT: process.cwd(), PORT: String(port), BASE_URL: baseUrl, BETTER_AUTH_BASE_URL: baseUrl,
        TEST_LOGIN_EMAIL: credentials.email, TEST_LOGIN_PASSWORD: credentials.password, E2E_EXTERNAL_SERVER: '1' };
    }, { dependencies: [] });

    for (const script of independentTestScripts) {
      await stage(script, () => command(script, 'npm', ['run', script]));
    }
    const externalReason = external ? 'External server mode: supplied prebuilt runtime; build/start are not executed or verified by this run.' : undefined;
    if (external) console.log('[test:all] External server mode: skipping build and startup. Build this checkout before starting the supplied server.');
    await stage('build', () => command('build', 'npm', ['run', 'build']), { skipReason: externalReason });
    await stage('server-start', async () => {
      if (!(await isPortAvailable(port))) throw new Error(`Test port ${port} became occupied before startup`);
      socketDirectory = await mkdtemp(path.join(os.tmpdir(), 'canvas-test-all-'));
      env.CANVAS_TERMINAL_SOCKET = path.join(socketDirectory, 'terminal.sock');
      const logFile = path.join(results.directory, 'server.log');
      await results.update('server-start', { log: logFile });
      serverLog = createWriteStream(logFile, { flags: 'wx', mode: 0o600 });
      serverLog.on('error', () => {});
      server = startOwnedProcess('npm', ['run', 'start'], { stdio: ['inherit', 'pipe', 'pipe'], env: {
        ...env, HOSTNAME: '127.0.0.1', CANVAS_TERMINAL_USE_UNIX_SOCKET: 'true',
        BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL || credentials.email,
        BOOTSTRAP_ADMIN_PASSWORD: process.env.BOOTSTRAP_ADMIN_PASSWORD || credentials.password,
        BOOTSTRAP_ADMIN_NAME: process.env.BOOTSTRAP_ADMIN_NAME || 'Test Admin',
      } });
      let startupOutput = '';
      server.child.stdout.on('data', chunk => {
        process.stdout.write(chunk); serverLog.write(chunk);
        startupOutput += chunk.toString();
        const lines = startupOutput.split('\n'); startupOutput = lines.pop().slice(-16_384);
        if (lines.some(line => line.trim() === `> Ready on http://localhost:${port}`)) server.listening = true;
      });
      server.child.stderr.on('data', chunk => { process.stderr.write(chunk); serverLog.write(chunk); });
    }, { dependencies: ['configuration', 'build'], skipReason: externalReason });
    await stage('server-health', () => waitForServer(baseUrl, server), {
      dependencies: external ? ['configuration'] : ['configuration', 'server-start'],
    });
    for (const script of serverTestScripts) {
      await stage(script, () => command(script, 'npm', ['run', script], true), { dependencies: ['server-health'] });
    }
    await stage('playwright', async () => {
      const jsonFile = path.join(results.directory, 'playwright.json');
      let commandError;
      try {
        await command('playwright', 'npx', ['--no-install', 'playwright', 'test', '--workers=1', '--max-failures=0',
          '--reporter=line,json', '--output=' + path.join(results.directory, 'playwright-artifacts')], true,
        { PLAYWRIGHT_JSON_OUTPUT_NAME: jsonFile });
      } catch (error) { commandError = error; }
      // A nonzero Playwright exit still carries useful per-case results.
      results.report.browser = await readPlaywrightResults(jsonFile);
      await results.save();
      if (commandError) throw commandError;
      const browser = results.report.browser;
      if (browser.counts.failed || browser.counts.blocked || browser.errors.length) throw new Error('Playwright reported failed/blocked cases or global errors');
    }, { dependencies: ['server-health'] });
    await stage('server-lifetime', async () => { assertRunning(server); }, {
      dependencies: ['server-health'], skipReason: external ? 'External server lifetime is not owned by this runner.' : undefined,
    });
  } finally {
    await stage('cleanup', async () => {
      const stopped = await Promise.allSettled([...ownedProcesses].map(stopOwnedProcess));
      if (serverLog) { serverLog.end(); await finished(serverLog); }
      if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
      const errors = stopped.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Owned process cleanup failed');
    }, { dependencies: [], always: true });
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    if (!(await results.finish())) process.exitCode = 1;
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
