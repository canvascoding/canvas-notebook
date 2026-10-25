#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
import { watchDevCheckout } from './dev-checkout-lifetime.mjs';

const DEFAULT_ENV_FILE = '.env.local';
const FALLBACK_DEV_PORT = 3001;
const URL_ENV_KEYS = ['BASE_URL', 'BETTER_AUTH_BASE_URL', 'OPENAI_CODEX_REDIRECT_URI'];

function resolveEnvFilePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return dotenv.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveLocalTeamSeatEnvFile(cwd) {
  const stateDir = process.env.CANVAS_LOCAL_TEAM_SEAT_STATE_DIR?.trim()
    || path.join(os.homedir(), '.local', 'state', 'canvas-local-team-seat');
  const composeEnv = readEnvFile(path.join(stateDir, 'compose.env'));
  const configuredNotebookDir = composeEnv.CANVAS_NOTEBOOK_DIR?.trim();
  const hostDevEnv = path.join(stateDir, 'notebook-host-dev.env');
  if (!configuredNotebookDir || !fs.existsSync(hostDevEnv)) return null;
  return path.resolve(configuredNotebookDir) === path.resolve(cwd) ? hostDevEnv : null;
}

function parsePort(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function appendNodeOption(nodeOptions, option) {
  return nodeOptions.includes(option)
    ? nodeOptions
    : [nodeOptions, option].filter(Boolean).join(' ');
}

function canRewriteLocalUrl(value, expectedPort) {
  try {
    const url = new URL(value);
    const port = url.port ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
    return ['localhost', '127.0.0.1'].includes(url.hostname) && port === expectedPort;
  } catch {
    return false;
  }
}

function rewriteLocalUrl(value, nextPort) {
  const url = new URL(value);
  url.port = String(nextPort);
  return url.toString();
}

function canConnectToPort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(250);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

function isPortListeningViaLsof(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  return result.status === 0 && result.stdout.trim().length > 0;
}

async function isPortBusy(port) {
  return isPortListeningViaLsof(port) || (await canConnectToPort(port));
}

async function main() {
  const localTeamSeatEnvFile = resolveLocalTeamSeatEnvFile(process.cwd());
  const configuredEnvFile = process.env.CANVAS_ENV_FILE?.trim() || localTeamSeatEnvFile || DEFAULT_ENV_FILE;
  const envFilePath = resolveEnvFilePath(configuredEnvFile);
  const fileEnv = readEnvFile(envFilePath);

  const explicitPort = parsePort(process.env.PORT);
  const requestedPort = explicitPort ?? parsePort(fileEnv.PORT) ?? 3000;
  const requestedPortBusy = requestedPort === 3000 ? await isPortBusy(requestedPort) : false;
  const selectedPort =
    explicitPort || !requestedPortBusy ? requestedPort : FALLBACK_DEV_PORT;
  const selectedPortBusy = explicitPort ? await isPortBusy(selectedPort) : false;

  if (selectedPortBusy) {
    console.error(`[dev] Port ${selectedPort} is already in use. Set PORT=<free-port> npm run dev.`);
    process.exit(1);
  }

  // Generate terminal auth token
  const terminalToken = randomBytes(32).toString('hex');
  console.log(`[dev] Terminal service token: ${terminalToken.substring(0, 8)}...`);

  const existingNodeOptions = process.env.NODE_OPTIONS || '';
  const maxOldSpaceFlag = '--max-old-space-size=4096';
  let nodeOptions = appendNodeOption(existingNodeOptions, maxOldSpaceFlag);
  const nodeMajorVersion = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (nodeMajorVersion >= 26) {
    // Tailwind and Sentry still register ESM hooks via Node's deprecated
    // module.register() API on Node 26. Keep local dev logs focused until
    // those upstream packages move to module.registerHooks().
    nodeOptions = appendNodeOption(nodeOptions, '--disable-warning=DEP0205');
  }

  const childEnv = {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    CANVAS_ENV_FILE: configuredEnvFile,
    CANVAS_APP_ROOT: process.cwd(),
    PORT: String(selectedPort),
    CANVAS_TERMINAL_TOKEN: terminalToken,
    CANVAS_TERMINAL_PORT: '3457',
    CANVAS_TERMINAL_USE_UNIX_SOCKET: 'false',
  };

  if (!explicitPort && selectedPort !== requestedPort) {
    for (const key of URL_ENV_KEYS) {
      if (process.env[key]) {
        continue;
      }
      const fileValue = fileEnv[key];
      if (typeof fileValue === 'string' && canRewriteLocalUrl(fileValue, requestedPort)) {
        childEnv[key] = rewriteLocalUrl(fileValue, selectedPort);
      }
    }
    console.log(`[dev] Port ${requestedPort} is busy. Starting local dev server on http://localhost:${selectedPort} instead.`);
  }

  const nextLockPath = path.resolve(process.cwd(), '.next', 'dev', 'lock');
  if (!selectedPortBusy && fs.existsSync(nextLockPath)) {
    fs.rmSync(nextLockPath, { force: true });
    console.log(`[dev] Removed stale Next dev lock at ${nextLockPath}.`);
  }

  if (process.env.CANVAS_DEV_DRY_RUN === '1') {
    console.log(JSON.stringify({ port: selectedPort, envFile: childEnv.CANVAS_ENV_FILE, nextLockRemoved: !selectedPortBusy }, null, 2));
    process.exit(0);
  }

  // Track all child processes for cleanup
  const childProcesses = [];
  let shuttingDown = false;
  let stopWatchingCheckout;
  const signalOwnedProcess = (child, signal) => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { stdio: 'ignore' });
      } else {
        // npx/tsx can have grandchildren. Each launcher owns a separate group.
        process.kill(-child.pid, signal);
      }
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const cleanupAndExit = (signal, code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWatchingCheckout?.();
    console.log(`[dev] ${signal}, shutting down all services...`);
    childProcesses.forEach(child => signalOwnedProcess(child, 'SIGTERM'));
    // child.killed only means a signal was sent; it does not prove an exit.
    setTimeout(() => {
      childProcesses.forEach(child => signalOwnedProcess(child, 'SIGKILL'));
      process.exit(code ?? 0);
    }, 2000);
  };
  stopWatchingCheckout = watchDevCheckout(process.cwd(), () => {
    console.error('[dev] Checkout was removed, replaced, or became unavailable. Stop background work before restarting from an existing checkout.');
    cleanupAndExit('Checkout unavailable', 1);
  });
  const forwardSignal = signal => cleanupAndExit(signal || 'Signal received', 0);
  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);
  process.on('SIGHUP', forwardSignal);
  process.on('exit', () => {
    stopWatchingCheckout?.();
    childProcesses.forEach(child => signalOwnedProcess(child, 'SIGTERM'));
  });
  const childOptions = { cwd: process.cwd(), env: childEnv, stdio: 'inherit', detached: process.platform !== 'win32' };

  // Start terminal service first
  console.log('[dev] Starting terminal service on port 3457...');
  const terminalService = spawn('npx', ['tsx', 'server/terminal-service.ts'], childOptions);
  childProcesses.push(terminalService);
  terminalService.once('error', () => cleanupAndExit('Terminal launch failed', 1));

  // Wait for terminal service to start
  await new Promise(resolve => setTimeout(resolve, 2000));
  if (shuttingDown) return;

  // Start Next.js
  console.log(`[dev] Starting Next.js on port ${selectedPort}...`);
  const child = spawn('tsx', ['server.js'], childOptions);
  childProcesses.push(child);
  child.once('error', () => cleanupAndExit('Next.js launch failed', 1));

  child.on('exit', (code) => {
    console.log('[dev] Next.js server exited');
    cleanupAndExit('EXIT', code ?? 0);
  });

  terminalService.on('exit', (code) => {
    console.log(`[dev] Terminal service exited with code ${code}`);
    // Don't exit immediately - Next.js might still be running
    // Only exit if both services are down
    const allExited = childProcesses.every(p => p.exitCode !== null || p.signalCode !== null);
    if (allExited) {
      cleanupAndExit('All services exited', code ?? 0);
    }
  });
}

main().catch((error) => {
  console.error('[dev] Failed to start local dev server:', error);
  process.exit(1);
});
