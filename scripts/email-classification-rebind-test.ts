import assert from 'node:assert/strict';
import Module from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { runEmailClassificationPostgresMigration } from '../app/lib/email/classification/postgres-migration';
import { createEmailClassificationStore } from '../app/lib/email/classification/store';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } from '../app/lib/email/classification/settings-types';
import { EMAIL_CLASSIFICATION_SCHEMA_VERSION } from '../app/lib/email/classification/schema';
import type { AuthorizedEmailClassificationMailbox } from '../app/lib/email/classification/mailbox-types';
import type { EmailClassificationQueryable, StoredEmailClassificationResult } from '../app/lib/email/classification/store-types';
import type { EmailClassificationFeedDependencies } from '../app/lib/email/classification/feed-service';
import type { EmailClassificationRaw } from '../app/lib/email/classification/types';

// Identity helpers import the IMAP module. This isolated test owns its database;
// it must never initialize or query the host's runtime database or credential files.
const loader = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = loader._load;
loader._load = (request, parent, isMain) => request === '@/app/lib/db' || request === '@/app/lib/email/account-store'
  ? {} : originalLoad(request, parent, isMain);

async function main() {
  const postgres = new PGlite();
  try {
    const { emailClassificationMailboxRef } = await import('../app/lib/email/classification/identity');
    const { matchesEmailMailboxScope } = await import('../app/lib/email/classification/mailbox-types');
    const { ingestEmailClassificationMetadata, emailClassificationMetadataInput } = await import('../app/lib/email/classification/index-service');
    const { readEmailClassificationFeed } = await import('../app/lib/email/classification/feed-service');
    const { readEmailClassificationMessage, updateEmailClassificationOverride, setEmailClassificationPersonalFocus } = await import('../app/lib/email/classification/state-service');
    await postgres.exec('CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES (\'owner\');');
    await runEmailClassificationPostgresMigration(postgres);
    let now = 1_790_000_000_000;
    const store = createEmailClassificationStore({ postgres: postgres as unknown as EmailClassificationQueryable,
      transaction: operation => postgres.transaction(connection => operation(connection as unknown as EmailClassificationQueryable)) });
    const scopeIdentity = { ownerUserId: 'owner', accountSource: 'local' as const, accountId: 'same-configurable-account', workspaceId: 'workspace', mailboxId: 'workspace-mailbox' };
    let source: AuthorizedEmailClassificationMailbox = {
      ...scopeIdentity, mailboxRef: emailClassificationMailboxRef(scopeIdentity), provider: 'imap', active: true,
      connectionRevision: 'imap-host-a-and-user-a', bindingRevision: 'workspace-binding-1', policyRevision: 'policy-1', readFrom: [],
      emailAddress: 'original@example.test', displayName: 'Work inbox', workspaceName: 'Workspace',
      capabilities: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManage: true },
    };
    let sources = [source];
    const dependencies: EmailClassificationFeedDependencies = {
      postgres: postgres as unknown as EmailClassificationQueryable, store, now: () => now,
      transaction: operation => postgres.transaction(connection => operation(connection as unknown as EmailClassificationQueryable)),
      mailboxes: async (_userId, scope = { kind: 'all' }) => sources.filter(mailbox => mailbox.active && matchesEmailMailboxScope(mailbox, scope)),
    };
    await store.upsertMailbox(source, now);
    const settings = await store.updateSettings({ expectedRevision: 0, actorUserId: 'owner', configuration: { ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, enabled: true }, now });
    const oldMail = { id: '17', uid: '17', uidValidity: '700', folder: 'INBOX', from: 'old-customer@example.test', subject: 'Original mailbox contents',
      date: new Date(now).toISOString(), snippet: 'Old preview', isRead: false, isAnswered: false };
    const indexed = await ingestEmailClassificationMetadata({ mailbox: source, message: oldMail, enqueue: true, settings, provenance: 'imap', inInbox: true, now }, { store });
    assert(indexed);
    const [claim] = await store.claimJobs({ limit: 1, leaseMs: 100_000, now: ++now });
    assert(claim?.claimToken);
    const raw: EmailClassificationRaw = { category: 'support', categoryProbabilities: { support: 0.9, other: 0.1 }, categoryConfidence: 0.9,
      priority: 'high', priorityProbabilities: { high: 0.9, normal: 0.1 }, priorityConfidence: 0.9, spamProbability: 0.02, replyProbability: 0.95,
      providerId: 'typesafe', model: DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION.model, adapterVersion: 'fixture', schemaVersion: EMAIL_CLASSIFICATION_SCHEMA_VERSION,
      probabilitySemantics: 'model_probability', calibrationReference: null, latencyMs: 1, evaluatedAt: now, evaluatedBodyCharacters: 100, bodyWasTruncated: false, usage: { requests: 1 } };
    assert.equal(await store.completeJob({ jobId: claim.id, claimToken: claim.claimToken, raw, now: ++now }), true);
    await store.updateOverride({ messageRef: indexed.messageRef, expectedVersion: 1, overrides: { category: 'finance', isSpam: false }, now: ++now });
    await store.setPersonalFocusState({ userId: 'owner', messageRef: indexed.messageRef, expectedVersion: 0, done: true, now: ++now });
    const initial = await readEmailClassificationFeed({ userId: 'owner', scope: { kind: 'all' }, view: 'all' }, dependencies);
    assert.equal(initial.items.length, 1); assert.equal(initial.items[0].classification?.group, 'done');
    assert.notEqual((await readEmailClassificationMessage({ userId: 'owner', messageRef: indexed.messageRef }, dependencies)).assessment, null);

    // Workspace binding/policy updates and active toggles do not change the
    // underlying connection, and must retain the durable raw result/corrections.
    for (const change of [{ bindingRevision: 'workspace-binding-2' }, { policyRevision: 'policy-2', readFrom: ['@example.test'] }, { active: false }, { active: true }]) {
      source = { ...source, ...change }; sources = [source];
      await store.upsertMailbox(source, ++now);
      const result: StoredEmailClassificationResult | undefined = (await store.readResultsBatch([indexed.messageRef]))[0];
      if (!source.active) {
        assert.equal(result, undefined, 'Inactive sources are hidden by authorized low-level result reads');
        assert.equal((await postgres.query('SELECT raw_json FROM email_classification_results WHERE message_ref=$1', [indexed.messageRef])).rows.length, 1);
      } else {
        assert(result);
        assert.deepEqual(result.raw, raw); assert.deepEqual(result.overrides, { category: 'finance', isSpam: false });
        assert.equal((await store.readPersonalFocusStates('owner', [indexed.messageRef]))[0].done, true);
        const feed = await readEmailClassificationFeed({ userId: 'owner', scope: { kind: 'all' }, view: 'all' }, dependencies);
        assert.equal(feed.items.length, 1); assert.equal(feed.items[0].classification?.category, 'finance');
      }
    }
    const beforeRebind = await readEmailClassificationFeed({ userId: 'owner', scope: { kind: 'all' }, view: 'all' }, dependencies);
    source = { ...source, connectionRevision: 'imap-host-b-and-user-b', bindingRevision: 'connection-b-workspace-binding-2', emailAddress: 'replacement@example.test' };
    sources = [source];
    await store.upsertMailbox(source, ++now);
    assert.deepEqual(await store.readMessages([indexed.messageRef]), []);
    assert.deepEqual(await store.readResultsBatch([indexed.messageRef]), []);
    assert.deepEqual(await store.readPersonalFocusStates('owner', [indexed.messageRef]), []);
    const afterRebind = await readEmailClassificationFeed({ userId: 'owner', scope: { kind: 'all' }, view: 'all' }, dependencies);
    assert.equal(afterRebind.items.length, 0); assert.equal(afterRebind.counts.total, 0);
    assert.equal((await postgres.query('SELECT message_ref FROM email_classification_feed_rows WHERE snapshot_id=$1', [beforeRebind.snapshot.id])).rows.length, 0, 'Deleted metadata cascades old frozen list data out of existing snapshots');
    const unavailable = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EMAIL_MESSAGE_UNAVAILABLE');
    await assert.rejects(readEmailClassificationMessage({ userId: 'owner', messageRef: indexed.messageRef }, dependencies), unavailable);
    await assert.rejects(updateEmailClassificationOverride({ userId: 'owner', messageRef: indexed.messageRef, expectedVersion: 2, overrides: {} }, dependencies), unavailable);
    await assert.rejects(setEmailClassificationPersonalFocus({ userId: 'owner', messageRef: indexed.messageRef, expectedVersion: 1, done: false }, dependencies), unavailable);

    // Different IMAP connections may reuse the same UIDVALIDITY + UID. The
    // freshly observed mail gets no raw result, correction or completion state.
    const replacementMail = { ...oldMail, from: 'different-customer@example.test', subject: 'Different mailbox contents', snippet: 'Fresh preview' };
    const replacement = await ingestEmailClassificationMetadata({ mailbox: source, message: replacementMail, enqueue: false, inInbox: true, provenance: 'imap', now: ++now }, { store });
    assert(replacement); assert.equal(replacement.canonicalId, indexed.canonicalId); assert.equal(replacement.messageRef, indexed.messageRef);
    const replacementDetail = await readEmailClassificationMessage({ userId: 'owner', messageRef: replacement.messageRef }, dependencies);
    assert.equal(replacementDetail.origin.emailAddress, 'replacement@example.test'); assert.equal(replacementDetail.message.subject, 'Different mailbox contents');
    assert.equal(replacementDetail.assessment, null); assert.deepEqual(replacementDetail.classification?.overrides, {});
    assert.equal(replacementDetail.classification?.version, 0); assert.equal(replacementDetail.classification?.status, 'pending');
    assert.deepEqual(replacementDetail.personalFocus, { done: false, version: 0 });
    assert.equal((await postgres.query('SELECT id FROM email_classification_jobs WHERE message_ref=$1', [replacement.messageRef])).rows.length, 0);

    // The same connection token cannot make a provider switch reuse old rows.
    await store.updateOverride({ messageRef: replacement.messageRef, expectedVersion: 0, overrides: { priority: 'urgent' }, now: ++now });
    source = { ...source, provider: 'google', bindingRevision: 'provider-change' }; sources = [source];
    await store.upsertMailbox(source, ++now);
    assert.deepEqual(await store.readMessages([replacement.messageRef]), []);
    assert.deepEqual(await store.readResultsBatch([replacement.messageRef]), []);

    const googleIdentity = { ownerUserId: 'owner', accountSource: 'managed' as const, accountId: 'google', workspaceId: null, mailboxId: null };
    const google: AuthorizedEmailClassificationMailbox = { ...googleIdentity, mailboxRef: emailClassificationMailboxRef(googleIdentity), provider: 'google', active: true,
      connectionRevision: 'google-connection', bindingRevision: 'google-binding', policyRevision: 'google-policy', readFrom: [],
      emailAddress: 'google@example.test', displayName: null, workspaceName: null, capabilities: { ...source.capabilities } };
    sources = [google]; await store.upsertMailbox(google, ++now);
    const missingFolderMail = { id: 'sent-with-no-folder', from: 'sender@example.test', subject: 'Sent message opened directly', date: new Date(now).toISOString(), snippet: 'Cached preview' };
    assert.equal(emailClassificationMetadataInput(google, missingFolderMail, 'cache').inInbox, false, 'A default identity folder cannot prove inbox membership');
    const missingFolder = await ingestEmailClassificationMetadata({ mailbox: google, message: missingFolderMail, inInbox: false, enqueue: true, provenance: 'cache', settings, now: ++now }, { store });
    assert(missingFolder); assert.equal(missingFolder.inInbox, false);
    assert.equal((await store.readClassificationJobStates([missingFolder.messageRef], settings.revision)).size, 0);
    assert.equal((await readEmailClassificationFeed({ userId: 'owner', scope: { kind: 'all' }, view: 'all' }, dependencies)).items.length, 0);
    const sent = await ingestEmailClassificationMetadata({ mailbox: google, message: { ...missingFolderMail, id: 'explicit-sent', folder: 'SENT' }, inInbox: false, enqueue: true, settings, now: ++now }, { store });
    assert(sent); assert.equal(sent.inInbox, false); assert.equal((await store.readClassificationJobStates([sent.messageRef], settings.revision)).size, 0);
    const knownInbox = await ingestEmailClassificationMetadata({ mailbox: google, message: { ...missingFolderMail, id: 'known-inbox', folder: 'INBOX' }, inInbox: true, enqueue: false, now: ++now }, { store });
    assert(knownInbox?.inInbox);
    const noFolderRefresh = await ingestEmailClassificationMetadata({ mailbox: google, message: { ...missingFolderMail, id: 'known-inbox' }, inInbox: false, enqueue: false, provenance: 'cache', now: ++now }, { store });
    assert.equal(noFolderRefresh?.inInbox, true, 'Secondary cache/detail views preserve already proven inbox membership');
    console.log('Email classification rebind passed: fresh connection/provider origins, no UID-reuse inheritance, stable binding/policy/toggle corrections and unproven-folder exclusion.');
  } finally { loader._load = originalLoad; await postgres.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
