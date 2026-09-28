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
  const preferences = {
    teamLicenseNotificationsEnabled: true,
    teamLicenseEmailNotificationsEnabled: false,
  };
  const patches: Array<Record<string, unknown>> = [];
  let failNextInAppUpdate = false;
  let summaryReads = 0;
  globalThis.fetch = async (input, init) => {
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
    if (url.pathname === '/api/user-preferences') {
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (failNextInAppUpdate && 'teamLicenseNotificationsEnabled' in patch) {
          failNextInAppUpdate = false;
          return Response.json({ success: false }, { status: 500 });
        }
        patches.push(patch);
        Object.assign(preferences, patch);
      }
      return Response.json({ success: true, data: preferences });
    }
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
    const inApp = screen.getByRole('switch', { name: 'In-app license alerts' });
    const email = screen.getByRole('switch', { name: 'License emails' });
    assert.equal(inApp.getAttribute('data-state'), 'checked');
    assert.equal(email.getAttribute('data-state'), 'unchecked');
    fireEvent.click(inApp);
    await settle();
    assert.deepEqual(patches[0], { teamLicenseNotificationsEnabled: false });
    assert.equal(inApp.getAttribute('data-state'), 'unchecked');
    assert.equal(email.getAttribute('data-state'), 'unchecked');
    assert(summaryReads >= 2, 'changing in-app preference refreshes the notification summary');
    fireEvent.click(email);
    await settle();
    assert.deepEqual(patches[1], { teamLicenseEmailNotificationsEnabled: true });
    assert.equal(inApp.getAttribute('data-state'), 'unchecked');
    assert.equal(email.getAttribute('data-state'), 'checked');
    failNextInAppUpdate = true;
    fireEvent.click(inApp);
    await settle();
    assert.equal(inApp.getAttribute('data-state'), 'unchecked');
    assert.equal(email.getAttribute('data-state'), 'checked');
    assert.equal(patches.length, 2);
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
    assert(germanScreen.getByRole('switch', { name: 'Lizenzhinweise in der App' }));
    assert(germanScreen.getByRole('switch', { name: 'Lizenz-E-Mails' }));
  } finally {
    germanScreen.unmount();
  }
  console.info('member notification center exposes independent in-app and email license preferences');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
