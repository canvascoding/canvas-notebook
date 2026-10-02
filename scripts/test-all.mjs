import { spawn } from 'node:child_process';
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
  const owned = startOwnedProcess(command, args, options);
  try {
    const result = await supervise(owned.completion, server);
    if (result.error) throw result.error;
    if (result.code !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed (${result.signal || result.code})`);
    }
  } finally {
    await stopOwnedProcess(owned);
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
  const external = process.env.E2E_EXTERNAL_SERVER === '1';
  if (external && !(process.env.TEST_LOGIN_EMAIL && process.env.TEST_LOGIN_PASSWORD)
    && !(process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD)) {
    throw new Error('External validation requires existing TEST_LOGIN_* or BOOTSTRAP_ADMIN_* credentials');
  }
  const credentials = resolveTestCredentials();
  const configuredUrl = process.env.BASE_URL ? resolveBaseUrl(process.env.BASE_URL, external) : null;
  const configuredPort = process.env.PORT ? parsePort(process.env.PORT) : null;
  const urlPort = configuredUrl ? Number(configuredUrl.port || (configuredUrl.protocol === 'https:' ? 443 : 80)) : null;
  if (!external && configuredPort && urlPort && configuredPort !== urlPort) {
    throw new Error('BASE_URL and PORT must identify the same test instance');
  }
  const port = (external ? urlPort || configuredPort : configuredPort || urlPort)
    || (external ? 3000 : await findAvailablePort());
  const baseUrl = configuredUrl?.origin || `http://127.0.0.1:${port}`;
  if (!external && !(await isPortAvailable(port))) throw new Error(`Test port ${port} is already occupied`);
  const env = {
    ...process.env,
    NODE_ENV: external ? process.env.NODE_ENV || 'production' : 'production',
    CANVAS_APP_ROOT: process.cwd(),
    PORT: String(port),
    BASE_URL: baseUrl,
    BETTER_AUTH_BASE_URL: baseUrl,
    TEST_LOGIN_EMAIL: credentials.email,
    TEST_LOGIN_PASSWORD: credentials.password,
    E2E_EXTERNAL_SERVER: '1',
  };
  const onSignal = signal => interruption.abort(new Error(`Validation interrupted by ${signal}`));
  const onInterrupt = () => onSignal('SIGINT');
  const onTerminate = () => onSignal('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  let socketDirectory;
  let server;
  try {
    await runCommand('npm', ['run', 'test:server:shutdown'], { env });
    await runCommand('npm', ['run', 'test:cli:portable'], { env });
    if (external) {
      console.log('[test:all] External server mode: skipping build and startup. Build this checkout before starting the supplied server.');
    } else {
      await runCommand('npm', ['run', 'build'], { env });
      if (!(await isPortAvailable(port))) throw new Error(`Test port ${port} became occupied before startup`);
      socketDirectory = await mkdtemp(path.join(os.tmpdir(), 'canvas-test-all-'));
      env.CANVAS_TERMINAL_SOCKET = path.join(socketDirectory, 'terminal.sock');
      server = startOwnedProcess('npm', ['run', 'start'], { stdio: ['inherit', 'pipe', 'pipe'], env: {
        ...env,
        HOSTNAME: '127.0.0.1',
        CANVAS_TERMINAL_USE_UNIX_SOCKET: 'true',
        BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL || credentials.email,
        BOOTSTRAP_ADMIN_PASSWORD: process.env.BOOTSTRAP_ADMIN_PASSWORD || credentials.password,
        BOOTSTRAP_ADMIN_NAME: process.env.BOOTSTRAP_ADMIN_NAME || 'Test Admin',
      } });
      // HTTP alone cannot identify our server if another process takes the port
      // during startup migrations. Require this server.js listen callback too.
      let startupOutput = '';
      server.child.stdout.on('data', chunk => {
        process.stdout.write(chunk);
        startupOutput += chunk.toString();
        const lines = startupOutput.split('\n');
        startupOutput = lines.pop().slice(-16_384);
        if (lines.some(line => line.trim() === `> Ready on http://localhost:${port}`)) server.listening = true;
      });
      server.child.stderr.on('data', chunk => process.stderr.write(chunk));
    }
    await waitForServer(baseUrl, server);
    for (const script of ['test:smoke', 'test:integration', 'test:prompt-builder', 'test:integration:pi']) {
      await runCommand('npm', ['run', script], { env }, server);
    }
    await runCommand('npx', ['--no-install', 'playwright', 'test', '--pass-with-no-tests', '--workers=1'], { env }, server);
    assertRunning(server);
  } finally {
    await Promise.all([...ownedProcesses].map(stopOwnedProcess));
    if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
