import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { EmailChatProvider, useEmailChatContext } from '../app/apps/email/context/email-chat-context';
import type { ChatRequestContext } from '../app/lib/chat/types';
import type { NotebookEmailContextIntent } from '../app/lib/notebook/context-surface';
import type { EmailClassificationFeed } from '../app/lib/email/classification/feed-types';
import translations from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/notebook', pretendToBeVisual: true });
for (const name of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'HTMLSelectElement', 'Element', 'Node', 'DOMParser', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
Object.defineProperty(globalThis, 'ResizeObserver', {
  value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true,
});
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON() {},
});

type ListRequest = { accountId: string; folder: string; query: string; offset: number };
const listRequests: ListRequest[] = [];
const feedRequests: URL[] = [];
const preferenceWrites: string[] = [];
const unexpectedRequests: string[] = [];
let holdNextListResponse = false;
let releaseListResponse: (() => void) | null = null;
let chatContext: ChatRequestContext | null = null;
function ChatContextProbe() {
  const { chatContext: context } = useEmailChatContext();
  useEffect(() => { chatContext = context; }, [context]);
  return null;
}
const accounts = ['account-a', 'account-b'].map((id, index) => ({
  id, provider: 'gmail', authType: 'oauth', emailAddress: `${id}@example.com`,
  displayName: id, isPrimary: index === 0, status: 'active', imapHost: null,
  accountScope: 'personal' as const, workspaceId: null, mailboxId: null, workspaceName: null, connectionState: 'ready' as const,
  capabilities: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManage: true },
  policy: { readFrom: [], sendTo: [] },
}));
const sources = accounts.map((account, index) => ({ mailboxRef: `emb:${(index === 0 ? 'a' : 'b').repeat(64)}`,
  accountSource: 'local' as const, accountId: account.id, workspaceId: null, mailboxId: null,
  emailAddress: account.emailAddress, displayName: account.displayName, workspaceName: null, capabilities: account.capabilities }));
const fixtureUserId = 'email-context-fixture-user';
let preferenceMode: string | null = null;
const folders = ['INBOX', 'Archive'].map((name) => ({
  id: name, name, path: name, role: name === 'INBOX' ? 'inbox' : 'archive',
  messageCount: 1, unseenCount: 0,
}));

globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), 'http://localhost');
  const path = url.pathname;
  let data: unknown;
  if (path === '/api/auth/get-session') return Response.json({
    user: { id: fixtureUserId, name: 'Context fixture', email: 'context-fixture@example.test', emailVerified: true,
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', role: 'user' },
    session: { id: 'context-test-session', token: 'synthetic-context-test-token', userId: fixtureUserId,
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' },
  });
  if (path === '/api/workspaces') return Response.json({ success: true, workspaces: [] });
  if (path === '/api/email/mailboxes') data = { accounts, setup: { canManageBusiness: false, manageableWorkspaces: [] } };
  else if (path === '/api/email/classification/availability') data = { enabled: true, available: true, revision: 1, defaultMode: 'focus', reason: null };
  else if (path === '/api/email/classification/mailboxes') data = { mailboxes: sources };
  else if (path === '/api/email/classification/feed') {
    feedRequests.push(url);
    const mode = url.searchParams.get('mode') === 'classic' ? 'classic' : 'focus';
    const feed: EmailClassificationFeed = { mode, requestedMode: mode, view: mode === 'classic' ? 'all' : 'focus',
      scope: url.searchParams.get('scope') === 'mailbox' ? { kind: 'mailbox', mailboxRef: url.searchParams.get('mailboxRef')! } : { kind: 'all' },
      items: [], nextCursor: null, snapshot: { id: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 600_000 },
      counts: { total: 0, groups: { important: 0, reply: 0, review: 0, pending: 0, other: 0, spam: 0, done: 0 }, categories: {} },
      coverage: sources.map(source => ({ mailboxRef: source.mailboxRef, state: 'complete', indexed: 0, pending: 0, failed: 0, stale: 0, lastSyncAt: Date.now() })),
      limits: { initialLookbackDays: 30, maxHistoricalMessages: 5_000 }, hasUpdates: false };
    data = feed;
  }
  else if (path === '/api/user-preferences') {
    if (init?.method === 'PATCH') {
      const update = JSON.parse(String(init.body)) as { emailExperienceMode?: string };
      if (update.emailExperienceMode) { preferenceMode = update.emailExperienceMode; preferenceWrites.push(preferenceMode); }
    }
    data = { emailExperienceMode: preferenceMode };
  }
  else if (path === '/api/email/outbox') data = [];
  else if (path === '/api/email/folders') data = { folders };
  else if (/^\/api\/email\/accounts\/[^/]+\/messages\/message-a$/u.test(path)) {
    data = { message: {
      id: 'message-a', folder: url.searchParams.get('folder'),
      from: 'sender@example.com', subject: 'Test message', date: '2026-09-09T10:00:00Z',
      body: 'Persistent reader body', isRead: true, attachments: [],
    } };
  }
  else if (path === '/api/email/messages/list') {
    const request = JSON.parse(String(init?.body)) as ListRequest;
    listRequests.push(request);
    data = { messages: [{
      id: 'message-a', folder: request.folder, from: 'sender@example.com',
      subject: `Result for ${request.query}`, snippet: 'Test message', date: '2026-09-09T10:00:00Z', isRead: true,
    }], total: 45 };
    if (holdNextListResponse) {
      holdNextListResponse = false;
      await new Promise<void>((resolve) => { releaseListResponse = resolve; });
    }
  } else {
    unexpectedRequests.push(url.toString());
    throw new Error(`Unexpected test request: ${url}`);
  }
  return Response.json({ success: true, data });
}) as typeof fetch;

async function main() {
  // Load the DOM renderer after installing JSDOM so real input events work.
  const { createRoot } = await import('react-dom/client');
  const { SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { EmailClient } = await import('../app/apps/email/components/EmailClient');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const searchParams = new URLSearchParams();
  async function flush() {
    for (let index = 0; index < 8; index++) {
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    }
  }
  async function render(intent: NotebookEmailContextIntent | null, embedded = true) {
    await act(async () => root.render(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={translations}>
        <SearchParamsContext.Provider value={searchParams}>
          <EmailChatProvider>
            <EmailClient contextIntent={intent} embedded={embedded} />
            <ChatContextProbe />
          </EmailChatProvider>
        </SearchParamsContext.Provider>
      </NextIntlClientProvider>,
    ));
    await flush();
  }
  function searchInput() {
    const input = container.querySelector<HTMLInputElement>(`input[placeholder="${translations.emails.searchPlaceholder}"]`);
    assert.ok(input, 'the real email search input must be rendered');
    return input;
  }
  async function typeQuery(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(searchInput(), value);
      searchInput().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.equal(searchInput().value, value, 'typing must update the controlled input');
  }
  async function submitSearch() {
    await act(async () => searchInput().closest('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
  }
  async function clickButton(label: string) {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    assert.ok(button && !button.disabled, `button ${label} must be available`);
    await act(async () => button.click());
    await flush();
  }
  const intent: NotebookEmailContextIntent = {
    kind: 'email', toolCallId: 'search-a', toolName: 'email_search_messages', status: 'running',
    accountId: 'account-a', folder: 'Archive', query: 'agent query',
  };
  try {
    await render(null);
    const focusButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === translations.emailFocus.focus);
    assert.equal(focusButton?.getAttribute('aria-pressed'), 'true', 'classification enabled starts in Focus when no user override is saved');
    assert.equal(feedRequests.at(-1)?.searchParams.get('mode'), 'focus');
    assert.equal(feedRequests.at(-1)?.searchParams.get('scope'), 'all');
    const scopeSelect = container.querySelector<HTMLSelectElement>('#email-focus-scope');
    assert.ok(scopeSelect);
    await act(async () => {
      scopeSelect.value = `mailbox:${sources[1].mailboxRef}`;
      scopeSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await flush();
    assert.equal(feedRequests.at(-1)?.searchParams.get('mailboxRef'), sources[1].mailboxRef, 'start the tool search from the previous single B Focus scope');
    await render(intent);
    assert.equal(container.querySelector<HTMLSelectElement>('#email-focus-scope')?.value, `mailbox:${sources[0].mailboxRef}`, 'tool search selects actual A rather than retaining old single B');
    assert.equal(preferenceWrites.at(-1), 'classic', 'tool search intentionally opens the existing single mailbox search');
    assert.equal(listRequests.at(-1)?.accountId, 'account-a');
    assert.equal(listRequests.at(-1)?.folder, 'Archive', 'switching to Classic must preserve the intent Archive folder');
    assert.equal(searchInput().value, 'agent query');
    assert.equal(listRequests.at(-1)?.query, 'agent query');
    await typeQuery('user query');
    await render({ ...intent, status: 'complete', view: 'message-list' });
    assert.equal(searchInput().value, 'user query', 'completion must not replay the agent query');
    await submitSearch();
    assert.equal(listRequests.at(-1)?.query, 'user query', 'manual submission must search for the user query');
    assert.equal(searchInput().value, 'user query', 'new results must not replay the agent query');
    assert.equal(chatContext?.emailContext?.query, 'user query', 'chat must receive the submitted user query');
    await clickButton(translations.emails.nextPage);
    assert.equal(listRequests.at(-1)?.offset, 20, 'new results must not reset pagination');
    await typeQuery('unsent edit');
    await clickButton(translations.emails.refresh);
    assert.equal(searchInput().value, 'unsent edit', 'background refresh must preserve unsent input');
    assert.equal(listRequests.at(-1)?.query, 'user query', 'refresh must use the submitted query');
    const messageButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Result for user query'));
    assert.ok(messageButton);
    await act(async () => messageButton.click());
    await flush();
    assert.ok(container.textContent?.includes('Persistent reader body'), 'opening a search result must keep the reader open');
    await render({ ...intent, status: 'complete', view: 'message-list' });
    assert.ok(container.textContent?.includes('Persistent reader body'), 'repeated tool events must not clear the reader');
    await typeQuery('');
    await submitSearch();
    assert.equal(listRequests.at(-1)?.query, '', 'the user must be able to clear the search');
    assert.equal(searchInput().value, '');
    assert.equal(chatContext?.emailContext?.query, undefined);

    const nextIntent = { ...intent, toolCallId: 'search-b' };
    await render(nextIntent);
    assert.equal(searchInput().value, 'agent query', 'a new tool call may apply even the same query again');
    assert.equal(listRequests.at(-1)?.offset, 0);
    holdNextListResponse = true;
    await typeQuery('submitted while loading');
    await submitSearch();
    assert.ok(releaseListResponse, 'the search response must be pending');
    await typeQuery('new edit while loading');
    await act(async () => { releaseListResponse!(); });
    releaseListResponse = null;
    await flush();
    assert.equal(searchInput().value, 'new edit while loading', 'a late response must preserve newer input');

    const unresolvedIntent = { ...intent, toolCallId: 'search-c', accountId: undefined, folder: undefined, mailboxId: 'mailbox-b' };
    await render(unresolvedIntent);
    await typeQuery('my mailbox search');
    await submitSearch();
    await render({ ...unresolvedIntent, status: 'complete', view: 'message-list', accountId: 'account-b', folder: 'Archive' });
    assert.equal(searchInput().value, 'my mailbox search', 'resolved mailbox metadata must not replay the same tool search');
    assert.equal(listRequests.at(-1)?.query, 'my mailbox search');
    assert.equal(listRequests.at(-1)?.accountId, 'account-b', 'late mailbox resolution must still navigate to the right account');
    assert.equal(listRequests.at(-1)?.folder, 'Archive');
    assert.equal(chatContext?.emailContext?.query, 'my mailbox search');

    await render(null);
    await render(intent);
    assert.equal(searchInput().value, 'agent query', 'clearing context must reset the consumed tool identity');
    await render(null, false);
    await typeQuery('standalone search');
    await submitSearch();
    await clickButton(translations.emails.refresh);
    assert.equal(searchInput().value, 'standalone search', 'standalone email search must stay editable');
    assert.equal(listRequests.at(-1)?.query, 'standalone search');
    await render({ kind: 'email', toolCallId: null, toolName: 'email_read', status: 'complete', accountId: 'account-a', folder: 'INBOX', messageId: 'message-a' }, false);
    assert.ok(container.textContent?.includes('Persistent reader body'), 'standalone message deep links must still open their target');
    assert.deepEqual(unexpectedRequests, [], 'all component requests must be covered by the fixtures');
    console.log('email-client-context-intent-test: ok');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => dom.window.close());
