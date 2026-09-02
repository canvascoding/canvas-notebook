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

const teamWorkspace: WorkspaceContext = {
  workspaceId: 'team-workspace',
  workspaceType: 'team',
  rootPath: '/private/data/workspaces/team/team-workspace/files',
  organizationId: 'email-organization',
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

const readOnlyTeamWorkspace: WorkspaceContext = {
  ...teamWorkspace,
  permissions: {
    ...teamWorkspace.permissions,
    canWrite: false,
    canDelete: false,
    canManageWorkspace: false,
  },
};

async function main() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-mobile-email-'));
  const originalData = process.env.DATA;
  const originalProvider = process.env.CANVAS_DATABASE_PROVIDER;
  process.env.DATA = path.join(temporaryRoot, 'data');
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';

  try {
    const { openDb } = await import('../app/lib/db');
    const database = await openDb();
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1_000);
    await database.run(
      `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['email-user', 'Email User', 'email@example.test', 1, 'admin', nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['other-reviewer', 'Other Reviewer', 'other@example.test', 1, 'member', nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['read-only-reviewer', 'Read-only Reviewer', 'readonly@example.test', 1, 'member', nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO canvas_organization_settings (
        organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      ['email-organization', 'email-user', 'team', 1, nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO organization_user_permissions (
        organization_id, user_id, role, status, can_write_team_workspace, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['email-organization', 'email-user', 'owner', 'active', 1, nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO organization_user_permissions (
        organization_id, user_id, role, status, can_write_team_workspace, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['email-organization', 'read-only-reviewer', 'member', 'active', 0, nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO canvas_workspaces (
        id, organization_id, type, owner_user_id, root_relative_path, display_name,
        status, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['team-workspace', 'email-organization', 'team', 'email-user', 'workspaces/team/team-workspace/files', 'Email Team', 'active', 0, nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO canvas_workspace_members (
        organization_id, workspace_id, user_id, role, status, can_read, can_write, can_manage,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['email-organization', 'team-workspace', 'email-user', 'owner', 'active', 1, 1, 1, nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO canvas_workspace_members (
        organization_id, workspace_id, user_id, role, status, can_read, can_write, can_manage,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['email-organization', 'team-workspace', 'read-only-reviewer', 'member', 'active', 1, 0, 0, nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO email_accounts (
        id, user_id, provider, auth_type, email_address, status, policy_json, secret_ref,
        is_primary, account_scope, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['email-account', 'email-user', 'google', 'oauth', 'email@example.test', 'active', '{}', 'secret-ref', 1, 'personal', nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO email_accounts (
        id, user_id, provider, auth_type, email_address, status, policy_json, secret_ref,
        is_primary, account_scope, workspace_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['team-email-account', 'email-user', 'google', 'oauth', 'support@example.test', 'active', '{}', 'team-secret-ref', 0, 'workspace', 'team-workspace', nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO workspace_email_mailboxes (
        id, workspace_id, email_account_id, status, role, created_by_user_id,
        last_edited_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['team-mailbox', 'team-workspace', 'team-email-account', 'active', 'inbound_outbound', 'email-user', 'email-user', nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO personal_email_inbox_cases (
        id, user_id, email_account_id, provider_thread_id, requester_address, requester_name,
        subject, status, priority, assignee_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['email-case', 'email-user', 'email-account', 'provider-thread', 'sender@example.test', 'Sender', 'Need help', 'awaiting_review', 'high', 'email-user', nowSeconds, nowSeconds],
    );
    await database.run(
      `INSERT INTO email_inbox_cases (
        id, workspace_id, mailbox_id, provider_thread_id, requester_address, requester_name,
        subject, status, priority, assignee_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['team-email-case', 'team-workspace', 'team-mailbox', 'team-provider-thread', 'business@example.test', 'Business Sender', 'Business request', 'awaiting_review', 'urgent', 'email-user', nowSeconds, nowSeconds],
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
    await database.run(
      `INSERT INTO email_drafts (
        id, user_id, account_id, workspace_id, mailbox_id, status, to_json, cc_json, bcc_json,
        subject, body, is_html, attachments_json, origin, inbox_case_id, outbox_status,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['team-email-review', 'email-user', 'team-email-account', 'team-workspace', 'team-mailbox', 'draft', '["business@example.test"]', '[]', '[]', 'Re: Business request', '<p>Approved response.</p>', 1, '[]', 'automation', 'team-email-case', 'awaiting_review', 7, nowSeconds, nowSeconds],
    );
    await database.close();

    const {
      MobileEmailError,
      getMobileEmailCase,
      getMobileEmailReview,
      sendMobileEmailReview,
    } = await import('../app/lib/mobile/email');
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
    await assert.rejects(
      () => sendMobileEmailReview({
        userId: 'email-user',
        workspace: personalWorkspace,
        draftId: 'email-review',
        expectedVersion: 2,
      }, { sendMessage: async () => undefined }),
      (error: unknown) => error instanceof MobileEmailError
        && error.code === 'EMAIL_REVIEW_VERSION_CONFLICT'
        && error.status === 409,
    );
    let personalSendUserId: string | null = null;
    const sentPersonalReview = await sendMobileEmailReview({
      userId: 'email-user',
      workspace: personalWorkspace,
      draftId: 'email-review',
      expectedVersion: 3,
    }, {
      sendMessage: async (input) => {
        personalSendUserId = input.userId;
        assert.deepEqual(input.to, ['sender@example.test']);
      },
    });
    assert.equal(personalSendUserId, 'email-user');
    assert.equal(sentPersonalReview.status, 'sent');
    assert.equal(sentPersonalReview.canSend, false);

    const teamReview = await getMobileEmailReview({
      userId: 'email-user',
      workspace: teamWorkspace,
      draftId: 'team-email-review',
    });
    assert.equal(teamReview.version, 7);
    assert.equal(teamReview.subject, 'Re: Business request');
    const teamCase = await getMobileEmailCase({
      userId: 'email-user',
      workspace: teamWorkspace,
      caseId: 'team-email-case',
    });
    assert.equal(teamCase.requesterAddress, 'business@example.test');
    assert.equal(teamCase.priority, 'urgent');
    assert.equal((await getMobileEmailReview({
      userId: 'read-only-reviewer',
      workspace: readOnlyTeamWorkspace,
      draftId: 'team-email-review',
    })).id, 'team-email-review');
    let unauthorizedSendAttempted = false;
    await assert.rejects(
      () => sendMobileEmailReview({
        userId: 'read-only-reviewer',
        workspace: readOnlyTeamWorkspace,
        draftId: 'team-email-review',
        expectedVersion: 7,
      }, {
        sendMessage: async () => {
          unauthorizedSendAttempted = true;
        },
      }),
      /workspace|permission|access/iu,
    );
    assert.equal(unauthorizedSendAttempted, false);
    await assert.rejects(
      () => getMobileEmailReview({
        userId: 'other-reviewer',
        workspace: teamWorkspace,
        draftId: 'team-email-review',
      }),
      /workspace|permission|access/iu,
    );
    let workspaceSendAccountId: string | null = null;
    const sentTeamReview = await sendMobileEmailReview({
      userId: 'email-user',
      workspace: teamWorkspace,
      draftId: 'team-email-review',
      expectedVersion: 7,
    }, {
      sendMessage: async (input) => {
        workspaceSendAccountId = input.accountId;
        assert.deepEqual(input.to, ['business@example.test']);
      },
    });
    assert.equal(workspaceSendAccountId, 'team-email-account');
    assert.equal(sentTeamReview.status, 'sent');
    assert.equal(sentTeamReview.canSend, false);

    const [reviewRoute, sendRoute, caseRoute] = await Promise.all([
      fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/email/reviews/[draftId]/route.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/email/reviews/[draftId]/send/route.ts'), 'utf8'),
      fs.readFile(path.join(process.cwd(), 'app/api/mobile/v1/email/cases/[caseId]/route.ts'), 'utf8'),
    ]);
    assert.match(reviewRoute, /permissions: 'canRead'/u);
    assert.match(caseRoute, /permissions: 'canRead'/u);
    assert.match(sendRoute, /permissions: 'canWrite'/u);
    assert.match(sendRoute, /typeof body\.expectedVersion === 'number'/u);
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
