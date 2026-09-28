import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import type { NotificationItem, NotificationSummary } from '../app/components/notifications/notification-summary';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test/en/notebook' });
for (const key of [
  'self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'SVGElement', 'getComputedStyle',
] as const) {
  const fallback = key === 'PointerEvent' ? dom.window.MouseEvent : undefined;
  Object.defineProperty(globalThis, key, { value: dom.window[key] ?? fallback, configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(dom.window.HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false });
Object.defineProperty(dom.window.HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: () => {} });
Object.defineProperty(dom.window.HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: () => {} });

function summary(item: NotificationItem): NotificationSummary {
  return {
    unreadCount: 1,
    counts: { unread: 1, chat: 0, todos: 0, todoUnread: 0, todoAttention: 0, emailAttention: 0,
      studio: 0, automation: 0, memoryApprovals: 0 },
    items: [item],
    sections: { notifications: [item], todos: [], todoUnread: [], todoAttention: [], emailAttention: [] },
  };
}

async function main() {
  const { cleanup, fireEvent, render, within } = await import('@testing-library/react');
  const { HomeAttentionPanel } = await import('../app/components/home/HomeAttentionPanel');
  const router = { push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {},
    hmrRefresh() {}, bfcacheId: 'test-router' };
  const mutations: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input), window.location.origin).pathname, '/api/notifications/summary');
    assert.equal(init?.method, 'PATCH');
    mutations.push(JSON.parse(String(init.body)));
    return Response.json({ success: true });
  };
  const base: NotificationItem = {
    id: 'file-change:operation-one', type: 'file.change_review_required', title: 'File change', detail: 'Review',
    occurredAt: '2026-09-26T10:00:00.000Z', unread: true, priority: 'normal',
    workspaceId: 'workspace-one', workspaceName: 'Review Workspace', fileChangeReason: 'needs_review',
    target: { kind: 'file_change', workspaceId: 'workspace-one', lineageId: 'lineage-one', operationId: 'operation-one' },
  };
  const branch: NotificationItem = {
    ...base,
    id: `file-change-branch:${'a'.repeat(64)}`,
    target: { kind: 'file_change', workspaceId: 'workspace-one', lineageId: 'lineage-one',
      operationId: 'operation-one', branch: {
      rootProposalId: 'proposal-one', itemId: `file-change-branch:${'a'.repeat(64)}`, revision: 'b'.repeat(64),
    } },
  };
  const wrap = (item: NotificationItem) => <AppRouterContext.Provider value={router}>
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <HomeAttentionPanel summary={summary(item)} isLoading={false} />
    </NextIntlClientProvider>
  </AppRouterContext.Provider>;
  const clickRead = async (item: NotificationItem) => {
    const screen = render(wrap(item));
    fireEvent.click(screen.getByRole('button', { name: 'Show notifications' }));
    const dialog = screen.getByRole('dialog', { name: 'Notifications' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark read' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    cleanup();
  };

  await clickRead(branch);
  assert.deepEqual(mutations[0], { action: 'mark_item_read', itemId: branch.id, workspaceId: 'workspace-one',
    expectedRevision: 'b'.repeat(64) }, 'Home passes the observed branch revision to the server');
  await clickRead(base);
  assert.deepEqual(mutations[1], { action: 'mark_item_read', itemId: base.id, workspaceId: 'workspace-one' },
    'legacy file-change notifications keep their prior mutation shape');
  console.log('Home file-change branch acknowledgement: revision-bound branch and legacy read controls passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
