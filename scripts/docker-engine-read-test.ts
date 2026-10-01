import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import http, { type RequestListener, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { createDefaultConfig } from '../cli/src/core/config';
import { DockerManager } from '../cli/src/core/docker';
import { DockerEngineReadClient, DOCKER_READ_TIMEOUT_MS, localDockerSocketPath } from '../cli/src/core/dockerEngine';
import { resolveDefaultPaths } from '../cli/src/core/platform';
import type { CommandResult, CommandRunner, RunOptions, RuntimeContext } from '../cli/src/core/types';

const containerId = 'a'.repeat(64);
const imageId = `sha256:${'b'.repeat(64)}`;
const imageRef = `registry.example:5000/canvas/notebook@sha256:${'c'.repeat(64)}`;
const created = '2026-10-02T00:00:00.123456789Z';

function fixtureEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...overrides };
}

const context: RuntimeContext = {
  platform: process.platform === 'win32' ? 'windows' : 'linux',
  paths: resolveDefaultPaths('linux', fixtureEnv({ HOME: '/tmp', CANVAS_INSTALL_DIR: '/tmp/canvas-engine-test' })),
  serviceName: 'canvas-notebook',
  dockerBin: 'docker',
};
const config = { ...createDefaultConfig(context.paths, context.platform), image: imageRef };

function inspectedContainer() {
  return {
    Id: containerId, Name: '/canvas-notebook', Image: imageId, RestartCount: 0,
    Config: { Image: imageRef },
    State: { Status: 'running', Running: true, Restarting: false, OOMKilled: false, ExitCode: 0, StartedAt: created },
  };
}

function inspectedImage() {
  return { Id: imageId, Created: created, RepoDigests: [imageRef] };
}

class FixtureRunner implements CommandRunner {
  calls: Array<{ args: string[]; options: RunOptions }> = [];
  contextResult: CommandResult = { status: 0, stdout: '', stderr: '' };
  contextError?: Error;
  composeResult?: CommandResult;
  inspectResult?: CommandResult;

  async run(_command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ args: [...args], options });
    if (args[0] === 'context') {
      if (this.contextError) throw this.contextError;
      return this.contextResult;
    }
    if (args[0] === 'compose') return this.composeResult ?? { status: 0, stdout: `${containerId}\n`, stderr: '' };
    if (args[0] === 'exec') return { status: 0, stdout: '5.9.1\n', stderr: '' };
    if (args[0] === 'image') return this.inspectResult ?? { status: 0, stdout: `${imageId}\n`, stderr: '' };
    if (this.inspectResult) return this.inspectResult;
    if (args.includes('{{.State.Running}}')) return { status: 0, stdout: 'true\n', stderr: '' };
    return { status: 0, stdout: `${imageId}\n`, stderr: '' };
  }
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function withSocket(handler: RequestListener, test: (endpoint: string, stop: () => Promise<void>) => Promise<void>): Promise<void> {
  const socketPath = `/tmp/canvas-engine-${randomUUID()}.sock`;
  const sockets = new Set<Socket>();
  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const stop = async () => {
    if (!server.listening) return;
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
  };
  try {
    await test(`unix://${socketPath}`, stop);
  } finally {
    await stop();
    await rm(socketPath, { force: true });
  }
}

function client(endpoint: string, runner = new FixtureRunner(), options: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
  return new DockerEngineReadClient(runner, context, { env: fixtureEnv({ DOCKER_HOST: endpoint }), ...options });
}

function errorCode(code: string) {
  return (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`✓ ${name}`);
}

async function main(): Promise<void> {
  await test('local endpoint parsing accepts Unix and local Windows pipes only', () => {
    assert.equal(localDockerSocketPath('unix:///tmp/docker.sock', 'darwin'), '/tmp/docker.sock');
    assert.equal(localDockerSocketPath('npipe:////./pipe/docker_engine', 'win32'), '\\\\.\\pipe\\docker_engine');
    assert.equal(localDockerSocketPath('npipe:////remote/pipe/docker_engine', 'win32'), null);
    assert.equal(localDockerSocketPath('unix://relative', 'linux'), null);
    assert.equal(localDockerSocketPath('unix:///tmp/docker.sock\n', 'linux'), null);
    assert.equal(localDockerSocketPath('ssh://host', 'linux'), null);
    assert.equal(localDockerSocketPath('tcp://localhost:2375', 'linux'), null);
  });

  await test('compatibility selection preserves CLI reads, timeouts and API-version override', async () => {
    for (const env of [
      { DOCKER_HOST: 'tcp://localhost:2376' },
      { DOCKER_HOST: 'ssh://remote' },
      { DOCKER_HOST: 'unix:///missing.sock', DOCKER_API_VERSION: '1.44' },
      { DOCKER_HOST: 'unix:///missing.sock', DOCKER_TLS_VERIFY: '1' },
      { DOCKER_HOST: 'unix:///missing.sock', DOCKER_TLS: '1' },
      { DOCKER_HOST: 'unix:///missing.sock', DOCKER_CERT_PATH: '/certificates' },
      {},
    ]) {
      const runner = new FixtureRunner();
      const docker = new DockerManager(runner, context, { env: fixtureEnv(env) });
      assert.equal(await docker.imageId(imageRef), imageId);
      assert.equal(await docker.containerImageId(containerId), imageId);
      assert.equal(await docker.isContainerRunning(containerId), true);
      assert.equal(await docker.containerId(config), containerId);
      assert(runner.calls.every((call) => call.options.timeoutMs === DOCKER_READ_TIMEOUT_MS));
      assert(runner.calls.filter((call) => call.args[0] === 'context').length <= 1);
      if ('DOCKER_API_VERSION' in env) assert.equal(runner.calls.some((call) => call.args[0] === 'context'), false);
    }
  });

  await test('failed, malformed or throwing context discovery retains CLI compatibility', async () => {
    for (const result of [
      { status: 1, stdout: '', stderr: 'no such context' },
      { status: 0, stdout: 'not-json', stderr: '' },
      { status: 0, stdout: '{}', stderr: '' },
    ]) {
      const runner = new FixtureRunner();
      runner.contextResult = result;
      const engine = new DockerEngineReadClient(runner, context, { env: fixtureEnv({ DOCKER_CONTEXT: 'selected' }) });
      assert.equal(await engine.inspectImage(imageRef), undefined);
      assert.equal(await engine.inspectContainer(containerId), undefined);
      assert.equal(runner.calls.length, 1);
    }
    const runner = new FixtureRunner();
    runner.contextError = Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' });
    assert.equal(await new DockerEngineReadClient(runner, context, { env: fixtureEnv() }).inspectImage(imageRef), undefined);
  });

  await test('CLI read failures cannot become false absence or erase rollback image IDs', async () => {
    for (const status of [1, 124, 130]) {
      const runner = new FixtureRunner();
      const docker = new DockerManager(runner, context, { env: fixtureEnv({ DOCKER_HOST: 'ssh://compatibility' }) });
      runner.composeResult = { status, stdout: '', stderr: 'private diagnostic must not enter the error message' };
      await assert.rejects(docker.containerId(config), (error: unknown) => error instanceof Error
        && error.message.includes(`status ${status}`) && !error.message.includes('private diagnostic'));
      runner.composeResult = { status: 0, stdout: '', stderr: '' };
      assert.equal(await docker.containerId(config), '');
      runner.inspectResult = { status, stdout: '', stderr: '' };
      await assert.rejects(docker.containerImageId(containerId));
      if (status === 1) assert.equal(await docker.imageId(imageRef), '');
      else {
        await assert.rejects(docker.imageId(imageRef));
        await assert.rejects(docker.isContainerRunning(containerId));
        await assert.rejects(docker.imageStatus(config, containerId));
        runner.composeResult = { status: 0, stdout: containerId, stderr: '' };
        await assert.rejects(docker.inspectContainer(config));
      }
    }
    const runner = new FixtureRunner();
    runner.inspectResult = { status: 0, stdout: '', stderr: '' };
    await assert.rejects(new DockerManager(runner, context, { env: fixtureEnv() }).containerImageId(containerId), errorCode('EPROTOCOL'));
  });

  if (process.platform === 'win32') {
    console.log(`Docker Engine read tests: ${passed} passed (Unix HTTP fixtures require Linux or macOS).`);
    return;
  }

  await test('structured status uses encoded references, fresh state and a single negotiation', async () => {
    const requests: Array<{ method?: string; url?: string }> = [];
    const currentContainer = inspectedContainer();
    let missingImage = false;
    let missingContainer = false;
    await withSocket((request, response) => {
      requests.push({ method: request.method, url: request.url });
      if (request.url === '/version') json(response, { ApiVersion: '1.54', MinAPIVersion: '1.40' });
      else if (request.url?.startsWith('/v1.47/images/')) json(response, missingImage ? {} : inspectedImage(), missingImage ? 404 : 200);
      else if (request.url?.startsWith('/v1.47/containers/')) json(response, missingContainer ? {} : currentContainer, missingContainer ? 404 : 200);
      else json(response, {}, 500);
    }, async (endpoint) => {
      const runner = new FixtureRunner();
      const docker = new DockerManager(runner, context, { env: fixtureEnv({ DOCKER_HOST: endpoint }) });
      assert.equal(await docker.imageId(imageRef), imageId);
      assert.equal(await docker.containerImageId(containerId), imageId);
      assert.equal(await docker.isContainerRunning(containerId), true);
      assert.deepEqual(await docker.inspectContainer(config), {
        id: containerId, name: '/canvas-notebook', status: 'running', running: true, restarting: false,
        oomKilled: false, exitCode: 0, restartCount: 0, image: imageRef, imageId, startedAt: created,
      });
      const status = await docker.imageStatus(config, containerId);
      assert.equal(status.localId, imageId);
      assert.equal(status.localDigest, imageRef);
      assert.equal(status.localCreated, created);
      assert.equal(status.runningImageId, imageId);
      assert.equal(status.runningRef, imageRef);
      assert.equal(status.runningStartedAt, created);
      assert.equal(status.appVersion, '5.9.1');
      assert(requests.some((request) => request.url === `/v1.47/images/${encodeURIComponent(imageRef)}/json`));
      currentContainer.State.Running = false;
      currentContainer.State.Status = 'exited';
      assert.equal(await docker.isContainerRunning(containerId), false);
      missingContainer = true;
      missingImage = true;
      assert.equal(await docker.inspectContainer(config), null);
      assert.equal(await docker.containerImageId(containerId), '');
      assert.equal(await docker.isContainerRunning(containerId), false);
      assert.equal(await docker.imageId(imageRef), '');
      const missingStatus = await docker.imageStatus(config, '');
      assert.equal(missingStatus.localId, '');
      assert.equal(missingStatus.runningImageId, '');
      assert.equal(requests.filter((request) => request.url === '/version').length, 1);
      assert(requests.every((request) => request.method === 'GET'));
      assert(runner.calls.every((call) => ['compose', 'exec'].includes(call.args[0])));
      assert(runner.calls.every((call) => call.options.timeoutMs === DOCKER_READ_TIMEOUT_MS));
    });
  });

  await test('explicit context overrides host; default context and host selection match Docker precedence', async () => {
    await withSocket((request, response) => json(response, request.url === '/version'
      ? { ApiVersion: '1.47', MinAPIVersion: '1.40' } : inspectedImage()), async (endpoint) => {
      for (const env of [
        fixtureEnv({ DOCKER_CONTEXT: 'orbstack', DOCKER_HOST: 'unix:///must-not-be-used.sock' }),
        fixtureEnv(),
        fixtureEnv({ DOCKER_HOST: endpoint }),
      ]) {
        const runner = new FixtureRunner();
        runner.contextResult = { status: 0, stdout: JSON.stringify({ Host: endpoint, SkipTLSVerify: false }), stderr: '' };
        const engine = new DockerEngineReadClient(runner, context, { env });
        assert.equal((await engine.inspectImage(imageRef))?.id, imageId);
        runner.contextResult = { status: 1, stdout: '', stderr: '' };
        assert.equal((await engine.inspectImage(imageRef))?.id, imageId);
        if ('DOCKER_HOST' in env && !('DOCKER_CONTEXT' in env)) assert.equal(runner.calls.length, 0);
        else {
          assert.equal(runner.calls.length, 1);
          assert.deepEqual(runner.calls[0].args, ['context', 'inspect', ...('DOCKER_CONTEXT' in env ? ['orbstack'] : []), '--format', '{{json .Endpoints.docker}}']);
          assert.deepEqual(runner.calls[0].options.env, env);
        }
      }
      const env = fixtureEnv({ DOCKER_HOST: endpoint });
      const engine = new DockerEngineReadClient(new FixtureRunner(), context, { env });
      env.DOCKER_HOST = 'unix:///changed-after-construction.sock';
      assert.equal((await engine.inspectImage(imageRef))?.id, imageId);
    });
  });

  await test('absent socket selects CLI once, and compatible older API versions are negotiated', async () => {
    const absent = client(`unix:///tmp/canvas-engine-missing-${randomUUID()}.sock`);
    assert.equal(await absent.inspectImage(imageRef), undefined);
    assert.equal(await absent.inspectContainer(containerId), undefined);
    const paths: string[] = [];
    await withSocket((request, response) => {
      paths.push(request.url ?? '');
      json(response, request.url === '/version' ? { ApiVersion: '1.41', MinAPIVersion: '1.40' } : inspectedImage());
    }, async (endpoint) => {
      assert.equal((await client(endpoint).inspectImage(imageRef))?.id, imageId);
      assert.equal(paths[1], `/v1.41/images/${encodeURIComponent(imageRef)}/json`);
    });
  });

  await test('incompatible daemon ranges use CLI; malformed version ranges fail visibly', async () => {
    for (const version of [
      { ApiVersion: '1.39', MinAPIVersion: '1.24' },
      { ApiVersion: '1.54', MinAPIVersion: '1.50' },
    ]) {
      let calls = 0;
      await withSocket((_request, response) => { calls += 1; json(response, version); }, async (endpoint) => {
        const engine = client(endpoint);
        assert.equal(await engine.inspectImage(imageRef), undefined);
        assert.equal(await engine.inspectImage(imageRef), undefined);
        assert.equal(calls, 1);
      });
    }
    for (const version of [{ ApiVersion: '1.54' }, { ApiVersion: 'wrong', MinAPIVersion: '1.40' }, { ApiVersion: '1.40', MinAPIVersion: '1.54' }]) {
      await withSocket((_request, response) => json(response, version), async (endpoint) => {
        await assert.rejects(client(endpoint).inspectImage(imageRef), errorCode('EPROTOCOL'));
      });
    }
  });

  await test('HTTP and JSON protocol failures never silently switch to CLI', async () => {
    for (const mode of ['http', 'malformed', 'wrong-container', 'wrong-state', 'wrong-image'] as const) {
      const runner = new FixtureRunner();
      await withSocket((request, response) => {
        if (request.url === '/version') json(response, { ApiVersion: '1.47', MinAPIVersion: '1.40' });
        else if (mode === 'http') json(response, {}, 503);
        else if (mode === 'malformed') response.end('{broken');
        else if (mode === 'wrong-container') json(response, { ...inspectedContainer(), Id: 'd'.repeat(64) });
        else if (mode === 'wrong-state') json(response, { ...inspectedContainer(), State: { ...inspectedContainer().State, Running: 'true' } });
        else json(response, { ...inspectedImage(), Id: 'mutable-tag-instead-of-image-id' });
      }, async (endpoint) => {
        const docker = new DockerManager(runner, context, { env: fixtureEnv({ DOCKER_HOST: endpoint }) });
        await assert.rejects(mode === 'wrong-image' ? docker.imageId(imageRef) : docker.isContainerRunning(containerId), errorCode(mode === 'http' ? 'EHTTP' : 'EPROTOCOL'));
        assert.equal(runner.calls.length, 0);
      });
    }
    await withSocket((_request, response) => json(response, {}, 404), async (endpoint) => {
      await assert.rejects(client(endpoint).inspectImage(imageRef), errorCode('EHTTP'));
    });
  });

  await test('container IDs are checked before inspection; a stopped daemon after negotiation is an error', async () => {
    await withSocket((request, response) => json(response, request.url === '/version'
      ? { ApiVersion: '1.47', MinAPIVersion: '1.40' } : inspectedContainer()), async (endpoint, stop) => {
      const engine = client(endpoint);
      await assert.rejects(engine.inspectContainer('../../other?container'), errorCode('EPROTOCOL'));
      assert.equal((await engine.inspectContainer(containerId.slice(0, 12)))?.id, containerId);
      await stop();
      await assert.rejects(engine.inspectContainer(containerId), (error: unknown) =>
        ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].some((code) => errorCode(code)(error)));
    });
  });

  await test('response bounds apply to declared and streamed bodies', async () => {
    for (const declared of [true, false]) {
      await withSocket((request, response) => {
        if (request.url === '/version') json(response, { ApiVersion: '1.47', MinAPIVersion: '1.40' });
        else {
          if (declared) response.writeHead(200, { 'Content-Length': '1024' });
          else response.writeHead(200, { 'Transfer-Encoding': 'chunked' });
          response.end('x'.repeat(1024));
        }
      }, async (endpoint) => {
        await assert.rejects(client(endpoint, new FixtureRunner(), { maxResponseBytes: 256 }).inspectImage(imageRef), errorCode('ETOOBIG'));
      });
    }
  });

  await test('absolute deadlines stop stalled negotiation and continuously streaming reads', async () => {
    await withSocket((_request, _response) => {}, async (endpoint) => {
      await assert.rejects(client(endpoint, new FixtureRunner(), { timeoutMs: 50 }).inspectImage(imageRef), errorCode('ETIMEDOUT'));
    });
    await withSocket((request, response) => {
      if (request.url === '/version') json(response, { ApiVersion: '1.47', MinAPIVersion: '1.40' });
      else {
        response.writeHead(200, { 'Transfer-Encoding': 'chunked' });
        const interval = setInterval(() => response.write(' '), 5);
        response.once('close', () => clearInterval(interval));
      }
    }, async (endpoint) => {
      const started = performance.now();
      await assert.rejects(client(endpoint, new FixtureRunner(), { timeoutMs: 60 }).inspectImage(imageRef), errorCode('ETIMEDOUT'));
      assert(performance.now() - started < 1000, 'streaming data must not extend the deadline');
    });
  });

  console.log(`Docker Engine read tests: ${passed} passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
