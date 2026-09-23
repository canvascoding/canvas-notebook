import assert from 'node:assert/strict';
import Module from 'node:module';
import { eq } from 'drizzle-orm';
import { createPiTestDatabase } from './helpers/pi-test-database';

type Loader = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const modules = Module as typeof Module & { _load: Loader };
const originalLoad = modules._load;
let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
let auditFails = false;
let browserTransportCalls = 0;
modules._load = (request, parent, isMain) => {
  if (database && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request))) return database;
  if (request.endsWith('/pi/session-workspace-context')) return {
    resolveAgentSessionWorkspaceForUser: async ({ userId, workspaceId }: { userId: string; workspaceId: string }) => {
      assert.equal(userId, 'reviewer');
      assert.equal(workspaceId, 'workspace');
      return { workspaceId };
    },
  };
  if (request === '@/app/lib/email/mailbox-access') return {
    resolveEmailMailboxAccess: async (input: { userId: string; mailboxWorkspaceId: string; accountId: string }) => {
      assert.equal(input.userId, 'reviewer'); assert.equal(input.mailboxWorkspaceId, 'workspace'); assert.equal(input.accountId, 'account');
      return { accountId: 'account', accountOwnerId: 'owner', workspaceId: 'workspace', mailboxId: 'mailbox', readOptions: { enforceReadPolicy: true } };
    },
    EmailMailboxAccessError: Error,
  };
  if (request === '@/app/lib/email/service' || /\/app\/lib\/email\/service(?:\.ts)?$/u.test(request)) return {
    sendEmailMessage: async (ownerId: string) => { assert.equal(ownerId, 'owner'); browserTransportCalls++; },
  };
  if (request.endsWith('/audit/audit-service')) return {
    recordAuditEvent: async () => { if (auditFails) throw new Error('Audit unavailable'); },
  };
  return originalLoad(request, parent, isMain);
};

async function main() {
  database = await createPiTestDatabase();
  try {
    const { db } = database;
    const { user, emailAccounts, emailDrafts, workspaceEmailMailboxes } = await import('../app/lib/db/schema');
    const outbox = await import('../app/lib/email/workspace-inbox-outbox');
    const now = new Date();
    await db.insert(user).values(['owner', 'reviewer'].map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })));
    await db.insert(emailAccounts).values({ id: 'account', userId: 'owner', provider: 'smtp_imap', authType: 'smtp_imap', emailAddress: 'owner@example.test', policyJson: JSON.stringify({ readFrom: [], sendTo: ['@example.test'] }), secretRef: 'unused-test-secret', createdAt: now, updatedAt: now });
    await db.insert(workspaceEmailMailboxes).values({ id: 'mailbox', workspaceId: 'workspace', emailAccountId: 'account', createdByUserId: 'owner', lastEditedByUserId: 'owner', createdAt: now, updatedAt: now });
    const humanCreated = await outbox.createWorkspaceOutboxDraft({ userId: 'reviewer', workspaceId: 'workspace', mailboxId: 'mailbox', origin: 'human', subject: 'Composed by a person', body: 'Keep this draft', to: ['outside@blocked.test'], initialStatus: 'prepared' });
    assert.equal(humanCreated.origin, 'human');
    assert.ok((await outbox.listWorkspaceOutboxDrafts('reviewer', 'workspace')).some(draft => draft.id === humanCreated.id));
    await assert.rejects(outbox.sendWorkspaceOutboxDraft({ userId: 'reviewer', workspaceId: 'workspace', draftId: humanCreated.id, expectedVersion: humanCreated.version }, { sendMessage: async () => { throw new Error('Policy should prevent transport'); } }), (error: unknown) => (error as { code: string }).code === 'SEND_POLICY_BLOCKED');
    assert.equal((await outbox.findWorkspaceOutboxDraft('reviewer', 'workspace', humanCreated.id))?.status, 'send_failed');
    const compose = await import('../app/lib/email/mailbox-compose');
    const beforeInline = (await outbox.listWorkspaceOutboxDrafts('reviewer', 'workspace')).length;
    await assert.rejects(compose.sendBrowserEmailMessage('reviewer', { accountId: 'account', mailboxWorkspaceId: 'workspace', to: ['allowed@example.test'], subject: 'Inline image', body: '<p><img src="cid:image"></p>', is_HTML: true }), (error: unknown) => (error as { status: number }).status === 400);
    assert.equal((await outbox.listWorkspaceOutboxDrafts('reviewer', 'workspace')).length, beforeInline, 'Unsupported inline content must fail before creating an Outbox entry');
    assert.equal(browserTransportCalls, 0);
    await assert.rejects(compose.sendBrowserEmailMessage('reviewer', { accountId: 'account', mailboxWorkspaceId: 'workspace', to: ['blocked@outside.test'], subject: 'Manual browser send', body: 'Recover me' }), (error: unknown) => (error as { code: string }).code === 'SEND_POLICY_BLOCKED');
    const failedManual = (await outbox.listWorkspaceOutboxDrafts('reviewer', 'workspace')).find(draft => draft.subject === 'Manual browser send');
    assert.ok(failedManual); assert.equal(failedManual.origin, 'human'); assert.equal(failedManual.status, 'send_failed'); assert.equal(failedManual.assignedUserId, 'reviewer');
    assert.equal(browserTransportCalls, 0);
    const fixedManual = await compose.updateBrowserEmailDraft('reviewer', failedManual.id, { accountId: 'account', mailboxWorkspaceId: 'workspace', expectedVersion: failedManual.version, to: ['allowed@example.test'], subject: 'Manual browser send', body: 'Recovered' });
    const sentManual = await compose.sendBrowserEmailDraft('reviewer', failedManual.id, { accountId: 'account', mailboxWorkspaceId: 'workspace', expectedVersion: Number((fixedManual as { draft: { version: number } }).draft.version) });
    assert.equal((sentManual as { sentByUserId: string }).sentByUserId, 'reviewer'); assert.equal((sentManual as { status: string }).status, 'sent'); assert.equal(browserTransportCalls, 1);
    let serial = 0;
    for (const scope of ['personal', 'workspace', 'human'] as const) {
      const identity = scope === 'personal' ? { userId: 'owner' } : { userId: 'reviewer', workspaceId: 'workspace' };
      const send = (draftId: string, expectedVersion: number, sendMessage: (input: { to: string[]; cc: string[]; bcc: string[] }) => Promise<unknown>) => scope === 'personal'
        ? outbox.sendPersonalOutboxDraft({ ...identity, draftId, expectedVersion }, { sendMessage })
        : outbox.sendWorkspaceOutboxDraft({ ...identity, workspaceId: 'workspace', draftId, expectedVersion }, { sendMessage });
      const reject = (draftId: string, expectedVersion: number) => scope === 'personal'
        ? outbox.rejectPersonalOutboxDraft({ ...identity, draftId, expectedVersion })
        : outbox.rejectWorkspaceOutboxDraft({ ...identity, workspaceId: 'workspace', draftId, expectedVersion });
      const edit = (draftId: string, expectedVersion: number) => {
        const input = { ...identity, draftId, expectedVersion, subject: 'Edited', body: '<p><strong>Edited</strong></p>', to: ['fixed@example.test'], cc: [], bcc: ['blind@example.test'] };
        return scope === 'personal' ? outbox.updatePersonalOutboxDraft(input) : outbox.updateWorkspaceOutboxDraft({ ...input, workspaceId: 'workspace' });
      };
      const get = (draftId: string) => scope === 'personal' ? outbox.findPersonalOutboxDraft('owner', draftId) : outbox.findWorkspaceOutboxDraft('reviewer', 'workspace', draftId);
      const fixture = async (recipients: Partial<Record<'to' | 'cc' | 'bcc', string[]>> = {}) => {
        const id = `${scope}-${++serial}`;
        await db.insert(emailDrafts).values({ id, userId: 'owner', accountId: 'account', workspaceId: scope !== 'personal' ? 'workspace' : null, mailboxId: scope !== 'personal' ? 'mailbox' : null, origin: scope === 'human' ? 'human' : 'agent', outboxStatus: 'awaiting_review', version: 1, subject: 'Review subject', body: '<p><strong>Preserve me</strong></p>', isHtml: true, toJson: JSON.stringify(recipients.to ?? ['allowed@example.test']), ccJson: JSON.stringify(recipients.cc ?? []), bccJson: JSON.stringify(recipients.bcc ?? ['blind@example.test']), createdAt: now, updatedAt: now });
        return id;
      };
      let deliveries = 0;
      const deliver = async () => { deliveries++; return { sent: true }; };
      for (const field of ['to', 'cc', 'bcc'] as const) {
        const id = await fixture({ [field]: ['Blocked <blocked@outside.test>'] });
        const before = await get(id);
        const count = deliveries;
        await assert.rejects(send(id, 1, deliver), (error: unknown) => {
          assert.equal((error as { code: string }).code, 'SEND_POLICY_BLOCKED');
          return true;
        });
        assert.equal(deliveries, count, `${scope} ${field}: blocked before transport`);
        const failed = await get(id);
        assert.ok(failed);
        assert.equal(failed.status, 'send_failed');
        assert.equal(failed.errorCode, 'SEND_POLICY_BLOCKED');
        assert.match(failed.errorMessage || '', /blocked@outside.test/i);
        assert.ok(failed.failedAt);
        assert.ok(failed.policySettingsUrl);
        assert.equal(failed.body, before?.body);
        assert.deepEqual(failed[field], before?.[field]);
        assert.ok(failed.version > 1);
        await assert.rejects(send(id, 1, deliver), /changed|reload/i);
        const fixed = await edit(id, failed.version);
        const sent = await send(id, fixed.version, deliver);
        assert.equal(sent.status, 'sent');
        assert.equal(sent.errorCode, null);
        assert.deepEqual(sent.bcc, ['blind@example.test']);
      }
      for (const field of ['to', 'cc', 'bcc'] as const) {
        for (const unsafeRecipient of ['Allowed <allowed@example.test>, bad@outside.test', 'allowed@example.test\r\nBcc: bad@outside.test']) {
          const invalidId = await fixture({ [field]: [unsafeRecipient] });
          const beforeDelivery = deliveries;
          await assert.rejects(send(invalidId, 1, deliver));
          assert.equal(deliveries, beforeDelivery, 'Composite or injected mailbox must never reach transport');
          const invalid = await get(invalidId);
          assert.ok(invalid);
          assert.equal(invalid.status, 'send_failed');
          assert.equal(invalid.errorCode, 'SEND_FAILED');
          assert.deepEqual(invalid[field], [unsafeRecipient], 'Invalid draft remains repairable');
          const repaired = await edit(invalidId, invalid.version);
          assert.equal((await send(invalidId, repaired.version, deliver)).status, 'sent');
        }
      }
      const namedId = await fixture({ to: ['Allowed Person <ALLOWED@EXAMPLE.TEST>'], cc: ['Copy <copy@example.test>'], bcc: ['Blind <blind@example.test>'] });
      assert.equal((await send(namedId, 1, async (input) => {
        assert.deepEqual(input.to, ['allowed@example.test']);
        assert.deepEqual(input.cc, ['copy@example.test']);
        assert.deepEqual(input.bcc, ['blind@example.test']);
      })).status, 'sent', 'Transport receives exactly the canonical mailboxes checked by policy');
      const settingsId = await fixture({ to: ['new@outside.test'] });
      await assert.rejects(send(settingsId, 1, deliver));
      const settingsFailure = await get(settingsId);
      assert.ok(settingsFailure);
      await db.update(emailAccounts).set({ policyJson: JSON.stringify({ readFrom: [], sendTo: ['@example.test', 'new@outside.test'] }) }).where(eq(emailAccounts.id, 'account'));
      assert.equal((await send(settingsId, settingsFailure.version, deliver)).status, 'sent', 'Retry reads the corrected account policy');
      await db.update(emailAccounts).set({ policyJson: JSON.stringify({ readFrom: [], sendTo: ['@example.test'] }) }).where(eq(emailAccounts.id, 'account'));

      const inactiveId = await fixture();
      await db.update(emailAccounts).set({ status: 'revoked' }).where(eq(emailAccounts.id, 'account'));
      try {
        await assert.rejects(send(inactiveId, 1, deliver));
        const inactive = await get(inactiveId);
        assert.ok(inactive);
        assert.equal(inactive.status, 'send_failed');
        assert.ok(inactive.errorMessage);
        assert.equal(inactive.body, '<p><strong>Preserve me</strong></p>');
      } finally {
        await db.update(emailAccounts).set({ status: 'active' }).where(eq(emailAccounts.id, 'account'));
      }
      const rejectedId = await fixture();
      const rejected = await reject(rejectedId, 1);
      assert.equal(rejected.status, 'discarded');
      assert.equal(rejected.body, '<p><strong>Preserve me</strong></p>');
      await assert.rejects(reject(rejectedId, 1), /changed|reload|discard|reject/i);
      await assert.rejects(send(rejectedId, rejected.version, deliver), /cannot|discard|sent/i);
      const raceId = await fixture();
      const race = await Promise.allSettled([reject(raceId, 1), edit(raceId, 1)]);
      assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1, 'Only one decision wins the CAS');

      const lockedId = await fixture();
      let release!: () => void;
      let entered!: () => void;
      const inTransport = new Promise<void>((resolve) => { entered = resolve; });
      const pending = send(lockedId, 1, async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
      await inTransport;
      const locked = await get(lockedId);
      assert.ok(locked);
      assert.equal(locked.status, 'sending');
      await assert.rejects(edit(lockedId, locked.version), /edit|sending/i);
      await assert.rejects(reject(lockedId, locked.version), /cannot|reject|sending|discard/i);
      await assert.rejects(send(lockedId, locked.version, deliver), /cannot|sending/i);
      release();
      assert.equal((await pending).status, 'sent');

      const failureId = await fixture();
      await assert.rejects(send(failureId, 1, async () => { throw Object.assign(new Error('SMTP temporarily unavailable'), { responseCode: 451 }); }), /SMTP temporarily unavailable/);
      const failure = await get(failureId);
      assert.ok(failure);
      assert.equal(failure.status, 'send_failed');
      assert.equal(failure.errorCode, 'SEND_FAILED');
      assert.match(failure.errorMessage || '', /SMTP temporarily unavailable/);
      assert.equal((await send(failureId, failure.version, deliver)).status, 'sent');

      const timeoutId = await fixture();
      let timeoutDispatches = 0;
      await assert.rejects(send(timeoutId, 1, async () => {
        timeoutDispatches++;
        throw Object.assign(new Error('Connection timed out after DATA'), { code: 'ETIMEDOUT' });
      }), (error: unknown) => {
        assert.equal((error as { code: string }).code, 'SEND_UNCERTAIN');
        return true;
      });
      const timeoutDraft = await get(timeoutId);
      assert.ok(timeoutDraft);
      assert.equal(timeoutDraft.status, 'send_uncertain');
      assert.equal(timeoutDraft.errorCode, 'SEND_UNCERTAIN');
      assert.equal(timeoutDraft.body, '<p><strong>Preserve me</strong></p>');
      await assert.rejects(send(timeoutId, timeoutDraft.version, async () => { timeoutDispatches++; }));
      assert.equal(timeoutDispatches, 1, 'Unknown outcome must never dispatch twice');
      await assert.rejects(edit(timeoutId, timeoutDraft.version));
      await assert.rejects(reject(timeoutId, timeoutDraft.version));

      // A transport success followed by failed persistence must never become retryable.
      const uncertainId = await fixture();
      const sql = database.getPostgresRuntimeQueryable();
      await sql.exec(`CREATE OR REPLACE FUNCTION reject_sent_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outbox_status = 'sent' THEN RAISE EXCEPTION 'finalize unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_finalize_failure BEFORE UPDATE ON email_drafts FOR EACH ROW EXECUTE FUNCTION reject_sent_transition();`);
      try {
        await assert.rejects(send(uncertainId, 1, deliver), (error: unknown) => {
          assert.equal((error as { code: string }).code, 'SEND_UNCERTAIN');
          return true;
        });
      } finally {
        await sql.exec('DROP TRIGGER test_finalize_failure ON email_drafts; DROP FUNCTION reject_sent_transition();');
      }
      const uncertain = await get(uncertainId);
      assert.ok(uncertain);
      assert.equal(uncertain.status, 'send_uncertain');
      await assert.rejects(send(uncertainId, uncertain.version, deliver));
      await assert.rejects(edit(uncertainId, uncertain.version));
      await assert.rejects(reject(uncertainId, uncertain.version));
      if (scope !== 'personal') {
        const auditId = await fixture();
        auditFails = true;
        try { assert.equal((await send(auditId, 1, deliver)).status, 'sent'); } finally { auditFails = false; }
        assert.equal((await get(auditId))?.status, 'sent');
      }
      assert.equal((await db.query.emailDrafts.findFirst({ where: eq(emailDrafts.id, failureId) }))?.body, '<p><strong>Preserve me</strong></p>');
    }
    console.log('email-outbox-review-test: ok (personal/workspace policy, persistence, CAS, locks, retry, uncertain delivery)');
  } finally {
    modules._load = originalLoad;
    await database.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
