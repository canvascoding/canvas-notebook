import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { emailClassificationSelectionSql, isEmailSelectedForClassification } from '../app/lib/email/classification/selection';
import { runEmailClassificationPostgresMigration } from '../app/lib/email/classification/postgres-migration';
import { createEmailClassificationStore } from '../app/lib/email/classification/store';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } from '../app/lib/email/classification/settings-types';
import { validateEmailClassificationConfiguration } from '../app/lib/email/classification/settings-validation';
import type { EmailClassificationQueryable, EmailClassificationMetadataInput } from '../app/lib/email/classification/store-types';
import type { EmailClassificationRaw } from '../app/lib/email/classification/types';

async function main() {
  const postgres = new PGlite();
  const now = Date.now(); const day = 86_400_000;
  const mailbox = { mailboxRef: 'selection-fixture', ownerUserId: 'owner', accountSource: 'local' as const, accountId: 'fixture',
    provider: 'google', workspaceId: null, mailboxId: null, bindingRevision: 'binding', policyRevision: 'policy', active: true, readFrom: [] };
  const raw: EmailClassificationRaw = { category: 'support', categoryProbabilities: { support: 0.9, other: 0.1 }, categoryConfidence: 0.9,
    priority: 'high', priorityProbabilities: { high: 0.9, normal: 0.1 }, priorityConfidence: 0.9,
    spamProbability: 0.02, replyProbability: 0.95, providerId: 'typesafe', model: 'jev-1.13.0', adapterVersion: 'fixture',
    schemaVersion: 'email-triage.v1', probabilitySemantics: 'model_probability', calibrationReference: null,
    evaluatedAt: now, latencyMs: 1, evaluatedBodyCharacters: 1, bodyWasTruncated: false, usage: null };
  const metadata = (id: string, isRead: boolean | undefined, age: number | null): EmailClassificationMetadataInput => ({
    messageRef: id, mailboxRef: mailbox.mailboxRef, canonicalId: id, folder: 'INBOX', fingerprint: id, inInbox: true,
    dateTimestamp: age === null ? null : now - age, replyStatus: 'unknown',
    list: { from: 'fixture@example.test', subject: id, date: age === null ? 'unknown' : new Date(now - age).toISOString(), snippet: '', isRead },
  });
  try {
    // The SQL selection used for claims and feeds must match the application selection exactly.
    for (const inInbox of [true, false]) for (const isRead of [true, false, undefined]) {
      for (const age of [null, -1, 0, 30 * day, 30 * day + 1, 365 * day]) {
        const message = { ...metadata('matrix', isRead, age), inInbox };
        const expected = inInbox && (isRead === false || age !== null && age >= 0 && age <= 30 * day);
        assert.equal(isEmailSelectedForClassification({ ...message, inInbox }, 30, now), expected);
        const result = await postgres.query<{ selected: boolean }>(`SELECT coalesce(${emailClassificationSelectionSql('message', '$4', '$5')},false) AS selected
          FROM (SELECT $1::boolean AS in_inbox, $2::bigint AS date_timestamp, $3::jsonb AS list_json) message`,
        [inInbox, message.dateTimestamp, JSON.stringify(message.list), now, 30]);
        assert.equal(result.rows[0].selected, expected, JSON.stringify({ inInbox, isRead, age }));
      }
    }
    assert.equal(isEmailSelectedForClassification({ ...metadata('old-unread', false, 365 * day), inInbox: true }, 1, now), true);
    assert.equal(isEmailSelectedForClassification({ ...metadata('old-read', true, 31 * day), inInbox: true }, 365, now), false, 'The selection itself caps legacy windows at 30 days.');
    assert.throws(() => validateEmailClassificationConfiguration({ ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, initialLookbackDays: 31 }));

    await postgres.exec('CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES (\'owner\');');
    await runEmailClassificationPostgresMigration(postgres);
    const store = createEmailClassificationStore({ postgres: postgres as unknown as EmailClassificationQueryable,
      transaction: operation => postgres.transaction(connection => operation(connection as unknown as EmailClassificationQueryable)) });
    await store.upsertMailbox(mailbox, now);
    let settings = await store.updateSettings({ expectedRevision: 0, actorUserId: 'owner', now,
      configuration: { ...DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION, enabled: true, maxEmailsPerDay: 2 } });
    for (const message of [metadata('old-unread', false, 365 * day), metadata('recent-read', true, 20 * day), metadata('old-read', true, 31 * day)]) {
      await store.upsertMessageMetadata(message, now);
      const job = await store.enqueueClassification({ messageRef: message.messageRef, fingerprint: message.fingerprint, configurationRevision: settings.revision, now });
      assert.equal(Boolean(job), message.messageRef !== 'old-read');
    }
    const claims = await store.claimJobs({ limit: 2, leaseMs: 60_000, now });
    assert.equal(claims.length, 2);
    for (const claim of claims) assert.equal(await store.completeJob({ jobId: claim.id, claimToken: claim.claimToken!, raw, now }), true);
    const storedRaw = JSON.stringify((await store.readResultsBatch(['old-unread']))[0].raw);
    await store.updateIndexedMessageState({ ownerUserId: 'owner', accountId: 'fixture', accountSource: 'local', canonicalId: 'old-unread', read: true, now });
    assert.equal(JSON.stringify((await store.readResultsBatch(['old-unread']))[0].raw), storedRaw);

    await store.upsertMessageMetadata(metadata('waiting', false, 365 * day), now);
    const waiting = await store.enqueueClassification({ messageRef: 'waiting', fingerprint: 'waiting', configurationRevision: settings.revision, now });
    assert(waiting);
    await store.updateIndexedMessageState({ ownerUserId: 'owner', accountId: 'fixture', accountSource: 'local', canonicalId: 'waiting', read: true, now });
    assert.deepEqual(await store.claimJobs({ limit: 2, leaseMs: 60_000, now }), []);
    assert.equal((await store.readJob(waiting.id))?.status, 'canceled', 'Ineligible work is canceled even with an exhausted daily budget.');

    settings = await store.updateSettings({ expectedRevision: settings.revision, actorUserId: 'owner', now,
      configuration: { ...settings.configuration, maxEmailsPerDay: 4 } });
    await store.upsertMessageMetadata(metadata('active', false, 365 * day), now);
    await store.enqueueClassification({ messageRef: 'active', fingerprint: 'active', configurationRevision: settings.revision, now });
    const active = (await store.claimJobs({ limit: 1, leaseMs: 60_000, now }))[0]; assert(active);
    await store.updateIndexedMessageState({ ownerUserId: 'owner', accountId: 'fixture', accountSource: 'local', canonicalId: 'active', read: true, now });
    assert.equal(await store.completeJob({ jobId: active.id, claimToken: active.claimToken!, raw, now }), false, 'Publication checks selection atomically.');
    assert.deepEqual(await store.readResultsBatch(['active']), []);

    // Upgrade preserves results and budget, changes only the obsolete window/revision, and is idempotent.
    await postgres.query("UPDATE email_classification_settings SET configuration_json=jsonb_set(configuration_json,'{initialLookbackDays}','365'::jsonb)");
    const budgetBefore = await postgres.query('SELECT * FROM email_classification_daily_budget');
    await runEmailClassificationPostgresMigration(postgres);
    const upgraded = await store.readSettings();
    assert.equal(upgraded.configuration.initialLookbackDays, 30); assert.equal(upgraded.revision, settings.revision + 1);
    await runEmailClassificationPostgresMigration(postgres);
    assert.equal((await store.readSettings()).revision, upgraded.revision);
    assert.deepEqual((await postgres.query('SELECT * FROM email_classification_daily_budget')).rows, budgetBefore.rows);
    assert.equal(JSON.stringify((await store.readResultsBatch(['old-unread']))[0].raw), storedRaw);
    console.log('Email selection passed: unread OR recent, exact boundary, SQL parity, queue cancellation, atomic publication, cache retention and idempotent legacy upgrade.');
  } finally { await postgres.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
