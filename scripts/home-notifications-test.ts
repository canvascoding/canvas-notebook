import assert from 'node:assert/strict';
import { homeNotificationItems, notificationHref, updateNotification } from '../app/components/notifications/notification-actions';
import type { NotificationItem, NotificationSummary } from '../app/components/notifications/notification-summary';

async function main() {
  const item = (id: string, target: NotificationItem['target'], priority: NotificationItem['priority'] = 'normal'): NotificationItem => ({
    id, target, priority, type: 'chat.response', title: id, detail: null, occurredAt: '2026-09-05T10:00:00Z', unread: true, workspaceId: 'workspace-a', workspaceName: 'Shared',
  });
  const chat = item('chat', { kind: 'chat', sessionId: 'session & 1' });
  const todo = item('todo', { kind: 'todo', todoId: 'todo1' }, 'high');
  const email = item('email', { kind: 'email', scope: 'workspace', draftId: 'draft1' });
  const studio = item('studio', { kind: 'studio', generationId: 'gen1' });
  const automation = item('automation', { kind: 'automation', runId: 'run1' }, 'high');
  const summary = {
    items: [chat, todo, email, studio, automation],
    sections: { notifications: [chat, studio, automation], todoAttention: [todo], emailAttention: [email] },
  } as NotificationSummary;
  const entries = homeNotificationItems(summary);
  assert.equal(entries.length, 5, 'the same event appearing in multiple summary sections must be shown once');
  assert.equal(entries[0].priority, 'high');
  assert.deepEqual(new Set(entries.map((entry) => entry.target.kind)), new Set(['chat', 'todo', 'email', 'studio', 'automation']));
  assert.deepEqual(homeNotificationItems(null), []);
  const chatLink = new URL(notificationHref(chat), 'http://localhost');
  assert.equal(chatLink.searchParams.get('session'), 'session & 1');
  assert.equal(chatLink.searchParams.get('workspaceId'), 'workspace-a');
  assert.equal(new URL(notificationHref(todo), 'http://localhost').searchParams.get('todo'), 'todo1');
  assert.ok(notificationHref(email).includes('workspaceId=workspace-a'));
  const originalFetch = globalThis.fetch;
  const events: string[] = [];
  Object.defineProperty(globalThis, 'window', { value: { dispatchEvent: (event: Event) => events.push(event.type) }, configurable: true });
  let payload: unknown;
  globalThis.fetch = async (_, options) => { payload = JSON.parse(String(options?.body)); return Response.json({ success: true }); };
  try {
    await updateNotification({ action: 'mark_item_read', itemId: 'todo', workspaceId: 'workspace-a' });
    assert.deepEqual(payload, { action: 'mark_item_read', itemId: 'todo', workspaceId: 'workspace-a' });
    assert.deepEqual(events, ['notification_summary_updated']);
    globalThis.fetch = async () => Response.json({ success: false }, { status: 403 });
    await assert.rejects(updateNotification({ action: 'dismiss_item', itemId: 'studio', workspaceId: 'workspace-a' }));
    assert.equal(events.length, 1, 'failed mutations must not advertise a successful update');
  } finally { globalThis.fetch = originalFetch; }
  console.log('Home notifications: deduplication, priority, event coverage, scoped links and mutation failures passed');
}
void main();
