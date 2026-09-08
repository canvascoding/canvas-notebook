import assert from 'node:assert/strict';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';

import {
  claimHomeWidgetRefreshToken,
  HOME_WIDGET_NAMES,
  parseHomeWidgetSelection,
} from '../app/lib/home/workspace-widget-request';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'Event'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

function emailResult(
  refreshToken: string,
  subject: string,
  refreshQueued = true,
  state: 'fresh' | 'stale' = 'stale',
) {
  return {
    status: 'ready' as const,
    data: [{ id: `message-${refreshToken}`, accountId: 'account', accountLabel: 'mail@example.test', folder: 'INBOX', from: 'sender@example.test', subject, date: '2026-09-08T10:00:00.000Z' }],
    cachedAt: '2026-09-08T10:00:00.000Z',
    stale: state === 'stale',
    cache: {
      enabled: true,
      state,
      source: 'cache' as const,
      fetchedAt: '2026-09-08T10:00:00.000Z',
      staleAt: '2026-09-08T10:01:00.000Z',
      expiresAt: '2026-09-15T10:00:00.000Z',
      refreshQueued,
      refreshToken,
      partial: false,
      accountCount: 1,
      successfulAccountCount: 1,
    },
  };
}

const otherWidgets = {
  todos: { status: 'ready' as const, data: [{ id: 'todo', title: 'Todo', priority: 'normal', dueAt: null, readState: 'read' }], cachedAt: '2026-09-08T10:00:00.000Z', stale: false },
  automation: { status: 'ready' as const, data: null, cachedAt: '2026-09-08T10:00:00.000Z', stale: false },
  studio: { status: 'ready' as const, data: null, cachedAt: '2026-09-08T10:00:00.000Z', stale: false },
};

function success(data: Record<string, unknown>) {
  return Response.json({ success: true, data });
}

async function main() {
  assert.deepEqual(parseHomeWidgetSelection(null, HOME_WIDGET_NAMES), HOME_WIDGET_NAMES);
  assert.deepEqual(parseHomeWidgetSelection('studio,emails,studio', []), ['emails', 'studio']);
  assert.equal(parseHomeWidgetSelection('emails,unknown', []), null);
  assert.equal(parseHomeWidgetSelection('', []), null);

  const claimedTokens = new Set<string>();
  assert.equal(claimHomeWidgetRefreshToken(claimedTokens, 'token-0'), true);
  assert.equal(claimHomeWidgetRefreshToken(claimedTokens, 'token-0'), false);
  for (let index = 1; index < 205; index += 1) {
    assert.equal(claimHomeWidgetRefreshToken(claimedTokens, `token-${index}`), true);
  }
  assert.equal(claimedTokens.size, 200);
  assert.equal(claimedTokens.has('token-0'), false);
  assert.equal(claimedTokens.has('token-4'), false);
  assert.equal(claimedTokens.has('token-5'), true);
  assert.equal(claimedTokens.has('token-204'), true);

  const { cleanup, fireEvent, render } = await import('@testing-library/react');
  const {
    HOME_EMAIL_STALE_FOLLOW_UP_MAX_DELAY_MS,
    HOME_EMAIL_STALE_FOLLOW_UP_MS,
    homeEmailStaleFollowUpDelay,
    useHomeWorkspaceWidgets,
  } = await import('../app/components/home/useHomeWorkspaceWidgets');
  assert.equal(homeEmailStaleFollowUpDelay(1), HOME_EMAIL_STALE_FOLLOW_UP_MS);
  assert.equal(homeEmailStaleFollowUpDelay(2), HOME_EMAIL_STALE_FOLLOW_UP_MS * 2);
  assert.equal(homeEmailStaleFollowUpDelay(8), HOME_EMAIL_STALE_FOLLOW_UP_MAX_DELAY_MS);
  assert.equal(homeEmailStaleFollowUpDelay(20), HOME_EMAIL_STALE_FOLLOW_UP_MAX_DELAY_MS);
  const settle = async (delay = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, delay)); });

  function Probe({ workspaceId }: { workspaceId: string }) {
    const widgets = useHomeWorkspaceWidgets(workspaceId, true);
    return <div>
      <span data-testid="email-status">{widgets.emails.status}</span>
      <span data-testid="email-subject">{widgets.emails.data[0]?.subject || ''}</span>
      <span data-testid="email-token">{widgets.emails.cache?.refreshToken || ''}</span>
      <span data-testid="email-source">{widgets.emails.cache?.source || ''}</span>
      <span data-testid="email-partial">{String(widgets.emails.cache?.partial)}</span>
      <span data-testid="todo-title">{widgets.todos.data[0]?.title || ''}</span>
      <button type="button" onClick={() => widgets.retry('todos')}>Retry todos</button>
    </div>;
  }

  const calls: URL[] = [];
  let fullRequests = 0;
  let emailRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    calls.push(url);
    const widgets = url.searchParams.get('widgets');
    if (widgets === 'emails') {
      emailRequests += 1;
      if (emailRequests === 1) {
        return success({ emails: emailResult('token-one', 'Provider still refreshing') });
      }
      const token = emailRequests === 2 ? 'token-two' : 'token-four';
      return success({ emails: emailResult(token, 'Refreshed email', false, 'fresh') });
    }
    if (widgets === 'todos') {
      return success({
        todos: { ...otherWidgets.todos, data: [{ ...otherWidgets.todos.data[0], title: 'Retried todo' }] },
      });
    }
    assert.equal(widgets, HOME_WIDGET_NAMES.join(','));
    fullRequests += 1;
    const token = fullRequests === 1 ? 'token-one' : 'token-three';
    return success({ emails: emailResult(token, fullRequests === 1 ? 'Cached email' : 'Cached again'), ...otherWidgets });
  };

  let screen = render(<Probe workspaceId="workspace-one" />);
  await settle();
  assert.equal(screen.getByTestId('email-status').textContent, 'ready');
  assert.equal(screen.getByTestId('email-subject').textContent, 'Cached email');
  assert.equal(screen.getByTestId('email-token').textContent, 'token-one');
  assert.equal(screen.getByTestId('email-source').textContent, 'cache');
  assert.equal(screen.getByTestId('email-partial').textContent, 'false');
  assert.equal(calls.length, 1);

  await settle(HOME_EMAIL_STALE_FOLLOW_UP_MS + 80);
  assert.equal(calls.length, 2, 'a stale token should schedule a delayed follow-up');
  assert.equal(calls[1]?.searchParams.get('widgets'), 'emails');
  assert.equal(calls[1]?.searchParams.has('refresh'), false);
  assert.equal(screen.getByTestId('email-token').textContent, 'token-one');
  assert.equal(screen.getByTestId('email-subject').textContent, 'Provider still refreshing');

  await settle(homeEmailStaleFollowUpDelay(2) + 80);
  assert.equal(calls.length, 3, 'the same stale token should be polled again while its refresh is queued');
  assert.equal(calls[2]?.searchParams.get('widgets'), 'emails');
  assert.equal(screen.getByTestId('email-token').textContent, 'token-two');
  assert.equal(screen.getByTestId('email-subject').textContent, 'Refreshed email');
  await settle(HOME_EMAIL_STALE_FOLLOW_UP_MS + 80);
  assert.equal(calls.length, 3, 'polling must stop once the cache becomes fresh');

  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(calls.length, 4);
  await settle(HOME_EMAIL_STALE_FOLLOW_UP_MS + 80);
  assert.equal(calls.length, 5, 'a new token may schedule a follow-up on a later natural refresh');
  assert.equal(calls[4]?.searchParams.get('widgets'), 'emails');

  document.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(calls.length, 6);
  await settle(HOME_EMAIL_STALE_FOLLOW_UP_MS + 80);
  assert.equal(calls.length, 7, 'a completed token may be followed again after a new provider refresh is queued');

  fireEvent.click(screen.getByRole('button', { name: 'Retry todos' }));
  await settle();
  assert.equal(calls.at(-1)?.searchParams.get('widgets'), 'todos');
  assert.equal(calls.at(-1)?.searchParams.get('refresh'), 'todos');
  assert.equal(screen.getByTestId('todo-title').textContent, 'Retried todo');
  cleanup();

  const failureCalls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    failureCalls.push(url);
    if (url.searchParams.get('widgets') === 'emails') return Response.json({ success: false }, { status: 503 });
    return success({ emails: emailResult('failure-token', 'Preserved cached email'), ...otherWidgets });
  };
  screen = render(<Probe workspaceId="workspace-failure" />);
  await settle();
  await settle(HOME_EMAIL_STALE_FOLLOW_UP_MS + 80);
  assert.equal(failureCalls.length, 2);
  assert.equal(screen.getByTestId('email-status').textContent, 'ready');
  assert.equal(screen.getByTestId('email-subject').textContent, 'Preserved cached email');
  await settle(HOME_EMAIL_STALE_FOLLOW_UP_MS + 80);
  assert.equal(failureCalls.length, 2, 'a failed follow-up must remain bounded');
  cleanup();

  const unmountCalls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    unmountCalls.push(url);
    return success({ emails: emailResult('unmount-token', 'Unmounted email'), ...otherWidgets });
  };
  render(<Probe workspaceId="workspace-unmount" />);
  await settle();
  cleanup();
  await settle(HOME_EMAIL_STALE_FOLLOW_UP_MS + 80);
  assert.equal(unmountCalls.length, 1, 'unmount must cancel the pending follow-up timer');

  let releaseOld!: () => void;
  const oldResponse = new Promise<void>((resolve) => { releaseOld = resolve; });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    const requestedWorkspace = url.searchParams.get('workspaceId');
    if (requestedWorkspace === 'old') {
      await oldResponse;
      return success({ emails: emailResult('old-token', 'Old email', false), ...otherWidgets });
    }
    return success({ emails: emailResult('new-token', 'New email', false), ...otherWidgets });
  };
  screen = render(<Probe workspaceId="old" />);
  screen.rerender(<Probe workspaceId="new" />);
  await settle();
  assert.equal(screen.getByTestId('email-subject').textContent, 'New email');
  await act(async () => { releaseOld(); await oldResponse; });
  assert.equal(screen.getByTestId('email-subject').textContent, 'New email', 'a late workspace response must not replace current data');
  cleanup();

  console.log('home-workspace-widgets-hook-test: ok');
}

void main();
