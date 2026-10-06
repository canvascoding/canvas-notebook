import assert from 'node:assert/strict';
import Module from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import type { DecisionResult } from '../app/lib/decision-models/types';
import type { AuthorizedEmailClassificationMailbox } from '../app/lib/email/classification/mailbox-types';
import type { EmailClassificationWorkerDependencies, EmailClassificationWorkerPage } from '../app/lib/email/classification/worker';
import type { EmailClassificationQueryable } from '../app/lib/email/classification/store-types';

const SECRET_MARKER = 'worker-system-fixture-key';
const BODY_MARKER = 'private-body-must-never-appear-in-logs-or-index';
const BASE_NOW = 20_000 * 86_400_000 + 1_000;
const loader = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  if (request === '@/app/lib/db' || request === '@/app/lib/email/account-store') return {};
  if (request === '@/app/lib/email/mailbox-access') return { EmailMailboxAccessError: class extends Error {}, listEmailMailboxes: () => { throw new Error('Inject authorization.'); }, resolveEmailMailboxAccess: () => { throw new Error('Inject authorization.'); } };
  return originalLoad(request, parent, isMain);
};

function decision(): DecisionResult {
  return { providerId: 'typesafe', model: 'jev-1.13.0', adapterVersion: 'fixture', probabilitySemantics: 'model_probability', latencyMs: 20,
    usage: { inputTokens: 400, outputTokens: 40, requests: 1 }, answers: {
      category: { type: 'choice', choice: 'support', probabilities: { correspondence: 0, finance: 0, support: 0.9, sales: 0, security: 0, newsletter: 0, marketing: 0, notification: 0, other: 0.1 }, confidence: 0.9 },
      priority: { type: 'choice', choice: 'high', probabilities: { low: 0.02, normal: 0.04, high: 0.92, urgent: 0.02 }, confidence: 0.893333 },
      is_spam: { type: 'binary', probability: 0.02 }, needs_reply: { type: 'binary', probability: 0.98 },
    } };
}

async function main() {
  const { runEmailClassificationPostgresMigration } = await import('../app/lib/email/classification/postgres-migration');
  const { createEmailClassificationStore } = await import('../app/lib/email/classification/store');
  const { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } = await import('../app/lib/email/classification/settings-types');
  const { emailClassificationMailboxRef, emailClassificationMessageIdentity } = await import('../app/lib/email/classification/identity');
  const { ingestEmailClassificationMetadata, readEmailClassificationProjectionBatch } = await import('../app/lib/email/classification/index-service');
  const { createEmailClassificationWorker, emailClassificationRetryDelay } = await import('../app/lib/email/classification/worker');
  const { initializeEmailClassificationRuntime, notifyEmailClassificationSettingsChanged } = await import('../app/lib/email/classification/runtime');
  const { DecisionModelError } = await import('../app/lib/decision-models/errors');

  assert.equal(emailClassificationRetryDelay(1, () => 0.5), 2_000);
  assert.equal(emailClassificationRetryDelay(100, () => 0.5), 3_600_000);
  assert.equal(emailClassificationRetryDelay(1, () => 0, 10_000), 10_000);

  async function fixture(options: { enabled?: boolean; count?: number; managed?: boolean; maxHistory?: number; maxLookback?: number } = {}) {
    const postgres = new PGlite();
    await postgres.exec(`CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES ('admin'), ('owner'), ('member');`);
    await runEmailClassificationPostgresMigration(postgres as unknown as EmailClassificationQueryable);
    const store = createEmailClassificationStore({ postgres: postgres as unknown as EmailClassificationQueryable,
      transaction: operation => postgres.transaction(connection => operation(connection as unknown as EmailClassificationQueryable)) });
    let time = BASE_NOW;
    if (options.enabled !== false) await store.updateSettings({ expectedRevision: 0, actorUserId: 'admin', now: time,
      configuration: { ...structuredClone(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION), enabled: true, concurrency: 2,
        maxHistoricalMessages: options.maxHistory ?? 5_000, initialLookbackDays: options.maxLookback ?? 30 } });
    const origin = { ownerUserId: 'owner', accountSource: options.managed ? 'managed' as const : 'local' as const, accountId: 'account', provider: 'google', workspaceId: null, mailboxId: null };
    let mailboxes: AuthorizedEmailClassificationMailbox[] = [{ ...origin, mailboxRef: emailClassificationMailboxRef(origin), connectionRevision: 'connection', bindingRevision: 'binding', policyRevision: 'policy', active: true, readFrom: [], emailAddress: 'owner@example.test', displayName: null, workspaceName: null,
      capabilities: { canRead: true, canWrite: true, canDelete: true, canManage: true, canRunAgent: true } }];
    let messages: Record<string, unknown>[] = Array.from({ length: options.count ?? 1 }, (_, index) => ({ id: `message-${index}`, folder: 'INBOX', from: 'customer@example.test', to: ['owner@example.test'], subject: `Delayed order ${index}`, date: new Date(BASE_NOW - index).toISOString(), snippet: 'Please investigate', isRead: false }));
    const calls = { discovery: 0, list: [] as number[], read: 0, model: 0, credential: 0 };
    const dependencies: EmailClassificationWorkerDependencies = {
      getStore: async () => store,
      listUserIds: async () => { calls.discovery++; return ['owner', 'member']; },
      resolveMailboxes: async () => mailboxes,
      ingestMetadata: (input) => ingestEmailClassificationMetadata(input, { store }),
      listMessages: async input => {
        calls.list.push(input.offset);
        const page = messages.slice(input.offset, input.offset + input.limit);
        const more = input.offset + page.length < messages.length;
        return { messages: page, total: messages.length, confirmed: true, hasMore: more, nextOffset: more ? input.offset + input.limit : null };
      },
      readMessage: async input => {
        calls.read++;
        return { ...messages.find(message => message.id === input.message.canonicalId), body: BODY_MARKER, attachments: [{ content: 'not-for-model' }] };
      },
      evaluate: async input => {
        calls.model++;
        assert.equal(input.credential?.apiKey, SECRET_MARKER);
        assert.equal(input.schemaVersion, 'email-triage.v1');
        assert.equal(input.questions.is_spam.type, 'binary');
        assert.equal(JSON.stringify(input.state).includes('not-for-model'), false);
        return decision();
      },
      resolveCredential: () => { calls.credential++; return { value: SECRET_MARKER, status: { status: 'configured', configured: true, anonymous: false, scope: 'system', settingsLink: '/settings?tab=secrets' } }; },
      now: () => time, random: () => 0.5, claimCheckIntervalMs: 10, rawTimeoutMs: 2_000, maxPagesPerMailbox: 2, discoveryIntervalMs: 0,
    };
    return { postgres, store, calls, dependencies, worker: createEmailClassificationWorker(dependencies),
      mailbox: () => mailboxes[0], setMailboxes: (value: AuthorizedEmailClassificationMailbox[]) => { mailboxes = value; },
      messages: () => messages, setMessages: (value: Record<string, unknown>[]) => { messages = value; },
      tick: (duration: number) => { time += duration; }, now: () => time,
      ref: (message = messages[0]) => emailClassificationMessageIdentity(mailboxes[0], message as { id: string }).messageRef,
      close: async () => { await postgres.close(); },
    };
  }

  const off = await fixture({ enabled: false, count: 3 });
  try {
    const cycle = await off.worker.runCycle();
    assert.equal(cycle.discovered, 1, 'Two authorized actors do not duplicate a shared source.');
    assert.equal(cycle.indexed, 3); assert.equal(cycle.claimed, 0);
    assert.equal(off.calls.read, 0); assert.equal(off.calls.model, 0); assert.equal(off.calls.credential, 0);
    assert.equal(Number((await off.postgres.query<{ count: string }>('SELECT count(*) FROM email_classification_jobs')).rows[0].count), 0);
    assert.equal((await off.store.readMailbox(off.mailbox().mailboxRef))?.coverage, 'complete');
    const persisted = await off.store.readMessages(off.messages().map(message => off.ref(message)));
    assert.ok(persisted.every(message => message.inInbox));
    assert.equal(JSON.stringify(persisted).includes(BODY_MARKER), false);
    await off.store.updateSettings({ expectedRevision: 0, actorUserId: 'admin', configuration: { ...structuredClone(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION), enabled: true }, now: off.now() });
    const activated = await off.worker.runCycle();
    assert.equal(activated.claimed, 2, 'Activation revisits already indexed messages, including behind the head page.');
  } finally { await off.close(); }

  const active = await fixture({ count: 3 });
  try {
    const [first, same] = await Promise.all([active.worker.runCycle(), active.worker.runCycle()]);
    assert.equal(first, same, 'Concurrent ticks share one in-process cycle.');
    assert.equal(first.claimed, 2); assert.equal(first.completed, 2);
    assert.equal(active.calls.discovery, 1); assert.equal(active.calls.list.length, 1);
    const second = await active.worker.runCycle();
    assert.equal(second.completed, 1); assert.equal(active.calls.model, 3);
    assert.equal((await active.store.readMessages([active.ref()]))[0].list.isRead, false, 'Classification never marks messages as read.');
    assert.equal(JSON.stringify((await active.store.readMessages([active.ref()]))[0]).includes(BODY_MARKER), false);
    const setting = await active.store.readSettings();
    const changed = await active.store.updateSettings({ expectedRevision: setting.revision, actorUserId: 'admin', configuration: { ...setting.configuration, concurrency: 1 }, now: active.now() });
    const metadata = (await active.store.readMessages([active.ref()]))[0];
    await active.store.enqueueClassification({ messageRef: metadata.messageRef, configurationRevision: changed.revision, fingerprint: metadata.fingerprint, now: active.now() });
    const reused = await active.worker.runCycle();
    assert.equal(reused.reused, 1); assert.equal(active.calls.read, 3); assert.equal(active.calls.model, 3, 'Current durable raw ratings avoid body and provider calls.');
  } finally { await active.close(); }

  const paging = await fixture({ enabled: false, count: 125 });
  try {
    await paging.worker.runCycle();
    assert.equal((await paging.store.readMailbox(paging.mailbox().mailboxRef))?.coverage, 'partial');
    paging.setMessages([{ id: 'new-head', folder: 'INBOX', from: 'customer@example.test', subject: 'New important message', date: new Date(BASE_NOW).toISOString(), snippet: 'New' }, ...paging.messages()]);
    paging.tick(61_000);
    await paging.worker.runCycle();
    await paging.worker.runCycle();
    const all = await paging.store.readMessages(paging.messages().map(message => paging.ref(message)));
    assert.equal(all.length, 126, 'Overlap and a fresh head pass survive an insertion during pagination.');
    assert.equal((await paging.store.readMailbox(paging.mailbox().mailboxRef))?.coverage, 'complete');
    assert.ok(paging.calls.list.some(offset => offset > 0));
    assert.ok(paging.calls.list.filter(offset => offset === 0).length >= 2);
    const removed = paging.messages().find(message => message.id === 'message-120')!;
    const removedRef = paging.ref(removed);
    paging.setMessages(paging.messages().filter(message => message !== removed));
    paging.tick(61_000);
    await paging.worker.runCycle();
    assert.equal((await paging.store.readMessages([removedRef]))[0].inInbox, true, 'A partial scan must retain previously indexed Inbox membership.');
    await paging.worker.runCycle();
    assert.equal((await paging.store.readMessages([removedRef]))[0].inInbox, false, 'A confirmed full scan removes an externally archived item beyond the head page.');
    assert.equal((await paging.store.readMailbox(paging.mailbox().mailboxRef))?.coverage, 'complete');
  } finally { await paging.close(); }

  const bounded = await fixture({ enabled: false, managed: true });
  try {
    const page: EmailClassificationWorkerPage = { messages: bounded.messages(), total: null, hasMore: false, nextOffset: null, confirmed: false };
    const worker = createEmailClassificationWorker({ ...bounded.dependencies, listMessages: async () => page });
    await worker.runCycle();
    assert.equal((await bounded.store.readMailbox(bounded.mailbox().mailboxRef))?.coverage, 'partial', 'Unacknowledged managed pages never imply complete coverage.');
    bounded.tick(61_000);
    const scanLimited = createEmailClassificationWorker({ ...bounded.dependencies, listMessages: async () => ({ ...page, confirmed: true }) });
    await scanLimited.runCycle();
    assert.equal((await bounded.store.readMailbox(bounded.mailbox().mailboxRef))?.coverage, 'partial', 'A provider scan ceiling without a total remains partial.');
    bounded.tick(61_000);
    const offsetLimited = createEmailClassificationWorker({ ...bounded.dependencies, listMessages: async () => ({ ...page, confirmed: true, hasMore: true, nextOffset: 10_001 }) });
    await offsetLimited.runCycle();
    assert.equal((await bounded.store.readMailbox(bounded.mailbox().mailboxRef))?.coverage, 'partial');
    bounded.tick(61_000);
    const unconfirmedEmpty = createEmailClassificationWorker({ ...bounded.dependencies, listMessages: async () => ({ messages: [], total: null, hasMore: false, nextOffset: null, confirmed: false }) });
    await unconfirmedEmpty.runCycle();
    assert.equal((await bounded.store.readMessages([bounded.ref()]))[0].inInbox, true, 'Partial or unacknowledged scans cannot reconcile missing emails.');
    bounded.tick(61_000);
    const inconsistentTotal = createEmailClassificationWorker({ ...bounded.dependencies, listMessages: async () => ({ messages: [], total: 100, hasMore: false, nextOffset: null, confirmed: true }) });
    await inconsistentTotal.runCycle();
    assert.equal((await bounded.store.readMailbox(bounded.mailbox().mailboxRef))?.coverage, 'partial');
    assert.equal((await bounded.store.readMessages([bounded.ref()]))[0].inInbox, true, 'An acknowledged but truncated result cannot prove complete membership.');
  } finally { await bounded.close(); }

  const changedDuringScan = await fixture({ enabled: false });
  try {
    const source = changedDuringScan.mailbox();
    const worker = createEmailClassificationWorker({ ...changedDuringScan.dependencies, listMessages: async () => {
      changedDuringScan.setMailboxes([{ ...source, policyRevision: 'new-policy' }]);
      return { messages: changedDuringScan.messages(), total: 1, hasMore: false, nextOffset: null, confirmed: true };
    } });
    const cycle = await worker.runCycle();
    assert.equal(cycle.synced, 0, 'A fresh policy change fences cursor and membership publication.');
    assert.equal((await changedDuringScan.store.readMailbox(source.mailboxRef))?.coverage, 'pending');
  } finally { await changedDuringScan.close(); }

  const history = await fixture({ count: 3, maxHistory: 2 });
  try {
    const cycle = await history.worker.runCycle();
    assert.equal(cycle.indexed, 3); assert.equal(cycle.completed, 2);
    assert.equal(history.calls.model, 2, 'Initial historical analysis stays bounded independently of metadata.');
  } finally { await history.close(); }

  const historyRevision = await fixture({ count: 3, maxHistory: 2 });
  try {
    let settings = await historyRevision.store.readSettings();
    settings = await historyRevision.store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, concurrency: 1 }, now: historyRevision.now() });
    assert.equal((await historyRevision.worker.runCycle()).completed, 1);
    assert.equal(Number((await historyRevision.postgres.query<{ count: string }>("SELECT count(*) FROM email_classification_jobs WHERE status = 'pending'")).rows[0].count), 1);
    await historyRevision.store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, concurrency: 2 }, now: historyRevision.now() });
    historyRevision.worker.cancelActive();
    historyRevision.tick(61_000);
    assert.equal((await historyRevision.worker.runCycle()).completed, 1, 'A previously selected historical email is re-enqueued after runtime settings change despite an exhausted cap.');
    assert.equal(historyRevision.calls.model, 2);
    assert.equal((await historyRevision.store.readResultsBatch(historyRevision.messages().map(message => historyRevision.ref(message)))).length, 2);
    assert.equal(JSON.parse((await historyRevision.store.readMailbox(historyRevision.mailbox().mailboxRef))!.syncCursor!).historicalQueued, 2);
  } finally { await historyRevision.close(); }

  const overlap = await fixture({ count: 130, maxHistory: 100 });
  try {
    await overlap.worker.runCycle();
    await overlap.worker.runCycle();
    const selected = (await overlap.postgres.query<{ count: string }>('SELECT count(DISTINCT message_ref) AS count FROM email_classification_jobs')).rows[0];
    assert.equal(Number(selected.count), 100, 'Pagination overlap never consumes historical capacity twice for the same message.');
    assert.equal(JSON.parse((await overlap.store.readMailbox(overlap.mailbox().mailboxRef))!.syncCursor!).historicalQueued, 100);
  } finally { await overlap.close(); }

  const discovery = await fixture({ enabled: false });
  try {
    const worker = createEmailClassificationWorker({ ...discovery.dependencies, discoveryIntervalMs: 1 });
    await worker.runCycle();
    discovery.tick(5_000); await worker.runCycle();
    assert.equal(discovery.calls.discovery, 1, 'Full discovery is bounded even when a smaller production interval is requested.');
    discovery.tick(55_000); await worker.runCycle();
    assert.equal(discovery.calls.discovery, 2);
    worker.cancelActive(); await worker.runCycle();
    assert.equal(discovery.calls.discovery, 3, 'A settings notification invalidates bounded discovery immediately.');
  } finally { await discovery.close(); }

  const cachedAuthorization = await fixture({ count: 2 });
  try {
    const settings = await cachedAuthorization.store.readSettings();
    await cachedAuthorization.store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, concurrency: 1 }, now: cachedAuthorization.now() });
    const worker = createEmailClassificationWorker({ ...cachedAuthorization.dependencies, discoveryIntervalMs: 60_000 });
    assert.equal((await worker.runCycle()).completed, 1);
    cachedAuthorization.setMailboxes([]);
    const cycle = await worker.runCycle();
    assert.equal(cycle.canceled, 1); assert.equal(cachedAuthorization.calls.discovery, 1);
    assert.equal(cachedAuthorization.calls.read, 1); assert.equal(cachedAuthorization.calls.model, 1, 'Bounded discovery never replaces fresh per-job authorization.');
  } finally { await cachedAuthorization.close(); }

  const unknownSource = await fixture();
  try {
    const original = unknownSource.mailbox();
    const added = { ...original, accountId: 'new-account', bindingRevision: 'new-binding', mailboxRef: emailClassificationMailboxRef({ ...original, accountId: 'new-account' }) };
    const addedMessage = { ...unknownSource.messages()[0], id: 'new-source-message' };
    const worker = createEmailClassificationWorker({ ...unknownSource.dependencies, discoveryIntervalMs: 60_000,
      readMessage: async input => input.mailbox.mailboxRef === added.mailboxRef ? { ...addedMessage, body: BODY_MARKER } : unknownSource.dependencies.readMessage!(input) });
    assert.equal((await worker.runCycle()).completed, 1);
    unknownSource.setMailboxes([original, added]);
    await unknownSource.store.upsertMailbox(added, unknownSource.now());
    await ingestEmailClassificationMetadata({ mailbox: added, message: addedMessage, enqueue: true, inInbox: true, inboxSeenAt: unknownSource.now(), now: unknownSource.now() }, { store: unknownSource.store });
    const cycle = await worker.runCycle();
    assert.equal(cycle.completed, 1); assert.equal(cycle.canceled, 0);
    assert.equal(unknownSource.calls.discovery, 2, 'A foreground-enqueued unknown source forces one fresh catalogue pass before execution.');
  } finally { await unknownSource.close(); }

  const fair = await fixture({ count: 3 });
  try {
    const original = fair.mailbox();
    const second = { ...original, accountId: 'second-account', bindingRevision: 'second-binding', mailboxRef: emailClassificationMailboxRef({ ...original, accountId: 'second-account' }) };
    const secondMessage = { ...fair.messages()[0], id: 'second-source-message' };
    fair.setMailboxes([original, second]);
    const settings = await fair.store.readSettings();
    await fair.store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, concurrency: 1 }, now: fair.now() });
    const processed: string[] = [];
    const worker = createEmailClassificationWorker({ ...fair.dependencies,
      listMessages: async input => {
        if (input.mailbox.mailboxRef !== second.mailboxRef) return fair.dependencies.listMessages!(input);
        fair.tick(1);
        return { messages: [secondMessage], total: 1, hasMore: false, nextOffset: null, confirmed: true };
      },
      readMessage: async input => { processed.push(input.mailbox.accountId); return input.mailbox.mailboxRef === second.mailboxRef ? { ...secondMessage, body: BODY_MARKER } : fair.dependencies.readMessage!(input); },
    });
    assert.equal((await worker.runCycle()).completed, 1);
    fair.tick(1);
    assert.equal((await worker.runCycle()).completed, 1);
    assert.deepEqual(processed, [original.accountId, second.accountId], 'With concurrency one, the next batch visits a second actual mailbox before continuing the older backlog.');
  } finally { await fair.close(); }

  const old = await fixture({ maxLookback: 1 });
  try {
    old.setMessages([{ ...old.messages()[0], date: new Date(BASE_NOW - 2 * 86_400_000).toISOString() }]);
    const cycle = await old.worker.runCycle();
    assert.equal(cycle.indexed, 1); assert.equal(cycle.claimed, 0); assert.equal(old.calls.read, 0);
  } finally { await old.close(); }

  const restricted = await fixture();
  try {
    restricted.setMailboxes([{ ...restricted.mailbox(), policyRevision: 'restricted', readFrom: ['allowed@example.test'] }]);
    const cycle = await restricted.worker.runCycle();
    assert.equal(cycle.indexed, 1); assert.equal(cycle.claimed, 0); assert.equal(restricted.calls.read, 0); assert.equal(restricted.calls.model, 0, 'Personal AI also respects sender restrictions.');
  } finally { await restricted.close(); }

  let listProvider: (ownerUserId: string, parameters: Record<string, unknown>, options: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => { throw new Error('Inject the default list provider.'); };
  let readProvider: (ownerUserId: string, accountId: string, canonicalId: string, folder: string, options: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => { throw new Error('Inject the default read provider.'); };
  const defaultServiceFixture = {
    listEmailMessages: (...args: Parameters<typeof listProvider>) => listProvider(...args),
    readEmailMessage: (...args: Parameters<typeof readProvider>) => readProvider(...args),
  };
  for (const policyScope of ['personal-restricted', 'work-restricted', 'work-allowed'] as const) {
    const policy = await fixture();
    const previousLoad = loader._load;
    try {
      const workspace = policyScope.startsWith('work');
      const allowed = policyScope === 'work-allowed';
      const origin = { ...policy.mailbox(), workspaceId: workspace ? 'policy-workspace' : null, mailboxId: workspace ? 'policy-mailbox' : null };
      const mailbox = { ...origin, mailboxRef: emailClassificationMailboxRef(origin), policyRevision: policyScope,
        readFrom: [allowed ? 'customer@example.test' : 'owner@example.test'] };
      policy.setMailboxes([mailbox]);
      const listPolicies: boolean[] = [];
      const bodyPolicies: boolean[] = [];
      listProvider = async (ownerUserId: string, parameters: Record<string, unknown>, options: Record<string, unknown>) => {
        assert.equal(ownerUserId, mailbox.ownerUserId);
        assert.equal(parameters.accountId, mailbox.accountId);
        assert.equal(parameters.folder, 'INBOX');
        assert.equal(options.actorUserId, mailbox.ownerUserId);
        assert.equal(options.workspaceId, mailbox.workspaceId);
        assert.equal(options.cacheMode, 'provider');
        assert.equal(options.skipClassification, true);
        assert.equal(options.prefetchDetails, false);
        listPolicies.push(options.enforceReadPolicy === true);
        const messages = options.enforceReadPolicy && !allowed ? [] : policy.messages();
        return { messages, total: messages.length, hasMore: false, nextOffset: null };
      };
      readProvider = async (_ownerUserId: string, _accountId: string, canonicalId: string, _folder: string, options: Record<string, unknown>) => {
        bodyPolicies.push(options.enforceReadPolicy === true);
        policy.calls.read++;
        return { message: { ...policy.messages()[0], id: canonicalId, body: BODY_MARKER } };
      };
      loader._load = (request, parent, isMain) => {
        if (request === '@/app/lib/email/service' || request.endsWith('/app/lib/email/service.ts')) return defaultServiceFixture;
        return previousLoad(request, parent, isMain);
      };
      const worker = createEmailClassificationWorker({ ...policy.dependencies, listMessages: undefined, readMessage: undefined });
      const cycle = await worker.runCycle();
      assert.deepEqual(listPolicies, [workspace], 'Default metadata retrieval follows the human read policy: full personal Inbox, restricted work Inbox.');
      assert.equal((await policy.store.readMailbox(mailbox.mailboxRef))?.coverage, 'complete', 'Confirmed human-visible coverage stays honest even when AI cannot evaluate that sender.');
      assert.equal(cycle.indexed, policyScope === 'work-restricted' ? 0 : 1);
      if (allowed) {
        assert.deepEqual(bodyPolicies, [true], 'The default body retrieval retains the AI read policy.');
        assert.equal(cycle.completed, 1);
      } else {
        assert.deepEqual(bodyPolicies, []); assert.equal(policy.calls.read, 0); assert.equal(policy.calls.model, 0);
        assert.equal(cycle.claimed, 0, 'AI-ineligible senders never create model jobs.');
        if (!workspace) {
          const metadata = (await policy.store.readMessages([policy.ref()]))[0];
          assert.equal(metadata.inInbox, true, 'Personal human-visible metadata survives reconciliation although the AI sender policy excludes it.');
          const projected = await readEmailClassificationProjectionBatch({ actorUserId: 'owner', mailbox, messages: policy.messages() }, { store: policy.store });
          assert.equal(projected.get(metadata.messageRef)?.classification.status, 'pending');
        }
      }
    } finally { loader._load = previousLoad; await policy.close(); }
  }

  for (const boundary of ['before_body', 'before_model', 'before_publication'] as const) {
    const revoke = await fixture();
    try {
      const source = revoke.mailbox();
      let modelCalls = 0;
      let readCalls = 0;
      if (boundary === 'before_body') {
        const claimJobs = revoke.store.claimJobs.bind(revoke.store);
        revoke.store.claimJobs = async input => { const claimed = await claimJobs(input); revoke.setMailboxes([]); return claimed; };
      }
      const worker = createEmailClassificationWorker({ ...revoke.dependencies,
        readMessage: async input => { readCalls++; if (boundary === 'before_model') revoke.setMailboxes([]); return { ...revoke.messages()[0], id: input.message.canonicalId, body: BODY_MARKER }; },
        evaluate: async () => { modelCalls++; if (boundary === 'before_publication') revoke.setMailboxes([]); return decision(); },
      });
      const cycle = await worker.runCycle();
      assert.equal(cycle.completed, 0); assert.equal(cycle.canceled, 1);
      assert.equal(readCalls, boundary === 'before_body' ? 0 : 1);
      assert.equal(modelCalls, boundary === 'before_publication' ? 1 : 0);
      assert.deepEqual(await revoke.store.readResultsBatch([emailClassificationMessageIdentity(source, revoke.messages()[0] as { id: string }).messageRef]), []);
    } finally { await revoke.close(); }
  }

  const stoppedInFlight = await fixture();
  try {
    let signal: AbortSignal | undefined;
    const worker = createEmailClassificationWorker({ ...stoppedInFlight.dependencies, evaluate: async input => {
      signal = input.signal;
      const settings = await stoppedInFlight.store.readSettings();
      await stoppedInFlight.store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, enabled: false }, now: stoppedInFlight.now() });
      return new Promise<DecisionResult>(() => undefined);
    } });
    const cycle = await worker.runCycle();
    assert.equal(signal?.aborted, true, 'The DB settings watchdog cancels a stalled provider after disable.');
    assert.equal(cycle.completed, 0); assert.equal(cycle.canceled, 1);
    assert.deepEqual(await stoppedInFlight.store.readResultsBatch([stoppedInFlight.ref()]), []);
  } finally { await stoppedInFlight.close(); }

  const rateLimited = await fixture();
  try {
    let modelCalls = 0;
    const worker = createEmailClassificationWorker({ ...rateLimited.dependencies, evaluate: async () => {
      modelCalls++;
      if (modelCalls === 1) throw new DecisionModelError('rate_limited', { retryable: true, retryAfterMs: 5_000 });
      return decision();
    } });
    const first = await worker.runCycle();
    assert.equal(first.retried, 1);
    assert.equal((await worker.runCycle()).claimed, 0, 'The provider circuit breaker avoids immediate retries.');
    assert.equal(modelCalls, 1);
    rateLimited.tick(5_001);
    assert.equal((await worker.runCycle()).completed, 1); assert.equal(modelCalls, 2);
    assert.equal(JSON.stringify((await rateLimited.postgres.query('SELECT error_code FROM email_classification_jobs')).rows).includes(BODY_MARKER), false);
  } finally { await rateLimited.close(); }

  const attempts = await fixture();
  try {
    const worker = createEmailClassificationWorker({ ...attempts.dependencies, maxAttempts: 1, evaluate: async () => { throw new DecisionModelError('provider_error', { retryable: true }); } });
    assert.equal((await worker.runCycle()).failed, 1, 'Retry attempts are bounded.');
    attempts.tick(60_000);
    assert.equal((await worker.runCycle()).claimed, 0);
  } finally { await attempts.close(); }

  const html = await fixture();
  try {
    const worker = createEmailClassificationWorker({ ...html.dependencies, readMessage: async input => ({ ...html.messages()[0], id: input.message.canonicalId, body: '', bodyHtml: `<html><style>STYLE_SECRET</style><script>SCRIPT_SECRET</script><body><p>${'x'.repeat(80_000)}</p></body></html>`, attachments: [BODY_MARKER] }),
      evaluate: async input => {
        const state = input.state as { email: { body: string } };
        assert.ok(state.email.body.length <= 16_000); assert.equal(state.email.body.includes('SCRIPT_SECRET'), false); assert.equal(state.email.body.includes('STYLE_SECRET'), false);
        assert.equal(JSON.stringify(input.state).includes(BODY_MARKER), false);
        return decision();
      } });
    assert.equal((await worker.runCycle()).completed, 1);
    assert.equal((await html.store.readResultsBatch([html.ref()]))[0].raw?.bodyWasTruncated, true);
  } finally { await html.close(); }

  const runtimeFixture = await fixture();
  let runtime: ReturnType<typeof initializeEmailClassificationRuntime> | undefined;
  const originalPhase = process.env.NEXT_PHASE;
  try {
    process.env.NEXT_PHASE = 'phase-production-build';
    assert.equal(initializeEmailClassificationRuntime(runtimeFixture.dependencies).started, false, 'Production builds never start background timers.');
    if (originalPhase === undefined) delete process.env.NEXT_PHASE; else process.env.NEXT_PHASE = originalPhase;
    let signal: AbortSignal | undefined;
    let started: () => void = () => undefined;
    const evaluationStarted = new Promise<void>(resolve => { started = resolve; });
    runtime = initializeEmailClassificationRuntime({ ...runtimeFixture.dependencies, initialDelayMs: 0, intervalMs: 10_000,
      evaluate: async input => { signal = input.signal; started(); return new Promise<DecisionResult>(() => undefined); } });
    assert.equal(runtime.started, true);
    const duplicate = initializeEmailClassificationRuntime(runtimeFixture.dependencies);
    assert.equal(duplicate.started, false); assert.equal(duplicate.trigger, runtime.trigger, 'The global runtime is idempotent across bundles.');
    await evaluationStarted;
    const settings = await runtimeFixture.store.readSettings();
    await runtimeFixture.store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, enabled: false }, now: runtimeFixture.now() });
    assert.equal(notifyEmailClassificationSettingsChanged(), true);
    assert.equal(signal?.aborted, true, 'Process notification immediately aborts active model requests.');
    runtime.stop();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(notifyEmailClassificationSettingsChanged(), false);
  } finally {
    runtime?.stop();
    if (originalPhase === undefined) delete process.env.NEXT_PHASE; else process.env.NEXT_PHASE = originalPhase;
    await runtimeFixture.close();
  }
  console.log('Email classification worker passed: closed-browser metadata, bounded discovery, unique history selection, revision recovery, cross-batch fairness, paging, reuse, policy boundaries, cancellation, backoff, limits and idempotent runtime.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { loader._load = originalLoad; });
