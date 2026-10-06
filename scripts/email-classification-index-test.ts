import assert from 'node:assert/strict';
import Module from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { runEmailClassificationPostgresMigration } from '../app/lib/email/classification/postgres-migration';
import { createEmailClassificationStore } from '../app/lib/email/classification/store';
import { EmailClassificationStoreStateError, type EmailClassificationQueryable } from '../app/lib/email/classification/store-types';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } from '../app/lib/email/classification/settings-types';
import type { AuthorizedEmailClassificationMailbox } from '../app/lib/email/classification/mailbox-types';
import type { EmailClassificationRaw } from '../app/lib/email/classification/types';

const loader = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (request, parent, isMain) => request === '@/app/lib/db' || request === '@/app/lib/email/account-store' ? {} : originalLoad(request, parent, isMain);
const now = 1_790_000_000_000;
const raw: EmailClassificationRaw = {
  category: 'support', categoryProbabilities: { support: 0.9, other: 0.1 }, categoryConfidence: 0.8,
  priority: 'high', priorityProbabilities: { high: 0.9, normal: 0.1 }, priorityConfidence: 0.8,
  spamProbability: 0.02, replyProbability: 0.95, providerId: 'typesafe', model: 'jev-1.13.0',
  adapterVersion: 'fixture', schemaVersion: 'email-triage.v1', probabilitySemantics: 'model_probability', calibrationReference: null,
  latencyMs: 10, evaluatedAt: now, evaluatedBodyCharacters: 30, bodyWasTruncated: false, usage: null,
};

async function main() {
  const postgres = new PGlite();
  try {
    const { emailClassificationMailboxRef } = await import('../app/lib/email/classification/identity');
    const { emailClassificationMetadataInput, ingestEmailClassificationMetadata, readEmailClassificationProjectionBatch, registerEmailClassificationMailboxes, isStoredEmailClassificationResultCurrent } = await import('../app/lib/email/classification/index-service');
    await postgres.exec('CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES (\'owner\'),(\'member\');');
    await runEmailClassificationPostgresMigration(postgres);
    const store = createEmailClassificationStore({ postgres: postgres as unknown as EmailClassificationQueryable,
      transaction: operation => postgres.transaction(connection => operation(connection as unknown as EmailClassificationQueryable)) });
    const source = (accountId: string): AuthorizedEmailClassificationMailbox => {
      const identity = { ownerUserId: 'owner', accountSource: 'managed' as const, accountId, workspaceId: null, mailboxId: null };
      return { ...identity, mailboxRef: emailClassificationMailboxRef(identity), provider: 'google', bindingRevision: `binding-${accountId}`,
        policyRevision: 'policy', readFrom: [], active: true, emailAddress: `${accountId}@example.test`, displayName: null, workspaceName: null,
        capabilities: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManage: true } };
    };
    const first = source('first'); const second = source('second');
    await registerEmailClassificationMailboxes([first, second], { store });
    const message = (id: string) => ({ id, folder: 'INBOX', from: 'customer@example.test', subject: 'Delayed order',
      date: new Date(now).toISOString(), snippet: 'Please reply', body: 'PRIVATE_BODY_NOT_INDEXED', attachments: ['PRIVATE_ATTACHMENT'], isRead: false, isAnswered: false });
    const firstMessage = message('same-provider-id');
    const firstMetadata = await ingestEmailClassificationMetadata({ mailbox: first, message: firstMessage, enqueue: true, now: now - 10 }, { store });
    assert(firstMetadata); assert.equal(firstMetadata.inInbox, true);
    assert.equal(firstMetadata.replyStatus, 'unknown');
    assert.equal(JSON.stringify(firstMetadata).includes('PRIVATE_BODY_NOT_INDEXED'), false);
    assert.equal((await postgres.query('SELECT id FROM email_classification_jobs')).rows.length, 0, 'Disabled metadata sync never queues AI');
    assert.equal(emailClassificationMetadataInput(first, { ...firstMessage, snippet: 'A longer preview', to: ['extra@example.test'], isRead: true, isAnswered: true }).fingerprint, firstMetadata.fingerprint);
    assert.notEqual(emailClassificationMetadataInput(first, { ...firstMessage, subject: 'Changed contents' }).fingerprint, firstMetadata.fingerprint);
    assert.notEqual(emailClassificationMetadataInput(second, firstMessage).messageRef, firstMetadata.messageRef);
    assert.equal(await ingestEmailClassificationMetadata({ mailbox: first, message: { ...firstMessage, id: '' }, enqueue: true }, { store }), null);
    let settings = await store.updateSettings({ expectedRevision: 0, actorUserId: 'owner', configuration: { ...structuredClone(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION), enabled: true, maxEmailsPerDay: 50, concurrency: 2 }, now: now - 5 });
    let queuedAt = now - 4;
    for (const [mailbox, mail] of [[first, firstMessage], [first, message('second-first-mail')], [first, message('third-first-mail')], [second, firstMessage]] as const) {
      await ingestEmailClassificationMetadata({ mailbox, message: mail, enqueue: true, settings, now: queuedAt++ }, { store });
    }
    const claims = await store.claimJobs({ limit: 10, leaseMs: 10_000, now: now + 1 });
    assert.equal(claims.length, 2); assert.equal(new Set(claims.map(job => job.mailboxRef)).size, 2, 'Claims rotate across mailboxes');
    assert.deepEqual(await store.claimJobs({ limit: 10, leaseMs: 10_000, now: now + 2 }), [], 'Other workers cannot exceed global concurrency');
    const firstJob = claims.find(job => job.messageRef === firstMetadata.messageRef); assert(firstJob?.claimToken);
    assert.equal(await store.cancelClaim({ jobId: firstJob.id, claimToken: 'wrong-token', errorCode: 'test', now: now + 3 }), false);
    assert.equal(await store.completeJob({ jobId: firstJob.id, claimToken: firstJob.claimToken, raw, now: now + 3 }), true);
    const result = (await store.readResultsBatch([firstMetadata.messageRef]))[0];
    assert.equal(isStoredEmailClassificationResultCurrent(result, firstMetadata, settings.configuration), true);
    await store.updateOverride({ messageRef: firstMetadata.messageRef, expectedVersion: result.version, overrides: { category: 'finance' }, now: now + 4 });
    await store.setPersonalFocusState({ userId: 'owner', messageRef: firstMetadata.messageRef, expectedVersion: 0, done: true, now: now + 4 });
    const read = await readEmailClassificationProjectionBatch({ actorUserId: 'owner', mailbox: first, messages: [firstMessage], settings }, { store });
    assert.equal(read.get(firstMetadata.messageRef)?.classification.category, 'finance'); assert.equal(read.get(firstMetadata.messageRef)?.classification.group, 'done');
    assert.equal(read.get(firstMetadata.messageRef)?.personalFocusVersion, 1);
    const otherUser = await readEmailClassificationProjectionBatch({ actorUserId: 'member', mailbox: first, messages: [firstMessage], settings }, { store });
    assert.equal(otherUser.get(firstMetadata.messageRef)?.classification.group, 'important', 'Personal completion is not a team status');
    const attempts = (await postgres.query<{ count: number }>('SELECT count(*) AS count FROM email_classification_jobs')).rows[0].count;
    settings = await store.updateSettings({ expectedRevision: 1, actorUserId: 'owner', configuration: { ...settings.configuration, enabled: false }, now: now + 5 });
    assert.equal((await readEmailClassificationProjectionBatch({ actorUserId: 'owner', mailbox: first, messages: [firstMessage], settings }, { store })).size, 0);
    settings = await store.updateSettings({ expectedRevision: 2, actorUserId: 'owner', configuration: { ...settings.configuration, enabled: true }, now: now + 6 });
    await ingestEmailClassificationMetadata({ mailbox: first, message: firstMessage, enqueue: true, settings, now: now + 7 }, { store });
    assert.equal((await postgres.query<{ count: number }>('SELECT count(*) AS count FROM email_classification_jobs')).rows[0].count, attempts, 'Toggle reuses valid ratings without a new job');
    const secondary = await ingestEmailClassificationMetadata({ mailbox: first, message: { ...firstMessage, folder: 'Important' }, enqueue: false, now: now + 8 }, { store });
    assert.equal(secondary?.inInbox, true, 'Secondary labels do not remove a current inbox mail');
    const outside = await ingestEmailClassificationMetadata({ mailbox: first, message: { ...message('sent-only'), folder: 'Sent' }, enqueue: true, settings, now: now + 8 }, { store });
    assert.equal(outside?.inInbox, false); assert.equal((await store.readClassificationJobStates([outside!.messageRef], settings.revision)).size, 0);
    const restricted = { ...first, readFrom: ['allowed@example.test'], policyRevision: 'restricted' };
    await registerEmailClassificationMailboxes([restricted], { store });
    const restrictedMail = await ingestEmailClassificationMetadata({ mailbox: restricted, message: message('denied-ai'), enqueue: true, settings, now: now + 9 }, { store });
    assert(restrictedMail); assert.equal((await store.readClassificationJobStates([restrictedMail.messageRef], settings.revision)).size, 0, 'Human personal browse does not authorize background AI outside its sender policy');
    assert.equal(await ingestEmailClassificationMetadata({ mailbox: first, message: firstMessage, enqueue: true, settings }, { store }), null, 'Old policy snapshots cannot overwrite current metadata');
    await assert.rejects(store.updateOverride({ messageRef: firstMetadata.messageRef, expectedVersion: 2, overrides: {}, expectedPolicyRevision: 'policy' }), EmailClassificationStoreStateError);
    await assert.rejects(store.setPersonalFocusState({ userId: 'owner', messageRef: firstMetadata.messageRef, expectedVersion: 1, done: false, expectedBindingRevision: 'removed' }), EmailClassificationStoreStateError);
    const shared = { ...second, workspaceId: 'work', mailboxId: 'binding', policyRevision: 'restricted-shared', readFrom: ['allowed@example.test'] };
    assert.equal(await ingestEmailClassificationMetadata({ mailbox: shared, message: message('denied-human'), enqueue: false }, { store }), null);
    const syncToken = await store.claimMailboxSync({ mailboxRef: first.mailboxRef, leaseMs: 10, now: now + 10 }); assert(syncToken);
    assert.equal(await store.claimMailboxSync({ mailboxRef: first.mailboxRef, leaseMs: 10, now: now + 11 }), null);
    const nextToken = await store.claimMailboxSync({ mailboxRef: first.mailboxRef, leaseMs: 100, now: now + 21 }); assert(nextToken);
    assert.equal(await store.recordMailboxSync({ mailboxRef: first.mailboxRef, bindingRevision: restricted.bindingRevision, policyRevision: restricted.policyRevision, claimToken: syncToken, cursor: 'old', coverage: 'complete', now: now + 22 }), false);
    assert.equal(await store.releaseMailboxSync({ mailboxRef: first.mailboxRef, claimToken: syncToken }), false);
    assert.equal(await store.recordMailboxSync({ mailboxRef: first.mailboxRef, bindingRevision: restricted.bindingRevision, policyRevision: restricted.policyRevision, claimToken: nextToken, cursor: 'fresh', coverage: 'partial', now: now + 22 }), true);
    assert.equal(await store.releaseMailboxSync({ mailboxRef: first.mailboxRef, claimToken: nextToken }), true);
    await registerEmailClassificationMailboxes([first], { store });
    const activeMessage = (await store.readMessages([firstMetadata.messageRef]))[0];
    await store.upsertMessageMetadata({ ...activeMessage, inInbox: false }, now + 23);
    assert.equal((await store.readResultsBatch([firstMetadata.messageRef]))[0].overrides.category, 'finance', 'Leaving inbox retains durable ratings/corrections');
    assert.equal(await store.enqueueClassification({ messageRef: firstMetadata.messageRef, fingerprint: activeMessage.fingerprint, configurationRevision: settings.revision }), null);
    console.log('Email classification index passed: no body persistence, batch projections, stable fingerprints, current policies, global concurrency/fairness, sync leases and durable reuse.');
  } finally { loader._load = originalLoad; await postgres.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
