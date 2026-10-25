import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const launcher = fileURLToPath(new URL('./run-dev.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  assert.fail(message);
}
function running(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  // A terminated grandchild may briefly await its OS reaper.
  return !spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().startsWith('Z');
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

for (const scenario of ['deleted', 'replaced', 'signal', 'graceful-parent']) {
  test(`dev launcher stops its process trees when checkout is ${scenario}`, { skip: process.platform === 'win32' }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-dev-lifetime-'));
    const cwd = path.join(root, 'checkout'), bin = path.join(root, 'bin');
    await fs.mkdir(cwd); await fs.mkdir(bin);
    const envPath = path.join(root, 'empty.env'), fixture = path.join(root, 'service.cjs');
    await fs.writeFile(envPath, '');
    await fs.writeFile(fixture, `const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const kind=process.argv.includes('server.js')?'app':'terminal';
const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
if(process.env.FIXTURE_PARENT_GRACEFUL!=='1')process.on('SIGTERM',()=>{});
fs.writeFileSync(path.join(process.env.FIXTURE_ROOT,kind+'.json'),JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);`);
    for (const command of ['npx', 'tsx']) {
      await fs.writeFile(path.join(bin, command), '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_SERVICE" "$@"\n', { mode: 0o700 });
    }
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const child = spawn(process.execPath, [launcher], { cwd, env: { ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, CANVAS_ENV_FILE: envPath,
      CANVAS_LOCAL_TEAM_SEAT_STATE_DIR: path.join(root, 'no-stack'), PORT: String(await freePort()),
      FIXTURE_NODE: process.execPath, FIXTURE_SERVICE: fixture, FIXTURE_ROOT: root,
      FIXTURE_PARENT_GRACEFUL: scenario === 'graceful-parent' ? '1' : '0',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', value => output += value);
    child.stderr.on('data', value => output += value);
    const completion = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const ownedPids = [];
    try {
      await until(async () => {
        try {
          const app = JSON.parse(await fs.readFile(path.join(root, 'app.json'), 'utf8'));
          const terminal = JSON.parse(await fs.readFile(path.join(root, 'terminal.json'), 'utf8'));
          ownedPids.splice(0, ownedPids.length, ...app, ...terminal);
          return true;
        } catch { return false; }
      }, `Fixture services did not start: ${output}`);
      // Let both descendants install their SIGTERM handlers.
      await delay(200);
      const signalled = scenario === 'signal' || scenario === 'graceful-parent';
      if (signalled) child.kill('SIGTERM');
      else {
        await fs.rm(cwd, { recursive: true });
        if (scenario === 'replaced') await fs.mkdir(cwd);
      }
      const result = await Promise.race([completion, delay(8_000).then(() => { throw new Error(`Launcher did not stop: ${output}`); })]);
      assert.equal(result.code, signalled ? 0 : 1, output);
      await until(() => ownedPids.every(pid => !running(pid)), 'An owned service or grandchild survived shutdown');
      assert.equal(running(unrelated.pid), true, 'Unrelated process was interrupted');
      if (!signalled) assert.match(output, /Checkout was removed, replaced, or became unavailable/u);
    } finally {
      child.kill('SIGKILL');
      for (const pid of ownedPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ } }
      unrelated.kill('SIGTERM');
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
