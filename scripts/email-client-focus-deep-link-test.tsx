import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { EmailChatProvider } from '../app/apps/email/context/email-chat-context';
import type { NotebookEmailContextIntent } from '../app/lib/notebook/context-surface';
import type { EmailClassificationFeed, EmailClassificationFeedItem } from '../app/lib/email/classification/feed-types';
import { emailOriginSelectionKey } from '../app/lib/email/classification/mailbox-types';
import { emailFocusIntentFromSearchParams } from '../app/apps/email/components/email-focus-deep-link';
import translations from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/emails', pretendToBeVisual: true });
for (const name of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'Text', 'Range', 'DOMParser', 'Event', 'KeyboardEvent', 'FocusEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON() {} });
dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
const normalSetTimeout = window.setTimeout.bind(window);
const normalClearTimeout = window.clearTimeout.bind(window);
const deadlines = new Map<number, () => void>();
let nextDeadline = -1;
window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
  if (delay !== 30_000 || typeof callback !== 'function') return normalSetTimeout(callback, delay, ...args);
  const id = nextDeadline--;
  deadlines.set(id, () => callback(...args));
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = (id: number | string | NodeJS.Timeout | undefined) => { if (typeof id === 'number' && deadlines.delete(id)) return; normalClearTimeout(id); };

let userId = 'focus-link-user';
let sessionId = 'focus-link-session';
let savedMode = 'classic';
const preferenceWrites: unknown[] = [];
const providerReads: URL[] = [];
const referenceReads: string[] = [];
const feedReads: URL[] = [];
const unexpected: string[] = [];
const capability = { canRead: true, canWrite: true, canManage: true, canDelete: true, canRunAgent: true };
const accounts = ['a', 'b', 'work'].map((label, index) => ({ id: `account-${label}`, provider: 'imap', authType: 'smtp_imap',
  emailAddress: `${label}@example.test`, displayName: label, isPrimary: index === 0, status: 'active', imapHost: 'localhost',
  accountScope: label === 'work' ? 'workspace' : 'personal', workspaceId: label === 'work' ? 'workspace-work' : null,
  mailboxId: label === 'work' ? 'work-mailbox' : null, workspaceName: label === 'work' ? 'Test work' : null, connectionState: 'ready',
  capabilities: label === 'work' ? { ...capability, canWrite: false, canManage: false, canDelete: false } : capability, policy: { readFrom: [], sendTo: [] } }));
const sources = accounts.map((account, index) => ({ mailboxRef: `emb:${String(index + 1).repeat(64)}`, accountSource: 'local', accountId: account.id,
  workspaceId: account.workspaceId, mailboxId: account.mailboxId, workspaceName: account.workspaceName, displayName: account.displayName,
  emailAddress: account.emailAddress, capabilities: account.capabilities }));
function item(index: number, refCharacter: string): EmailClassificationFeedItem {
  const account = accounts[index]; const source = sources[index];
  const origin = { ...source, accountSource: 'local' as const, accountScope: account.workspaceId ? 'workspace' as const : 'personal' as const,
    accountOwnerId: account.workspaceId ? 'fixture-system-owner' : 'focus-link-user', accountId: account.id, folder: 'INBOX', canonicalId: 'uid-1' };
  return { messageRef: `emm:${refCharacter.repeat(64)}`, selectionKey: emailOriginSelectionKey(origin), origin,
    message: { from: 'customer@example.test', subject: `${account.displayName} unique subject`, date: '2026-10-06T12:00:00Z', snippet: '', isRead: true },
    classification: { category: 'correspondence', priority: 'high', spamProbability: 0.01, replyProbability: 0.99, isSpam: false,
      needsReply: true, states: { category: 'ready', priority: 'ready', spam: 'ready', reply: 'ready' }, status: 'ready',
      replyStatus: 'unanswered', group: 'important', overrides: {}, personallyDone: false, version: 1, evaluatedAt: 1, bodyWasTruncated: false },
    personalFocus: { done: false, version: 0 } };
}
const personal = item(1, 'a');
const work = item(2, 'b');
let heldRef: string | null = null;
let heldSignal: AbortSignal | null = null;
let releaseHeld: (() => void) | null = null;

globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), 'http://localhost');
  const path = url.pathname;
  let data: unknown;
  if (path === '/api/auth/get-session') return Response.json({ user: { id: userId, role: 'user', name: 'Fixture', email: 'fixture@example.test', emailVerified: true,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }, session: { id: sessionId, userId, token: 'synthetic-session',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' } });
  if (path === '/api/workspaces') return Response.json({ success: true, workspaces: [] });
  if (path === '/api/email/mailboxes') data = { accounts, setup: { canManageBusiness: false, manageableWorkspaces: [] } };
  else if (path === '/api/email/classification/mailboxes') data = { mailboxes: sources };
  else if (path === '/api/email/classification/availability') data = { enabled: true, available: true, revision: 1, defaultMode: 'focus', reason: null };
  else if (path === '/api/user-preferences') {
    if (init?.method === 'PATCH') { const patch = JSON.parse(String(init.body)); preferenceWrites.push(patch); savedMode = patch.emailExperienceMode ?? savedMode; }
    data = { emailExperienceMode: savedMode };
  } else if (path === '/api/email/classification/feed') {
    feedReads.push(url);
    const mode = url.searchParams.get('mode') === 'classic' ? 'classic' : 'focus';
    const view = url.searchParams.get('view') as EmailClassificationFeed['view'];
    const feed: EmailClassificationFeed = { mode, requestedMode: mode, view, scope: { kind: url.searchParams.get('scope') as 'all' | 'personal' | 'work' },
      // The requested B and Work references are deliberately outside this first 50.
      items: Array.from({ length: 50 }, (_, index) => ({ ...item(0, 'c'), selectionKey: `list-${index}`, messageRef: `list-${index}`, message: { ...item(0, 'c').message, subject: `First-page ${index}` } })),
      nextCursor: null, snapshot: { id: '11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 600_000 }, hasUpdates: false,
      counts: { total: 52, groups: { important: 52, reply: 0, review: 0, pending: 0, other: 0, spam: 0, done: 0 }, categories: {} },
      coverage: [], limits: { initialLookbackDays: 30, maxHistoricalMessages: 5000 } };
    data = feed;
  } else if (path === '/api/email/classification/message') {
    const ref = url.searchParams.get('messageRef')!;
    referenceReads.push(ref);
    if (ref === heldRef) {
      heldRef = null;
      heldSignal = init?.signal as AbortSignal;
      await new Promise<void>(resolve => { releaseHeld = resolve; }); // Deliberately ignore abort to verify the fence.
    } else if (userId !== 'focus-link-user') return Response.json({ success: false, error: 'unsafe server diagnostic' }, { status: 404 });
    if (ref === `emm:${'d'.repeat(64)}`) return Response.json({ success: false, error: 'unsafe server diagnostic' }, { status: 404 });
    data = { ...(ref === personal.messageRef ? personal : work), assessment: null };
    if (ref === `emm:${'e'.repeat(64)}`) data = { ...work, messageRef: ref, selectionKey: 'untrusted mismatch' };
  } else if (path === '/api/email/folders') data = { folders: [{ id: 'INBOX', path: 'INBOX', name: 'Inbox', role: 'inbox', selectable: true }] };
  else if (path === '/api/email/outbox' || /^\/api\/workspaces\/[^/]+\/email\/outbox$/u.test(path)) data = [];
  else if (path === '/api/email/messages/list') data = { messages: [], total: 0, hasMore: false };
  else if (/^\/api\/email\/accounts\/[^/]+\/messages\/uid-1$/u.test(path)) {
    providerReads.push(url);
    const isWork = path.includes('/account-work/');
    const isPersonalB = path.includes('/account-b/');
    data = { message: { id: 'uid-1', folder: 'INBOX', from: 'customer@example.test', to: [isWork ? accounts[2].emailAddress : accounts[1].emailAddress],
      subject: isWork ? work.message.subject : isPersonalB ? personal.message.subject : 'First-page 0',
      body: isWork ? 'Authorized work source body' : isPersonalB ? 'Authorized personal B source body' : 'Authorized personal A source body', isRead: true, attachments: [] } };
  } else { unexpected.push(path); throw new Error(`Unexpected fixture request: ${path}`); }
  return Response.json({ success: true, data });
}) as typeof fetch;

async function main() {
  const { createRoot } = await import('react-dom/client');
  const { SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { EmailClient } = await import('../app/apps/email/components/EmailClient');
  const { authClient } = await import('../app/lib/auth-client');
  let refetchSession: (() => Promise<unknown>) | undefined;
  function SessionProbe() {
    const session = authClient.useSession();
    useEffect(() => { refetchSession = session.refetch; }, [session.refetch]);
    return null;
  }
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  const flush = async () => { for (let index = 0; index < 12; index++) await act(async () => { await new Promise(resolve => normalSetTimeout(resolve, 0)); }); };
  async function render(intent: NotebookEmailContextIntent | null) {
    await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={translations}>
      <SearchParamsContext.Provider value={new URLSearchParams()}><EmailChatProvider><EmailClient contextIntent={intent} /><SessionProbe /></EmailChatProvider></SearchParamsContext.Provider>
    </NextIntlClientProvider>)); await flush();
  }
  const home = (ref: string): NotebookEmailContextIntent => ({ kind: 'email', toolCallId: null, toolName: 'email_focus_link', status: 'complete',
    messageRef: ref, experienceMode: 'focus', feedScope: 'all', feedView: 'focus', accountId: 'account-a' });
  const contains = (text: string) => container.textContent?.includes(text);
  function modeButton(mode: 'focus' | 'classic') {
    const header = container.querySelector('[data-testid="email-focus-header"]');
    const button = [...header!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === translations.emailFocus[mode]);
    assert.ok(button); return button;
  }
  async function clickText(text: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text);
    assert.ok(button, `fixture control ${text} must exist`); await act(async () => button.click()); await flush();
  }
  try {
    const parsed = emailFocusIntentFromSearchParams({ messageRef: work.messageRef, mode: 'focus', scope: 'all', view: 'review', accountId: 'invented' })!;
    assert.equal(parsed.messageRef, work.messageRef); assert.equal(parsed.feedView, 'review'); assert.equal(parsed.accountId, undefined);
    assert.equal(parsed.scope, undefined, 'feed scope must stay separate from legacy workspace scope');
    assert.equal(emailFocusIntentFromSearchParams({ messageRef: ['bad', work.messageRef] })?.messageRef, '', 'ambiguous references must safely fail rather than fall through to a legacy ID');
    await render(home(work.messageRef));
    assert.equal(modeButton('focus').getAttribute('aria-pressed'), 'true');
    assert.equal(savedMode, 'classic'); assert.equal(preferenceWrites.length, 0, 'Home navigation cannot PATCH the saved Classic choice');
    assert.ok(contains('Authorized work source body'), 'resolve an authorized Work origin outside the first 50 rows');
    assert.equal(providerReads.at(-1)?.pathname, '/api/email/accounts/account-work/messages/uid-1');
    assert.equal(providerReads.at(-1)?.searchParams.get('mailboxWorkspaceId'), 'workspace-work');
    const firstCount = referenceReads.length;
    await render({ ...home(work.messageRef), status: 'running' });
    assert.equal(referenceReads.length, firstCount, 'repeated status events must not reapply the same durable reference');
    await render(home(personal.messageRef));
    assert.ok(contains('Authorized personal B source body')); assert.ok(!contains('Authorized work source body'));
    assert.equal(providerReads.at(-1)?.pathname, '/api/email/accounts/account-b/messages/uid-1', 'the same UID uses its full authorized origin');
    assert.equal(providerReads.at(-1)?.searchParams.get('mailboxWorkspaceId'), null);
    await render({ ...home(personal.messageRef), messageRef: undefined, feedView: 'review', feedScope: 'work' });
    assert.equal(feedReads.at(-1)?.searchParams.get('view'), 'review'); assert.equal(feedReads.at(-1)?.searchParams.get('scope'), 'work');
    assert.ok(!contains('Authorized personal B source body'), 'a group link clears the previous reader');
    assert.equal(preferenceWrites.length, 0);

    heldRef = work.messageRef;
    await render(home(work.messageRef)); assert.ok(releaseHeld);
    const beforeLate = providerReads.length;
    await render(home(personal.messageRef));
    await act(async () => releaseHeld!()); releaseHeld = null; await flush();
    assert.ok(heldSignal?.aborted); assert.ok(contains('Authorized personal B source body'));
    assert.equal(providerReads.length, beforeLate + 1, 'the obsolete authorization response cannot read the old Work source');
    for (const ref of ['invalid-ref', `emm:${'d'.repeat(64)}`, `emm:${'e'.repeat(64)}`]) {
      const before = providerReads.length; await render(home(ref));
      assert.equal(providerReads.length, before); assert.ok(!contains('Authorized personal B source body'));
      assert.ok(contains(translations.emailFocus.selectionError)); assert.ok(!contains('unsafe server diagnostic'));
    }
    for (const navigation of ['scope', 'view', 'category', 'search', 'mode']) {
      heldRef = work.messageRef;
      await render({ ...home(work.messageRef), toolCallId: `navigation-${navigation}` }); assert.ok(releaseHeld);
      const staleDeadline = [...deadlines.values()][0]; assert.ok(staleDeadline);
      const beforeNavigation = providerReads.length;
      await act(async () => {
        if (navigation === 'scope') {
          const select = container.querySelector<HTMLSelectElement>('#email-focus-scope')!;
          select.value = 'personal'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        } else if (navigation === 'view' || navigation === 'category') {
          const label = navigation === 'view' ? `${translations.emailFocus.views.review}: 0` : `${translations.emailFocus.categories.finance}: 0`;
          const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`); assert.ok(button); button.click();
        } else if (navigation === 'search') {
          const input = container.querySelector<HTMLInputElement>('#email-focus-search')!;
          Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'new user search');
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        } else modeButton('classic').click();
      }); await flush();
      assert.ok(heldSignal?.aborted, `${navigation} consumes and immediately aborts the pending external reference`);
      await act(async () => { staleDeadline(); releaseHeld!(); }); releaseHeld = null; await flush();
      assert.equal(providerReads.length, beforeNavigation, `${navigation} must fence a late reference even when fetch ignores abort`);
      assert.ok(!contains(translations.emailFocus.selectionError), `${navigation} must fence the old timeout as well`);
      assert.ok(!contains('Authorized work source body'));
    }
    const manualRowIntent = { ...home(work.messageRef), toolCallId: 'manual-row-race' };
    heldRef = work.messageRef; await render(manualRowIntent); assert.ok(releaseHeld);
    const oldManualDeadline = [...deadlines.values()][0]; assert.ok(oldManualDeadline);
    const referenceCountBeforeRow = referenceReads.length;
    const row = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="email-focus-row"]')]
      .find(button => button.textContent?.includes('First-page 0')); assert.ok(row);
    await act(async () => row.click()); await flush();
    assert.ok(heldSignal?.aborted); assert.ok(contains('Authorized personal A source body'));
    const providerCountAfterRow = providerReads.length;
    await render({ ...manualRowIntent, status: 'running' });
    assert.equal(referenceReads.length, referenceCountBeforeRow, 'a cosmetic same-key event cannot restart a consumed external reference');
    await act(async () => { oldManualDeadline(); releaseHeld!(); }); releaseHeld = null; await flush();
    assert.equal(providerReads.length, providerCountAfterRow);
    assert.ok(contains('Authorized personal A source body')); assert.ok(!contains('Authorized work source body'));
    assert.ok(!contains(translations.emailFocus.selectionError));
    heldRef = work.messageRef; await render(home(work.messageRef)); assert.ok(releaseHeld);
    assert.equal(deadlines.size, 1, 'a hanging reference resolution owns one bounded 30-second deadline');
    await act(async () => { for (const expire of deadlines.values()) expire(); }); await flush();
    assert.ok(heldSignal?.aborted); assert.ok(contains(translations.emailFocus.selectionError));
    const beforeTimeout = providerReads.length;
    await act(async () => releaseHeld!()); releaseHeld = null; await flush();
    assert.equal(providerReads.length, beforeTimeout, 'a successful response after its deadline cannot reopen the reader');
    await render(null); assert.equal(modeButton('classic').getAttribute('aria-pressed'), 'true', 'leaving the intent restores the unchanged saved mode');

    await clickText(translations.emailFocus.compose);
    const sender = document.querySelector<HTMLSelectElement>('select[aria-label="Sender mailbox"]'); assert.ok(sender);
    await act(async () => { sender.value = 'account-b'; sender.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    await clickText(translations.emailFocus.composeWithSender);
    const composeSubject = document.querySelector<HTMLInputElement>('#email-compose-subject'); assert.ok(composeSubject);
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(composeSubject, 'Pinned Home navigation draft');
      composeSubject.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await render(home(work.messageRef));
    assert.ok(contains('Authorized work source body')); assert.ok(contains(translations.emailFocus.resumeDraft));
    await clickText(translations.emailFocus.resumeDraft);
    assert.equal(document.querySelector<HTMLInputElement>('#email-compose-subject')?.value, 'Pinned Home navigation draft');
    assert.ok(document.querySelector('[role="dialog"]')?.textContent?.includes(accounts[1].emailAddress), 'the resumed composer retains its actual personal sender');

    heldRef = personal.messageRef; await render(home(personal.messageRef)); assert.ok(releaseHeld);
    const beforeSession = providerReads.length;
    userId = 'new-user'; sessionId = 'new-session';
    await act(async () => { await refetchSession!(); }); await flush();
    await act(async () => releaseHeld!()); releaseHeld = null; await flush();
    assert.ok(heldSignal?.aborted); assert.equal(providerReads.length, beforeSession, 'logout/session replacement fences a late old-user reference');
    assert.ok(!contains('Authorized personal B source body'));
    assert.deepEqual(unexpected, []);
    console.log('email-client-focus-deep-link-test: ok');
  } finally { if (releaseHeld) await act(async () => releaseHeld!()); await act(async () => root.unmount()); dom.window.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
