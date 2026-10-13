import 'server-only';

import { TRANSCRIPTION_API_KEYS } from './config';
import { TranscriptionServiceError } from './errors';

const QUOTA_ERROR_CODES = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded',
]);

/** Interpret compatible providers without exposing their raw responses or credentials. */
export async function readProviderTranscript(response: Response, provider: 'openai' | 'groq'): Promise<string> {
  const result: unknown = await response.json().catch(() => null);
  const body = result && typeof result === 'object' ? result as Record<string, unknown> : null;
  const error = body?.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : null;
  const label = provider === 'openai' ? 'OpenAI' : 'Groq';
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new TranscriptionServiceError(
        `${label} API access was denied (${response.status}). Check ${TRANSCRIPTION_API_KEYS[provider]} in /settings?tab=secrets and access to the selected transcription model.`,
        'TRANSCRIPTION_PROVIDER_ACCESS_DENIED', 502,
      );
    }
    if (response.status === 429) {
      if ((typeof error?.code === 'string' && QUOTA_ERROR_CODES.has(error.code)) || error?.type === 'insufficient_quota') {
        throw new TranscriptionServiceError(
          `${label} API quota is exhausted. Check the API project's billing and usage limits.`,
          'TRANSCRIPTION_QUOTA_EXCEEDED', 429,
        );
      }
      throw new TranscriptionServiceError(`${label} transcription rate limit reached. Try again later.`, 'TRANSCRIPTION_RATE_LIMITED', 429);
    }
    if (response.status === 404 || error?.code === 'model_not_found') {
      throw new TranscriptionServiceError(
        `${label} transcription model is unavailable. Check the selected model in /settings?tab=dictation and the API project's model access.`,
        'TRANSCRIPTION_MODEL_UNAVAILABLE', 502,
      );
    }
    if (response.status === 400 || response.status === 413 || response.status === 415 || response.status === 422) {
      throw new TranscriptionServiceError(
        `${label} rejected the audio recording or transcription settings (${response.status}). Check the recording format and selected model in /settings?tab=dictation.`,
        'TRANSCRIPTION_PROVIDER_REJECTED_AUDIO', 502,
      );
    }
    throw new TranscriptionServiceError(`${label} transcription failed (${response.status}). Try again later.`, 'TRANSCRIPTION_FAILED', 502);
  }
  if (typeof body?.text !== 'string') {
    throw new TranscriptionServiceError(`${label} returned an invalid transcription response. Try again later.`, 'INVALID_TRANSCRIPTION_RESPONSE', 502);
  }
  return body.text;
}
