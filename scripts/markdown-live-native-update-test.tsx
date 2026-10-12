import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import { type Editor, type JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import type { CollaborationDocument } from '../app/lib/collaboration/client';
import { createInitialTextCollaborationClientState } from '../app/lib/collaboration/client-state';
import { MarkdownEditorAccessContext } from '../app/components/editor/MarkdownEditorAccess';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://canvas.test', pretendToBeVisual: true });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent',
  'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
Object.defineProperty(dom.window, 'ResizeObserver', { value: globalThis.ResizeObserver, configurable: true });
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();

async function main() {
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  internals._load = (request, parent, isMain) => request === 'server-only' ? {} : originalLoad(request, parent, isMain);
  const codec = await import('../app/lib/markdown/rich-markdown-codec');
  const { createRichMarkdownYDoc, convertRichMarkdownYDoc, replaceRichMarkdownInYDoc, validateRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
  const { readRichDocumentJson } = await import('../app/lib/collaboration/rich-document');
  const legacy = createRichMarkdownYDoc('Original paragraph');
  const doc = convertRichMarkdownYDoc(legacy, 'tiptap_blocks'); legacy.destroy();
  const peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  const session: NonNullable<CollaborationDocument['session']> = {
    success: true, documentId: 'native-doc', documentName: 'native-doc', provider: 'yjs', representation: 'tiptap_blocks',
    lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, blockTreeFormatVersion: 1, permission: 'write',
    documentSequence: 1, checkpointSequence: 1, stateVector: '', stateProof: null, token: 'test',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), websocketUrl: '/ws/collaboration',
    user: { id: 'user', name: 'User', color: '#123456', colorLight: '#abcdef' },
  };
  const collaboration: CollaborationDocument = {
    registryKey: ['workspace', 'owner', 'native-doc', '1', 'tiptap_blocks'].join('\0'), doc, session,
    provider: { awareness: null } as unknown as NonNullable<CollaborationDocument['provider']>,
    clientState: { ...createInitialTextCollaborationClientState(), ready: true, indexedDbHydrated: true,
      remoteSynced: true, connection: 'live', durability: 'persisted_yjs' },
    connection: 'live', durability: 'persisted_yjs', ready: true, status: 'live', error: null,
    setComposition() {}, requestCheckpoint: async () => { throw new Error('Native edits never require a checkpoint.'); },
  };
  let failProjection = false;
  let projectionParses = 0;
  const workspace = { activeWorkspaceId: null };
  const files = { currentFile: null, currentFileWorkspaceId: null, treeGeneration: 0 };
  internals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/markdown/rich-markdown-codec') return { ...codec, createRichMarkdownManager: () => {
      const manager = codec.createRichMarkdownManager();
      return { ...manager, parse: (markdown: string) => { projectionParses++; return manager.parse(markdown); }, serialize: (json: JSONContent) => {
        if (failProjection) throw new Error('Projected Markdown unavailable');
        return manager.serialize(json);
      } };
    } };
    if (request === '@/app/lib/collaboration/client') return {
      useCollaborationDocument: () => collaboration,
      useTextCollaborationSession: () => ({ session, error: null, loading: false, retry() {} }),
    };
    if (request === './CodeEditorClient') return { CodeEditor: ({ value, readOnly }: { value: string; readOnly: boolean }) =>
      <div data-testid="source-editor" data-readonly={String(readOnly)}>{value}</div> };
    if (request === '@/components/ui/mermaid-diagram') return { MermaidDiagram: () => null };
    if (request === '@/app/components/shared/MarkdownRenderer') return { MarkdownRenderer: () => <div data-testid="markdown-preview" /> };
    if (request === '@/app/components/shared/WorkspaceDocumentPreviewDialog') return { WorkspaceDocumentPreviewDialog: () => null };
    if (request === '@/app/store/workspace-store') return { useWorkspaceStore: Object.assign(
      (selector: (value: typeof workspace) => unknown) => selector(workspace), { getState: () => workspace }) };
    if (request === '@/app/store/file-store') return { useFileStore: Object.assign(
      (selector?: (value: typeof files) => unknown) => selector ? selector(files) : files, { getState: () => files }) };
    return originalLoad(request, parent, isMain);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('No server request belongs to this native edit.'); };
  const { MarkdownEditor, RichMarkdownEditor } = await import('../app/components/editor/MarkdownEditor');
  const root = createRoot(document.getElementById('root')!);
  const changes: string[] = [];
  const labels = messages.notebook.editorModes;
  const modeButton = (label: string) => [...document.querySelectorAll('.markdown-mode-bar button')]
    .find((button) => button.textContent === label);
  const editor = () => {
    const element = document.querySelector('.tiptap') as HTMLElement & { editor: Editor };
    assert(element?.editor); return element.editor;
  };
  const wrap = (child: React.ReactNode) => <StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <MarkdownEditorAccessContext.Provider value={{ workspace: false, resolveImage: () => null }}>{child}</MarkdownEditorAccessContext.Provider>
  </NextIntlClientProvider></StrictMode>;
  let updates = 0;
  const relay = (update: Uint8Array) => { updates++; Y.applyUpdate(peer, update); };
  doc.on('update', relay);
  try {
    await act(async () => root.render(wrap(<MarkdownEditor value="Original paragraph" filePath="live.md" collaborationEnabled
      mode="rich" onChange={(value) => changes.push(value)} />)));
    const instance = editor(); const element = instance.view.dom;
    assert.equal(modeButton(labels.source), undefined, 'structured collaboration does not offer an unwritable Source mode');
    assert.equal(instance.state.doc.textContent, 'Original paragraph', 'fixture mounts the authoritative Yjs binding');
    const originalIds = readRichDocumentJson(doc).content!.map((node) => node.attrs!.id);
    const manager = instance.storage.markdown.manager;
    const serialize = manager.serialize;
    let nativeSerializations = 0;
    manager.serialize = () => { nativeSerializations++; throw new Error('Native Markdown serializer unavailable'); };
    failProjection = true;
    await act(async () => { assert.equal(instance.commands.insertContent('New '), true); });
    assert.equal(nativeSerializations, 0, 'native input does not invoke the Markdown serializer');
    assert.equal(editor(), instance); assert.equal(editor().view.dom, element, 'failed projection does not remount the editor');
    assert.equal(instance.state.doc.textContent, 'New Original paragraph');
    assert.equal(instance.isEditable, true);
    assert(updates > 0); assert.deepEqual(readRichDocumentJson(peer), readRichDocumentJson(doc), 'native update reaches a Yjs peer');
    assert.deepEqual(readRichDocumentJson(doc).content!.map((node) => node.attrs!.id), originalIds);
    assert.equal(changes.length, 0, 'collaborative parent previews observe Yjs instead of a second Markdown callback');
    assert.equal(document.querySelector('[data-testid="markdown-save-state"]'), null, 'usable native state needs no error panel');
    await act(async () => { instance.commands.insertContent('Again '); });
    assert.equal(instance.state.doc.textContent, 'New Again Original paragraph');
    assert.deepEqual(readRichDocumentJson(peer), readRichDocumentJson(doc));
    manager.serialize = serialize; failProjection = false;

    await act(async () => replaceRichMarkdownInYDoc(doc, '| First | Second |\n| --- | --- |\n| Seed | Neighbor |'));
    const tableEditor = editor();
    let cellStart = -1;
    tableEditor.state.doc.descendants((node, position) => { if (node.isText && node.text === 'Seed') cellStart = position; });
    assert(cellStart > 0);
    const parsesBeforeInput = projectionParses;
    await act(async () => {
      tableEditor.commands.setTextSelection({ from: cellStart, to: cellStart + 4 });
      tableEditor.commands.insertContent({ type: 'text', text: 'odd\\|pipe' });
      tableEditor.commands.setTextSelection({ from: cellStart, to: cellStart + 9 });
      tableEditor.commands.toggleCode();
    });
    assert.equal(projectionParses, parsesBeforeInput, 'ordinary live input never runs the derived Markdown parse check');
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable', 'real codec reproduces lossy table code');
    const nativeBeforeModes = readRichDocumentJson(doc);
    const binaryBeforeModes = Y.encodeStateAsUpdate(doc);
    const modeChanges: string[] = [];
    await act(async () => root.render(wrap(<MarkdownEditor value="Original paragraph" filePath="live.md" collaborationEnabled mode="source"
      onModeChange={(mode) => modeChanges.push(mode)} />)));
    assert.equal(document.querySelector('[data-testid="source-editor"]'), null, 'an unavailable controlled Source mode never mounts a text writer');
    assert.equal(document.querySelector('[data-editor-mode]')?.getAttribute('data-editor-mode'), 'read');
    assert.equal(modeButton(labels.read)?.getAttribute('aria-pressed'), 'true');
    assert.equal(modeButton(labels.source), undefined);
    assert(modeChanges.includes('read'), 'the controlled owner is told about the safe mode fallback');
    assert.equal(editor().isEditable, false);
    assert.deepEqual(editor().getJSON(), nativeBeforeModes, 'fallback Read uses the intact native document');
    const parsesAfterSource = projectionParses;
    assert(parsesAfterSource > parsesBeforeInput, 'fallback Read validates its derived Markdown before choosing a renderer');
    await act(async () => root.render(wrap(<MarkdownEditor value="Original paragraph" filePath="live.md" collaborationEnabled mode="source" />)));
    assert.equal(projectionParses, parsesAfterSource, 're-render reuses the validation of the same snapshot');
    await act(async () => root.render(wrap(<MarkdownEditor value="Original paragraph" filePath="live.md" collaborationEnabled mode="read" />)));
    assert.equal(document.querySelector('[data-testid="markdown-preview"]'), null);
    assert.equal(editor().isEditable, false, 'Read renders the native document instead of a lossy Markdown preview');
    assert.deepEqual(editor().getJSON(), nativeBeforeModes);
    await act(async () => root.render(wrap(<MarkdownEditor value="Original paragraph" filePath="live.md" collaborationEnabled mode="rich" />)));
    assert.equal(editor().isEditable, true);
    assert.deepEqual(editor().getJSON(), nativeBeforeModes);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), binaryBeforeModes, 'Source/Read/Edit never rewrite the live document');
    assert.equal(document.querySelector('[data-testid="markdown-save-state"]'), null);
    await act(async () => {
      editor().commands.setTextSelection({ from: cellStart, to: cellStart + 9 });
      editor().commands.unsetCode();
    });
    assert.equal(validateRichMarkdownYDoc(doc).valid, true);
    await act(async () => root.render(wrap(<MarkdownEditor value="Original paragraph" filePath="live.md" collaborationEnabled mode="source" />)));
    assert.equal(document.querySelector('[data-testid="source-editor"]'), null, 'a valid projection is still not an editable Source document');
    assert.equal(modeButton(labels.source), undefined);
    assert.equal(document.querySelector('[data-editor-mode]')?.getAttribute('data-editor-mode'), 'read');
    assert(document.querySelector('[data-testid="markdown-preview"]'), 'lossless fallback Read may use the Markdown preview');
    assert.deepEqual(readRichDocumentJson(peer), readRichDocumentJson(doc));

    await act(async () => root.render(wrap(<MarkdownEditor value="Local source" filePath="local.md" mode="source" />)));
    assert(modeButton(labels.source), 'local Markdown fields and documents retain Source');
    assert.equal(document.querySelector('[data-testid="source-editor"]')?.getAttribute('data-readonly'), 'false');
    assert.equal(document.querySelector('[data-testid="source-editor"]')?.textContent, 'Local source');

    const plainDoc = new Y.Doc(); plainDoc.getText('content').insert(0, '<div>Exact source</div>\n');
    const plainSession = { ...session, documentId: 'plain-doc', representation: 'plain_text' as const };
    const plainCollaboration = { ...collaboration, doc: plainDoc, session: plainSession };
    const external = { resolution: { session: plainSession, error: null, loading: false, retry() {} }, document: plainCollaboration };
    try {
      await act(async () => root.render(wrap(<MarkdownEditor value="stale file" filePath="plain.md" collaborationEnabled
        externalCollaboration={external} mode="source" />)));
      assert(modeButton(labels.source), 'source-backed collaboration retains Source');
      assert.equal(document.querySelector('[data-testid="source-editor"]')?.textContent, '<div>Exact source</div>\n');
      assert.equal(document.querySelector('[data-testid="source-editor"]')?.getAttribute('data-readonly'), 'false');
      plainCollaboration.connection = 'offline';
      await act(async () => root.render(wrap(<MarkdownEditor value="stale file" filePath="plain.md" collaborationEnabled
        externalCollaboration={external} mode="source" readOnly />)));
      assert(modeButton(labels.source), 'source support is independent of permissions and connectivity');
      assert.equal(document.querySelector('[data-testid="source-editor"]')?.getAttribute('data-readonly'), 'true');
      await act(async () => root.render(wrap(<MarkdownEditor value="Original paragraph" filePath="live.md" collaborationEnabled mode="read" />)));
    } finally { plainDoc.destroy(); }

    await act(async () => root.render(wrap(<RichMarkdownEditor value="Local paragraph" filePath="local.md" readOnly={false}
      isMobileKeyboardActive={false} onSourceMode={() => {}} onChange={(value) => changes.push(value)} />)));
    const local = editor();
    await act(async () => { local.commands.insertContent('Local edit '); });
    assert(changes.at(-1)?.includes('Local edit Local paragraph'), 'non-collaborative editor still publishes its Markdown onChange');
    console.log('Native rich editing: source availability/fallback, exact plain/local source, serializer failure, peer updates and identity passed.');
  } finally {
    await act(async () => root.unmount());
    doc.off('update', relay); doc.destroy(); peer.destroy();
    internals._load = originalLoad; globalThis.fetch = originalFetch; dom.window.close();
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
