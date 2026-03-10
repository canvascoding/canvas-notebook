#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

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

function parsePort(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
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
  const configuredEnvFile = process.env.CANVAS_ENV_FILE?.trim() || DEFAULT_ENV_FILE;
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

  const childEnv = {
    ...process.env,
    CANVAS_ENV_FILE: configuredEnvFile,
    PORT: String(selectedPort),
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

  const child = spawn('tsx', ['server.js'], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: 'inherit',
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error('[dev] Failed to start local dev server:', error);
  process.exit(1);
});
