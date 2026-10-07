import { readBoundedResponseBody } from '../../security/safe-external-fetch';
import { DecisionModelError } from '../errors';
import { normalizeDecisionEndpoint, requestDecisionHttp } from '../http';
import type { DecisionInput, DecisionProviderContext } from '../types';

const MAX_RESPONSE_BYTES = 512 * 1024;

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(duration) && duration >= 0 ? Math.min(Math.ceil(duration), 24 * 60 * 60 * 1000) : undefined;
}

/** Shared bounded transport; response text and credentials never enter a public error. */
export async function postDecisionJson(input: DecisionInput, context: DecisionProviderContext, payload: Record<string, unknown>, options: {
  requireCredential: boolean; maxRequestBytes: number;
}): Promise<unknown> {
  const providerId = input.configuration.providerId;
  const endpoint = normalizeDecisionEndpoint(input.configuration);
  const apiKey = input.credential?.apiKey?.trim();
  if (options.requireCredential && !apiKey) throw new DecisionModelError('missing_configuration', { providerId });
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > options.maxRequestBytes) throw new DecisionModelError('invalid_request', { providerId });
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = context.fetch
    ? await context.fetch(endpoint, { method: 'POST', headers, body, signal: context.signal, redirect: 'manual', credentials: 'omit' })
    : await requestDecisionHttp(endpoint, input.configuration, { body, headers, signal: context.signal, timeoutMs: context.timeoutMs });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) throw new DecisionModelError('authentication_failed', { providerId, httpStatus: response.status });
    if (response.status === 429 || response.status === 529) throw new DecisionModelError('rate_limited', {
      providerId, httpStatus: response.status, retryAfterMs: retryAfterMs(response), retryable: true,
    });
    throw new DecisionModelError('provider_error', { providerId, httpStatus: response.status, retryable: response.status >= 500 });
  }
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new DecisionModelError('invalid_response', { providerId });
  }
  try {
    const buffer = await readBoundedResponseBody(response, MAX_RESPONSE_BYTES, context.signal);
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    if (context.signal.aborted) context.signal.throwIfAborted();
    throw new DecisionModelError('invalid_response', { providerId });
  }
}
