import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { CommandResult, CommandRunner, RunOptions, RuntimeContext, StatusJson } from './types';

export const DOCKER_READ_TIMEOUT_MS = 20_000;
export const MAX_DOCKER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_API_VERSION = '1.40';
const MAX_API_VERSION = '1.47';

type EngineConnection = { socketPath: string; apiVersion: string };
type EngineContainer = NonNullable<StatusJson['container']>;
export type EngineImage = { id: string; repoDigests: string[]; created: string };
export type DockerEngineOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export class DockerEngineError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'DockerEngineError';
  }
}

export function localDockerSocketPath(endpoint: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32' && endpoint.startsWith('unix://')) {
    const socketPath = endpoint.slice('unix://'.length);
    return socketPath.startsWith('/') && !/[\0\r\n]/u.test(socketPath) ? socketPath : null;
  }
  if (platform === 'win32') {
    const pipe = /^npipe:\/\/\/\/\.\/pipe\/([a-zA-Z0-9_.-]+)$/u.exec(endpoint);
    if (pipe) return `\\\\.\\pipe\\${pipe[1]}`;
  }
  return null;
}

function apiVersion(value: unknown): number | null {
  if (typeof value !== 'string' || !/^1\.\d{1,3}$/u.test(value)) return null;
  return Number(value.slice(2));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DockerEngineError(`Docker Engine returned invalid ${label}.`, 'EPROTOCOL');
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string, maxLength = 512): string {
  if (typeof value !== 'string' || !value || value.length > maxLength || /[\0\r\n]/u.test(value)) {
    throw new DockerEngineError(`Docker Engine returned invalid ${label}.`, 'EPROTOCOL');
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = stringField(value, label, 80);
  if (!Number.isFinite(Date.parse(text))) throw new DockerEngineError(`Docker Engine returned invalid ${label}.`, 'EPROTOCOL');
  return text;
}

function imageId(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new DockerEngineError('Docker Engine returned an invalid image ID.', 'EPROTOCOL');
  }
  return value;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new DockerEngineError(`Docker Engine returned invalid ${label}.`, 'EPROTOCOL');
  return value;
}

function integerField(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DockerEngineError(`Docker Engine returned invalid ${label}.`, 'EPROTOCOL');
  }
  return value;
}


const MAX_RESPONSE_BYTES = MAX_DOCKER_RESPONSE_BYTES;
const NOTICE = Buffer.from('[... process output truncated; showing tail ...]\n');

export interface ContainerSnapshot {
  Id: string;
  Name: string;
  Image: string;
  RestartCount: number;
  Config: { Image: string };
  State: { Status: string; Running: boolean; Restarting: boolean; OOMKilled: boolean; ExitCode: number; StartedAt: string };
}

export interface ImageSnapshot { Id: string; RepoDigests?: string[]; Created: string }

export class DockerExecInterruptedError extends Error {
  constructor(readonly execId: string, readonly containerId: string, readonly running: boolean | null, readonly exitCode: number | null, cause: unknown) {
    super(`Docker exec ${execId} interrupted (${cause instanceof Error ? cause.message : 'transport failure'}). Remote state: ${running === null ? 'unknown' : running ? 'still running' : `stopped, exit ${exitCode ?? 'unknown'}`}. The command was not retried.`);
    this.name = 'DockerExecInterruptedError';
  }
}

class OutputCapture {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly limit: number, private readonly exact: boolean) {}
  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size > this.limit) this.truncated = true;
    if (this.truncated && this.exact) throw new Error('Structured Docker exec output exceeded its limit');
    const keep = this.truncated ? this.limit - NOTICE.length : this.limit;
    while (this.size > keep) {
      const first = this.chunks[0];
      const excess = this.size - keep;
      if (first.length <= excess) { this.chunks.shift(); this.size -= first.length; }
      else { this.chunks[0] = Buffer.from(first.subarray(excess)); this.size -= excess; }
    }
  }
  text(): string { return Buffer.concat(this.truncated ? [NOTICE, ...this.chunks] : this.chunks).toString('utf8'); }
}

class DockerFrames {
  private header = Buffer.alloc(0);
  private remaining = 0;
  private stream = 0;
  constructor(private readonly stdout: OutputCapture, private readonly stderr: OutputCapture) {}
  consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining === 0) {
        const count = Math.min(8 - this.header.length, chunk.length - offset);
        this.header = Buffer.concat([this.header, chunk.subarray(offset, offset + count)]);
        offset += count;
        if (this.header.length !== 8) continue;
        this.stream = this.header[0];
        if (![1, 2].includes(this.stream) || this.header[1] || this.header[2] || this.header[3]) throw new Error('Invalid Docker exec stream header');
        this.remaining = this.header.readUInt32BE(4);
        if (this.remaining > 16 * 1024 * 1024) throw new Error('Docker exec frame exceeded its limit');
        this.header = Buffer.alloc(0);
        if (this.remaining === 0) continue;
      }
      const count = Math.min(this.remaining, chunk.length - offset);
      (this.stream === 1 ? this.stdout : this.stderr).append(chunk.subarray(offset, offset + count));
      this.remaining -= count;
      offset += count;
    }
  }
  finish(): void { if (this.remaining || this.header.length) throw new Error('Truncated Docker exec stream'); }
}

export class DockerEngineClient {
  private connection?: Promise<{ socketPath: string; version: string } | null>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  constructor(private readonly runner: CommandRunner, private readonly context: RuntimeContext, env: NodeJS.ProcessEnv = process.env, options: DockerEngineOptions = {}) {
    this.env = { ...env };
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DOCKER_READ_TIMEOUT_MS);
    this.maxResponseBytes = Math.max(1, options.maxResponseBytes ?? MAX_RESPONSE_BYTES);
  }

  private async resolveConnection(): Promise<{ socketPath: string; version: string } | null> {
    if (this.env.CANVAS_DOCKER_ENGINE_API === 'off' || this.context.dockerBin !== 'docker' || this.env.DOCKER_API_VERSION || this.env.DOCKER_TLS || this.env.DOCKER_TLS_VERIFY || this.env.DOCKER_CERT_PATH) return null;
    let host = this.env.DOCKER_CONTEXT ? '' : this.env.DOCKER_HOST || '';
    if (!host) {
      try {
        const result = await this.runner.run(this.context.dockerBin, ['context', 'inspect', ...(this.env.DOCKER_CONTEXT ? [this.env.DOCKER_CONTEXT] : []), '--format', '{{json .Endpoints.docker}}'], {
          cwd: this.context.paths.installDir, env: this.env, timeoutMs: this.timeoutMs, capture: 'exact', maxOutputBytes: 64 * 1024,
        });
        if (result.status !== 0) return null;
        const endpoint = record(JSON.parse(result.stdout), 'Docker context');
        if (typeof endpoint.Host !== 'string' || endpoint.SkipTLSVerify === true) return null;
        host = endpoint.Host;
      } catch { return null; }
    }
    const socketPath = localDockerSocketPath(host);
    if (!socketPath) return null;
    let response: { status: number; body: string };
    try { response = await this.request(socketPath, '/version', 'GET', undefined, this.timeoutMs); }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes((error as NodeJS.ErrnoException).code || '')) return null;
      throw error;
    }
    if (response.status !== 200) throw new DockerEngineError(`Docker API version negotiation failed (HTTP ${response.status})`, 'EHTTP');
    let version: Record<string, unknown>;
    try { version = record(JSON.parse(response.body), 'version response'); }
    catch { throw new DockerEngineError('Docker Engine returned malformed version information.', 'EPROTOCOL'); }
    const maximum = apiVersion(version.ApiVersion);
    const minimum = apiVersion(version.MinAPIVersion);
    if (maximum === null || minimum === null || minimum > maximum) throw new DockerEngineError('Docker Engine returned an invalid API version range.', 'EPROTOCOL');
    const requested = Math.min(apiVersion(MAX_API_VERSION)!, maximum);
    if (requested < Math.max(apiVersion(MIN_API_VERSION)!, minimum)) return null;
    return { socketPath, version: `1.${requested}` };
  }

  private connect() {
    return this.connection ??= this.resolveConnection().catch((error: unknown) => {
      this.connection = undefined;
      throw error;
    });
  }
  async available(): Promise<boolean> { return (await this.connect()) !== null; }

  async execAvailable(): Promise<boolean> { const connection = await this.connect(); return !!connection && connection.socketPath.startsWith('/'); }

  private request(socketPath: string, route: string, method: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      let response: IncomingMessage | undefined;
      let settled = false;
      const finish = (error?: Error, value?: { status: number; body: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) { response?.destroy(); req.destroy(); reject(error); } else resolve(value!);
      };
      const req = http.request({ socketPath, path: route, method, agent: false, headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} }, (res) => {
        response = res;
        const chunks: Buffer[] = [];
        let length = 0;
        res.on('error', finish);
        if (Number(res.headers['content-length']) > this.maxResponseBytes) { finish(new DockerEngineError('Docker API response exceeded its limit', 'ETOOBIG')); return; }
        res.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > this.maxResponseBytes) finish(new DockerEngineError('Docker API response exceeded its limit', 'ETOOBIG'));
          else chunks.push(chunk);
        });
        res.on('end', () => finish(undefined, { status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('close', () => { if (!res.complete) finish(new DockerEngineError('Docker API response disconnected', 'EPROTOCOL')); });
      });
      const timer = setTimeout(() => finish(new DockerEngineError('Docker API request exceeded its deadline', 'ETIMEDOUT')), Math.max(1, timeoutMs));
      const abort = () => finish(new DockerEngineError('Docker API request canceled', 'ABORT_ERR'));
      req.on('error', finish);
      if (signal?.aborted) abort();
      else { signal?.addEventListener('abort', abort, { once: true }); req.end(payload); }
    });
  }

  private async json<T>(route: string, method = 'GET', body?: unknown, timeoutMs = this.timeoutMs, missing = false, signal?: AbortSignal): Promise<T | null> {
    const connection = await this.connect();
    if (!connection) throw new Error('Docker Engine API is unavailable for this context');
    const response = await this.request(connection.socketPath, `/v${connection.version}${route}`, method, body, timeoutMs, signal);
    if (missing && response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) throw new DockerEngineError(`Docker API ${method} ${route} failed (HTTP ${response.status})`, 'EHTTP');
    try { return JSON.parse(response.body) as T; } catch { throw new DockerEngineError('Docker Engine returned malformed JSON.', 'EPROTOCOL'); }
  }

  async ping(): Promise<boolean> {
    const connection = await this.connect();
    if (!connection) return false;
    return (await this.request(connection.socketPath, '/_ping', 'GET', undefined, 10_000)).status === 200;
  }
  async inspectContainer(id: string, timeoutMs = this.timeoutMs): Promise<ContainerSnapshot | null> {
    const value = await this.json<ContainerSnapshot>(`/containers/${encodeURIComponent(id)}/json`, 'GET', undefined, timeoutMs, true);
    if (value && (!value.Id || !value.State || !value.Config || typeof value.State.Running !== 'boolean')) throw new DockerEngineError('Invalid Docker container inspection', 'EPROTOCOL');
    return value;
  }
  async inspectImage(ref: string): Promise<ImageSnapshot | null> {
    const value = await this.json<ImageSnapshot>(`/images/${encodeURIComponent(ref)}/json`, 'GET', undefined, this.timeoutMs, true);
    if (value && (!value.Id || typeof value.Created !== 'string' || (value.RepoDigests && !Array.isArray(value.RepoDigests)))) throw new DockerEngineError('Invalid Docker image inspection', 'EPROTOCOL');
    return value;
  }

  private async streamExec(execId: string, options: RunOptions, timeoutMs: number, frames: DockerFrames): Promise<void> {
    const connection = (await this.connect())!;
    await new Promise<void>((resolve, reject) => {
      let stream: IncomingMessage | Socket | undefined;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        stream?.destroy();
        req.destroy();
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new Error('Docker exec canceled'));
      const consume = (chunk: Buffer) => { try { frames.consume(chunk); } catch (error) { finish(error as Error); } };
      const attach = (value: IncomingMessage | Socket, head?: Buffer) => {
        stream = value;
        value.on('error', finish);
        value.on('data', consume);
        value.on('end', () => { try { frames.finish(); finish(); } catch (error) { finish(error as Error); } });
        value.on('close', () => { if (!settled) finish(new Error('Docker exec disconnected')); });
        if (head?.length) consume(head);
      };
      const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
      const req = http.request({ socketPath: connection.socketPath, path: `/v${connection.version}/exec/${encodeURIComponent(execId)}/start`, method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': payload.length, connection: 'Upgrade', upgrade: 'tcp' } });
      const timer = setTimeout(() => finish(new Error('Docker exec exceeded its deadline')), Math.max(1, timeoutMs));
      req.on('error', finish);
      req.on('upgrade', (res, socket, head) => {
        if (settled) { socket.destroy(); return; }
        if (res.statusCode !== 101) { socket.destroy(); finish(new Error(`Docker exec start failed (HTTP ${res.statusCode})`)); return; }
        attach(socket, head);
        if (!settled) {
          if (options.stdin !== undefined) socket.end(options.stdin);
        }
      });
      req.on('response', (res) => {
        if (settled) { res.destroy(); return; }
        if (res.statusCode !== 200 || options.stdin !== undefined) { res.destroy(); finish(new Error(`Docker exec requires an upgraded stream (HTTP ${res.statusCode})`)); return; }
        attach(res);
      });
      if (options.signal?.aborted) abort();
      else { options.signal?.addEventListener('abort', abort, { once: true }); req.end(payload); }
    });
  }

  async exec(containerId: string, command: string[], options: RunOptions & { user?: string } = {}): Promise<CommandResult> {
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    const remaining = () => { const value = deadline - Date.now(); if (value <= 0) throw new Error('Docker exec exceeded its deadline'); return value; };
    const limit = Math.min(MAX_RESPONSE_BYTES, options.maxOutputBytes ?? MAX_RESPONSE_BYTES);
    if (!Number.isInteger(limit) || limit <= NOTICE.length) throw new Error('Invalid Docker exec output limit');
    if (options.signal?.aborted) throw new Error('Docker exec canceled');
    const created = await this.json<{ Id: string }>(`/containers/${encodeURIComponent(containerId)}/exec`, 'POST', {
      AttachStdin: options.stdin !== undefined, AttachStdout: true, AttachStderr: true, Tty: false, Cmd: command, ...(options.user ? { User: options.user } : {}),
    }, remaining(), false, options.signal);
    if (!created?.Id || typeof created.Id !== 'string') throw new Error('Docker exec creation returned no ID');
    const stdout = new OutputCapture(limit, options.capture === 'exact');
    const stderr = new OutputCapture(limit, options.capture === 'exact');
    try {
      await this.streamExec(created.Id, options, remaining(), new DockerFrames(stdout, stderr));
      let state = await this.json<{ Running: boolean; ExitCode: number | null }>(`/exec/${encodeURIComponent(created.Id)}/json`, 'GET', undefined, remaining(), false, options.signal);
      while (state?.Running) {
        await delay(Math.min(100, remaining()), undefined, { signal: options.signal });
        state = await this.json(`/exec/${encodeURIComponent(created.Id)}/json`, 'GET', undefined, remaining(), false, options.signal);
      }
      if (!state || state.Running !== false || !Number.isInteger(state.ExitCode)) throw new Error('Docker exec exit status is unknown');
      return { status: state.ExitCode!, stdout: stdout.text(), stderr: stderr.text(), stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated };
    } catch (error) {
      const state = await this.json<{ Running: boolean; ExitCode: number | null }>(`/exec/${encodeURIComponent(created.Id)}/json`, 'GET', undefined, 1000).catch(() => null);
      throw new DockerExecInterruptedError(created.Id, containerId, state?.Running ?? null, state?.ExitCode ?? null, error);
    }
  }
}

export class DockerEngineReadClient {
  private readonly engine: DockerEngineClient;

  constructor(runner: CommandRunner, context: RuntimeContext, options: DockerEngineOptions = {}, engine?: DockerEngineClient) {
    this.engine = engine ?? new DockerEngineClient(runner, context, options.env, options);
  }

  async inspectImage(imageRef: string): Promise<EngineImage | null | undefined> {
    if (!await this.engine.available()) return undefined;
    stringField(imageRef, 'image reference');
    const response = await this.engine.inspectImage(imageRef);
    if (response === null) return null;
    const inspected = record(response, 'image inspection');
    const repoDigests = inspected.RepoDigests ?? [];
    if (!Array.isArray(repoDigests) || repoDigests.length > 1024) {
      throw new DockerEngineError('Docker Engine returned invalid repository digests.', 'EPROTOCOL');
    }
    return {
      id: imageId(inspected.Id),
      repoDigests: repoDigests.map((digest) => {
        const text = stringField(digest, 'repository digest', 1024);
        if (!/@sha256:[a-f0-9]{64}$/u.test(text)) throw new DockerEngineError('Docker Engine returned an invalid repository digest.', 'EPROTOCOL');
        return text;
      }),
      created: timestamp(inspected.Created, 'image creation time'),
    };
  }

  async inspectContainer(containerId: string): Promise<EngineContainer | null | undefined> {
    if (!await this.engine.available()) return undefined;
    if (!/^[a-f0-9]{12,64}$/u.test(containerId)) throw new DockerEngineError('Invalid Docker container ID for inspection.', 'EPROTOCOL');
    const response = await this.engine.inspectContainer(containerId);
    if (response === null) return null;
    const inspected = record(response, 'container inspection');
    if (typeof inspected.Id !== 'string' || !/^[a-f0-9]{64}$/u.test(inspected.Id) || !inspected.Id.startsWith(containerId)) {
      throw new DockerEngineError('Docker Engine returned an unexpected container ID.', 'EPROTOCOL');
    }
    const state = record(inspected.State, 'container state');
    const config = record(inspected.Config, 'container configuration');
    const status = stringField(state.Status, 'container status', 32);
    if (!['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(status)) {
      throw new DockerEngineError('Docker Engine returned an invalid container status.', 'EPROTOCOL');
    }
    return {
      id: inspected.Id,
      name: stringField(inspected.Name, 'container name'),
      status,
      running: booleanField(state.Running, 'running state'),
      restarting: booleanField(state.Restarting, 'restarting state'),
      oomKilled: booleanField(state.OOMKilled, 'OOM state'),
      exitCode: integerField(state.ExitCode, 'exit code'),
      restartCount: integerField(inspected.RestartCount, 'restart count'),
      image: stringField(config.Image, 'container image reference'),
      imageId: imageId(inspected.Image),
      startedAt: timestamp(state.StartedAt, 'container start time'),
    };
  }
}
