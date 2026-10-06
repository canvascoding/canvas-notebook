import { createHash } from 'node:crypto';
import { buildEmailClassificationQuestions, EMAIL_CLASSIFICATION_SCHEMA_VERSION } from './schema';
import type { EmailClassificationConfiguration } from './settings-types';

/** AI inputs only: toggles, runtime budgets and display thresholds do not invalidate raw answers. */
export function emailClassificationEvaluationFingerprint(configuration: EmailClassificationConfiguration): string {
  return createHash('sha256').update(JSON.stringify({
    providerId: configuration.providerId, model: configuration.model, endpoint: configuration.endpoint,
    schemaVersion: EMAIL_CLASSIFICATION_SCHEMA_VERSION,
    questions: buildEmailClassificationQuestions(configuration.questionProfile),
    personalPurpose: configuration.questionProfile.personalPurpose, workPurpose: configuration.questionProfile.workPurpose,
  })).digest('hex');
}
