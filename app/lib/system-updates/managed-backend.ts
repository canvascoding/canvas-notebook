import 'server-only';

import {
  validateSystemUpdateEvent,
  type SystemUpdateEvent,
  type SystemUpdateReleaseChannel,
} from '@/cli/src/core/systemUpdateContract';
import packageJson from '@/package.json';
import { getManagedSystemUpdateOrigin } from '@/app/lib/managed/control-plane-url-policy';

import {
  SystemUpdateBackendError,
  type StartSystemUpdateInput,
  type SystemUpdateAvailability,
  type SystemUpdateBackend,
  type SystemUpdateOperationSnapshot,
  type SystemUpdateOperationView,
  type SystemUpdateStatusAccess,
  validateSystemUpdateOperationView,
} from './types';

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;

function safeErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\0\r\n]+/gu, ' ').trim().slice(0, 2048) || fallback;
}

function parseOperation(value: unknown): SystemUpdateOperationView {
  const operation = validateSystemUpdateOperationView(value);
  if (!operation) throw new SystemUpdateBackendError(502, 'control_plane_protocol_invalid', 'Control Plane update operation is invalid.');
  return operation;
}

function parseEvents(value: unknown, operationId: string): SystemUpdateEvent[] {
  if (!Array.isArray(value)) throw new SystemUpdateBackendError(502, 'control_plane_protocol_invalid', 'Control Plane update events are invalid.');
  return value.map((entry) => {
    const validation = validateSystemUpdateEvent(entry);
    if (!validation.ok || validation.value.operationId !== operationId) {
      throw new SystemUpdateBackendError(502, 'control_plane_protocol_invalid', validation.ok
        ? 'Control Plane update event belongs to another operation.'
        : validation.error);
    }
    return validation.value;
  });
}

function parseAvailability(value: unknown, channel: SystemUpdateReleaseChannel): SystemUpdateAvailability {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SystemUpdateBackendError(502, 'control_plane_protocol_invalid', 'Control Plane availability response is invalid.');
  }
  const candidate = value as Partial<SystemUpdateAvailability>;
  const release = candidate.release;
  const releaseValid = release === null || (
    typeof release === 'object' &&
    typeof release.releaseId === 'string' && /^[0-9a-f-]{36}$/iu.test(release.releaseId) &&
    typeof release.version === 'string' && /^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/u.test(release.version) &&
    typeof release.publishedAt === 'string' && Number.isFinite(Date.parse(release.publishedAt)) &&
    typeof release.backupRequired === 'boolean' &&
    (release.releaseNotesUrl === null || (typeof release.releaseNotesUrl === 'string' && release.releaseNotesUrl.startsWith('https://')))
  );
  if (
    candidate.contractVersion !== 1 || candidate.mode !== 'managed' || candidate.platform !== 'canvas-installer' ||
    candidate.channel !== channel || (candidate.currentVersion !== null && typeof candidate.currentVersion !== 'string') ||
    (candidate.updateAvailable !== null && typeof candidate.updateAvailable !== 'boolean') ||
    typeof candidate.ready !== 'boolean' || !Array.isArray(candidate.reasons) ||
    candidate.reasons.some((reason) => typeof reason !== 'string') || !releaseValid ||
    !Array.isArray(candidate.instructions) || candidate.instructions.some((instruction) => typeof instruction !== 'string')
  ) {
    throw new SystemUpdateBackendError(502, 'control_plane_protocol_invalid', 'Control Plane availability response is invalid.');
  }
  return candidate as SystemUpdateAvailability;
}

export class ManagedSystemUpdateBackend implements SystemUpdateBackend {
  readonly mode = 'managed' as const;
  private readonly baseUrl: string;
  private readonly token: string;

  private readonly configurationError: SystemUpdateBackendError | null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.token = env.CANVAS_INSTANCE_TOKEN?.trim() || '';
    let baseUrl = '';
    let error: SystemUpdateBackendError | null = null;
    try {
      baseUrl = getManagedSystemUpdateOrigin(env);
      if (!this.token) throw new Error('Managed updates require CANVAS_INSTANCE_TOKEN from the Control Plane.');
    } catch (cause) {
      error = new SystemUpdateBackendError(503, 'managed_configuration_invalid', safeErrorMessage(
        cause instanceof Error ? cause.message : null, 'Managed Control Plane configuration is invalid.',
      ));
    }
    this.baseUrl = baseUrl;
    this.configurationError = error;
  }

  private async request(method: 'GET' | 'POST', requestPath: string, body?: unknown): Promise<unknown> {
    if (this.configurationError) throw this.configurationError;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}${requestPath}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_RESPONSE_BYTES) {
        throw new SystemUpdateBackendError(502, 'control_plane_response_too_large', 'Control Plane update response is too large.');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(buffer).toString('utf8')) as unknown;
      } catch {
        throw new SystemUpdateBackendError(502, 'control_plane_protocol_invalid', 'Control Plane returned invalid JSON.');
      }
      if (!response.ok) {
        const error = typeof payload === 'object' && payload !== null ? payload as { error?: unknown; code?: unknown } : null;
        throw new SystemUpdateBackendError(
          response.status,
          typeof error?.code === 'string' ? error.code : 'control_plane_failed',
          safeErrorMessage(error?.error, 'Managed Control Plane update request failed.'),
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof SystemUpdateBackendError) throw error;
      if (controller.signal.aborted) throw new SystemUpdateBackendError(504, 'control_plane_timeout', 'Managed Control Plane update request timed out.');
      throw new SystemUpdateBackendError(503, 'control_plane_unavailable', safeErrorMessage(
        error instanceof Error ? error.message : null,
        'Managed Control Plane update service is unavailable.',
      ));
    } finally {
      clearTimeout(timeout);
    }
  }

  async getAvailability(channel: SystemUpdateReleaseChannel): Promise<SystemUpdateAvailability> {
    if (this.configurationError) return {
      contractVersion: 1, mode: 'managed', platform: 'canvas-installer', channel,
      currentVersion: packageJson.version || null, updateAvailable: null, ready: false,
      reasons: [this.configurationError.code], release: null, instructions: [],
    };
    return parseAvailability(
      await this.request('GET', `/v1/managed/system-updates/availability?channel=${encodeURIComponent(channel)}`),
      channel,
    );
  }

  async startUpdate(input: StartSystemUpdateInput): Promise<SystemUpdateOperationView> {
    if (!input.expectedReleaseId) {
      throw new SystemUpdateBackendError(400, 'request_invalid', 'Expected managed release ID is required.');
    }
    const response = await this.request('POST', '/v1/managed/system-updates', input);
    const operation = typeof response === 'object' && response !== null
      ? (response as { operation?: unknown }).operation
      : null;
    return parseOperation(operation);
  }

  async getOperation(operationId: string): Promise<SystemUpdateOperationView> {
    const response = await this.request('GET', `/v1/managed/system-updates/${encodeURIComponent(operationId)}`);
    const operation = typeof response === 'object' && response !== null
      ? (response as { operation?: unknown }).operation
      : null;
    const parsed = parseOperation(operation);
    if (parsed.operationId !== operationId) {
      throw new SystemUpdateBackendError(502, 'control_plane_protocol_invalid', 'Control Plane returned another update operation.');
    }
    return parsed;
  }

  async getEvents(operationId: string, afterSequence: number): Promise<SystemUpdateOperationSnapshot> {
    const response = await this.request('GET', `/v1/managed/system-updates/${encodeURIComponent(operationId)}/events?after=${afterSequence}`);
    if (typeof response !== 'object' || response === null || Array.isArray(response)) {
      throw new SystemUpdateBackendError(502, 'control_plane_protocol_invalid', 'Control Plane update snapshot is invalid.');
    }
    const candidate = response as { operation?: unknown; events?: unknown };
    const operation = parseOperation(candidate.operation);
    if (operation.operationId !== operationId) {
      throw new SystemUpdateBackendError(502, 'control_plane_protocol_invalid', 'Control Plane returned another update operation.');
    }
    return { operation, events: parseEvents(candidate.events, operationId) };
  }

  async createStatusAccess(operationId: string): Promise<SystemUpdateStatusAccess | null> {
    const response = await this.request('POST', `/v1/managed/system-updates/${encodeURIComponent(operationId)}/status-ticket`);
    const access = response as Partial<SystemUpdateStatusAccess> | null;
    const relativePath = `/v1/managed/system-updates/${encodeURIComponent(operationId)}/status`;
    const expectedPath = `${this.baseUrl}${relativePath}`;
    if (!access || (access.path !== expectedPath && access.path !== relativePath) || access.transport !== 'snapshot' ||
        typeof access.ticket !== 'string' || !access.ticket || access.ticket.length > 8192 || /[\r\n]/u.test(access.ticket) ||
        typeof access.expiresAt !== 'string' || !Number.isFinite(Date.parse(access.expiresAt)) || Date.parse(access.expiresAt) <= Date.now()) {
      throw new SystemUpdateBackendError(502, 'control_plane_protocol_invalid', 'Control Plane status access is invalid.');
    }
    return { path: expectedPath, ticket: access.ticket, expiresAt: access.expiresAt, transport: 'snapshot' };
  }
}
