import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { Inbox } from 'lucide-react';
import en from '../messages/en.json';
import de from '../messages/de.json';
import type { EmailClassificationFeed, EmailClassificationFeedItem } from '../app/lib/email/classification/feed-types';
import type { HomeEmailFocusState } from '../app/components/home/useHomeEmailFocus';
import { emailOriginSelectionKey } from '../app/lib/email/classification/mailbox-types';
import { DEFAULT_EMAIL_CLASSIFICATION_POLICY } from '../app/lib/email/classification/types';
import { projectEmailClassification } from '../app/lib/email/classification/policy';

const require = createRequire(import.meta.url);
require.extensions['.css'] = module => { module.exports = { card: 'card', widgetBody: 'widget-body', preview: 'preview' }; };
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'Event', 'MutationObserver', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

function item(character: string, work: boolean): EmailClassificationFeedItem {
  const origin = { mailboxRef: `emb:${character.repeat(64)}`, accountSource: 'local' as const, accountId: work ? 'work' : 'personal',
    accountScope: work ? 'workspace' as const : 'personal' as const, accountOwnerId: work ? 'another-owner' : 'actor',
    mailboxId: work ? 'binding' : null, workspaceId: work ? 'work-space' : null, workspaceName: work ? 'Customer team' : null,
    emailAddress: work ? 'work@example.test' : 'personal@example.test', displayName: null, folder: 'INBOX', canonicalId: 'same-provider-id',
    capabilities: { canRead: true, canWrite: !work, canDelete: !work, canRunAgent: !work, canManage: !work } };
  const rawProjection = projectEmailClassification({ raw: null, policy: DEFAULT_EMAIL_CLASSIFICATION_POLICY });
  return { messageRef: `emm:${character.repeat(64)}`, selectionKey: emailOriginSelectionKey(origin), origin,
    message: { from: 'Customer', subject: work ? 'Work reply' : 'Important personal mail', snippet: 'Please reply', date: '2026-10-07T12:00:00Z', isRead: true },
    classification: { ...rawProjection, group: work ? 'reply' : 'important', category: 'support', priority: work ? 'normal' : 'high', needsReply: true,
      isSpam: false, status: 'ready', states: { category: 'ready', priority: 'ready', spam: 'ready', reply: 'ready' }, replyProbability: 0.98 }, personalFocus: { done: false, version: 0 } };
}
const personal = item('a', false); const work = item('b', true);
function feed(items = [personal, work]): EmailClassificationFeed {
  return { scope: { kind: 'all' }, requestedMode: 'focus', mode: 'focus', view: 'focus', items, nextCursor: null,
    snapshot: { id: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 600_000 }, hasUpdates: false,
    counts: { total: 16, groups: { important: 5, reply: 3, review: 2, pending: 1, other: 4, spam: 0, done: 1 }, categories: { support: 16 } },
    coverage: [personal, work].map(value => ({ mailboxRef: value.origin.mailboxRef, state: 'complete', lastSyncAt: Date.now(), indexed: 8, pending: 0, failed: 0, stale: 0 })),
    limits: { initialLookbackDays: 30, maxHistoricalMessages: 5000 } };
}
const legacy = { status: 'ready' as const, data: [{ id: 'legacy', accountId: 'personal', accountLabel: 'Personal', from: 'Sender', subject: 'Legacy unread', date: null }] };
const enabled = { enabled: true, available: false, revision: 1, defaultMode: 'focus' as const, reason: 'provider_unavailable' as const };

async function main() {
  const { render, renderHook, cleanup, fireEvent } = await import('@testing-library/react');
  const { useHomeEmailFocus } = await import('../app/components/home/useHomeEmailFocus');
  const { useHomeWorkspaceWidgets } = await import('../app/components/home/useHomeWorkspaceWidgets');
  const { HomeEmailWidget, HomeWidgetGrid, WidgetCard } = await import('../app/components/home/HomeAppLinks');
  const originalFetch = globalThis.fetch; const originalInterval = window.setInterval; const originalClearInterval = window.clearInterval;
  const intervals = new Map<number, () => void>(); let intervalId = 0;
  window.setInterval = ((callback: TimerHandler, millis?: number) => { assert.equal(millis, 30000); intervals.set(++intervalId, callback as () => void); return intervalId; }) as typeof window.setInterval;
  window.clearInterval = ((id: number) => { intervals.delete(id); }) as typeof window.clearInterval;
  const calls: URL[] = []; let availability: unknown = enabled; let availabilityStatus = 200; let feedStatus = 200; let nextFeed = feed();
  globalThis.fetch = async input => {
    const url = new URL(String(input), 'http://localhost'); calls.push(url);
    if (url.pathname.endsWith('/availability')) {
      if (availabilityStatus !== 200) {
        const failure = new Response('', { status: availabilityStatus }); Object.defineProperty(failure, 'json', { value: () => new Promise(() => {}) }); return failure;
      }
      return Response.json({ success: true, data: availability });
    }
    if (url.pathname.endsWith('/feed')) {
      if (feedStatus === 403) {
        const failure = new Response('', { status: feedStatus }); Object.defineProperty(failure, 'json', { value: () => new Promise(() => {}) }); return failure;
      }
      return Response.json({ success: feedStatus === 200, data: nextFeed, error: 'PRIVATE_SERVER_ERROR' }, { status: feedStatus });
    }
    assert.equal(url.pathname, '/api/home/workspace-widgets');
    return Response.json({ success: true, data: { emails: { ...legacy, cachedAt: new Date().toISOString(), stale: false }, todos: { status: 'ready', data: [] }, studio: { status: 'ready', data: null }, automation: { status: 'ready', data: null } } });
  };
  const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  const poll = () => act(async () => { for (const callback of [...intervals.values()]) callback(); });
  const wrapper = (content: React.ReactNode, locale: 'en' | 'de' = 'en') => <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : de} timeZone="UTC">{content}</NextIntlClientProvider>;
  try {
    const hook = renderHook(({ userId, active }: { userId: string; active: boolean }) => {
      const home = useHomeEmailFocus(userId, active);
      const widgets = useHomeWorkspaceWidgets('workspace', active, { actorId: userId, emailEnabled: home.mode === 'legacy' });
      return { home, widgets };
    }, { initialProps: { userId: 'actor', active: true } });
    const current = () => hook.result.current;
    await tick(); await tick();
    assert.equal(current().home.mode, 'focus', 'Provider readiness does not turn off saved Focus ratings');
    const feedCalls = () => calls.filter(url => url.pathname.endsWith('/feed'));
    assert.equal(feedCalls()[0].searchParams.get('limit'), '2'); assert.equal(feedCalls()[0].searchParams.get('scope'), 'all');
    assert.equal(feedCalls()[0].searchParams.get('view'), 'focus');
    assert(calls.filter(url => url.pathname.endsWith('/workspace-widgets')).every(url => !url.searchParams.get('widgets')?.split(',').includes('emails')), 'Focus never starts the legacy per-provider mailbox pipeline');
    assert.equal(current().home.focus.feed?.counts.total, 16);
    nextFeed = { ...feed([work, personal]), counts: { ...feed().counts, total: 99 }, hasUpdates: true };
    await poll();
    assert.deepEqual(current().home.focus.items.map(value => value.messageRef), [personal.messageRef, work.messageRef]);
    assert.equal(current().home.focus.feed?.counts.total, 16, 'Background ratings retain working snapshot counters');
    assert.equal(current().home.focus.hasUpdates, true);
    assert(feedCalls().at(-1)?.searchParams.get('cursor'), 'Rights polling revisits the stable snapshot');
    feedStatus = 403; await poll(); assert.deepEqual(current().home.focus.items, [], 'Revocation clears the preview immediately');
    assert.equal(current().home.focus.error?.status, 403);
    availabilityStatus = 503; await poll(); assert.equal(current().home.mode, 'unknown');
    assert(calls.filter(url => url.pathname.endsWith('/workspace-widgets')).every(url => !url.searchParams.get('widgets')?.split(',').includes('emails')), 'Unknown activation is not central off');
    availabilityStatus = 200; feedStatus = 200; availability = { ...enabled, enabled: false, reason: 'disabled', defaultMode: 'classic' };
    await poll(); await tick(); assert.equal(current().home.mode, 'legacy'); assert.equal(current().widgets.emails.data[0]?.subject, 'Legacy unread');
    const legacyCalls = calls.filter(url => url.pathname.endsWith('/workspace-widgets') && url.searchParams.get('widgets') === 'emails');
    assert.equal(legacyCalls.length, 1, 'Confirmed off activates the preserved legacy pipeline without reloading other widgets');
    hook.rerender({ userId: 'another-user', active: true }); assert.equal(current().home.mode, 'unknown');
    assert.deepEqual(current().widgets.emails.data, [], 'Session change hides previous cached personal preview');
    hook.unmount();

    for (const status of [401, 403]) {
      let deny = false; let holdStudio = false; let releaseStudio!: (value: Response) => void; let studioSignal: AbortSignal | null | undefined;
      let deniedBodyRequested = false;
      const currentStudioSignal = (): AbortSignal | null | undefined => studioSignal;
      const readyWidgets = (subject: string) => ({ emails: { ...legacy, data: [{ ...legacy.data[0], subject }], cachedAt: new Date().toISOString(), stale: false },
        todos: { status: 'ready', data: [{ id: 'private-todo', title: subject, priority: 'normal', dueAt: null }] },
        studio: { status: 'ready', data: { id: 'private-studio', prompt: subject, status: 'completed', createdAt: '', output: null } },
        automation: { status: 'ready', data: { id: 'private-run', name: subject, status: 'active', lastRunAt: null, lastRunStatus: null, nextRunAt: null, resultText: subject } } });
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input), 'http://localhost');
        assert.equal(url.pathname, '/api/home/workspace-widgets');
        if (url.searchParams.get('widgets') === 'studio' && holdStudio) {
          studioSignal = init?.signal; return new Promise(resolve => { releaseStudio = resolve; });
        }
        if (deny) {
          const denial = new Response('', { status });
          Object.defineProperty(denial, 'json', { value: () => { deniedBodyRequested = true; return new Promise(() => {}); } });
          return denial;
        }
        return Response.json({ success: true, data: readyWidgets('Current private data') });
      };
      const denied = renderHook(() => useHomeWorkspaceWidgets('shared-workspace', true, { actorId: 'actor' }));
      const deniedState = () => denied.result.current;
      await tick(); assert.equal(deniedState().emails.status, 'ready'); assert.equal(deniedState().todos.status, 'ready');
      holdStudio = true;
      await act(async () => { window.dispatchEvent(new CustomEvent('workspace_widgets_updated', { detail: { widgets: ['studio'] } })); });
      deny = true;
      await act(async () => {
        if (status === 401) deniedState().retry('todos');
        else window.dispatchEvent(new CustomEvent('workspace_widgets_updated', { detail: { widgets: ['todos'] } }));
      });
      assert.equal(deniedState().accessDenied, true); assert.equal(currentStudioSignal()?.aborted, true);
      assert.equal(deniedBodyRequested, false, 'Unauthorized response headers clear previews without waiting for a response body');
      assert.deepEqual(deniedState().emails.data, []); assert.deepEqual(deniedState().todos.data, []);
      assert.equal(deniedState().studio.data, null); assert.equal(deniedState().automation.data, null);
      await act(async () => { releaseStudio(Response.json({ success: true, data: readyWidgets('Old delayed private data') })); });
      assert.equal(deniedState().accessDenied, true); assert.equal(deniedState().studio.data, null, 'A late successful response cannot revive previews after a foreground or background auth denial');
      deny = false; holdStudio = false;
      await act(async () => { deniedState().retry(); });
      assert.equal(deniedState().accessDenied, false); assert.equal(deniedState().emails.data[0]?.subject, 'Current private data');
      denied.unmount();
    }

    const focusState: HomeEmailFocusState = { mode: 'focus', availability: enabled, loading: false, error: false, refresh: async () => {},
      focus: { feed: feed(), items: feed().items, loading: false, loadingMore: false, error: null, hasUpdates: false, hasMore: false, reload() {}, loadMore() {}, updateItem() {} } };
    const props = { state: legacy, onRetry() {}, emailFocus: focusState, identity: 'actor:workspace:focus' };
    const card = render(wrapper(<HomeEmailWidget {...props} />));
    const summary = card.getByTestId('home-email-focus-summary');
    assert.equal(summary.dataset.focusCount, '8'); assert.equal(summary.dataset.importantCount, '5'); assert.equal(summary.dataset.replyCount, '3'); assert.equal(summary.dataset.totalCount, '16');
    assert(card.getByText('8 in Focus')); assert(card.getByText('3 other replies needed'));
    assert.equal(card.getAllByTestId('home-email-focus-row').length, 2); assert(card.getByText('High')); assert(card.getAllByText('Reply expected').length === 2);
    assert(card.getByText('New preparation paused')); assert.equal(card.container.textContent?.includes('98%'), false);
    const workLink = new URL(card.getAllByTestId('home-email-focus-row')[1].getAttribute('href')!, 'http://localhost');
    assert.equal(workLink.searchParams.get('messageRef'), work.messageRef); assert.equal(workLink.searchParams.get('scope'), 'all'); assert.equal(workLink.searchParams.get('mode'), 'focus');
    assert.equal(workLink.searchParams.has('accountId'), false, 'The current server-side source is resolved from its qualified ref');
    const reviewLink = new URL(card.getByTestId('home-email-focus-review').getAttribute('href')!, 'http://localhost'); assert.equal(reviewLink.searchParams.get('view'), 'review');
    fireEvent.pointerEnter(card.getByTestId('workspace-widget-email'));
    card.rerender(wrapper(<HomeEmailWidget {...props} emailFocus={{ ...focusState, focus: { ...focusState.focus, feed: { ...feed(), items: [work, personal], counts: { ...feed().counts, total: 99 } } } }} />));
    assert.equal(card.getAllByTestId('home-email-focus-row')[0].dataset.messageRef, personal.messageRef, 'Pointer freeze keeps the selected row and href stable');
    assert.equal(card.getByTestId('home-email-focus-summary').dataset.totalCount, '16');
    card.rerender(wrapper(<HomeEmailWidget {...props} emailFocus={{ ...focusState, focus: { ...focusState.focus, feed: null, items: [], error: { code: 'FORBIDDEN', status: 403 } } }} />));
    assert.equal(card.queryByTestId('home-email-focus-row'), null, 'Rights invalidation bypasses a hovered frozen ReactNode');
    assert.equal(card.queryByTestId('home-email-focus-summary'), null); assert(card.getByTestId('home-email-focus-status'));
    assert.equal(card.container.textContent?.includes('PRIVATE_SERVER_ERROR'), false);
    card.rerender(wrapper(<HomeEmailWidget {...props} emailFocus={{ ...focusState, mode: 'unknown', error: true }} identity="new-session:workspace:unknown" />));
    assert.equal(card.queryByTestId('home-email-focus-row'), null); assert(card.getByText(en.home.workspaceWidgets.email.unconfirmed));
    card.rerender(wrapper(<HomeEmailWidget {...props} emailFocus={{ ...focusState, mode: 'legacy' }} identity="actor:workspace:legacy" />));
    assert(card.getByText('Legacy unread')); assert.equal(card.queryByTestId('home-email-focus-summary'), null);
    const emptyFeed = { ...feed([]), coverage: [{ ...feed().coverage[0], state: 'partial' as const, pending: 1 }] };
    card.rerender(wrapper(<HomeEmailWidget {...props} emailFocus={{ ...focusState, focus: { ...focusState.focus, feed: emptyFeed, items: [] } }} />, 'de'));
    assert(card.getByText(de.home.workspaceWidgets.email.emptyPreparing)); assert(card.getByTestId('home-email-focus-review')); assert(card.getByTestId('home-email-focus-pending'));
    assert.equal(card.container.textContent?.includes(de.home.workspaceWidgets.email.empty), false);
    cleanup();

    const grid = (actor: string, status: 'ready' | 'loading') => wrapper(<HomeWidgetGrid identity={`${actor}:same-workspace`}>
      {['todos', 'studio', 'automation'].map(id => <WidgetCard key={id} id={id} title={id} description="Preview" icon={Inbox} href={`/${id}`} footer="Open"
        freezeEnabled={status === 'ready'} preview={<p>{status === 'ready' ? `${actor} ${id}` : 'Loading'}</p>} />)}
    </HomeWidgetGrid>);
    const widgets = render(grid('user-A', 'ready'));
    for (const id of ['todos', 'studio', 'automation']) fireEvent.pointerEnter(widgets.getByTestId(`workspace-widget-${id}`));
    widgets.rerender(grid('user-B', 'loading'));
    for (const id of ['todos', 'studio', 'automation']) assert.equal(widgets.queryByText(`user-A ${id}`), null);
    widgets.rerender(grid('user-B', 'ready'));
    for (const id of ['todos', 'studio', 'automation']) {
      assert(widgets.getByText(`user-B ${id}`)); assert.equal(widgets.queryByText(`user-A ${id}`), null, 'The former actor’s frozen private preview cannot return when the next actor is ready');
    }
    cleanup();
    for (const interaction of ['pointer', 'keyboard'] as const) {
      const sourceCard = (subject: string, ready: boolean) => wrapper(<WidgetCard id="email" title="Email" description="Preview" icon={Inbox} href="/emails" footer="Open" freezeEnabled={ready} freezeIdentity="same-user:same-source" preview={<p>{subject}</p>} />);
      const source = render(sourceCard('Old source mail', true));
      if (interaction === 'pointer') fireEvent.pointerEnter(source.getByTestId('workspace-widget-email'));
      else fireEvent.focus(source.getAllByRole('link')[0]);
      source.rerender(sourceCard('Source unavailable', false)); assert.equal(source.queryByText('Old source mail'), null);
      source.rerender(sourceCard('No current mail', true)); assert(source.getByText('No current mail'));
      assert.equal(source.queryByText('Old source mail'), null, 'A disabled freeze is permanently discarded before the same source becomes ready again');
      cleanup();
    }
    console.log('Home Email Focus: authorized limit-two feed, real counters, stable refresh, off/unknown/session fences, legacy SWR, paused status, source refs and pointer-revocation UI passed.');
  } finally {
    cleanup(); globalThis.fetch = originalFetch; window.setInterval = originalInterval; window.clearInterval = originalClearInterval; dom.window.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
