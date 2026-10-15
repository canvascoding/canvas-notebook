import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { getSchema, type JSONContent } from '@tiptap/core';
import type { CollaborationDocument } from '../app/lib/collaboration/client';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { createInitialTextCollaborationClientState } from '../app/lib/collaboration/client-state';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { isFileGuestContentBootstrap, type FileGuestContentBootstrap } from '../app/lib/file-guests/content-contract';
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
  const lossyDoc = createRichMarkdownYDoc('| Native width |\n| --- |\n| Preserved cell |', 'tiptap_blocks');
  const lossyTree = new CollaborationBlockTree(lossyDoc, getSchema(codec.richMarkdownCodecExtensions()));
  for (const record of lossyTree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
    (record.get('attributes') as Y.Map<unknown>).set('colwidth', [120]);
  }
  const plainDoc = new Y.Doc(); plainDoc.getText('content').insert(0, '<div>Shared source</div>\n');
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
      const serialize = manager.serialize.bind(manager);
      // Preserve the real instance: lossless checks also call its prototype parse method.
      manager.serialize = (json: JSONContent) => {
        if (failSerialization) throw new Error('Private serializer diagnostic');
        return serialize(json);
      };
      return manager;
    } };
    // This test isolates the actual guest shell, projection hook and common recovery panel.
    // guest-editor-controls-test exercises the real rich editor and account/guest command parity.
    if (request === '@/app/components/editor/MarkdownEditor') return {
      RichMarkdownEditor: ({ readOnly, collaborationDocument }: { readOnly: boolean; collaborationDocument: CollaborationDocument }) =>
        <div data-testid="native-editor" data-readonly={String(readOnly)} data-document-guid={collaborationDocument.doc.guid} />,
      useMobileKeyboardActive: () => false, useVisualViewportBottomOffset() {},
    };
    if (request === '@uiw/react-codemirror') return { __esModule: true,
      default: ({ value, editable }: { value: string; editable: boolean }) =>
        <div data-testid="source-editor" data-editable={String(editable)}>{value}</div> };
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
  let bootstrap: FileGuestContentBootstrap = { kind: 'markdown', markdown: 'Shared draft' };
  const render = async (key = 'same') => act(async () => root.render(<StrictMode>
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <GuestMarkdownEditor key={key} session={session} path="shared.md" fileName="shared.md" bootstrap={bootstrap}
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
    assert.equal(shell.children.length, 3, 'only document header, document and access footer occupy layout');
    assert(button(labels.guestDownloadCopy)?.closest('.markdown-mode-bar'));
    assert.equal(native()?.getAttribute('data-readonly'), 'false');
    assert.equal(button(labels.source), undefined, 'rich guest collaboration never offers an unwritable Source view');
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
    assert.equal(button(labels.guestDownloadCopy)?.disabled, false, 'the actual Shared draft document has a lossless Markdown projection');
    await act(async () => button(labels.guestDownloadCopy)!.click());
    assert.equal(downloads.length, 1, 'the enabled download produces the actual Markdown copy');
    assert.equal(downloads[0].name, 'shared.md'); assert.equal(await downloads[0].blob.text(), 'Shared draft');

    assert(isFileGuestContentBootstrap({ kind: 'markdown', markdown: '' }), 'an actual empty Markdown document remains valid');
    assert.equal(isFileGuestContentBootstrap({ kind: 'native_document', content: { kind: 'binary', bytes: '' } }), false);
    assert.equal(isFileGuestContentBootstrap({ kind: 'native_document', content: {
      kind: 'rich_text', document: { type: 'unsupported' }, frontmatter: '', bodyFinalLineEnding: '',
    } }), false);
    bootstrap = { kind: 'native_document', content: { kind: 'rich_text', document: readRichDocumentJson(doc),
      frontmatter: '', bodyFinalLineEnding: '' } };
    await update({ ready: false }, { indexedDbHydrated: false, ready: false });
    assert.equal(native(), null, 'native bootstrap JSON must not initialize an editable substitute for the Yjs room');
    assert.equal(button(labels.guestDownloadCopy)?.disabled, true, 'native bootstrap never claims an empty Markdown fallback is available');
    await act(async () => button(labels.guestDownloadCopy)!.click());
    assert.equal(downloads.length, 1, 'an unhydrated native document cannot produce a fake empty Markdown download');
    await update({ ready: true }, { indexedDbHydrated: true, ready: true });
    assert.equal(native()?.getAttribute('data-document-guid'), doc.guid);
    assert.equal(native()?.getAttribute('data-readonly'), 'false');
    assert.equal(button(labels.guestDownloadCopy)?.disabled, false, 'a genuinely lossless hydrated projection may be downloaded');

    bootstrap = { kind: 'native_document', content: { kind: 'rich_text', document: readRichDocumentJson(lossyDoc),
      frontmatter: '', bodyFinalLineEnding: '' } };
    await update({ doc: lossyDoc });
    assert.equal(native()?.getAttribute('data-document-guid'), lossyDoc.guid);
    assert.equal(native()?.getAttribute('data-readonly'), 'false', 'a valid native table does not require a lossless Markdown export to be edited');
    assert.equal(panel(), null, 'lossy Markdown availability alone is not a native document failure');
    assert.equal(button(labels.guestDownloadCopy)?.disabled, true, 'a serializer result that drops native column widths is not a downloadable copy');
    await act(async () => button(labels.guestDownloadCopy)!.click());
    assert.equal(downloads.length, 1);
    assert.match(JSON.stringify(readRichDocumentJson(lossyDoc)), /"colwidth":\[120\]/u);
    bootstrap = { kind: 'markdown', markdown: 'Shared draft' };
    await update({ doc });

    failSerialization = true;
    await act(async () => doc.getText('frontmatter').insert(0, '\n'));
    assert(native(), 'native Yjs editor survives a failed Markdown projection');
    assert.equal(panel(), null, 'healthy native document does not become an error');
    assert.equal(button(labels.guestDownloadCopy)?.disabled, true);
    assert.equal(button(labels.source), undefined, 'failed projection does not introduce a Source mode');
    assert.equal(button(labels.read), undefined);
    assert.equal(button(labels.rich), undefined);
    assert.equal(native()?.getAttribute('data-readonly'), 'false', 'a projection failure does not turn a writer into a reader');

    await update({ connection: 'denied', durability: 'degraded', error: 'Secret transport detail' }, {
      connection: 'denied', durability: 'degraded', failure: { kind: 'authentication', code: 'DENIED_INTERNAL' },
    });
    assert(panel()?.classList.contains('absolute'), 'attention never creates a document flow row');
    assert(text().includes(labels.failure.authentication)); assert(!text().includes('Secret transport detail'));
    assert.equal(native()?.getAttribute('data-readonly'), 'true'); assert.equal(button(labels.rich), undefined);
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
    assert.equal(button(labels.rich), undefined); assert.equal(button(labels.guestDownloadCopy)?.disabled, false);
    assert.equal(button(labels.source), undefined, 'read permission does not expose derived Rich source');
    assert.equal(checkpoints, 0);

    session.permission = 'write'; session.representation = 'plain_text';
    current = { ...current, doc: plainDoc, connection: 'live', ready: true,
      clientState: { ...current.clientState, connection: 'live', ready: true } };
    await render();
    assert.equal(button(labels.source), undefined, 'a source-backed guest opens its only editable view directly');
    assert.equal(document.querySelector('[data-testid="source-editor"]')?.textContent, '<div>Shared source</div>\n');
    assert.equal(document.querySelector('[data-testid="source-editor"]')?.getAttribute('data-editable'), 'true');
    await update({ connection: 'offline' }, { connection: 'offline' });
    assert.equal(button(labels.source), undefined);
    assert.equal(document.querySelector('[data-testid="source-editor"]')?.getAttribute('data-editable'), 'true');

    session.representation = 'tiptap_blocks';
    await update({ doc, connection: 'live' }, { connection: 'live' });
    assert.equal(button(labels.source), undefined);
    assert.equal(document.querySelector('section')?.getAttribute('data-editor-mode'), 'rich', 'a representation change opens the native view directly');
    assert.equal(native()?.getAttribute('data-readonly'), 'false');
    session.representation = 'plain_text'; session.permission = 'read';
    await update({ doc: plainDoc });
    assert.equal(document.querySelector('section')?.getAttribute('data-editor-mode'), 'read');
    assert.equal(document.querySelector('[data-testid="source-editor"]'), null, 'plain readers never mount a source writer');
    await update({ ready: false }, { ready: false });
    assert.equal(button(labels.source), undefined);
    assert.equal(document.querySelector('[data-testid="source-editor"]'), null, 'loading never mounts a source writer');
    console.log('Guest shell: explicit native bootstrap, lossless-only Markdown downloads, source capabilities/fallback, rights, silent sync, native projection fallback and exact Yjs backup passed.');
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    internals._load = originalLoad; globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    dom.window.HTMLAnchorElement.prototype.click = originalClick;
    doc.destroy(); lossyDoc.destroy(); plainDoc.destroy(); dom.window.close();
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
