import { decisionProviderRegistry } from '@/app/lib/decision-models/registry';
import { normalizeDecisionEndpoint } from '@/app/lib/decision-models/http';
import { OPENAI_DECISIONS_MODEL } from '@/app/lib/decision-models/providers/openai-decisions';
import { validateEmailClassificationPolicy } from './policy';
import { validateEmailQuestionProfile } from './schema';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, type EmailClassificationConfiguration } from './settings-types';
import { MAX_EMAIL_CLASSIFICATION_LOOKBACK_DAYS } from './selection';

export function validateEmailClassificationConfiguration(value: unknown): EmailClassificationConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid email classification configuration.');
  const record = value as Record<string, unknown>;
  const allowed = Object.keys(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION);
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new Error('Unknown classification setting.');
  if (typeof record.enabled !== 'boolean' || typeof record.allowPrivateNetwork !== 'boolean') throw new Error('Invalid activation or endpoint policy.');
  if (typeof record.providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(record.providerId)) throw new Error('Invalid decision provider.');
  const provider = decisionProviderRegistry.get(record.providerId);
  if (!provider || !provider.capabilities.questionTypes.includes('choice') || !provider.capabilities.binaryProbabilities) throw new Error('The decision provider does not support email classification.');
  if (typeof record.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,199}$/u.test(record.model)) throw new Error('Invalid model reference.');
  if (record.providerId === 'openai-decisions' && record.model !== OPENAI_DECISIONS_MODEL) throw new Error('The Decisions provider does not support this model.');
  const endpoint = record.endpoint === null ? null : typeof record.endpoint === 'string' && record.endpoint.trim().length <= 2_048 ? record.endpoint.trim() : undefined;
  if (endpoint === undefined) throw new Error('Invalid provider endpoint.');
  const credentialKey = record.credentialKey === null ? null : typeof record.credentialKey === 'string' && /^[A-Z][A-Z0-9_]{2,127}$/u.test(record.credentialKey) ? record.credentialKey : undefined;
  const fixedProvider = record.providerId === 'typesafe' || record.providerId === 'openai-decisions';
  if (credentialKey === undefined || fixedProvider && !credentialKey) throw new Error('Select a system credential key.');
  // URL policy is checked here; DNS/private-network policy is checked again by the transport.
  const normalizedEndpoint = normalizeDecisionEndpoint({ providerId: record.providerId, model: record.model, endpoint: endpoint ?? undefined, allowPrivateNetwork: record.allowPrivateNetwork });
  const integer = (key: string, minimum: number, maximum: number) => {
    const number = record[key];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error(`Invalid ${key}.`);
    return number;
  };
  return {
    enabled: record.enabled, providerId: record.providerId, model: record.model,
    endpoint: fixedProvider ? null : normalizedEndpoint.toString(),
    allowPrivateNetwork: fixedProvider ? false : record.allowPrivateNetwork,
    credentialKey, concurrency: integer('concurrency', 1, 8), timeoutMs: integer('timeoutMs', 1_000, 120_000),
    maxEmailsPerDay: integer('maxEmailsPerDay', 1, 100_000), initialLookbackDays: integer('initialLookbackDays', 1, MAX_EMAIL_CLASSIFICATION_LOOKBACK_DAYS),
    maxHistoricalMessages: integer('maxHistoricalMessages', 1, 100_000), syncIntervalSeconds: integer('syncIntervalSeconds', 15, 3_600),
    questionProfile: validateEmailQuestionProfile(record.questionProfile), policy: validateEmailClassificationPolicy(record.policy),
  };
}

/** Reusing a validation reference after changing its actual evaluation inputs is unsafe. */
export function resetChangedEmailSpamValidation(previous: EmailClassificationConfiguration, next: EmailClassificationConfiguration): EmailClassificationConfiguration {
  const evaluationInputs = (configuration: EmailClassificationConfiguration) => JSON.stringify({
    providerId: configuration.providerId, model: configuration.model, endpoint: configuration.endpoint,
    questionProfile: configuration.questionProfile,
    thresholds: { choiceMinimumProbability: configuration.policy.choiceMinimumProbability, choiceMinimumMargin: configuration.policy.choiceMinimumMargin,
      spamPositiveThreshold: configuration.policy.spamPositiveThreshold, spamNegativeThreshold: configuration.policy.spamNegativeThreshold,
      replyPositiveThreshold: configuration.policy.replyPositiveThreshold, replyNegativeThreshold: configuration.policy.replyNegativeThreshold },
  });
  if (evaluationInputs(previous) === evaluationInputs(next)) return next;
  return { ...next, policy: { ...next.policy, spamSortingValidated: false, calibrationReference: null, validatedProviderId: null, validatedModel: null, validatedSchemaVersion: null } };
}
