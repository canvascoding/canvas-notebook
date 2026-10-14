import { StudioServiceError } from './studio-errors';
import { IntegrationServiceError } from './integration-service-error';
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'openai/error';

export interface StudioGenerationFailure {
  code: string;
  message: string;
  details: string;
  retryable: boolean;
  status?: number;
  requestId?: string;
}

function safeDetails(value: string) {
  return value.replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/giu, '[redacted]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [redacted]')
    .slice(0, 500);
}

export class StudioGenerationFailureError extends StudioServiceError {
  constructor(public readonly failure: StudioGenerationFailure) {
    super(failure.details, failure.message, failure.code);
  }
}

export function studioGenerationFailureHttpStatus(failure: StudioGenerationFailure) {
  if (failure.code === 'PROVIDER_TIMEOUT') return 504;
  if (failure.code === 'PROVIDER_RATE_LIMIT') return 429;
  if (failure.code === 'INVALID_IMAGE_OPTIONS' || failure.code === 'INVALID_PROVIDER_REQUEST' || failure.code === 'PROVIDER_MODERATION_BLOCKED') return 400;
  return 502;
}

export function classifyStudioGenerationFailure(error: unknown): StudioGenerationFailure {
  if (error instanceof StudioGenerationFailureError) return error.failure;
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const details = safeDetails(error instanceof Error ? error.message : typeof record.message === 'string' ? record.message : 'Image generation failed');
  const status = typeof record.status === 'number' ? record.status : typeof record.statusCode === 'number' ? record.statusCode : undefined;
  const requestId = typeof record.requestID === 'string' ? record.requestID.slice(0, 100) : undefined;
  const base = { details, ...(status !== undefined ? { status } : {}), ...(requestId ? { requestId } : {}) };
  if (error instanceof StudioServiceError) return { ...base, code: error.code || 'GENERATION_FAILED', message: safeDetails(error.userMessage), retryable: false };
  if (record.code === 'moderation_blocked' || record.code === 'content_policy_violation') {
    return { ...base, code: 'PROVIDER_MODERATION_BLOCKED', message: 'Die Bildanfrage wurde bei der Sicherheitsprüfung des Bildanbieters abgelehnt.', retryable: false };
  }
  if (status === 401 || status === 403 || record.code === 'invalid_api_key' || record.code === 'permission_denied' || /(?:API key is missing|Managed OpenAI image generation is not configured)/u.test(details)) return { ...base, code: 'PROVIDER_AUTH_ERROR', message: 'Der Zugang zum Bildanbieter fehlt oder hat nicht die erforderlichen Rechte. Bitte prüfe die Zugangsdaten unter /settings?tab=secrets.', retryable: false };
  if (status === 429 || record.code === 'rate_limit_exceeded' || record.code === 'insufficient_quota') return { ...base, code: 'PROVIDER_RATE_LIMIT', message: 'Das Limit des Bildanbieters wurde erreicht. Bitte prüfe dein Kontingent oder versuche es später erneut.', retryable: record.code !== 'insufficient_quota' };
  if (status === 408 || status === 504 || error instanceof APIConnectionTimeoutError || error instanceof APIUserAbortError || record.name === 'APIConnectionTimeoutError' || record.name === 'AbortError' || record.code === 'ETIMEDOUT') {
    return { ...base, code: 'PROVIDER_TIMEOUT', message: 'Der Bildanbieter hat nicht rechtzeitig geantwortet. Bitte prüfe den Auftrag, bevor du eine neue Generierung startest.', retryable: false };
  }
  if (error instanceof IntegrationServiceError && status === 502) {
    return { ...base, code: 'MANAGED_MEDIA_FAILED', message: `Der Managed-Bildauftrag ist fehlgeschlagen: ${details}`, retryable: false };
  }
  if ((status !== undefined && status >= 500) || error instanceof APIConnectionError || record.name === 'APIConnectionError' || record.code === 'server_error' || record.code === 'internal_error') {
    return { ...base, code: 'PROVIDER_UNAVAILABLE', message: 'Der Bildanbieter ist vorübergehend nicht erreichbar. Bitte versuche es später erneut.', retryable: true };
  }
  if (status === 400 || record.code === 'unsupported_parameter' || record.code === 'invalid_parameter' || record.code === 'invalid_request_error') return { ...base, code: 'INVALID_PROVIDER_REQUEST', message: 'Der Bildanbieter hat die Anfrage wegen nicht unterstützter oder ungültiger Bildeinstellungen abgelehnt.', retryable: false };
  if (/^(?:No (?:final )?image was returned by OpenAI|No image was returned by managed OpenAI)/u.test(details)) {
    return { ...base, code: 'PROVIDER_EMPTY_RESULT', message: 'Der Bildanbieter hat kein fertiges Bild zurückgegeben.', retryable: false };
  }
  if (/^(?:An edit mask|The edit mask|Reference image|OpenAI supports|Model must|Unsupported OpenAI|Quality must|Output format must|Background must|Moderation must|Input fidelity must|Output compression|Invalid image size|Stream must|Partial images?|Image count)/u.test(details)) {
    return { ...base, code: 'INVALID_IMAGE_OPTIONS', message: `Die Bildeinstellungen sind ungültig: ${details}`, retryable: false };
  }
  return { ...base, code: 'GENERATION_FAILED', message: details, retryable: false };
}
