#!/usr/bin/env node

/**
 * Canvas Notebook — Setup & Install Script
 *
 * Sets up and starts the Canvas Notebook container on your machine.
 * Safe to run multiple times — rebuilds and restarts the container.
 *
 * Usage: npm run setup
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = join(__dirname, '..');
const composeProjectName = basename(rootDir);

const PORT = 3456;
const APP_URL = `http://localhost:${PORT}`;

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function step(n, label) {
  console.log();
  log(`Step ${n}: ${label}`, 'yellow');
}

function ok(msg) { log(`✓ ${msg}`, 'green'); }
function fail(msg) { log(`✗ ${msg}`, 'red'); }
function warn(msg) { log(`! ${msg}`, 'yellow'); }
function info(msg) { log(`  ${msg}`, 'cyan'); }

function exec(command, options = {}) {
  log(`> ${command}`, 'cyan');
  try {
    return execSync(command, { stdio: 'inherit', cwd: rootDir, ...options });
  } catch (error) {
    if (!options.ignoreError) throw error;
  }
}

function removeLingeringComposeContainers() {
  try {
    const output = execSync(
      `docker ps -aq --filter label=com.docker.compose.project=${composeProjectName}`,
      { encoding: 'utf-8', cwd: rootDir },
    ).trim();

    if (!output) {
      return;
    }

    const ids = output.split(/\s+/).filter(Boolean);
    if (ids.length === 0) {
      return;
    }

    info(`Removing ${ids.length} lingering compose container(s) for project ${composeProjectName}...`);
    exec(`docker rm -f ${ids.join(' ')}`, { ignoreError: true });
  } catch {
    // Best-effort cleanup; setup continues with normal compose handling.
  }
}

// ─── Docker install instructions per platform ────────────────────────────────

function printDockerInstructions() {
  const platform = process.platform;
  console.log();
  log('Docker is required to run Canvas Notebook.', 'yellow');
  log('It was not found on your system. Please install it first:', 'yellow');
  console.log();

  if (platform === 'darwin') {
    info('Download Docker Desktop for Mac (free):');
    info('  https://www.docker.com/products/docker-desktop/');
    console.log();
    info('After installing:');
    info('  1. Open Docker Desktop from your Applications folder');
    info('  2. Wait until the whale icon in the menu bar is steady (not animated)');
    info('  3. Run this script again: npm run setup');
  } else if (platform === 'win32') {
    info('Download Docker Desktop for Windows (free):');
    info('  https://www.docker.com/products/docker-desktop/');
    console.log();
    info('After installing:');
    info('  1. Start Docker Desktop from the Start menu');
    info('  2. Wait until the whale icon in the taskbar is steady (not animated)');
    info('  3. Run this script again: npm run setup');
  } else {
    info('Install Docker Engine for Linux:');
    info('  https://docs.docker.com/engine/install/');
    console.log();
    info('After installing, make sure your user is in the docker group:');
    info('  sudo usermod -aG docker $USER   # then log out and back in');
    console.log();
    info('Then run this script again: npm run setup');
  }
  console.log();
}

// ─── .env.docker.local helper ─────────────────────────────────────────────────

function printEnvInstructions(envFile, isNew) {
  if (isNew) {
    console.log();
    log('A config file has been created for you: .env.docker.local', 'yellow');
    log('Open it and set the following values before running setup again:', 'yellow');
  } else {
    console.log();
    warn('The config file exists but appears to still use the example values.');
    warn('Open .env.docker.local and update the following before running setup:');
  }
  console.log();
  info('  BETTER_AUTH_SECRET    — a random secret (run: openssl rand -base64 32)');
  info('  BOOTSTRAP_ADMIN_EMAIL — your login email');
  info('  BOOTSTRAP_ADMIN_PASSWORD — your login password');
  console.log();
  info('Then run: npm run setup');
  console.log();
}

function envFileIsConfigured(envFile) {
  try {
    const content = readFileSync(envFile, 'utf-8');
    // Check if still contains placeholder values from the example
    const hasExampleEmail = content.includes('admin@example.com');
    const hasExamplePassword = /BOOTSTRAP_ADMIN_PASSWORD\s*=\s*admin\b/.test(content);
    const hasSampleSecret = content.includes('c9PkVtSazPhUtmcKsjau1w2uONuBZKiUvgFaHGXz2kZE=');
    return !(hasExampleEmail || hasExamplePassword || hasSampleSecret);
  } catch {
    return false;
  }
}

// ─── Data directories ─────────────────────────────────────────────────────────

function ensureDataDirs() {
  const subdirs = ['workspace', 'canvas-agent', 'pi-oauth-states', 'secrets', 'skills'];
  for (const subdir of subdirs) {
    const path = join(rootDir, 'data', subdir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function createSpinner(getMessage) {
  let frame = 0;
  const interval = setInterval(() => {
    frame = (frame + 1) % SPINNER.length;
    process.stdout.write(`\r\x1b[K  ${SPINNER[frame]} ${getMessage()}`);
  }, 100);
  return {
    stop() {
      clearInterval(interval);
      process.stdout.write('\r\x1b[K');
    },
  };
}

// ─── Docker build with progress ───────────────────────────────────────────────

function buildWithProgress() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let frame = 0;
    let currentDesc = 'Starting build...';
    let completed = 0;
    let total = 0;

    const steps = new Map(); // id → { desc, done }

    function renderBar() {
      const pct = total > 0 ? Math.min(1, completed / total) : 0;
      const filled = Math.round(pct * 20);
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      const pctStr = `${Math.round(pct * 100)}%`.padStart(4);
      const elapsed = Math.round((Date.now() - start) / 1000);
      const desc = currentDesc.slice(0, 55);
      process.stdout.write(`\r\x1b[K  ${SPINNER[frame]} [${bar}] ${pctStr}  ${desc}  (${elapsed}s)`);
    }

    const spinnerInterval = setInterval(() => {
      frame = (frame + 1) % SPINNER.length;
      renderBar();
    }, 100);

    const proc = spawn('docker', ['compose', 'build', '--no-cache', '--progress=plain'], {
      cwd: rootDir,
      env: process.env,
    });

    let stderrBuffer = '';
    let capturedOutput = '';

    const startRe = /^#(\d+) \[([^\]]+)\] (.+)/;
    const doneRe  = /^#(\d+) (DONE|CACHED)/;

    function processLine(line) {
      capturedOutput += line + '\n';

      const startMatch = line.match(startRe);
      if (startMatch) {
        const id = parseInt(startMatch[1]);
        const stageInfo = startMatch[2];
        const action = startMatch[3];
        if (!steps.has(id)) steps.set(id, { desc: `[${stageInfo}] ${action}`, done: false });
        if (id > total) total = id;
        currentDesc = `[${stageInfo}] ${action}`;
        renderBar();
        return;
      }

      const doneMatch = line.match(doneRe);
      if (doneMatch) {
        const id = parseInt(doneMatch[1]);
        const entry = steps.get(id);
        if (entry && !entry.done) {
          entry.done = true;
          completed++;
          renderBar();
        }
      }
    }

    proc.stderr.on('data', chunk => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    });

    proc.on('close', code => {
      if (stderrBuffer) processLine(stderrBuffer);
      clearInterval(spinnerInterval);
      process.stdout.write('\r\x1b[K');

      if (code === 0) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        ok(`Image built successfully (${elapsed}s)`);
        resolve();
      } else {
        fail('Build failed. Docker output:');
        console.error(capturedOutput.slice(-3000));
        reject(new Error(`docker compose build exited with code ${code}`));
      }
    });

    proc.on('error', err => {
      clearInterval(spinnerInterval);
      process.stdout.write('\r\x1b[K');
      reject(err);
    });
  });
}

// ─── Health check ─────────────────────────────────────────────────────────────

async function waitForReady(url, maxWaitMs = 300_000, intervalMs = 3_000) {
  const start = Date.now();

  const spinner = createSpinner(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    return `Waiting for app...  (${elapsed}s)`;
  });

  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) {
        spinner.stop();
        const elapsed = Math.round((Date.now() - start) / 1000);
        ok(`App is ready after ${elapsed}s`);
        return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  spinner.stop();
  warn('App did not respond within the timeout — it may still be starting.');
  return false;
}

// ─── Open browser ─────────────────────────────────────────────────────────────

function openBrowser(url) {
  const cmds = {
    darwin: ['open', [url]],
    win32:  ['cmd', ['/c', 'start', url]],
  };
  const cmd = cmds[process.platform] ?? ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
    child.unref();
    ok(`Opening browser at ${url}`);
  } catch {
    warn(`Could not open browser automatically. Visit: ${url}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  log('╔══════════════════════════════════════════╗', 'blue');
  log('║      Canvas Notebook  —  Setup           ║', 'blue');
  log('╚══════════════════════════════════════════╝', 'blue');
  console.log();
  info('This script will build and start Canvas Notebook in Docker.');
  info('It is safe to run again at any time to rebuild or restart the app.');

  // ── Step 1: Check Docker ───────────────────────────────────────────────────
  step(1, 'Checking Docker...');
  let dockerOk = false;
  try {
    execSync('docker --version', { stdio: 'pipe' });
    execSync('docker compose version', { stdio: 'pipe' });
    dockerOk = true;
  } catch {
    // check if Docker is installed but not running
    try {
      execSync('docker info', { stdio: 'pipe' });
      dockerOk = true;
    } catch {
      dockerOk = false;
    }
  }

  if (!dockerOk) {
    fail('Docker is not available.');
    printDockerInstructions();
    process.exit(1);
  }

  // Verify Docker daemon is actually running
  try {
    execSync('docker info', { stdio: 'pipe' });
  } catch {
    fail('Docker is installed but not running.');
    console.log();
    if (process.platform === 'darwin' || process.platform === 'win32') {
      info('Please start Docker Desktop and wait for it to be ready,');
      info('then run: npm run setup');
    } else {
      info('Please start the Docker daemon: sudo systemctl start docker');
      info('Then run: npm run setup');
    }
    console.log();
    process.exit(1);
  }

  ok('Docker is running');

  // ── Step 2: Config file ────────────────────────────────────────────────────
  step(2, 'Checking configuration...');
  const envFile = join(rootDir, '.env.docker.local');
  const envExample = join(rootDir, '.env.docker.example');

  if (!existsSync(envFile)) {
    if (existsSync(envExample)) {
      copyFileSync(envExample, envFile);
      fail('.env.docker.local was not found — created it from the template.');
      printEnvInstructions(envFile, true);
    } else {
      fail('.env.docker.local not found and no template available.');
      info('Create a .env.docker.local file. See the README for required values.');
    }
    process.exit(1);
  }

  if (!envFileIsConfigured(envFile)) {
    warn('.env.docker.local still contains example/default values.');
    printEnvInstructions(envFile, false);
    process.exit(1);
  }

  ok('.env.docker.local is configured');

  // ── Step 3: Data directories ───────────────────────────────────────────────
  step(3, 'Preparing data directories...');
  ensureDataDirs();
  ok('Data directories ready (./data/)');

  // ── Step 4: Stop existing container ───────────────────────────────────────
  step(4, 'Stopping existing container (if any)...');
  exec('docker compose down --remove-orphans', { ignoreError: true });
  removeLingeringComposeContainers();
  ok('Done');

  // ── Step 5: Build image ────────────────────────────────────────────────────
  step(5, 'Building Docker image...');
  info('This may take a few minutes on the first run.');
  console.log();
  try {
    await buildWithProgress();
  } catch {
    process.exit(1);
  }

  // ── Step 6: Start container ────────────────────────────────────────────────
  step(6, 'Starting container...');
  try {
    exec('docker compose up -d --force-recreate');
    ok('Container started');
  } catch {
    warn('Container start hit a conflict. Retrying once after explicit cleanup...');
    exec('docker compose down --remove-orphans', { ignoreError: true });
    removeLingeringComposeContainers();

    try {
      exec('docker compose up -d --force-recreate');
      ok('Container started');
    } catch {
      fail('Failed to start container. Check the output above for errors.');
      process.exit(1);
    }
  }

  // ── Step 7: Wait for app ───────────────────────────────────────────────────
  step(7, 'Waiting for the app to be ready...');
  info('The first startup includes installing optional CLI tools (may take ~60s).');
  console.log();
  const ready = await waitForReady(`${APP_URL}/api/health`);
  console.log();

  // ── Step 8: Summary ────────────────────────────────────────────────────────
  try {
    const status = execSync('docker compose ps', { encoding: 'utf-8', cwd: rootDir });
    log('Container status:', 'blue');
    console.log(status.toString().trimEnd());
    console.log();
  } catch { /* ignore */ }

  log('╔══════════════════════════════════════════╗', 'green');
  log('║      Canvas Notebook is ready!           ║', 'green');
  log('╚══════════════════════════════════════════╝', 'green');
  console.log();
  log(`  URL:  ${APP_URL}`, 'bold');
  console.log();
  info('After login, an optional onboarding wizard can guide you through provider setup.');
  console.log();
  log('Useful commands:', 'blue');
  info('  docker compose logs -f canvas-notebook   # follow logs');
  info('  docker exec -it canvas-notebook sh       # open a shell in the container');
  info('  docker compose down                      # stop the container');
  info('  npm run setup                            # rebuild and restart');
  console.log();

  if (ready) {
    openBrowser(APP_URL);
  } else {
    warn(`App may still be starting. Visit: ${APP_URL}`);
  }
}

main().catch(error => {
  fail(`\nUnexpected error: ${error.message}`);
  process.exit(1);
});
