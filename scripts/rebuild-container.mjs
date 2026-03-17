#!/usr/bin/env node

/**
 * Rebuild Container Script
 *
 * 1. Stops and removes the existing container via docker compose
 * 2. Builds a fresh image (no cache)
 * 3. Starts the container via docker compose (all volumes from compose.yaml)
 * 4. Waits for the app to be ready, then opens a browser window
 *
 * Usage: npm run container:rebuild
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = join(__dirname, '..');

const PORT = 3456;
const APP_URL = `http://localhost:${PORT}`;

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function exec(command, options = {}) {
  log(`> ${command}`, 'cyan');
  try {
    return execSync(command, {
      stdio: 'inherit',
      cwd: rootDir,
      ...options
    });
  } catch (error) {
    if (!options.ignoreError) {
      throw error;
    }
  }
}

function ensureDataDirs() {
  const dataDir = join(rootDir, 'data');
  const subdirs = ['workspace', 'canvas-agent', 'pi-oauth-states', 'secrets', 'skills'];

  if (!existsSync(dataDir)) {
    log('Creating data/ directory...', 'yellow');
    mkdirSync(dataDir, { recursive: true });
  }

  for (const subdir of subdirs) {
    const path = join(dataDir, subdir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }
}

async function waitForReady(url, maxWaitMs = 120_000, intervalMs = 2_000) {
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < maxWaitMs) {
    attempt++;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) {
        log(`✓ App is ready (${res.status}) after ${Math.round((Date.now() - start) / 1000)}s`, 'green');
        return true;
      }
    } catch {
      // not ready yet
    }

    if (attempt % 5 === 0) {
      log(`Still waiting for app to start... (${Math.round((Date.now() - start) / 1000)}s)`, 'cyan');
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  log('App did not become ready within the timeout.', 'yellow');
  return false;
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd;

  if (platform === 'darwin') {
    cmd = ['open', [url]];
  } else if (platform === 'win32') {
    cmd = ['cmd', ['/c', 'start', url]];
  } else {
    cmd = ['xdg-open', [url]];
  }

  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
    child.unref();
    log(`✓ Browser opened at ${url}`, 'green');
  } catch {
    log(`Could not open browser automatically. Visit: ${url}`, 'yellow');
  }
}

async function main() {
  log('========================================', 'blue');
  log('  Canvas Notebook - Container Rebuild', 'blue');
  log('========================================', 'blue');
  console.log();

  // Step 1: Check Docker
  log('Step 1: Checking Docker...', 'yellow');
  try {
    execSync('docker --version', { stdio: 'pipe' });
    execSync('docker compose version', { stdio: 'pipe' });
    log('✓ Docker and Docker Compose are available', 'green');
  } catch {
    log('✗ Docker or Docker Compose is not available. Please install Docker Desktop.', 'red');
    process.exit(1);
  }
  console.log();

  // Step 2: Check .env.docker.local
  log('Step 2: Checking environment file...', 'yellow');
  const envFile = join(rootDir, '.env.docker.local');
  if (!existsSync(envFile)) {
    log('✗ .env.docker.local not found.', 'red');
    log('  Run: cp .env.docker.example .env.docker.local', 'yellow');
    log('  Then edit .env.docker.local to set your credentials.', 'yellow');
    process.exit(1);
  }
  log('✓ .env.docker.local found', 'green');
  console.log();

  // Step 3: Ensure data directories exist
  log('Step 3: Preparing data directories...', 'yellow');
  ensureDataDirs();
  log('✓ Data directories ready', 'green');
  console.log();

  // Step 4: Stop existing container
  log('Step 4: Stopping existing container...', 'yellow');
  exec('docker compose down', { ignoreError: true });
  log('✓ Done', 'green');
  console.log();

  // Step 5: Build fresh image
  log('Step 5: Building image (no cache)...', 'yellow');
  log('This may take a few minutes on first run.', 'cyan');
  console.log();

  try {
    exec('docker compose build --no-cache');
    log('✓ Image built successfully', 'green');
  } catch {
    log('✗ Build failed', 'red');
    process.exit(1);
  }
  console.log();

  // Step 6: Start container
  log('Step 6: Starting container...', 'yellow');
  try {
    exec('docker compose up -d');
    log('✓ Container started', 'green');
  } catch {
    log('✗ Failed to start container', 'red');
    process.exit(1);
  }
  console.log();

  // Step 7: Wait for app to be ready
  log('Step 7: Waiting for app to be ready...', 'yellow');
  const ready = await waitForReady(`${APP_URL}/login`);
  console.log();

  // Step 8: Show status
  try {
    const status = execSync(
      'docker compose ps',
      { encoding: 'utf-8', cwd: rootDir }
    ).toString();
    log('Container status:', 'blue');
    console.log(status);
  } catch {
    // ignore
  }

  log('========================================', 'green');
  log('  Container successfully rebuilt!', 'green');
  log('========================================', 'green');
  log(`  URL:  ${APP_URL}`, 'cyan');
  log('========================================', 'green');
  console.log();
  log('Useful commands:', 'blue');
  log('  docker compose logs -f canvas-notebook   # follow logs', 'cyan');
  log('  docker exec -it canvas-notebook sh       # shell inside container', 'cyan');
  log('  docker compose down                      # stop', 'cyan');
  console.log();

  // Step 9: Open browser
  if (ready) {
    openBrowser(APP_URL);
  } else {
    log(`App may still be starting. Visit: ${APP_URL}`, 'yellow');
  }
}

main().catch(error => {
  log(`\nError: ${error.message}`, 'red');
  process.exit(1);
});
