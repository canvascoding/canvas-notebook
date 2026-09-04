import 'server-only';

import http from 'node:http';
import path from 'node:path';

import {
  validateSystemUpdateEvent,
  validateSystemUpdateOperation,
  type SystemUpdateEvent,
  type SystemUpdateOperation,
  type SystemUpdateReleaseChannel,
} from '@/cli/src/core/systemUpdateContract';

import {
  SystemUpdateBackendError,
  type StartSystemUpdateInput,
  type SystemUpdateAvailability,
  type SystemUpdateBackend,
  type SystemUpdateOperationSnapshot,
  type SystemUpdateOperationView,
  type SystemUpdateStatusAccess,
  withoutSensitiveOperationFields,
} from './types';

const DEFAULT_SOCKET_PATH = '/run/canvas-notebook-updater.sock';
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;

type UpdaterAvailability = Omit<SystemUpdateAvailability, 'platform' | 'instructions' | 'release'> & {
  mode: 'standalone';
  release: NonNullable<SystemUpdateAvailability['release']>;
};

function safeErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\0\r\n]+/gu, ' ').trim().slice(0, 2048) || fallback;
}

function parseOperation(value: unknown): SystemUpdateOperation {
  const validation = validateSystemUpdateOperation(value);
  if (!validation.ok) throw new SystemUpdateBackendError(502, 'updater_protocol_invalid', validation.error);
  return validation.value;
}

function parseEventList(value: unknown, operationId: string): SystemUpdateEvent[] {
  if (!Array.isArray(value)) throw new SystemUpdateBackendError(502, 'updater_protocol_invalid', 'Updater events must be an array.');
  return value.map((entry) => {
    const validation = validateSystemUpdateEvent(entry);
    if (!validation.ok || validation.value.operationId !== operationId) {
      throw new SystemUpdateBackendError(502, 'updater_protocol_invalid', validation.ok
        ? 'Updater event belongs to another operation.'
        : validation.error);
    }
    return validation.value;
  });
}

function parseAvailability(value: unknown, channel: SystemUpdateReleaseChannel): UpdaterAvailability {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SystemUpdateBackendError(502, 'updater_protocol_invalid', 'Updater availability response is invalid.');
  }
  const candidate = value as Partial<UpdaterAvailability>;
  const release = candidate.release;
  if (
    candidate.contractVersion !== 1 || candidate.mode !== 'standalone' || candidate.channel !== channel ||
    typeof candidate.ready !== 'boolean' || typeof candidate.updateAvailable !== 'boolean' ||
    !Array.isArray(candidate.reasons) || candidate.reasons.some((reason) => typeof reason !== 'string') ||
    typeof release !== 'object' || release === null || typeof release.releaseId !== 'string' ||
    typeof release.version !== 'string' || typeof release.publishedAt !== 'string' ||
    typeof release.backupRequired !== 'boolean' ||
    (release.releaseNotesUrl !== null && typeof release.releaseNotesUrl !== 'string')
  ) {
    throw new SystemUpdateBackendError(502, 'updater_protocol_invalid', 'Updater availability response is invalid.');
  }
  return candidate as UpdaterAvailability;
}

export class StandaloneSystemUpdateBackend implements SystemUpdateBackend {
  readonly mode = 'standalone' as const;
  private readonly socketPath: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.socketPath = String(env.CANVAS_UPDATER_SOCKET_PATH || DEFAULT_SOCKET_PATH).trim();
    if (!path.isAbsolute(this.socketPath)) {
      throw new SystemUpdateBackendError(503, 'updater_unavailable', 'Standalone updater socket path must be absolute.');
    }
  }

  private async request(method: 'GET' | 'POST', requestPath: string, body?: unknown): Promise<unknown> {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath,
        path: requestPath,
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : undefined,
        timeout: REQUEST_TIMEOUT_MS,
      }, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            request.destroy(new SystemUpdateBackendError(502, 'updater_response_too_large', 'Standalone updater response is too large.'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          } catch {
            reject(new SystemUpdateBackendError(502, 'updater_protocol_invalid', 'Standalone updater returned invalid JSON.'));
            return;
          }
          const statusCode = response.statusCode || 500;
          if (statusCode >= 400) {
            const error = typeof parsed === 'object' && parsed !== null
              ? (parsed as { error?: { code?: unknown; message?: unknown } }).error
              : null;
            reject(new SystemUpdateBackendError(
              statusCode,
              typeof error?.code === 'string' ? error.code : 'updater_failed',
              safeErrorMessage(error?.message, 'Standalone updater request failed.'),
            ));
            return;
          }
          resolve(parsed);
        });
      });
      request.on('timeout', () => request.destroy(new SystemUpdateBackendError(504, 'updater_timeout', 'Standalone updater request timed out.')));
      request.on('error', (error: NodeJS.ErrnoException) => {
        if (error instanceof SystemUpdateBackendError) reject(error);
        else reject(new SystemUpdateBackendError(503, 'updater_unavailable', safeErrorMessage(error.message, 'Standalone updater is unavailable.')));
      });
      if (payload) request.write(payload);
      request.end();
    });
  }

  async getAvailability(channel: SystemUpdateReleaseChannel): Promise<SystemUpdateAvailability> {
    const availability = parseAvailability(
      await this.request('GET', `/v1/availability?channel=${encodeURIComponent(channel)}`),
      channel,
    );
    return { ...availability, platform: 'canvas-installer', instructions: [] };
  }

  async startUpdate(input: StartSystemUpdateInput): Promise<SystemUpdateOperationView> {
    const response = await this.request('POST', '/v1/updates', input);
    const operation = typeof response === 'object' && response !== null
      ? (response as { operation?: unknown }).operation
      : null;
    return withoutSensitiveOperationFields(parseOperation(operation));
  }

  async getOperation(operationId: string): Promise<SystemUpdateOperationView> {
    return withoutSensitiveOperationFields(parseOperation(await this.request('GET', `/v1/operations/${encodeURIComponent(operationId)}`)));
  }

  async getEvents(operationId: string, afterSequence: number): Promise<SystemUpdateOperationSnapshot> {
    const response = await this.request('GET', `/v1/operations/${encodeURIComponent(operationId)}/events?after=${afterSequence}`);
    if (typeof response !== 'object' || response === null || Array.isArray(response)) {
      throw new SystemUpdateBackendError(502, 'updater_protocol_invalid', 'Updater operation snapshot is invalid.');
    }
    const candidate = response as { operation?: unknown; events?: unknown };
    const operation = parseOperation(candidate.operation);
    if (operation.operationId !== operationId) {
      throw new SystemUpdateBackendError(502, 'updater_protocol_invalid', 'Updater returned another operation.');
    }
    return {
      operation: withoutSensitiveOperationFields(operation),
      events: parseEventList(candidate.events, operationId),
    };
  }

  async createStatusAccess(operationId: string): Promise<SystemUpdateStatusAccess> {
    const response = await this.request('POST', `/v1/operations/${encodeURIComponent(operationId)}/status-ticket`);
    if (typeof response !== 'object' || response === null || Array.isArray(response)) {
      throw new SystemUpdateBackendError(502, 'updater_protocol_invalid', 'Updater status access response is invalid.');
    }
    const candidate = response as Partial<SystemUpdateStatusAccess>;
    if (
      candidate.path !== `/__canvas-host/operations/${operationId}/events` ||
      typeof candidate.ticket !== 'string' || !/^[A-Za-z0-9_-]{40,1024}\.[A-Za-z0-9_-]{43}$/u.test(candidate.ticket) ||
      typeof candidate.expiresAt !== 'string' || !Number.isFinite(Date.parse(candidate.expiresAt))
    ) {
      throw new SystemUpdateBackendError(502, 'updater_protocol_invalid', 'Updater status access response is invalid.');
    }
    return candidate as SystemUpdateStatusAccess;
  }
}
