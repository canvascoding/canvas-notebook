import { DEFAULT_EMAIL_QUESTION_PROFILE, type EmailQuestionProfile } from './schema';
import { DEFAULT_EMAIL_CLASSIFICATION_POLICY, type EmailClassificationPolicy } from './types';

export interface EmailClassificationConfiguration {
  enabled: boolean;
  executionMode: 'direct' | 'managed';
  managedModelRef: string | null;
  managedModel: { ref: string; providerId: string; model: string; inferenceRevision: string; adapterVersion: string } | null;
  providerId: string;
  model: string;
  endpoint: string | null;
  allowPrivateNetwork: boolean;
  credentialKey: string | null;
  concurrency: number;
  timeoutMs: number;
  maxEmailsPerDay: number;
  initialLookbackDays: number;
  maxHistoricalMessages: number;
  syncIntervalSeconds: number;
  questionProfile: EmailQuestionProfile;
  policy: EmailClassificationPolicy;
}

export interface EmailClassificationSettings {
  revision: number;
  configuration: EmailClassificationConfiguration;
  updatedAt: number | null;
  updatedByUserId: string | null;
}

export const DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION: Readonly<EmailClassificationConfiguration> = {
  executionMode: 'direct', managedModelRef: null, managedModel: null,
  enabled: false, providerId: 'typesafe', model: 'jev-1.13.0', endpoint: null, allowPrivateNetwork: false,
  credentialKey: 'TYPESAFE_API_KEY', concurrency: 2, timeoutMs: 30_000, maxEmailsPerDay: 2_000,
  initialLookbackDays: 30, maxHistoricalMessages: 5_000, syncIntervalSeconds: 60,
  questionProfile: DEFAULT_EMAIL_QUESTION_PROFILE, policy: DEFAULT_EMAIL_CLASSIFICATION_POLICY,
};
