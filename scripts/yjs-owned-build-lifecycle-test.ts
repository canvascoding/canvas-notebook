/** Process-lifecycle regression only. No application build or acceptance is certified. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Identity = { pid: number; ppid: number; pgid: number; uid: number; started: string; cwd: string };
type Held = { process: ChildProcess; identity: Identity; closed: Promise<void>; output: () => string };
type Outcome = { rejected: true; name: string; messages: string[]; elapsedMs: number };
type Mode = 'deadline' | 'SIGTERM' | 'SIGINT' | 'gate-failure' | 'next-escalation' | 'cleanup-uncertain';
const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const proofName = 'yjs-authority-build-proof.json';
const roles = ['npm', 'relay', 'next', 'leaf'] as const;

function identity(pid: number, cwd: string): Identity | undefined {
  let row: string;
  try { row = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,uid=,lstart='],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { if ((error as { status?: number }).status === 1) return undefined; throw error; }
  if (!row) return undefined;
  const match = row.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u);
  assert(match, 'A process identity must be independently readable.');
  return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), uid: Number(match[4]), started: match[5], cwd };
}
function assertHeld(original: Identity): void {
  const current = identity(original.pid, original.cwd);
  assert(current, `Owned process ${original.pid} disappeared before its identity check.`);
  for (const key of ['pid', 'pgid', 'uid', 'started'] as const) assert.equal(current[key], original[key], `Process ${key} fence changed.`);
  assert.equal(current.uid, process.getuid?.());
  assert(execFileSync('lsof', ['-a', '-p', String(original.pid), '-d', 'cwd', '-Fn'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').includes(`n${original.cwd}`), 'Owned process cwd fence changed.');
}
function groupMembers(group: number): number[] {
  return execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).trim().split('\n')
    .map(row => row.trim().split(/\s+/u).map(Number)).filter(([, pgid]) => pgid === group).map(([pid]) => pid);
}
async function until<T>(read: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  do { const value = await read(); if (value !== undefined) return value; await pause(25); } while (performance.now() < deadline);
  throw new Error(`Lifecycle fixture deadline: ${label}.`);
}
async function json<T>(filename: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function launch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Held> {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', failure: Error | undefined;
  child.stdout?.on('data', chunk => { assert(output.length < 512 * 1024); output += String(chunk); });
  child.stderr?.on('data', chunk => { assert(output.length < 512 * 1024); output += String(chunk); });
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', error => { failure = error; resolve(); }); });
  const captured = await until(async () => child.pid ? identity(child.pid, cwd) : undefined, 5000, 'spawn identity');
  if (failure) throw failure;
  assert.equal(captured.pgid, captured.pid);
  return { process: child, identity: captured, closed, output: () => output };
}
async function waitClosed(held: Held, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([held.closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned fixture worker did not close.')), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function gone(entries: readonly Identity[]): Promise<void> {
  await until(async () => entries.every(entry => !identity(entry.pid, entry.cwd))
    && [...new Set(entries.map(entry => entry.pgid))].every(group => groupMembers(group).length === 0) ? true : undefined,
  5000, 'independent PID and process-group disappearance');
}
/** Only identities captured from this fixture's actual parent/child chain may be stopped. */
async function stopCaptured(entries: readonly Identity[]): Promise<void> {
  for (const entry of [...entries].reverse()) {
    if (!identity(entry.pid, entry.cwd)) continue;
    assertHeld(entry); process.kill(entry.pid, 'SIGKILL');
  }
  await gone(entries);
}

const processRecorder = String.raw`
const fs = require('node:fs');
const {execFileSync, spawn} = require('node:child_process');
const capture = (pid, role) => {
  const row = execFileSync('ps',['-p',String(pid),'-o','pid=,ppid=,pgid=,uid=,lstart='],{encoding:'utf8'}).trim();
  const match = row.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!match) throw new Error('Fixture process identity unavailable.');
  fs.writeFileSync(cfg.evidence+'/'+role+'.json',JSON.stringify({pid:+match[1],ppid:+match[2],pgid:+match[3],uid:+match[4],started:match[5],cwd:process.cwd()}),{flag:'wx',mode:0o600});
};
const signal = name => fs.appendFileSync(cfg.evidence+'/'+role+'.signals',name+'\n',{mode:0o600});
`;

async function fixture(root: string, source: string, mode: Mode): Promise<{ repo: string; evidence: string; bin: string }> {
  const repo = path.join(root, 'repo'), evidence = path.join(root, 'evidence'), bin = path.join(root, 'bin');
  for (const directory of [repo, evidence, bin, path.join(repo, 'scripts'), path.join(repo, 'app'), path.join(repo, 'node_modules/next/dist/bin')]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const cfg = { repo, evidence, mode, gateDelayMs: 2500 };
  const prefix = `const cfg=${JSON.stringify(cfg)};\n`;
  // The unchanged real relay supplies its detached Next group and 10-second SIGKILL escalation.
  await fs.copyFile(path.join(source, 'scripts/release-next-build.mjs'), path.join(repo, 'scripts/release-next-build.mjs'));
  await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n.next/\n');
  await fs.writeFile(path.join(repo, 'app/fixture.ts'), 'export const lifecycleFixture = true;\n');
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ private: true, name: 'owned-lifecycle-fixture',
    scripts: { build: 'node scripts/release-next-build.mjs compile' } }));
  await fs.writeFile(path.join(bin, 'npm'), `#!${process.execPath}\n${prefix}${processRecorder}
const role='npm'; capture(process.pid,role);
if (JSON.stringify(process.argv.slice(2))!==JSON.stringify(['run','build'])) throw new Error('Unexpected npm fixture invocation.');
const keep=setInterval(()=>{},1000);
for (const name of ['SIGINT','SIGTERM']) process.on(name,()=>signal(name));
const relay=spawn(process.execPath,[cfg.repo+'/scripts/release-next-build.mjs','compile'],{cwd:cfg.repo,stdio:'inherit'});
relay.once('error',error=>{throw error;}); capture(relay.pid,'relay');
relay.once('close',(code,signalName)=>{
  fs.writeFileSync(cfg.evidence+'/relay-exit.json',JSON.stringify({code,signal:signalName}),{flag:'wx',mode:0o600});
  if(cfg.mode==='cleanup-uncertain') return;
  clearInterval(keep); process.exitCode=code===0?0:31;
});
`, { mode: 0o700 });
  await fs.writeFile(path.join(repo, 'node_modules/next/dist/bin/next'), `${prefix}${processRecorder}
const role=process.argv[2]==='lifecycle-leaf'?'leaf':'next'; capture(process.pid,role);
const keep=setInterval(()=>{},1000);
for(const name of ['SIGINT','SIGTERM']) process.on(name,()=>{
  signal(name); if(cfg.mode==='next-escalation') return;
  clearInterval(keep); setTimeout(()=>process.exit(32),50);
});
if(role==='next') {
  const leaf=spawn(process.execPath,[__filename,'lifecycle-leaf'],{cwd:cfg.repo,stdio:'inherit'});
  leaf.once('error',error=>{throw error;});
}
if(cfg.mode==='gate-failure') setTimeout(()=>{
  clearInterval(keep);
  if(role==='next') console.error('LIFECYCLE_FIXTURE_GATE_FAILURE');
  process.exit(role==='next'?31:0);
},role==='next'?cfg.gateDelayMs:cfg.gateDelayMs-250);
`, { mode: 0o600 });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Lifecycle fixture', '-c', 'user.email=lifecycle@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Own lifecycle fixture'], { cwd: repo });
  return { repo, evidence, bin };
}

export async function yjsOwnedBuildLifecycleTest(): Promise<void> {
  assert(['darwin', 'linux'].includes(process.platform), 'The actual POSIX PID/group fences are required.');
  const source = await fs.realpath(process.cwd());
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-yjs-build-lifecycle-')));
  await fs.chmod(root, 0o700);
  const rootIdentity = await fs.lstat(root);
  const node = process.execPath, hook = createRequire(path.join(source, 'package.json')).resolve('tsx');
  const workerScript = path.join(root, 'worker.mjs');
  await fs.writeFile(workerScript, `import fs from 'node:fs';
const [repo,result,timeout]=process.argv.slice(2);
const {buildOwnedYjsArtifact}=await import(${JSON.stringify(pathToFileURL(path.join(source, 'scripts/run-yjs-authority-e2e.ts')).href)});
const started=performance.now();
const messages=e=>[e instanceof Error?e.message:String(e),...(e instanceof AggregateError?Array.from(e.errors).flatMap(messages):[])];
try { await buildOwnedYjsArtifact(repo,{timeoutMs:Number(timeout)}); fs.writeFileSync(result,JSON.stringify({rejected:false}),{flag:'wx',mode:0o600}); process.exit(0); }
catch(error) { fs.writeFileSync(result,JSON.stringify({rejected:true,name:error?.name,messages:messages(error),elapsedMs:performance.now()-started}),{flag:'wx',mode:0o600}); process.exit(1); }
`, { mode: 0o600 });
  const env = { ...process.env };
  const sentinel = await launch(node, ['-e', 'setInterval(()=>{},1000)'], root, env);
  let groups = 0, completed = false;
  try {
    for (const mode of ['deadline', 'SIGTERM', 'SIGINT', 'gate-failure', 'next-escalation', 'cleanup-uncertain'] as const) {
      const directory = path.join(root, mode); await fs.mkdir(directory, { mode: 0o700 });
      const own = await fixture(directory, source, mode), outcomePath = path.join(own.evidence, 'outcome.json');
      const timeoutMs = ['deadline', 'next-escalation', 'cleanup-uncertain'].includes(mode) ? 2500 : 12_000;
      const worker = await launch(node, ['--conditions=react-server', '--import', pathToFileURL(hook).href,
        workerScript, own.repo, outcomePath, String(timeoutMs)], own.repo,
      { ...env, TMPDIR: directory, PATH: `${own.bin}${path.delimiter}${env.PATH ?? ''}` });
      const captured: Identity[] = [worker.identity];
      let independentlyClosed = false;
      try {
        const processFacts = await until(async () => {
          const facts = await Promise.all(roles.map(role => json<Identity>(path.join(own.evidence, `${role}.json`))));
          return facts.every((fact): fact is Identity => fact !== undefined) ? facts : undefined;
        }, 10_000, `${mode} complete parent/child identity chain`);
        captured.push(...processFacts);
        const [npm, relay, next, leaf] = processFacts;
        assert.equal(npm.ppid, worker.identity.pid); assert.equal(npm.pgid, npm.pid);
        assert.equal(relay.ppid, npm.pid); assert.equal(relay.pgid, npm.pgid);
        assert.equal(next.ppid, relay.pid); assert.equal(next.pgid, next.pid); assert.notEqual(next.pgid, npm.pgid);
        assert.equal(leaf.ppid, next.pid); assert.equal(leaf.pgid, next.pgid);
        for (const entry of captured) {
          assertHeld(entry); assert.equal(identity(entry.pid, entry.cwd)?.ppid, entry.ppid, 'The actual live ancestry must match the captured child chain.');
        }
        if (mode === 'SIGTERM' || mode === 'SIGINT') { assertHeld(worker.identity); process.kill(worker.identity.pid, mode); }
        await waitClosed(worker, mode === 'cleanup-uncertain' ? 25_000 : 20_000);
        const outcome = await json<Outcome>(outcomePath);
        assert(outcome?.rejected, `${mode}: actual build function must reject: ${worker.output()}`);
        assert.equal(worker.process.exitCode, 1);
        assert(outcome.messages.length > 0);
        if (mode === 'gate-failure') {
          assert(outcome.elapsedMs >= 2500 && outcome.elapsedMs < timeoutMs, 'Natural failure must outlive the 250-ms comparison boundary and precede its actual deadline.');
          assert(outcome.messages.some(message => message.includes('Production build failed')));
          assert(!outcome.messages.some(message => /deadline|cancellation/u.test(message)));
          assert(worker.output().includes('[yjs-qa] production build;'));
          const scratch = (await fs.readdir(directory)).filter(name => name.startsWith('canvas-yjs-build-'));
          assert.equal(scratch.length, 1);
          const buildRoot = path.join(directory, scratch[0]); assert.equal(await fs.realpath(buildRoot), buildRoot);
          const actualLog = await fs.readFile(path.join(buildRoot, 'build.log'), 'utf8');
          assert(actualLog.includes('LIFECYCLE_FIXTURE_GATE_FAILURE') && actualLog.includes('exit=31'), 'The genuine failing child and real release relay must both report their failure.');
          const exit = await json<{ code: number | null }>(path.join(own.evidence, 'relay-exit.json'));
          assert.equal(exit?.code, 31);
          await assert.rejects(fs.readFile(path.join(own.evidence, 'npm.signals')), { code: 'ENOENT' });
        } else {
          assert(outcome.messages.some(message => message.includes(mode === 'SIGTERM' || mode === 'SIGINT'
            ? 'Owned run cancellation requested' : 'Owned child deadline exceeded')));
          assert((await fs.readFile(path.join(own.evidence, 'next.signals'), 'utf8')).includes('SIGTERM'), 'The real release relay must reach the separate Next group.');
        }
        if (mode === 'next-escalation') {
          assert(outcome.elapsedMs >= 10_000, 'Noncooperative Next must actually reach the unchanged 10-second relay escalation.');
          const exit = await json<{ code: number | null; signal: string | null }>(path.join(own.evidence, 'relay-exit.json'));
          assert(exit); assert.equal(exit.code, 1); assert.equal(exit.signal, null);
        }
        if (mode === 'cleanup-uncertain') {
          assert.equal(outcome.name, 'AggregateError');
          assert(outcome.messages.filter(message => message.includes('Owned child deadline exceeded')).length >= 2,
            'Both original deadline and the actual 15-second shutdown failure must remain visible.');
          assert(outcome.elapsedMs >= 15_000); assertHeld(npm);
          assert(groupMembers(npm.pgid).includes(npm.pid), 'An unconfirmed build child must remain observable before test-owned cleanup.');
          // The function failed with cleanup uncertainty. This separately fenced test cleanup is not its success.
          await stopCaptured(captured);
        } else await gone(captured);
        independentlyClosed = true;
        for (const name of [proofName, `${proofName}.writing`]) {
          await assert.rejects(fs.lstat(path.join(own.repo, '.next', name)), { code: 'ENOENT' });
        }
        assertHeld(sentinel.identity);
        groups++; console.log(`PASS lifecycle ${groups}/6 ${mode} (process supervision only)`);
      } finally {
        if (!independentlyClosed) {
          // Recover additional already-created fixture identities if an assertion failed during startup.
          for (const role of roles) {
            const fact = await json<Identity>(path.join(own.evidence, `${role}.json`));
            if (fact && !captured.some(entry => entry.pid === fact.pid)) {
              assert(captured.some(parent => parent.pid === fact.ppid), 'An unobserved foreign process cannot be adopted for cleanup.');
              assert.equal(fact.cwd, own.repo); captured.push(fact);
            }
          }
          await stopCaptured(captured);
        }
      }
    }
    assert.equal(groups, 6); completed = true;
  } finally {
    await stopCaptured([sentinel.identity]); await sentinel.closed;
    if (completed) {
      const current = await fs.lstat(root);
      assert.equal(current.dev, rootIdentity.dev); assert.equal(current.ino, rootIdentity.ino);
      assert.equal(await fs.realpath(root), root); await fs.rm(root, { recursive: true });
    } else console.error(`Lifecycle failure evidence preserved at ${root}`);
  }
  console.log('Owned build lifecycle: 6/6. No application build or browser acceptance was performed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/yjs-owned-build-lifecycle-test.ts')) {
  void yjsOwnedBuildLifecycleTest().catch(error => { console.error(error); process.exitCode = 1; });
}
