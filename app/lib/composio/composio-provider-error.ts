export type ComposioErrorCode =
  | 'COMPOSIO_AUTH_REQUIRED'
  | 'COMPOSIO_CREDENTIALS_OR_SCOPE'
  | 'COMPOSIO_RATE_LIMITED'
  | 'COMPOSIO_TIMEOUT'
  | 'COMPOSIO_UNAVAILABLE'
  | 'COMPOSIO_BAD_RESPONSE'
  | 'COMPOSIO_UPSTREAM_ERROR'
  | 'COMPOSIO_OUTCOME_UNKNOWN';

export type ComposioFailureDetails = {
  code: ComposioErrorCode;
  retryable: boolean;
  outcomeUnknown?: boolean;
  upstreamStatus?: number;
  providerRequestId?: string;
  retryAfterMs?: number;
};

export class ComposioProviderError extends Error implements ComposioFailureDetails {
  code!: ComposioErrorCode;
  retryable!: boolean;
  outcomeUnknown?: boolean;
  upstreamStatus?: number;
  providerRequestId?: string;
  retryAfterMs?: number;

  constructor(message: string, details: ComposioFailureDetails) {
    super(message);
    this.name = 'ComposioProviderError';
    Object.assign(this, details);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function knownCode(value: unknown): ComposioErrorCode | undefined {
  return typeof value === 'string' && [
    'COMPOSIO_AUTH_REQUIRED', 'COMPOSIO_CREDENTIALS_OR_SCOPE', 'COMPOSIO_RATE_LIMITED', 'COMPOSIO_TIMEOUT',
    'COMPOSIO_UNAVAILABLE', 'COMPOSIO_BAD_RESPONSE', 'COMPOSIO_UPSTREAM_ERROR', 'COMPOSIO_OUTCOME_UNKNOWN',
  ].includes(value) ? value as ComposioErrorCode : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function headersFrom(value: unknown): Headers | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if ('get' in value && typeof (value as { get?: unknown }).get === 'function') return value as Headers;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length ? new Headers(entries) : undefined;
}

function errorDetails(error: unknown): { status?: number; headers?: Headers; payload?: unknown; timeout: boolean } {
  const errorRecord = record(error);
  const response = record(errorRecord.response);
  const cause = record(errorRecord.cause);
  const data = errorRecord.data ?? response.data ?? response.body ?? cause.data;
  const status = finiteNumber(errorRecord.status) ?? finiteNumber(errorRecord.statusCode) ?? finiteNumber(response.status) ?? finiteNumber(cause.status);
  const headers = headersFrom(errorRecord.headers) ?? headersFrom(response.headers) ?? headersFrom(cause.headers);
  const name = typeof errorRecord.name === 'string' ? errorRecord.name : '';
  const message = typeof errorRecord.message === 'string' ? errorRecord.message : '';
  const timeout = /abort|timeout|request.?cancelled/i.test(`${name} ${message}`);
  return { status, headers, payload: data, timeout };
}

export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function providerRequestId(headers?: Headers, payload?: unknown): string | undefined {
  const fromHeaders = headers?.get('x-request-id') || headers?.get('x-composio-request-id') || headers?.get('request-id');
  if (fromHeaders) return fromHeaders;
  const body = record(payload);
  const value = body.providerRequestId || body.provider_request_id || body.requestId || body.request_id;
  return typeof value === 'string' && value ? value : undefined;
}

export function safeComposioMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message.slice(0, 300);
  const body = record(value);
  return typeof body.error === 'string' ? body.error.slice(0, 300)
    : typeof body.message === 'string' ? body.message.slice(0, 300)
      : fallback;
}

export function classifyComposioFailure(input: {
  error?: unknown;
  status?: number;
  headers?: Headers;
  payload?: unknown;
  mutation?: boolean;
  timeout?: boolean;
}): ComposioProviderError {
  const details = errorDetails(input.error);
  const headers = input.headers ?? details.headers;
  const payloadValue = input.payload ?? details.payload;
  const retryAfter = retryAfterMs(headers?.get('retry-after'));
  const requestId = providerRequestId(headers, payloadValue);
  const status = input.status ?? details.status;
  const payload = record(payloadValue);
  const timeout = input.timeout || details.timeout;
  const payloadCode = knownCode(payload.code);
  const outcomeUnknown = payload.outcomeUnknown === true || Boolean(input.mutation && timeout);
  let code: ComposioErrorCode = payloadCode || 'COMPOSIO_UNAVAILABLE';
  if (outcomeUnknown) code = 'COMPOSIO_OUTCOME_UNKNOWN';
  else if (timeout) code = 'COMPOSIO_TIMEOUT';
  else if (!payloadCode && status === 401 || !payloadCode && status === 403) code = 'COMPOSIO_CREDENTIALS_OR_SCOPE';
  else if (!payloadCode && status === 409 && payload.auth_required) code = 'COMPOSIO_AUTH_REQUIRED';
  else if (!payloadCode && status === 429) code = 'COMPOSIO_RATE_LIMITED';
  else if (!payloadCode && status && [502, 503, 504].includes(status)) code = 'COMPOSIO_UNAVAILABLE';
  else if (!payloadCode && status && status >= 400) code = 'COMPOSIO_UPSTREAM_ERROR';
  const payloadRetryable = typeof payload.retryable === 'boolean' ? payload.retryable : undefined;
  const payloadRequestId = typeof payload.providerRequestId === 'string' ? payload.providerRequestId : undefined;
  const payloadStatus = finiteNumber(payload.upstreamStatus);
  const payloadRetryAfter = finiteNumber(payload.retryAfterMs);
  return new ComposioProviderError(safeComposioMessage(payloadValue ?? input.error, 'Composio is temporarily unavailable.'), {
    code,
    retryable: outcomeUnknown ? false : payloadRetryable ?? (code === 'COMPOSIO_TIMEOUT' || code === 'COMPOSIO_UNAVAILABLE' || (code === 'COMPOSIO_RATE_LIMITED' && (payloadRetryAfter ?? retryAfter ?? Infinity) <= 3000)),
    ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
    ...(payloadStatus ?? status ? { upstreamStatus: payloadStatus ?? status } : {}),
    ...(payloadRequestId || requestId ? { providerRequestId: payloadRequestId || requestId } : {}),
    ...(payloadRetryAfter ?? retryAfter ? { retryAfterMs: payloadRetryAfter ?? retryAfter } : {}),
  });
}
