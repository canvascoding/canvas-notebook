import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import type { NotificationSummary } from '../app/components/notifications/notification-summary';
import type { OpenChatSessionEventDetail } from '../app/lib/chat/open-chat-session-event';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://canvas.test/en/notebook?workspaceId=workspace-one',
});
for (const key of [
  'self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'SVGElement', 'getComputedStyle',
] as const) {
  const fallback = key === 'PointerEvent' ? dom.window.MouseEvent : undefined;
  Object.defineProperty(globalThis, key, { value: dom.window[key] ?? fallback, configurable: true });
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: class { observe() {} unobserve() {} disconnect() {} },
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(dom.window.HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false });
Object.defineProperty(dom.window.HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: () => {} });
Object.defineProperty(dom.window.HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: () => {} });

async function main() {
  const { fireEvent, render } = await import('@testing-library/react');
  const { NotificationBell } = await import('../app/components/notifications/NotificationBell');
  const { useFileVersionCenterStore, closeVersionCenter } = await import('../app/store/file-version-center-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');

  const fileChange = {
    id: 'file-change:operation-one', type: 'file.change_review_required' as const,
    title: 'Server fallback', detail: null, occurredAt: '2026-09-15T10:00:00.000Z', unread: true,
    priority: 'normal' as const, workspaceId: 'workspace-one', workspaceName: 'Review Workspace',
    fileChangeReason: 'needs_review' as const,
    target: { kind: 'file_change' as const, workspaceId: 'workspace-one', lineageId: 'lineage-one', operationId: 'operation-one' },
  };
  const chat = {
    id: 'chat:session-one', type: 'chat.response' as const, title: 'Legacy chat reply', detail: null,
    occurredAt: '2026-09-15T09:00:00.000Z', unread: true, priority: 'normal' as const,
    workspaceId: 'workspace-one', workspaceName: 'Review Workspace',
    target: { kind: 'chat' as const, sessionId: 'session-one' },
  };
  const summary = {
    unreadCount: 2,
    counts: { unread: 2, chat: 1, todos: 0, todoUnread: 0, todoAttention: 0, emailAttention: 0, studio: 0, automation: 0, memoryApprovals: 0 },
    items: [fileChange, chat],
    sections: { notifications: [fileChange, chat], todos: [], todoUnread: [], todoAttention: [], emailAttention: [] },
  } satisfies NotificationSummary;
  const mutations: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname !== '/api/notifications/summary') throw new Error(`Unexpected fetch: ${url.pathname}`);
    if (init?.method === 'PATCH') {
      mutations.push(JSON.parse(String(init.body)));
      return Response.json({ success: true });
    }
    return Response.json({ success: true, data: summary });
  };
  useWorkspaceStore.setState({
    activeWorkspaceId: 'workspace-one',
    initialized: true,
    workspaces: [{
      id: 'workspace-one', type: 'personal', name: 'Review Workspace', description: '',
      organizationId: 'org', customerId: null, projectId: null, ownerUserId: 'owner',
      color: '#475569', status: 'active', isDefault: true, legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true },
    }],
  });
  const router = { push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {}, hmrRefresh() {} };
  const screen = render(
    <AppRouterContext.Provider value={router}>
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <NotificationBell />
      </NextIntlClientProvider>
    </AppRouterContext.Provider>,
  );
  const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  await settle();

  fireEvent.click(screen.getByTestId('notification-bell'));
  await settle();
  const fileButton = screen.getByRole('button', { name: /File change needs review/u });
  assert.ok(fileButton.querySelector('.lucide-file-clock'), 'file changes use the existing file-history icon');
  fireEvent.click(fileButton);
  await settle();
  assert.equal(mutations.length, 0, 'the Bell never marks a file change read before the global center resolves it');
  assert.deepEqual(useFileVersionCenterStore.getState().request, {
    contractVersion: 1,
    target: { kind: 'lineage', workspaceId: 'workspace-one', lineageId: 'lineage-one' },
    selectedEntry: { kind: 'agent_operation', id: 'operation-one' },
    initialView: 'reviews',
    source: 'notification',
  });

  closeVersionCenter();
  window.addEventListener('canvas:open-chat-session', (event) => {
    (event as CustomEvent<OpenChatSessionEventDetail>).detail.handled = true;
  }, { once: true });
  fireEvent.click(screen.getByTestId('notification-bell'));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: /Legacy chat reply/u }));
  await settle();
  assert.deepEqual(mutations, [{ action: 'mark_item_read', itemId: 'chat:session-one', workspaceId: 'workspace-one' }],
    'legacy Bell navigation still marks eligible notifications before opening them');
  assert.equal(new URL(window.location.href).searchParams.get('session'), 'session-one');
  screen.unmount();
  console.log('notification-bell-file-review-test: ok');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
