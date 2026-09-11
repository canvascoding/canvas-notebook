import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import type { JSONContent } from '@tiptap/core';
import type { CollaborationDocument } from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { createInitialTextCollaborationClientState } from '../app/lib/collaboration/client-state';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://canvas.test/guest', pretendToBeVisual: true });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Element', 'Document', 'HTMLElement',
  'HTMLButtonElement', 'HTMLAnchorElement', 'SVGElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

async function main() {
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (request, parent, isMain) => request === 'server-only' ? {} : originalLoad(request, parent, isMain);
  const codec = await import('../app/lib/markdown/rich-markdown-codec');
  const { createRichMarkdownYDoc, convertRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
  const legacy = createRichMarkdownYDoc('Shared draft');
  const doc = convertRichMarkdownYDoc(legacy, 'tiptap_blocks'); legacy.destroy();
  const session: CollaborationSessionResponse = {
    success: true, documentId: 'guest-doc', documentName: 'guest-doc', provider: 'yjs', representation: 'tiptap_blocks',
    lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, blockTreeFormatVersion: 1, permission: 'write',
    documentSequence: 2, checkpointSequence: 1, stateVector: '', stateProof: null, token: 'test',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), websocketUrl: '/ws/collaboration',
    guestAccess: { invitationId: 'invitation', workspaceId: 'shared-workspace' },
    user: { id: 'guest', name: 'Guest', color: '#123456', colorLight: '#abcdef' },
  };
  let checkpoints = 0;
  let reloads = 0;
  let failSerialization = false;
  let current: CollaborationDocument = {
    registryKey: ['shared-workspace', 'guest', 'guest-doc', '1', 'tiptap_blocks'].join('\0'),
    doc, provider: null, session, status: 'live', connection: 'live', durability: 'persisted_yjs', ready: true, error: null,
    clientState: { ...createInitialTextCollaborationClientState({ documentSequence: 2, checkpointSequence: 1 }),
      indexedDbHydrated: true, remoteSynced: true, ready: true, connection: 'live', durability: 'persisted_yjs' },
    setComposition() {}, requestCheckpoint: async () => { checkpoints++; },
  };
  // Keep account state present while rendering a guest link: it must not enable account recovery writes.
  const workspace = { activeWorkspaceId: 'private-account-workspace' };
  const files = { currentFile: null, currentFileWorkspaceId: 'private-account-workspace', treeGeneration: 1 };
  internals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/collaboration/client') return { useCollaborationDocument: () => current };
    if (request === '@/app/lib/markdown/rich-markdown-codec') return { ...codec, createRichMarkdownManager: () => {
      const manager = codec.createRichMarkdownManager();
      return { ...manager, serialize: (json: JSONContent) => {
        if (failSerialization) throw new Error('Private serializer diagnostic');
        return manager.serialize(json);
      } };
    } };
    // This test isolates the actual guest shell, projection hook and common recovery panel.
    // guest-editor-controls-test exercises the real rich editor and account/guest command parity.
    if (request === '@/app/components/editor/MarkdownEditor') return {
      RichMarkdownEditor: ({ readOnly }: { readOnly: boolean }) => <div data-testid="native-editor" data-readonly={String(readOnly)} />,
      useMobileKeyboardActive: () => false, useVisualViewportBottomOffset() {},
    };
    if (request === '@/app/store/workspace-store') return { useWorkspaceStore: Object.assign(
      (selector: (value: typeof workspace) => unknown) => selector(workspace), { getState: () => workspace }) };
    if (request === '@/app/store/file-store') return { useFileStore: Object.assign(
      (selector: (value: typeof files) => unknown) => selector(files), { getState: () => files }) };
    return originalLoad(request, parent, isMain);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Guest shell must not request a workspace write.'); };
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  const downloads: { blob: Blob; name: string }[] = [];
  let pendingBlob: Blob;
  URL.createObjectURL = (blob: Blob) => { pendingBlob = blob; return 'blob:guest-backup'; };
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push({ blob: pendingBlob, name: this.download }); };
  const { GuestMarkdownEditor } = await import('../app/components/file-guests/GuestMarkdownEditor');
  const root = createRoot(document.getElementById('root')!);
  const labels = messages.notebook.editorModes;
  const text = () => document.body.textContent ?? '';
  const button = (label: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === label);
  const native = () => document.querySelector('[data-testid="native-editor"]');
  const panel = () => document.querySelector('[data-testid="markdown-save-state"]');
  const render = async (key = 'same') => act(async () => root.render(<StrictMode>
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <GuestMarkdownEditor key={key} session={session} path="shared.md" fileName="shared.md" initialMarkdown="Shared draft"
        assets={[]} onReload={() => { reloads++; }} />
    </NextIntlClientProvider>
  </StrictMode>));
  const update = async (patch: Partial<CollaborationDocument>, state: Partial<CollaborationDocument['clientState']> = {}) => {
    current = { ...current, ...patch, clientState: { ...current.clientState, ...state } };
    await render();
  };
  const noWorkspaceRecovery = () => {
    for (const label of [labels.recoverCopy, labels.retry, labels.undoRecovery]) assert.equal(button(label), undefined);
  };
  try {
    await render();
    const shell = document.querySelector('section')!;
    assert(shell.classList.contains('relative'));
    assert.equal(shell.children.length, 3, 'only fixed mode bar, document and access footer occupy layout');
    assert(button(labels.guestDownloadCopy)?.closest('.markdown-mode-bar'));
    assert.equal(native()?.getAttribute('data-readonly'), 'false');
    for (const durability of ['local_pending', 'server_received', 'persisted_yjs', 'checkpoint_pending', 'checkpointed_file'] as const) {
      await update({ durability }, { durability });
      assert.equal(panel(), null, durability);
      assert.equal(shell.children.length, 3, durability);
      assert.equal(document.querySelector('[role="status"]'), null, 'no per-edit live announcement');
    }
    await update({ connection: 'offline' }, { connection: 'offline' });
    assert.equal(panel(), null); assert.equal(native()?.getAttribute('data-readonly'), 'false');
    await update({ connection: 'live', durability: 'persisted_yjs' }, { connection: 'live', durability: 'persisted_yjs',
      projectionError: { code: 'COLLABORATION_CHECKPOINT_ROUNDTRIP_UNSTABLE', sequence: 2 } });
    assert.equal(panel(), null); assert.equal(checkpoints, 0);
    assert(!text().includes('roundtrip') && !text().includes('persisted_yjs'));
    await act(async () => button(labels.guestDownloadCopy)!.click());
    assert.equal(downloads[0].name, 'shared.md'); assert.equal(await downloads[0].blob.text(), 'Shared draft');

    failSerialization = true;
    await act(async () => doc.getText('frontmatter').insert(0, '\n'));
    assert(native(), 'native Yjs editor survives a failed Markdown projection');
    assert.equal(panel(), null, 'healthy native document does not become an error');
    assert.equal(button(labels.guestDownloadCopy)?.disabled, true);
    await act(async () => button(labels.source)!.click());
    assert(text().includes(labels.sourceUnavailable)); assert.equal(native(), null);
    await act(async () => button(labels.rich)!.click()); assert(native());

    await update({ connection: 'denied', durability: 'degraded', error: 'Secret transport detail' }, {
      connection: 'denied', durability: 'degraded', failure: { kind: 'authentication', code: 'DENIED_INTERNAL' },
    });
    assert(panel()?.classList.contains('absolute'), 'attention never creates a document flow row');
    assert(text().includes(labels.failure.authentication)); assert(!text().includes('Secret transport detail'));
    assert.equal(native()?.getAttribute('data-readonly'), 'true'); assert.equal(button(labels.rich)?.disabled, true);
    assert.equal(button(labels.backup), undefined); assert(button(labels.snapshot)); noWorkspaceRecovery();
    await act(async () => { button(labels.snapshot)!.click(); button(labels.reopen)!.click(); });
    assert.equal(reloads, 1); assert.equal(downloads[1].name, 'canvas-recovery.yjs');
    assert.deepEqual(new Uint8Array(await downloads[1].blob.arrayBuffer()), Y.encodeStateAsUpdate(doc));
    await act(async () => { dom.window.history.pushState({}, '', '?collaborationDebug=1'); dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate')); });
    assert(panel()?.querySelector('details')); assert(text().includes('Secret transport detail'));
    await act(async () => { dom.window.history.pushState({}, '', '/guest'); dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate')); });
    assert.equal(panel()?.querySelector('details'), null); assert(!text().includes('Secret transport detail'));

    failSerialization = false;
    await act(async () => doc.getText('frontmatter').delete(0, 1));
    session.permission = 'read';
    current = { ...current, connection: 'read_only', durability: 'checkpointed_file', error: null,
      clientState: { ...current.clientState, connection: 'read_only', durability: 'checkpointed_file', failure: null } };
    await render('read');
    assert.equal(panel(), null); assert.equal(native()?.getAttribute('data-readonly'), 'true');
    assert.equal(button(labels.rich)?.disabled, true); assert.equal(button(labels.guestDownloadCopy)?.disabled, false);
    assert.equal(checkpoints, 0);
    console.log('Guest shell: silent sync/projection states, stable exception overlay, scoped rights, native editing without Markdown and exact Yjs backup passed.');
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    internals._load = originalLoad; globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
    doc.destroy(); dom.window.close();
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
