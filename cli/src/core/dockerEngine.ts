import http from 'node:http';

import type { CommandRunner, RuntimeContext, StatusJson } from './types';

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

/** Docker's local transports only; remote/TLS contexts retain CLI compatibility. */
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

/** One command owns one connection choice. Every inspection reads the daemon anew. */
export class DockerEngineReadClient {
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private connection?: Promise<EngineConnection | null>;

  constructor(
    private readonly runner: CommandRunner,
    private readonly context: RuntimeContext,
    options: DockerEngineOptions = {},
  ) {
    this.env = { ...(options.env ?? process.env) };
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DOCKER_READ_TIMEOUT_MS);
    this.maxResponseBytes = Math.max(1, options.maxResponseBytes ?? MAX_DOCKER_RESPONSE_BYTES);
  }

  private getConnection(): Promise<EngineConnection | null> {
    this.connection ??= this.resolveConnection();
    return this.connection;
  }

  private async resolveConnection(): Promise<EngineConnection | null> {
    // This override disables negotiation in Docker itself. Preserve it via the CLI.
    if (this.env.DOCKER_API_VERSION || this.env.DOCKER_TLS || this.env.DOCKER_TLS_VERIFY || this.env.DOCKER_CERT_PATH) return null;
    let endpoint: string;
    if (!this.env.DOCKER_CONTEXT && this.env.DOCKER_HOST) {
      endpoint = this.env.DOCKER_HOST;
    } else {
      try {
        const result = await this.runner.run(this.context.dockerBin, [
          'context', 'inspect',
          ...(this.env.DOCKER_CONTEXT ? [this.env.DOCKER_CONTEXT] : []),
          '--format', '{{json .Endpoints.docker}}',
        ], { cwd: this.context.paths.installDir, env: this.env, stdio: 'pipe', timeoutMs: this.timeoutMs });
        if (result.status !== 0) return null;
        const dockerEndpoint = record(JSON.parse(result.stdout), 'Docker context');
        if (typeof dockerEndpoint.Host !== 'string' || dockerEndpoint.SkipTLSVerify === true) return null;
        endpoint = dockerEndpoint.Host;
      } catch {
        // CLI remains authoritative when context discovery is unavailable.
        return null;
      }
    }
    const socketPath = localDockerSocketPath(endpoint);
    if (!socketPath) return null;
    let version: unknown;
    try {
      version = await this.request(socketPath, '/version');
    } catch (error) {
      if (['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
      throw error;
    }
    const versionRecord = record(version, 'version response');
    const daemonMax = apiVersion(versionRecord.ApiVersion);
    const daemonMin = apiVersion(versionRecord.MinAPIVersion);
    if (daemonMax === null || daemonMin === null || daemonMin > daemonMax) {
      throw new DockerEngineError('Docker Engine returned an invalid API version range.', 'EPROTOCOL');
    }
    const selected = Math.min(daemonMax, apiVersion(MAX_API_VERSION)!);
    if (selected < Math.max(daemonMin, apiVersion(MIN_API_VERSION)!)) return null;
    return { socketPath, apiVersion: `1.${selected}` };
  }

  private request(socketPath: string, requestPath: string, allowNotFound = false): Promise<unknown | null> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve(value);
      };
      const request = http.request({ socketPath, path: requestPath, method: 'GET', headers: { Accept: 'application/json' } });
      const deadline = setTimeout(() => {
        const error = new DockerEngineError(`Docker Engine read exceeded ${this.timeoutMs}ms.`, 'ETIMEDOUT');
        finish(error);
        request.destroy(error);
      }, this.timeoutMs);
      request.on('error', (error) => finish(error));
      request.on('response', (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const declaredBytes = Number(response.headers['content-length']);
        const oversized = () => {
          const error = new DockerEngineError('Docker Engine response exceeded the size limit.', 'ETOOBIG');
          finish(error);
          response.destroy(error);
          request.destroy(error);
        };
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new DockerEngineError('Docker Engine response was interrupted.', 'EPROTOCOL')));
        if (declaredBytes > this.maxResponseBytes) {
          oversized();
          return;
        }
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.maxResponseBytes) oversized();
          else chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          if (response.statusCode === 404 && allowNotFound) {
            finish(undefined, null);
            return;
          }
          if (response.statusCode !== 200) {
            finish(new DockerEngineError(`Docker Engine read failed with HTTP ${response.statusCode ?? 'unknown'}.`, 'EHTTP'));
            return;
          }
          try {
            finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            finish(new DockerEngineError('Docker Engine returned malformed JSON.', 'EPROTOCOL'));
          }
        });
      });
      request.end();
    });
  }

  async inspectImage(imageRef: string): Promise<EngineImage | null | undefined> {
    const connection = await this.getConnection();
    if (!connection) return undefined;
    stringField(imageRef, 'image reference');
    const response = await this.request(connection.socketPath, `/v${connection.apiVersion}/images/${encodeURIComponent(imageRef)}/json`, true);
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
    const connection = await this.getConnection();
    if (!connection) return undefined;
    if (!/^[a-f0-9]{12,64}$/u.test(containerId)) throw new DockerEngineError('Invalid Docker container ID for inspection.', 'EPROTOCOL');
    const response = await this.request(connection.socketPath, `/v${connection.apiVersion}/containers/${encodeURIComponent(containerId)}/json`, true);
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
