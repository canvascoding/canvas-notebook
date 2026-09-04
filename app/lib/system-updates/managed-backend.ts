import 'server-only';

import {
  validateSystemUpdateEvent,
  type SystemUpdateEvent,
  type SystemUpdateReleaseChannel,
} from '@/cli/src/core/systemUpdateContract';
import { getManagedControlPlaneBaseUrl } from '@/app/lib/managed/control-plane-url';

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

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const configuredUrl = getManagedControlPlaneBaseUrl();
    const token = env.CANVAS_INSTANCE_TOKEN?.trim();
    if (!configuredUrl || !token) {
      throw new SystemUpdateBackendError(503, 'control_plane_unavailable', 'Managed Control Plane update service is not configured.');
    }
    let parsed: URL;
    try {
      parsed = new URL(configuredUrl);
    } catch {
      throw new SystemUpdateBackendError(503, 'control_plane_unavailable', 'Managed Control Plane URL is invalid.');
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname))) {
      throw new SystemUpdateBackendError(503, 'control_plane_unavailable', 'Managed Control Plane URL must use HTTPS.');
    }
    this.baseUrl = configuredUrl.replace(/\/+$/u, '');
    this.token = token;
  }

  private async request(method: 'GET' | 'POST', requestPath: string, body?: unknown): Promise<unknown> {
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
    return parseAvailability(
      await this.request('GET', `/v1/managed-system-updates/availability?channel=${encodeURIComponent(channel)}`),
      channel,
    );
  }

  async startUpdate(input: StartSystemUpdateInput): Promise<SystemUpdateOperationView> {
    if (!input.expectedReleaseId) {
      throw new SystemUpdateBackendError(400, 'request_invalid', 'Expected managed release ID is required.');
    }
    const response = await this.request('POST', '/v1/managed-system-updates', input);
    const operation = typeof response === 'object' && response !== null
      ? (response as { operation?: unknown }).operation
      : null;
    return parseOperation(operation);
  }

  async getOperation(operationId: string): Promise<SystemUpdateOperationView> {
    const response = await this.request('GET', `/v1/managed-system-updates/${encodeURIComponent(operationId)}`);
    const operation = typeof response === 'object' && response !== null
      ? (response as { operation?: unknown }).operation
      : null;
    return parseOperation(operation);
  }

  async getEvents(operationId: string, afterSequence: number): Promise<SystemUpdateOperationSnapshot> {
    const response = await this.request('GET', `/v1/managed-system-updates/${encodeURIComponent(operationId)}/events?after=${afterSequence}`);
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

  async createStatusAccess(_operationId: string): Promise<SystemUpdateStatusAccess | null> {
    return null;
  }
}
