import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import germanMessages from '../messages/de.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://canvas.test/en/settings?tab=license',
  pretendToBeVisual: true,
});
for (const key of [
  'self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLFormElement',
  'HTMLInputElement', 'Element', 'Node', 'MutationObserver', 'CustomEvent', 'Event',
  'MouseEvent', 'KeyboardEvent', 'getComputedStyle',
] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  value: dom.window.requestAnimationFrame.bind(dom.window), configurable: true,
});
Object.defineProperty(globalThis, 'cancelAnimationFrame', {
  value: dom.window.cancelAnimationFrame.bind(dom.window), configurable: true,
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true, configurable: true, writable: true,
});
const scrollCalls: Array<{ target: HTMLElement; options: boolean | ScrollIntoViewOptions | undefined }> = [];
Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
  value: function (this: HTMLElement, options?: boolean | ScrollIntoViewOptions) {
    scrollCalls.push({ target: this, options });
  },
  configurable: true,
});

type PreferenceKey = 'teamLicenseNotificationsEnabled' | 'teamLicenseEmailNotificationsEnabled';
type Preferences = Partial<Record<PreferenceKey, boolean>>;
type Reply = () => Response | Promise<Response>;
type Request = { method: string; init: RequestInit; body: unknown };

const labels = {
  en: { title: 'License notifications', inApp: 'In-app Team license alerts', email: 'Team license emails', retry: 'Retry' },
  de: { title: 'Lizenz-Benachrichtigungen', inApp: 'Team-Lizenzhinweise in der App', email: 'Team-Lizenz-E-Mails', retry: 'Erneut versuchen' },
} as const;

async function main(): Promise<void> {
  const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  const { LicenseNotificationSettings } = await import('../app/components/license/LicenseNotificationSettings');
  const originalFetch = globalThis.fetch;
  const originalTimeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  const timeouts: Array<{ milliseconds: number; signal: AbortSignal; controller: AbortController }> = [];
  const requests: Request[] = [];
  const getReplies: Reply[] = [];
  const patchReplies: Reply[] = [];
  let stored: Preferences = {};
  let summaryEvents = 0;
  const onSummaryUpdated = () => { summaryEvents++; };
  window.addEventListener('notification_summary_updated', onSummaryUpdated);
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    value: (milliseconds: number) => {
      const controller = new AbortController();
      const signal = controller.signal;
      timeouts.push({ milliseconds, signal, controller });
      return signal;
    },
  });
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(String(input), '/api/user-preferences');
    assert.equal(init.credentials, 'include', 'preferences use the signed-in session');
    const method = init.method ?? 'GET';
    const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, init, body });
    assert.equal(timeouts.at(-1)?.milliseconds, 15_000);
    assert.equal(init.signal, timeouts.at(-1)?.signal, 'the request uses its bounded timeout signal');
    if (method === 'GET') {
      assert.equal(init.cache, 'no-store');
      return getReplies.length ? getReplies.shift()!() : Response.json({ success: true, data: { ...stored } });
    }
    assert.equal(method, 'PATCH');
    assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
    assert(body && typeof body === 'object' && !Array.isArray(body));
    const fields = Object.keys(body);
    assert.equal(fields.length, 1, 'a save targets only the changed preference');
    assert(['teamLicenseNotificationsEnabled', 'teamLicenseEmailNotificationsEnabled'].includes(fields[0]));
    const key = fields[0] as PreferenceKey;
    const value = (body as Preferences)[key];
    assert.equal(typeof value, 'boolean');
    const response = patchReplies.length ? await patchReplies.shift()!() : Response.json({ success: true, data: { ...stored, [key]: value } });
    const payload = await response.clone().json().catch(() => null);
    if (response.ok && payload?.success === true) stored = { ...stored, [key]: value };
    return response;
  };

  const reset = (preferences: Preferences = {}, hash = '', locale: 'en' | 'de' = 'en') => {
    cleanup();
    window.history.replaceState(null, '', `/${locale}/settings?tab=license${hash}`);
    stored = { ...preferences };
    requests.length = 0;
    getReplies.length = 0;
    patchReplies.length = 0;
    timeouts.length = 0;
    summaryEvents = 0;
    scrollCalls.length = 0;
  };
  const view = (locale: 'en' | 'de' = 'en') => render(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={locale === 'de' ? germanMessages : messages}>
      <LicenseNotificationSettings />
    </NextIntlClientProvider>,
  );
  const checkState = (control: HTMLElement, checked: boolean, disabled = false) => {
    assert.equal(control.getAttribute('aria-checked'), String(checked));
    assert.equal(control.hasAttribute('disabled'), disabled);
  };
  const open = async (screen: ReturnType<typeof render>, locale: 'en' | 'de' = 'en') => {
    const header = screen.getByRole('button', { name: new RegExp(labels[locale].title) });
    fireEvent.click(header);
    await waitFor(() => assert(screen.getByRole('switch', { name: labels[locale].inApp })));
    return header;
  };

  try {
    reset();
    const screen = view();
    const header = screen.getByRole('button', { name: 'Expand: License notifications' });
    assert.equal(screen.container.querySelector('#license-notifications')?.id, 'license-notifications');
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.equal(screen.queryByRole('switch'), null);
    await act(async () => { await Promise.resolve(); });
    assert.equal(requests.length, 0, 'closed notification settings do not fetch preferences');
    header.focus();
    assert.equal(document.activeElement, header, 'the disclosure header is keyboard focusable');
    // JSDOM does not synthesize a native button click from Enter; detail 0 models keyboard activation.
    fireEvent.click(header, { detail: 0 });
    await waitFor(() => assert(screen.getByRole('switch', { name: labels.en.inApp })));
    assert.equal(header.getAttribute('aria-expanded'), 'true');
    assert.equal(header.getAttribute('aria-label'), 'Collapse: License notifications');
    assert(header.getAttribute('aria-controls'));
    assert(document.getElementById(header.getAttribute('aria-controls')!));
    assert.equal(requests.filter((request) => request.method === 'GET').length, 1);
    const inApp = screen.getByRole('switch', { name: labels.en.inApp });
    const email = screen.getByRole('switch', { name: labels.en.email });
    checkState(inApp, true);
    checkState(email, true);
    assert.equal(screen.getAllByRole('switch').length, 2, 'both preferences are directly available in one disclosure');

    let releaseSave!: (response: Response) => void;
    patchReplies.push(() => new Promise<Response>((resolve) => { releaseSave = resolve; }));
    fireEvent.click(inApp);
    checkState(inApp, true, true);
    checkState(email, true, true);
    assert.equal(summaryEvents, 0, 'pending saves do not refresh the notification summary');
    assert.deepEqual(stored, {}, 'pending saves do not change persisted preferences');
    const pendingRequestCount = requests.length;
    fireEvent.click(email);
    assert.equal(requests.length, pendingRequestCount, 'another preference cannot be saved concurrently');
    await act(async () => releaseSave(Response.json({ success: true, data: {
      teamLicenseNotificationsEnabled: false, teamLicenseEmailNotificationsEnabled: false,
    } })));
    await waitFor(() => checkState(inApp, false));
    checkState(email, true);
    assert.equal(summaryEvents, 1);
    assert.deepEqual(requests.at(-1)?.body, { teamLicenseNotificationsEnabled: false });

    for (const next of [false, true]) {
      fireEvent.click(email);
      await waitFor(() => checkState(email, next));
      checkState(inApp, false);
      assert.deepEqual(requests.at(-1)?.body, { teamLicenseEmailNotificationsEnabled: next });
      assert.equal(summaryEvents, 1, 'email preferences do not emit an in-app summary event');
    }
    for (const next of [true, false]) {
      fireEvent.click(inApp);
      await waitFor(() => checkState(inApp, next));
      assert.deepEqual(requests.at(-1)?.body, { teamLicenseNotificationsEnabled: next });
    }
    assert.equal(summaryEvents, 3);
    assert.deepEqual(stored, { teamLicenseNotificationsEnabled: false, teamLicenseEmailNotificationsEnabled: true });
    const loadsBeforeClosing = requests.filter((request) => request.method === 'GET').length;
    fireEvent.click(header);
    assert.equal(header.getAttribute('aria-expanded'), 'false');
    assert.equal(screen.queryByRole('switch'), null, 'a previously opened disclosure hides its switches when closed');
    fireEvent.click(header);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    checkState(screen.getByRole('switch', { name: labels.en.inApp }), false);
    checkState(screen.getByRole('switch', { name: labels.en.email }), true);
    assert.equal(requests.filter((request) => request.method === 'GET').length, loadsBeforeClosing, 'reopening uses the saved preferences without another GET');
    screen.unmount();
    const reloaded = view();
    assert.equal(reloaded.getByRole('button', { name: 'Expand: License notifications' }).getAttribute('aria-expanded'), 'false');
    await open(reloaded);
    checkState(reloaded.getByRole('switch', { name: labels.en.inApp }), false);
    checkState(reloaded.getByRole('switch', { name: labels.en.email }), true);

    const saveFailures: Array<[string, Reply]> = [
      ['HTTP error', () => Response.json({ success: false, error: 'Unavailable' }, { status: 503 })],
      ['unsuccessful payload', () => Response.json({ success: false })],
      ['missing success', () => Response.json({ data: {} })],
      ['non-boolean success', () => Response.json({ success: 'true', data: {} })],
      ['invalid JSON', () => new Response('not-json')],
      ['network failure', () => { throw new Error('Network unavailable'); }],
    ];
    for (const [failure, reply] of saveFailures) {
      for (const [key, label] of [
        ['teamLicenseNotificationsEnabled', labels.en.inApp],
        ['teamLicenseEmailNotificationsEnabled', labels.en.email],
      ] as const) {
        reset({ teamLicenseNotificationsEnabled: true, teamLicenseEmailNotificationsEnabled: true });
        const failed = view();
        await open(failed);
        patchReplies.push(reply);
        const control = failed.getByRole('switch', { name: label });
        fireEvent.click(control);
        await waitFor(() => assert(failed.getByRole('alert'), failure));
        checkState(control, true);
        assert.equal(stored[key], true, `${failure} preserves the persisted value`);
        assert.equal(summaryEvents, 0, `${failure} does not dispatch a summary event`);
        fireEvent.click(control);
        await waitFor(() => checkState(control, false));
        assert.equal(failed.queryByRole('alert'), null, 'a later successful toggle clears the save failure');
        assert.equal(stored[key], false);
        assert.equal(summaryEvents, key === 'teamLicenseNotificationsEnabled' ? 1 : 0);
      }
    }

    const loadFailures: Array<[string, Reply]> = [
      ['HTTP error', () => Response.json({ success: true, data: {} }, { status: 503 })],
      ['unsuccessful payload', () => Response.json({ success: false, data: {} })],
      ['missing success', () => Response.json({ data: {} })],
      ['non-boolean success', () => Response.json({ success: 'true', data: {} })],
      ['missing data', () => Response.json({ success: true })],
      ['null data', () => Response.json({ success: true, data: null })],
      ['array data', () => Response.json({ success: true, data: [] })],
      ['string data', () => Response.json({ success: true, data: 'invalid' })],
      ['non-boolean in-app preference', () => Response.json({ success: true, data: { teamLicenseNotificationsEnabled: 'false' } })],
      ['non-boolean email preference', () => Response.json({ success: true, data: { teamLicenseEmailNotificationsEnabled: null } })],
      ['invalid JSON', () => new Response('not-json')],
      ['network failure', () => { throw new Error('Network unavailable'); }],
    ];
    for (const [failure, reply] of loadFailures) {
      reset();
      getReplies.push(reply);
      const failed = view();
      fireEvent.click(failed.getByRole('button', { name: 'Expand: License notifications' }));
      await waitFor(() => assert(failed.getByRole('alert'), failure));
      assert.equal(failed.queryByRole('switch'), null, 'unloaded preferences cannot be changed');
      assert.equal(summaryEvents, 0);
      fireEvent.click(failed.getByRole('button', { name: labels.en.retry }));
      await waitFor(() => assert(failed.getByRole('switch', { name: labels.en.inApp })));
      checkState(failed.getByRole('switch', { name: labels.en.inApp }), true);
      checkState(failed.getByRole('switch', { name: labels.en.email }), true);
      assert.equal(failed.queryByRole('alert'), null);
      assert.equal(requests.filter((request) => request.method === 'GET').length, 2, 'retry issues a fresh bounded request');
    }

    const rejectOnTimeout: Reply = () => new Promise<Response>((_resolve, reject) => {
      const signal = timeouts.at(-1)!.signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    reset();
    getReplies.push(rejectOnTimeout);
    const loadTimeout = view();
    fireEvent.click(loadTimeout.getByRole('button', { name: 'Expand: License notifications' }));
    await waitFor(() => assert.equal(requests.length, 1));
    await act(async () => timeouts.at(-1)!.controller.abort(new DOMException('Request timed out', 'TimeoutError')));
    await waitFor(() => assert(loadTimeout.getByRole('alert')));
    assert.equal(loadTimeout.queryByRole('switch'), null);
    fireEvent.click(loadTimeout.getByRole('button', { name: labels.en.retry }));
    await waitFor(() => checkState(loadTimeout.getByRole('switch', { name: labels.en.inApp }), true));

    reset({ teamLicenseNotificationsEnabled: true, teamLicenseEmailNotificationsEnabled: false });
    const saveTimeout = view();
    await open(saveTimeout);
    patchReplies.push(rejectOnTimeout);
    const timedOutInApp = saveTimeout.getByRole('switch', { name: labels.en.inApp });
    const timedOutEmail = saveTimeout.getByRole('switch', { name: labels.en.email });
    fireEvent.click(timedOutInApp);
    checkState(timedOutInApp, true, true);
    checkState(timedOutEmail, false, true);
    await act(async () => timeouts.at(-1)!.controller.abort(new DOMException('Request timed out', 'TimeoutError')));
    await waitFor(() => assert(saveTimeout.getByRole('alert')));
    checkState(timedOutInApp, true);
    checkState(timedOutEmail, false);
    assert.equal(stored.teamLicenseNotificationsEnabled, true);
    assert.equal(summaryEvents, 0, 'a timed-out PATCH preserves state and emits no event');
    fireEvent.click(timedOutInApp);
    await waitFor(() => checkState(timedOutInApp, false));
    assert.equal(summaryEvents, 1);

    reset({ teamLicenseNotificationsEnabled: false }, '#license-notifications');
    const linked = view();
    await waitFor(() => checkState(linked.getByRole('switch', { name: labels.en.inApp }), false));
    assert.equal(linked.getByRole('button', { name: 'Collapse: License notifications' }).getAttribute('aria-expanded'), 'true');
    assert.equal(requests.filter((request) => request.method === 'GET').length, 1);
    await waitFor(() => assert.equal(scrollCalls.at(-1)?.target.id, 'license-notifications'));
    assert.deepEqual(scrollCalls.at(-1)?.options, { block: 'start' });

    reset();
    const liveLinked = view();
    assert.equal(requests.length, 0);
    await act(async () => {
      window.history.replaceState(null, '', '/en/settings?tab=license#license-notifications');
      window.dispatchEvent(new Event('hashchange'));
    });
    await waitFor(() => assert(liveLinked.getByRole('switch', { name: labels.en.email })));
    assert.equal(liveLinked.getByRole('button', { name: 'Collapse: License notifications' }).getAttribute('aria-expanded'), 'true');
    await waitFor(() => assert.equal(scrollCalls.at(-1)?.target.id, 'license-notifications'));

    reset();
    const clientLinked = view();
    const clientLinkedHeader = clientLinked.getByRole('button', { name: 'Expand: License notifications' });
    await act(async () => {
      window.history.pushState(null, '', '/en/settings?tab=license#license-notifications');
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(clientLinkedHeader.getAttribute('aria-expanded'), 'false', 'pushState does not emit hashchange or implicitly open a mounted disclosure');
    assert.equal(clientLinked.queryByRole('switch'), null);
    assert.equal(requests.length, 0);
    assert.equal(scrollCalls.length, 0);
    const originalWindowFrame = window.requestAnimationFrame;
    const scrollFrames: FrameRequestCallback[] = [];
    window.requestAnimationFrame = (callback) => {
      scrollFrames.push(callback);
      return 10_000 + scrollFrames.length;
    };
    try {
      await act(async () => window.dispatchEvent(new Event('license_notification_settings_requested')));
      assert.equal(clientLinkedHeader.getAttribute('aria-expanded'), 'true', 'the explicit client-navigation event opens mounted settings');
      assert.equal(scrollFrames.length, 1, 'revealing the section schedules the scroll for the next frame');
      assert.equal(scrollCalls.length, 0, 'the scroll does not run before the next animation frame');
      await act(async () => scrollFrames[0](performance.now()));
      assert.equal(scrollCalls.length, 1);
      assert.equal(scrollCalls[0].target, clientLinked.container.querySelector('#license-notifications'));
      assert.deepEqual(scrollCalls[0].options, { block: 'start' });
      await waitFor(() => checkState(clientLinked.getByRole('switch', { name: labels.en.inApp }), true));
      assert.equal(requests.filter((request) => request.method === 'GET').length, 1, 'revealing client-navigated settings lazily loads preferences');
    } finally {
      window.requestAnimationFrame = originalWindowFrame;
    }

    reset({}, '', 'de');
    getReplies.push(() => Response.json({ success: false }, { status: 500 }));
    const german = view('de');
    const germanHeader = german.getByRole('button', { name: 'Aufklappen: Lizenz-Benachrichtigungen' });
    assert.equal(germanHeader.getAttribute('aria-expanded'), 'false');
    fireEvent.click(germanHeader);
    await waitFor(() => assert(german.getByRole('alert')));
    fireEvent.click(german.getByRole('button', { name: labels.de.retry }));
    await waitFor(() => assert(german.getByRole('switch', { name: labels.de.inApp })));
    checkState(german.getByRole('switch', { name: labels.de.inApp }), true);
    checkState(german.getByRole('switch', { name: labels.de.email }), true);
    assert.equal(germanHeader.getAttribute('aria-label'), 'Einklappen: Lizenz-Benachrichtigungen');

    console.info('license-notification-settings-test: PASS (lazy accessible disclosure, bounded strict GET, targeted durable saves, persistence, error recovery, summary events, hash/client navigation and frame scroll, EN/DE)');
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    if (originalTimeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', originalTimeoutDescriptor);
    window.removeEventListener('notification_summary_updated', onSummaryUpdated);
    dom.window.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
