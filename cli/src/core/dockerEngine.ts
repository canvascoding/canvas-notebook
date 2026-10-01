import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { CommandResult, CommandRunner, RunOptions, RuntimeContext } from './types';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
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
  constructor(private readonly runner: CommandRunner, private readonly context: RuntimeContext, private readonly env: NodeJS.ProcessEnv = process.env) {}

  private async resolveConnection(): Promise<{ socketPath: string; version: string } | null> {
    if (this.env.CANVAS_DOCKER_ENGINE_API === 'off' || this.context.dockerBin !== 'docker') return null;
    let host = this.env.DOCKER_CONTEXT ? '' : this.env.DOCKER_HOST || '';
    if (!host) {
      const result = await this.runner.run(this.context.dockerBin, ['context', 'inspect', ...(this.env.DOCKER_CONTEXT ? [this.env.DOCKER_CONTEXT] : []), '--format', '{{json .Endpoints.docker}}'], {
        cwd: this.context.paths.installDir, env: this.env, timeoutMs: 10_000, capture: 'exact', maxOutputBytes: 64 * 1024,
      });
      if (result.status !== 0) return null;
      try { host = String((JSON.parse(result.stdout) as { Host?: string }).Host || ''); } catch { return null; }
    }
    if (!host.startsWith('unix:///')) return null;
    const socketPath = host.slice('unix://'.length);
    const response = await this.request(socketPath, '/version', 'GET', undefined, 10_000);
    if (response.status !== 200) throw new Error(`Docker API version negotiation failed (HTTP ${response.status})`);
    const version = JSON.parse(response.body) as { ApiVersion?: string; MinAPIVersion?: string };
    const numeric = (value: string | undefined) => /^1\.\d+$/u.test(value || '') ? Number(value!.split('.')[1]) : NaN;
    const maximum = Math.min(56, numeric(version.ApiVersion));
    const minimum = Math.max(40, numeric(version.MinAPIVersion || '1.24'));
    const requested = this.env.DOCKER_API_VERSION ? numeric(this.env.DOCKER_API_VERSION) : maximum;
    if (!Number.isInteger(requested) || requested < minimum || requested > maximum) return null;
    return { socketPath, version: `1.${requested}` };
  }

  private connect() {
    return this.connection ??= this.resolveConnection().catch((error: unknown) => {
      this.connection = undefined;
      throw error;
    });
  }
  async available(): Promise<boolean> { return (await this.connect()) !== null; }

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
        res.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) finish(new Error('Docker API response exceeded its limit'));
          else chunks.push(chunk);
        });
        res.on('error', finish);
        res.on('end', () => finish(undefined, { status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('close', () => { if (!res.complete) finish(new Error('Docker API response disconnected')); });
      });
      const timer = setTimeout(() => finish(new Error('Docker API request exceeded its deadline')), Math.max(1, timeoutMs));
      const abort = () => finish(new Error('Docker API request canceled'));
      req.on('error', finish);
      if (signal?.aborted) abort();
      else { signal?.addEventListener('abort', abort, { once: true }); req.end(payload); }
    });
  }

  private async json<T>(route: string, method = 'GET', body?: unknown, timeoutMs = 10_000, missing = false, signal?: AbortSignal): Promise<T | null> {
    const connection = await this.connect();
    if (!connection) throw new Error('Docker Engine API is unavailable for this context');
    const response = await this.request(connection.socketPath, `/v${connection.version}${route}`, method, body, timeoutMs, signal);
    if (missing && response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) throw new Error(`Docker API ${method} ${route} failed (HTTP ${response.status})`);
    return JSON.parse(response.body) as T;
  }

  async ping(): Promise<boolean> {
    const connection = await this.connect();
    if (!connection) return false;
    return (await this.request(connection.socketPath, '/_ping', 'GET', undefined, 10_000)).status === 200;
  }
  async inspectContainer(id: string, timeoutMs = 10_000): Promise<ContainerSnapshot | null> {
    const value = await this.json<ContainerSnapshot>(`/containers/${encodeURIComponent(id)}/json`, 'GET', undefined, timeoutMs, true);
    if (value && (!value.Id || !value.State || !value.Config || typeof value.State.Running !== 'boolean')) throw new Error('Invalid Docker container inspection');
    return value;
  }
  async inspectImage(ref: string): Promise<ImageSnapshot | null> {
    const value = await this.json<ImageSnapshot>(`/images/${encodeURIComponent(ref)}/json`, 'GET', undefined, 10_000, true);
    if (value && (!value.Id || typeof value.Created !== 'string' || (value.RepoDigests && !Array.isArray(value.RepoDigests)))) throw new Error('Invalid Docker image inspection');
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
