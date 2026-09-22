import assert from 'node:assert/strict';
import { emailReviewTargetFromNotification, homeNotificationItems, notificationHref } from '../app/components/notifications/notification-actions';
import type { NotificationItem, NotificationSummary } from '../app/components/notifications/notification-summary';

const email: NotificationItem = {
  id: 'email:one', type: 'email.attention', title: 'Review proposal', detail: null,
  occurredAt: '2026-09-22T10:00:00Z', unread: false, priority: 'normal',
  workspaceId: 'workspace-a', workspaceName: 'Team',
  target: { kind: 'email', scope: 'workspace', draftId: 'draft & one' },
};
assert.deepEqual(emailReviewTargetFromNotification(email), { scope: 'workspace', workspaceId: 'workspace-a', draftId: 'draft & one' });
assert.deepEqual(emailReviewTargetFromNotification({ ...email, target: { kind: 'email', scope: 'personal', draftId: 'draft1' } }), { scope: 'personal', workspaceId: undefined, draftId: 'draft1' });
assert.equal(emailReviewTargetFromNotification({ ...email, target: { kind: 'email', scope: 'personal', caseId: 'case1' } }), null);
assert.equal(emailReviewTargetFromNotification({ ...email, target: { kind: 'todo', todoId: 'todo1' } }), null);
const summary = { items: [email], sections: { notifications: [], todoAttention: [], emailAttention: [email] } } as unknown as NotificationSummary;
assert.deepEqual(homeNotificationItems(summary), [email], 'Read normal-priority proposals remain actionable on home and deduplicate');
const fallback = new URL(notificationHref(email), 'https://canvas.test');
assert.equal(fallback.searchParams.get('outboxDraft'), 'draft & one');
assert.equal(fallback.searchParams.get('workspaceId'), 'workspace-a');
console.log('Email review notifications: targets, retained home attention and fallback links passed');
