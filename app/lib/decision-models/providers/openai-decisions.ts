import { DecisionModelError } from '../errors';
import type { DecisionAnswer, DecisionInput, DecisionProvider, DecisionProviderContext, DecisionProviderResult, DecisionQuestion } from '../types';
import { isDecisionProbability, isDecisionRecord } from '../validation';
import { postDecisionJson } from './http-json';

export const OPENAI_DECISIONS_MODEL = 'gpt-6-luna';

type OpenAIDecisionQuestion = { name: string; instructions: string } & (
  | { type: 'predicate' }
  | { type: 'choice'; choices: { value: string; description: string }[] }
  | { type: 'score'; levels: { label: string; description: string }[] }
);

/** Native Decisions questions, not a generated JSON schema or a Responses request. */
export function toOpenAIDecisionQuestions(questions: Record<string, DecisionQuestion>): OpenAIDecisionQuestion[] {
  return Object.entries(questions).map(([name, question]) => {
    const common = { name, instructions: question.instructions };
    if (question.type === 'choice') return {
      ...common, type: 'choice', choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description })),
    };
    if (question.type === 'ordinal') return {
      ...common, type: 'score', levels: question.criteria.map((description, index) => ({ label: String(index), description })),
    };
    return {
      ...common, type: 'predicate',
      // A predicate has one instruction, so preserve optional caller-supplied true/false criteria there.
      ...(question.criteria ? { instructions: `${question.instructions}\nTrue: ${question.criteria.true}\nFalse: ${question.criteria.false}` } : {}),
    };
  });
}

function invalidResponse(): never {
  throw new DecisionModelError('invalid_response', { providerId: 'openai-decisions' });
}

function distribution(value: unknown, question: Exclude<DecisionQuestion, { type: 'binary' }>): Record<string, number> {
  const expected = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  if (!Array.isArray(value) || value.length !== expected.length) invalidResponse();
  const entries: [string, number][] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isDecisionRecord(entry) || !isDecisionProbability(entry.probability)) invalidResponse();
    if (question.type === 'choice' ? typeof entry.value !== 'string' : !Number.isSafeInteger(entry.value)) invalidResponse();
    const id = String(entry.value);
    if (!expected.includes(id) || seen.has(id)
      || question.type === 'ordinal' && entry.label !== undefined && entry.label !== id) invalidResponse();
    seen.add(id);
    entries.push([id, entry.probability]);
  }
  // The shared validator checks total mass, chosen maximum and weighted ordinal score.
  return Object.fromEntries(entries);
}

function normalizeOpenAIDecisionResult(raw: unknown, input: DecisionInput): DecisionProviderResult {
  if (!isDecisionRecord(raw) || raw.model !== input.configuration.model || !Array.isArray(raw.answers)
    || raw.answers.length !== Object.keys(input.questions).length) invalidResponse();
  const named = new Map<string, Record<string, unknown>>();
  for (const answer of raw.answers) {
    if (!isDecisionRecord(answer) || typeof answer.name !== 'string'
      || !Object.hasOwn(input.questions, answer.name) || named.has(answer.name)) invalidResponse();
    named.set(answer.name, answer);
  }
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(input.questions)) {
    const answer = named.get(id);
    if (!answer) invalidResponse();
    // A refusal never becomes a zero probability or a partial valid classification.
    if (answer.type === 'refusal') throw new DecisionModelError('refused', { providerId: 'openai-decisions' });
    if (question.type === 'binary') {
      if (answer.type !== 'predicate' || !isDecisionProbability(answer.probability)) invalidResponse();
      answers[id] = { type: 'binary', probability: answer.probability };
    } else {
      if (answer.type !== (question.type === 'choice' ? 'choice' : 'score') || !isDecisionProbability(answer.confidence)) invalidResponse();
      const common = { probabilities: distribution(answer.probabilities, question), confidence: answer.confidence };
      if (question.type === 'choice') {
        if (typeof answer.choice !== 'string') invalidResponse();
        answers[id] = { type: 'choice', choice: answer.choice, ...common };
      } else {
        if (typeof answer.score !== 'number') invalidResponse();
        answers[id] = { type: 'ordinal', score: answer.score, ...common };
      }
    }
  }
  if (!isDecisionRecord(raw.usage) || !Number.isSafeInteger(raw.usage.input_tokens) || (raw.usage.input_tokens as number) < 0
    || !Number.isSafeInteger(raw.usage.output_tokens) || (raw.usage.output_tokens as number) < 0) invalidResponse();
  return {
    answers, model: raw.model as string,
    usage: { inputTokens: raw.usage.input_tokens as number, outputTokens: raw.usage.output_tokens as number, requests: 1 },
  };
}

async function evaluateOpenAIDecisions(input: DecisionInput, context: DecisionProviderContext): Promise<DecisionProviderResult> {
  if (input.configuration.model !== OPENAI_DECISIONS_MODEL) throw new DecisionModelError('unsupported_capability', { providerId: 'openai-decisions' });
  const raw = await postDecisionJson(input, context, {
    model: input.configuration.model,
    // All state is evidence in one text input; objects cannot introduce roles, files or external image inputs.
    input: typeof input.state === 'string' ? input.state : JSON.stringify(input.state),
    questions: toOpenAIDecisionQuestions(input.questions),
  }, { requireCredential: true, maxRequestBytes: openAIDecisionsProvider.capabilities.maxRequestBytes });
  return normalizeOpenAIDecisionResult(raw, input);
}

/** Official beta contract: https://developers.openai.com/api/docs/guides/decisions (2026-10-07). */
export const openAIDecisionsProvider: DecisionProvider = {
  id: 'openai-decisions', adapterVersion: 'openai-decisions.v1',
  capabilities: {
    questionTypes: ['choice', 'binary', 'ordinal'], simultaneousQuestions: true,
    choiceProbabilities: 'required', ordinalProbabilities: 'required', binaryProbabilities: true,
    // Conservative harness limits, not claims about the provider's maximum context or API limits.
    maxChoices: 255, maxOrdinalLevels: 10, maxStateBytes: 128 * 1024, maxRequestBytes: 256 * 1024,
    probabilitySemantics: 'model_probability', calibrationReference: 'https://developers.openai.com/api/docs/guides/decisions#interpret-the-answers',
  },
  evaluate: evaluateOpenAIDecisions,
};
