import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { runEmailClassificationPostgresMigration } from '../app/lib/email/classification/postgres-migration';
import { createEmailClassificationStore } from '../app/lib/email/classification/store';
import {
  EmailClassificationStoreStateError, EmailClassificationVersionConflictError,
  type EmailClassificationQueryable, type EmailClassificationMailboxInput, type EmailClassificationMetadataInput,
} from '../app/lib/email/classification/store-types';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } from '../app/lib/email/classification/settings-types';
import { emailClassificationEvaluationFingerprint } from '../app/lib/email/classification/settings-evaluation';
import { EMAIL_CLASSIFICATION_SCHEMA_VERSION } from '../app/lib/email/classification/schema';
import type { EmailClassificationRaw } from '../app/lib/email/classification/types';
import { verifyEmailClassificationUnicodePersistence } from './email-classification-unicode-regression';

const raw: EmailClassificationRaw = {
  category: 'support', categoryProbabilities: { support: 0.9, other: 0.1 }, categoryConfidence: 0.9,
  priority: 'high', priorityProbabilities: { high: 0.9, normal: 0.1 }, priorityConfidence: 0.9,
  spamProbability: 0.02, replyProbability: 0.95, providerId: 'typesafe', model: 'jev-1.13.0',
  adapterVersion: 'fixture-v1', schemaVersion: EMAIL_CLASSIFICATION_SCHEMA_VERSION, probabilitySemantics: 'model_probability', calibrationReference: null,
  evaluatedAt: 1_000, latencyMs: 10, evaluatedBodyCharacters: 100, bodyWasTruncated: false, usage: { requests: 1, inputTokens: undefined, outputTokens: undefined },
};
const mailbox: EmailClassificationMailboxInput = {
  mailboxRef: 'personal-mailbox', ownerUserId: 'owner', accountSource: 'managed', accountId: 'remote-no-local-account', provider: 'google',
  workspaceId: null, mailboxId: null, bindingRevision: 'binding-1', connectionRevision: 'connection-1', policyRevision: 'policy-1', readFrom: [], active: true,
};
const message = (id: string, overrides: Partial<EmailClassificationMetadataInput> = {}): EmailClassificationMetadataInput => ({
  messageRef: id, mailboxRef: mailbox.mailboxRef, canonicalId: `provider-${id}`, folder: 'INBOX', dateTimestamp: 100,
  replyStatus: 'unknown', fingerprint: `fingerprint-${id}`,
  list: { from: 'customer@example.test', subject: 'Delayed order', date: '1970-01-01T00:00:00.100Z', snippet: 'Please investigate', isRead: false, threadId: 'thread-1' },
  ...overrides,
});

async function verifyManagedPublication() {
  const postgres = new PGlite();
  try {
    await postgres.exec(`CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES ('owner'), ('admin');`);
    await runEmailClassificationPostgresMigration(postgres);
    const store = createEmailClassificationStore({
      postgres: postgres as unknown as EmailClassificationQueryable,
      transaction: operation => postgres.transaction(connection => operation(connection as unknown as EmailClassificationQueryable)),
    });
    const managedModel = { ref: 'central-model', providerId: 'systemone', model: 'kev', adapterVersion: 'systemone-http.v1', inferenceRevision: 'sha256:' + 'a'.repeat(64) };
    const settings = await store.updateSettings({ expectedRevision: 0, actorUserId: 'admin', now: 100,
      configuration: { ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, enabled: true, executionMode: 'managed', managedModelRef: managedModel.ref, managedModel } });
    await store.upsertMailbox(mailbox, 101);
    const managedRaw = { ...raw, providerId: managedModel.providerId, model: managedModel.model, adapterVersion: managedModel.adapterVersion };
    for (const [id, value, accepted] of [
      ['managed-valid', managedRaw, true],
      ['managed-wrong-provider', { ...managedRaw, providerId: 'typesafe' }, false],
      ['managed-wrong-model', { ...managedRaw, model: 'another-model' }, false],
      ['managed-wrong-adapter', { ...managedRaw, adapterVersion: 'another-adapter' }, false],
    ] as const) {
      await store.upsertMessageMetadata(message(id), 102);
      await store.enqueueClassification({ messageRef: id, fingerprint: message(id).fingerprint, configurationRevision: settings.revision, now: 103 });
      const [claim] = await store.claimJobs({ limit: 1, leaseMs: 100, now: 104 });
      assert.equal(await store.completeJob({ jobId: claim.id, claimToken: claim.claimToken!, raw: value, now: 105 }), accepted, id);
      assert.equal((await store.readResultsBatch([id])).length, accepted ? 1 : 0, id);
      assert.equal((await store.readJob(claim.id))?.status, accepted ? 'completed' : 'canceled', id);
    }
    const stored = (await store.readResultsBatch(['managed-valid']))[0];
    assert.equal(stored.raw?.providerId, 'systemone', 'Managed results do not use the preserved direct provider selection');
    assert.equal(stored.evaluationFingerprint, emailClassificationEvaluationFingerprint(settings.configuration));
  } finally { await postgres.close(); }
}

async function main() {
  await verifyManagedPublication();
  const brokenMigration = new PGlite();
  try {
    await brokenMigration.exec('CREATE TABLE "user"(id text PRIMARY KEY); CREATE TABLE email_classification_messages(message_ref text PRIMARY KEY);');
    await assert.rejects(runEmailClassificationPostgresMigration(brokenMigration));
    assert.equal((await brokenMigration.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('email_classification_settings','email_classification_mailboxes')")).rows.length, 0, 'A failed migration batch does not leave a partially installed schema');
    await brokenMigration.exec('DROP TABLE email_classification_messages');
    await runEmailClassificationPostgresMigration(brokenMigration);
  } finally { await brokenMigration.close(); }
  const postgres = new PGlite();
  try {
    await postgres.exec(`CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES ('owner'), ('admin'), ('member');`);
    await runEmailClassificationPostgresMigration(postgres as unknown as EmailClassificationQueryable);
    const schema = await postgres.query<{ table_name: string; column_name: string; data_type: string }>(`SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name,column_name`);
    await runEmailClassificationPostgresMigration(postgres as unknown as EmailClassificationQueryable);
    assert.deepEqual((await postgres.query(`SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name,column_name`)).rows, schema.rows, 'Repeated migration is idempotent');
    assert.equal(new Set(schema.rows.map(row => row.table_name)).size, 11);
    assert.ok(schema.rows.some(row => row.table_name === 'email_classification_messages' && row.column_name === 'list_json' && row.data_type === 'jsonb'));
    assert.ok(schema.rows.some(row => row.table_name === 'email_classification_results' && row.column_name === 'evaluation_fingerprint' && row.data_type === 'text'));
    assert.ok(schema.rows.some(row => row.table_name === 'email_classification_mailboxes' && row.column_name === 'last_sync_error_code' && row.data_type === 'text'));
    await postgres.exec('ALTER TABLE email_classification_results DROP COLUMN evaluation_fingerprint');
    await runEmailClassificationPostgresMigration(postgres);
    assert.equal((await postgres.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'email_classification_results' AND column_name = 'evaluation_fingerprint'")).rows.length, 1, 'Repeated migration upgrades an already installed result table');
    assert.ok(!schema.rows.some(row => /body|attachment/iu.test(String(row.column_name))), 'Permanent metadata tables have no message body or attachment columns');

    const store = createEmailClassificationStore({
      postgres: postgres as unknown as EmailClassificationQueryable,
      transaction: operation => postgres.transaction(connection => operation(connection as unknown as EmailClassificationQueryable)),
    });
    const initial = await store.readSettings();
    assert.equal(initial.revision, 0); assert.equal(initial.configuration.enabled, false);
    initial.configuration.policy.spamPositiveThreshold = 0.5;
    assert.equal((await store.readSettings()).configuration.policy.spamPositiveThreshold, 0.95, 'Defaults are not shared mutable state');

    const firstMailbox = await store.upsertMailbox(mailbox, 100);
    assert.equal(firstMailbox.accountSource, 'managed', 'Managed account does not require a local account row');
    assert.equal(firstMailbox.coverage, 'pending');
    assert.equal(firstMailbox.lastSyncErrorCode, null);
    await postgres.exec('ALTER TABLE email_classification_mailboxes DROP COLUMN last_sync_error_code');
    await runEmailClassificationPostgresMigration(postgres);
    await runEmailClassificationPostgresMigration(postgres);
    assert.equal((await store.readMailbox(mailbox.mailboxRef))?.lastSyncErrorCode, null, 'Additive repeat migration upgrades an existing mailbox without fabricating a diagnostic');
    await assert.rejects(postgres.query('UPDATE email_classification_mailboxes SET last_sync_error_code = $2 WHERE mailbox_ref = $1', [mailbox.mailboxRef, 'secret-provider-detail']), /check constraint/u);
    await assert.rejects(store.upsertMailbox({ ...mailbox, ownerUserId: 'member' }, 100), EmailClassificationStoreStateError);
    await assert.rejects(store.upsertMailbox({ ...mailbox, mailboxRef: 'missing-owner', ownerUserId: 'missing' }, 100));
    await assert.rejects(store.upsertMailbox({ ...mailbox, mailboxRef: 'invalid-scope', workspaceId: 'workspace-1' }, 100));
    const firstMessage = await store.upsertMessageMetadata(message('message-1'), 101);
    assert.equal(firstMessage.replyStatus, 'unknown');
    assert.equal(firstMessage.mailbox.ownerUserId, 'owner');
    assert.equal((await store.upsertMessageMetadata(message('message-1'), 102)).indexRevision, firstMessage.indexRevision, 'Identical provider refresh does not change the index revision');
    const refreshed = await store.upsertMessageMetadata(message('message-1', { list: { ...message('message-1').list, isRead: true, body: 'must never persist', attachments: ['must never persist'] } as EmailClassificationMetadataInput['list'] }), 103);
    assert.equal(refreshed.indexRevision, 2);
    assert.equal(refreshed.fingerprint, firstMessage.fingerprint, 'Read flags do not create a new content fingerprint');
    assert.equal('body' in refreshed.list, false); assert.equal('attachments' in refreshed.list, false);
    await verifyEmailClassificationUnicodePersistence({ store, postgres: postgres as unknown as EmailClassificationQueryable, mailboxRef: mailbox.mailboxRef, now: 103 });
    await assert.rejects(store.upsertMessageMetadata(message('message-1', { canonicalId: 'different-provider-mail' }), 103), EmailClassificationStoreStateError);
    await assert.rejects(store.upsertMessageMetadata(message('message-alias', { canonicalId: 'provider-message-1' }), 103));
    assert.equal(await store.recordMailboxSync({ mailboxRef: mailbox.mailboxRef, bindingRevision: 'binding-1', policyRevision: 'policy-1', cursor: 'opaque-provider-cursor', coverage: 'partial', now: 104 }), true);
    assert.equal((await store.readMailbox(mailbox.mailboxRef))?.coverage, 'partial');
    const syncClaim = await store.claimMailboxSync({ mailboxRef: mailbox.mailboxRef, leaseMs: 20, now: 104 });
    assert.ok(syncClaim);
    assert.equal(await store.recordMailboxSync({ mailboxRef: mailbox.mailboxRef, bindingRevision: 'binding-1', policyRevision: 'policy-1', cursor: 'opaque-provider-cursor', coverage: 'failed', errorCode: 'timeout', claimToken: syncClaim, now: 105 }), true);
    const syncFailed = (await store.readMailbox(mailbox.mailboxRef))!;
    assert.equal(syncFailed.lastSyncErrorCode, 'timeout'); assert.equal(syncFailed.lastSyncAt, 104);
    assert.equal(await store.recordMailboxSync({ mailboxRef: mailbox.mailboxRef, bindingRevision: 'binding-1', policyRevision: 'policy-1', cursor: null, coverage: 'failed', errorCode: 'auth_required', claimToken: 'wrong', now: 106 }), false);
    assert.equal((await store.readMailbox(mailbox.mailboxRef))?.lastSyncErrorCode, 'timeout', 'Rejected claims cannot overwrite an ingestion diagnostic');
    const replacementSyncClaim = await store.claimMailboxSync({ mailboxRef: mailbox.mailboxRef, leaseMs: 20, now: 125 });
    assert.ok(replacementSyncClaim); assert.notEqual(replacementSyncClaim, syncClaim);
    assert.equal(await store.recordMailboxSync({ mailboxRef: mailbox.mailboxRef, bindingRevision: 'binding-1', policyRevision: 'policy-1', cursor: null, coverage: 'complete', claimToken: syncClaim, now: 126 }), false);
    assert.equal((await store.readMailbox(mailbox.mailboxRef))?.lastSyncErrorCode, 'timeout', 'Expired claims cannot clear a newer diagnostic');
    assert.equal(await store.recordMailboxSync({ mailboxRef: mailbox.mailboxRef, bindingRevision: 'binding-1', policyRevision: 'policy-1', cursor: 'opaque-provider-cursor', coverage: 'partial', claimToken: replacementSyncClaim, now: 127 }), true);
    assert.equal((await store.readMailbox(mailbox.mailboxRef))?.lastSyncErrorCode, null, 'A successful partial scan clears the old error');
    assert.equal((await store.readMailbox(mailbox.mailboxRef))?.lastSyncAt, 127);
    await store.releaseMailboxSync({ mailboxRef: mailbox.mailboxRef, claimToken: replacementSyncClaim });
    await assert.rejects(store.recordMailboxSync({ mailboxRef: mailbox.mailboxRef, bindingRevision: 'binding-1', policyRevision: 'policy-1', cursor: null, coverage: 'failed', errorCode: 'unsafe-provider-secret' as never, now: 128 }), /Invalid mailbox sync error code/u);
    assert.equal(await store.enqueueClassification({ messageRef: 'message-1', configurationRevision: 1, fingerprint: firstMessage.fingerprint, now: 110 }), null);
    assert.deepEqual(await store.claimJobs({ limit: 2, leaseMs: 100, now: 110 }), []);

    const races = await Promise.allSettled([
      store.updateSettings({ expectedRevision: 0, actorUserId: 'admin', configuration: { ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, enabled: true }, now: 200 }),
      store.updateSettings({ expectedRevision: 0, actorUserId: 'admin', configuration: { ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, enabled: true }, now: 201 }),
    ]);
    assert.equal(races.filter(result => result.status === 'fulfilled').length, 1, 'Only one initial settings revision wins');
    assert.ok(races.some(result => result.status === 'rejected' && result.reason instanceof EmailClassificationVersionConflictError));
    let settings = await store.readSettings();
    assert.equal(settings.revision, 1); assert.equal(settings.configuration.enabled, true);
    await assert.rejects(store.updateSettings({ expectedRevision: 0, actorUserId: 'admin', configuration: settings.configuration }), EmailClassificationVersionConflictError);
    await assert.rejects(store.updateSettings({ expectedRevision: 1, actorUserId: 'admin', configuration: { ...settings.configuration, timeoutMs: 0 } }));

    const [queuedA, queuedB] = await Promise.all([
      store.enqueueClassification({ messageRef: 'message-1', configurationRevision: 1, fingerprint: firstMessage.fingerprint, now: 210 }),
      store.enqueueClassification({ messageRef: 'message-1', configurationRevision: 1, fingerprint: firstMessage.fingerprint, now: 210 }),
    ]);
    assert.ok(queuedA && queuedB); assert.equal(queuedA.id, queuedB.id, 'Duplicate discoveries produce one job');
    const [claimA, claimB] = await Promise.all([store.claimJobs({ limit: 1, leaseMs: 100, now: 220 }), store.claimJobs({ limit: 1, leaseMs: 100, now: 220 })]);
    assert.equal(claimA.length + claimB.length, 1, 'Concurrent claimers do not receive the same live lease');
    const claim = [...claimA, ...claimB][0];
    assert.ok(claim.claimToken); assert.equal(claim.attempts, 1);
    assert.equal(await store.completeJob({ jobId: claim.id, claimToken: 'wrong-token', raw, now: 221 }), false);
    assert.equal(await store.renewClaim({ jobId: claim.id, claimToken: claim.claimToken!, leaseMs: 200, now: 222 }), true);
    assert.equal(await store.completeJob({ jobId: claim.id, claimToken: claim.claimToken!, raw, now: 223 }), true);
    assert.equal(await store.completeJob({ jobId: claim.id, claimToken: claim.claimToken!, raw, now: 224 }), false, 'A completed claim cannot publish twice');
    assert.equal((await store.readJob(claim.id))?.status, 'completed');
    let result = (await store.readResultsBatch(['message-1']))[0];
    assert.equal(result.raw?.spamProbability, 0.02); assert.equal(result.resultRevision, 1);
    assert.equal(result.evaluationFingerprint, emailClassificationEvaluationFingerprint(settings.configuration));
    assert.deepEqual(result.raw?.usage, { requests: 1 }, 'Unknown token counts remain absent instead of being rejected or fabricated as zero');
    result = await store.updateOverride({ messageRef: 'message-1', expectedVersion: result.version, overrides: { priority: 'urgent', isSpam: false }, now: 230 });
    assert.equal(result.overrides.priority, 'urgent'); assert.equal(result.raw?.priority, 'high', 'Override never rewrites original model judgment');
    await assert.rejects(store.updateOverride({ messageRef: 'message-1', expectedVersion: 1, overrides: { priority: 'low' } }), EmailClassificationVersionConflictError);
    const overrideRaces = await Promise.allSettled([
      store.updateOverride({ messageRef: 'message-1', expectedVersion: result.version, overrides: { priority: 'urgent' }, now: 231 }),
      store.updateOverride({ messageRef: 'message-1', expectedVersion: result.version, overrides: { priority: 'low' }, now: 232 }),
    ]);
    assert.equal(overrideRaces.filter(value => value.status === 'fulfilled').length, 1);
    result = (await store.readResultsBatch(['message-1']))[0];

    const done = await store.setPersonalFocusState({ userId: 'member', messageRef: 'message-1', expectedVersion: 0, done: true, now: 240 });
    assert.equal(done.done, true);
    assert.deepEqual(await store.readPersonalFocusStates('owner', ['message-1']), [], 'Shared completion is personal to the actor');
    assert.equal((await store.readPersonalFocusStates('member', ['message-1']))[0].done, true);
    await assert.rejects(store.setPersonalFocusState({ userId: 'member', messageRef: 'message-1', expectedVersion: 0, done: false }), EmailClassificationVersionConflictError);
    const undone = await store.setPersonalFocusState({ userId: 'member', messageRef: 'message-1', expectedVersion: done.version, done: false, now: 241 });
    assert.equal(undone.done, false); assert.equal(undone.version, done.version + 1);
    await store.upsertMessageMetadata(message('message-2'), 242);
    assert.deepEqual(await store.readPersonalFocusStates('member', ['message-2']), [], 'New incoming message is not suppressed by older completion');

    settings = await store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, model: 'jev-1.13.1' }, now: 250 });
    const replacement = await store.enqueueClassification({ messageRef: 'message-1', configurationRevision: settings.revision, fingerprint: firstMessage.fingerprint, now: 251 });
    assert.ok(replacement); assert.notEqual(replacement.id, claim.id);
    const replacementClaim = (await store.claimJobs({ limit: 1, leaseMs: 100, now: 252 }))[0];
    assert.equal(await store.completeJob({ jobId: replacementClaim.id, claimToken: replacementClaim.claimToken!, raw: { ...raw, model: 'jev-1.13.1' }, now: 253 }), true);
    const reclassified = (await store.readResultsBatch(['message-1']))[0];
    assert.deepEqual(reclassified.overrides, result.overrides, 'Provider result replacement preserves human corrections');
    assert.notEqual(reclassified.evaluationFingerprint, result.evaluationFingerprint, 'A changed model creates a changed evaluation identity');
    assert.equal(reclassified.resultRevision, 2); assert.equal(reclassified.version, result.version + 1);
    assert.equal((await store.readMessages(['message-1']))[0].list.isRead, true);

    const pending = await store.enqueueClassification({ messageRef: 'message-2', configurationRevision: settings.revision, fingerprint: message('message-2').fingerprint, now: 260 });
    assert.ok(pending);
    const beforeDisable = (await store.claimJobs({ limit: 1, leaseMs: 100, now: 261 }))[0];
    settings = await store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, enabled: false }, now: 262 });
    assert.equal(await store.completeJob({ jobId: beforeDisable.id, claimToken: beforeDisable.claimToken!, raw, now: 263 }), false, 'Disabled configuration refuses late publication');
    assert.equal((await store.readJob(beforeDisable.id))?.status, 'canceled');
    assert.equal((await store.readMessages(['message-1', 'message-2'])).length, 2, 'Permanent metadata survives central AI disable');
    assert.equal((await store.readResultsBatch(['message-1'])).length, 1, 'Results remain durable after disable');
    assert.equal((await store.readResultsBatch(['message-1']))[0].evaluationFingerprint, reclassified.evaluationFingerprint);
    assert.equal(reclassified.evaluationFingerprint, emailClassificationEvaluationFingerprint(settings.configuration), 'Central disable does not invalidate published raw evaluations');
    assert.deepEqual(await store.claimJobs({ limit: 1, leaseMs: 100, now: 264 }), []);

    settings = await store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, enabled: true }, now: 270 });
    assert.equal((await store.readResultsBatch(['message-1']))[0].evaluationFingerprint, emailClassificationEvaluationFingerprint(settings.configuration), 'Reenable preserves reuse of the existing evaluation');
    await store.enqueueClassification({ messageRef: 'message-2', configurationRevision: settings.revision, fingerprint: message('message-2').fingerprint, now: 271 });
    const expiredClaim = (await store.claimJobs({ limit: 1, leaseMs: 10, now: 272 }))[0];
    const reclaimed = (await store.claimJobs({ limit: 1, leaseMs: 100, now: 283 }))[0];
    assert.equal(reclaimed.id, expiredClaim.id); assert.notEqual(reclaimed.claimToken, expiredClaim.claimToken); assert.equal(reclaimed.attempts, 2);
    assert.equal(await store.completeJob({ jobId: expiredClaim.id, claimToken: expiredClaim.claimToken!, raw, now: 284 }), false, 'Old lease token cannot publish after a replacement claim');
    assert.equal(await store.retryJob({ jobId: reclaimed.id, claimToken: reclaimed.claimToken!, errorCode: 'rate_limit', nextAttemptAt: 300, now: 285 }), true);
    assert.deepEqual(await store.claimJobs({ limit: 1, leaseMs: 100, now: 299 }), []);
    const retry = (await store.claimJobs({ limit: 1, leaseMs: 100, now: 300 }))[0];
    await store.recordMailboxSync({ mailboxRef: mailbox.mailboxRef, bindingRevision: 'binding-1', policyRevision: 'policy-1', cursor: null, coverage: 'failed', errorCode: 'auth_required', now: 300 });
    await store.upsertMailbox({ ...mailbox, policyRevision: 'policy-2', readFrom: ['allowed@example.test'] }, 301);
    assert.equal((await store.readMailbox(mailbox.mailboxRef))?.coverage, 'pending', 'Changed rights invalidate the old sync coverage');
    assert.equal((await store.readMailbox(mailbox.mailboxRef))?.syncCursor, null);
    assert.equal((await store.readMailbox(mailbox.mailboxRef))?.lastSyncErrorCode, null, 'Policy changes clear diagnostics from the old authorized source');
    assert.equal(await store.recordMailboxSync({ mailboxRef: mailbox.mailboxRef, bindingRevision: 'binding-1', policyRevision: 'policy-1', cursor: 'stale-policy-cursor', coverage: 'complete', now: 301 }), false, 'Old policy sync cannot publish its stale cursor');
    assert.equal((await store.readMailbox(mailbox.mailboxRef))?.coverage, 'pending');
    assert.equal((await store.readMailbox(mailbox.mailboxRef))?.syncCursor, null);
    assert.equal(await store.completeJob({ jobId: retry.id, claimToken: retry.claimToken!, raw, now: 302 }), false, 'Changed sender policy rejects stale claims');
    const policyJob = await store.enqueueClassification({ messageRef: 'message-2', configurationRevision: settings.revision, fingerprint: message('message-2').fingerprint, now: 303 });
    assert.equal(policyJob?.policyRevision, 'policy-2'); assert.equal(policyJob?.status, 'pending', 'Same key can be reevaluated after binding/policy invalidation');
    const bindingClaim = (await store.claimJobs({ limit: 1, leaseMs: 100, now: 304 }))[0];
    await store.recordMailboxSync({ mailboxRef: mailbox.mailboxRef, bindingRevision: 'binding-1', policyRevision: 'policy-2', cursor: null, coverage: 'failed', errorCode: 'provider_unavailable', now: 304 });
    await store.upsertMailbox({ ...mailbox, bindingRevision: 'binding-2', policyRevision: 'policy-2', readFrom: ['allowed@example.test'] }, 305);
    assert.equal((await store.readMailbox(mailbox.mailboxRef))?.lastSyncErrorCode, null, 'Binding changes clear diagnostics');
    assert.equal(await store.recordMailboxSync({ mailboxRef: mailbox.mailboxRef, bindingRevision: 'binding-1', policyRevision: 'policy-2', cursor: null, coverage: 'failed', errorCode: 'content_invalid', now: 305 }), false, 'Stale binding errors cannot repopulate a new binding');
    assert.equal(await store.recordMailboxSync({ mailboxRef: mailbox.mailboxRef, bindingRevision: 'binding-1', policyRevision: 'policy-2', cursor: 'stale-binding-cursor', coverage: 'complete', now: 305 }), false, 'Old binding sync cannot replace new binding coverage');
    assert.equal(await store.completeJob({ jobId: bindingClaim.id, claimToken: bindingClaim.claimToken!, raw, now: 306 }), false, 'Changed mailbox binding rejects stale publication');

    await store.enqueueClassification({ messageRef: 'message-2', configurationRevision: settings.revision, fingerprint: message('message-2').fingerprint, now: 310 });
    const changedBodyClaim = (await store.claimJobs({ limit: 1, leaseMs: 100, now: 311 }))[0];
    await store.upsertMessageMetadata(message('message-2', { fingerprint: 'changed-body-fingerprint' }), 312);
    assert.equal(await store.completeJob({ jobId: changedBodyClaim.id, claimToken: changedBodyClaim.claimToken!, raw, now: 313 }), false, 'Changed content rejects late result');
    await store.enqueueClassification({ messageRef: 'message-2', configurationRevision: settings.revision, fingerprint: 'changed-body-fingerprint', now: 314 });
    const disconnectedClaim = (await store.claimJobs({ limit: 1, leaseMs: 100, now: 315 }))[0];
    await store.deactivateMailbox(mailbox.mailboxRef, 316);
    assert.equal(await store.completeJob({ jobId: disconnectedClaim.id, claimToken: disconnectedClaim.claimToken!, raw, now: 317 }), false);
    assert.deepEqual(await store.readMessages(['message-1']), []); assert.deepEqual(await store.readResultsBatch(['message-1']), []);
    await assert.rejects(store.setPersonalFocusState({ userId: 'member', messageRef: 'message-1', expectedVersion: undone.version, done: true }), EmailClassificationStoreStateError);
    await store.upsertMailbox({ ...mailbox, bindingRevision: 'binding-2', policyRevision: 'policy-2', readFrom: ['allowed@example.test'] }, 318);
    const reopened = await store.enqueueClassification({ messageRef: 'message-2', configurationRevision: settings.revision, fingerprint: 'changed-body-fingerprint', now: 319 });
    assert.equal(reopened?.id, disconnectedClaim.id);
    assert.equal(reopened?.status, 'pending', 'Reconnecting unchanged identity revives its canceled job');
    await store.upsertMessageMetadata(message('failed-message'), 319);
    const overrideOnly = await store.updateOverride({ messageRef: 'failed-message', expectedVersion: 0, overrides: { priority: 'normal' }, now: 319 });
    assert.equal(overrideOnly.evaluationFingerprint, null, 'Manual-only rows do not invent a model evaluation identity');
    const failedJob = await store.enqueueClassification({ messageRef: 'failed-message', configurationRevision: settings.revision, fingerprint: message('failed-message').fingerprint, now: 319 });
    const failedClaim = (await store.claimJobs({ limit: 2, leaseMs: 100, now: 319 })).find(job => job.id === failedJob?.id);
    assert.ok(failedClaim);
    assert.equal(await store.retryJob({ jobId: failedClaim.id, claimToken: failedClaim.claimToken!, errorCode: 'exhausted', nextAttemptAt: 400, terminal: true, now: 319 }), true);
    assert.equal((await store.enqueueClassification({ messageRef: 'failed-message', configurationRevision: settings.revision, fingerprint: message('failed-message').fingerprint, now: 319 }))?.status, 'failed', 'Repeated discovery does not reactivate exhausted failed jobs');

    const validatedPolicy = { ...settings.configuration.policy, spamSortingValidated: true, calibrationReference: 'fixture-eval', validatedProviderId: 'typesafe', validatedModel: settings.configuration.model, validatedSchemaVersion: EMAIL_CLASSIFICATION_SCHEMA_VERSION };
    settings = await store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, policy: validatedPolicy }, now: 320 });
    assert.equal(settings.configuration.policy.spamSortingValidated, true);
    settings = await store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, model: 'jev-1.13.2' }, now: 321 });
    assert.equal(settings.configuration.policy.spamSortingValidated, false, 'Model changes invalidate the earlier spam evaluation');
    assert.equal(settings.configuration.policy.calibrationReference, null);
    assert.notEqual(reclassified.evaluationFingerprint, emailClassificationEvaluationFingerprint(settings.configuration), 'Changing model makes earlier evaluations unsuitable for reuse');
    const beforePurposeChange = emailClassificationEvaluationFingerprint(settings.configuration);
    settings = await store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, questionProfile: { ...settings.configuration.questionProfile, personalPurpose: 'Personal research correspondence' } }, now: 322 });
    assert.notEqual(beforePurposeChange, emailClassificationEvaluationFingerprint(settings.configuration), 'Changed mailbox purpose changes the evaluation inputs');

    // Attempts are globally capped per UTC day, including reclaims/retries; the
    // budget is independent of provider/configuration revision and toggles.
    const firstDay = 86_400_000;
    settings = await store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, maxEmailsPerDay: 2 }, now: firstDay });
    for (const id of ['quota-1', 'quota-2', 'quota-3']) {
      await store.upsertMessageMetadata(message(id), firstDay + 1);
      await store.enqueueClassification({ messageRef: id, configurationRevision: settings.revision, fingerprint: message(id).fingerprint, now: firstDay + 2 });
    }
    const quotaClaims = await Promise.all([store.claimJobs({ limit: 5, leaseMs: 100, now: firstDay + 3 }), store.claimJobs({ limit: 5, leaseMs: 100, now: firstDay + 3 })]);
    assert.equal(quotaClaims.flat().length, 2, 'Concurrent claims cannot exceed the daily attempt cap');
    assert.equal(Number((await postgres.query<{ attempts: number }>('SELECT attempts FROM email_classification_daily_budget WHERE day_start = $1', [firstDay])).rows[0].attempts), 2);
    assert.deepEqual(await store.claimJobs({ limit: 1, leaseMs: 100, now: firstDay + 104 }), [], 'Expired leases cannot bypass the attempt budget');
    settings = await store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, enabled: false }, now: firstDay + 105 });
    settings = await store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'admin', configuration: { ...settings.configuration, enabled: true, model: 'jev-1.13.3' }, now: firstDay + 106 });
    for (const id of ['quota-1', 'quota-2', 'quota-3']) await store.enqueueClassification({ messageRef: id, configurationRevision: settings.revision, fingerprint: message(id).fingerprint, now: firstDay + 107 });
    assert.deepEqual(await store.claimJobs({ limit: 5, leaseMs: 100, now: firstDay + 108 }), [], 'Toggle/model changes do not reset the daily attempt count');
    const secondDay = firstDay * 2;
    const nextDayClaims = await store.claimJobs({ limit: 5, leaseMs: 100, now: secondDay + 1 });
    assert.equal(nextDayClaims.length, 2, 'Next UTC day receives a fresh configured budget');
    assert.equal(Number((await postgres.query<{ attempts: number }>('SELECT attempts FROM email_classification_daily_budget WHERE day_start = $1', [secondDay])).rows[0].attempts), 2);
    assert.deepEqual(await store.claimJobs({ limit: 1, leaseMs: 100, now: secondDay + 2 }), []);

    await postgres.query('DELETE FROM "user" WHERE id = $1', ['member']);
    assert.deepEqual(await store.readPersonalFocusStates('member', ['message-1']), [], 'Actor deletion cascades personal state');
    await postgres.query('DELETE FROM "user" WHERE id = $1', ['owner']);
    for (const table of ['email_classification_mailboxes', 'email_classification_messages', 'email_classification_jobs', 'email_classification_results', 'email_classification_personal_focus']) {
      assert.equal(Number((await postgres.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0].count), 0, 'Owner deletion cascades its indexed message data');
    }
    await postgres.query('DELETE FROM "user" WHERE id = $1', ['admin']);
    assert.equal((await store.readSettings()).updatedByUserId, null, 'Admin deletion preserves instance settings without dangling attribution');
  } finally { await postgres.close(); }
  console.log('email-classification-store-test: ok');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
