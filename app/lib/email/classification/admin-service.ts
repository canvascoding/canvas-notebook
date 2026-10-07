import 'server-only';

import { DecisionModelError } from '@/app/lib/decision-models/errors';
import type { DecisionInput, DecisionResult } from '@/app/lib/decision-models/types';
import type { EmailClassificationCredentialResolution, EmailClassificationCredentialStatus, EmailClassificationSecretReader } from './credential-service';
import { resolveEmailClassificationExecution, executeEmailClassification, managedEmailConfiguration, reconcileEmailClassificationExecution, type EmailClassificationExecutionDependencies, type EmailClassificationExecution } from './execution-service';
import { ManagedDecisionClientError, readManagedDecisionModels, type ManagedDecisionCatalogResolution } from '@/app/lib/managed/decision-client';
import { normalizeEmailClassificationResult } from './normalize';
import { projectEmailClassification } from './policy';
import { buildEmailClassificationQuestions, buildEmailDecisionState, EMAIL_CLASSIFICATION_SCHEMA_VERSION } from './schema';
import { emailClassificationEvaluationFingerprint } from './settings-evaluation';
import { emailClassificationSelectionSql } from './selection';
import { notifyEmailClassificationSettingsChanged } from './runtime-control';
import type { EmailClassificationConfiguration, EmailClassificationSettings } from './settings-types';
import { validateEmailClassificationConfiguration } from './settings-validation';
import { getRuntimeEmailClassificationStore, type PostgresEmailClassificationStore } from './store';
import { EmailClassificationVersionConflictError, type EmailClassificationQueryable } from './store-types';
import type { EmailClassification, EmailClassificationRaw } from './types';

const DAY_MS = 86_400_000;
const SECRETS_LINK = '/settings?tab=secrets' as const;

export type EmailClassificationAvailabilityReason = 'disabled' | 'missing_configuration' | 'configuration_unavailable' | 'budget_exhausted' | 'provider_unavailable' | null;

/** Display mode follows activation; processing readiness may degrade without hiding cached ratings. */
export interface EmailClassificationAvailability {
  enabled: boolean;
  available: boolean;
  revision: number;
  defaultMode: 'focus' | 'classic';
  reason: EmailClassificationAvailabilityReason;
}

export interface EmailClassificationProviderOption {
  id: string;
  label: string;
  requiresEndpoint: boolean;
  defaultModel: string;
  credentialKeyDefault: string | null;
}

export interface EmailClassificationRuntimeHealth {
  state: 'idle' | 'processing' | 'paused' | 'unavailable';
  counts: { indexed: number; analyzed: number; pending: number; processing: number; failed: number } | null;
  mailboxes: { active: number; pending: number; partial: number; complete: number; failed: number; lastSyncAt: number | null } | null;
  budget: { dayStart: number; resetsAt: number; limit: number; used: number | null; remaining: number | null };
  usage: { reportedInputTokens: number | null; reportedOutputTokens: number | null; samples: number } | null;
  averageLatencyMs: number | null;
  lastCompletedAt: number | null;
}

export interface EmailClassificationAdminSettings {
  execution: { mode: 'direct' | 'managed'; reason: string | null; managed: ManagedDecisionCatalogResolution | null };
  settings: EmailClassificationSettings;
  availability: EmailClassificationAvailability;
  credentials: EmailClassificationCredentialStatus;
  health: EmailClassificationRuntimeHealth;
  providerOptions: EmailClassificationProviderOption[];
}

export type EmailClassificationAdminStore = Pick<PostgresEmailClassificationStore, 'readSettings' | 'updateSettings'>;

export interface EmailClassificationAdminServiceDependencies extends EmailClassificationExecutionDependencies {
  store?: EmailClassificationAdminStore;
  postgres?: EmailClassificationQueryable;
  readSecret?: EmailClassificationSecretReader;
  evaluate?: (input: DecisionInput) => Promise<DecisionResult>;
  now?: () => number;
}

export class EmailClassificationAdminServiceError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly settingsLink?: string) {
    super(message);
    this.name = 'EmailClassificationAdminServiceError';
  }
}

export function emailClassificationAdminErrorDetails(error: unknown): { code: string; status: number; message: string; settingsLink?: string } {
  if (error instanceof ManagedDecisionClientError) return { code: `EMAIL_CLASSIFICATION_MANAGED_${error.managedCode.toUpperCase()}`, status: error.managedCode === 'budget_exhausted' || error.managedCode === 'entitlement_denied' ? 402 : error.httpStatus === 409 ? 409 : 503, message: error.message };
  if (error instanceof EmailClassificationAdminServiceError) {
    return { code: error.code, status: error.status, message: error.message, ...(error.settingsLink ? { settingsLink: error.settingsLink } : {}) };
  }
  if (error instanceof EmailClassificationVersionConflictError) {
    return { code: error.code, status: 409, message: 'Email classification settings changed. Reload before saving.' };
  }
  if (error instanceof DecisionModelError) {
    const status = error.code === 'timeout' ? 504 : error.code === 'rate_limited' ? 429 : error.code === 'aborted' ? 409 : 502;
    return { code: `EMAIL_CLASSIFICATION_${error.code.toUpperCase()}`, status, message: error.message };
  }
  return { code: 'EMAIL_CLASSIFICATION_UNAVAILABLE', status: 503, message: 'Email classification is temporarily unavailable.' };
}

function invalidConfiguration(): never {
  throw new EmailClassificationAdminServiceError('EMAIL_CLASSIFICATION_INVALID_CONFIGURATION', 400, 'Enter a valid email classification configuration.');
}

function validatedConfiguration(value: unknown): EmailClassificationConfiguration {
  try { return validateEmailClassificationConfiguration(value); } catch { return invalidConfiguration(); }
}

function requireUsableCredential(resolution: EmailClassificationCredentialResolution): void {
  if (resolution.status.status === 'missing') {
    throw new EmailClassificationAdminServiceError('EMAIL_CLASSIFICATION_CREDENTIAL_MISSING', 409, 'Configure the selected provider credential in system Secrets.', SECRETS_LINK);
  }
  if (resolution.status.status === 'unavailable') {
    throw new EmailClassificationAdminServiceError('EMAIL_CLASSIFICATION_CREDENTIAL_UNAVAILABLE', 503, 'The selected system credential cannot be used. Check system Secrets.', SECRETS_LINK);
  }
}

function requireUsableExecution(execution: EmailClassificationExecution): void {
  if (execution.mode === 'direct') return requireUsableCredential(execution.credential);
  if (!execution.ready) throw new EmailClassificationAdminServiceError(`EMAIL_CLASSIFICATION_MANAGED_${(execution.reason ?? 'UNAVAILABLE').toUpperCase()}`, execution.reason === 'budget_exhausted' || execution.reason === 'entitlement_denied' ? 402 : 409, 'The managed decision model is not ready. Check the Control Plane connection, access, model credentials and pricing.');
}

async function storeFor(dependencies: EmailClassificationAdminServiceDependencies): Promise<EmailClassificationAdminStore> {
  return dependencies.store ?? getRuntimeEmailClassificationStore();
}

async function postgresFor(dependencies: EmailClassificationAdminServiceDependencies): Promise<EmailClassificationQueryable> {
  if (dependencies.postgres) return dependencies.postgres;
  const database = await import('@/app/lib/db');
  database.assertDatabaseAvailable();
  const postgres = database.getPostgresRuntimeQueryable();
  if (!postgres) throw new Error('Email classification persistence is unavailable.');
  return postgres;
}

function timestamp(dependencies: EmailClassificationAdminServiceDependencies): number {
  const now = dependencies.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid runtime time.');
  return now;
}

function count(value: unknown): number {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid runtime statistics.');
  return number;
}

function metric(value: unknown): number | null {
  if (value === null) return null;
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0) throw new Error('Invalid runtime statistics.');
  return number;
}

/** Aggregate SQL only; no raw mail, account identity, endpoint or error string reaches this DTO. */
export async function readEmailClassificationRuntimeHealth(settings: EmailClassificationSettings, dependencies: EmailClassificationAdminServiceDependencies = {}): Promise<EmailClassificationRuntimeHealth> {
  const now = timestamp(dependencies);
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const budgetBase = { dayStart, resetsAt: dayStart + DAY_MS, limit: settings.configuration.maxEmailsPerDay };
  try {
    const postgres = await postgresFor(dependencies);
    const result = await postgres.query(`WITH active_mailboxes AS (
      SELECT mailbox_ref, binding_revision, policy_revision, coverage, last_sync_at FROM email_classification_mailboxes WHERE active
    ), indexed AS (
      SELECT message.message_ref, message.fingerprint, mailbox.binding_revision, mailbox.policy_revision,
        coalesce(${emailClassificationSelectionSql('message', '$4', '$5')},false) AS selected
      FROM email_classification_messages message JOIN active_mailboxes mailbox ON mailbox.mailbox_ref = message.mailbox_ref
    ), current_results AS (
      SELECT result.raw_json, result.updated_at FROM email_classification_results result JOIN indexed message ON message.message_ref = result.message_ref
      WHERE result.raw_json IS NOT NULL AND result.evaluation_fingerprint = $2 AND result.fingerprint = message.fingerprint
        AND result.binding_revision = message.binding_revision AND result.policy_revision = message.policy_revision
    ), current_jobs AS (
      SELECT job.status FROM email_classification_jobs job JOIN indexed message ON message.message_ref = job.message_ref
      WHERE message.selected AND job.configuration_revision = $1 AND job.fingerprint = message.fingerprint
        AND job.binding_revision = message.binding_revision AND job.policy_revision = message.policy_revision
    ) SELECT
      (SELECT count(*) FROM indexed) AS indexed,
      (SELECT count(*) FROM current_results) AS analyzed,
      (SELECT count(*) FROM current_jobs WHERE status IN ('pending','retry')) AS pending,
      (SELECT count(*) FROM current_jobs WHERE status = 'processing') AS processing,
      (SELECT count(*) FROM current_jobs WHERE status = 'failed') AS failed,
      (SELECT count(*) FROM active_mailboxes) AS mailbox_active,
      (SELECT count(*) FROM active_mailboxes WHERE coverage = 'pending') AS mailbox_pending,
      (SELECT count(*) FROM active_mailboxes WHERE coverage = 'partial') AS mailbox_partial,
      (SELECT count(*) FROM active_mailboxes WHERE coverage = 'complete') AS mailbox_complete,
      (SELECT count(*) FROM active_mailboxes WHERE coverage = 'failed') AS mailbox_failed,
      (SELECT max(last_sync_at) FROM active_mailboxes) AS last_sync_at,
      (SELECT attempts FROM email_classification_daily_budget WHERE day_start = $3) AS budget_used,
      (SELECT sum((raw_json->'usage'->>'inputTokens')::numeric) FROM current_results) AS input_tokens,
      (SELECT sum((raw_json->'usage'->>'outputTokens')::numeric) FROM current_results) AS output_tokens,
      (SELECT count(*) FROM current_results WHERE raw_json->'usage'->>'inputTokens' IS NOT NULL OR raw_json->'usage'->>'outputTokens' IS NOT NULL) AS usage_samples,
      (SELECT avg((raw_json->>'latencyMs')::numeric) FROM current_results) AS average_latency_ms,
      (SELECT max(updated_at) FROM current_results) AS last_completed_at`,
    [settings.revision, emailClassificationEvaluationFingerprint(settings.configuration), dayStart, now, settings.configuration.initialLookbackDays]);
    const row = result.rows[0];
    if (!row) throw new Error('Missing runtime statistics.');
    const used = row.budget_used === null ? 0 : count(row.budget_used);
    const remaining = Math.max(0, budgetBase.limit - used);
    const counts = { indexed: count(row.indexed), analyzed: count(row.analyzed), pending: count(row.pending), processing: count(row.processing), failed: count(row.failed) };
    return {
      state: !settings.configuration.enabled || remaining === 0 ? 'paused' : counts.processing > 0 ? 'processing' : 'idle',
      counts,
      mailboxes: { active: count(row.mailbox_active), pending: count(row.mailbox_pending), partial: count(row.mailbox_partial), complete: count(row.mailbox_complete), failed: count(row.mailbox_failed), lastSyncAt: metric(row.last_sync_at) },
      budget: { ...budgetBase, used, remaining },
      usage: { reportedInputTokens: metric(row.input_tokens), reportedOutputTokens: metric(row.output_tokens), samples: count(row.usage_samples) },
      averageLatencyMs: metric(row.average_latency_ms), lastCompletedAt: metric(row.last_completed_at),
    };
  } catch {
    return { state: 'unavailable', counts: null, mailboxes: null, budget: { ...budgetBase, used: null, remaining: null }, usage: null, averageLatencyMs: null, lastCompletedAt: null };
  }
}

type AvailabilityRuntime = Pick<EmailClassificationRuntimeHealth, 'state' | 'budget'>;

function availability(settings: EmailClassificationSettings, credential: EmailClassificationCredentialStatus, health: AvailabilityRuntime | null): EmailClassificationAvailability {
  let reason: EmailClassificationAvailabilityReason = null;
  if (!settings.configuration.enabled) reason = 'disabled';
  else if (credential.status === 'missing') reason = 'missing_configuration';
  else if (credential.status === 'unavailable') reason = 'configuration_unavailable';
  else if (health?.state === 'unavailable') reason = 'provider_unavailable';
  else if (health?.budget.remaining === 0) reason = 'budget_exhausted';
  return { enabled: settings.configuration.enabled, available: reason === null || reason === 'budget_exhausted', revision: settings.revision, defaultMode: settings.configuration.enabled ? 'focus' : 'classic', reason };
}

function providerOptions(): EmailClassificationProviderOption[] {
  return [
    { id: 'typesafe', label: 'TypeSafe Jev', requiresEndpoint: false, defaultModel: 'jev-1.13.0', credentialKeyDefault: 'TYPESAFE_API_KEY' },
    { id: 'systemone', label: 'System One compatible', requiresEndpoint: true, defaultModel: 'kev', credentialKeyDefault: 'EMAIL_CLASSIFICATION_API_KEY' },
    { id: 'openai-decisions', label: 'OpenAI Decisions', requiresEndpoint: false, defaultModel: 'gpt-6-luna', credentialKeyDefault: 'OPENAI_API_KEY' },
  ];
}

async function adminSnapshot(settings: EmailClassificationSettings, dependencies: EmailClassificationAdminServiceDependencies): Promise<EmailClassificationAdminSettings> {
  const execution = await resolveEmailClassificationExecution(settings.configuration, dependencies);
  if (settings.configuration.enabled && dependencies.store) settings = await reconcileEmailClassificationExecution(dependencies.store, settings, execution);
  else if (!settings.configuration.enabled) settings = { ...settings, configuration: managedEmailConfiguration(settings.configuration, execution) };
  const credential = execution.credential;
  const managedCatalog = execution.catalog ?? await (dependencies.readManagedCatalog ?? (() => readManagedDecisionModels(dependencies)))();
  const health = await readEmailClassificationRuntimeHealth(settings, dependencies);
  if (settings.configuration.enabled && credential.status.status !== 'configured' && health.state !== 'unavailable') health.state = 'paused';
  return { settings, availability: availability(settings, credential.status, health), credentials: credential.status, health, providerOptions: providerOptions(), execution: { mode: execution.mode, reason: execution.reason, managed: managedCatalog } };
}

export async function readAdminEmailClassificationSettings(dependencies: EmailClassificationAdminServiceDependencies = {}): Promise<EmailClassificationAdminSettings> {
  const store = await storeFor(dependencies);
  return adminSnapshot(await store.readSettings(), { ...dependencies, store });
}

export async function updateAdminEmailClassificationSettings(input: {
  expectedRevision: number; configuration: unknown; actorUserId: string;
}, dependencies: EmailClassificationAdminServiceDependencies = {}): Promise<EmailClassificationAdminSettings & { changedFields: string[] }> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || typeof input.actorUserId !== 'string' || !input.actorUserId.trim() || input.actorUserId.length > 500) invalidConfiguration();
  let configuration = validatedConfiguration(input.configuration);
  const store = await storeFor(dependencies);
  const previous = await store.readSettings();
  if (previous.revision !== input.expectedRevision) throw new EmailClassificationVersionConflictError();
  configuration = { ...configuration, managedModel: configuration.managedModelRef === previous.configuration.managedModelRef ? previous.configuration.managedModel : null };
  const execution = await resolveEmailClassificationExecution(configuration, dependencies);
  configuration = managedEmailConfiguration(configuration, execution);
  if (configuration.enabled) requireUsableExecution(execution);
  const settings = await store.updateSettings({ expectedRevision: input.expectedRevision, configuration, actorUserId: input.actorUserId, now: timestamp(dependencies) });
  notifyEmailClassificationSettingsChanged();
  const changedFields = Object.keys(settings.configuration).filter(key => JSON.stringify(previous.configuration[key as keyof EmailClassificationConfiguration]) !== JSON.stringify(settings.configuration[key as keyof EmailClassificationConfiguration]));
  return { ...await adminSnapshot(settings, { ...dependencies, store }), changedFields };
}

export async function readEmailClassificationAvailability(dependencies: EmailClassificationAdminServiceDependencies = {}): Promise<EmailClassificationAvailability> {
  const store = await storeFor(dependencies);
  let settings = await store.readSettings();
  if (!settings.configuration.enabled) return { enabled: false, available: false, revision: settings.revision, defaultMode: 'classic', reason: 'disabled' };
  const execution = await resolveEmailClassificationExecution(settings.configuration, dependencies);
  settings = await reconcileEmailClassificationExecution(store, settings, execution);
  const credential = execution.credential;
  // Normal UI polling must never scan the mail corpus or admin usage aggregates.
  let health: AvailabilityRuntime | null = null;
  if (credential.status.configured) {
    const dayStart = Math.floor(timestamp(dependencies) / DAY_MS) * DAY_MS;
    const budgetBase = { dayStart, resetsAt: dayStart + DAY_MS, limit: settings.configuration.maxEmailsPerDay };
    try {
      const result = await (await postgresFor(dependencies)).query('SELECT attempts FROM email_classification_daily_budget WHERE day_start = $1', [dayStart]);
      const used = result.rows[0] ? count(result.rows[0].attempts) : 0;
      health = { state: 'idle', budget: { ...budgetBase, used, remaining: Math.max(0, budgetBase.limit - used) } };
    } catch {
      health = { state: 'unavailable', budget: { ...budgetBase, used: null, remaining: null } };
    }
  }
  return availability(settings, credential.status, health);
}

export interface EmailClassificationProviderTestResult {
  success: true;
  providerId: string;
  model: string;
  adapterVersion: string;
  latencyMs: number;
  usage: EmailClassificationRaw['usage'];
  classification: EmailClassification;
  ratings: Pick<EmailClassificationRaw, 'category' | 'categoryProbabilities' | 'categoryConfidence' | 'priority' | 'priorityProbabilities' | 'priorityConfidence' | 'spamProbability' | 'replyProbability'>;
  schemaVersion: string;
  testedRevision: number | null;
  calibrationVerified: false;
}

/** Synthetic only: this explicitly authorized admin probe also works before central activation. */
export async function testEmailClassificationProvider(input: { configuration?: unknown; signal?: AbortSignal } = {}, dependencies: EmailClassificationAdminServiceDependencies = {}): Promise<EmailClassificationProviderTestResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['configuration', 'signal'].includes(key))) invalidConfiguration();
  const saved = input.configuration === undefined ? await (await storeFor(dependencies)).readSettings() : null;
  let configuration = validatedConfiguration(input.configuration ?? saved?.configuration);
  const execution = await resolveEmailClassificationExecution(configuration, dependencies);
  requireUsableExecution(execution);
  configuration = managedEmailConfiguration(configuration, execution);
  const state = buildEmailDecisionState({
    from: 'customer@example.test', to: ['support@example.test'], subject: 'Order delayed',
    body: 'My order has not arrived after two weeks. Please investigate and reply with an update.', mailboxScope: 'workspace',
  }, configuration.questionProfile);
  const result = await executeEmailClassification(configuration, {
    state: state.state, questions: buildEmailClassificationQuestions(configuration.questionProfile), schemaVersion: EMAIL_CLASSIFICATION_SCHEMA_VERSION,
    signal: input.signal,
  }, execution, undefined, dependencies);
  let raw: EmailClassificationRaw;
  try { raw = normalizeEmailClassificationResult(result, { evaluatedBodyCharacters: state.evaluatedBodyCharacters, bodyWasTruncated: state.bodyWasTruncated, evaluatedAt: timestamp(dependencies) }); }
  catch { throw new EmailClassificationAdminServiceError('EMAIL_CLASSIFICATION_INVALID_RESPONSE', 502, 'The decision provider returned an invalid email assessment.'); }
  return {
    success: true, providerId: raw.providerId, model: raw.model, adapterVersion: raw.adapterVersion, latencyMs: raw.latencyMs, usage: raw.usage,
    classification: projectEmailClassification({ raw, policy: configuration.policy }),
    ratings: { category: raw.category, categoryProbabilities: raw.categoryProbabilities, categoryConfidence: raw.categoryConfidence,
      priority: raw.priority, priorityProbabilities: raw.priorityProbabilities, priorityConfidence: raw.priorityConfidence,
      spamProbability: raw.spamProbability, replyProbability: raw.replyProbability },
    schemaVersion: raw.schemaVersion, testedRevision: saved?.revision ?? null, calibrationVerified: false,
  };
}
