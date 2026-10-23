import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import type { NotificationItem, NotificationSummary } from '../app/components/notifications/notification-summary';
import type { OpenChatSessionEventDetail } from '../app/lib/chat/open-chat-session-event';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test/en/notebook' });
for (const key of [
  'self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'SVGElement', 'getComputedStyle',
] as const) {
  Object.defineProperty(globalThis, key, { configurable: true,
    value: dom.window[key] ?? (key === 'PointerEvent' ? dom.window.MouseEvent : undefined) });
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true, value: class { observe() {} unobserve() {} disconnect() {} },
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
for (const method of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture']) {
  Object.defineProperty(dom.window.HTMLElement.prototype, method, { configurable: true,
    value: method === 'hasPointerCapture' ? () => false : () => {} });
}

async function main() {
  const { render, fireEvent, cleanup } = await import('@testing-library/react');
  const { NotificationBell } = await import('../app/components/notifications/NotificationBell');
  const { authClient } = await import('../app/lib/auth-client');
  const originalFetch = globalThis.fetch;
  const now = new Date();
  const authSession = {
    user: { id: 'read-state-user', name: 'Read state', email: 'read-state@example.test',
      emailVerified: true, createdAt: now, updatedAt: now },
    session: { id: 'read-state-session', userId: 'read-state-user', token: 'synthetic-session',
      createdAt: now, updatedAt: now, expiresAt: new Date('2099-01-01T00:00:00.000Z') },
  } as NonNullable<ReturnType<typeof authClient.$store.atoms.session.get>['data']>;
  const item = (id: string, type: NotificationItem['type'], target: NotificationItem['target'], unread: boolean): NotificationItem => ({
    id, type, target, unread, title: id, detail: null, occurredAt: '2026-10-16T10:00:00.000Z',
    priority: 'normal', workspaceId: 'workspace-one', workspaceName: 'Canvas Studios',
  });
  let notifications = [
    item('studio:already-read', 'studio.completed', { kind: 'studio', generationId: 'already-read' }, false),
    item('automation:already-read', 'automation.failed', { kind: 'automation', runId: 'already-read' }, false),
    item('studio:new', 'studio.completed', { kind: 'studio', generationId: 'new' }, true),
    item('chat:new', 'chat.response', { kind: 'chat', sessionId: 'new' }, true),
    item('file-path-preparation:11111111-2222-3333-4444-555555555555','file.operation_attention',
      {kind:'file_path_operation',workspaceId:'workspace-one',preparationRequestId:'11111111-2222-3333-4444-555555555555',operationKind:'rename',status:'pending'},false),
    item('file-path-preparation:66666666-7777-8888-9999-aaaaaaaaaaaa','file.operation_attention',
      {kind:'file_path_operation',workspaceId:'workspace-one',preparationRequestId:'66666666-7777-8888-9999-aaaaaaaaaaaa',operationKind:'rename',status:'pending'},true),
  ];
  let todos = [item('todo:open', 'todo.attention', { kind: 'todo', todoId: 'open' }, false)];
  let emails = [item('email:pending', 'email.attention', { kind: 'email', scope: 'personal', caseId: 'pending' }, false)];
  const mutations: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/auth/get-session') return Response.json(authSession);
    assert.equal(url.pathname, '/api/notifications/summary');
    if (init?.method === 'PATCH') {
      const payload = JSON.parse(String(init.body));
      mutations.push(payload);
      notifications = notifications.map((entry) => (
        payload.action === 'mark_all_read' || payload.itemId === entry.id ? { ...entry, unread: false } : entry
      ));
      return Response.json({ success: true });
    }
    const unreadCount = notifications.filter((entry) => entry.unread).length;
    const summary: NotificationSummary = {
      unreadCount,
      counts: { unread: unreadCount, chat: 0, studio: 0, automation: 0, memoryApprovals: 0,
        todos: todos.length, todoAttention: todos.length, emailAttention: emails.length },
      items: [...notifications, ...todos, ...emails],
      sections: { notifications, todos, todoAttention: todos, emailAttention: emails },
    };
    return Response.json({ success: true, data: summary });
  };
  authClient.$store.atoms.session.set({ ...authClient.$store.atoms.session.get(), data: authSession,
    error: null, isPending: false, isRefetching: false });
  const router = { push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {},
    hmrRefresh() {}, bfcacheId: 'test-router' };
  const mount = () => render(<AppRouterContext.Provider value={router}>
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <NotificationBell />
    </NextIntlClientProvider>
  </AppRouterContext.Provider>);
  const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
  const interceptChat = (event: Event) => {
    (event as CustomEvent<OpenChatSessionEventDetail>).detail.handled = true;
  };
  window.addEventListener('canvas:open-chat-session', interceptChat);
  let screen = mount();
  const open = async () => {
    fireEvent.click(screen.getByTestId('notification-bell'));
    await settle();
  };
  try {
    await settle();
    await open();
    assert.ok(!screen.queryByRole('button', { name: /studio:already-read/u }), 'read Studio results are hidden on load');
    assert.equal(screen.queryByRole('button', { name: /automation:already-read/u }), null, 'read automation events are hidden on load');

    assert.equal(document.querySelector('[data-notification-id="file-path-preparation:11111111-2222-3333-4444-555555555555"]'),null,'a read pending preparation stays hidden in the unread-only Bell');
    assert.ok(document.querySelector('[data-notification-id="file-path-preparation:66666666-7777-8888-9999-aaaaaaaaaaaa"]'),'an unread saved preparation remains discoverable in the Bell');
    assert.ok(screen.getByRole('button', { name: /studio:new/u }));
    fireEvent.click(screen.getByRole('button', { name: /chat:new/u }));
    await settle();
    assert.deepEqual(mutations.at(-1), { action: 'mark_item_read', itemId: 'chat:new', workspaceId: 'workspace-one' });
    await open();
    assert.equal(screen.queryByRole('button', { name: /chat:new/u }), null, 'opening an unread event removes it after the read update');
    assert.ok(screen.getByRole('button', { name: /studio:new/u }));

    fireEvent.click(screen.getByRole('button', { name: messages.notifications.markAllRead }));
    await settle();
    assert.deepEqual(mutations.at(-1), { action: 'mark_all_read' });
    assert.equal(screen.queryByRole('button', { name: /studio:new/u }), null, 'mark all read clears the notification list');
    assert.equal(document.getElementById('notification-center-notifications'), null, 'the empty section disappears');
    assert.equal(document.querySelector('[data-notification-id^="file-path-preparation:"]'),null,'mark-all-read hides pending preparation rows without resolving the saved action');
    assert.ok(screen.getByRole('button', { name: /todo:open/u }), 'open Todos remain visible');
    assert.ok(screen.getByRole('button', { name: /email:pending/u }), 'pending email attention remains visible');
    assert.equal((screen.getByRole('button', { name: messages.notifications.markAllRead }) as HTMLButtonElement).disabled, true);

    cleanup();
    screen = mount();
    await settle();
    await open();
    assert.equal(document.querySelector('[data-notification-id^="studio:"]'), null, 'read events stay hidden after remounting');
    assert.equal(document.querySelector('[data-notification-id^="file-path-preparation:"]'),null,'read preparations stay hidden after Bell remount; Home retention is checked separately');
    notifications.push(item('studio:latest', 'studio.completed', { kind: 'studio', generationId: 'latest' }, true));
    await act(async () => { window.dispatchEvent(new CustomEvent('notification_summary_updated')); });
    await settle();
    assert.ok(screen.getByRole('button', { name: /studio:latest/u }), 'new unread results still appear after a refresh');

    todos = [];
    emails = [];
    fireEvent.click(screen.getByRole('button', { name: messages.notifications.markAllRead }));
    await settle();
    assert.ok(screen.getByText(messages.notifications.empty.title), 'only read events produce the empty state');
    assert.equal(document.querySelector('[data-notification-id]'), null);
    console.log('notification-bell-read-state-test: initial read state, individual/all-read updates, reload, fresh events and attention sections passed');
  } finally {
    cleanup();
    window.removeEventListener('canvas:open-chat-session', interceptChat);
    globalThis.fetch = originalFetch;
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
