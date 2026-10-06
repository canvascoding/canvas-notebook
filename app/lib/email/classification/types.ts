export const EMAIL_CATEGORY_IDS = [
  'correspondence', 'finance', 'support', 'sales', 'security',
  'newsletter', 'marketing', 'notification', 'other',
] as const;

export type EmailCategory = typeof EMAIL_CATEGORY_IDS[number];
export const EMAIL_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type EmailPriority = typeof EMAIL_PRIORITIES[number];
export type EmailDecisionState = 'ready' | 'uncertain' | 'pending' | 'failed' | 'stale';
export type EmailReplyStatus = 'answered' | 'unanswered' | 'unknown';
export type EmailFocusGroup = 'important' | 'reply' | 'review' | 'pending' | 'other' | 'spam' | 'done';

export interface EmailClassificationPolicy {
  choiceMinimumProbability: number;
  choiceMinimumMargin: number;
  spamPositiveThreshold: number;
  spamNegativeThreshold: number;
  replyPositiveThreshold: number;
  replyNegativeThreshold: number;
  /** Spam hiding requires a separately evaluated provider/model/schema profile. */
  spamSortingValidated: boolean;
  calibrationReference: string | null;
  validatedProviderId: string | null;
  validatedModel: string | null;
  validatedSchemaVersion: string | null;
}

export interface EmailClassificationRaw {
  category: EmailCategory;
  categoryProbabilities: Record<string, number> | null;
  categoryConfidence: number | null;
  priority: EmailPriority;
  priorityProbabilities: Record<string, number> | null;
  priorityConfidence: number | null;
  spamProbability: number;
  replyProbability: number;
  providerId: string;
  model: string;
  adapterVersion: string;
  schemaVersion: string;
  probabilitySemantics: string;
  calibrationReference: string | null;
  latencyMs: number;
  evaluatedAt: number;
  evaluatedBodyCharacters: number;
  bodyWasTruncated: boolean;
  usage: { inputTokens?: number; outputTokens?: number; requests?: number } | null;
}

export interface EmailClassificationOverride {
  category?: EmailCategory;
  priority?: EmailPriority;
  isSpam?: boolean;
  needsReply?: boolean;
}

/** Compact authorized projection; distributions and provider diagnostics stay in detail. */
export interface EmailClassification {
  category: EmailCategory | null;
  priority: EmailPriority | null;
  spamProbability: number | null;
  replyProbability: number | null;
  isSpam: boolean | null;
  needsReply: boolean | null;
  states: { category: EmailDecisionState; priority: EmailDecisionState; spam: EmailDecisionState; reply: EmailDecisionState };
  status: EmailDecisionState;
  replyStatus: EmailReplyStatus;
  group: EmailFocusGroup;
  overrides: EmailClassificationOverride;
  personallyDone: boolean;
  version: number;
  evaluatedAt: number | null;
  bodyWasTruncated: boolean;
}

export const DEFAULT_EMAIL_CLASSIFICATION_POLICY: Readonly<EmailClassificationPolicy> = {
  choiceMinimumProbability: 0.65,
  choiceMinimumMargin: 0.15,
  spamPositiveThreshold: 0.95,
  spamNegativeThreshold: 0.3,
  replyPositiveThreshold: 0.75,
  replyNegativeThreshold: 0.25,
  spamSortingValidated: false,
  calibrationReference: null,
  validatedProviderId: null,
  validatedModel: null,
  validatedSchemaVersion: null,
};
