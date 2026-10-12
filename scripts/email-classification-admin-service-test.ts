import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  emailClassificationAdminErrorDetails, readAdminEmailClassificationSettings, readEmailClassificationAvailability,
  readEmailClassificationRuntimeHealth, testEmailClassificationProvider, updateAdminEmailClassificationSettings,
  type EmailClassificationAdminServiceDependencies,
} from '../app/lib/email/classification/admin-service';
import { resolveEmailClassificationCredential } from '../app/lib/email/classification/credential-service';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } from '../app/lib/email/classification/settings-types';
import { resetChangedEmailSpamValidation, validateEmailClassificationConfiguration } from '../app/lib/email/classification/settings-validation';
import { runEmailClassificationPostgresMigration } from '../app/lib/email/classification/postgres-migration';
import { createEmailClassificationStore } from '../app/lib/email/classification/store';
import type { EmailClassificationQueryable } from '../app/lib/email/classification/store-types';
import { normalizeEmailClassificationResult } from '../app/lib/email/classification/normalize';
import { DecisionModelError } from '../app/lib/decision-models/errors';
import type { DecisionInput, DecisionResult } from '../app/lib/decision-models/types';

const KEY_MARKER = 'only-system-fixture-key';
const PRIVATE_MARKER = 'private-message-and-provider-error-fixture';
const DAY_MS = 86_400_000;
const NOW = 20_000 * DAY_MS + 1_000;

function config() { return structuredClone(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION); }

function result(): DecisionResult {
  return {
    providerId: 'typesafe', model: 'jev-1.13.0', adapterVersion: 'fixture-v1', probabilitySemantics: 'model_probability', latencyMs: 31,
    usage: { inputTokens: 450, outputTokens: 42, requests: 1 },
    answers: {
      category: { type: 'choice', choice: 'support', probabilities: { correspondence: 0, finance: 0, support: 0.9, sales: 0, security: 0, newsletter: 0, marketing: 0, notification: 0, other: 0.1 }, confidence: 0.9 },
      priority: { type: 'choice', choice: 'high', probabilities: { low: 0.02, normal: 0.04, high: 0.92, urgent: 0.02 }, confidence: 0.893333333 },
      is_spam: { type: 'binary', probability: 0.02 }, needs_reply: { type: 'binary', probability: 0.98 },
    },
  };
}

async function rejection(operation: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(operation, error => {
    const details = emailClassificationAdminErrorDetails(error);
    assert.equal(details.code, code);
    assert.equal(details.status, status);
    assert.equal(JSON.stringify(details).includes(KEY_MARKER), false);
    assert.equal(JSON.stringify(details).includes(PRIVATE_MARKER), false);
    return true;
  });
}

async function main() {
  const credentialRequests: unknown[] = [];
  const readSecret = (key: string, scope: { secretScope: 'system' }) => {
    credentialRequests.push({ key, scope });
    return KEY_MARKER;
  };
  const ready = resolveEmailClassificationCredential(config(), { readSecret });
  assert.equal(ready.value, KEY_MARKER);
  assert.deepEqual(credentialRequests, [{ key: 'TYPESAFE_API_KEY', scope: { secretScope: 'system' } }]);
  assert.deepEqual(ready.status, { status: 'configured', configured: true, scope: 'system', anonymous: false, settingsLink: '/settings?tab=secrets' });
  assert.equal(JSON.stringify(ready.status).includes(KEY_MARKER), false);
  assert.equal(resolveEmailClassificationCredential(config(), { readSecret: () => null }).status.status, 'missing');
  assert.equal(resolveEmailClassificationCredential(config(), { readSecret: () => { throw new Error(PRIVATE_MARKER); } }).status.status, 'unavailable');
  assert.equal(resolveEmailClassificationCredential(config(), { readSecret: () => 'bad\nkey' }).status.status, 'unavailable');
  assert.equal(resolveEmailClassificationCredential({ ...config(), credentialKey: 'EMAIL_ACCOUNT_SECRET_ENCRYPTION_KEY' }, { readSecret }).status.status, 'unavailable');
  const anonymous = { ...config(), providerId: 'systemone', model: 'kev', endpoint: 'http://127.0.0.1:8000', allowPrivateNetwork: true, credentialKey: null };
  assert.equal(resolveEmailClassificationCredential(anonymous, { readSecret: () => { throw new Error('No ambient key lookup is allowed.'); } }).status.anonymous, true);
  assert.equal(resolveEmailClassificationCredential({ ...anonymous, credentialKey: 'EMAIL_CLASSIFICATION_API_KEY' }, { readSecret: () => null }).status.status, 'missing', 'Configured-but-missing is not anonymous.');
  assert.equal(resolveEmailClassificationCredential({ ...anonymous, allowPrivateNetwork: false }, { readSecret }).status.status, 'missing');
  assert.equal(resolveEmailClassificationCredential({ ...config(), credentialKey: null, allowPrivateNetwork: true }, { readSecret }).status.status, 'missing', 'TypeSafe cannot become anonymous.');
  const openAI = { ...config(), providerId: 'openai-decisions', model: 'gpt-6-luna', credentialKey: 'OPENAI_API_KEY' };
  const openAICredentialRequests: unknown[] = [];
  const openAISecret = (key: string, scope: { secretScope: 'system' }) => {
    openAICredentialRequests.push({ key, scope }); return key === 'OPENAI_API_KEY' && scope.secretScope === 'system' ? KEY_MARKER : null;
  };
  assert.equal(resolveEmailClassificationCredential(openAI, { readSecret: openAISecret }).status.status, 'configured');
  assert.deepEqual(openAICredentialRequests, [{ key: 'OPENAI_API_KEY', scope: { secretScope: 'system' } }]);
  assert.equal(resolveEmailClassificationCredential(openAI, { readSecret: () => null }).status.status, 'missing');
  assert.equal(resolveEmailClassificationCredential({ ...openAI, credentialKey: null, allowPrivateNetwork: true }, { readSecret: openAISecret }).status.status, 'missing', 'OpenAI cannot become anonymous.');
  assert.equal(openAICredentialRequests.length, 1, 'Missing credential configuration never searches an ambient key.');
  const normalizedOpenAI = validateEmailClassificationConfiguration({ ...openAI, allowPrivateNetwork: true, endpoint: 'https://api.openai.com/v1/decisions' });
  assert.equal(normalizedOpenAI.endpoint, null); assert.equal(normalizedOpenAI.allowPrivateNetwork, false);
  assert.throws(() => validateEmailClassificationConfiguration({ ...openAI, credentialKey: null }));
  assert.throws(() => validateEmailClassificationConfiguration({ ...openAI, model: 'gpt-6-sol' }));
  assert.throws(() => validateEmailClassificationConfiguration({ ...openAI, endpoint: 'https://api.openai.com/v1/responses' }));
  const validatedTypeSafe = { ...config(), policy: { ...config().policy, spamSortingValidated: true, calibrationReference: 'Labeled TypeSafe test set', validatedProviderId: 'typesafe', validatedModel: 'jev-1.13.0', validatedSchemaVersion: 'email.v1' } };
  const switchedProvider = resetChangedEmailSpamValidation(validatedTypeSafe, { ...openAI, policy: validatedTypeSafe.policy });
  assert.equal(switchedProvider.policy.spamSortingValidated, false); assert.equal(switchedProvider.policy.calibrationReference, null);
  assert.equal(switchedProvider.policy.validatedProviderId, null); assert.equal(switchedProvider.policy.validatedModel, null); assert.equal(switchedProvider.policy.validatedSchemaVersion, null);

  const postgres = new PGlite();
  try {
    await postgres.exec(`CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES ('admin'), ('owner');`);
    await runEmailClassificationPostgresMigration(postgres as unknown as EmailClassificationQueryable);
    const store = createEmailClassificationStore({ postgres: postgres as unknown as EmailClassificationQueryable,
      transaction: operation => postgres.transaction(connection => operation(connection as unknown as EmailClassificationQueryable)) });
    const dependencies: EmailClassificationAdminServiceDependencies = { store, postgres: postgres as unknown as EmailClassificationQueryable, readSecret, now: () => NOW };
    const initial = await readAdminEmailClassificationSettings(dependencies);
    assert.equal(initial.settings.revision, 0);
    assert.deepEqual(initial.availability, { enabled: false, available: false, revision: 0, defaultMode: 'classic', reason: 'disabled' });
    assert.equal(initial.credentials.status, 'configured');
    assert.equal(initial.health.counts?.indexed, 0);
    assert.equal(initial.health.usage?.reportedInputTokens, null, 'Unknown usage is never invented as zero.');
    assert.deepEqual(initial.providerOptions.map(option => option.id), ['typesafe', 'systemone', 'openai-decisions']);
    assert.deepEqual(initial.providerOptions.find(option => option.id === 'openai-decisions'), { id: 'openai-decisions', label: 'OpenAI Decisions', requiresEndpoint: false, defaultModel: 'gpt-6-luna', credentialKeyDefault: 'OPENAI_API_KEY' });
    assert.equal(JSON.stringify(initial).includes(KEY_MARKER), false);
    const readsBeforeDisabled = credentialRequests.length;
    await readEmailClassificationAvailability(dependencies);
    assert.equal(credentialRequests.length, readsBeforeDisabled, 'Disabled availability does not read credentials.');

    let evaluationCalls = 0;
    const evaluated: DecisionInput[] = [];
    const evaluate = async (input: DecisionInput) => {
      evaluated.push(input); evaluationCalls++;
      assert.equal(input.credential?.apiKey, KEY_MARKER);
      assert.equal(input.configuration.endpoint, undefined, 'The TypeSafe endpoint stays fixed.');
      assert.equal(Object.keys(input.questions).length, 4);
      assert.equal((input.state as Record<string, unknown>).email !== undefined, true);
      return result();
    };
    const probe = await testEmailClassificationProvider({}, { ...dependencies, evaluate });
    assert.equal(probe.success, true); assert.equal(probe.testedRevision, 0);
    assert.equal(probe.ratings.category, 'support'); assert.equal(probe.ratings.priority, 'high');
    assert.equal(probe.calibrationVerified, false, 'A connection probe never validates spam sorting quality.');
    assert.equal(probe.classification.replyStatus, 'unknown');
    assert.equal(JSON.stringify(probe).includes(KEY_MARKER), false);
    assert.equal((await store.readSettings()).revision, 0, 'Testing while disabled does not save or activate configuration.');
    const unsaved = { ...config(), model: 'jev-preview', questionProfile: { ...config().questionProfile, workPurpose: 'Changed example work profile.' } };
    const unsavedProbe = await testEmailClassificationProvider({ configuration: unsaved }, { ...dependencies, evaluate });
    assert.equal(unsavedProbe.testedRevision, null);
    assert.equal(evaluated[1].configuration.model, 'jev-preview');
    assert.equal((evaluated[1].state as Record<string, unknown>).mailboxContext, 'Changed example work profile.');
    assert.deepEqual((evaluated[0].state as { email: unknown }).email, (evaluated[1].state as { email: unknown }).email, 'Only the coded synthetic email is used.');
    assert.equal((await store.readSettings()).revision, 0);
    await rejection(testEmailClassificationProvider({ configuration: { ...config(), apiKey: KEY_MARKER } }, { ...dependencies, evaluate }), 'EMAIL_CLASSIFICATION_INVALID_CONFIGURATION', 400);
    await rejection(testEmailClassificationProvider({ state: PRIVATE_MARKER } as never, { ...dependencies, evaluate }), 'EMAIL_CLASSIFICATION_INVALID_CONFIGURATION', 400);
    assert.equal(evaluationCalls, 2, 'Rejected payloads never invoke a model.');
    await rejection(testEmailClassificationProvider({}, { ...dependencies, readSecret: () => null, evaluate }), 'EMAIL_CLASSIFICATION_CREDENTIAL_MISSING', 409);
    await rejection(testEmailClassificationProvider({}, { ...dependencies, readSecret: () => { throw new Error(PRIVATE_MARKER); }, evaluate }), 'EMAIL_CLASSIFICATION_CREDENTIAL_UNAVAILABLE', 503);
    await rejection(testEmailClassificationProvider({}, { ...dependencies, evaluate: async () => ({ ...result(), answers: {} }) }), 'EMAIL_CLASSIFICATION_INVALID_RESPONSE', 502);
    const aborted = new AbortController();
    aborted.abort();
    await rejection(testEmailClassificationProvider({ signal: aborted.signal }, { ...dependencies, evaluate: async input => {
      assert.equal(input.signal, aborted.signal);
      throw new DecisionModelError('aborted');
    } }), 'EMAIL_CLASSIFICATION_ABORTED', 409);
    assert.deepEqual(emailClassificationAdminErrorDetails(new Error(`${KEY_MARKER} ${PRIVATE_MARKER}`)), { code: 'EMAIL_CLASSIFICATION_UNAVAILABLE', status: 503, message: 'Email classification is temporarily unavailable.' });

    await rejection(updateAdminEmailClassificationSettings({ expectedRevision: 0, actorUserId: 'admin', configuration: { ...config(), enabled: true } }, { ...dependencies, readSecret: () => null }), 'EMAIL_CLASSIFICATION_CREDENTIAL_MISSING', 409);
    assert.equal((await store.readSettings()).revision, 0);
    await rejection(updateAdminEmailClassificationSettings({ expectedRevision: 0, actorUserId: 'admin', configuration: { ...config(), enabled: true } }, { ...dependencies, readSecret: () => { throw new Error(PRIVATE_MARKER); } }), 'EMAIL_CLASSIFICATION_CREDENTIAL_UNAVAILABLE', 503);
    const enabled = await updateAdminEmailClassificationSettings({ expectedRevision: 0, actorUserId: 'admin', configuration: { ...config(), enabled: true, maxEmailsPerDay: 2 } }, dependencies);
    assert.equal(enabled.settings.revision, 1);
    assert.equal(enabled.availability.defaultMode, 'focus'); assert.equal(enabled.availability.available, true);
    assert.deepEqual(enabled.changedFields.sort(), ['enabled', 'maxEmailsPerDay']);
    const publicQueries: string[] = [];
    const publicPostgres = { query: async (sql: string, params?: unknown[]) => {
      publicQueries.push(sql);
      return postgres.query(sql, params);
    } } as EmailClassificationQueryable;
    assert.equal((await readEmailClassificationAvailability({ ...dependencies, postgres: publicPostgres })).available, true);
    assert.equal(publicQueries.length, 1);
    assert.ok(publicQueries[0].includes('email_classification_daily_budget'));
    assert.equal(/email_classification_(messages|mailboxes|results|jobs)/u.test(publicQueries[0]), false, 'Ordinary availability polls do not scan corpus/admin statistics.');
    await rejection(updateAdminEmailClassificationSettings({ expectedRevision: 0, actorUserId: 'admin', configuration: enabled.settings.configuration }, dependencies), 'EMAIL_CLASSIFICATION_VERSION_CONFLICT', 409);
    const missing = await readEmailClassificationAvailability({ ...dependencies, readSecret: () => null });
    assert.equal(missing.enabled, true); assert.equal(missing.defaultMode, 'focus'); assert.equal(missing.available, false); assert.equal(missing.reason, 'missing_configuration');
    assert.equal(JSON.stringify(missing).includes('provider'), false);
    const secretFailed = await readAdminEmailClassificationSettings({ ...dependencies, readSecret: () => { throw new Error(PRIVATE_MARKER); } });
    assert.equal(secretFailed.credentials.status, 'unavailable'); assert.equal(secretFailed.health.state, 'paused');
    assert.equal(JSON.stringify(secretFailed).includes(PRIVATE_MARKER), false);
    const failingPostgres: EmailClassificationQueryable = { query: async () => { throw new Error(`${KEY_MARKER} ${PRIVATE_MARKER}`); } };
    const failedHealth = await readEmailClassificationRuntimeHealth(enabled.settings, { ...dependencies, postgres: failingPostgres });
    assert.equal(failedHealth.state, 'unavailable'); assert.equal(failedHealth.counts, null); assert.equal(failedHealth.budget.used, null);
    const degraded = await readEmailClassificationAvailability({ ...dependencies, postgres: failingPostgres });
    assert.equal(degraded.enabled, true); assert.equal(degraded.defaultMode, 'focus'); assert.equal(degraded.available, false); assert.equal(degraded.reason, 'provider_unavailable');
    assert.equal(JSON.stringify(degraded).includes(PRIVATE_MARKER), false);

    await store.upsertMailbox({ mailboxRef: 'fixture-mailbox', ownerUserId: 'owner', accountId: 'account', accountSource: 'managed', provider: 'google', workspaceId: null, mailboxId: null, bindingRevision: 'binding', policyRevision: 'policy', readFrom: [], active: true }, NOW);
    await store.upsertMessageMetadata({ messageRef: 'fixture-message', mailboxRef: 'fixture-mailbox', canonicalId: 'provider-message', folder: 'INBOX', dateTimestamp: NOW, replyStatus: 'unknown', fingerprint: 'fingerprint', list: { from: PRIVATE_MARKER, subject: PRIVATE_MARKER, snippet: PRIVATE_MARKER, date: String(NOW) } }, NOW);
    await store.enqueueClassification({ messageRef: 'fixture-message', configurationRevision: 1, fingerprint: 'fingerprint', now: NOW });
    const job = (await store.claimJobs({ limit: 1, leaseMs: 10_000, now: NOW }))[0];
    const running = await readAdminEmailClassificationSettings(dependencies);
    assert.equal(running.health.state, 'processing'); assert.equal(running.health.counts?.processing, 1); assert.equal(running.health.budget.used, 1);
    const raw = normalizeEmailClassificationResult(result(), { evaluatedBodyCharacters: 80, bodyWasTruncated: false, evaluatedAt: NOW });
    assert.equal(await store.completeJob({ jobId: job.id, claimToken: job.claimToken!, raw, now: NOW + 1 }), true);
    const completed = await readAdminEmailClassificationSettings(dependencies);
    assert.equal(completed.health.counts?.indexed, 1); assert.equal(completed.health.counts?.analyzed, 1); assert.equal(completed.health.counts?.processing, 0);
    assert.equal(completed.health.usage?.reportedInputTokens, 450); assert.equal(completed.health.usage?.reportedOutputTokens, 42); assert.equal(completed.health.averageLatencyMs, 31);
    assert.equal(JSON.stringify(completed).includes(PRIVATE_MARKER), false, 'Runtime status exposes aggregate statistics, not messages.');
    await postgres.query('UPDATE email_classification_daily_budget SET attempts = 2 WHERE day_start = $1', [Math.floor(NOW / DAY_MS) * DAY_MS]);
    const exhausted = await readAdminEmailClassificationSettings(dependencies);
    assert.equal(exhausted.health.state, 'paused'); assert.equal(exhausted.health.budget.remaining, 0); assert.equal(exhausted.availability.reason, 'budget_exhausted');
    assert.equal(exhausted.availability.available, true); assert.equal(exhausted.availability.defaultMode, 'focus', 'Budget exhaustion preserves the prepared experience.');
    assert.equal(exhausted.health.budget.resetsAt, Math.floor(NOW / DAY_MS) * DAY_MS + DAY_MS);
    const nextDay = await readEmailClassificationRuntimeHealth(enabled.settings, { ...dependencies, now: () => NOW + DAY_MS });
    assert.equal(nextDay.budget.used, 0); assert.equal(nextDay.budget.remaining, 2);

    const anonymousSaved = await updateAdminEmailClassificationSettings({ expectedRevision: 1, actorUserId: 'admin', configuration: { ...anonymous, enabled: true } }, { ...dependencies, readSecret: () => { throw new Error('Anonymous must not look up credentials.'); } });
    assert.equal(anonymousSaved.credentials.anonymous, true); assert.equal(anonymousSaved.settings.configuration.endpoint, 'http://127.0.0.1:8000/v1/systemone');
    const anonymousProbe = await testEmailClassificationProvider({ configuration: anonymous }, { ...dependencies, evaluate: async input => {
      assert.equal(input.credential, undefined); assert.equal(input.configuration.providerId, 'systemone');
      return { ...result(), providerId: 'systemone', model: 'kev', probabilitySemantics: 'relative_probability' };
    } });
    assert.equal(anonymousProbe.providerId, 'systemone'); assert.equal(anonymousProbe.calibrationVerified, false);
    assert.equal((await store.readSettings()).configuration.policy.spamSortingValidated, false);
    const beforeOpenAIProbe = (await store.readSettings()).revision;
    const openAIProbe = await testEmailClassificationProvider({ configuration: openAI }, { ...dependencies, readSecret: openAISecret, evaluate: async input => {
      assert.equal(input.configuration.providerId, 'openai-decisions'); assert.equal(input.configuration.model, 'gpt-6-luna');
      assert.equal(input.configuration.endpoint, undefined); assert.equal(input.configuration.allowPrivateNetwork, false);
      assert.equal(input.credential?.apiKey, KEY_MARKER); assert.equal(Object.keys(input.questions).length, 4);
      assert.deepEqual((input.state as { email: unknown }).email, (evaluated[0].state as { email: unknown }).email, 'OpenAI probes use the same immutable synthetic email, not indexed mail.');
      return { ...result(), providerId: 'openai-decisions', model: 'gpt-6-luna', adapterVersion: 'openai-decisions.v1', usage: { inputTokens: 450, outputTokens: 0, requests: 1 } };
    } });
    assert.equal(openAIProbe.providerId, 'openai-decisions'); assert.equal(openAIProbe.model, 'gpt-6-luna');
    assert.equal(openAIProbe.calibrationVerified, false); assert.equal(openAIProbe.testedRevision, null);
    assert.equal(JSON.stringify(openAIProbe).includes(KEY_MARKER), false);
    assert.equal((await store.readSettings()).revision, beforeOpenAIProbe, 'The new-provider probe does not save or enable unsaved settings.');
    await rejection(testEmailClassificationProvider({ configuration: openAI }, { ...dependencies, readSecret: () => null, evaluate: async () => { throw new Error('Missing system key must prevent a provider request.'); } }), 'EMAIL_CLASSIFICATION_CREDENTIAL_MISSING', 409);
    await rejection(testEmailClassificationProvider({ configuration: { ...openAI, model: 'gpt-6-sol' } }, dependencies), 'EMAIL_CLASSIFICATION_INVALID_CONFIGURATION', 400);
    await rejection(testEmailClassificationProvider({ configuration: openAI }, { ...dependencies, readSecret: openAISecret, evaluate: async () => { throw new DecisionModelError('refused', { providerId: 'openai-decisions' }); } }), 'EMAIL_CLASSIFICATION_REFUSED', 502);
    await rejection(updateAdminEmailClassificationSettings({ expectedRevision: beforeOpenAIProbe, actorUserId: 'admin', configuration: { ...openAI, enabled: true } }, { ...dependencies, readSecret: () => null }), 'EMAIL_CLASSIFICATION_CREDENTIAL_MISSING', 409);
    const openAISaved = await updateAdminEmailClassificationSettings({ expectedRevision: beforeOpenAIProbe, actorUserId: 'admin', configuration: { ...openAI, enabled: true } }, { ...dependencies, readSecret: openAISecret });
    assert.equal(openAISaved.settings.configuration.providerId, 'openai-decisions'); assert.equal(openAISaved.settings.configuration.model, 'gpt-6-luna');
    assert.equal(openAISaved.settings.configuration.endpoint, null); assert.equal(openAISaved.settings.configuration.allowPrivateNetwork, false);
    assert.equal(openAISaved.credentials.scope, 'system'); assert.equal(openAISaved.credentials.status, 'configured');
    assert.equal(openAISaved.availability.defaultMode, 'focus'); assert.equal(openAISaved.availability.available, true);
    assert.equal(openAISaved.settings.configuration.policy.spamSortingValidated, false);
    assert.equal(JSON.stringify(openAISaved).includes(KEY_MARKER), false);
    console.log('Email classification admin service passed: system-only credentials, CAS, synthetic unsaved probes, safe availability and PostgreSQL runtime health.');
  } finally { await postgres.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
