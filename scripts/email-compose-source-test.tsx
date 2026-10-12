import assert from 'node:assert/strict';
import Module from 'node:module';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import type { EmailAccount, EmailComposeDraft, EmailMessageDetail } from '../app/apps/email/components/email-client-types';
import type { EmailAttachmentDraft } from '../app/lib/email/attachment-types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DOMParser', 'CustomEvent', 'Event'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

const loader = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = loader._load;
const translations = new Map<string, (key: string) => string>();
const reviews: Array<{ target: unknown; options: unknown }> = [];
loader._load = (request, parent, isMain) => {
  if (request === 'next-intl') return { useTranslations(namespace: string) {
    if (!translations.has(namespace)) translations.set(namespace, key => `${namespace}.${key}`);
    return translations.get(namespace);
  } };
  if (request === '@/app/store/email-review-store') return { openEmailReview: async (target: unknown, options: unknown) => { reviews.push({ target, options }); return true; } };
  return originalLoad(request, parent, isMain);
};

const canUse = { canRead: true, canWrite: true, canManage: true, canDelete: true, canRunAgent: true };
function account(workspaceId: string | null, overrides: Partial<EmailAccount> = {}): EmailAccount {
  return { id: 'shared-id', accountScope: workspaceId ? 'workspace' : 'personal', workspaceId, mailboxId: workspaceId ? 'mailbox' : null,
    emailAddress: `${workspaceId || 'personal'}@example.test`, displayName: workspaceId, provider: 'imap', authType: 'password',
    imapHost: 'localhost', status: 'active', connectionState: 'ready', isPrimary: true,
    capabilities: { ...canUse }, policy: { readFrom: [], sendTo: [] }, ...overrides };
}
const a = account('workspace-a');
const b = account('workspace-b');
const personal = account(null);
const message: EmailMessageDetail = { id: 'colliding-message-id', from: 'customer@example.test', subject: 'Original subject',
  date: '2026-10-06T12:00:00Z', folder: 'INBOX', snippet: 'Question', body: 'Original body' };

function stream(body: string) {
  return new Response(`data: ${JSON.stringify({ type: 'delta', delta: body })}\n\ndata: ${JSON.stringify({ type: 'done', body })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function main() {
  const { renderHook, cleanup } = await import('@testing-library/react');
  const { useEmailComposeController } = await import('../app/apps/email/components/useEmailComposeController');
  type Options = Parameters<typeof useEmailComposeController>[0];
  const noop = () => {};
  function options(overrides: Partial<Options> = {}): Options {
    return { ownerUserId: 'owner', accounts: [a, b, personal], activeAccount: a, activeFolder: 'INBOX',
      activeWorkspaceId: 'files-a', mailboxWorkspaceId: 'workspace-a', contextIntent: null,
      onAccessChanged: async () => {}, onError: noop, onMessageActionNotice: noop, onMessageDialogOpenChange: noop, ...overrides };
  }
  const calls: Array<{ url: string; body: Record<string, unknown>; signal?: AbortSignal | null }> = [];
  let response: () => Promise<Response> = async () => Response.json({ success: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')), signal: init?.signal });
    return response();
  };
  function fixture(initial = options()) {
    const hook = renderHook(props => useEmailComposeController(props), { initialProps: initial });
    const change = (updates: Partial<Options>) => { initial = { ...initial, ...updates }; hook.rerender(initial); };
    return { ...hook, change };
  }
  async function createDraft(hook: ReturnType<typeof fixture>) {
    act(() => hook.result.current.openNewDraft());
    act(() => hook.result.current.updateDraft({ subject: 'Keep this subject', body: 'Keep this body', bodyHtml: '<p>Keep this body</p>',
      toText: 'recipient@example.test', aiMode: 'quick', aiPrompt: 'Improve this reply' }));
  }
  try {
    // Reply routing is consistent with server-derived drafts and preserves explicit edits.
    const replyMessage: EmailMessageDetail = { ...message, from: 'notifications@example.test',
      replyTo: ['"Support, Team" <support@example.test> (Support inbox)', 'backup@example.test (Backup)'],
      to: [a.emailAddress.toUpperCase(), b.emailAddress, 'support@example.test', 'colleague@example.test'],
      cc: ['colleague@example.test', 'manager@example.test', 'backup@example.test', personal.emailAddress] };
    const replyDestinations = fixture();
    act(() => { replyDestinations.result.current.openDraft('reply', replyMessage); });
    assert.equal(replyDestinations.result.current.draft?.toText, 'support@example.test, backup@example.test');
    assert.equal(replyDestinations.result.current.draft?.ccText, '');
    act(() => { replyDestinations.result.current.updateDraft({ toText: 'selected@example.test' }); });
    assert.equal(replyDestinations.result.current.draft?.toText, 'selected@example.test');
    act(() => { replyDestinations.result.current.close(); });
    act(() => { replyDestinations.result.current.openDraft('reply-all', replyMessage); });
    assert.equal(replyDestinations.result.current.draft?.toText, 'support@example.test, backup@example.test, workspace-b@example.test, colleague@example.test', 'a different readable shared mailbox remains a participant while selected sender and personal aliases are excluded');
    assert.equal(replyDestinations.result.current.draft?.ccText, 'manager@example.test');
    act(() => { replyDestinations.result.current.close(); });
    act(() => { replyDestinations.result.current.openDraft('reply', { ...replyMessage, replyTo: ['invalid'] }); });
    assert.equal(replyDestinations.result.current.draft?.toText, 'notifications@example.test');
    act(() => { replyDestinations.result.current.close(); });
    act(() => { replyDestinations.result.current.openDraft('reply', { ...replyMessage, from: a.emailAddress, replyTo: undefined }); });
    assert.equal(replyDestinations.result.current.draft?.toText, 'workspace-b@example.test, support@example.test, colleague@example.test');
    act(() => { replyDestinations.result.current.close(); });
    act(() => { replyDestinations.result.current.openDraft('forward', replyMessage); });
    assert.equal(replyDestinations.result.current.draft?.toText, '');
    assert.equal(replyDestinations.result.current.draft?.ccText, '');
    replyDestinations.unmount();

    // Same account IDs are distinct sources. Selecting B while composing A preserves A.
    const first = fixture(); await createDraft(first);
    act(() => first.result.current.minimize());
    first.change({ activeAccount: b, mailboxWorkspaceId: 'workspace-b', activeFolder: 'Other' });
    assert.equal(first.result.current.composeMinimized, true);
    assert.equal(first.result.current.draftSenderAddress, a.emailAddress);
    assert.equal(first.result.current.draftMailboxWorkspaceId, 'workspace-a');
    assert.equal(first.result.current.draftAttachmentWorkspaceId, 'files-a');
    assert.equal(first.result.current.draft?.subject, 'Keep this subject');
    act(() => first.result.current.openNewDraft());
    assert.equal(first.result.current.composeMinimized, false, 'new compose resumes the existing draft');
    let opened: boolean | undefined;
    act(() => { opened = first.result.current.openDraft('reply', message, 'Replacement'); });
    assert.equal(opened, false);
    assert.equal(first.result.current.draft?.body, 'Keep this body');
    const beforePreview = calls.length;
    await act(async () => { await first.result.current.generateAiReplyPreview(message, 'INBOX'); });
    assert.equal(calls.length, beforePreview, 'reply preview cannot overwrite an existing draft');
    response = async () => stream('AI from A');
    await act(async () => { await first.result.current.generateAiBody(); });
    assert.equal(calls.at(-1)?.body.accountId, a.id);
    assert.equal(calls.at(-1)?.body.mailboxWorkspaceId, 'workspace-a');
    assert.equal(calls.at(-1)?.body.workspaceId, 'files-a');
    assert.equal(first.result.current.draft?.body, 'AI from A');
    response = async () => Response.json({ success: true });
    await act(async () => { await first.result.current.submit(); });
    assert.equal(calls.at(-1)?.url, '/api/email/send');
    assert.equal(calls.at(-1)?.body.mailboxWorkspaceId, 'workspace-a');
    assert.equal(calls.at(-1)?.body.attachmentWorkspaceId, 'files-a');
    assert.equal(first.result.current.draft, null);
    first.unmount();

    // A live capability/source lookup governs send and AI, rather than frozen permissions.
    const access = fixture(); await createDraft(access);
    access.change({ activeAccount: b, accounts: [{ ...a, capabilities: { ...canUse, canRunAgent: false } }, b, personal] });
    assert.equal(access.result.current.draftCanGenerateAi, false);
    const beforeRevokedAi = calls.length;
    await act(async () => { await access.result.current.generateAiBody(); });
    assert.equal(calls.length, beforeRevokedAi);
    access.change({ accounts: [b, personal] });
    assert.equal(access.result.current.draftSourceUnavailable, true);
    assert.equal(access.result.current.draftCanWrite, false);
    assert.equal(access.result.current.draft?.subject, 'Keep this subject');
    await act(async () => { await access.result.current.submit(); });
    assert.equal(calls.length, beforeRevokedAi, 'B with the same account ID never replaces missing A');
    assert.match(access.result.current.error || '', /senderChanged/);
    access.change({ accounts: [a, b, personal] });
    assert.equal(access.result.current.draftCanWrite, true);
    access.change({ accounts: [{ ...a, mailboxId: 'different-binding' }, b, personal] });
    assert.equal(access.result.current.draftSourceUnavailable, true, 'a different mailbox assignment preserves and blocks the draft');
    access.change({ accounts: [{ ...a, capabilities: { ...canUse, canWrite: false } }, b, personal] });
    assert.equal(access.result.current.draftSourceUnavailable, true);
    await act(async () => { await access.result.current.submit(); });
    assert.equal(calls.length, beforeRevokedAi);
    access.unmount();

    // A send uncertainty from A is retained after selecting B and cannot be retried.
    const uncertain = fixture(); await createDraft(uncertain);
    const delayedSend = deferred<Response>(); response = () => delayedSend.promise;
    let pendingSend!: Promise<void>;
    act(() => { pendingSend = uncertain.result.current.submit(); });
    uncertain.change({ activeAccount: b, mailboxWorkspaceId: 'workspace-b' });
    await act(async () => { delayedSend.resolve(Response.json({ success: false, error: 'Transport uncertain' }, { status: 502 })); await pendingSend; });
    assert.equal(uncertain.result.current.sendUncertain, true);
    const sentCalls = calls.length;
    await act(async () => { await uncertain.result.current.submit(); });
    assert.equal(calls.length, sentCalls);
    act(() => uncertain.result.current.openOutbox());
    assert.deepEqual(reviews.at(-1), { target: undefined, options: { filter: 'failed' } }, 'unknown draft ID opens the review overview without inventing an identity');
    assert.equal(uncertain.result.current.draftMailboxWorkspaceId, 'workspace-a');
    uncertain.unmount();

    // A durable server-created review identity is opened using A's frozen workspace.
    const known = fixture(); await createDraft(known);
    known.change({ activeAccount: b, mailboxWorkspaceId: 'workspace-b' });
    response = async () => Response.json({ success: false, error: 'Needs review', data: { id: 'actual-outbox-id' } }, { status: 503 });
    await act(async () => { await known.result.current.submit(); });
    assert.deepEqual(reviews.at(-1)?.target, { scope: 'workspace', workspaceId: 'workspace-a', draftId: 'actual-outbox-id' });
    assert.equal(known.result.current.draft, null);
    known.unmount();

    // Late AI output is discarded once the actual draft source loses AI permission.
    const live = fixture(); await createDraft(live);
    const delayedAi = deferred<Response>(); response = () => delayedAi.promise;
    let pendingAi!: Promise<void>;
    act(() => { pendingAi = live.result.current.generateAiBody(); });
    const aiSignal = calls.at(-1)?.signal;
    live.change({ accounts: [{ ...a, capabilities: { ...canUse, canRunAgent: false } }, b, personal] });
    assert.equal(aiSignal?.aborted, true);
    await act(async () => { delayedAi.resolve(stream('Late revoked output')); await pendingAi; });
    assert.equal(live.result.current.draft?.body, 'Keep this body');
    assert.equal(live.result.current.isGeneratingAi, false);
    live.unmount();

    // A pending preview/reply keeps its original message folder, ID and actual source.
    const reply = fixture(); const delayedPreview = deferred<Response>(); response = () => delayedPreview.promise;
    let preview!: Promise<void>;
    act(() => { preview = reply.result.current.generateAiReplyPreview(message, 'INBOX'); });
    assert.equal(calls.at(-1)?.body.mailboxWorkspaceId, 'workspace-a');
    assert.equal(calls.at(-1)?.body.workspaceId, 'files-a');
    reply.change({ activeAccount: b, mailboxWorkspaceId: 'workspace-b', activeFolder: 'Other' });
    await act(async () => { delayedPreview.resolve(stream('Preview reply from A')); await preview; });
    assert.equal(reply.result.current.draft?.body, 'Preview reply from A');
    assert.equal(reply.result.current.draftMailboxWorkspaceId, 'workspace-a');
    response = async () => Response.json({ success: true });
    await act(async () => { await reply.result.current.submit(); });
    assert.equal(calls.at(-1)?.url, `/api/email/accounts/${a.id}/messages/actions`);
    assert.equal(calls.at(-1)?.body.mailboxWorkspaceId, 'workspace-a');
    assert.equal(calls.at(-1)?.body.messageId, message.id);
    assert.equal(calls.at(-1)?.body.folder, 'INBOX');
    reply.unmount();

    // Workspace files/context cannot be silently rebound; uploads remain usable.
    const attachments = fixture(); await createDraft(attachments);
    const workspaceFile: EmailAttachmentDraft = { id: 'file', source: 'workspace', path: '/a.txt', name: 'a.txt', size: 1, mimeType: 'text/plain' };
    const upload: EmailAttachmentDraft = { id: 'upload', source: 'upload', uploadId: 'upload-id', name: 'upload.txt', size: 1, mimeType: 'text/plain' };
    act(() => attachments.result.current.updateDraft({ attachments: [workspaceFile] }));
    const previousUpdate = attachments.result.current.updateDraft;
    attachments.change({ activeAccount: b, activeWorkspaceId: 'files-b' });
    act(() => previousUpdate({ contextFiles: [{ path: '/wrong-workspace.txt' }] }));
    assert.deepEqual(attachments.result.current.draft?.contextFiles, []);
    act(() => previousUpdate({ attachments: [workspaceFile, { ...workspaceFile, id: 'new', path: '/b.txt' }] }));
    assert.deepEqual(attachments.result.current.draft?.attachments, [workspaceFile]);
    const beforeBadAttachments = calls.length;
    await act(async () => { await attachments.result.current.submit(); });
    assert.equal(calls.length, beforeBadAttachments);
    act(() => attachments.result.current.updateDraft({ attachments: [upload] }));
    assert.deepEqual(attachments.result.current.draft?.attachments, [upload]);
    response = async () => Response.json({ success: true });
    await act(async () => { await attachments.result.current.submit(); });
    assert.equal(calls.at(-1)?.body.attachmentWorkspaceId, 'files-a');
    assert.deepEqual(calls.at(-1)?.body.attachments, [upload]);
    attachments.unmount();

    // Personal/workspace scopes sharing raw IDs remain distinct, even with stale context scope.
    const personalDraft = fixture(options({ activeAccount: personal, mailboxWorkspaceId: 'workspace-b' }));
    await createDraft(personalDraft);
    personalDraft.change({ activeAccount: b, mailboxWorkspaceId: 'workspace-b' });
    await act(async () => { await personalDraft.result.current.submit(); });
    assert.equal(calls.at(-1)?.body.mailboxWorkspaceId, null);
    personalDraft.unmount();

    // An owner switch hides old drafts and cannot apply old responses to a new owner's draft.
    const owner = fixture(); await createDraft(owner);
    const oldCallback = owner.result.current.openNewDraft;
    const oldAi = deferred<Response>(); response = () => oldAi.promise;
    let ownerAi!: Promise<void>;
    act(() => { ownerAi = owner.result.current.generateAiBody(); });
    owner.change({ ownerUserId: 'new-owner', activeAccount: b });
    assert.equal(owner.result.current.draft, null);
    assert.equal(owner.result.current.draftAccount, null);
    assert.equal(owner.result.current.draftSenderAddress, '');
    act(() => oldCallback());
    assert.equal(owner.result.current.draft, null, 'an obsolete callback cannot restore the old owner');
    act(() => owner.result.current.openNewDraft());
    act(() => owner.result.current.updateDraft({ body: 'New owner body' }));
    await act(async () => { oldAi.resolve(stream('Old owner late response')); await ownerAi; });
    const currentOwnerDraft: EmailComposeDraft | null = owner.result.current.draft as EmailComposeDraft | null;
    assert.ok(currentOwnerDraft);
    assert.equal(currentOwnerDraft.body, 'New owner body');
    assert.equal(owner.result.current.draftSenderAddress, b.emailAddress);
    owner.unmount();
    console.log('Email compose source: frozen mailbox/sender, minimize/resume, collisions, current permissions, stale AI, attachments and uncertainty passed.');
  } finally {
    cleanup(); globalThis.fetch = originalFetch; loader._load = originalLoad; dom.window.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
