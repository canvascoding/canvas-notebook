import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorkspaceContext } from '../app/lib/workspaces/types';

const personalWorkspace: WorkspaceContext = {
  workspaceId: 'personal-workspace',
  workspaceType: 'personal',
  rootPath: '/private/data/workspaces/personal/email-user/files',
  ownerUserId: 'email-user',
  permissions: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canCreatePublicLinks: true,
    canManageWorkspace: true,
    canRunAgent: true,
  },
  legacy: false,
};

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-email-'));
  const originalData = process.env.DATA;
  const originalProvider = process.env.CANVAS_DATABASE_PROVIDER;
  process.env.DATA = path.join(temporaryRoot, 'data');
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  try {
    const { closeDatabaseConnections, openDb } = await import('../app/lib/db');
    const database = await openDb();
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1_000);
    await database.run(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['email-user', 'Email User', 'email@example.test', 1, nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['other-reviewer', 'Other Reviewer', 'other@example.test', 1, nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO email_accounts (
        id, user_id, provider, auth_type, email_address, status, policy_json, secret_ref,
        is_primary, account_scope, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['email-account', 'email-user', 'google', 'oauth', 'email@example.test', 'active', '{}', 'secret-ref', 1, 'personal', nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO personal_email_inbox_cases (
        id, user_id, email_account_id, provider_thread_id, requester_address, requester_name,
        subject, status, priority, assignee_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['email-case', 'email-user', 'email-account', 'provider-thread', 'sender@example.test', 'Sender', 'Need help', 'awaiting_review', 'high', 'email-user', nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO email_drafts (
        id, user_id, account_id, status, to_json, cc_json, bcc_json, subject, body, is_html,
        attachments_json, origin, personal_inbox_case_id, outbox_status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['email-review', 'email-user', 'email-account', 'draft', '["sender@example.test"]', '[]', '[]', 'Re: Need help', '<p>We can help.</p>', 1, '[]', 'agent', 'email-case', 'awaiting_review', 3, nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO email_drafts (
        id, user_id, account_id, status, to_json, cc_json, bcc_json, subject, body, is_html,
        attachments_json, origin, outbox_status, version, editing_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['email-review-locked', 'email-user', 'email-account', 'draft', '[]', '[]', '[]', 'Locked', '<p>Locked</p>', 1, '[]', 'agent', 'editing', 1, 'other-reviewer', nowSeconds, nowSeconds],
    );
    await database.close();

    const { MobileEmailError, getMobileEmailCase, getMobileEmailReview } = await import('../app/lib/mobile/email');
    const review = await getMobileEmailReview({ userId: 'email-user', workspace: personalWorkspace, draftId: 'email-review' });
    assert.deepEqual(review, {
      id: 'email-review',
      status: 'awaiting_review',
      version: 3,
      subject: 'Re: Need help',
      body: '<p>We can help.</p>',
      to: ['sender@example.test'],
      cc: [],
      bcc: [],
      isHtml: true,
      editingByOther: false,
      canSend: true,
      updatedAt: new Date(nowSeconds * 1_000).toISOString(),
    });
    const lockedReview = await getMobileEmailReview({ userId: 'email-user', workspace: personalWorkspace, draftId: 'email-review-locked' });
    assert.equal(lockedReview.editingByOther, true);
    assert.equal(lockedReview.canSend, false);

    const emailCase = await getMobileEmailCase({ userId: 'email-user', workspace: personalWorkspace, caseId: 'email-case' });
    assert.deepEqual(emailCase, {
      id: 'email-case',
      subject: 'Need help',
      requesterName: 'Sender',
      requesterAddress: 'sender@example.test',
      status: 'awaiting_review',
      priority: 'high',
      assigneeUserId: 'email-user',
      updatedAt: new Date(nowSeconds * 1_000).toISOString(),
    });
    await assert.rejects(
      () => getMobileEmailReview({ userId: 'email-user', workspace: personalWorkspace, draftId: 'another-user-draft' }),
      (error: unknown) => error instanceof MobileEmailError && error.code === 'EMAIL_REVIEW_NOT_FOUND' && error.status === 404,
    );
  } finally {
    const { closeDatabaseConnections } = await import('../app/lib/db');
    await closeDatabaseConnections();
    if (originalData === undefined) delete process.env.DATA;
    else process.env.DATA = originalData;
    if (originalProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = originalProvider;
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

void main().then(() => {
  console.log('mobile-email-contract-test: ok');
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
