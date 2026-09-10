import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { resolveStartupHealthBudget, waitForStartupHealth } from './wait-for-startup-health.mjs';

async function main() {
  for (const value of [undefined, '', '0', '-1', 'invalid']) assert.equal(resolveStartupHealthBudget(value), 180_000);
  assert.equal(resolveStartupHealthBudget('15'), 15_000);
  let now = 0;
  const timeouts = [];
  const fake = {
    url: 'http://127.0.0.1', pid: process.pid, budgetMillis: 12_000,
    now: () => now, isRunning: () => true,
    pause: async (millis) => { now += millis; },
    probe: async (_url, millis) => { timeouts.push(millis); now += millis; return false; },
  };
  assert.equal(await waitForStartupHealth(fake), 'timeout');
  assert.equal(now, 12_000, 'probe duration and sleep must both count toward the budget');
  assert.deepEqual(timeouts, [5_000, 5_000]);
  now = 0;
  assert.equal(await waitForStartupHealth({ ...fake, isRunning: () => false }), 'exited');
  assert.equal(now, 0);
  assert.equal(await waitForStartupHealth({ ...fake, probe: async () => true }), 'ready');
  now = 0;
  assert.equal(await waitForStartupHealth({ ...fake, probe: async () => { now = 12_001; return true; } }), 'timeout', 'a late 200 is not ready within budget');
  now = 0;
  let alive = true;
  assert.equal(await waitForStartupHealth({ ...fake, isRunning: () => alive, probe: async () => { alive = false; return true; } }), 'exited');

  const sockets = new Set();
  let healthy = false;
  const server = http.createServer((_request, response) => {
    if (healthy) { response.writeHead(200); response.end('{}'); }
    // Otherwise deliberately never send HTTP headers.
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const started = performance.now();
    assert.equal(await waitForStartupHealth({ url: `http://127.0.0.1:${port}`, pid: process.pid, budgetMillis: 80 }), 'timeout');
    assert.ok(performance.now() - started < 2_000, 'an actual hung HTTP connection must be aborted');

    const source = readFileSync('scripts/start-services.sh', 'utf8');
    assert.match(source, /node --import tsx server\.js &/);
    const block = source.slice(source.indexOf('health_url='), source.indexOf('# ─── Step 4:'));
    assert.ok(block.includes('wait-for-startup-health.mjs'));
    for (healthy of [false, true]) {
      const child = spawn('sh', ['-c', `
        set -eu
        step_ok() { printf 'ready\\n'; }
        step_fail() { printf 'failed\\n'; }
        trap 'printf "cleanup\\n"' EXIT
        ${block}
      `], { env: { ...process.env, PORT: String(port), NEXT_PID: String(process.pid), STARTUP_HEALTH_MAX_ATTEMPTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      }).finally(() => clearTimeout(timer));
      assert.equal(code, healthy ? 0 : 1, output);
      assert.match(output, /cleanup/);
      assert.match(output, healthy ? /ready/ : /did not become healthy within 1s/);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('Startup health budget: elapsed time, hung HTTP abort, late response, process exit and shell cleanup passed.');
}

await main();
