import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { runEmailClassificationPostgresMigration } from '../app/lib/email/classification/postgres-migration';
import { createEmailClassificationStore } from '../app/lib/email/classification/store';
import { DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION } from '../app/lib/email/classification/settings-types';
import { EmailClassificationVersionConflictError, type EmailClassificationTransaction } from '../app/lib/email/classification/store-types';
import type { EmailClassificationRaw } from '../app/lib/email/classification/types';

/** Actual concurrent PostgreSQL sessions in an owned temporary schema of the managed local stack. */
async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  const envPath = process.env.CANVAS_EMAIL_CLASSIFICATION_TEST_ENV_FILE;
  assert(envPath, 'Explicit private managed local env file is required.');
  assert.equal((await stat(envPath)).mode & 0o077, 0, 'The local environment must be private.');
  const connectionString = parse(await readFile(envPath)).DATABASE_URL;
  assert(connectionString, 'Local PostgreSQL is not configured.');
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook');
  assert.equal(url.search, '', 'Connection overrides are not allowed.');
  const schema = `email_classification_test_${randomBytes(8).toString('hex')}`;
  assert.match(schema, /^email_classification_test_[a-f0-9]{16}$/);
  const administrator = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
  let pool: Pool | null = null;
  let created = false;
  try {
    const identity = (await administrator.query<{ name: string; version: number }>('SELECT current_database() AS name, current_setting(\'server_version_num\')::integer AS version')).rows[0];
    assert.equal(identity.name, 'canvas_notebook'); assert(identity.version >= 180000);
    await administrator.query(`CREATE SCHEMA "${schema}"`); created = true;
    pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000, options: `-c search_path=${schema} -c application_name=canvas-email-classification-test` });
    assert.equal((await pool.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0].schema, schema);
    await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    await pool.query('INSERT INTO "user" (id) VALUES ($1),($2)', ['owner','member']);
    await runEmailClassificationPostgresMigration(pool);
    await runEmailClassificationPostgresMigration(pool);
    const transaction: EmailClassificationTransaction = async operation => {
      const connection = await pool!.connect();
      try {
        await connection.query('BEGIN');
        assert.equal((await connection.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0].schema, schema);
        const result = await operation(connection); await connection.query('COMMIT'); return result;
      } catch (error) { await connection.query('ROLLBACK'); throw error; }
      finally { connection.release(); }
    };
    const first = createEmailClassificationStore({ postgres: pool, transaction });
    const second = createEmailClassificationStore({ postgres: pool, transaction });
    const configuration = { ...structuredClone(DEFAULT_EMAIL_CLASSIFICATION_CONFIGURATION), enabled: true, maxEmailsPerDay: 2 };
    const saves = await Promise.allSettled([
      first.updateSettings({ expectedRevision: 0, actorUserId: 'owner', configuration }),
      second.updateSettings({ expectedRevision: 0, actorUserId: 'owner', configuration }),
    ]);
    assert.equal(saves.filter(result => result.status === 'fulfilled').length, 1);
    assert(saves.some(result => result.status === 'rejected' && result.reason instanceof EmailClassificationVersionConflictError));
    const settings = await first.readSettings(); assert.equal(settings.revision, 1);
    const mailbox = { mailboxRef: 'native-mailbox', ownerUserId: 'owner', accountSource: 'managed' as const, accountId: 'opaque', provider: 'google', workspaceId: null, mailboxId: null, bindingRevision: 'binding1', policyRevision: 'policy1', active: true, readFrom: [] };
    await first.upsertMailbox(mailbox);
    const now = Date.now();
    for (const id of ['one','two','three']) {
      await first.upsertMessageMetadata({ messageRef: id, mailboxRef: mailbox.mailboxRef, canonicalId: id, folder: 'INBOX', dateTimestamp: now, replyStatus: 'unknown', fingerprint: id, list: { from: 'sender@example.test', subject: id, date: new Date(now).toISOString(), snippet: id } });
      await first.enqueueClassification({ messageRef: id, configurationRevision: settings.revision, fingerprint: id, now });
    }
    const [claimsA, claimsB] = await Promise.all([first.claimJobs({ limit: 1, leaseMs: 60_000, now }), second.claimJobs({ limit: 1, leaseMs: 60_000, now })]);
    assert.equal(claimsA.length, 1); assert.equal(claimsB.length, 1); assert.notEqual(claimsA[0].id, claimsB[0].id);
    assert.equal((await first.claimJobs({ limit: 1, leaseMs: 60_000, now })).length, 0, 'The shared daily cap is atomic across sessions.');
    assert.equal((await pool.query<{ attempts: string }>('SELECT attempts FROM email_classification_daily_budget')).rows[0].attempts, '2');
    await first.upsertMailbox({ ...mailbox, policyRevision: 'policy2', readFrom: ['allowed@example.test'] });
    assert.equal(await second.recordMailboxSync({ mailboxRef: mailbox.mailboxRef, bindingRevision: mailbox.bindingRevision, policyRevision: mailbox.policyRevision, cursor: 'stale-page', coverage: 'complete' }), false);
    assert.equal((await first.readMailbox(mailbox.mailboxRef))!.coverage, 'pending');
    const focusWrites = await Promise.allSettled([
      first.setPersonalFocusState({ userId: 'owner', messageRef: 'one', expectedVersion: 0, done: true }),
      second.setPersonalFocusState({ userId: 'owner', messageRef: 'one', expectedVersion: 0, done: true }),
    ]);
    assert.equal(focusWrites.filter(result => result.status === 'fulfilled').length, 1);
    assert(focusWrites.some(result => result.status === 'rejected' && result.reason instanceof EmailClassificationVersionConflictError));
    assert.equal((await second.readPersonalFocusStates('member', ['one'])).length, 0);
    const disabled = await first.updateSettings({ expectedRevision: 1, actorUserId: 'owner', configuration: { ...configuration, enabled: false } });
    assert.equal(disabled.revision, 2);
    const raw: EmailClassificationRaw = { category: 'support', categoryProbabilities: { support: 1 }, categoryConfidence: 1, priority: 'normal', priorityProbabilities: { normal: 1 }, priorityConfidence: 1, spamProbability: 0, replyProbability: 1, providerId: 'typesafe', model: 'jev-1.13.0', adapterVersion: 'fixture', schemaVersion: 'email-triage.v1', probabilitySemantics: 'model_probability', calibrationReference: null, latencyMs: 1, evaluatedAt: now, evaluatedBodyCharacters: 1, bodyWasTruncated: false, usage: null };
    assert.equal(await second.completeJob({ jobId: claimsA[0].id, claimToken: claimsA[0].claimToken!, raw, now: now + 1 }), false);
    assert.equal((await first.readMessages(['one','two','three'])).length, 3, 'AI toggle preserves the independent metadata index.');
    const resumed = await first.updateSettings({ expectedRevision: 2, actorUserId: 'owner', configuration: { ...configuration, enabled: true, maxEmailsPerDay: 20, concurrency: 1 } });
    for (const id of ['one','two','three']) await first.enqueueClassification({ messageRef: id, fingerprint: id, configurationRevision: resumed.revision, now: now + 2 });
    const slots = await Promise.all([first.claimJobs({ limit: 3, leaseMs: 60_000, now: now + 3 }), second.claimJobs({ limit: 3, leaseMs: 60_000, now: now + 3 })]);
    assert.equal(slots.flat().length, 1, 'Global concurrency remains one across independent workers even with spare daily budget.');
    const syncClaims = await Promise.all([first.claimMailboxSync({ mailboxRef: mailbox.mailboxRef, leaseMs: 10_000, now }), second.claimMailboxSync({ mailboxRef: mailbox.mailboxRef, leaseMs: 10_000, now })]);
    assert.equal(syncClaims.filter(Boolean).length, 1, 'Only one session may synchronize this mailbox.');
    console.log('Native PostgreSQL 18 classification races passed: settings/focus CAS, exclusive leases, shared daily/concurrency limits, sync claims, stale sync and disable-before-result.');
  } finally {
    await pool?.end();
    if (created) await administrator.query(`DROP SCHEMA "${schema}" CASCADE`);
    await administrator.end();
  }
}
main().catch(error => { console.error('Native email classification test failed:', error instanceof Error ? error.message : 'Unknown failure'); process.exitCode = 1; });
