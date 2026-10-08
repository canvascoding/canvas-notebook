import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act, type ReactNode } from 'react';
import { JSDOM } from 'jsdom';
import type { EmailComposeDialogLabels, EmailComposeDraft } from '../app/apps/email/components/email-client-types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'Element', 'Node', 'DOMParser', 'CustomEvent', 'Event', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
const loader = Module as typeof Module & { _load(request: string, parent: NodeModule | null, isMain: boolean): unknown };
const originalLoad = loader._load;
const translate = (key: string) => key;
const fileQueries: Array<{ workspaceId: string }> = [];
let workspaceId = 'files-a';
const wrapper = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
loader._load = (request, parent, isMain) => {
  if (request === 'next-intl') return { useTranslations: () => translate, useLocale: () => 'en' };
  if (request === '@/app/store/workspace-store') return { useWorkspaceStore: (select: (state: { activeWorkspaceId: string }) => unknown) => select({ activeWorkspaceId: workspaceId }) };
  if (request === '@/app/lib/files/client') return { listWorkspaceFileReferences: async (query: { workspaceId: string }) => { fileQueries.push(query); return []; } };
  if (request === '@/components/ui/dialog') return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => open ? <div role="dialog">{children}</div> : null,
    DialogContent: wrapper, DialogDescription: wrapper, DialogFooter: wrapper, DialogHeader: wrapper, DialogTitle: wrapper,
  };
  if (request === '@/app/apps/email/components/EmailAttachmentPanel') return { EmailAttachmentPanel: () => <div data-testid="uploads-available" /> };
  if (request === '@/app/apps/email/components/EmailMessageReader') return { EmailMessageBody: () => null };
  if (request === '@/app/components/canvas-agent-chat/ComposerReferencePicker') return { ComposerReferencePicker: () => <div data-testid="reference-picker" /> };
  if (request === './EmailHtmlEditor' && parent?.filename.endsWith('EmailComposeDialog.tsx')) return { EmailHtmlEditor: () => <div data-testid="body-editor" /> };
  return originalLoad(request, parent, isMain);
};

async function main() {
  const { cleanup, fireEvent, render } = await import('@testing-library/react');
  const { EmailComposeDialog } = await import('../app/apps/email/components/EmailComposeDialog');
  const draft: EmailComposeDraft = { mode: 'compose', aiMode: 'workspace-agent', aiPrompt: 'Use context', aiTone: 'casual', body: 'Keep content',
    bodyHtml: '<p>Keep content</p>', attachments: [], contextFiles: [], usedContext: [], ccText: '', toText: 'recipient@example.test', subject: 'Keep subject' };
  const labels = new Proxy({}, { get: (_target, key) => String(key) }) as EmailComposeDialogLabels;
  let minimized = 0; let closed = 0; let updates = 0;
  const recipientUpdates: unknown[] = [];
  const recipientQueries: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/email/recipients');
    recipientQueries.push(JSON.parse(String(init?.body)));
    return Response.json({ success: true, data: { status: 'resolved', candidates: [{ address: 'anna@example.test', name: 'Anna', reason: 'name_match', source: { messageId: 'old-source', folder: 'Sent', role: 'to' } }], candidateCount: 1, omittedCount: 0, coverage: { hasMore: false, nextOffset: null, incomplete: false } } });
  };
  const props = { draft, error: null, agentEvents: [], agentStatus: null, locale: 'en', labels, senderAddress: 'workspace-a@example.test',
    accountId: 'shared-id', mailboxWorkspaceId: 'workspace-a', attachmentWorkspaceId: 'files-a',
    isGeneratingAi: false, isSubmitting: false, onClose: () => { closed++; }, onMinimize: () => { minimized++; }, minimizeLabel: 'Minimize',
    onGenerateAi: () => {}, onSubmit: () => {}, onUpdate: (patch: unknown) => { updates++; recipientUpdates.push(patch); }, allowRemoteResourcesByDefault: false, allowedRemoteResourceSenders: [],
    onAllowRemoteResourcesForSender: () => {} };
  try {
    const view = render(<EmailComposeDialog {...props} />);
    assert.equal(recipientQueries.length, 0, 'opening compose never preloads recipient history');
    assert.ok(view.getByText('workspace-a@example.test'));
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'composeAddContext' })); });
    assert.equal(fileQueries.at(-1)?.workspaceId, 'files-a');
    assert.ok(view.getByTestId('reference-picker'));
    fireEvent.click(view.getByTestId('email-compose-minimize'));
    assert.equal(minimized, 1);
    assert.equal(closed, 0, 'minimize never discards the draft');
    assert.equal(updates, 0);
    view.rerender(<EmailComposeDialog {...props} composeMinimized />);
    assert.equal(view.queryByRole('dialog'), null);
    workspaceId = 'files-b';
    view.rerender(<EmailComposeDialog {...props} />);
    assert.ok(view.getByText('workspace-a@example.test'), 'restoring the dialog keeps the pinned sender');
    assert.ok(view.getByText('attachmentWorkspaceChanged'));
    assert.ok(view.getByTestId('uploads-available'));
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'composeAddContext' })); });
    assert.equal(fileQueries.at(-1)?.workspaceId, 'files-a', 'reference lookup carries the frozen attachment workspace');
    await act(async () => {
      const input = view.getByRole('combobox', { name: 'to' });
      fireEvent.focus(input); fireEvent.change(input, { target: { value: 'Anna' } });
      await new Promise(done => setTimeout(done, 440));
    });
    assert.equal(recipientQueries[0]?.accountId, 'shared-id');
    assert.equal(recipientQueries[0]?.mailboxWorkspaceId, 'workspace-a', 'recipient lookup uses the pinned sender mailbox after workspace navigation');
    assert.equal(recipientQueries[0]?.workspaceId, undefined, 'attachment workspace is not a mailbox lookup context');
    const recipientOption = view.getByRole('option', { name: /anna@example\.test/u });
    fireEvent.mouseDown(recipientOption); fireEvent.click(recipientOption);
    assert.deepEqual(recipientUpdates.at(-1), { toText: 'recipient@example.test, anna@example.test' });
    view.rerender(<EmailComposeDialog {...props} isGeneratingAi />);
    fireEvent.click(view.getByTestId('email-compose-minimize'));
    assert.equal(minimized, 2, 'a draft can be minimized while generation continues');
    assert.equal(closed, 0);
    view.rerender(<EmailComposeDialog {...props} />);
    fireEvent.click(view.getByRole('button', { name: 'cancel' }));
    assert.equal(closed, 1, 'Cancel retains its explicit discard semantics');
    console.log('Email compose dialog: minimize/resume, sender, pinned reference workspace, upload visibility and explicit Cancel passed.');
  } finally { cleanup(); globalThis.fetch = originalFetch; loader._load = originalLoad; dom.window.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
