import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { NextIntlClientProvider } from 'next-intl';
import { toast } from 'sonner';
import messages from '../messages/en.json';
import type { NotificationItem, NotificationSummary } from '../app/components/notifications/notification-summary';
import { createDocumentReviewUiFixture } from './helpers/document-review-ui-fixture';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test/en' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'SVGElement', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key] ?? (key === 'PointerEvent' ? dom.window.MouseEvent : undefined), configurable: true });
}
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
for (const name of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture']) {
  Object.defineProperty(dom.window.HTMLElement.prototype, name, { configurable: true, value: () => false });
}

async function main() {
  const { render, fireEvent, within, cleanup } = await import('@testing-library/react');
  const { HomeAttentionPanel } = await import('../app/components/home/HomeAttentionPanel');
  const { HomeNotificationItem } = await import('../app/components/home/HomeNotificationItem');
  const { NotificationBell } = await import('../app/components/notifications/NotificationBell');
  const { isNotificationDismissible } = await import('../app/components/notifications/notification-actions');
  const { authClient } = await import('../app/lib/auth-client');
  const ReviewAvailability = await createDocumentReviewUiFixture();
  const item: NotificationItem = { id: 'file-path-operation:batch-abcdefghijklmnop', type: 'file.operation_attention',
    title: 'fallback', detail: 'before.md', occurredAt: new Date(100).toISOString(), notificationRevision: '100',
    unread: false, priority: 'high', workspaceId: 'workspace-a', workspaceName: 'A',
    target: { kind: 'file_path_operation', workspaceId: 'workspace-a', batchId: 'batch-abcdefghijklmnop', operationKind: 'rename', status: 'blocked' } };
  let summary: NotificationSummary = { unreadCount: 0,
    counts: { unread: 0, chat: 0, todos: 0, todoAttention: 0, emailAttention: 0, studio: 0, automation: 0, memoryApprovals: 0 },
    items: [item], sections: { notifications: [item], todos: [], todoAttention: [], emailAttention: [] } };
  let fail = true;
  let releasePatch: (() => void) | undefined;
  let hold = false;
  const mutations: unknown[] = [];
  const errors: string[] = [];
  const originalToastError = toast.error;
  toast.error = (message) => { errors.push(String(message)); return 'test-toast'; };
  const now = new Date();
  const authSession = { user: { id: 'dismiss-user', name: 'Dismiss', email: 'dismiss@example.test', emailVerified: true, createdAt: now, updatedAt: now },
    session: { id: 'dismiss-session', userId: 'dismiss-user', token: 'synthetic', createdAt: now, updatedAt: now, expiresAt: new Date('2099-01-01') } } as
    NonNullable<ReturnType<typeof authClient.$store.atoms.session.get>['data']>;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/auth/get-session') return Response.json(authSession);
    if (url.pathname !== '/api/notifications/summary') throw new Error(`Unexpected fetch: ${url.pathname}`);
    if (init?.method !== 'PATCH') return Response.json({ success: true, data: summary });
    mutations.push(JSON.parse(String(init.body)));
    if (hold) await new Promise<void>((resolve) => { releasePatch = resolve; });
    if (fail) return Response.json({ success: false, error: 'offline' }, { status: 500 });
    summary = { ...summary, items: [], sections: { ...summary.sections, notifications: [] } };
    return Response.json({ success: true });
  };
  authClient.$store.atoms.session.set({ ...authClient.$store.atoms.session.get(), data: authSession, error: null, isPending: false, isRefetching: false });
  const navigations: string[] = [];
  const router = { push: (url: string) => navigations.push(url), replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {}, hmrRefresh() {}, bfcacheId: 'test' };
  const wrap = (children: React.ReactNode) => <AppRouterContext.Provider value={router}>
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}><ReviewAvailability enabled={false}>{children}</ReviewAvailability></NextIntlClientProvider>
  </AppRouterContext.Provider>;
  const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  const expectedMutation = { action: 'dismiss_item', itemId: item.id, workspaceId: item.workspaceId, expectedRevision: '100' };
  try {
    assert.equal(isNotificationDismissible(item), true, 'read errors remain dismissible');
    assert.equal(isNotificationDismissible({ ...item, notificationRevision: undefined }), false, 'old clients must refresh before dismissing');
    for (const status of ['queued', 'applying'] as const) {
      assert.equal(isNotificationDismissible({ ...item, target: { ...item.target, status } as NotificationItem['target'] }), false);
    }
    let screen = render(wrap(<HomeAttentionPanel summary={summary} isLoading={false} />));
    const aside = within(screen.getByRole('complementary'));
    const compactDismiss = aside.getByRole('button', { name: messages.notifications.dismiss }) as HTMLButtonElement;
    assert.equal(compactDismiss.closest('a'), null, 'dismiss is separate from the open-details link');
    hold = true;
    fireEvent.click(compactDismiss);
    await act(async () => { await Promise.resolve(); });
    assert.equal(compactDismiss.disabled, true);
    await act(async () => { releasePatch?.(); });
    hold = false;
    await settle();
    assert.deepEqual(mutations.at(-1), expectedMutation);
    assert.ok(aside.getByRole('link', { name: /Rename: blocked/u }), 'a failed dismissal keeps the notification available');
    assert.ok(aside.getByRole('alert'));
    assert.equal(compactDismiss.disabled, false);
    fail = false;
    fireEvent.click(aside.getByRole('button', { name: messages.home.start.retry }));
    await settle();
    assert.deepEqual(mutations.at(-1), expectedMutation);
    assert.equal(aside.queryByRole('alert'), null);
    assert.equal(navigations.length, 0, 'dismiss works without opening details or navigating away');
    cleanup();

    let dismissCalls = 0;
    screen = render(wrap(<ul><HomeNotificationItem item={item} showActions pending={false} onRead={() => {}} onDismiss={() => { dismissCalls += 1; }} /></ul>));
    fireEvent.click(screen.getByRole('button', { name: messages.notifications.dismiss }));
    assert.equal(dismissCalls, 1, 'the expanded list offers the same action');
    cleanup();

    summary = { ...summary, items: [item], sections: { ...summary.sections, notifications: [item] } };
    fail = true;
    screen = render(wrap(<NotificationBell />));
    await settle();
    fireEvent.click(screen.getByTestId('notification-bell'));
    await settle();
    const row = document.querySelector(`[data-notification-id="${item.id}"]`)!.parentElement!;
    const bellDismiss = within(row as HTMLElement).getByRole('button', { name: messages.notifications.dismiss });
    assert.equal(bellDismiss.className.includes('opacity-0'), false, 'touch users can always see the control');
    fireEvent.click(bellDismiss);
    await settle();
    assert.deepEqual(mutations.at(-1), expectedMutation);
    assert.equal(errors.at(-1), messages.notifications.dismissFailed);
    assert.ok(document.querySelector(`[data-notification-id="${item.id}"]`));
    fail = false;
    fireEvent.click(within(document.querySelector(`[data-notification-id="${item.id}"]`)!.parentElement!).getByRole('button', { name: messages.notifications.dismiss }));
    await settle();
    assert.equal(document.querySelector(`[data-notification-id="${item.id}"]`), null);
    console.log('workspace-operation-notification-dismiss-ui-test: ok');
  } finally { toast.error = originalToastError; cleanup(); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
