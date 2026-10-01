import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DockerEngineClient, DockerExecInterruptedError } from '../cli/src/core/dockerEngine';
import { DockerManager } from '../cli/src/core/docker';
import { createDefaultConfig } from '../cli/src/core/config';
import { createRuntimeContext } from '../cli/src/core/platform';
import { SpawnCommandRunner } from '../cli/src/core/process';

async function main() {
  const runner = new SpawnCommandRunner();
  const context = createRuntimeContext({ ...process.env, CANVAS_INSTALL_DIR: os.tmpdir() });
  const engine = new DockerEngineClient(runner, context);
  const docker = new DockerManager(runner, context, engine);
  assert(await engine.available(), 'Use the local skill stack and a Docker Unix socket context');
  assert(await engine.ping());
  const container = await engine.inspectContainer('canvas-local-prod-notebook');
  assert(container?.State.Running);
  const image = await engine.inspectImage(container.Image);
  assert.equal(image?.Id, container.Image);
  const config = createDefaultConfig(context.paths, context.platform);
  config.image = container.Config.Image;
  const status = await docker.imageStatus(config, container.Id);
  assert.equal(status.runningImageId, container.Image);assert.ok(status.appVersion);
  const output = await docker.exec(container.Id, ['node', '-e', "process.stdout.write('out');process.stderr.write('err');process.exitCode=7"]);
  assert.equal(output.status, 7);assert.equal(output.stdout, 'out');assert.equal(output.stderr, 'err');
  for (let index = 0; index < 10; index += 1) {
    const input = `${'ü'.repeat(1000)}-${index}\n`;
    const result = await docker.exec(container.Id, ['node', '-e', "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>console.log(JSON.stringify(input)))"], {stdin:input,timeoutMs:3000});
    assert.equal(result.status, 0);assert.equal(JSON.parse(result.stdout), input);
  }
  const postgres = await engine.inspectContainer('canvas-local-prod-postgres');assert(postgres?.State.Running);
  const ready = await docker.exec(postgres.Id, ['pg_isready'], { user:'postgres',timeoutMs:5000 });assert.equal(ready.status,0);
  const pgEnv = Object.fromEntries((await fs.readFile(path.join(os.homedir(), '.local/state/canvas-local-team-seat/postgres.env'), 'utf8')).split('\n').filter(line=>line.includes('=')&&!line.startsWith('#')).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
  const sql = await docker.execOrThrow(postgres.Id, ['psql','-U',pgEnv.POSTGRES_USER,'-d','canvas_notebook','-At'], {user:'postgres',stdin:"SELECT current_setting('server_version'), extversion FROM pg_extension WHERE extname = 'vector';\n",timeoutMs:5000,capture:'exact'});
  assert.match(sql.stdout,/^18\..+\|0\.8\.3/u);
  const marker = `canvas-exec-${randomUUID()}`;
  let interrupted: DockerExecInterruptedError | undefined;
  try { await docker.exec(container.Id, ['node','-e','setTimeout(()=>{},1500)',marker], {timeoutMs:250}); }
  catch (error) { assert(error instanceof DockerExecInterruptedError);interrupted=error; }
  assert(interrupted?.running, 'A client timeout must expose that remote execution continues');
  await new Promise(resolve=>setTimeout(resolve,1800));
  const reaped = await docker.execOrThrow(container.Id, ['node','-e', "const fs=require('fs');const marker=process.argv[1];let count=0;for(const id of fs.readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x))){if(id===String(process.pid))continue;try{if(fs.readFileSync('/proc/'+id+'/cmdline','utf8').split(String.fromCharCode(0)).includes(marker))count++}catch{}}console.log(count)",marker], {timeoutMs:3000});
  assert.equal(reaped.stdout.trim(),'0');
  console.log('Local skill stack: API snapshots, application version, exit status, stdin EOF, PostgreSQL/pgvector and observable timeout passed');
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
