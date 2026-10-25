import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./prepare-release-runner.sh', import.meta.url));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-release-runner-test-'));
const bin = path.join(fixture, 'bin');
fs.mkdirSync(bin);
const mock = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
if(name === 'uname') console.log(process.env.CANVAS_TEST_UNAME || 'Linux');
else if(name === 'df') console.log('Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 100000000 1000000 ' + (process.env.CANVAS_TEST_FREE_KIB || '90000000') + ' 1% /');
else if(name === 'free') console.log('Fixture memory diagnostics');
else if(name === 'sudo') {
  fs.appendFileSync(process.env.CANVAS_TEST_COMMAND_LOG, JSON.stringify(args) + '\\n');
  if(args[0] === 'du') console.log('1 ' + args.at(-1));
  else if(args[0] === 'install') {
    if(args.at(-1) !== path.join(process.env.RUNNER_TEMP, 'canvas-release.swap')) throw Error('Unexpected target');
    fs.writeFileSync(args.at(-1), '', {mode:0o600,flag:'wx'});
  } else if(!['fallocate','mkswap','swapon'].includes(args[0])) throw Error('Unexpected privileged mutation');
}
`;
try {
  for (const name of ['uname', 'df', 'free', 'sudo']) fs.writeFileSync(path.join(bin, name), mock, {mode:0o700});
  const run = (name, overrides = {}, existing = false) => {
    const temporary = path.join(fixture, name + ' with spaces'); fs.mkdirSync(temporary);
    const commands = path.join(temporary, 'commands.jsonl');
    const swap = path.join(temporary, 'canvas-release.swap');
    if(existing) fs.writeFileSync(swap, 'retained original');
    const result = spawnSync('bash', [script], {encoding:'utf8', env:{...process.env, PATH:bin + path.delimiter + process.env.PATH,
      GITHUB_ACTIONS:'true', CANVAS_RELEASE_RUNNER_ENVIRONMENT:'github-hosted', RUNNER_TEMP:temporary,
      CANVAS_TEST_COMMAND_LOG:commands, ...overrides}});
    return {...result, swap, commands:fs.existsSync(commands) ? fs.readFileSync(commands,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : []};
  };
  for(const [name,env] of [['local',{GITHUB_ACTIONS:'false'}],['persistent',{CANVAS_RELEASE_RUNNER_ENVIRONMENT:'self-hosted'}],['mac',{CANVAS_TEST_UNAME:'Darwin'}]]) {
    const result=run(name,env);assert.notEqual(result.status,0);assert.equal(result.commands.length,0);assert.equal(fs.existsSync(result.swap),false);
  }
  const existing=run('existing',{},true);assert.notEqual(existing.status,0);assert.equal(fs.readFileSync(existing.swap,'utf8'),'retained original');assert.equal(existing.commands.length,0);
  const low=run('low-disk',{CANVAS_TEST_FREE_KIB:'40000000'});assert.notEqual(low.status,0);assert.match(low.stderr,/Insufficient free disk/);assert.ok(low.commands.every(args=>args[0]==='du'));assert.equal(fs.existsSync(low.swap),false);
  const success=run('sufficient');assert.equal(success.status,0,success.stderr);
  assert.deepEqual(success.commands,[['install','-m','600','/dev/null',success.swap],['fallocate','-l','32G',success.swap],['mkswap',success.swap],['swapon',success.swap]]);
  assert.equal(fs.statSync(success.swap).mode & 0o777,0o600);
  console.log('Release runner: local/persistent/non-Linux refusal, retained existing files, disk headroom and bounded private swap setup passed without real privileged commands.');
} finally { fs.rmSync(fixture,{recursive:true,force:true}); }
