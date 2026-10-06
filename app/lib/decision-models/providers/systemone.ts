import { readBoundedResponseBody } from '../../security/safe-external-fetch';
import { DecisionModelError } from '../errors';
import { normalizeDecisionEndpoint, requestDecisionHttp } from '../http';
import type { DecisionAnswer, DecisionInput, DecisionProvider, DecisionProviderContext, DecisionProviderResult, DecisionQuestion } from '../types';
import { isDecisionRecord } from '../validation';

const MAX_RESPONSE_BYTES = 512 * 1024;

export function toSystemOneQuestions(questions: Record<string, DecisionQuestion>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, {
    type: question.type === 'binary' ? 'noul' : question.type === 'ordinal' ? 'score' : 'choice',
    instructions: question.instructions,
    ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
  }]));
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(duration) && duration >= 0 ? Math.min(Math.ceil(duration), 24 * 60 * 60 * 1000) : undefined;
}

function invalidResponse(providerId: string): never {
  throw new DecisionModelError('invalid_response', { providerId });
}

/** Normalize the official contract; no model label, probability or confidence is invented. */
function normalizeSystemOneResult(raw: unknown, input: DecisionInput, requireFullDistribution: boolean): DecisionProviderResult {
  const providerId = input.configuration.providerId;
  if (!isDecisionRecord(raw) || typeof raw.model !== 'string' || !isDecisionRecord(raw.answers)) invalidResponse(providerId);
  const answers: Record<string, DecisionAnswer> = {};
  const requestedIds = Object.keys(input.questions);
  if (Object.keys(raw.answers).length !== requestedIds.length || Object.keys(raw.answers).some(id => !Object.hasOwn(input.questions, id))) invalidResponse(providerId);
  for (const [id, question] of Object.entries(input.questions)) {
    const answer = raw.answers[id];
    if (!isDecisionRecord(answer)) invalidResponse(providerId);
    if (question.type === 'binary') {
      if (answer.type !== 'noul' || typeof answer.noul !== 'number') invalidResponse(providerId);
      answers[id] = { type: 'binary', probability: answer.noul };
    } else {
      if (answer.type !== (question.type === 'choice' ? 'choice' : 'score')) invalidResponse(providerId);
      if (requireFullDistribution && (answer.probabilities === undefined || answer.confidence === undefined)) invalidResponse(providerId);
      const common = {
        ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities as Record<string, number> }),
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence as number }),
      };
      if (question.type === 'choice') {
        if (typeof answer.choice !== 'string') invalidResponse(providerId);
        answers[id] = { type: 'choice', choice: answer.choice, ...common };
      } else {
        if (typeof answer.score !== 'number') invalidResponse(providerId);
        if (answer.legend !== undefined && (!isDecisionRecord(answer.legend)
          || Object.keys(answer.legend).length !== question.criteria.length
          || question.criteria.some((description, index) => (answer.legend as Record<string, unknown>)[String(index)] !== description))) {
          invalidResponse(providerId);
        }
        if (requireFullDistribution && answer.legend === undefined) invalidResponse(providerId);
        answers[id] = { type: 'ordinal', score: answer.score, ...common };
      }
    }
  }
  if (requireFullDistribution && raw.usage === undefined) invalidResponse(providerId);
  if (raw.usage !== undefined && (!isDecisionRecord(raw.usage)
    || !Number.isSafeInteger(raw.usage.input_tokens) || (raw.usage.input_tokens as number) < 0
    || !Number.isSafeInteger(raw.usage.output_tokens) || (raw.usage.output_tokens as number) < 0)) invalidResponse(providerId);
  return {
    answers,
    model: raw.model,
    ...(raw.usage === undefined ? {} : { usage: {
      inputTokens: (raw.usage as Record<string, number>).input_tokens,
      outputTokens: (raw.usage as Record<string, number>).output_tokens,
      requests: 1,
    } }),
  };
}

export async function evaluateSystemOne(input: DecisionInput, context: DecisionProviderContext, requireFullDistribution: boolean): Promise<DecisionProviderResult> {
  const providerId = input.configuration.providerId;
  const endpoint = normalizeDecisionEndpoint(input.configuration);
  const apiKey = input.credential?.apiKey?.trim();
  if (providerId === 'typesafe' && !apiKey) throw new DecisionModelError('missing_configuration', { providerId });
  const body = JSON.stringify({ state: input.state, model: input.configuration.model, questions: toSystemOneQuestions(input.questions) });
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
    invalidResponse(providerId);
  }
  let raw: unknown;
  try {
    const buffer = await readBoundedResponseBody(response, MAX_RESPONSE_BYTES, context.signal);
    raw = JSON.parse(buffer.toString('utf8'));
  } catch {
    if (context.signal.aborted) context.signal.throwIfAborted();
    invalidResponse(providerId);
  }
  return normalizeSystemOneResult(raw, input, requireFullDistribution);
}

/** TypeSafe-compatible self-hosted servers must declare their own calibration separately. */
export const systemOneDecisionProvider: DecisionProvider = {
  id: 'systemone',
  adapterVersion: 'systemone-http.v1',
  capabilities: {
    questionTypes: ['choice', 'binary', 'ordinal'],
    simultaneousQuestions: true,
    choiceProbabilities: 'optional',
    ordinalProbabilities: 'optional',
    binaryProbabilities: true,
    maxChoices: 255,
    maxOrdinalLevels: 10,
    maxStateBytes: 128 * 1024,
    maxRequestBytes: 256 * 1024,
    probabilitySemantics: 'relative_probability',
  },
  evaluate: (input, context) => evaluateSystemOne(input, context, false),
};
