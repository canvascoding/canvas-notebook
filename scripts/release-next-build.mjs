import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const phase = process.argv[2];
if (!['compile', 'generate'].includes(phase)) {
  console.error('Usage: node scripts/release-next-build.mjs <compile|generate>');
  process.exit(1);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const startedAt = Date.now();
const nativeParallelism = process.env.CANVAS_RELEASE_NATIVE_PARALLELISM?.trim() || '4';
if (!/^[1-4]$/u.test(nativeParallelism)) {
  throw new Error('CANVAS_RELEASE_NATIVE_PARALLELISM must be an integer from 1 to 4.');
}
const prefix = `[release-build:${phase}]`;
let peakRssKiB = 0;
let timedOut = false;
let stopped = false;
let forceKillTimer;

console.log(`${prefix} Turbopack, native parallelism=${nativeParallelism}, V8 heap=8192 MiB, host RAM=${Math.round(os.totalmem() / 2 ** 20)} MiB`);

const child = spawn(process.execPath, [
  '--max-old-space-size=8192', '--disable-warning=DEP0205',
  path.join(root, 'node_modules/next/dist/bin/next'),
  'build', '--experimental-build-mode', phase,
], {
  cwd: root,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    CI: 'true',
    CANVAS_RELEASE_BUILD_SKIP_TYPECHECK: '1',
    CANVAS_RELEASE_BUILD_LOW_MEMORY: '1',
    // experimental.cpus only limits page workers. Bound the native transform
    // pools as well. Smaller local builders may explicitly lower the bound.
    TURBO_TASKS_AVAILABLE_PARALLELISM: nativeParallelism,
    RAYON_NUM_THREADS: nativeParallelism,
  },
});

function reportResources() {
  let rssKiB;
  let linuxMemory = '';
  if (process.platform === 'linux') {
    try {
      const info = readFileSync('/proc/meminfo', 'utf8');
      const value = name => Number(info.match(new RegExp(`^${name}:\\s+(\\d+)`, 'mu'))?.[1] ?? 0);
      linuxMemory = `, available=${Math.round(value('MemAvailable') / 1024)} MiB, swap used=${Math.round((value('SwapTotal') - value('SwapFree')) / 1024)} MiB`;
    } catch {
      // Non-Linux hosts and restricted procfs mounts still get RSS diagnostics.
    }
  }
  if (child.pid && process.platform !== 'win32') {
    try {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], {
        encoding: 'utf8', timeout: 5000,
      }).trim().split('\n').map(line => line.trim().split(/\s+/u).map(Number));
      const descendants = new Set([child.pid]);
      let previousSize;
      do {
        previousSize = descendants.size;
        for (const [pid, parent] of rows) if (descendants.has(parent)) descendants.add(pid);
      } while (descendants.size !== previousSize);
      rssKiB = rows.reduce((sum, [pid, , rss]) => sum + (descendants.has(pid) ? rss : 0), 0);
      peakRssKiB = Math.max(peakRssKiB, rssKiB);
    } catch {
      // Resource diagnostics must never change the build's exit status.
    }
  }
  console.log(`${prefix} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s, RSS=${rssKiB === undefined ? 'unavailable' : `${Math.round(rssKiB / 1024)} MiB`}, sampled peak=${Math.round(peakRssKiB / 1024)} MiB, host free=${Math.round(os.freemem() / 2 ** 20)} MiB${linuxMemory}`);
}

function stopBuild(signal) {
  if (stopped || !child.pid) return;
  stopped = true;
  const kill = nextSignal => {
    try {
      if (process.platform === 'win32') child.kill(nextSignal);
      else process.kill(-child.pid, nextSignal);
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(`${prefix} Could not stop build: ${error.message}`);
    }
  };
  kill(signal);
  forceKillTimer = setTimeout(() => kill('SIGKILL'), 10_000);
  forceKillTimer.unref();
}

const diagnosticsTimer = setInterval(reportResources, 30_000);
const firstDiagnosticsTimer = setTimeout(reportResources, 5_000);
const timeoutTimer = setTimeout(() => {
  timedOut = true;
  console.error(`${prefix} Exceeded the 25-minute build limit; stopping the build process group.`);
  reportResources();
  stopBuild('SIGTERM');
}, 25 * 60_000);
process.once('SIGINT', () => stopBuild('SIGINT'));
process.once('SIGTERM', () => stopBuild('SIGTERM'));
child.once('error', error => console.error(`${prefix} Could not start Next.js: ${error.message}`));
child.once('close', (code, signal) => {
  clearInterval(diagnosticsTimer);
  clearTimeout(firstDiagnosticsTimer);
  clearTimeout(timeoutTimer);
  clearTimeout(forceKillTimer);
  console.log(`${prefix} finished in ${Math.round((Date.now() - startedAt) / 1000)}s, sampled peak=${Math.round(peakRssKiB / 1024)} MiB, exit=${code ?? signal}`);
  process.exitCode = timedOut ? 124 : stopped ? 1 : (code ?? 1);
});
