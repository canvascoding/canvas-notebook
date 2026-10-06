import type { DecisionResult } from '@/app/lib/decision-models/types';
import { EMAIL_CLASSIFICATION_SCHEMA_VERSION } from './schema';
import { EMAIL_CATEGORY_IDS, EMAIL_PRIORITIES, type EmailCategory, type EmailClassificationRaw, type EmailPriority } from './types';

/** The harness validates transport answers; this binds them to the email schema. */
export function normalizeEmailClassificationResult(result: DecisionResult, context: {
  evaluatedBodyCharacters: number; bodyWasTruncated: boolean; evaluatedAt?: number;
}): EmailClassificationRaw {
  const { category, priority, is_spam: spam, needs_reply: reply } = result.answers;
  if (category?.type !== 'choice' || !(EMAIL_CATEGORY_IDS as readonly string[]).includes(category.choice)) throw new Error('Missing valid email category.');
  if (priority?.type !== 'choice' || !(EMAIL_PRIORITIES as readonly string[]).includes(priority.choice)) throw new Error('Missing valid email priority.');
  if (spam?.type !== 'binary' || reply?.type !== 'binary') throw new Error('Missing email binary assessments.');
  for (const value of [spam.probability, reply.probability]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid email probability.');
  }
  return {
    category: category.choice as EmailCategory, categoryProbabilities: category.probabilities ?? null, categoryConfidence: category.confidence ?? null,
    priority: priority.choice as EmailPriority, priorityProbabilities: priority.probabilities ?? null, priorityConfidence: priority.confidence ?? null,
    spamProbability: spam.probability, replyProbability: reply.probability,
    providerId: result.providerId, model: result.model, adapterVersion: result.adapterVersion,
    schemaVersion: EMAIL_CLASSIFICATION_SCHEMA_VERSION, probabilitySemantics: result.probabilitySemantics,
    calibrationReference: result.calibrationReference ?? null, latencyMs: result.latencyMs,
    evaluatedAt: context.evaluatedAt ?? Date.now(), evaluatedBodyCharacters: context.evaluatedBodyCharacters,
    bodyWasTruncated: context.bodyWasTruncated, usage: result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, requests: result.usage.requests } : null,
  };
}
