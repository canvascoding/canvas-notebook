import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import { ensureOrganizationBootstrapForUser } from '../app/lib/organization/bootstrap';

const moduleInternals = Module as typeof Module & {
  _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = (request, parent, isMain) => {
  if (request === 'server-only') return {};
  return originalLoad(request, parent, isMain);
};

type WorkspaceRow = { id: string };
type SentEmailInput = { to: string[]; subject: string; body: string; attachments: Array<{ uploadId?: string }> };

function requireSentEmailInput(input: SentEmailInput | null): SentEmailInput {
  if (!input) throw new Error('Expected the workspace outbox draft to be sent.');
  return input;
}

function verifyLegacyEmailAccountMigration() {
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`
      CREATE TABLE email_accounts (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        email_address TEXT NOT NULL,
        display_name TEXT,
        provider_account_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        policy_json TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    runMigrations(legacy);
    runMigrations(legacy);

    const columns = legacy.prepare('PRAGMA table_info(email_accounts)').all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'workspace_id'));
    assert.ok(legacy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_email_accounts_workspace'").get());
  } finally {
    legacy.close();
  }
}

async function main() {
  verifyLegacyEmailAccountMigration();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-email-workspace-binding-'));
  const dataRoot = path.join(tempRoot, 'data');
  const dbPath = path.join(dataRoot, 'sqlite.db');
  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  await fs.mkdir(dataRoot, { recursive: true });
  const sqlite = new Database(dbPath);
  try {
    runMigrations(sqlite);
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('owner-user', 'Owner', 'owner@example.test', 1, 'admin', now, now);
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('other-user', 'Other', 'other@example.test', 1, 'member', now, now);

    sqlite.exec('BEGIN IMMEDIATE');
    ensureOrganizationBootstrapForUser(sqlite, 'owner-user');
    ensureOrganizationBootstrapForUser(sqlite, 'other-user');
    sqlite.exec('COMMIT');

    const ownerWorkspace = sqlite.prepare(`
      SELECT id FROM canvas_workspaces WHERE type = 'personal' AND owner_user_id = ?
    `).get('owner-user') as WorkspaceRow | undefined;
    const otherWorkspace = sqlite.prepare(`
      SELECT id FROM canvas_workspaces WHERE type = 'personal' AND owner_user_id = ?
    `).get('other-user') as WorkspaceRow | undefined;
    assert.ok(ownerWorkspace?.id);
    assert.ok(otherWorkspace?.id);

    const {
      assignStoredEmailAccountWorkspace,
      requireActiveWorkspaceMailboxForAutomation,
      upsertOAuthEmailAccount,
    } = await import('../app/lib/email/account-store');
    const created = await upsertOAuthEmailAccount({
      userId: 'owner-user',
      provider: 'google',
      providerAccountId: 'owner-google',
      emailAddress: 'owner@example.test',
      displayName: 'Owner',
      secret: { authType: 'oauth', tokenType: 'Bearer', accessToken: 'test-token' },
    });
    assert.equal(created.workspaceId, null);

    const assigned = await assignStoredEmailAccountWorkspace('owner-user', created.id, ownerWorkspace.id);
    assert.equal(assigned.workspaceId, ownerWorkspace.id);
    assert.equal(
      (await requireActiveWorkspaceMailboxForAutomation({
        emailAccountId: created.id,
        workspaceId: ownerWorkspace.id,
      })).workspaceId,
      ownerWorkspace.id,
    );
    await assert.rejects(
      () => requireActiveWorkspaceMailboxForAutomation({
        emailAccountId: created.id,
        workspaceId: otherWorkspace.id,
      }),
      /not actively assigned/i,
    );
    const { createAutomationJob, listDueAutomationJobs } = await import('../app/lib/automations/store');
    const eventAutomation = await createAutomationJob({
      name: 'Email triage',
      prompt: 'Prepare an outbox draft but never send it.',
      workspaceId: ownerWorkspace.id,
      triggerKind: 'event',
      eventConfig: { eventType: 'email_inbox_event', mailboxId: created.id },
      resultPolicy: 'record_only',
      schedule: { kind: 'daily', times: ['09:00'], timeZone: 'UTC' },
    }, { id: 'owner-user', email: 'owner@example.test', role: 'admin' });
    assert.equal(eventAutomation.triggerKind, 'event');
    assert.deepEqual(eventAutomation.eventConfig, { eventType: 'email_inbox_event', mailboxId: created.id });
    assert.equal(eventAutomation.nextRunAt, null);
    assert.equal((await listDueAutomationJobs(new Date(Date.now() + 86_400_000))).some((job) => job.id === eventAutomation.id), false);
    await assert.rejects(
      () => createAutomationJob({
        name: 'Duplicate email triage',
        prompt: 'Prepare another draft but never send it.',
        workspaceId: ownerWorkspace.id,
        triggerKind: 'event',
        eventConfig: { eventType: 'email_inbox_event', mailboxId: created.id },
        resultPolicy: 'record_only',
        schedule: { kind: 'daily', times: ['10:00'], timeZone: 'UTC' },
      }, { id: 'owner-user', email: 'owner@example.test', role: 'admin' }),
      /already configured for this mailbox/i,
    );
    const { pollWorkspaceMailboxInboxEvents } = await import('../app/lib/email/inbox-events');
    const pollNow = new Date(Date.now() + 1_000);
    const firstPoll = await pollWorkspaceMailboxInboxEvents({
      now: pollNow,
      fetchMessages: async () => [
        { id: 'historical-message', date: new Date(pollNow.getTime() - 60_000).toISOString() },
        { id: 'new-message', threadId: 'thread-1', date: pollNow.toISOString(), folder: 'INBOX' },
      ],
    });
    assert.deepEqual(firstPoll, { checked: 1, created: 1, duplicate: 0, historical: 1, failed: 0 });
    const duplicatePoll = await pollWorkspaceMailboxInboxEvents({
      now: new Date(pollNow.getTime() + 1_000),
      fetchMessages: async () => [{ id: 'new-message', threadId: 'thread-1', date: pollNow.toISOString(), folder: 'INBOX' }],
    });
    assert.deepEqual(duplicatePoll, { checked: 1, created: 0, duplicate: 1, historical: 0, failed: 0 });
    const storedEvent = sqlite.prepare(`
      SELECT id, workspace_id, provider_message_id, provider_thread_id, status
      FROM email_inbox_events WHERE provider_message_id = 'new-message'
    `).get() as { id: string; workspace_id: string; provider_message_id: string; provider_thread_id: string; status: string } | undefined;
    assert.equal(storedEvent?.workspace_id, ownerWorkspace.id);
    assert.equal(storedEvent?.provider_message_id, 'new-message');
    assert.equal(storedEvent?.provider_thread_id, 'thread-1');
    assert.equal(storedEvent?.status, 'pending');
    assert.ok(storedEvent?.id);
    const activeMailbox = sqlite.prepare(`
      SELECT id, workspace_id, status, created_by_user_id, last_edited_by_user_id
      FROM workspace_email_mailboxes
      WHERE email_account_id = ? AND status = 'active'
    `).get(created.id) as {
      id: string;
      workspace_id: string;
      status: string;
      created_by_user_id: string;
      last_edited_by_user_id: string;
    } | undefined;
    assert.deepEqual(activeMailbox, {
      id: activeMailbox?.id,
      workspace_id: ownerWorkspace.id,
      status: 'active',
      created_by_user_id: 'owner-user',
      last_edited_by_user_id: 'owner-user',
    });
    assert.ok(activeMailbox?.id);
    const {
      getWorkspaceEmailAutomationEventContext,
      markWorkspaceEmailAutomationEventRunFinished,
      migrateWorkspaceEmailAutomationJobs,
      queuePendingWorkspaceEmailAutomationRuns,
    } = await import('../app/lib/email/workspace-email-automation-events');
    sqlite.prepare(`UPDATE automation_jobs SET event_config_json = ? WHERE id = ?`).run(
      JSON.stringify({ eventType: 'email_inbox_event', mailboxId: created.id, outboundMode: 'draft_only' }),
      eventAutomation.id,
    );
    assert.equal(await migrateWorkspaceEmailAutomationJobs(), 1);
    const migratedEventConfig = sqlite.prepare(`SELECT event_config_json FROM automation_jobs WHERE id = ?`).get(eventAutomation.id) as { event_config_json: string };
    assert.deepEqual(JSON.parse(migratedEventConfig.event_config_json), { eventType: 'email_inbox_event', mailboxId: created.id });
    const queued = await queuePendingWorkspaceEmailAutomationRuns();
    assert.deepEqual(queued, { checked: 1, queued: 1, deferred: 0, ignored: 0, failed: 0 });
    const queuedEvent = sqlite.prepare(`SELECT status FROM email_inbox_events WHERE provider_message_id = 'new-message'`).get() as { status: string };
    assert.equal(queuedEvent.status, 'queued');
    const automationStore = await import('../app/lib/automations/store');
    const runs = await automationStore.listAutomationRuns(eventAutomation.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].triggerType, 'event');
    const queuedRun = await automationStore.getAutomationRun(runs[0].id);
    assert.ok(queuedRun);
    assert.deepEqual(queuedRun.metadataJson, { emailInboxEventId: storedEvent.id });
    const eventContext = await getWorkspaceEmailAutomationEventContext({ job: eventAutomation, run: queuedRun });
    assert.deepEqual(eventContext && {
      eventId: eventContext.eventId,
      mailboxId: eventContext.mailboxId,
      providerMessageId: eventContext.providerMessageId,
      providerThreadId: eventContext.providerThreadId,
      folder: eventContext.folder,
      hasAttachments: eventContext.hasAttachments,
    }, {
      eventId: eventContext?.eventId,
      mailboxId: activeMailbox?.id,
      providerMessageId: 'new-message',
      providerThreadId: 'thread-1',
      folder: 'INBOX',
      hasAttachments: false,
    });
    assert.match(eventContext?.sessionId || '', /^automation-email:/);
    await markWorkspaceEmailAutomationEventRunFinished({ run: queuedRun, status: 'success' });
    const processedEvent = sqlite.prepare(`SELECT status, processed_at, error_code FROM email_inbox_events WHERE id = ?`).get(storedEvent.id) as {
      status: string; processed_at: number | null; error_code: string | null;
    };
    assert.equal(processedEvent.status, 'processed');
    assert.ok(processedEvent.processed_at);
    assert.equal(processedEvent.error_code, null);
    const { createWorkspaceInboxCase, createWorkspaceOutboxDraft, listWorkspaceInboxCases, listWorkspaceOutboxDrafts, sendWorkspaceOutboxDraft, updateWorkspaceOutboxDraft } = await import('../app/lib/email/workspace-inbox-outbox');
    const inboxCase = await createWorkspaceInboxCase({
      userId: 'owner-user', workspaceId: ownerWorkspace.id, mailboxId: activeMailbox.id,
      providerThreadId: 'thread-1', latestProviderMessageId: 'new-message', requesterAddress: 'customer@example.test', subject: 'Support request',
    });
    assert.equal((await listWorkspaceInboxCases('owner-user', ownerWorkspace.id)).length, 1);
    const outboxDraft = await createWorkspaceOutboxDraft({
      userId: 'owner-user', workspaceId: ownerWorkspace.id, mailboxId: activeMailbox.id, inboxCaseId: inboxCase.id,
      subject: 'Re: Support request', body: 'We will help.\n\nBest regards,', to: ['customer@example.test'],
      attachments: [{ source: 'upload', uploadId: 'agent-report.pdf', name: 'agent-report.pdf', mimeType: 'application/pdf', size: 42 }],
    });
    assert.equal(outboxDraft.status, 'awaiting_review');
    assert.equal(outboxDraft.body, '<p>We will help.</p><p>Best regards,</p>');
    assert.deepEqual(outboxDraft.attachments, [{
      source: 'upload', contentId: undefined, disposition: 'attachment', name: 'agent-report.pdf', mimeType: 'application/pdf',
      size: 42, path: undefined, uploadId: 'agent-report.pdf', deliveryFormat: undefined,
    }]);
    assert.equal((await listWorkspaceInboxCases('owner-user', ownerWorkspace.id)).find((item) => item.id === inboxCase.id)?.status, 'awaiting_review');
    const edited = await updateWorkspaceOutboxDraft({
      userId: 'owner-user', workspaceId: ownerWorkspace.id, draftId: outboxDraft.id, expectedVersion: 1,
      subject: 'Re: Support request', body: 'We will help shortly.',
      bodyHtml: '<p>We will <strong>help shortly</strong>.</p><ul><li>Compare the offers</li><li>Choose a provider</li></ul><script>alert(1)</script>',
      to: ['customer@example.test'], status: 'editing',
    });
    assert.equal(edited.version, 2);
    assert.match(edited.body, /<strong>help shortly<\/strong>/);
    assert.match(edited.body, /<ul><li>Compare the offers<\/li><li>Choose a provider<\/li><\/ul>/);
    assert.doesNotMatch(edited.body, /script|alert\(1\)/i);
    await assert.rejects(
      () => updateWorkspaceOutboxDraft({
        userId: 'owner-user', workspaceId: ownerWorkspace.id, draftId: outboxDraft.id, expectedVersion: 1,
        subject: 'Re: Support request', body: '<p>Stale update</p>', to: ['customer@example.test'],
      }),
      /has changed/i,
    );
    await assert.rejects(
      () => updateWorkspaceOutboxDraft({
        userId: 'owner-user', workspaceId: ownerWorkspace.id, draftId: outboxDraft.id, expectedVersion: edited.version,
        subject: 'Re: Support request', body: '<p>Automated overwrite</p>', to: ['customer@example.test'], actor: 'agent',
      }),
      /being reviewed by a person/i,
    );
    let sentInput: SentEmailInput | null = null;
    const sent = await sendWorkspaceOutboxDraft({
      userId: 'owner-user', workspaceId: ownerWorkspace.id, draftId: outboxDraft.id, expectedVersion: edited.version,
    }, {
      sendMessage: async (input) => { sentInput = { to: input.to, subject: input.subject, body: input.body, attachments: input.attachments }; },
    });
    assert.equal(sent.status, 'sent');
    const sentEmailInput = requireSentEmailInput(sentInput);
    assert.deepEqual(sentEmailInput.to, ['customer@example.test']);
    assert.equal(sentEmailInput.subject, 'Re: Support request');
    assert.match(sentEmailInput.body, /<strong>help shortly<\/strong>/);
    assert.match(sentEmailInput.body, /<ul><li>Compare the offers<\/li><li>Choose a provider<\/li><\/ul>/);
    assert.deepEqual(sentEmailInput.attachments, [{
      source: 'upload', contentId: undefined, disposition: 'attachment', name: 'agent-report.pdf', mimeType: 'application/pdf',
      size: 42, path: undefined, uploadId: 'agent-report.pdf', deliveryFormat: undefined,
    }]);
    assert.equal((await listWorkspaceInboxCases('owner-user', ownerWorkspace.id)).find((item) => item.id === inboxCase.id)?.status, 'answered');
    assert.ok((await listWorkspaceOutboxDrafts('owner-user', ownerWorkspace.id)).some((draft) => draft.id === outboxDraft.id));
    await assert.rejects(
      () => listWorkspaceInboxCases('owner-user', otherWorkspace.id),
      /workspace|permission|access/i,
    );
    await assert.rejects(
      () => listWorkspaceOutboxDrafts('owner-user', otherWorkspace.id),
      /workspace|permission|access/i,
    );

    await assert.rejects(
      () => assignStoredEmailAccountWorkspace('owner-user', created.id, otherWorkspace.id),
      /workspace|access|permission/i,
    );
    const stillAssigned = await assignStoredEmailAccountWorkspace('owner-user', created.id, ownerWorkspace.id);
    assert.equal(stillAssigned.workspaceId, ownerWorkspace.id);

    const cleared = await assignStoredEmailAccountWorkspace('owner-user', created.id, null);
    assert.equal(cleared.workspaceId, null);
    const {
      createPersonalInboxCase,
      createPersonalOutboxDraft,
      listPersonalInboxCases,
      listPersonalOutboxDrafts,
      sendPersonalOutboxDraft,
      updatePersonalOutboxDraft,
    } = await import('../app/lib/email/workspace-inbox-outbox');
    const personalCase = await createPersonalInboxCase({
      userId: 'owner-user', accountId: created.id, providerThreadId: 'personal-thread-1',
      latestProviderMessageId: 'personal-message-1', requesterAddress: 'friend@example.test', subject: 'Private request',
    });
    assert.equal(personalCase.workspaceId, null);
    assert.equal(personalCase.mailboxId, `account:${created.id}`);
    assert.equal((await listPersonalInboxCases('owner-user')).find((item) => item.id === personalCase.id)?.subject, 'Private request');
    const personalDraft = await createPersonalOutboxDraft({
      userId: 'owner-user', accountId: created.id, inboxCaseId: personalCase.id,
      subject: 'Re: Private request', body: '<p>Happy to help.</p>', to: ['friend@example.test'],
    });
    assert.equal(personalDraft.status, 'awaiting_review');
    assert.equal((await listPersonalInboxCases('owner-user')).find((item) => item.id === personalCase.id)?.status, 'awaiting_review');
    const editedPersonalDraft = await updatePersonalOutboxDraft({
      userId: 'owner-user', draftId: personalDraft.id, expectedVersion: personalDraft.version,
      subject: 'Re: Private request', body: '<p>Happy to help shortly.</p>', to: ['friend@example.test'], status: 'editing',
    });
    const sentPersonal = await sendPersonalOutboxDraft({
      userId: 'owner-user', draftId: personalDraft.id, expectedVersion: editedPersonalDraft.version,
    }, {
      sendMessage: async () => undefined,
    });
    assert.equal(sentPersonal.status, 'sent');
    assert.ok((await listPersonalOutboxDrafts('owner-user')).some((draft) => draft.id === personalDraft.id));
    await assert.rejects(
      () => requireActiveWorkspaceMailboxForAutomation({
        emailAccountId: created.id,
        workspaceId: ownerWorkspace.id,
      }),
      /not actively assigned/i,
    );
    await assert.rejects(
      () => createAutomationJob({
        name: 'Unassigned email triage',
        prompt: 'Prepare an outbox draft but never send it.',
        workspaceId: ownerWorkspace.id,
        triggerKind: 'event',
        eventConfig: { eventType: 'email_inbox_event', mailboxId: created.id },
        resultPolicy: 'record_only',
        schedule: { kind: 'daily', times: ['09:00'], timeZone: 'UTC' },
      }, { id: 'owner-user', email: 'owner@example.test', role: 'admin' }),
      /not actively assigned/i,
    );
    const archivedMailboxCount = sqlite.prepare(`
      SELECT COUNT(*) AS count FROM workspace_email_mailboxes
      WHERE email_account_id = ? AND status = 'archived'
    `).get(created.id) as { count: number };
    assert.equal(archivedMailboxCount.count, 1);

    const {
      assignAdminWorkspaceMailbox,
      listAdminWorkspaceMailboxes,
      removeAdminWorkspaceMailbox,
      saveAdminWorkspaceMailbox,
    } = await import('../app/lib/email/workspace-mailbox-store');
    const sharedMailbox = await saveAdminWorkspaceMailbox('owner-user', {
      emailAddress: 'support@example.test',
      displayName: 'Support',
      smtpHost: 'smtp.example.test',
      smtpPort: 587,
      smtpSecure: false,
      smtpUsername: 'support@example.test',
      smtpPassword: 'workspace-secret',
      imapHost: 'imap.example.test',
      imapPort: 993,
      imapSecure: true,
      imapUsername: 'support@example.test',
      imapPassword: 'workspace-secret',
    });
    assert.equal(sharedMailbox.workspaceId, null);
    assert.equal(sharedMailbox.emailAddress, 'support@example.test');
    assert.equal(sharedMailbox.imapHost, 'imap.example.test');
    assert.equal((await listAdminWorkspaceMailboxes()).some((mailbox) => mailbox.id === sharedMailbox.id), true);
    const savedAgain = await saveAdminWorkspaceMailbox('owner-user', {
      emailAddress: 'support@example.test',
      displayName: 'Support desk',
      smtpHost: 'smtp.example.test',
      smtpPort: 587,
      smtpSecure: false,
      smtpUsername: 'support@example.test',
      smtpPassword: 'rotated-workspace-secret',
      imapHost: 'imap.example.test',
      imapPort: 993,
      imapSecure: true,
      imapUsername: 'support@example.test',
      imapPassword: 'rotated-workspace-secret',
    });
    assert.equal(savedAgain.id, sharedMailbox.id);
    assert.equal(savedAgain.accountId, sharedMailbox.accountId);
    assert.equal(savedAgain.displayName, 'Support desk');
    assert.equal((await listAdminWorkspaceMailboxes()).filter((mailbox) => mailbox.emailAddress === 'support@example.test').length, 1);
    const assignedSharedMailbox = await assignAdminWorkspaceMailbox({
      actorUserId: 'owner-user', accountId: sharedMailbox.id, workspaceId: ownerWorkspace.id,
    });
    assert.equal(assignedSharedMailbox.workspaceId, ownerWorkspace.id);
    assert.ok(assignedSharedMailbox.mailboxId);
    assert.equal(
      (await requireActiveWorkspaceMailboxForAutomation({
        emailAccountId: sharedMailbox.accountId,
        workspaceId: ownerWorkspace.id,
      })).id,
      assignedSharedMailbox.mailboxId,
    );
    const { listPublicEmailAccountsForUser } = await import('../app/lib/email/account-store');
    assert.equal(
      (await listPublicEmailAccountsForUser('owner-user')).some((account) => account.id === sharedMailbox.accountId),
      false,
    );
    await removeAdminWorkspaceMailbox('owner-user', sharedMailbox.id);
    assert.equal((await listAdminWorkspaceMailboxes()).some((mailbox) => mailbox.id === sharedMailbox.id), false);
    await assert.rejects(
      () => requireActiveWorkspaceMailboxForAutomation({
        emailAccountId: sharedMailbox.accountId,
        workspaceId: ownerWorkspace.id,
      }),
      /not actively assigned/i,
    );
  } finally {
    sqlite.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  console.log('Email account workspace binding test passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
