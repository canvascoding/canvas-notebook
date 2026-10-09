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

    for (const locale of ['en', 'de'] as const) {
      const messages = locale === 'en' ? en.emailFocus : de.emailFocus;
      const setupHeader = render(wrap(<EmailFocusHeader {...headerProps} classificationEnabled canConfigureClassification processingReason="budget_exhausted" />, locale));
      assert.equal(setupHeader.getByRole('link', { name: messages.configureClassification }).getAttribute('href'), '/settings?tab=system-email');
      assert(setupHeader.getByText(messages.processingReasons.budget_exhausted, { exact: false }));
      assert(setupHeader.getByRole('button', { name: messages.focus }));
      setupHeader.rerender(wrap(<EmailFocusHeader {...headerProps} classificationEnabled processingReason="provider_unavailable" />, locale));
      assert.equal(setupHeader.queryByRole('link', { name: messages.configureClassification }), null);
      assert.equal(setupHeader.queryByRole('button', { name: messages.menu }), null);
      assert(setupHeader.getByText(messages.processingReasons.provider_unavailable, { exact: false }));
      assert(setupHeader.getByText(messages.classificationAdminHint, { exact: false }));
      setupHeader.rerender(wrap(<EmailFocusHeader {...headerProps} controlsOnly canConfigureClassification processingReason="missing_configuration" />, locale));
      assert(setupHeader.getByRole('button', { name: messages.menu }), 'Admins can reach setup from inactive single-mailbox Classic');
      assert.equal(setupHeader.queryByRole('button', { name: messages.focus }), null);
      assert.equal(setupHeader.queryByText(messages.classificationAdminHint, { exact: false }), null, 'Central inactivity stays quiet');
      cleanup();

      const completeMailboxCalls: string[] = [];
      const completeHeader = render(wrap(<EmailFocusHeader {...headerProps} scope={{ kind: 'mailbox', mailboxRef: second.origin.mailboxRef }} onOpenMailbox={mailboxRef => completeMailboxCalls.push(mailboxRef)} />, locale));
      fireEvent.click(completeHeader.getByRole('button', { name: messages.fullMailbox }));
      assert.deepEqual(completeMailboxCalls, [second.origin.mailboxRef], 'The complete mailbox action passes the selected authorized source');
      assert(completeHeader.getByText(messages.fullMailboxHint));
      for (const unavailable of [
        { mailboxes: [] },
        { mailboxesLoading: true },
        { mailboxesError: true },
        { mailboxes: [{ ...second.origin, capabilities: { ...second.origin.capabilities, canRead: false } }] },
      ]) {
        completeHeader.rerender(wrap(<EmailFocusHeader {...headerProps} {...unavailable} scope={{ kind: 'mailbox', mailboxRef: second.origin.mailboxRef }} onOpenMailbox={mailboxRef => completeMailboxCalls.push(mailboxRef)} />, locale));
        assert.equal((completeHeader.getByRole('button', { name: messages.fullMailbox }) as HTMLButtonElement).disabled, true, 'An unconfirmed or unreadable source cannot be opened');
        fireEvent.click(completeHeader.getByRole('button', { name: messages.fullMailbox }));
        assert.deepEqual(completeMailboxCalls, [second.origin.mailboxRef]);
      }
      completeHeader.rerender(wrap(<EmailFocusHeader {...headerProps} mailboxes={[first.origin]} scope={{ kind: 'mailbox', mailboxRef: second.origin.mailboxRef }} onOpenMailbox={mailboxRef => completeMailboxCalls.push(mailboxRef)} />, locale));
      const fallbackChooser = completeHeader.getByRole('button', { name: messages.fullMailbox }) as HTMLButtonElement;
      assert.equal(fallbackChooser.disabled, false);
      assert.equal(fallbackChooser.getAttribute('aria-haspopup'), 'menu', 'A removed selection offers a chooser of other readable sources instead of opening the removed mailbox');
      assert.deepEqual(completeMailboxCalls, [second.origin.mailboxRef]);
      completeHeader.rerender(wrap(<EmailFocusHeader {...headerProps} controlsOnly onOpenMailbox={mailboxRef => completeMailboxCalls.push(mailboxRef)} />, locale));
      assert.equal(completeHeader.queryByRole('button', { name: messages.fullMailbox }), null, 'Full Classic controls do not duplicate the complete-mailbox action');
      cleanup();
    }

    const opened: EmailClassificationFeedItem[] = []; const doneCalls: unknown[] = []; const views: string[] = [];
    const navProps = { feed: feed(), view: 'focus' as const, category: null, onViewChange: (view: string) => views.push(view), onCategoryChange: () => {},
      onOpen: (value: EmailClassificationFeedItem) => opened.push(value), onDone: (value: EmailClassificationFeedItem, done: boolean) => doneCalls.push([value.messageRef, done]),
      selectionKey: null, loading: false, error: null, hasUpdates: false, hasMore: false, onReload: () => {}, onLoadMore: () => {}, aggregate: true };
    const nav = render(wrap(<EmailFocusNavigation {...navProps} />));
    assert.equal(nav.getAllByTestId('email-focus-row').length, 2);
    assert(nav.getByRole('button', { name: /Captured inbox mail: 4/ })); assert(nav.getByRole('button', { name: /Needs review: 1/ })); assert(nav.getByRole('button', { name: /Not yet prepared: 1/ }));
    assert(nav.getByText('Work · Support · work@example.test')); assert(nav.getByText('Personal · personal@example.test'));
    assert.equal(nav.container.textContent?.includes('95%'), false, 'The navigation has no probability columns');
    fireEvent.click(nav.getAllByTestId('email-focus-row')[1]); assert.equal(opened[0].origin.accountOwnerId, 'different-owner');
    fireEvent.click(nav.getByRole('button', { name: 'Mark as done for me: Reply to customer' })); assert.deepEqual(doneCalls, [[second.messageRef, true]], 'Read-only work mail still permits personal completion');
    fireEvent.click(nav.getByRole('button', { name: /Needs review: 1/ })); assert.deepEqual(views, ['review']);
    nav.rerender(wrap(<EmailFocusNavigation {...navProps} feed={{ ...feed([]), nextCursor: null }} />));
    assert(nav.getByText(en.emailFocus.emptyPreparing)); assert.equal(nav.container.textContent?.includes('all caught up'), false);
    cleanup();

    for (const locale of ['en', 'de'] as const) {
      const messages = locale === 'en' ? en.emailFocus : de.emailFocus;
      const capturedFeed: EmailClassificationFeed = { ...feed([first]), view: 'all', counts: { ...feed().counts, total: 2283 },
        coverage: [{ ...feed().coverage[0], pending: 3, failed: 1, stale: 2 }] };
      const captured = render(wrap(<EmailFocusNavigation {...navProps} feed={capturedFeed} view="all" mailboxes={[first.origin]} />, locale));
      const totalButton = captured.getByRole('button', { name: `${messages.views.all}: 2283` });
      assert(captured.getByRole('heading', { name: messages.views.all }), 'The section uses the same captured Inbox label');
      assert.equal(totalButton.getAttribute('aria-describedby'), captured.getByTestId('email-captured-count-hint').id);
      assert(captured.getByText(messages.counts.hint));
      assert.equal(captured.queryByTestId('email-capture-incomplete'), null, 'Pending, failed and stale AI assessments do not imply incomplete capture');
      const assessmentScope = captured.getByTestId('email-assessment-scope') as HTMLDetailsElement;
      assert.equal(assessmentScope.open, false, 'Assessment scope occupies one compact summary by default');
      assert.equal(assessmentScope.querySelector('summary')!.textContent, messages.assessmentScope);
      fireEvent.click(assessmentScope.querySelector('summary')!);
      assert.equal(assessmentScope.open, true);
      assert(captured.getByText(messages.assessmentScopeHint.replace('{days}', '30')));
      assert.equal(assessmentScope.textContent?.includes('5000'), false, 'The UI does not promise a per-scan historical budget');
      for (const state of ['pending', 'partial', 'failed'] as const) {
        captured.rerender(wrap(<EmailFocusNavigation {...navProps} view="all" feed={{ ...capturedFeed, coverage: [{ ...capturedFeed.coverage[0], state }] }} mailboxes={[first.origin]} />, locale));
        assert.equal(captured.getByTestId('email-capture-incomplete').textContent, messages.counts.incomplete);
        assert(captured.getByRole('button', { name: `${messages.views.all}: 2283` }));
      }
      captured.rerender(wrap(<EmailFocusNavigation {...navProps} view="all" feed={{ ...capturedFeed, mode: 'classic', requestedMode: 'classic' }} mailboxes={[first.origin]} />, locale));
      assert.equal(captured.queryByTestId('email-assessment-scope'), null, 'Classic shows no AI assessment-window footer');
      assert.equal(captured.queryByTestId('email-capture-incomplete'), null);
      captured.rerender(wrap(<EmailFocusNavigation {...navProps} view="all" feed={null} loading mailboxes={[first.origin]} />, locale));
      assert(captured.getByRole('button', { name: `${messages.views.all}: —` }));
      assert(captured.getByText(messages.counts.unconfirmed));
      captured.rerender(wrap(<EmailFocusNavigation {...navProps} view="all" feed={capturedFeed} error={{ code: 'EMAIL_FEED_UNAVAILABLE', status: 503 }} mailboxes={[first.origin]} />, locale));
      assert(captured.getByRole('button', { name: `${messages.views.all}: —` }));
      captured.rerender(wrap(<EmailFocusNavigation {...navProps} view="all" feed={{ ...feed(), counts: { ...feed().counts, total: 2283 } }} mailboxes={[first.origin]} />, locale));
      assert(captured.getByRole('button', { name: `${messages.views.all}: —` }), 'An old snapshot count stays unconfirmed after source removal');
      assert.equal(captured.getAllByTestId('email-focus-row').length, 1);
      assert.equal(captured.queryByText('Work · Support · work@example.test'), null);
      assert.equal(captured.queryByText(second.message.subject), null, 'A revoked source loses cached row content as well as count validity');
      captured.rerender(wrap(<EmailFocusNavigation {...navProps} view="all" feed={{ ...capturedFeed, items: [], coverage: [], counts: { ...capturedFeed.counts, total: 0 } }} mailboxes={[first.origin]} />, locale));
      assert(captured.getByRole('button', { name: `${messages.views.all}: —` }), 'Missing coverage for a readable scoped source cannot imply a confirmed zero');
      assert(captured.getByText(messages.counts.unconfirmed));
      assert(captured.getByText(messages.emptyPreparing), 'Missing source coverage cannot imply a fully confirmed empty view');
      fireEvent.click(captured.getByText(messages.moreViews));
      assert(captured.getByRole('button', { name: `${messages.categories.support}: —` }), 'Category counts remain unconfirmed alongside the total');
      captured.rerender(wrap(<EmailFocusNavigation {...navProps} view="all" feed={{ ...capturedFeed, scope: { kind: 'work' }, items: [], coverage: [], counts: { ...capturedFeed.counts, total: 0 } }} mailboxes={[first.origin]} />, locale));
      assert(captured.getByRole('button', { name: `${messages.views.all}: 0` }), 'A scope with no readable catalog source can truthfully show zero');
      assert.equal(captured.queryByTestId('email-capture-incomplete'), null);
      cleanup();
    }

    const emptyMailbox = { ...first.origin, mailboxRef: `emb:${'d'.repeat(64)}`, accountId: 'empty', emailAddress: 'empty@example.test',
      displayName: 'Long mailbox name '.repeat(12), workspaceName: 'International support team '.repeat(8) };
    const diagnosticFeed: EmailClassificationFeed = { ...feed([first]), nextCursor: null,
      coverage: [feed().coverage[0],
        { mailboxRef: second.origin.mailboxRef, state: 'failed', lastSyncAt: Date.parse('2026-10-09T10:15:00Z'), indexed: 2, pending: 3, failed: 1, stale: 2,
          errorCode: 'auth_required', source: { emailAddress: second.origin.emailAddress, displayName: 'Customer support', workspaceName: 'Support' } },
        { mailboxRef: emptyMailbox.mailboxRef, state: 'failed', lastSyncAt: null, indexed: 0, pending: 0, failed: 0, stale: 0,
          errorCode: 'auth_required', source: { emailAddress: emptyMailbox.emailAddress, displayName: emptyMailbox.displayName, workspaceName: emptyMailbox.workspaceName } }] };
    for (const locale of ['en', 'de'] as const) {
      const messages = locale === 'en' ? en.emailFocus : de.emailFocus;
      const mailboxActions: Array<[string, boolean | undefined]> = []; let reloads = 0;
      const diagnosticProps = { ...navProps, feed: diagnosticFeed, mailboxes: [first.origin, second.origin, emptyMailbox],
        onOpenMailbox: (mailboxRef: string, manageConnection?: boolean) => mailboxActions.push([mailboxRef, manageConnection]), onReload: () => { reloads++; } };
      const diagnostics = render(wrap(<EmailFocusNavigation {...diagnosticProps} />, locale));
      const panel = diagnostics.getByTestId('email-source-diagnostics') as HTMLDetailsElement;
      assert(diagnostics.getByTestId('email-source-diagnostics-scroll').classList.contains('max-h-64'), 'Expanded source details preserve a bounded message area');
      assert.equal(panel.open, false, 'Mailbox diagnostics start as a short collapsed summary');
      assert.match(panel.querySelector('summary')!.textContent!, /2/);
      fireEvent.click(panel.querySelector('summary')!);
      assert.equal(panel.open, true, 'Native summary opens mailbox details');
      const sources = diagnostics.getAllByTestId('email-source-diagnostic');
      assert.equal(sources.length, 2, 'Only sources needing capture or assessment attention appear');
      const readonly = within(sources[0]); const emptySource = within(sources[1]);
      assert(readonly.getByText('Customer support')); assert(readonly.getByText(second.origin.emailAddress));
      assert(readonly.getByText(messages.diagnostics.contactManager));
      assert.equal(readonly.queryByRole('button', { name: messages.diagnostics.checkConnection }), null, 'Read-only mailbox users cannot manage provider access');
      assert(readonly.getByText(messages.diagnostics.aiPending.replace('{count}', '3')));
      assert(readonly.getByText(messages.diagnostics.aiFailed.replace('{count}', '1')));
      assert(readonly.getByText(messages.diagnostics.aiStale.replace('{count}', '2')));
      assert.equal(sources[0].querySelector('time')!.getAttribute('datetime'), '2026-10-09T10:15:00.000Z');
      assert.match(sources[0].querySelector('time')!.textContent!, /2026/);
      assert.match(sources[0].querySelector('time')!.textContent!, /\d{1,2}:\d{2}/);
      assert(emptySource.getByText(messages.diagnostics.neverConfirmed));
      assert(emptySource.getByText(emptyMailbox.displayName.trim())); assert(emptySource.getByText(emptyMailbox.workspaceName.trim()));
      assert.equal(sources[1].querySelector('[class*="overflow-wrap:anywhere"]') !== null, true, 'Long names and addresses can wrap on narrow layouts');
      fireEvent.click(readonly.getByRole('button', { name: messages.diagnostics.openClassic }));
      fireEvent.click(emptySource.getByRole('button', { name: messages.diagnostics.checkConnection }));
      assert.deepEqual(mailboxActions, [[second.origin.mailboxRef, undefined], [emptyMailbox.mailboxRef, true]], 'Source actions preserve the mailbox reference and management intent');
      fireEvent.click(diagnostics.getByRole('button', { name: messages.diagnostics.reload }));
      assert.equal(reloads, 1); assert(diagnostics.getByText(messages.diagnostics.reloadHint));
      assert.equal(diagnostics.getAllByTestId('email-focus-row').length, 1, 'A working mailbox remains usable alongside an empty failed source');
      diagnostics.rerender(wrap(<EmailFocusNavigation {...diagnosticProps} feed={{ ...diagnosticFeed, mode: 'classic', requestedMode: 'classic' }} />, locale));
      assert.equal(diagnostics.queryByTestId('email-source-assessments'), null, 'Classic capture diagnostics do not show AI preparation counts');
      diagnostics.rerender(wrap(<EmailFocusNavigation {...diagnosticProps} mailboxes={[]} />, locale));
      assert.equal(diagnostics.queryByRole('button', { name: messages.diagnostics.openClassic }), null, 'Unconfirmed source capabilities cannot offer mailbox actions');
      assert.equal(diagnostics.queryByRole('button', { name: messages.diagnostics.checkConnection }), null);
      assert.equal(diagnostics.queryByTestId('email-source-diagnostics'), null, 'An empty current catalog removes stale feed diagnostic metadata');
      assert.equal(diagnostics.container.textContent?.includes('Customer support'), false);
      diagnostics.rerender(wrap(<EmailFocusNavigation {...diagnosticProps} mailboxes={[first.origin, { ...second.origin, capabilities: { ...second.origin.capabilities, canRead: false } }, emptyMailbox]} />, locale));
      assert.equal(diagnostics.queryByText('Customer support'), null, 'Revoked canRead removes a cached source name and timestamp');
      assert.equal(diagnostics.getAllByTestId('email-source-diagnostic').length, 1);
      assert.equal(diagnostics.container.querySelector('time[datetime="2026-10-09T10:15:00.000Z"]'), null);
      cleanup();

      for (const errorCode of ['auth_required', 'rate_limited', 'timeout', 'provider_unavailable', 'content_invalid', 'sync_failed', 'unsafe-provider-secret'] as const) {
        const expected = errorCode === 'unsafe-provider-secret' ? 'sync_failed' : errorCode;
        const reasonFeed: EmailClassificationFeed = { ...feed([]), coverage: [{ ...diagnosticFeed.coverage[2], lastSyncAt: Number.MAX_VALUE, errorCode: errorCode as never, source: undefined }] };
        const reasons = render(wrap(<EmailFocusNavigation {...navProps} feed={reasonFeed} mailboxes={[emptyMailbox]} />, locale));
        const reasonPanel = reasons.getByTestId('email-source-diagnostics') as HTMLDetailsElement;
        fireEvent.click(reasonPanel.querySelector('summary')!);
        assert(reasons.getByText(messages.diagnostics.errors[expected]));
        assert(reasons.getByText(messages.diagnostics.neverConfirmed), 'Out-of-range timestamps cannot fabricate a confirmed capture or crash the view');
        assert(reasons.getByText(emptyMailbox.emailAddress), 'Authorized catalog labels support older feed payloads');
        assert.equal(reasons.container.textContent?.includes('unsafe-provider-secret'), false, 'Unknown errors never expose provider content');
        assert(reasons.getByText(messages.emptyPreparing), 'An empty unconfirmed source never becomes a fully captured empty mailbox');
        cleanup();
      }
      const assessedFeed: EmailClassificationFeed = { ...feed([]), coverage: [{ ...feed().coverage[0], pending: 2, failed: 1, stale: 1 }] };
      const assessmentOnly = render(wrap(<EmailFocusNavigation {...navProps} feed={assessedFeed} />, locale));
      const assessmentPanel = assessmentOnly.getByTestId('email-source-diagnostics') as HTMLDetailsElement;
      fireEvent.click(assessmentPanel.querySelector('summary')!);
      assert(assessmentOnly.getByText(messages.diagnostics.states.complete));
      assert(assessmentOnly.getByText(messages.diagnostics.aiFailed.replace('{count}', '1')));
      assert.equal(assessmentOnly.queryByText(messages.diagnostics.states.failed), null, 'A failed assessment cannot be described as failed Inbox capture');
      assessmentOnly.rerender(wrap(<EmailFocusNavigation {...navProps} feed={{ ...assessedFeed, mode: 'classic' }} />, locale));
      assert.equal(assessmentOnly.queryByTestId('email-source-diagnostics'), null, 'Complete capture has no warning in Classic when only AI work remains');
      cleanup();
    }

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
