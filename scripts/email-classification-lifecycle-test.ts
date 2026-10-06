import assert from 'node:assert/strict';
import Module from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { runEmailClassificationPostgresMigration } from '../app/lib/email/classification/postgres-migration';
import { createEmailClassificationStore } from '../app/lib/email/classification/store';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } from '../app/lib/email/classification/settings-types';
import type { EmailClassificationQueryable } from '../app/lib/email/classification/store-types';
import type { AuthorizedEmailClassificationMailbox } from '../app/lib/email/classification/mailbox-types';
import type { EmailClassificationRaw } from '../app/lib/email/classification/types';

const loader = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = loader._load;
let serviceMocks = false;
let providerFails = false;
let managedAvailable = false;
const events: string[] = [];
const notifications: Array<Record<string, unknown>> = [];
const account = { id: 'first', provider: 'google', authType: 'smtp_imap', status: 'active', emailAddress: 'first@example.test' };
const remote = { id: 'remote', provider: 'google', status: 'active', emailAddress: 'remote@example.test' };
const operationResult = { success: true, account };
const providerOperation = async (name: string, value: unknown = operationResult) => {
  events.push(`provider:${name}`);
  if (providerFails) throw new Error('Provider operation failed');
  return value;
};
const failedStore = {
  invalidateAccount: async () => { events.push('classification:unavailable'); throw new Error('Classification database unavailable'); },
  updateIndexedMessageState: async () => { events.push('classification:unavailable'); throw new Error('Classification database unavailable'); },
};
let lifecycle: typeof import('../app/lib/email/classification/lifecycle');
loader._load = (request, parent, isMain) => {
  if (request === 'server-only' || request === '@/app/lib/db' || request === '@/app/lib/email/account-store') return {};
  if (serviceMocks) {
    if (request.endsWith('/email/classification/lifecycle') || request.endsWith('/email/classification/lifecycle.ts')) return {
      notifyEmailClassificationAccountChanged: async (input: Parameters<typeof lifecycle.notifyEmailClassificationAccountChanged>[0]) => {
        notifications.push(input); events.push('notify:account'); return lifecycle.notifyEmailClassificationAccountChanged(input, { store: failedStore });
      },
      notifyEmailClassificationMessageChanged: async (input: Parameters<typeof lifecycle.notifyEmailClassificationMessageChanged>[0]) => {
        notifications.push(input); events.push('notify:message'); return lifecycle.notifyEmailClassificationMessageChanged(input, { store: failedStore });
      },
    };
    if (request.endsWith('/email/local-service')) return {
      listLocalEmailAccounts: async () => [account],
      resolveLocalEmailCacheAccount: async () => ({ account, provider: 'google' }),
      updateLocalEmailPolicy: () => providerOperation('policy', account),
      disconnectLocalEmailAccount: () => providerOperation('disconnect'),
      setLocalEmailMessageRead: () => providerOperation('read'),
      setLocalEmailMessageAnswered: () => providerOperation('answered'),
      archiveLocalEmailMessage: () => providerOperation('archive'),
      moveLocalEmailMessage: () => providerOperation('move'),
      trashLocalEmailMessage: () => providerOperation('trash'),
      deleteLocalEmailMessagePermanently: () => providerOperation('delete'),
    };
    if (request.endsWith('/email/cache/read-through')) return { emailMessageCacheRef: () => ({ messageId: 'same-id' }) };
    if (request.endsWith('/email/cache/consistency')) return {
      runLocalEmailMessageReadMutation: async (_input: unknown, operation: () => Promise<unknown>) => operation(),
      runLocalEmailMailboxMutation: async (_input: unknown, operation: () => Promise<unknown>) => operation(),
      purgeEmailMailboxCache: async () => { events.push('cache:purge'); },
      reactivateEmailMailboxCache: async () => { events.push('cache:reactivate'); },
    };
    if (request.endsWith('/email/smtp-service')) return { saveSmtpEmailAccount: () => providerOperation('save-smtp', account) };
    if (request.endsWith('/email/managed-client')) return {
      isManagedEmailAvailable: () => managedAvailable,
      managedEmailRequest: async (url: string) => url.endsWith('/accounts') ? { accounts: [remote] }
        : providerOperation(url.endsWith('/policy') ? 'managed-policy' : 'managed-disconnect', { account: remote, success: true }),
    };
    if (['/email/cache/store', '/email/attachments'].some(suffix => request.endsWith(suffix))) return {};
  }
  return originalLoad(request, parent, isMain);
};

const now = 1_790_000_000_000;
const raw: EmailClassificationRaw = {
  category: 'support', categoryProbabilities: { support: 0.9, other: 0.1 }, categoryConfidence: 0.9,
  priority: 'normal', priorityProbabilities: { normal: 0.9, high: 0.1 }, priorityConfidence: 0.9,
  spamProbability: 0.02, replyProbability: 0.95, providerId: 'typesafe', model: 'jev-1.13.0',
  adapterVersion: 'fixture', schemaVersion: 'email-triage.v1', probabilitySemantics: 'model_probability', calibrationReference: null,
  latencyMs: 10, evaluatedAt: now, evaluatedBodyCharacters: 30, bodyWasTruncated: false, usage: null,
};

async function verifyDurableLifecycle() {
  const postgres = new PGlite();
  try {
    const { emailClassificationMailboxRef } = await import('../app/lib/email/classification/identity');
    const { createImapMessageReference } = await import('../app/lib/email/imap-service');
    const { ingestEmailClassificationMetadata, readEmailClassificationProjectionBatch } = await import('../app/lib/email/classification/index-service');
    lifecycle = await import('../app/lib/email/classification/lifecycle');
    await postgres.exec('CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES (\'owner\'),(\'other-owner\');');
    await runEmailClassificationPostgresMigration(postgres);
    const store = createEmailClassificationStore({ postgres: postgres as unknown as EmailClassificationQueryable,
      transaction: operation => postgres.transaction(connection => operation(connection as unknown as EmailClassificationQueryable)) });
    const source = (accountId: string, ownerUserId = 'owner'): AuthorizedEmailClassificationMailbox => {
      const input = { ownerUserId, accountSource: 'local' as const, accountId, workspaceId: null, mailboxId: null };
      return { ...input, mailboxRef: emailClassificationMailboxRef(input), provider: 'imap', bindingRevision: 'binding-1', policyRevision: 'policy-1',
        active: true, readFrom: [], emailAddress: `${accountId}@example.test`, displayName: null, workspaceName: null,
        capabilities: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManage: true } };
    };
    const first = source('first'); const second = source('second'); const otherOwner = source('first', 'other-owner');
    for (const mailbox of [first, second, otherOwner]) await store.upsertMailbox(mailbox, now);
    let settings = await store.updateSettings({ expectedRevision: 0, actorUserId: 'owner',
      configuration: { ...structuredClone(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION), enabled: true, concurrency: 4 }, now });
    const mail = (folder = 'INBOX') => ({ id: createImapMessageReference(folder, '10', 7), folder,
      from: 'customer@example.test', subject: 'Please respond', date: new Date(now).toISOString(), snippet: 'Question', isRead: false, isAnswered: false });
    const initial = mail(); const otherFolder = mail('Other');
    const firstMetadata = await ingestEmailClassificationMetadata({ mailbox: first, message: initial, enqueue: true, settings, provenance: 'imap', now: now + 1 }, { store });
    const secondMetadata = await ingestEmailClassificationMetadata({ mailbox: second, message: initial, enqueue: true, settings, provenance: 'imap', now: now + 1 }, { store });
    const otherOwnerMetadata = await ingestEmailClassificationMetadata({ mailbox: otherOwner, message: initial, enqueue: true, settings, provenance: 'imap', now: now + 1 }, { store });
    const otherFolderMetadata = await ingestEmailClassificationMetadata({ mailbox: first, message: otherFolder, enqueue: false, settings, provenance: 'imap', now: now + 1 }, { store });
    assert(firstMetadata && secondMetadata && otherOwnerMetadata && otherFolderMetadata);
    assert.equal(firstMetadata.canonicalId, secondMetadata.canonicalId); assert.equal(firstMetadata.canonicalId, otherOwnerMetadata.canonicalId);
    assert.notEqual(firstMetadata.messageRef, secondMetadata.messageRef);
    const claims = await store.claimJobs({ limit: 4, leaseMs: 10_000, now: now + 2 });
    assert.equal(claims.length, 3);
    for (const claim of claims) assert.equal(await store.completeJob({ jobId: claim.id, claimToken: claim.claimToken!, raw, now: now + 3 }), true);
    const evaluated = (await store.readResultsBatch([firstMetadata.messageRef]))[0];
    const overridden = await store.updateOverride({ messageRef: firstMetadata.messageRef, expectedVersion: evaluated.version, overrides: { category: 'finance' }, now: now + 4 });
    const change = { ownerUserId: 'owner', accountId: 'first', accountSource: 'local' as const, messageId: initial.id, folder: initial.folder };
    const unaffectedRefs = [secondMetadata.messageRef, otherOwnerMetadata.messageRef, otherFolderMetadata.messageRef];
    const messageState = async () => (await store.readMessages(unaffectedRefs)).map(value => {
      const record: Record<string, unknown> = { ...value }; delete record.mailbox; return record;
    }).sort((left, right) => String(left.messageRef).localeCompare(String(right.messageRef)));
    const untouched = await messageState();
    assert.equal(await lifecycle.notifyEmailClassificationMessageChanged({ ...change, read: true }, { store }), true);
    const read = (await store.readMessages([firstMetadata.messageRef]))[0];
    assert.equal(read.list.isRead, true); assert.deepEqual(await store.readPersonalFocusStates('owner', [read.messageRef]), [], 'Reading does not mark personal completion');
    let projection = await readEmailClassificationProjectionBatch({ actorUserId: 'owner', mailbox: first, messages: [{ ...initial, isRead: true }], settings, provenance: 'cache' }, { store });
    assert.equal(projection.get(read.messageRef)?.classification.personallyDone, false);
    assert.equal(projection.get(read.messageRef)?.classification.group, 'reply', 'A read email still needs its response');
    assert.equal(await lifecycle.notifyEmailClassificationMessageChanged({ ...change, answered: true }, { store }), true);
    const refreshed = await ingestEmailClassificationMetadata({ mailbox: first, message: { ...initial, isRead: true }, enqueue: false, provenance: 'cache', now: now + 5 }, { store });
    assert.equal(refreshed?.replyStatus, 'answered', 'An unknown cache refresh preserves the known answered state');
    projection = await readEmailClassificationProjectionBatch({ actorUserId: 'owner', mailbox: first, messages: [{ ...initial, isRead: true }], settings, provenance: 'cache' }, { store });
    assert.equal(projection.get(read.messageRef)?.classification.replyStatus, 'answered');
    assert.equal(projection.get(read.messageRef)?.classification.group, 'other');
    assert.deepEqual(await messageState(), untouched, 'Same UID/UIDVALIDITY in another account, owner or folder stays untouched');

    await store.setPersonalFocusState({ userId: 'owner', messageRef: firstMetadata.messageRef, expectedVersion: 0, done: true, now: now + 6 });
    settings = await store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'owner', configuration: { ...settings.configuration, model: 'jev-1.13.1' }, now: now + 7 });
    const pending = await store.enqueueClassification({ messageRef: firstMetadata.messageRef, fingerprint: firstMetadata.fingerprint, configurationRevision: settings.revision, now: now + 8 });
    assert(pending);
    assert.equal(await lifecycle.notifyEmailClassificationMessageChanged({ ...change, leaveInbox: true }, { store }), true);
    const archived = (await store.readMessages([firstMetadata.messageRef]))[0];
    assert.equal(archived.inInbox, false); assert.equal((await store.readJob(pending.id))?.status, 'canceled');
    assert.deepEqual((await store.readResultsBatch([firstMetadata.messageRef]))[0].raw, evaluated.raw, 'Archive/trash retain original ratings');
    assert.deepEqual((await store.readResultsBatch([firstMetadata.messageRef]))[0].overrides, overridden.overrides, 'Archive/trash retain human corrections');
    assert.equal((await store.readPersonalFocusStates('owner', [firstMetadata.messageRef]))[0].done, true);
    assert.equal((await store.readMessages([secondMetadata.messageRef]))[0].inInbox, true);
    assert.equal(await lifecycle.notifyEmailClassificationMessageChanged({ ...change, remove: true }, { store }), true);
    assert.deepEqual(await store.readMessages([firstMetadata.messageRef]), []);
    for (const table of ['email_classification_results', 'email_classification_jobs', 'email_classification_personal_focus']) {
      assert.equal((await postgres.query<{ count: number }>(`SELECT count(*) AS count FROM ${table} WHERE message_ref = $1`, [firstMetadata.messageRef])).rows[0].count, 0, `${table} cascades on permanent deletion`);
    }
    assert.equal((await store.readMessages([secondMetadata.messageRef])).length, 1);
    assert.equal((await store.readResultsBatch([secondMetadata.messageRef])).length, 1, 'Permanent deletion never touches another account result');

    const secondPending = await store.enqueueClassification({ messageRef: secondMetadata.messageRef, fingerprint: secondMetadata.fingerprint, configurationRevision: settings.revision, now: now + 9 });
    const otherPending = await store.enqueueClassification({ messageRef: otherOwnerMetadata.messageRef, fingerprint: otherOwnerMetadata.fingerprint, configurationRevision: settings.revision, now: now + 9 });
    assert(secondPending && otherPending);
    assert.equal(await lifecycle.notifyEmailClassificationAccountChanged({ ownerUserId: 'owner', accountId: 'second', accountSource: 'local' }, { store }), true);
    assert.equal((await store.readMailbox(second.mailboxRef))?.active, false);
    assert.equal((await store.readJob(secondPending.id))?.status, 'canceled');
    assert.equal((await store.readJob(otherPending.id))?.status, 'pending', 'Account invalidation cancels only that owner/account/source');
    assert.equal((await store.readMailbox(otherOwner.mailboxRef))?.active, true);
    assert.equal((await postgres.query<{ count: number }>('SELECT count(*) AS count FROM email_classification_results WHERE message_ref = $1', [secondMetadata.messageRef])).rows[0].count, 1, 'Disconnect retains durable results while removing their availability');

    const localOverlap = { ...source('overlap'), provider: 'google' };
    const remoteInput = { ...localOverlap, accountSource: 'managed' as const };
    const managedOverlap = { ...remoteInput, mailboxRef: emailClassificationMailboxRef(remoteInput) };
    for (const mailbox of [localOverlap, managedOverlap]) await store.upsertMailbox(mailbox, now + 10);
    const oauthMail = { ...initial, id: 'same-provider-id' };
    const localOverlapMetadata = await ingestEmailClassificationMetadata({ mailbox: localOverlap, message: oauthMail, enqueue: true, settings, now: now + 11 }, { store });
    const managedOverlapMetadata = await ingestEmailClassificationMetadata({ mailbox: managedOverlap, message: oauthMail, enqueue: true, settings, now: now + 11 }, { store });
    assert(localOverlapMetadata && managedOverlapMetadata);
    await lifecycle.notifyEmailClassificationMessageChanged({ ownerUserId: 'owner', accountId: 'overlap', accountSource: 'local', messageId: oauthMail.id, folder: 'INBOX', read: true }, { store });
    assert.equal((await store.readMessages([localOverlapMetadata.messageRef]))[0].list.isRead, true);
    assert.equal((await store.readMessages([managedOverlapMetadata.messageRef]))[0].list.isRead, false, 'Identical account/provider IDs in another source stay untouched');
    await lifecycle.notifyEmailClassificationAccountChanged({ ownerUserId: 'owner', accountId: 'overlap', accountSource: 'local' }, { store });
    assert.equal((await store.readMailbox(localOverlap.mailboxRef))?.active, false);
    assert.equal((await store.readMailbox(managedOverlap.mailboxRef))?.active, true);
    assert.equal((await store.readClassificationJobStates([managedOverlapMetadata.messageRef], settings.revision)).get(managedOverlapMetadata.messageRef), 'pending');
    assert.equal(await lifecycle.notifyEmailClassificationMessageChanged(change, { store: failedStore }), false);
    assert.equal(await lifecycle.notifyEmailClassificationAccountChanged({ ownerUserId: 'owner', accountId: 'first', accountSource: 'local' }, { store: failedStore }), false);
  } finally { await postgres.close(); }
}

async function verifyProviderOperationHooks() {
  serviceMocks = true;
  const service = await import('../app/lib/email/service');
  const cases: Array<{ name: string; run(): Promise<unknown>; expected: Record<string, unknown> }> = [
    { name: 'policy', run: () => service.updateEmailPolicy('owner', 'first', {}), expected: { accountSource: 'local' } },
    { name: 'disconnect', run: () => service.disconnectEmailAccount('owner', 'first'), expected: { accountSource: 'local' } },
    { name: 'save-smtp', run: () => service.saveEmailSmtpAccount('owner', {} as Parameters<typeof service.saveEmailSmtpAccount>[1]), expected: { accountSource: 'local' } },
    { name: 'read', run: () => service.setEmailMessageRead('owner', 'first', 'same-id', 'INBOX', true), expected: { read: true } },
    { name: 'answered', run: () => service.setEmailMessageAnswered('owner', 'first', 'same-id', 'INBOX', true), expected: { answered: true } },
    { name: 'archive', run: () => service.archiveEmailMessage('owner', 'first', 'same-id', 'INBOX'), expected: { leaveInbox: true } },
    { name: 'move', run: () => service.moveEmailMessage('owner', 'first', 'same-id', 'INBOX', 'Archive'), expected: { leaveInbox: true } },
    { name: 'trash', run: () => service.trashEmailMessage('owner', 'first', 'same-id', 'INBOX'), expected: { leaveInbox: true } },
    { name: 'delete', run: () => service.deleteEmailMessagePermanently('owner', 'first', 'same-id', 'INBOX'), expected: { remove: true } },
  ];
  for (const test of cases) {
    events.length = 0; notifications.length = 0; providerFails = false;
    assert.equal(await test.run(), test.name === 'policy' || test.name === 'save-smtp' ? account : operationResult, 'Successful provider response remains unchanged during a classification outage');
    assert.equal(events.filter(event => event === `provider:${test.name}`).length, 1, 'Classification outages never replay a successful provider operation');
    assert.equal(events[0], `provider:${test.name}`); assert.equal(notifications.length, 1, test.name);
    assert.equal(events.at(-1), 'classification:unavailable');
    assert.equal(notifications[0].ownerUserId, 'owner'); assert.equal(notifications[0].accountId, 'first');
    for (const [key, value] of Object.entries(test.expected)) assert.equal(notifications[0][key], value, test.name);
    providerFails = true; events.length = 0; notifications.length = 0;
    await assert.rejects(test.run, /Provider operation failed/);
    assert.deepEqual(events, [`provider:${test.name}`]); assert.equal(notifications.length, 0, 'Failed provider operations never mutate the index');
  }
  managedAvailable = true;
  for (const [name, run] of [
    ['managed-policy', () => service.updateEmailPolicy('owner', 'remote', {})],
    ['managed-disconnect', () => service.disconnectEmailAccount('owner', 'remote')],
  ] as const) {
    providerFails = false; events.length = 0; notifications.length = 0;
    await run(); assert.equal(events.filter(event => event === `provider:${name}`).length, 1);
    assert.equal(notifications.length, 1); assert.equal(notifications[0].accountSource, 'managed'); assert.equal(notifications[0].accountId, 'remote');
    providerFails = true; events.length = 0; notifications.length = 0;
    await assert.rejects(run, /Provider operation failed/); assert.equal(notifications.length, 0);
  }
}

async function main() {
  await verifyDurableLifecycle();
  await verifyProviderOperationHooks();
  console.log('Email classification lifecycle passed: real PostgreSQL mutation isolation, read versus done, durable answered state, archive/trash retention, permanent-delete cascade, account job cancellation and successful-provider behavior across all local/managed hooks during classification outages.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { loader._load = originalLoad; });
