import {
  DEFAULT_EMAIL_CLASSIFICATION_POLICY, EMAIL_CATEGORY_IDS, EMAIL_PRIORITIES,
  type EmailClassification, type EmailClassificationOverride, type EmailClassificationPolicy,
  type EmailClassificationRaw, type EmailDecisionState, type EmailFocusGroup,
  type EmailReplyStatus,
} from './types';

export function validateEmailClassificationPolicy(value: unknown): EmailClassificationPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid email classification policy.');
  const record = value as Record<string, unknown>;
  const probability = (key: string) => {
    const number = record[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1) throw new Error(`Invalid ${key}.`);
    return number;
  };
  const optionalText = (key: string) => typeof record[key] === 'string' && (record[key] as string).trim() ? (record[key] as string).trim().slice(0, 200) : null;
  const policy = {
    choiceMinimumProbability: probability('choiceMinimumProbability'), choiceMinimumMargin: probability('choiceMinimumMargin'),
    spamPositiveThreshold: probability('spamPositiveThreshold'), spamNegativeThreshold: probability('spamNegativeThreshold'),
    replyPositiveThreshold: probability('replyPositiveThreshold'), replyNegativeThreshold: probability('replyNegativeThreshold'),
    spamSortingValidated: record.spamSortingValidated === true,
    calibrationReference: optionalText('calibrationReference'),
    validatedProviderId: optionalText('validatedProviderId'), validatedModel: optionalText('validatedModel'), validatedSchemaVersion: optionalText('validatedSchemaVersion'),
  };
  if (typeof record.spamSortingValidated !== 'boolean') throw new Error('Invalid spam validation state.');
  if (policy.spamNegativeThreshold >= policy.spamPositiveThreshold || policy.replyNegativeThreshold >= policy.replyPositiveThreshold) throw new Error('Decision thresholds overlap.');
  if (policy.spamSortingValidated && (!policy.calibrationReference || !policy.validatedProviderId || !policy.validatedModel || !policy.validatedSchemaVersion)) throw new Error('Spam sorting requires a provider/model/schema evaluation reference.');
  return policy;
}

export function validateEmailClassificationOverride(value: unknown): EmailClassificationOverride {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid email correction.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['category', 'priority', 'isSpam', 'needsReply'].includes(key))) throw new Error('Unknown correction field.');
  const override: EmailClassificationOverride = {};
  if (record.category !== undefined) {
    if (!(EMAIL_CATEGORY_IDS as readonly unknown[]).includes(record.category)) throw new Error('Invalid category.');
    override.category = record.category as EmailClassificationOverride['category'];
  }
  if (record.priority !== undefined) {
    if (!(EMAIL_PRIORITIES as readonly unknown[]).includes(record.priority)) throw new Error('Invalid priority.');
    override.priority = record.priority as EmailClassificationOverride['priority'];
  }
  for (const field of ['isSpam', 'needsReply'] as const) {
    if (record[field] !== undefined) {
      if (typeof record[field] !== 'boolean') throw new Error('Invalid binary correction.');
      override[field] = record[field];
    }
  }
  return override;
}

function choiceState(choice: string, probabilities: Record<string, number> | null, policy: EmailClassificationPolicy): EmailDecisionState {
  if (!probabilities || !Number.isFinite(probabilities[choice])) return 'uncertain';
  const selected = probabilities[choice];
  const alternatives = Object.entries(probabilities).filter(([key]) => key !== choice).map(([, probability]) => probability);
  const next = alternatives.length ? Math.max(...alternatives) : 0;
  return selected >= policy.choiceMinimumProbability && selected - next >= policy.choiceMinimumMargin ? 'ready' : 'uncertain';
}

function binaryDecision(probability: number | null, negative: number, positive: number): boolean | null {
  if (probability === null) return null;
  return probability >= positive ? true : probability <= negative ? false : null;
}

export function emailFocusGroup(classification: Omit<EmailClassification, 'group'>): EmailFocusGroup {
  if (classification.personallyDone) return 'done';
  const { states, priority, isSpam, needsReply } = classification;
  const isImportant = priority === 'high' || priority === 'urgent';
  const usable = [states.priority, states.spam, states.reply].some(state => state === 'ready' || state === 'uncertain');
  if (!usable) return classification.status === 'not_selected' ? 'other' : 'pending';
  if (isImportant && isSpam === true) return 'review';
  if (states.priority === 'uncertain' || states.spam === 'uncertain' || states.reply === 'uncertain') return 'review';
  if (isSpam === true) return 'spam';
  if (isImportant && states.priority === 'ready') return 'important';
  if (needsReply === true && classification.replyStatus !== 'answered') return 'reply';
  if (states.priority !== 'ready' || states.spam !== 'ready' || states.reply !== 'ready') return classification.status === 'not_selected' ? 'other' : 'pending';
  return 'other';
}

export function projectEmailClassification(input: {
  raw: EmailClassificationRaw | null;
  overrides?: EmailClassificationOverride;
  policy?: EmailClassificationPolicy;
  replyStatus?: EmailReplyStatus;
  personallyDone?: boolean;
  version?: number;
  unavailableState?: 'pending' | 'failed' | 'stale' | 'not_selected';
}): EmailClassification {
  const raw = input.unavailableState === 'stale' ? null : input.raw;
  const policy = input.policy ?? DEFAULT_EMAIL_CLASSIFICATION_POLICY;
  const overrides = input.overrides ?? {};
  const missing = input.unavailableState ?? 'pending';
  const states: EmailClassification['states'] = {
    category: raw ? choiceState(raw.category, raw.categoryProbabilities, policy) : missing,
    priority: raw ? choiceState(raw.priority, raw.priorityProbabilities, policy) : missing,
    spam: raw ? 'ready' : missing, reply: raw ? 'ready' : missing,
  };
  let isSpam = binaryDecision(raw?.spamProbability ?? null, policy.spamNegativeThreshold, policy.spamPositiveThreshold);
  let needsReply = binaryDecision(raw?.replyProbability ?? null, policy.replyNegativeThreshold, policy.replyPositiveThreshold);
  if (raw && isSpam === null) states.spam = 'uncertain';
  if (raw && needsReply === null) states.reply = 'uncertain';
  const validatedSpam = raw && policy.spamSortingValidated && policy.calibrationReference
    && policy.validatedProviderId === raw.providerId && policy.validatedModel === raw.model && policy.validatedSchemaVersion === raw.schemaVersion
    && ['model_probability', 'relative_probability'].includes(raw.probabilitySemantics);
  if (isSpam === true && !validatedSpam) { isSpam = null; states.spam = 'uncertain'; }
  if (overrides.category !== undefined) states.category = 'ready';
  if (overrides.priority !== undefined) states.priority = 'ready';
  if (overrides.isSpam !== undefined) { isSpam = overrides.isSpam; states.spam = 'ready'; }
  if (overrides.needsReply !== undefined) { needsReply = overrides.needsReply; states.reply = 'ready'; }
  const status: EmailDecisionState = Object.values(states).every(state => state === 'ready') ? 'ready' : Object.values(states).some(state => state === 'uncertain') ? 'uncertain' : missing;
  const projected: Omit<EmailClassification, 'group'> = {
    category: overrides.category ?? raw?.category ?? null, priority: overrides.priority ?? raw?.priority ?? null,
    spamProbability: raw?.spamProbability ?? null, replyProbability: raw?.replyProbability ?? null,
    isSpam, needsReply, states, status, replyStatus: input.replyStatus ?? 'unknown',
    overrides: { ...overrides }, personallyDone: input.personallyDone ?? false, version: input.version ?? 0,
    evaluatedAt: raw?.evaluatedAt ?? null, bodyWasTruncated: raw?.bodyWasTruncated ?? false,
  };
  return { ...projected, group: emailFocusGroup(projected) };
}

export function emailFocusSortKey(classification: EmailClassification): [number, number, number] {
  const groups: Record<EmailFocusGroup, number> = { important: 0, reply: 1, review: 2, pending: 3, other: 4, spam: 5, done: 6 };
  return [groups[classification.group], classification.priority ? EMAIL_PRIORITIES.length - EMAIL_PRIORITIES.indexOf(classification.priority) : 5, classification.needsReply === true ? 0 : 1];
}
