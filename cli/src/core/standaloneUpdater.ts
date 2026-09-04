import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import { resolveCliPath } from './cliPath';
import {
  SYSTEM_UPDATE_CONTRACT_VERSION,
  isTerminalSystemUpdateStatus,
  validateSystemUpdateEvent,
  type SystemUpdateEvent,
  type SystemUpdateOperation,
  type SystemUpdateReleaseChannel,
} from './systemUpdateContract';
import { createStandaloneUpdateOperation, StandaloneUpdateJournal } from './standaloneUpdateJournal';
import { compareCanvasVersions, StandaloneReleaseResolver, type VerifiedStandaloneRelease } from './standaloneUpdateRelease';

export const STANDALONE_UPDATER_IDLE_GRACE_MS = 10 * 60 * 1000;
const MAX_REQUEST_BODY_BYTES = 4096;
const MAX_STDERR_BYTES = 64 * 1024;
const UPDATE_DEADLINE_MS = 3 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/u;

interface CurrentCanvasVersion {
  appVersion: string | null;
  cliVersion: string | null;
}

interface StartStandaloneUpdateInput {
  channel: SystemUpdateReleaseChannel;
  expectedReleaseId?: string;
}

interface StandaloneUpdateAvailability {
  contractVersion: typeof SYSTEM_UPDATE_CONTRACT_VERSION;
  mode: 'standalone';
  channel: SystemUpdateReleaseChannel;
  currentVersion: string | null;
  updateAvailable: boolean;
  ready: boolean;
  reasons: string[];
  release: {
    releaseId: string;
    version: string;
    publishedAt: string;
    backupRequired: boolean;
    releaseNotesUrl: string | null;
  };
}

export interface StandaloneUpdaterOptions {
  env?: NodeJS.ProcessEnv;
  journal?: StandaloneUpdateJournal;
  releaseResolver?: StandaloneReleaseResolver;
  currentVersion?: () => Promise<CurrentCanvasVersion>;
  executeUpdate?: (
    operation: SystemUpdateOperation,
    onEvent: (event: SystemUpdateEvent) => Promise<void>,
    release: VerifiedStandaloneRelease,
  ) => Promise<number>;
  prepareHostCli?: (release: VerifiedStandaloneRelease, current: CurrentCanvasVersion) => Promise<void>;
  now?: () => Date;
  onBusyChange?: (busy: boolean) => void;
}

export interface StandaloneUpdaterTriggerResult {
  started: boolean;
  operationId: string | null;
  targetVersion: string | null;
  reason: 'started' | 'up_to_date';
}

class StandaloneUpdaterHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function safeMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message
    .replace(/(?:postgres(?:ql)?:\/\/)[^\s]+/giu, '[redacted-database-url]')
    .replace(/\b(password|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/[\0\r\n]+/gu, ' ')
    .trim()
    .slice(0, 2048) || fallback;
}

function parseChannel(value: unknown): SystemUpdateReleaseChannel {
  if (value === undefined || value === null || value === '') return 'stable';
  if (value !== 'stable' && value !== 'beta') throw new StandaloneUpdaterHttpError(400, 'request_invalid', 'Update channel must be stable or beta.');
  return value;
}

function parseStartInput(value: unknown): StartStandaloneUpdateInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StandaloneUpdaterHttpError(400, 'request_invalid', 'Update request must be a JSON object.');
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(['channel', 'expectedReleaseId']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new StandaloneUpdaterHttpError(400, 'request_invalid', 'Update request contains unsupported fields.');
  }
  const channel = parseChannel(input.channel);
  if (input.expectedReleaseId !== undefined &&
    (typeof input.expectedReleaseId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(input.expectedReleaseId))) {
    throw new StandaloneUpdaterHttpError(400, 'request_invalid', 'Expected release ID is invalid.');
  }
  return { channel, ...(input.expectedReleaseId ? { expectedReleaseId: input.expectedReleaseId } : {}) };
}

function statusForEvent(operation: SystemUpdateOperation, event: SystemUpdateEvent): SystemUpdateOperation['status'] {
  if (event.stage === 'completed') {
    if (event.status === 'succeeded') return 'succeeded';
    if (event.status === 'failed') return operation.rolledBack ? 'rolled_back' : 'failed';
  }
  if (event.stage === 'health_verification' || event.stage === 'version_verification') return 'verifying';
  if (['image_pull', 'container_recreate', 'rollback'].includes(event.stage)) return 'running';
  return 'preflight';
}

async function readCurrentCanvasVersion(env: NodeJS.ProcessEnv): Promise<CurrentCanvasVersion> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCliPath(env), ['version', '--json', '--no-banner'], {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_STDERR_BYTES) return;
      const value = Buffer.from(chunk).subarray(0, MAX_STDERR_BYTES - stdoutBytes);
      stdout.push(value);
      stdoutBytes += value.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const value = Buffer.from(chunk).subarray(0, MAX_STDERR_BYTES - stderrBytes);
      stderr.push(value);
      stderrBytes += value.length;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || 'Canvas CLI version check failed.'));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8')) as { appVersion?: unknown; cliVersion?: unknown };
        resolve({
          appVersion: typeof parsed.appVersion === 'string' && parsed.appVersion ? parsed.appVersion : null,
          cliVersion: typeof parsed.cliVersion === 'string' && parsed.cliVersion ? parsed.cliVersion : null,
        });
      } catch {
        reject(new Error('Canvas CLI returned invalid version information.'));
      }
    });
  });
}

async function executeCliUpdate(
  env: NodeJS.ProcessEnv,
  operation: SystemUpdateOperation,
  onEvent: (event: SystemUpdateEvent) => Promise<void>,
  release: VerifiedStandaloneRelease,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCliPath(env), [
      'update',
      '--image', operation.targetImageRef,
      '--require-pinned',
      ...(release.signed.manifest.backupRequired ? ['--backup-required'] : []),
      '--event-stream',
      '--operation-id', operation.operationId,
      '--no-banner',
    ], {
      env: {
        ...env,
        CANVAS_UPDATE_DEADLINE_EPOCH_MS: String(Date.now() + UPDATE_DEADLINE_MS),
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const value = Buffer.from(chunk).subarray(0, MAX_STDERR_BYTES - stderrBytes);
      stderr.push(value);
      stderrBytes += value.length;
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let processing = Promise.resolve();
    let protocolError: Error | null = null;
    lines.on('line', (line) => {
      if (protocolError) return;
      if (Buffer.byteLength(line, 'utf8') > 16 * 1024) {
        protocolError = new Error('Canvas CLI update event exceeded the size limit.');
        child.kill('SIGTERM');
        return;
      }
      processing = processing.then(async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          throw new Error('Canvas CLI returned a non-JSON update event.');
        }
        const event = validateSystemUpdateEvent(parsed);
        if (!event.ok || event.value.operationId !== operation.operationId) {
          throw new Error(event.ok ? 'Canvas CLI returned an event for another operation.' : event.error);
        }
        await onEvent(event.value);
      }).catch((error) => {
        protocolError = error instanceof Error ? error : new Error('Canvas CLI update event handling failed.');
        child.kill('SIGTERM');
      });
    });
    child.on('error', reject);
    child.on('close', (code) => {
      processing.then(() => {
        if (protocolError) reject(protocolError);
        else if ((code ?? 1) !== 0 && stderrBytes > 0) {
          reject(new Error(safeMessage(Buffer.concat(stderr).toString('utf8'), 'Canvas CLI update failed.')));
        } else resolve(code ?? 1);
      }, reject);
    });
  });
}

async function prepareVerifiedHostCli(
  env: NodeJS.ProcessEnv,
  release: VerifiedStandaloneRelease,
  current: CurrentCanvasVersion,
): Promise<void> {
  if (current.cliVersion && compareCanvasVersions(current.cliVersion, release.signed.manifest.cliVersion) >= 0) return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-updater-cli-'));
  const checksumPath = path.join(directory, 'canvas-notebook-linux-cli.sha256');
  try {
    await fs.writeFile(checksumPath, `${release.cliArtifact.sha256}  canvas-notebook-linux-cli.tar.gz\n`, { mode: 0o600 });
    const result = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = spawn(resolveCliPath(env), ['cli-update', '--json', '--no-banner'], {
        env: {
          ...env,
          CANVAS_CLI_SELF_UPDATE: 'true',
          CANVAS_VERSION: release.signed.manifest.cliVersion,
          CANVAS_LINUX_CLI_URL: release.cliArtifact.url,
          CANVAS_LINUX_CLI_SHA256_URL: pathToFileURL(checksumPath).toString(),
        },
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes >= MAX_STDERR_BYTES) return;
        const value = Buffer.from(chunk).subarray(0, MAX_STDERR_BYTES - stderrBytes);
        stderr.push(value);
        stderrBytes += value.length;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stderr: Buffer.concat(stderr).toString('utf8') }));
    });
    if (result.code !== 0) throw new Error(safeMessage(result.stderr, 'Verified host CLI update failed.'));
    const verified = await readCurrentCanvasVersion(env);
    if (!verified.cliVersion || compareCanvasVersions(verified.cliVersion, release.signed.manifest.cliVersion) < 0) {
      throw new Error('Verified host CLI artifact was not activated.');
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export class StandaloneUpdater {
  private readonly env: NodeJS.ProcessEnv;
  private readonly journal: StandaloneUpdateJournal;
  private readonly releaseResolver: StandaloneReleaseResolver;
  private readonly currentVersion: () => Promise<CurrentCanvasVersion>;
  private readonly executeUpdate: StandaloneUpdaterOptions['executeUpdate'];
  private readonly prepareHostCli: NonNullable<StandaloneUpdaterOptions['prepareHostCli']>;
  private readonly now: () => Date;
  private readonly onBusyChange: (busy: boolean) => void;
  private activeOperationId: string | null = null;
  private reserving = false;

  constructor(options: StandaloneUpdaterOptions = {}) {
    this.env = options.env || process.env;
    this.journal = options.journal || new StandaloneUpdateJournal(
      String(this.env.CANVAS_UPDATER_STATE_DIR || '/var/lib/canvas-notebook-updater'),
    );
    this.releaseResolver = options.releaseResolver || new StandaloneReleaseResolver({ env: this.env });
    this.currentVersion = options.currentVersion || (() => readCurrentCanvasVersion(this.env));
    this.executeUpdate = options.executeUpdate || ((operation, onEvent, release) => executeCliUpdate(this.env, operation, onEvent, release));
    this.prepareHostCli = options.prepareHostCli || ((release, current) => prepareVerifiedHostCli(this.env, release, current));
    this.now = options.now || (() => new Date());
    this.onBusyChange = options.onBusyChange || (() => undefined);
  }

  get busy(): boolean {
    return this.reserving || this.activeOperationId !== null;
  }

  async initialize(): Promise<void> {
    await this.journal.initialize();
    await this.journal.recoverInterruptedOperation(this.now());
    await this.journal.rotate();
  }

  private readiness(release: VerifiedStandaloneRelease, current: CurrentCanvasVersion): { ready: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (!current.appVersion || !VERSION_PATTERN.test(current.appVersion)) reasons.push('current_version_unknown');
    if (!current.cliVersion || !VERSION_PATTERN.test(current.cliVersion)) reasons.push('host_cli_version_unknown');
    if (current.appVersion && VERSION_PATTERN.test(current.appVersion) && release.signed.manifest.minimumVersion &&
      compareCanvasVersions(current.appVersion, release.signed.manifest.minimumVersion) < 0) {
      reasons.push('minimum_version_not_met');
    }
    return { ready: reasons.length === 0, reasons };
  }

  async getAvailability(channel: SystemUpdateReleaseChannel): Promise<StandaloneUpdateAvailability> {
    const [release, current] = await Promise.all([this.releaseResolver.resolve(channel), this.currentVersion()]);
    const readiness = this.readiness(release, current);
    const updateAvailable = current.appVersion && VERSION_PATTERN.test(current.appVersion)
      ? compareCanvasVersions(current.appVersion, release.signed.manifest.version) < 0
      : true;
    return {
      contractVersion: SYSTEM_UPDATE_CONTRACT_VERSION,
      mode: 'standalone',
      channel,
      currentVersion: current.appVersion,
      updateAvailable,
      ...readiness,
      release: {
        releaseId: release.signed.manifest.releaseId,
        version: release.signed.manifest.version,
        publishedAt: release.signed.manifest.publishedAt,
        backupRequired: release.signed.manifest.backupRequired,
        releaseNotesUrl: release.signed.manifest.releaseNotesUrl,
      },
    };
  }

  async startUpdate(input: StartStandaloneUpdateInput): Promise<SystemUpdateOperation> {
    if (this.busy) throw new StandaloneUpdaterHttpError(409, 'operation_conflict', 'Another Canvas update is already running.');
    this.reserving = true;
    this.onBusyChange(true);
    try {
      const currentJournalOperation = await this.journal.readCurrentOperation();
      if (currentJournalOperation && !isTerminalSystemUpdateStatus(currentJournalOperation.status)) {
        throw new StandaloneUpdaterHttpError(409, 'operation_conflict', 'Another Canvas update is already running.');
      }
      const [release, current] = await Promise.all([this.releaseResolver.resolve(input.channel), this.currentVersion()]);
      if (input.expectedReleaseId && input.expectedReleaseId !== release.signed.manifest.releaseId) {
        throw new StandaloneUpdaterHttpError(409, 'release_changed', 'The available release changed; review it before updating.');
      }
      const readiness = this.readiness(release, current);
      if (!readiness.ready) {
        throw new StandaloneUpdaterHttpError(412, 'release_incompatible', `Update preflight failed: ${readiness.reasons.join(', ')}`);
      }
      if (current.appVersion && compareCanvasVersions(current.appVersion, release.signed.manifest.version) >= 0) {
        throw new StandaloneUpdaterHttpError(409, 'no_update_available', 'Canvas Notebook is already up to date.');
      }
      const operation = createStandaloneUpdateOperation({
        operationId: crypto.randomUUID(),
        targetVersion: release.signed.manifest.version,
        targetImageRef: release.signed.manifest.imageRef,
        currentVersion: current.appVersion,
        now: this.now(),
      });
      await this.journal.writeOperation(operation);
      this.activeOperationId = operation.operationId;
      this.reserving = false;
      setImmediate(() => void this.runOperation(operation, release, current));
      return operation;
    } catch (error) {
      this.reserving = false;
      this.onBusyChange(false);
      throw error;
    }
  }

  private async recordEvent(operationId: string, event: SystemUpdateEvent): Promise<void> {
    const operation = await this.journal.readOperation(operationId);
    if (!operation) throw new Error('Active update operation disappeared from the journal.');
    if (event.sequence !== operation.lastSequence + 1) throw new Error('Canvas CLI update event sequence is not contiguous.');
    await this.journal.appendEvent(event);
    const rolledBack = operation.rolledBack || (event.stage === 'rollback' && event.status === 'succeeded');
    const status = statusForEvent({ ...operation, rolledBack }, event);
    const terminal = isTerminalSystemUpdateStatus(status);
    await this.journal.writeOperation({
      ...operation,
      status,
      stage: event.stage,
      startedAt: operation.startedAt || event.occurredAt,
      updatedAt: event.occurredAt,
      completedAt: terminal ? event.occurredAt : null,
      rolledBack,
      errorCode: event.status === 'failed' ? (event.errorCode || 'update_execution_failed') : operation.errorCode,
      error: event.status === 'failed' ? safeMessage(event.message, 'Canvas Notebook update failed.') : operation.error,
      lastSequence: event.sequence,
    });
  }

  private async runOperation(
    initial: SystemUpdateOperation,
    release: VerifiedStandaloneRelease,
    current: CurrentCanvasVersion,
  ): Promise<void> {
    try {
      await this.prepareHostCli(release, current);
      const exitCode = await this.executeUpdate!(initial, (event) => this.recordEvent(initial.operationId, event), release);
      const operation = await this.journal.readOperation(initial.operationId);
      if (operation && !isTerminalSystemUpdateStatus(operation.status)) {
        const completedAt = this.now().toISOString();
        await this.journal.writeOperation({
          ...operation,
          status: exitCode === 0 ? 'indeterminate' : (operation.rolledBack ? 'rolled_back' : 'failed'),
          updatedAt: completedAt,
          completedAt,
          errorCode: exitCode === 0 ? 'operation_interrupted' : (operation.errorCode || 'update_execution_failed'),
          error: operation.error || (exitCode === 0
            ? 'Canvas CLI exited without a final verification event.'
            : 'Canvas CLI update execution failed.'),
        });
      }
    } catch (error) {
      const operation = await this.journal.readOperation(initial.operationId).catch(() => initial) || initial;
      if (!isTerminalSystemUpdateStatus(operation.status)) {
        const completedAt = this.now().toISOString();
        await this.journal.writeOperation({
          ...operation,
          status: operation.rolledBack ? 'rolled_back' : 'failed',
          updatedAt: completedAt,
          completedAt,
          errorCode: operation.errorCode || 'update_execution_failed',
          error: safeMessage(error, 'Canvas CLI update execution failed.'),
        });
      }
    } finally {
      this.activeOperationId = null;
      await this.journal.rotate().catch(() => undefined);
      this.onBusyChange(false);
    }
  }

  async getOperation(operationId: string): Promise<SystemUpdateOperation | null> {
    return this.journal.readOperation(operationId);
  }

  async getEvents(operationId: string, afterSequence: number): Promise<SystemUpdateEvent[]> {
    return this.journal.readEvents(operationId, afterSequence);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new StandaloneUpdaterHttpError(415, 'request_invalid', 'Content-Type must be application/json.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    bytes += value.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) throw new StandaloneUpdaterHttpError(413, 'request_invalid', 'Update request is too large.');
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new StandaloneUpdaterHttpError(400, 'request_invalid', 'Update request is not valid JSON.');
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const content = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': content.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(content);
}

async function handleRequest(updater: StandaloneUpdater, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url || '/', 'http://canvas-updater.local');
    if (request.method === 'GET' && url.pathname === '/v1/health') {
      sendJson(response, 200, { ok: true, contractVersion: SYSTEM_UPDATE_CONTRACT_VERSION, mode: 'standalone' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/availability') {
      const unknownParameters = [...url.searchParams.keys()].filter((key) => key !== 'channel');
      if (unknownParameters.length > 0) throw new StandaloneUpdaterHttpError(400, 'request_invalid', 'Availability request contains unsupported parameters.');
      sendJson(response, 200, await updater.getAvailability(parseChannel(url.searchParams.get('channel'))));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/updates') {
      const operation = await updater.startUpdate(parseStartInput(await readJsonBody(request)));
      sendJson(response, 202, {
        operation,
        statusUrl: `/v1/operations/${operation.operationId}`,
        eventsUrl: `/v1/operations/${operation.operationId}/events`,
      });
      return;
    }
    const match = /^\/v1\/operations\/([0-9a-f-]+)(\/events)?$/iu.exec(url.pathname);
    if (request.method === 'GET' && match) {
      const operationId = match[1];
      if (!UUID_PATTERN.test(operationId)) throw new StandaloneUpdaterHttpError(400, 'request_invalid', 'Update operation ID is invalid.');
      const operation = await updater.getOperation(operationId);
      if (!operation) throw new StandaloneUpdaterHttpError(404, 'operation_not_found', 'Update operation was not found.');
      if (match[2]) {
        const after = Number(url.searchParams.get('after') || 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new StandaloneUpdaterHttpError(400, 'request_invalid', 'Event cursor is invalid.');
        sendJson(response, 200, { operation, events: await updater.getEvents(operationId, after) });
      } else {
        if ([...url.searchParams.keys()].length > 0) throw new StandaloneUpdaterHttpError(400, 'request_invalid', 'Operation request contains unsupported parameters.');
        sendJson(response, 200, operation);
      }
      return;
    }
    sendJson(response, 404, { error: { code: 'not_found', message: 'Updater endpoint was not found.' } });
  } catch (error) {
    const known = error instanceof StandaloneUpdaterHttpError;
    sendJson(response, known ? error.statusCode : 500, {
      error: {
        code: known ? error.code : 'updater_failed',
        message: safeMessage(error, 'Standalone updater request failed.'),
      },
    });
  }
}

export function createStandaloneUpdaterHttpServer(updater: StandaloneUpdater): http.Server {
  const server = http.createServer((request, response) => {
    void handleRequest(updater, request, response);
  });
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}

function inheritedSocketFd(env: NodeJS.ProcessEnv): number | null {
  const explicit = String(env.CANVAS_UPDATER_SOCKET_FD || '').trim();
  if (explicit) {
    const fd = Number(explicit);
    if (!Number.isInteger(fd) || fd < 3 || fd > 1024) throw new Error('CANVAS_UPDATER_SOCKET_FD is invalid.');
    return fd;
  }
  if (Number(env.LISTEN_FDS || 0) < 1) return null;
  const listenPid = Number(env.LISTEN_PID || 0);
  if (listenPid && listenPid !== process.pid) throw new Error('Inherited updater socket belongs to another process.');
  return 3;
}

async function requestLocalUpdater<T>(
  env: NodeJS.ProcessEnv,
  method: 'GET' | 'POST',
  requestPath: string,
  body?: unknown,
): Promise<T> {
  const socketPath = String(env.CANVAS_UPDATER_SOCKET_PATH || '/run/canvas-notebook-updater.sock');
  if (!path.isAbsolute(socketPath)) throw new Error('CANVAS_UPDATER_SOCKET_PATH must be absolute.');
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise<T>((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: requestPath,
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : undefined,
      timeout: 20_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) {
          request.destroy(new Error('Standalone updater response is too large.'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } catch {
          reject(new Error('Standalone updater returned invalid JSON.'));
          return;
        }
        if ((response.statusCode || 500) >= 400) {
          const message = typeof parsed === 'object' && parsed !== null &&
            typeof (parsed as { error?: { message?: unknown } }).error?.message === 'string'
            ? String((parsed as { error: { message: string } }).error.message)
            : `Standalone updater request failed with HTTP ${response.statusCode || 500}.`;
          reject(new Error(safeMessage(message, 'Standalone updater request failed.')));
          return;
        }
        resolve(parsed as T);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Standalone updater request timed out.')));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export async function triggerStandaloneUpdateFromHost(
  channel: SystemUpdateReleaseChannel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StandaloneUpdaterTriggerResult> {
  const availability = await requestLocalUpdater<StandaloneUpdateAvailability>(
    env,
    'GET',
    `/v1/availability?channel=${encodeURIComponent(channel)}`,
  );
  if (!availability.updateAvailable) {
    return { started: false, operationId: null, targetVersion: availability.release.version, reason: 'up_to_date' };
  }
  if (!availability.ready) throw new Error(`Standalone update preflight failed: ${availability.reasons.join(', ')}`);
  const started = await requestLocalUpdater<{ operation: SystemUpdateOperation }>(env, 'POST', '/v1/updates', {
    channel,
    expectedReleaseId: availability.release.releaseId,
  });
  return {
    started: true,
    operationId: started.operation.operationId,
    targetVersion: started.operation.targetVersion,
    reason: 'started',
  };
}

export async function runStandaloneUpdaterFromEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let idleTimer: NodeJS.Timeout | null = null;
  function armIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (updater.busy) {
        armIdleTimer();
        return;
      }
      server.close();
    }, STANDALONE_UPDATER_IDLE_GRACE_MS);
    idleTimer.unref();
  }
  const updater = new StandaloneUpdater({ env, onBusyChange: (busy) => {
    if (!busy) armIdleTimer();
  } });
  await updater.initialize();
  const server = createStandaloneUpdaterHttpServer(updater);
  server.on('request', () => armIdleTimer());
  const fd = inheritedSocketFd(env);
  const socketPath = String(env.CANVAS_UPDATER_SOCKET_PATH || '').trim();
  if (fd === null && !socketPath) throw new Error('Standalone updater requires a systemd socket or CANVAS_UPDATER_SOCKET_PATH.');
  if (socketPath) {
    if (!path.isAbsolute(socketPath)) throw new Error('CANVAS_UPDATER_SOCKET_PATH must be absolute.');
    const existing = await fs.lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && !existing.isSocket()) throw new Error('Refusing to replace a non-socket updater path.');
    if (existing) await fs.rm(socketPath);
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
    if (socketPath) server.listen(socketPath);
    else server.listen({ fd: fd! });
  });
  if (socketPath) await fs.chmod(socketPath, 0o660);
  armIdleTimer();
  await new Promise<void>((resolve, reject) => {
    server.once('close', resolve);
    server.once('error', reject);
  });
  if (idleTimer) clearTimeout(idleTimer);
  if (socketPath) await fs.rm(socketPath, { force: true });
}
