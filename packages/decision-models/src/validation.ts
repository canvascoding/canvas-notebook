import { DecisionModelError } from './errors.js';
import type { DecisionInput, DecisionProvider, DecisionProviderResult, DecisionQuestion } from './types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/u;
const MAX_QUESTIONS = 64;
const MAX_INSTRUCTION_BYTES = 32_768;
const DISTRIBUTION_TOLERANCE = 0.0001;

export function isDecisionRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidRequest(): never {
  throw new DecisionModelError('invalid_request');
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= MAX_INSTRUCTION_BYTES;
}

function validId(value: string): boolean {
  return ID_PATTERN.test(value) && value !== '__proto__' && value !== 'constructor' && value !== 'prototype';
}

function assertQuestion(question: unknown, provider: DecisionProvider): asserts question is DecisionQuestion {
  if (!isDecisionRecord(question) || !validText(question.instructions)) invalidRequest();
  if (question.type !== 'choice' && question.type !== 'binary' && question.type !== 'ordinal') invalidRequest();
  if (!provider.capabilities.questionTypes.includes(question.type)) {
    throw new DecisionModelError('unsupported_capability', { providerId: provider.id });
  }
  if (question.type === 'choice') {
    if (!isDecisionRecord(question.criteria)) invalidRequest();
    const options = Object.entries(question.criteria);
    if (options.length < 2 || options.length > provider.capabilities.maxChoices
      || options.some(([id, description]) => !validId(id) || !validText(description))) invalidRequest();
  } else if (question.type === 'ordinal') {
    if (!Array.isArray(question.criteria) || question.criteria.length < 2
      || question.criteria.length > provider.capabilities.maxOrdinalLevels
      || !question.criteria.every(validText)) invalidRequest();
  } else {
    if (!provider.capabilities.binaryProbabilities) {
      throw new DecisionModelError('unsupported_capability', { providerId: provider.id });
    }
    if (question.criteria !== undefined && (!isDecisionRecord(question.criteria)
      || Object.keys(question.criteria).length !== 2
      || !validText(question.criteria.true) || !validText(question.criteria.false))) invalidRequest();
  }
}

/** Reject implicit JSON coercion (functions, dates, NaN, cycles), including deeply nested data. */
function assertJsonState(state: unknown): void {
  const ancestors = new Set<object>();
  let values = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++values > 20_000 || depth > 24) invalidRequest();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!Array.isArray(value) && !isDecisionRecord(value)) invalidRequest();
    if (ancestors.has(value)) invalidRequest();
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else {
      for (const [key, item] of Object.entries(value)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') invalidRequest();
        visit(item, depth + 1);
      }
    }
    ancestors.delete(value);
  };
  if (typeof state !== 'string' && !Array.isArray(state) && !isDecisionRecord(state)) invalidRequest();
  visit(state, 0);
}

export function validateDecisionInput(input: DecisionInput, provider: DecisionProvider): void {
  if (!isDecisionRecord(input) || !isDecisionRecord(input.configuration)
    || !validId(input.configuration.providerId) || !MODEL_PATTERN.test(input.configuration.model)
    || typeof input.schemaVersion !== 'string' || !validId(input.schemaVersion)
    || !isDecisionRecord(input.questions)) invalidRequest();
  if (input.configuration.endpoint !== undefined
    && (typeof input.configuration.endpoint !== 'string' || input.configuration.endpoint.length > 2048)) invalidRequest();
  if (input.configuration.allowPrivateNetwork !== undefined && typeof input.configuration.allowPrivateNetwork !== 'boolean') invalidRequest();
  if (input.credential !== undefined && (!isDecisionRecord(input.credential)
    || (input.credential.apiKey !== undefined && (typeof input.credential.apiKey !== 'string'
      || input.credential.apiKey.length > 8192 || /[\r\n]/u.test(input.credential.apiKey))))) invalidRequest();
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000)) invalidRequest();
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) invalidRequest();
  const questions = Object.entries(input.questions);
  if (questions.length === 0 || questions.length > MAX_QUESTIONS) invalidRequest();
  if (questions.length > 1 && !provider.capabilities.simultaneousQuestions) {
    throw new DecisionModelError('unsupported_capability', { providerId: provider.id });
  }
  for (const [id, question] of questions) {
    if (!validId(id)) invalidRequest();
    assertQuestion(question, provider);
  }
  assertJsonState(input.state);
  if (Buffer.byteLength(JSON.stringify(input.state)) > provider.capabilities.maxStateBytes
    || Buffer.byteLength(JSON.stringify({ state: input.state, model: input.configuration.model, questions: input.questions }))
      > provider.capabilities.maxRequestBytes) invalidRequest();
}

function invalidResponse(provider: DecisionProvider): never {
  throw new DecisionModelError('invalid_response', { providerId: provider.id });
}

export function isDecisionProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function assertDistribution(value: unknown, expectedIds: string[], provider: DecisionProvider): asserts value is Record<string, number> {
  if (!isDecisionRecord(value)) invalidResponse(provider);
  const entries = Object.entries(value);
  if (entries.length !== expectedIds.length || entries.some(([id, probability]) => !expectedIds.includes(id) || !isDecisionProbability(probability))) {
    invalidResponse(provider);
  }
  if (Math.abs(entries.reduce((sum, [, probability]) => sum + (probability as number), 0) - 1) > DISTRIBUTION_TOLERANCE) {
    invalidResponse(provider);
  }
}

/** Validate every requested answer before any caller receives a partial result. */
export function validateDecisionResult(result: DecisionProviderResult, input: DecisionInput, provider: DecisionProvider): void {
  if (!isDecisionRecord(result) || typeof result.model !== 'string' || !MODEL_PATTERN.test(result.model)
    || !isDecisionRecord(result.answers)) invalidResponse(provider);
  const ids = Object.keys(input.questions);
  if (Object.keys(result.answers).length !== ids.length
    || Object.keys(result.answers).some(id => !Object.hasOwn(input.questions, id))) invalidResponse(provider);
  for (const [id, question] of Object.entries(input.questions)) {
    const answer: unknown = result.answers[id];
    if (!isDecisionRecord(answer) || answer.type !== question.type) invalidResponse(provider);
    if (question.type === 'binary') {
      if (!isDecisionProbability(answer.probability)) invalidResponse(provider);
      continue;
    }
    if (answer.confidence !== undefined && !isDecisionProbability(answer.confidence)) invalidResponse(provider);
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria);
      if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)) invalidResponse(provider);
      if (answer.probabilities !== undefined) {
        assertDistribution(answer.probabilities, options, provider);
        const maximum = Math.max(...Object.values(answer.probabilities));
        if (maximum - answer.probabilities[answer.choice] > DISTRIBUTION_TOLERANCE) invalidResponse(provider);
      } else if (provider.capabilities.choiceProbabilities === 'required') invalidResponse(provider);
    } else {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)
        || answer.score < 0 || answer.score > question.criteria.length - 1) invalidResponse(provider);
      if (answer.probabilities !== undefined) {
        assertDistribution(answer.probabilities, question.criteria.map((_, index) => String(index)), provider);
        const expectedScore = Object.entries(answer.probabilities).reduce((sum, [level, probability]) => sum + Number(level) * probability, 0);
        if (Math.abs(expectedScore - answer.score) > 0.001) invalidResponse(provider);
      } else if (provider.capabilities.ordinalProbabilities === 'required') invalidResponse(provider);
    }
  }
  if (result.usage !== undefined && (!isDecisionRecord(result.usage)
    || !Number.isSafeInteger(result.usage.requests) || result.usage.requests < 1
    || (result.usage.inputTokens !== undefined && (!Number.isSafeInteger(result.usage.inputTokens) || result.usage.inputTokens < 0))
    || (result.usage.outputTokens !== undefined && (!Number.isSafeInteger(result.usage.outputTokens) || result.usage.outputTokens < 0)))) {
    invalidResponse(provider);
  }
}
