import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';
import { DockerEngineClient, DockerExecInterruptedError } from '../cli/src/core/dockerEngine';
import { DockerManager } from '../cli/src/core/docker';
import { createDefaultConfig } from '../cli/src/core/config';
import { createRuntimeContext } from '../cli/src/core/platform';
import type { CommandRunner, RunOptions } from '../cli/src/core/types';

class Runner implements CommandRunner {
  calls: Array<{ args: string[]; options: RunOptions }> = [];
  constructor(private readonly socketPath: string) {}
  async run(_command: string, args: string[], options: RunOptions = {}) {
    this.calls.push({ args, options });
    if (args[0] === 'context') return { status: 0, stdout: JSON.stringify({ Host: `unix://${this.socketPath}` }), stderr: '' };
    return { status: 0, stdout: 'cli-result', stderr: '' };
  }
}

const frame = (stream: number, text: string) => {
  const data = Buffer.from(text);
  const header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
};

async function main() {
  if (process.platform === 'win32') { console.log('Docker Unix socket tests skipped on Windows'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-'));
  const socketPath = path.join(root, 'd.sock');
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  let mode = 'normal';
  let count = 0;
  let exitCode = 0;
  let running = false;
  let capturedInput = '';
  let createdBody: Record<string, unknown> = {};
  let startCount = 0;
  const container = { Id: 'container', Name: '/notebook', Image: 'sha256:image', RestartCount: 0, Config: { Image: 'image:tag' }, State: { Status: 'running', Running: true, Restarting: false, OOMKilled: false, ExitCode: 0, StartedAt: 'start' } };
  const server = http.createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const json = (body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/version' && mode === 'version-error') { json({}, 500); return; }
    if (req.url === '/version') { json({ ApiVersion: '1.54', MinAPIVersion: '1.40' }); return; }
    if (req.url === '/_ping') { res.end('OK'); return; }
    if (req.url?.includes('/containers/')) {
      if (req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += String(chunk);
        if (mode === 'hang-create') return;
        createdBody = JSON.parse(body); count += 1; running = mode === 'timeout';
        json({ Id: `exec-${count}` }, 201); return;
      }
      if (req.url.includes('missing')) json({}, 404);
      else if (mode === 'http-error') json({}, 500);
      else if (mode === 'oversized-json') res.end('x'.repeat(2 * 1024 * 1024 + 1));
      else json(container);
      return;
    }
    if (req.url?.includes('/images/')) { json({ Id: 'sha256:image', RepoDigests: ['digest'], Created: 'created' }); return; }
    if (req.url?.includes('/exec/') && req.url.endsWith('/json')) { json({ Running: running, ExitCode: running ? null : exitCode }); return; }
    json({}, 404);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('error', () => undefined); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    startCount += 1;
    requests.push(`${req.method} ${req.url}`);
    const size = Number(req.headers['content-length']);
    let body = head;
    const begin = () => {
      socket.removeListener('data', receive);
      if (mode === 'disconnect') { socket.destroy(); return; }
      if (mode === '200') {
        const data = frame(1, 'plain-response');
        socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${data.length}\r\n\r\n`), data])); return;
      }
      socket.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      if (mode === 'timeout' || mode === 'abort') return;
      if (mode === 'stdin') {
        socket.on('data', (chunk) => { capturedInput += String(chunk); });
        socket.on('end', () => { socket.end(frame(1, capturedInput)); }); return;
      }
      let data = Buffer.concat([frame(1, 'Grüße'), frame(2, 'stderr')]);
      if (mode === 'truncated-frame') data = data.subarray(0, data.length - 1);
      if (mode === 'invalid-frame') data[0] = 9;
      if (mode === 'oversized-output') data = frame(1, 'x'.repeat(5000));
      if (mode === 'huge-frame') { data = Buffer.alloc(8); data[0] = 1; data.writeUInt32BE(17 * 1024 * 1024, 4); }
      for (let offset = 0; offset < data.length; offset += 3) socket.write(data.subarray(offset, offset + 3));
      socket.end();
    };
    const receive = (chunk: Buffer) => { body = Buffer.concat([body, chunk]); if (body.length >= size) begin(); };
    if (body.length >= size) begin(); else { socket.on('data', receive); socket.resume(); req.on('data', receive); req.resume(); }
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const context = createRuntimeContext({ NODE_ENV: 'test', CANVAS_INSTALL_DIR: root });
  const runner = new Runner(socketPath);
  const engine = new DockerEngineClient(runner, context, { NODE_ENV: 'test', DOCKER_HOST: `unix://${socketPath}` });
  const docker = new DockerManager(runner, context, engine);
  try {
    mode = 'version-error';
    await assert.rejects(engine.available(), /version negotiation failed/u);
    mode = 'normal';
    assert(await engine.available()); assert(await docker.isReachable());
    assert.equal(await docker.imageId('registry/image@sha256:abc'), 'sha256:image');
    assert.equal(await docker.containerImageId('container'), 'sha256:image');
    assert(await docker.isContainerRunning('container'));
    assert.equal(await engine.inspectContainer('missing'), null);
    exitCode = 7;
    let output = await docker.exec('container', ['command', 'literal; no-shell'], { user: 'postgres', timeoutMs:2000 });
    assert.equal(output.status, 7);assert.equal(output.stdout, 'Grüße');assert.equal(output.stderr, 'stderr');
    assert.deepEqual(createdBody.Cmd, ['command', 'literal; no-shell']);assert.equal(createdBody.User, 'postgres');
    assert.equal(createdBody.AttachStdin, false);
    mode = 'stdin'; exitCode = 0;
    output = await docker.exec('container', ['command'], { stdin: 'password\n', timeoutMs: 2000 });
    assert.equal(output.stdout, 'password\n');assert.equal(createdBody.AttachStdin, true);
    assert.equal(JSON.stringify(createdBody).includes('password'), false);
    mode = '200';assert.equal((await docker.exec('container', ['command'])).stdout, 'plain-response');
    for (const failure of ['truncated-frame', 'invalid-frame', 'huge-frame', 'disconnect', 'oversized-output']) {
      mode = failure;
      await assert.rejects(docker.exec('container', ['command'], {capture: 'exact',maxOutputBytes:4096,timeoutMs:1000}), DockerExecInterruptedError);
    }
    mode = 'oversized-output';
    const tail = await docker.exec('container', ['command'], {maxOutputBytes:4096});
    assert(tail.stdoutTruncated);assert(Buffer.byteLength(tail.stdout) <= 4096);
    mode = 'hang-create';
    await assert.rejects(docker.exec('container', ['command'], {timeoutMs:2000,signal:AbortSignal.timeout(100)}), /request canceled/u);
    mode = 'timeout';
    const before = startCount;
    await assert.rejects(docker.exec('container', ['command'], {timeoutMs:100}), (error: unknown) => error instanceof DockerExecInterruptedError && error.running === true && error.execId.startsWith('exec-'));
    assert.equal(startCount, before + 1);
    mode = 'abort';running = true;
    await assert.rejects(docker.exec('container', ['command'], {signal:AbortSignal.timeout(100)}), DockerExecInterruptedError);
    mode = 'http-error';await assert.rejects(docker.imageStatus(createDefaultConfig(context.paths, context.platform), 'container'), /HTTP 500/u);
    mode = 'oversized-json';await assert.rejects(engine.inspectContainer('container'), /exceeded its limit/u);
    mode = 'normal';running = false;
    const requestOffset = requests.length;
    const status = await docker.imageStatus(createDefaultConfig(context.paths, context.platform), 'container');
    assert.equal(status.runningImageId, 'sha256:image');
    assert.equal(requests.slice(requestOffset).filter(route=>route.endsWith('/json') && !route.includes('/exec/')).length, 2);
    assert.equal(runner.calls.length, 0, 'Direct API operations must not spawn Docker CLI commands');
    const contextual = new DockerEngineClient(runner, context, { NODE_ENV: 'test', DOCKER_CONTEXT: 'chosen-context', DOCKER_HOST: 'unix:///wrong-daemon.sock' });
    assert(await contextual.available());
    assert.deepEqual(runner.calls[0].args.slice(0,3), ['context','inspect','chosen-context']);
    assert.equal(runner.calls[0].options.capture, 'exact');
    const remote = new DockerEngineClient(runner, context, { NODE_ENV: 'test', DOCKER_HOST: 'ssh://remote' });
    assert.equal(await remote.available(), false);
    assert.equal((await new DockerManager(runner, context, remote).exec('container', ['command'])).stdout, 'cli-result');
    assert.equal(runner.calls.at(-1)!.args[0], 'exec');
    const incompatible = new DockerEngineClient(runner, context, { NODE_ENV: 'test', DOCKER_HOST: `unix://${socketPath}`, DOCKER_API_VERSION: '1.39' });
    assert.equal(await incompatible.available(), false);
    const disabled = new DockerEngineClient(runner, context, { NODE_ENV: 'test', CANVAS_DOCKER_ENGINE_API: 'off' });
    assert.equal(await disabled.available(), false);
    console.log('Docker API: context selection, version negotiation, snapshot batching, stdin, framed output, status, deadlines, cancellation and no duplicate execution passed');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(()=>resolve()));
    await fs.rm(root, {recursive:true,force:true});
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
