import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { observeOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { composerDraftScope, loadComposerDraft, saveComposerDraft } from '../app/lib/chat/draft-storage';
import { useChatComposerDraft } from '../app/components/canvas-agent-chat/useChatComposerDraft';

async function main() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  observeOpenedDocumentAuth({ data: { user: { id: 'u1' }, session: { id: 'auth1' } } });
  useWorkspaceStore.setState({ activeWorkspaceId: 'w1' });
  saveComposerDraft('__new__', 'workspace one');
  const firstScope = composerDraftScope();
  useWorkspaceStore.setState({ activeWorkspaceId: 'w2' });
  assert.equal(loadComposerDraft('__new__'), null);
  assert.equal(loadComposerDraft('__new__', firstScope), 'workspace one');
  observeOpenedDocumentAuth({ data: { user: { id: 'u2' }, session: { id: 'auth2' } } });
  useWorkspaceStore.setState({ activeWorkspaceId: 'w1' });
  assert.equal(loadComposerDraft('__new__'), null);

  const textareaRef = { current: null };
  function Harness({ sessionId, input }: { sessionId: string | null; input: string }) {
    useChatComposerDraft({ sessionId, input, messages: [], setInput: () => {}, textareaRef });
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<Harness sessionId="chat-a" input="belongs to A" />));
  // Navigation can update global workspace before this component renders again.
  useWorkspaceStore.setState({ activeWorkspaceId: 'w2' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
  assert.equal(loadComposerDraft('chat-a'), null, 'a delayed save must retain its original workspace');
  assert.equal(loadComposerDraft('chat-a', composerDraftScope('w1')), 'belongs to A');
  await act(async () => root.render(<Harness sessionId="chat-a" input="pending A" />));
  await act(async () => root.render(<Harness sessionId="chat-b" input="draft B" />));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
  assert.equal(loadComposerDraft('chat-b'), 'draft B');
  assert.equal(loadComposerDraft('chat-a'), null, 'cancelled timer cannot write to the next chat');
  await act(async () => root.unmount());
  dom.window.close();
  console.log('chat-draft-scope-test: ok');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
