import assert from 'node:assert/strict';
import Module from 'node:module';
import { eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { createPiTestDatabase } from './helpers/pi-test-database';

type Loader = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const modules = Module as typeof Module & { _load: Loader };
const originalLoad = modules._load;
let database: Awaited<ReturnType<typeof createPiTestDatabase>>;
let session: { user: { id: string; email: string; role: string } } | null = null;
let includedWorkspaces: WorkspaceContext[] = [];
const workspace = (id: string, personal = false, canWrite = true): WorkspaceContext => ({
  workspaceId: id, workspaceType: personal ? 'personal' : 'team', displayName: id,
  rootPath: `/unused/${id}`, legacy: false, ownerUserId: personal ? 'owner' : null,
  permissions: { canRead: true, canWrite, canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: false },
});
const personal = workspace('personal', true);
const shared = workspace('shared');
const second = workspace('second');
const readOnly = workspace('shared', false, false);
const contexts = [personal, shared, second];
let gates: string[] = [];

modules._load = (request, parent, isMain) => {
  if (database && (request === '@/app/lib/db' || /\/app\/lib\/db(?:\/index)?(?:\.ts)?$/u.test(request))) return database;
  if (request === '@/app/lib/auth') return { auth: { api: { getSession: async () => session } } };
  if (request === '@/app/lib/utils/rate-limit') return { rateLimit: () => ({ ok: true }) };
  if (request === '@/app/lib/api/route-helpers') return { jsonServerError: (_context: string, _error: unknown, message: string) => NextResponse.json({ success: false, error: message }, { status: 500 }) };
  if (request === '@/app/lib/mobile/inbox-scope') return { loadMobileInboxScope: async () => ({ includedWorkspaces }) };
  if (request === '@/app/lib/workspaces/request') return {
    requireRequestWorkspace: async (request: NextRequest, options: { permissions: string }) => {
      gates.push(options.permissions);
      if (!session) return { response: NextResponse.json({ success: false }, { status: 401 }) };
      const id = request.headers.get('X-Canvas-Workspace-Id') || 'personal';
      const resolved = contexts.find((context) => context.workspaceId === id);
      const current = session.user.id === 'reader' && resolved?.workspaceId === 'shared' ? readOnly : resolved;
      if (!current) return { response: NextResponse.json({ success: false }, { status: 404 }) };
      if (options.permissions === 'canWrite' && !current.permissions.canWrite) return { response: NextResponse.json({ success: false }, { status: 403 }) };
      return { session, workspace: current, response: null };
    },
  };
  if (request.endsWith('/pi/session-workspace-context')) return {
    resolveAgentSessionWorkspaceForUser: async ({ workspaceId, userId, permissions }: { workspaceId: string; userId: string; permissions: string[] }) => {
      assert.ok(['shared', 'second'].includes(workspaceId));
      if (userId === 'reader' && permissions.includes('canWrite')) throw new Error('Permission denied');
      return userId === 'reader' ? readOnly : contexts.find((context) => context.workspaceId === workspaceId);
    },
  };
  if (request.endsWith('/audit/audit-service')) return { recordAuditEvent: async () => {} };
  return originalLoad(request, parent, isMain);
};

async function main() {
  database = await createPiTestDatabase();
  try {
    const { db } = database;
    const { user, emailAccounts, emailDrafts, emailInboxCases, workspaceEmailMailboxes } = await import('../app/lib/db/schema');
    const email = await import('../app/lib/mobile/email');
    const { mobileEmailErrorResponse } = await import('../app/lib/mobile/email-route');
    const queueRoute = await import('../app/api/mobile/v1/email/reviews/route');
    const detailRoute = await import('../app/api/mobile/v1/email/reviews/[draftId]/route');
    const rejectRoute = await import('../app/api/mobile/v1/email/reviews/[draftId]/reject/route');
    const sendRoute = await import('../app/api/mobile/v1/email/reviews/[draftId]/send/route');
    const now = new Date('2026-10-01T10:00:00Z');
    await db.insert(user).values(['owner', 'reader', 'other'].map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true, createdAt: now, updatedAt: now })));
    await db.insert(emailAccounts).values(['account', 'account-second'].map((id) => ({ id, userId: 'owner', provider: 'smtp_imap', authType: 'smtp_imap', emailAddress: id === 'account' ? 'owner@example.test' : 'second@example.test', policyJson: JSON.stringify({ readFrom: [], sendTo: ['@example.test'] }), secretRef: 'never-return-this-secret', createdAt: now, updatedAt: now })));
    await db.insert(workspaceEmailMailboxes).values(['shared', 'second'].map((id) => ({ id: `mailbox-${id}`, workspaceId: id, emailAccountId: id === 'second' ? 'account-second' : 'account', createdByUserId: 'owner', lastEditedByUserId: 'owner', createdAt: now, updatedAt: now })));
    await db.insert(emailInboxCases).values({ id: 'same-case', workspaceId: 'shared', mailboxId: 'mailbox-shared', providerThreadId: 'thread', subject: 'Same case', createdAt: now, updatedAt: now });
    const attachments = [{ source: 'upload' as const, uploadId: 'private-snapshot-token', disposition: 'attachment', name: 'Report.pdf', mimeType: 'application/pdf', size: 1234 }];
    const html = '<p><strong>Grüße 日本語</strong></p><ul><li>First</li></ul><table><tbody><tr><td>Data</td></tr></tbody></table><p><a href="https://example.test/report">Report</a></p>';
    const fixture = async (id: string, context: WorkspaceContext = shared, patch: Partial<typeof emailDrafts.$inferInsert> = {}) => {
      await db.insert(emailDrafts).values({
        id, userId: 'owner', accountId: context.workspaceId === 'second' ? 'account-second' : 'account', workspaceId: context.workspaceType === 'personal' ? null : context.workspaceId,
        mailboxId: context.workspaceType === 'personal' ? null : `mailbox-${context.workspaceId}`,
        origin: 'agent', outboxStatus: 'awaiting_review', version: 1, subject: `Subject ${id}`, body: html, isHtml: true,
        attachmentsJson: JSON.stringify(attachments), toJson: '["allowed@example.test"]', ccJson: '[]', bccJson: '["blind@example.test"]',
        createdAt: now, updatedAt: now, ...patch,
      });
    };
    await fixture('personal-draft', personal);
    await fixture('case-draft-one', shared, { inboxCaseId: 'same-case' });
    await fixture('case-draft-two', shared, { inboxCaseId: 'same-case' });
    await fixture('excluded-draft', second);
    await fixture('sent-draft', shared, { outboxStatus: 'sent' });
    await fixture('uncertain-draft', shared, { outboxStatus: 'send_uncertain', outboxErrorCode: 'SEND_UNCERTAIN', outboxErrorMessage: 'private provider debug' });
    await fixture('failed-draft', shared, { outboxStatus: 'send_failed', outboxErrorCode: 'SEND_FAILED', outboxErrorMessage: 'smtp://user:secret@provider.test' });
    await fixture('other-personal-draft', personal, { userId: 'other' });

    const queueInput = { userId: 'owner', workspaces: [personal, shared, { ...personal, workspaceId: 'personal-second' }, shared], scope: 'selected' as const };
    const first = await email.listMobileEmailReviews({ ...queueInput, limit: 2 });
    assert.equal(first.pagination.total, 5);
    assert.equal(first.pagination.problemCount, 2);
    assert.ok(first.pagination.nextCursor);
    const secondPage = await email.listMobileEmailReviews({ ...queueInput, limit: 2, cursor: first.pagination.nextCursor });
    const thirdPage = await email.listMobileEmailReviews({ ...queueInput, limit: 2, cursor: secondPage.pagination.nextCursor });
    const full = [...first.data, ...secondPage.data, ...thirdPage.data];
    assert.equal(new Set(full.map((item) => item.id)).size, 5, 'Stable tie ordering must not duplicate or omit a draft');
    assert.equal(full.filter((item) => item.scope === 'personal').length, 1, 'Personal drafts are listed once');
    assert.equal(full.some((item) => item.id === 'other-personal-draft' || item.id === 'excluded-draft' || item.id === 'sent-draft'), false, 'Other users, excluded sources and terminal drafts are absent');
    assert.ok(full.some((item) => item.id === 'case-draft-one') && full.some((item) => item.id === 'case-draft-two'), 'Two drafts from one case remain separate');
    assert.equal(thirdPage.pagination.nextCursor, null);
    for (const changed of [{ filter: 'problems' }, { scope: 'current' as const }, { userId: 'reader' }, { workspaces: [shared] }]) {
      await assert.rejects(email.listMobileEmailReviews({ ...queueInput, ...changed, cursor: first.pagination.nextCursor }), (error: unknown) => (error as { code: string }).code === 'INVALID_EMAIL_REVIEW_CURSOR');
    }
    for (const invalid of [{ cursor: 'not-a-cursor' }, { limit: 0 }, { limit: 101 }, { filter: 'sent' }]) {
      await assert.rejects(email.listMobileEmailReviews({ ...queueInput, ...invalid }));
    }
    const problems = await email.listMobileEmailReviews({ ...queueInput, filter: 'problems' });
    assert.equal(problems.data.length, 2);
    assert.equal(JSON.stringify(problems).includes('smtp://'), false, 'Provider credentials are never serialized');
    const unreadable = { ...second, permissions: { ...second.permissions, canRead: false } };
    assert.equal((await email.listMobileEmailReviews({ userId: 'owner', workspaces: [unreadable], scope: 'selected' })).data.length, 0);
    await assert.rejects(email.getMobileEmailReview({ userId: 'owner', workspace: unreadable, draftId: 'excluded-draft' }), (error: unknown) => (error as { status: number }).status === 403);

    for (const context of [personal, shared]) {
      for (const original of [
        { body: 'Plain text\nGrüße <not markup> & Japanese 日本語', isHtml: false },
        { body: '<div style="color: blue"><h2>Rich original</h2><p>Keep  spacing &amp; links</p><table class="legacy"><tr><td>Cell</td></tr></table></div>', isHtml: true },
      ]) {
        const id = `preserve-${context.workspaceId}-${original.isHtml}`;
        await fixture(id, context, original);
        const input = { userId: 'owner', workspace: context, draftId: id };
        const untouched = await email.updateMobileEmailReview({ ...input, expectedVersion: 1, changes: { subject: 'Metadata only', to: ['new@example.test'] } });
        assert.equal(untouched.body, original.body, 'Omitted body must preserve even legacy or noncanonical content byte for byte');
        assert.equal(untouched.isHtml, original.isHtml, 'Metadata-only updates preserve the original content type');
        const edited = await email.updateMobileEmailReview({ ...input, expectedVersion: 2, changes: { body: '<p><strong>Explicit HTML edit</strong></p><script>bad()</script>' } });
        assert.equal(edited.isHtml, true, 'Explicit content edits store sanitized HTML, including a legacy plaintext draft');
        assert.equal(edited.body, '<p><strong>Explicit HTML edit</strong></p>');
        assert.deepEqual(JSON.parse((await db.query.emailDrafts.findFirst({ where: eq(emailDrafts.id, id) }))!.attachmentsJson), attachments);
      }
      const id = `editable-${context.workspaceId}`;
      await fixture(id, context);
      const input = { userId: 'owner', workspace: context, draftId: id };
      const original = await email.getMobileEmailReview(input);
      assert.equal(original.senderAddress, 'owner@example.test');
      assert.equal(original.workspaceId, context.workspaceId);
      assert.deepEqual(original.attachments, [{ id: `${id}:0`, name: 'Report.pdf', mimeType: 'application/pdf', size: 1234 }]);
      assert.equal(JSON.stringify(original).includes('private-snapshot-token'), false);
      await assert.rejects(email.getMobileEmailReview({ ...input, workspace: context.workspaceType === 'personal' ? shared : personal }));
      const saved = await email.updateMobileEmailReview({ ...input, expectedVersion: 1, changes: { subject: 'Reviewed' } });
      assert.equal(saved.version, 2);
      assert.equal(saved.body, html, 'Subject-only saves preserve formatted content');
      assert.deepEqual(saved.bcc, original.bcc);
      assert.deepEqual(saved.attachments, original.attachments);
      assert.equal(saved.senderAddress, 'owner@example.test', 'Mutation responses retain sender context');
      await assert.rejects(email.updateMobileEmailReview({ ...input, expectedVersion: 1, changes: { subject: 'Stale' } }), (error: unknown) => (error as { code: string }).code === 'EMAIL_REVIEW_VERSION_CONFLICT');
      await assert.rejects(email.rejectMobileEmailReview({ ...input, expectedVersion: 1 }), (error: unknown) => (error as { code: string }).code === 'EMAIL_REVIEW_VERSION_CONFLICT');
      await assert.rejects(email.updateMobileEmailReview({ ...input, expectedVersion: 2, changes: { attachments: [] } }));
      await assert.rejects(email.updateMobileEmailReview({ ...input, expectedVersion: 2, changes: { to: ['allowed@example.test\r\nBcc: bad@outside.test'] } }));
      const sanitized = await email.updateMobileEmailReview({ ...input, expectedVersion: 2, changes: { body: `${html}<script>alert(1)</script><p onclick="evil()">Safe</p>`, cc: ['Copy <COPY@example.test>'] } });
      assert.equal(sanitized.body.includes('<script'), false);
      assert.equal(sanitized.body.includes('onclick'), false);
      assert.match(sanitized.body, /<table>/u);
      assert.deepEqual(sanitized.cc, ['copy@example.test']);
      assert.deepEqual(JSON.parse((await db.query.emailDrafts.findFirst({ where: eq(emailDrafts.id, id) }))!.attachmentsJson), attachments);
      const rejected = await email.rejectMobileEmailReview({ ...input, expectedVersion: sanitized.version });
      assert.equal(rejected.status, 'discarded');
      assert.equal(rejected.canSend, false);
      await assert.rejects(email.sendMobileEmailReview({ ...input, expectedVersion: rejected.version }));
    }

    const readerInput = { userId: 'reader', workspace: readOnly, draftId: 'case-draft-one' };
    const readonlyReview = await email.getMobileEmailReview(readerInput);
    assert.equal(readonlyReview.canSend || readonlyReview.canEdit || readonlyReview.canReject, false);
    for (const mutation of [email.updateMobileEmailReview({ ...readerInput, expectedVersion: 1, changes: { subject: 'Unauthorized' } }), email.rejectMobileEmailReview({ ...readerInput, expectedVersion: 1 }), email.sendMobileEmailReview({ ...readerInput, expectedVersion: 1 })]) {
      await assert.rejects(mutation, (error: unknown) => (error as { status: number }).status === 403);
    }
    await fixture('other-editor', shared, { editingByUserId: 'other' });
    const locked = await email.getMobileEmailReview({ userId: 'owner', workspace: shared, draftId: 'other-editor' });
    assert.equal(locked.editingByOther, true);
    assert.equal(locked.canEdit || locked.canReject || locked.canSend, false);
    for (const status of ['sending', 'sent', 'discarded', 'send_uncertain']) {
      const id = `locked-${status}`;
      await fixture(id, shared, { outboxStatus: status });
      const input = { userId: 'owner', workspace: shared, draftId: id, expectedVersion: 1 };
      const current = await email.getMobileEmailReview(input);
      assert.equal(current.canEdit || current.canReject || current.canSend, false);
      await assert.rejects(email.updateMobileEmailReview({ ...input, changes: { subject: 'No' } }), (error: unknown) => (error as { code: string }).code === 'EMAIL_REVIEW_NOT_EDITABLE');
      await assert.rejects(email.rejectMobileEmailReview(input), (error: unknown) => (error as { code: string }).code === 'EMAIL_REVIEW_NOT_REJECTABLE');
      await assert.rejects(email.sendMobileEmailReview(input), (error: unknown) => (error as { code: string }).code === 'EMAIL_REVIEW_NOT_SENDABLE');
    }

    let dispatches = 0;
    for (const context of [personal, shared]) {
      const id = `send-${context.workspaceId}`;
      await fixture(id, context);
      const input = { userId: 'owner', workspace: context, draftId: id, expectedVersion: 1 };
      const sent = await email.sendMobileEmailReview(input, { sendMessage: async () => { dispatches++; } });
      assert.equal(sent.status, 'sent');
      await assert.rejects(email.sendMobileEmailReview({ ...input, expectedVersion: sent.version }, { sendMessage: async () => { dispatches++; } }));
      const uncertainId = `timeout-${context.workspaceId}`;
      await fixture(uncertainId, context);
      try {
        await email.sendMobileEmailReview({ ...input, draftId: uncertainId }, { sendMessage: async () => { dispatches++; throw Object.assign(new Error('SMTP SECRET DEBUG'), { code: 'ETIMEDOUT' }); } });
        assert.fail('Timeout must produce an uncertain state');
      } catch (error) {
        assert.equal((error as { code: string }).code, 'SEND_UNCERTAIN');
        const response = mobileEmailErrorResponse(error, 'test');
        assert.equal(response.status, 409);
        const payload = await response.json();
        assert.equal(payload.data.status, 'send_uncertain');
        assert.equal(payload.data.canSend || payload.data.canEdit || payload.data.canReject, false);
        assert.equal(JSON.stringify(payload).includes('SECRET'), false);
        await assert.rejects(email.sendMobileEmailReview({ ...input, draftId: uncertainId, expectedVersion: payload.data.version }, { sendMessage: async () => { dispatches++; } }));
        await assert.rejects(email.updateMobileEmailReview({ ...input, draftId: uncertainId, expectedVersion: payload.data.version, changes: { subject: 'No' } }));
        await assert.rejects(email.rejectMobileEmailReview({ ...input, draftId: uncertainId, expectedVersion: payload.data.version }));
      }
      const blockedId = `policy-${context.workspaceId}`;
      await fixture(blockedId, context, { toJson: '["blocked@outside.test"]' });
      await assert.rejects(email.sendMobileEmailReview({ ...input, draftId: blockedId }, { sendMessage: async () => { dispatches++; } }), (error: unknown) => {
        assert.equal((error as { code: string }).code, 'SEND_POLICY_BLOCKED');
        assert.equal((error as { data: { status: string } }).data.status, 'send_failed');
        assert.equal(mobileEmailErrorResponse(error, 'test').status, 422);
        return true;
      });
    }
    assert.equal(dispatches, 4, 'Each normal/uncertain email is dispatched once; blocked or terminal drafts never dispatch');

    const request = (path: string, method = 'GET', body?: unknown, workspaceId = 'shared') => new NextRequest(`http://localhost/api/mobile/v1/email/reviews${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Canvas-Workspace-Id': workspaceId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal((await queueRoute.GET(request(''))).status, 401);
    session = { user: { id: 'owner', email: 'owner@example.test', role: 'member' } };
    includedWorkspaces = [personal];
    const selected = await queueRoute.GET(request('?scope=selected'));
    assert.equal(selected.status, 200);
    assert.equal(selected.headers.get('cache-control'), 'no-store, max-age=0');
    assert.equal((await selected.json()).data.every((draft: { scope: string }) => draft.scope === 'personal'), true);
    const current = await queueRoute.GET(request('?scope=current'));
    assert.equal((await current.json()).data.every((draft: { workspaceId: string }) => draft.workspaceId === 'shared'), true);
    assert.equal((await queueRoute.GET(request('?scope=unauthorized'))).status, 400);
    const context = { params: Promise.resolve({ draftId: 'case-draft-one' }) };
    for (const invalidBody of [null, [], 'invalid', {}]) {
      assert.equal((await detailRoute.PATCH(request('/case-draft-one', 'PATCH', invalidBody), context)).status, 400);
      assert.equal((await rejectRoute.POST(request('/case-draft-one/reject', 'POST', invalidBody), context)).status, 400);
      assert.equal((await sendRoute.POST(request('/case-draft-one/send', 'POST', invalidBody), context)).status, 400);
    }
    gates = [];
    assert.equal((await detailRoute.GET(request('/case-draft-one'), context)).status, 200);
    assert.equal((await detailRoute.PATCH(request('/case-draft-one', 'PATCH', { expectedVersion: 1, subject: 'Route edit' }), context)).status, 200);
    assert.equal((await sendRoute.POST(request('/case-draft-one/send', 'POST', { expectedVersion: 1 }), context)).status, 409);
    assert.equal((await rejectRoute.POST(request('/case-draft-one/reject', 'POST', { expectedVersion: 2 }), context)).status, 200);
    assert.deepEqual(gates, ['canRead', 'canWrite', 'canWrite', 'canWrite']);
    session = { user: { id: 'reader', email: 'reader@example.test', role: 'member' } };
    assert.equal((await detailRoute.PATCH(request('/case-draft-one', 'PATCH', { expectedVersion: 3, subject: 'No' }), context)).status, 403);
    assert.equal((await rejectRoute.POST(request('/case-draft-one/reject', 'POST', { expectedVersion: 3 }), context)).status, 403);
    assert.equal((await sendRoute.POST(request('/case-draft-one/send', 'POST', { expectedVersion: 3 }), context)).status, 403);
    console.log('mobile-email-review-test: ok (isolated PostgreSQL, authorized scope, pagination, partial HTML edits, attachments, permissions, CAS, rejection, policy and nonduplicate delivery)');
  } finally {
    modules._load = originalLoad;
    await database.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
