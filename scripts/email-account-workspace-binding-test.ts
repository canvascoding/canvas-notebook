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

async function main() {
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
      SELECT workspace_id, provider_message_id, provider_thread_id, status
      FROM email_inbox_events WHERE provider_message_id = 'new-message'
    `).get() as { workspace_id: string; provider_message_id: string; provider_thread_id: string; status: string } | undefined;
    assert.deepEqual(storedEvent, {
      workspace_id: ownerWorkspace.id,
      provider_message_id: 'new-message',
      provider_thread_id: 'thread-1',
      status: 'pending',
    });
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
    const { processPendingWorkspaceEmailTriageEvents } = await import('../app/lib/email/workspace-triage');
    const triage = await processPendingWorkspaceEmailTriageEvents({
      readMessage: async () => ({
        message: {
          id: 'new-message', threadId: 'thread-triage', from: 'Customer <customer@example.test>',
          subject: 'Need help', body: 'Please help us with our workspace.', snippet: 'Please help us',
        },
      }),
      draftReply: async () => 'Thank you for reaching out. We will review this and get back to you shortly.',
    });
    assert.deepEqual(triage, { checked: 1, processed: 0, ignored: 0, drafted: 1, failed: 0 });
    const processedEvent = sqlite.prepare(`SELECT status, case_id FROM email_inbox_events WHERE provider_message_id = 'new-message'`).get() as { status: string; case_id: string | null };
    assert.equal(processedEvent.status, 'processed');
    assert.ok(processedEvent.case_id);
    const { createWorkspaceInboxCase, createWorkspaceOutboxDraft, listWorkspaceInboxCases, listWorkspaceOutboxDrafts, updateWorkspaceOutboxDraft } = await import('../app/lib/email/workspace-inbox-outbox');
    const inboxCase = await createWorkspaceInboxCase({
      userId: 'owner-user', workspaceId: ownerWorkspace.id, mailboxId: activeMailbox.id,
      providerThreadId: 'thread-1', latestProviderMessageId: 'new-message', requesterAddress: 'customer@example.test', subject: 'Support request',
    });
    assert.equal((await listWorkspaceInboxCases('owner-user', ownerWorkspace.id)).length, 2);
    const outboxDraft = await createWorkspaceOutboxDraft({
      userId: 'owner-user', workspaceId: ownerWorkspace.id, mailboxId: activeMailbox.id, inboxCaseId: inboxCase.id,
      subject: 'Re: Support request', body: '<p>We will help.</p>', to: ['customer@example.test'],
    });
    assert.equal(outboxDraft.status, 'awaiting_review');
    const edited = await updateWorkspaceOutboxDraft({
      userId: 'owner-user', workspaceId: ownerWorkspace.id, draftId: outboxDraft.id, expectedVersion: 1,
      subject: 'Re: Support request', body: '<p>We will help shortly.</p>', to: ['customer@example.test'], status: 'editing',
    });
    assert.equal(edited.version, 2);
    await assert.rejects(
      () => updateWorkspaceOutboxDraft({
        userId: 'owner-user', workspaceId: ownerWorkspace.id, draftId: outboxDraft.id, expectedVersion: 1,
        subject: 'Re: Support request', body: '<p>Stale update</p>', to: ['customer@example.test'],
      }),
      /has changed/i,
    );
    assert.ok((await listWorkspaceOutboxDrafts('owner-user', ownerWorkspace.id)).some((draft) => draft.id === outboxDraft.id));

    await pollWorkspaceMailboxInboxEvents({
      now: new Date(pollNow.getTime() + 2_000),
      fetchMessages: async () => [{ id: 'auto-message', threadId: 'thread-auto', date: new Date(pollNow.getTime() + 2_000).toISOString(), folder: 'INBOX' }],
    });
    const autoTriage = await processPendingWorkspaceEmailTriageEvents({
      readMessage: async () => ({
        message: { id: 'auto-message', threadId: 'thread-auto', from: 'Mailer-Daemon <mailer-daemon@example.test>', subject: 'Delivery status notification', body: 'This is an automated message.' },
      }),
      draftReply: async () => { throw new Error('Automatic messages must not produce a draft.'); },
    });
    assert.deepEqual(autoTriage, { checked: 1, processed: 0, ignored: 1, drafted: 0, failed: 0 });

    await assert.rejects(
      () => assignStoredEmailAccountWorkspace('owner-user', created.id, otherWorkspace.id),
      /workspace|access|permission/i,
    );
    const stillAssigned = await assignStoredEmailAccountWorkspace('owner-user', created.id, ownerWorkspace.id);
    assert.equal(stillAssigned.workspaceId, ownerWorkspace.id);

    const cleared = await assignStoredEmailAccountWorkspace('owner-user', created.id, null);
    assert.equal(cleared.workspaceId, null);
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
