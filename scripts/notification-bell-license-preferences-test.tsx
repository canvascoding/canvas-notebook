import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../messages/en.json';
import germanMessages from '../messages/de.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://canvas.test/en/notebook',
});
for (const key of [
  'self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLButtonElement',
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
  let summaryReads = 0;
  let preferenceRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/notifications/summary') {
      summaryReads++;
      return Response.json({ success: true, data: {
        unreadCount: 0,
        counts: { unread: 0, chat: 0, todos: 0, todoUnread: 0, todoAttention: 0,
          emailAttention: 0, studio: 0, automation: 0, memoryApprovals: 0 },
        items: [], sections: { notifications: [], todos: [], todoUnread: [],
          todoAttention: [], emailAttention: [] },
      } });
    }
    if (url.pathname === '/api/user-preferences') preferenceRequests++;
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  };
  const router = { push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {},
    hmrRefresh() {}, bfcacheId: 'test-router' };
  const screen = render(
    <AppRouterContext.Provider value={router}>
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <NotificationBell />
      </NextIntlClientProvider>
    </AppRouterContext.Provider>,
  );
  const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  try {
    await settle();
    fireEvent.click(screen.getByTestId('notification-bell'));
    await settle();
    assert.equal(screen.queryByRole('switch'), null);
    assert.equal(preferenceRequests, 0);
    const link = screen.getByRole('link', { name: 'License settings' });
    assert.match(link.getAttribute('href') || '', /settings\?tab=license#license-notifications$/);
    assert(summaryReads >= 2, 'opening still refreshes the summary');
    const readsBeforeUpdate = summaryReads;
    window.dispatchEvent(new CustomEvent('notification_summary_updated'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    assert(summaryReads > readsBeforeUpdate, 'a preference change still refreshes the bell');
    fireEvent.click(link);
    await settle();
    assert.equal(screen.queryByRole('link', { name: 'License settings' }), null, 'navigation closes the popup');
  } finally {
    screen.unmount();
  }
  const germanScreen = render(
    <AppRouterContext.Provider value={router}>
      <NextIntlClientProvider locale="de" timeZone="UTC" messages={germanMessages}>
        <NotificationBell />
      </NextIntlClientProvider>
    </AppRouterContext.Provider>,
  );
  try {
    await settle();
    fireEvent.click(germanScreen.getByTestId('notification-bell'));
    await settle();
    assert.equal(germanScreen.queryByRole('switch'), null);
    assert(germanScreen.getByRole('link', { name: 'Lizenz-Einstellungen' }));
    assert.equal(preferenceRequests, 0);
  } finally {
    germanScreen.unmount();
  }
  console.info('Notification bell discloses a localized settings link, preserves summary refresh, and avoids preference controls and requests');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
