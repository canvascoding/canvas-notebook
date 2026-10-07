import assert from 'node:assert/strict';
import Module from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { decisionProviderRegistry } from '../app/lib/decision-models/registry';
import { decisionInferenceRevision, type ManagedDecisionCatalog, type ManagedDecisionModel } from '@canvas/decision-models/managed';
import { readManagedDecisionModels, evaluateManagedDecisionModel, ManagedDecisionClientError } from '../app/lib/managed/decision-client';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, type EmailClassificationConfiguration } from '../app/lib/email/classification/settings-types';
import { validateEmailClassificationConfiguration } from '../app/lib/email/classification/settings-validation';
import { emailClassificationEvaluationFingerprint } from '../app/lib/email/classification/settings-evaluation';
import { runEmailClassificationPostgresMigration } from '../app/lib/email/classification/postgres-migration';
import { createEmailClassificationStore } from '../app/lib/email/classification/store';
import { emailClassificationMailboxRef } from '../app/lib/email/classification/identity';
import type { DecisionResult } from '../app/lib/decision-models/types';
import type { EmailClassificationQueryable } from '../app/lib/email/classification/store-types';
import type { AuthorizedEmailClassificationMailbox } from '../app/lib/email/classification/mailbox-types';

const loader = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (request, parent, isMain) => {
  if (request === '@/app/lib/db' || request === '@/app/lib/email/account-store') return {};
  if (request === '@/app/lib/email/mailbox-access') return { EmailMailboxAccessError: class extends Error {}, listEmailMailboxes: () => { throw new Error('Inject authorization.'); }, resolveEmailMailboxAccess: () => { throw new Error('Inject authorization.'); } };
  return originalLoad(request, parent, isMain);
};

const provider = decisionProviderRegistry.get('typesafe')!;
const model: ManagedDecisionModel = { ref: 'managed-jev', name: 'Managed Jev', providerId: 'typesafe', model: 'jev-1.13.0', inferenceRevision: decisionInferenceRevision({ providerId: 'typesafe', model: 'jev-1.13.0' }), adapterVersion: provider.adapterVersion, capabilities: provider.capabilities, status: 'ready', available: true, timeoutMs: 30000 };
function catalog(profile = model): ManagedDecisionCatalog { return { contractVersion: 1, defaultModelRef: profile.ref, catalogRevision: `sha256:${'a'.repeat(64)}`, models: [profile] }; }
const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CANVAS_MANAGED_SERVICES_ENABLED: 'true', CANVAS_INSTANCE_TOKEN: 'synthetic-instance-token', CANVAS_CONTROL_PLANE_URL: 'http://localhost:4001', CANVAS_UPDATE_ALLOW_LOCAL_HTTP: 'true' };
function decision(): DecisionResult {
  return { providerId: model.providerId, model: model.model, adapterVersion: model.adapterVersion, probabilitySemantics: provider.capabilities.probabilitySemantics, latencyMs: 10, usage: { requests: 1, inputTokens: 100, outputTokens: 20 }, answers: {
    category: { type: 'choice', choice: 'support', probabilities: { correspondence: 0, finance: 0, support: 1, sales: 0, security: 0, newsletter: 0, marketing: 0, notification: 0, other: 0 }, confidence: 1 },
    priority: { type: 'choice', choice: 'high', probabilities: { low: 0, normal: 0, high: 1, urgent: 0 }, confidence: 1 },
    is_spam: { type: 'binary', probability: 0.01 }, needs_reply: { type: 'binary', probability: 0.99 },
  } };
}

async function main() {
  const { createEmailClassificationWorker } = await import('../app/lib/email/classification/worker');
  const { ingestEmailClassificationMetadata } = await import('../app/lib/email/classification/index-service');
  const { testEmailClassificationProvider } = await import('../app/lib/email/classification/admin-service');
  const { reconcileEmailClassificationExecution, resolveEmailClassificationExecution } = await import('../app/lib/email/classification/execution-service');
  const legacy = structuredClone(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION) as unknown as Record<string, unknown>;
  delete legacy.executionMode; delete legacy.managedModelRef; delete legacy.managedModel;
  assert.equal(validateEmailClassificationConfiguration(legacy).executionMode, 'direct');
  assert.equal((await readManagedDecisionModels({ env: { NODE_ENV: 'test', CANVAS_CONTROL_PLANE_URL: env.CANVAS_CONTROL_PLANE_URL }, force: true })).status, 'missing_connection');
  let sent: Record<string, unknown> | null = null;
  const remoteFetch: typeof fetch = async (_url, init) => {
    if (init?.method !== 'POST') return Response.json(catalog());
    sent = JSON.parse(String(init.body));
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${env.CANVAS_INSTANCE_TOKEN}`);
    return Response.json({ contractVersion: 1, requestId: sent!.requestId, modelRef: model.ref, inferenceRevision: model.inferenceRevision, result: decision() });
  };
  const loaded = await readManagedDecisionModels({ env, fetch: remoteFetch, force: true });
  assert.equal(loaded.status, 'ready');
  const configuration = { ...structuredClone(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION), executionMode: 'managed' as const, managedModelRef: model.ref, managedModel: { ref: model.ref, providerId: model.providerId, model: model.model, adapterVersion: model.adapterVersion, inferenceRevision: model.inferenceRevision }, credentialKey: null };
  let directReads = 0;
  const dependencies = { readManagedCatalog: async () => ({ status: 'ready' as const, code: null, catalog: catalog() }), env, fetch: remoteFetch, readSecret: () => { directReads++; throw new Error('Local secrets must not be read.'); } };
  const probe = await testEmailClassificationProvider({ configuration }, dependencies);
  assert.equal(probe.success, true); assert.equal(directReads, 0);
  assert.deepEqual(Object.keys(sent!).sort(), ['contractVersion', 'inferenceRevision', 'modelRef', 'questions', 'requestId', 'schemaVersion', 'state']);
  const down = await readManagedDecisionModels({ env, force: true, fetch: async () => { throw new Error('Synthetic connection outage'); } });
  assert.equal(down.status, 'unavailable'); assert.equal(down.catalog?.models[0].ref, model.ref);
  await assert.rejects(evaluateManagedDecisionModel({ state: 'Synthetic input', questions: { needs_reply: { type: 'binary', instructions: 'Needs reply?' } }, schemaVersion: 'test.v1', configuration: { providerId: 'typesafe', model: model.model } }, model, 'synthetic-operation', { env, fetch: async () => Response.json({ contractVersion: 1, modelRef: model.ref, requestId: 'different-operation', inferenceRevision: model.inferenceRevision, result: decision() }) }), { managedCode: 'invalid_response' });

  const postgres = new PGlite();
  const now = Date.now(); let time = now;
  try {
    await postgres.exec('CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES (\'admin\'), (\'owner\');');
    await runEmailClassificationPostgresMigration(postgres as unknown as EmailClassificationQueryable);
    const store = createEmailClassificationStore({ postgres: postgres as unknown as EmailClassificationQueryable, transaction: operation => postgres.transaction(connection => operation(connection as unknown as EmailClassificationQueryable)) });
    await store.updateSettings({ expectedRevision: 0, actorUserId: 'admin', configuration: { ...configuration, enabled: true, concurrency: 8 }, now });
    const stable = await store.readSettings();
    const reordered = { ...stable, configuration: { ...stable.configuration, managedModel: Object.fromEntries(Object.entries(stable.configuration.managedModel!).reverse()) as NonNullable<EmailClassificationConfiguration['managedModel']> } };
    const unchanged = await reconcileEmailClassificationExecution(store, reordered, await resolveEmailClassificationExecution(stable.configuration, dependencies));
    assert.equal(unchanged.revision, stable.revision, 'JSON field ordering must not create a new configuration revision.');
    const mailboxes: AuthorizedEmailClassificationMailbox[] = [null, 'workspace'].map(workspaceId => {
      const identity = { ownerUserId: 'owner', accountSource: 'local' as const, accountId: workspaceId ?? 'personal', provider: 'google', workspaceId, mailboxId: workspaceId ? 'business' : null };
      return { ...identity, mailboxRef: emailClassificationMailboxRef(identity), bindingRevision: 'binding', policyRevision: 'policy', connectionRevision: 'connection', active: true, readFrom: [], emailAddress: 'owner@example.test', displayName: null, workspaceName: workspaceId, capabilities: { canRead: true, canWrite: true, canDelete: true, canManage: true, canRunAgent: true } };
    });
    const messages = [
      { id: 'old-unread', isRead: false, date: new Date(now - 100 * 86400000).toISOString() },
      { id: 'recent-read', isRead: true, date: new Date(now - 2 * 86400000).toISOString() },
      { id: 'old-read', isRead: true, date: new Date(now - 100 * 86400000).toISOString() },
    ].map(message => ({ ...message, folder: 'INBOX', from: 'customer@example.test', to: ['owner@example.test'], subject: message.id, snippet: 'Synthetic order question' }));
    let activeCatalog = catalog(); let available = true; let calls = 0; let budgetReject = false;
    const requestIds: string[] = [];
    const worker = createEmailClassificationWorker({ getStore: async () => store, now: () => time, random: () => 0.5, discoveryIntervalMs: 0, listUserIds: async () => ['owner'], resolveMailboxes: async () => mailboxes,
      ingestMetadata: input => ingestEmailClassificationMetadata(input, { store }),
      listMessages: async () => ({ messages, total: 3, hasMore: false, nextOffset: null, confirmed: true }),
      readMessage: async input => ({ ...messages.find(message => message.id === input.message.canonicalId), body: 'Synthetic support question' }),
      resolveCredential: () => { throw new Error('No local credentials in managed mode.'); }, evaluate: async () => { throw new Error('No direct provider fallback.'); },
      readManagedCatalog: async () => ({ status: available ? 'ready' : 'unavailable', code: available ? null : 'provider_unavailable', catalog: activeCatalog }),
      evaluateManaged: async (_input, _profile, id) => { calls++; requestIds.push(id); if (budgetReject) { budgetReject = false; throw new ManagedDecisionClientError('budget_exhausted', { retryable: true }); } return decision(); },
    });
    assert.equal((await worker.runCycle()).completed, 4);
    const before = await store.readSettings(); const fingerprint = emailClassificationEvaluationFingerprint(before.configuration);
    assert.equal(Number((await postgres.query<{ count: number }>('SELECT count(*) AS count FROM email_classification_results WHERE raw_json IS NOT NULL')).rows[0].count), 4);
    available = false; time += 61000;
    assert.equal((await worker.runCycle()).claimed, 0); assert.equal(calls, 4);
    assert.equal(emailClassificationEvaluationFingerprint((await store.readSettings()).configuration), fingerprint);
    assert.equal((await store.readSettings()).revision, before.revision);
    assert.equal(Number((await postgres.query<{ count: number }>('SELECT count(*) AS count FROM email_classification_results WHERE raw_json IS NOT NULL')).rows[0].count), 4);
    available = true; activeCatalog = { ...activeCatalog, catalogRevision: `sha256:${'b'.repeat(64)}` }; time += 61000;
    await worker.runCycle(); assert.equal(calls, 4, 'A catalog-only change must not repeat inference.');
    const previous = await store.readSettings();
    await store.updateSettings({ expectedRevision: previous.revision, actorUserId: 'admin', configuration: { ...previous.configuration, policy: { ...previous.configuration.policy, spamSortingValidated: true, calibrationReference: 'Synthetic labeled test set', validatedProviderId: model.providerId, validatedModel: model.model, validatedSchemaVersion: 'email-triage.v1' } }, now: time });
    activeCatalog = catalog({ ...model, inferenceRevision: decisionInferenceRevision({ providerId: model.providerId, model: model.model }, '2') }); time += 61000; budgetReject = true;
    const changed = await worker.runCycle(); assert.equal(changed.completed, 3); assert.equal(changed.retried, 1);
    assert.equal((await store.readSettings()).configuration.policy.spamSortingValidated, false);
    assert.notEqual(emailClassificationEvaluationFingerprint((await store.readSettings()).configuration), fingerprint);
    const pending = (await postgres.query<{ decision_request_id: string }>('SELECT decision_request_id FROM email_classification_jobs WHERE status = \'retry\'')).rows[0];
    assert.ok(pending); assert.ok(!requestIds.includes(String(pending.decision_request_id)), 'A confirmed budget denial gets a new persisted operation ID.');
    time += 61000; assert.equal((await worker.runCycle()).completed, 1);
    assert.equal(calls, 9);
    assert.equal(Number((await postgres.query<{ count: number }>('SELECT count(*) AS count FROM email_classification_jobs job JOIN email_classification_messages message USING(message_ref) WHERE message.canonical_id = \'old-read\'')).rows[0].count), 0);
  } finally { await postgres.close(); }
  console.log('Managed email decisions passed: catalog and response validation, no local keys, both mailbox scopes, unread plus 30-day selection, cache survival, inference revisions and safe retry IDs.');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
