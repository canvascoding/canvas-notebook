import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { EmailClassificationFeed, EmailClassificationFeedItem } from '../app/lib/email/classification/feed-types';
import type { EmailClassificationMessageDetail } from '../app/lib/email/classification/state-service';
import { DEFAULT_EMAIL_CLASSIFICATION_POLICY } from '../app/lib/email/classification/types';
import { projectEmailClassification } from '../app/lib/email/classification/policy';
import { emailOriginSelectionKey } from '../app/lib/email/classification/mailbox-types';
import type { UseEmailFocusFeedInput } from '../app/apps/email/components/useEmailFocusFeed';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'Element', 'Node', 'MutationObserver', 'Event', 'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

function item(character: string, work = false): EmailClassificationFeedItem {
  const origin = { mailboxRef: `emb:${character.repeat(64)}`, accountSource: 'local' as const, accountId: work ? 'work' : 'personal',
    accountScope: work ? 'workspace' as const : 'personal' as const, accountOwnerId: work ? 'different-owner' : 'actor',
    mailboxId: work ? 'binding' : null, workspaceId: work ? 'workspace' : null, workspaceName: work ? 'Support' : null,
    emailAddress: work ? 'work@example.test' : 'personal@example.test', displayName: null, folder: 'INBOX', canonicalId: 'same-provider-id',
    capabilities: { canRead: true, canWrite: !work, canDelete: !work, canRunAgent: !work, canManage: !work } };
  const classification = projectEmailClassification({ raw: null, policy: DEFAULT_EMAIL_CLASSIFICATION_POLICY });
  return { messageRef: `emm:${character.repeat(64)}`, selectionKey: emailOriginSelectionKey(origin), origin,
    message: { from: 'Customer <customer@example.test>', subject: work ? 'Reply to customer' : 'Important request', snippet: 'Please investigate', date: '2026-10-06T12:00:00Z', isRead: false },
    classification: { ...classification, category: 'support', priority: work ? 'normal' : 'high', spamProbability: null, replyProbability: 0.95,
      needsReply: true, isSpam: false, group: work ? 'reply' : 'important', status: 'ready',
      states: { category: 'ready', priority: 'ready', spam: 'ready', reply: 'ready' }, version: 2 }, personalFocus: { done: false, version: work ? 7 : 0 } };
}
const first = item('a'); const second = item('b', true);
const thirdOrigin = { ...first.origin, canonicalId: 'third-provider-id' };
const third = { ...item('c'), origin: thirdOrigin, selectionKey: emailOriginSelectionKey(thirdOrigin), message: { ...first.message, subject: 'Third message' } };
function feed(items = [first, second], id = '11111111-1111-4111-8111-111111111111'): EmailClassificationFeed {
  return { scope: { kind: 'all' }, requestedMode: 'focus', mode: 'focus', view: 'focus', items,
    nextCursor: btoa(JSON.stringify({ v: 1, id, after: 2 })), snapshot: { id, expiresAt: Date.now() + 600_000 }, hasUpdates: false,
    counts: { total: 4, groups: { important: 1, reply: 1, review: 1, pending: 1, other: 0, spam: 0, done: 0 }, categories: { support: 2 } },
    coverage: [{ mailboxRef: first.origin.mailboxRef, state: 'complete', lastSyncAt: Date.now(), indexed: 2, pending: 0, failed: 0, stale: 0 },
      { mailboxRef: second.origin.mailboxRef, state: 'failed', lastSyncAt: null, indexed: 2, pending: 1, failed: 1, stale: 0 }],
    limits: { initialLookbackDays: 30, maxHistoricalMessages: 5000 } };
}
const detail = (value: EmailClassificationFeedItem): EmailClassificationMessageDetail => ({ ...structuredClone(value), assessment: null });

async function main() {
  const { render, renderHook, fireEvent, cleanup, within } = await import('@testing-library/react');
  const { useEmailFocusFeed } = await import('../app/apps/email/components/useEmailFocusFeed');
  const { EmailFocusHeader } = await import('../app/apps/email/components/EmailFocusHeader');
  const { EmailFocusNavigation } = await import('../app/apps/email/components/EmailFocusNavigation');
  const { EmailClassificationDetails } = await import('../app/apps/email/components/EmailClassificationDetails');
  const originalFetch = globalThis.fetch;
  const originalInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  const originalTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const polls = new Map<number, () => void>(); let intervalId = 0;
  window.setInterval = ((callback: TimerHandler, timeout?: number) => { assert.equal(timeout, 30_000); assert.equal(typeof callback, 'function'); polls.set(++intervalId, callback as () => void); return intervalId; }) as typeof window.setInterval;
  window.clearInterval = ((id: number) => { polls.delete(id); }) as typeof window.clearInterval;
  const calls: Array<{ url: URL; body?: Record<string, unknown>; signal?: AbortSignal | null }> = [];
  let response: (url: URL, init?: RequestInit) => Promise<Response> = async () => Response.json({ success: true, data: feed() });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal });
    return response(url, init);
  };
  const tick = (millis = 5) => act(async () => { await new Promise(resolve => setTimeout(resolve, millis)); });
  const poll = () => act(async () => { for (const callback of polls.values()) callback(); });
  const wrap = (content: React.ReactNode, locale: 'en' | 'de' = 'en') => <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC">{content}</NextIntlClientProvider>;
  try {
    const props: UseEmailFocusFeedInput = { userId: 'actor', enabled: true, scope: { kind: 'all' }, mode: 'focus', view: 'focus', search: '' };
    const hook = renderHook((input: UseEmailFocusFeedInput) => useEmailFocusFeed(input), { initialProps: props });
    const currentHook = (): ReturnType<typeof useEmailFocusFeed> => hook.result.current;
    await tick(); assert.deepEqual(hook.result.current.items.map(value => value.messageRef), [first.messageRef, second.messageRef]);
    response = async () => Response.json({ success: true, data: { ...feed([second, first]), hasUpdates: true } });
    await poll();
    const backgroundCursor = JSON.parse(atob(calls.at(-1)!.url.searchParams.get('cursor')!.replaceAll('-', '+').replaceAll('_', '/')));
    assert.equal(backgroundCursor.id, hook.result.current.feed?.snapshot.id); assert.equal(backgroundCursor.after, 0, 'Rights polling revisits the current snapshot');
    assert.deepEqual(hook.result.current.items.map(value => value.messageRef), [first.messageRef, second.messageRef], 'Background updates never reorder the working list');
    assert.equal(hook.result.current.hasUpdates, true);
    response = async () => Response.json({ success: true, data: { ...feed([second, third]), nextCursor: null } });
    await act(async () => { hook.result.current.loadMore(); });
    assert.deepEqual(hook.result.current.items.map(value => value.messageRef), [first.messageRef, second.messageRef, third.messageRef], 'Paging deduplicates qualified origins');
    const done = { ...first, personalFocus: { done: true, version: 1 }, classification: { ...first.classification!, personallyDone: true, group: 'done' as const } };
    await act(async () => { hook.result.current.updateItem(done); });
    assert.equal(hook.result.current.items[0].personalFocus.done, true); assert.equal(hook.result.current.feed?.counts.groups.important, 1, 'Explicit state updates preserve snapshot positions/counts until refresh');
    response = async () => Response.json({ success: true, data: feed([second, third], '22222222-2222-4222-8222-222222222222') });
    await act(async () => { hook.result.current.reload(); });
    assert.deepEqual(hook.result.current.items.map(value => value.messageRef), [second.messageRef, third.messageRef], 'User refresh intentionally applies the new order');
    response = async () => Response.json({ success: false, code: 'EMAIL_FEED_CURSOR_INVALID', error: 'PRIVATE_MESSAGE' }, { status: 409 });
    await act(async () => { hook.result.current.loadMore(); });
    assert.deepEqual(hook.result.current.items, []); assert.equal(hook.result.current.error?.status, 409);
    response = async () => Response.json({ success: true, data: feed() });
    await act(async () => { hook.result.current.reload(); }); assert.equal(hook.result.current.error, null);
    response = async () => Response.json({ success: false, error: 'PRIVATE_MESSAGE' }, { status: 403 });
    await poll(); assert.deepEqual(hook.result.current.items, []); assert.equal(currentHook().error?.status, 403, 'A revoked rights check clears old mail');
    for (const status of [401, 503]) {
      response = async () => Response.json({ success: true, data: feed() });
      await act(async () => { hook.result.current.reload(); });
      response = async () => Response.json({ success: false, error: 'PRIVATE_MESSAGE' }, { status });
      await poll(); assert.deepEqual(hook.result.current.items, []); assert.equal(currentHook().error?.status, status, 'An unconfirmed actor/source is never retained after a failed check');
    }
    const deadlines = new Map<number, { callback(): void; millis: number }>(); let deadlineId = 10000;
    window.setTimeout = ((callback: TimerHandler, millis?: number, ...args: unknown[]) => {
      if ((millis === 30000 || millis === 60000) && typeof callback === 'function') { deadlines.set(++deadlineId, { callback: callback as () => void, millis }); return deadlineId; }
      return originalTimeout(callback, millis, ...args);
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id: number) => { if (!deadlines.delete(id)) originalClearTimeout(id); }) as typeof window.clearTimeout;
    response = async () => Response.json({ success: true, data: feed() });
    await act(async () => { hook.result.current.reload(); });
    let releaseSlow!: (value: Response) => void;
    response = async () => new Promise(resolve => { releaseSlow = resolve; });
    await poll();
    const slowSignal = calls.at(-1)!.signal;
    await act(async () => { [...deadlines.values()].find(timer => timer.millis === 30000)!.callback(); });
    assert.equal(slowSignal?.aborted, true); assert.deepEqual(hook.result.current.items, [], 'A stalled rights request clears stale mail within the request deadline');
    await act(async () => { releaseSlow(Response.json({ success: true, data: feed() })); });
    assert.deepEqual(hook.result.current.items, [], 'A late response cannot revive data after the authority deadline');
    response = async () => Response.json({ success: true, data: feed() });
    await act(async () => { hook.result.current.reload(); });
    await act(async () => { [...deadlines.values()].find(timer => timer.millis === 60000)!.callback(); });
    assert.deepEqual(hook.result.current.items, [], 'Unrenewed authorization expires independently of manual refresh activity');
    window.setTimeout = originalTimeout; window.clearTimeout = originalClearTimeout;
    hook.unmount();

    const pending: Array<{ resolve(value: Response): void; signal?: AbortSignal | null }> = [];
    response = async (_url, init) => new Promise(resolve => pending.push({ resolve, signal: init?.signal }));
    const race = renderHook((input: UseEmailFocusFeedInput) => useEmailFocusFeed(input), { initialProps: props });
    const currentRace = (): ReturnType<typeof useEmailFocusFeed> => race.result.current;
    await tick(); assert.equal(pending.length, 1);
    race.rerender({ ...props, userId: 'different-session' });
    assert.deepEqual(race.result.current.items, [], 'A session switch hides prior items immediately');
    await tick(); assert.equal(pending[0].signal?.aborted, true); assert.equal(pending.length, 2);
    await act(async () => { pending[1].resolve(Response.json({ success: true, data: feed([second]) })); });
    await act(async () => { pending[0].resolve(Response.json({ success: true, data: feed([first]) })); });
    assert.deepEqual(currentRace().items.map(value => value.messageRef), [second.messageRef], 'Late old-session responses cannot replace current mail');
    await act(async () => { race.result.current.reload(); });
    race.rerender({ ...props, userId: 'different-session', scope: { kind: 'work' } });
    assert.deepEqual(race.result.current.items, [], 'Changing scope hides the previous source immediately');
    await tick(); assert.equal(pending[2].signal?.aborted, true);
    await act(async () => { pending[3].resolve(Response.json({ success: true, data: { ...feed([second]), scope: { kind: 'work' } } })); });
    await act(async () => { pending[2].resolve(Response.json({ success: true, data: feed([first]) })); });
    assert.deepEqual(currentRace().items.map(value => value.messageRef), [second.messageRef], 'Late previous-source responses cannot enter the new scope');
    race.rerender({ ...props, userId: 'different-session', enabled: false }); assert.deepEqual(race.result.current.items, []);
    race.unmount();

    const scopes: unknown[] = []; const modes: unknown[] = []; let compose = 0;
    const headerProps = { scope: { kind: 'all' as const }, mode: 'classic' as const, classificationEnabled: false,
      mailboxes: [first.origin, second.origin], search: '', onScopeChange: (scope: unknown) => scopes.push(scope), onModeChange: (mode: unknown) => modes.push(mode),
      onSearchChange: () => {}, onCompose: () => { compose++; }, onRefresh: () => {} };
    const header = render(wrap(<EmailFocusHeader {...headerProps} />));
    assert.equal(header.queryByRole('button', { name: 'Focus' }), null);
    assert.equal(header.queryByRole('button', { name: 'Classic' }), null);
    assert.equal(header.queryByText(en.emailFocus.classificationDisabled), null);
    fireEvent.change(header.getByLabelText('Mailbox scope'), { target: { value: `mailbox:${second.origin.mailboxRef}` } });
    assert.deepEqual(scopes, [{ kind: 'mailbox', mailboxRef: second.origin.mailboxRef }]);
    fireEvent.click(header.getByRole('button', { name: 'New email' })); assert.equal(compose, 1, 'Aggregate compose delegates to the caller’s sender picker');
    header.rerender(wrap(<EmailFocusHeader {...headerProps} controlsOnly />));
    assert.equal(header.queryByRole('button', { name: 'Focus' }), null);
    assert.equal(header.queryByRole('button', { name: 'New email' }), null); assert.equal(header.queryByRole('searchbox'), null, 'Classic single-mailbox controls do not duplicate legacy search/compose');
    header.rerender(wrap(<EmailFocusHeader {...headerProps} classificationEnabled />));
    fireEvent.click(header.getByRole('button', { name: 'Focus' }));
    fireEvent.click(header.getByRole('button', { name: 'Classic' }));
    assert.deepEqual(modes, ['focus', 'classic'], 'An activated preparation retains both mode choices');
    header.rerender(wrap(<EmailFocusHeader {...headerProps} classificationEnabled mode="focus" />));
    assert.equal(header.getByRole('button', { name: 'Focus' }).getAttribute('aria-pressed'), 'true');
    header.rerender(wrap(<EmailFocusHeader {...headerProps} />));
    assert.equal(header.queryByRole('button', { name: 'Focus' }), null, 'Central deactivation removes the switch after activation');
    cleanup();

    const opened: EmailClassificationFeedItem[] = []; const doneCalls: unknown[] = []; const views: string[] = [];
    const navProps = { feed: feed(), view: 'focus' as const, category: null, onViewChange: (view: string) => views.push(view), onCategoryChange: () => {},
      onOpen: (value: EmailClassificationFeedItem) => opened.push(value), onDone: (value: EmailClassificationFeedItem, done: boolean) => doneCalls.push([value.messageRef, done]),
      selectionKey: null, loading: false, error: null, hasUpdates: false, hasMore: false, onReload: () => {}, onLoadMore: () => {}, aggregate: true };
    const nav = render(wrap(<EmailFocusNavigation {...navProps} />));
    assert.equal(nav.getAllByTestId('email-focus-row').length, 2);
    assert(nav.getByRole('button', { name: /All emails: 4/ })); assert(nav.getByRole('button', { name: /Needs review: 1/ })); assert(nav.getByRole('button', { name: /Not yet prepared: 1/ }));
    assert(nav.getByText('Work · Support · work@example.test')); assert(nav.getByText('Personal · personal@example.test'));
    assert.equal(nav.container.textContent?.includes('95%'), false, 'The navigation has no probability columns');
    fireEvent.click(nav.getAllByTestId('email-focus-row')[1]); assert.equal(opened[0].origin.accountOwnerId, 'different-owner');
    fireEvent.click(nav.getByRole('button', { name: 'Mark as done for me: Reply to customer' })); assert.deepEqual(doneCalls, [[second.messageRef, true]], 'Read-only work mail still permits personal completion');
    fireEvent.click(nav.getByRole('button', { name: /Needs review: 1/ })); assert.deepEqual(views, ['review']);
    nav.rerender(wrap(<EmailFocusNavigation {...navProps} feed={{ ...feed([]), nextCursor: null }} />));
    assert(nav.getByText(en.emailFocus.emptyPreparing)); assert.equal(nav.container.textContent?.includes('all caught up'), false);
    cleanup();

    const excluded = { ...first, classification: projectEmailClassification({ raw: null, unavailableState: 'not_selected' }) };
    const excludedNav = render(wrap(<EmailFocusNavigation {...navProps} feed={feed([excluded])} view="all" />));
    assert(excludedNav.getByText(en.emailFocus.reasons.not_selected));
    assert.equal(excludedNav.getByTestId('email-focus-row').textContent?.includes(en.emailFocus.reasons.pending), false);
    cleanup();
    const excludedReader = render(wrap(<EmailClassificationDetails item={excluded} userId="actor" onItemChange={() => {}} onUnavailable={() => {}} />));
    assert(excludedReader.getByText(en.emailFocus.reasons.not_selected));
    assert.equal(excludedReader.container.textContent?.includes(en.emailFocus.reasons.ordinary), false, 'Missing assessment is not presented as no action needed.');
    cleanup();

    const changed: EmailClassificationMessageDetail[] = []; const unavailable: string[] = [];
    let currentDetail = detail(second); let mutationCount = 0;
    response = async (url, init) => {
      if (url.pathname.endsWith('/focus')) {
        const body = JSON.parse(String(init?.body)); assert.equal(body.expectedVersion, 7); assert.equal(body.done, true); mutationCount++;
        currentDetail = { ...currentDetail, personalFocus: { done: true, version: 8 }, classification: { ...currentDetail.classification!, personallyDone: true, group: 'done' } };
      }
      return Response.json({ success: true, data: currentDetail });
    };
    const beforeReader = calls.length;
    const readerProps = { item: second, userId: 'actor', onItemChange: (value: EmailClassificationMessageDetail) => changed.push(value), onUnavailable: (ref: string) => unavailable.push(ref) };
    const reader = render(wrap(<EmailClassificationDetails {...readerProps} />));
    assert.equal(calls.length, beforeReader, 'A compact reader does not fetch detailed ratings');
    await act(async () => { fireEvent.click(reader.getByTestId('email-classification-done')); });
    assert.equal(mutationCount, 1); assert.equal(changed.at(-1)?.personalFocus.version, 8);
    await act(async () => { fireEvent.click(reader.getByTestId('email-classification-expand')); });
    assert.equal(reader.queryByTestId('email-classification-correct'), null); assert(reader.getByText(en.emailFocus.details.readOnlyHint));
    assert(reader.getAllByText('—').length > 0, 'Unavailable ratings stay unknown instead of zero');
    response = async () => Response.json({ success: false, error: 'PRIVATE_MESSAGE' }, { status: 403 });
    await act(async () => { fireEvent.click(reader.getByTestId('email-classification-done')); });
    assert.deepEqual(unavailable, [second.messageRef]); assert(reader.getByTestId('email-classification-unavailable'));
    assert.equal(reader.container.textContent?.includes('95%'), false); assert.equal(reader.container.textContent?.includes('PRIVATE_MESSAGE'), false);
    cleanup();

    currentDetail = detail(first); let conflict = true;
    response = async (url, init) => {
      if (url.pathname.endsWith('/override')) {
        if (conflict) return Response.json({ success: false, code: 'EMAIL_CLASSIFICATION_VERSION_CONFLICT', error: 'PRIVATE_MESSAGE' }, { status: 409 });
        const body = JSON.parse(String(init?.body)); assert.equal(body.expectedVersion, 5); assert.deepEqual(body.overrides, { category: 'finance' });
        currentDetail = { ...currentDetail, classification: { ...currentDetail.classification!, category: 'finance', overrides: { category: 'finance' }, version: 6 } };
      }
      return Response.json({ success: true, data: currentDetail });
    };
    const correction = render(wrap(<EmailClassificationDetails {...readerProps} item={first} />));
    await act(async () => { fireEvent.click(correction.getByTestId('email-classification-expand')); });
    fireEvent.click(correction.getByTestId('email-classification-correct'));
    const categorySelect = within(correction.getByTestId('email-classification-correction')).getByLabelText('Category') as HTMLSelectElement;
    fireEvent.change(categorySelect, { target: { value: 'finance' } });
    await act(async () => { fireEvent.click(correction.getByTestId('email-classification-save')); });
    assert(correction.getByTestId('email-classification-conflict')); assert.equal(categorySelect.value, 'finance');
    currentDetail = { ...currentDetail, classification: { ...currentDetail.classification!, version: 5, category: 'sales' } };
    await act(async () => { fireEvent.click(correction.getByRole('button', { name: 'Refresh assessment' })); });
    assert.equal(categorySelect.value, 'finance', 'Conflict refresh preserves the correction draft'); conflict = false;
    await act(async () => { fireEvent.click(correction.getByTestId('email-classification-save')); });
    assert.equal(changed.at(-1)?.classification?.version, 6); assert.equal(changed.at(-1)?.classification?.category, 'finance');
    assert.equal(changed.at(-1)?.personalFocus.done, false, 'Correcting an assessment is not personal completion');
    cleanup();

    const lateDetails: Array<(value: Response) => void> = [];
    response = async () => new Promise(resolve => lateDetails.push(resolve));
    const selection = render(wrap(<EmailClassificationDetails {...readerProps} item={first} />));
    await act(async () => { fireEvent.click(selection.getByTestId('email-classification-expand')); });
    const oldSignal = calls.at(-1)!.signal;
    selection.rerender(wrap(<EmailClassificationDetails {...readerProps} item={second} />));
    assert.equal(oldSignal?.aborted, true);
    await act(async () => { lateDetails.pop()!(Response.json({ success: true, data: { ...detail(first), classification: { ...first.classification!, category: 'finance' } } })); });
    assert.equal(selection.queryByText('Finance'), null, 'A late previous-source assessment never appears in the current reader');
    selection.rerender(wrap(<EmailClassificationDetails {...readerProps} item={{ ...second, classification: null }} />));
    assert.equal(selection.queryByText('Support'), null, 'Central disable clears an old compact classification');
    cleanup();
    console.log('Email Focus UI passed: stable authorized snapshots, paging and session races, explicit updates, central-mode/scope controls, preparation visibility, qualified source rows, read-only personal completion, unknown scores, CAS correction preservation and reader revocation/source cleanup.');
  } finally {
    cleanup(); globalThis.fetch = originalFetch; window.setInterval = originalInterval; window.clearInterval = originalClearInterval;
    window.setTimeout = originalTimeout; window.clearTimeout = originalClearTimeout; dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
