import assert from 'node:assert/strict';
import Module from 'node:module';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { getSchema, type Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import * as Y from 'yjs';
import messages from '../messages/en.json';
import type { CollaborationDocument } from '../app/lib/collaboration/client';
import type { WorkspaceMarkdownLocation } from '../app/lib/markdown/workspace-markdown-navigation';

// Geometry shims only keep ProseMirror functional in JSDOM. Assertions below
// observe native selection and PM scrollIntoView intent, never browser pixels.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://localhost/en/notebook' });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'HTMLDetailsElement', 'SVGElement', 'Node', 'NodeFilter', 'Event', 'CustomEvent', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
Object.defineProperty(dom.window, 'ResizeObserver', { value: globalThis.ResizeObserver, configurable: true });
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.scrollBy = () => {};
dom.window.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList; };

async function main() {
  const { cleanup, waitFor } = await import('@testing-library/react');
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const original = internals._load;
  const workspace = { activeWorkspaceId: 'heading-navigation-fixture' }, files = { currentFile: null };
  const errors: string[] = [];
  internals._load = (request, parent, isMain) => {
    if (request === './CodeEditorClient') return original('./CodeEditor', parent, isMain);
    if (request === '@/components/ui/mermaid-diagram') return { MermaidDiagram: () => null };
    if (request === '@/app/components/ThemeProvider') return { useTheme: () => ({ resolvedTheme: 'light' }) };
    if (request === '@/app/components/shared/WorkspaceDocumentPreviewDialog') return { WorkspaceDocumentPreviewDialog: () => null };
    if (request === '@/app/store/workspace-store') return { useWorkspaceStore: Object.assign((selector: (value: typeof workspace) => unknown) => selector(workspace), { getState: () => workspace }) };
    if (request === '@/app/store/file-store') return { useFileStore: Object.assign((selector?: (value: typeof files) => unknown) => selector ? selector(files) : files, { getState: () => files }) };
    if (request === 'sonner') return { toast: { error: (message: string) => errors.push(message), warning: (message: string) => errors.push(message) } };
    return original(request, parent, isMain);
  };
  let socketAttempts = 0;
  const cases: Array<{ name: string; error: unknown }> = [];
  try {
    const { RichMarkdownEditor } = await import('../app/components/editor/MarkdownEditor');
    const { MarkdownEditorAccessContext } = await import('../app/components/editor/MarkdownEditorAccess');
    const { MarkdownModeViewport } = await import('../app/lib/editor/markdown-mode-viewport');
    const { createRichMarkdownManager, richMarkdownCodecExtensions } = await import('../app/lib/markdown/rich-markdown-codec');
    const { generateRichNodeIds } = await import('../app/lib/editor/generate-rich-node-ids');
    const { CollaborationBlockTree } = await import('../app/lib/collaboration/block-tree');
    const { isBlockTreeEditorReady } = await import('../app/lib/collaboration/block-tree-editor');
    const { isRemoteRichEditorTransaction } = await import('../app/lib/collaboration/rich-editor-extensions');
    const { createInitialTextCollaborationClientState } = await import('../app/lib/collaboration/client-state');
    const schema = getSchema(richMarkdownCodecExtensions());
    // Use the same real codec/identity/block-tree seed mechanics without a
    // server-only module marker in this client React fixture.
    const createDocument = (markdown: string) => {
      const doc = new Y.Doc();
      try {
        const json = generateRichNodeIds(createRichMarkdownManager().parse(markdown), richMarkdownCodecExtensions());
        CollaborationBlockTree.create(doc, schema.nodeFromJSON(json));
        const ending = markdown.match(/((?:\r?\n)+)$/u)?.[1];
        if (ending) doc.getText('bodyFinalLineEnding').insert(0, ending);
        return doc;
      } catch (error) { doc.destroy(); throw error; }
    };
    const location = (heading: string, requestId: string): WorkspaceMarkdownLocation => Object.freeze({
      path: 'Heading.md', blockId: null, heading, requestId, requestedAt: Date.now(),
    });
    const flush = async () => act(async () => { await new Promise<void>(done => setTimeout(done, 40)); });
    const exercise = async (name: string, operation: () => Promise<void>) => {
      try { await operation(); console.log(`PASS ${name}`); }
      catch (error) { cases.push({ name, error }); console.error(`FAIL ${name}`, error); }
    };
    const mount = async (initialMarkdown: string, target: WorkspaceMarkdownLocation | null) => {
      const doc = createDocument(initialMarkdown), peer = new Y.Doc();
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      const socket = new HocuspocusProviderWebsocket({ url: 'ws://fixture.invalid', autoConnect: false,
        WebSocketPolyfill: class { constructor() { socketAttempts++; throw new Error('This fixture must never open a socket.'); } } });
      const provider = new HocuspocusProvider({ name: 'heading-fixture', document: doc, websocketProvider: socket });
      const state = createInitialTextCollaborationClientState();
      const collaboration: CollaborationDocument = {
        registryKey: 'heading-fixture', doc, provider, session: { success: true, documentId: 'heading-doc', documentName: 'heading-doc',
          provider: 'yjs', representation: 'tiptap_blocks', lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 1,
          blockTreeFormatVersion: 1, permission: 'write', token: 'offline-fixture', expiresAt: '2099-01-01T00:00:00Z', websocketUrl: 'ws://fixture.invalid',
          user: { id: 'heading-user', name: 'Heading User', color: '#123456', colorLight: '#eeeeee' } },
        status: 'connecting', clientState: state, connection: state.connection, durability: state.durability, ready: true,
        error: null, setComposition() {}, requestCheckpoint: async () => {},
      };
      const viewport = new MarkdownModeViewport(), claims: string[] = [], changes: string[] = [], nativeUpdates: unknown[] = [];
      const claim = viewport.claimNavigation.bind(viewport);
      viewport.claimNavigation = requestId => { const accepted = claim(requestId); if (accepted) claims.push(requestId); return accepted; };
      const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
      let mounted = true, disposed = false, currentTarget = target;
      let editor: Editor | undefined;
      const transactions: Transaction[] = [];
      const onTransaction = ({ transaction }: { transaction: Transaction }) => transactions.push(transaction);
      const onNative = (_update: Uint8Array, origin: unknown) => nativeUpdates.push(origin);
      const destroy = async () => {
        if (disposed) return;
        disposed = true;
        try { if (mounted) { await act(async () => root.unmount()); mounted = false; } }
        finally {
          editor?.off('transaction', onTransaction); doc.off('update', onNative);
          provider.destroy(); socket.destroy(); peer.destroy(); doc.destroy(); container.remove();
        }
      };
      const access = { workspace: true } as const;
      const onChange = (value: string) => changes.push(value);
      const render = async (next = currentTarget) => {
        currentTarget = next;
        await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
          <MarkdownEditorAccessContext.Provider value={access}>
            <RichMarkdownEditor value={initialMarkdown} onChange={onChange} filePath="Heading.md" mode="rich" layout="field"
              isMobileKeyboardActive={false} onSourceMode={() => {}} collaborationEnabled collaborationDocument={collaboration}
              markdownNavigationTarget={currentTarget} viewport={viewport} viewportMarkdown={initialMarkdown} />
          </MarkdownEditorAccessContext.Provider>
        </NextIntlClientProvider>));
      };
      const renderSync = (next: WorkspaceMarkdownLocation | null) => {
        currentTarget = next;
        flushSync(() => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
          <MarkdownEditorAccessContext.Provider value={access}>
            <RichMarkdownEditor value={initialMarkdown} onChange={onChange} filePath="Heading.md" mode="rich" layout="field"
              isMobileKeyboardActive={false} onSourceMode={() => {}} collaborationEnabled collaborationDocument={collaboration}
              markdownNavigationTarget={currentTarget} viewport={viewport} viewportMarkdown={initialMarkdown} />
          </MarkdownEditorAccessContext.Provider>
        </NextIntlClientProvider>));
      };
      const prepareNativeHeading = (heading: string) => {
        const tree = new CollaborationBlockTree(peer, schema), before = tree.read(), nodes: import('@tiptap/pm/model').Node[] = [];
        before.forEach(node => nodes.push(node));
        nodes.push(schema.nodes.heading.createChecked({ id: `heading-${heading}`, level: 2 }, schema.text(heading)));
        tree.applyDocumentChange(before, schema.topNodeType.createChecked(null, nodes), 'fixture-peer');
        return { update: Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)),
          expectedBytes: Y.encodeStateAsUpdate(peer), expectedJson: tree.read().toJSON() };
      };
      const unmountSync = () => { flushSync(() => root.unmount()); mounted = false; };
      try {
        await render();
        await waitFor(() => assert(container.querySelector('.ProseMirror')));
        editor = (container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor;
        await waitFor(() => assert(isBlockTreeEditorReady(editor!)));
        await flush();
      } catch (error) { await destroy(); throw error; }
      const actualEditor = editor;
      actualEditor.on('transaction', onTransaction); doc.on('update', onNative);
      const headingPosition = (heading: string) => {
        let found: number | null = null;
        actualEditor.state.doc.descendants((node, position) => { if (node.type.name === 'heading' && node.textContent === heading) found = position + 1; });
        return found;
      };
      const appendHeading = async (heading: string) => {
        const tree = new CollaborationBlockTree(peer, schema), before = tree.read(), nodes: import('@tiptap/pm/model').Node[] = [];
        before.forEach(node => nodes.push(node));
        nodes.push(schema.nodes.heading.createChecked({ id: `heading-${heading}`, level: 2 }, schema.text(heading)));
        tree.applyDocumentChange(before, schema.topNodeType.createChecked(null, nodes), 'fixture-peer');
        const expectedBytes = Y.encodeStateAsUpdate(peer), expectedJson = tree.read().toJSON();
        const update = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc));
        await act(async () => Y.applyUpdate(doc, update, 'fixture-peer'));
        await waitFor(() => assert.notEqual(headingPosition(heading), null));
        assert.equal((container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor, actualEditor, 'native projection keeps the actual Editor');
        assert.equal(collaboration.provider, provider); assert.equal(collaboration.doc, doc);
        await flush();
        assert.deepEqual(Y.encodeStateAsUpdate(doc), expectedBytes, 'projection/navigation preserves the exact peer-native state');
        assert.deepEqual(actualEditor.getJSON(), expectedJson, 'projection/navigation preserves the actual peer document');
      };
      const assertNavigation = (heading: string, requestId: string) => {
        const expected = headingPosition(heading); assert.notEqual(expected, null);
        assert.equal(actualEditor.state.selection.from, expected, 'late native heading must receive the navigation selection');
        assert.equal(actualEditor.state.selection.$from.parent.type.name, 'heading');
        assert.equal(actualEditor.state.selection.$from.parent.textContent, heading);
        const navigations = transactions.filter(transaction => transaction.scrolledIntoView && transaction.selectionSet
          && transaction.selection.$from.parent.type.name === 'heading' && transaction.selection.$from.parent.textContent === heading);
        assert.equal(navigations.length, 1, 'exactly one actual ProseMirror selection+scrollIntoView transaction');
        assert.deepEqual(claims, [requestId], 'exactly one accepted viewport navigation');
        assert.equal(changes.length, 0); assert.equal(actualEditor.can().undo(), false);
      };
      return { doc, peer, editor: actualEditor, viewport, provider, collaboration, target, transactions, claims, changes, nativeUpdates,
        render, renderSync, prepareNativeHeading, unmountSync, appendHeading, headingPosition, assertNavigation, destroy, unmount: async () => {
          await act(async () => root.unmount()); mounted = false;
        } };
    };
    await exercise('already available native heading navigates once without native content/undo writes', async () => {
      const view = await mount('Prelude\n\n## Available Target\n', null), request = location('Available Target', 'available');
      try {
        const bytes = Y.encodeStateAsUpdate(view.doc), json = view.editor.getJSON();
        await view.render(request); await flush(); view.assertNavigation('Available Target', request.requestId);
        await view.render(request); await flush(); view.assertNavigation('Available Target', request.requestId);
        assert.deepEqual(Y.encodeStateAsUpdate(view.doc), bytes); assert.deepEqual(view.editor.getJSON(), json); assert.deepEqual(view.nativeUpdates, []);
      } finally { await view.destroy(); }
    });
    await exercise('stable request retries when a real remote Yjs block projection introduces its heading', async () => {
      const request = location('Late Target', 'late'), view = await mount('Prelude\n\nTail\n', request);
      try {
        assert.equal(view.headingPosition('Late Target'), null); assert.deepEqual(view.claims, []);
        await act(async () => view.editor.commands.setTextSelection(2));
        const beforeSelection = view.editor.state.selection.from;
        await view.appendHeading('Late Target');
        const bytes = Y.encodeStateAsUpdate(view.doc), json = view.editor.getJSON();
        assert(view.transactions.some(transaction => transaction.docChanged && isRemoteRichEditorTransaction(transaction)), 'the actual BlockTreeBinding projected a native remote update');
        assert.equal(view.nativeUpdates.length, 1); assert.equal(view.nativeUpdates[0], 'fixture-peer');
        assert.equal(view.changes.length, 0); assert.equal(view.editor.can().undo(), false);
        console.log('Late-heading chronology:', { sameRequest: view.target === request, sameProvider: view.collaboration.provider === view.provider,
          headingPosition: view.headingPosition('Late Target'), beforeSelection, afterSelection: view.editor.state.selection.from,
          viewportClaims: view.claims.length, scrollRequests: view.transactions.filter(transaction => transaction.scrolledIntoView).length });
        await waitFor(() => view.assertNavigation('Late Target', request.requestId), { timeout: 500 });
        await view.render(request); await flush(); view.assertNavigation('Late Target', request.requestId);
        assert.deepEqual(Y.encodeStateAsUpdate(view.doc), bytes); assert.deepEqual(view.editor.getJSON(), json); assert.equal(view.nativeUpdates.length, 1);
      } finally { await view.destroy(); }
    });
    await exercise('superseded request cannot steal navigation when its absent heading arrives later', async () => {
      const oldRequest = location('Old Target', 'old'), view = await mount('Prelude\n\n## Current Target\n', oldRequest);
      try {
        assert.deepEqual(view.claims, []); const current = location('Current Target', 'current');
        await view.render(current); await flush(); view.assertNavigation('Current Target', current.requestId);
        await view.appendHeading('Old Target'); view.assertNavigation('Current Target', current.requestId);
        assert.equal(view.editor.state.selection.$from.parent.textContent, 'Current Target');
      } finally { await view.destroy(); }
    });
    await exercise('destroyed editor receives no later navigation after unmount and a native update', async () => {
      const view = await mount('Prelude\n', location('After Unmount', 'unmounted'));
      try {
        assert.deepEqual(view.claims, []); await view.unmount(); assert(view.editor.isDestroyed);
        const prior = view.transactions.length;
        const tree = new CollaborationBlockTree(view.peer, schema), before = tree.read(), nodes: import('@tiptap/pm/model').Node[] = [];
        before.forEach(node => nodes.push(node));
        nodes.push(schema.nodes.heading.createChecked({ id: 'heading-after-unmount', level: 2 }, schema.text('After Unmount')));
        tree.applyDocumentChange(before, schema.topNodeType.createChecked(null, nodes), 'fixture-peer');
        Y.applyUpdate(view.doc, Y.encodeStateAsUpdate(view.peer, Y.encodeStateVector(view.doc)), 'fixture-peer');
        await flush(); assert.equal(view.transactions.length, prior); assert.deepEqual(view.claims, []);
      } finally { await view.destroy(); }
    });
    await exercise('synchronous request replacement cancels an already projected native heading before queued navigation', async () => {
      const oldRequest = location('Queued Old Target', 'queued-old');
      const view = await mount('Prelude\n\n## Synchronous Current\n', oldRequest);
      try {
        await act(async () => view.editor.commands.setTextSelection(2));
        const current = location('Synchronous Current', 'synchronous-current');
        const prepared = view.prepareNativeHeading('Queued Old Target');
        let turnCheckpointReached = false;
        act(() => {
          Y.applyUpdate(view.doc, prepared.update, 'fixture-peer');
          queueMicrotask(() => { turnCheckpointReached = true; });
          assert.notEqual(view.headingPosition('Queued Old Target'), null, 'actual native projection finished before synchronous request cleanup');
          assert(view.transactions.some(transaction => transaction.docChanged && isRemoteRichEditorTransaction(transaction)));
          assert.equal(turnCheckpointReached, false); assert.equal(view.editor.state.selection.from, 2); assert.deepEqual(view.claims, []);
          view.renderSync(current);
          assert.equal(turnCheckpointReached, false, 'real React commit/old effect cleanup happens before the microtask checkpoint');
          view.assertNavigation('Synchronous Current', current.requestId);
        });
        await flush(); assert.equal(turnCheckpointReached, true);
        view.assertNavigation('Synchronous Current', current.requestId);
        assert.equal(view.transactions.filter(transaction => transaction.scrolledIntoView && transaction.selectionSet
          && transaction.selection.$from.parent.textContent === 'Queued Old Target').length, 0, 'cancelled request never selects or scrolls its newly projected heading');
        assert.deepEqual(Y.encodeStateAsUpdate(view.doc), prepared.expectedBytes); assert.deepEqual(view.editor.getJSON(), prepared.expectedJson);
        assert.deepEqual(view.nativeUpdates, ['fixture-peer']);
      } finally { await view.destroy(); }
    });
    await exercise('synchronous unmount cancels an already projected native heading before queued navigation', async () => {
      const view = await mount('Prelude\n', location('Queued Unmount Target', 'queued-unmount'));
      try {
        await act(async () => view.editor.commands.setTextSelection(2));
        const prepared = view.prepareNativeHeading('Queued Unmount Target');
        let turnCheckpointReached = false, transactionCountAtCleanup = -1;
        act(() => {
          Y.applyUpdate(view.doc, prepared.update, 'fixture-peer');
          queueMicrotask(() => { turnCheckpointReached = true; });
          assert.notEqual(view.headingPosition('Queued Unmount Target'), null, 'actual native projection finished before synchronous unmount');
          assert(view.transactions.some(transaction => transaction.docChanged && isRemoteRichEditorTransaction(transaction)));
          assert.equal(turnCheckpointReached, false); assert.equal(view.editor.state.selection.from, 2); assert.deepEqual(view.claims, []);
          view.unmountSync(); assert.equal(view.editor.view.dom.isConnected, false);
          assert.equal(view.editor.isDestroyed, false, 'installed Tiptap defers Editor destruction until its timer, so effect cancellation must protect this window');
          assert.equal(turnCheckpointReached, false, 'real React unmount/effect cleanup happens before the microtask checkpoint');
          transactionCountAtCleanup = view.transactions.length;
        });
        await flush(); assert.equal(turnCheckpointReached, true); assert(view.editor.isDestroyed);
        assert.equal(view.transactions.length, transactionCountAtCleanup); assert.deepEqual(view.claims, []);
        assert.equal(view.transactions.filter(transaction => transaction.scrolledIntoView && transaction.selectionSet
          && transaction.selection.$from.parent.textContent === 'Queued Unmount Target').length, 0, 'unmounted request never selects or scrolls its newly projected heading');
        assert.deepEqual(Y.encodeStateAsUpdate(view.doc), prepared.expectedBytes); assert.deepEqual(view.editor.getJSON(), prepared.expectedJson);
        assert.deepEqual(view.nativeUpdates, ['fixture-peer']); assert.equal(view.changes.length, 0); assert.equal(view.editor.can().undo(), false);
      } finally { await view.destroy(); }
    });
    assert.equal(socketAttempts, 0); assert.deepEqual(errors, []);
    assert.equal(cases.length, 0, 'all native-heading navigation cases must pass; missing update subscription intentionally fails before the product fix');
    console.log('Rich native heading UI: actual React/Tiptap/BlockTree selection+PM scroll intent, one request, unchanged content/undo and cleanup passed. Browser geometry remains separate.');
  } finally { cleanup(); internals._load = original; dom.window.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
