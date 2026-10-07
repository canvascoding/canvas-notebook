import { createHash } from 'node:crypto';
import { buildEmailClassificationQuestions, EMAIL_CLASSIFICATION_SCHEMA_VERSION } from './schema';
import type { EmailClassificationConfiguration } from './settings-types';

/** AI inputs only: toggles, runtime budgets and display thresholds do not invalidate raw answers. */
export function emailClassificationEvaluationFingerprint(configuration: EmailClassificationConfiguration): string {
  const identity = configuration.executionMode === 'managed' ? configuration.managedModel : null;
  const providerId = identity?.providerId ?? configuration.providerId;
  const model = identity?.model ?? configuration.model;
  const endpoint = identity ? null : configuration.endpoint;
  return createHash('sha256').update(JSON.stringify({
    providerId, model, endpoint,
    ...(identity ? { inferenceRevision: identity.inferenceRevision } : {}),
    schemaVersion: EMAIL_CLASSIFICATION_SCHEMA_VERSION,
    questions: buildEmailClassificationQuestions(configuration.questionProfile),
    personalPurpose: configuration.questionProfile.personalPurpose, workPurpose: configuration.questionProfile.workPurpose,
  })).digest('hex');
}
