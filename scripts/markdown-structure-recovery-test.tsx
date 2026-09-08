import assert from 'node:assert/strict';
import Module from 'node:module';
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import type { CollaborationDocument } from '../app/lib/collaboration/client';
import type { CurrentFile } from '../app/lib/files/types';
import { createInitialTextCollaborationClientState, reduceTextCollaborationClientState, textCollaborationLegacyStatus } from '../app/lib/collaboration/client-state';
import { COLLABORATION_CHECKPOINT_ERROR_CODES } from '../app/lib/collaboration/checkpoint-errors';
import { COLLABORATION_FAILURE_CODES } from '../app/lib/collaboration/failure';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { findBlockTreeHistory } from '../app/lib/collaboration/block-tree-history';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test', pretendToBeVisual: true });
for (const key of ['window', 'Window', 'document', 'DOMParser', 'navigator', 'Element', 'Document', 'HTMLElement', 'HTMLInputElement',
  'HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'SVGElement', 'Node', 'NodeFilter', 'Event',
  'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key as keyof Window], configurable: true });
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();

async function main() {
  const { useFileStore } = await import('../app/store/file-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  let collaboration!: CollaborationDocument;
  // Use the actual React editor, block binding, history and validator. The
  // transport is controlled, and server-only's environment marker is omitted
  // so the pure server validator can run beside React in this Node process.
  internals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/collaboration/client') return {
      useCollaborationDocument: () => collaboration,
      useTextCollaborationSession: () => ({ session: collaboration.session, error: null, loading: false, retry() {} }),
    };
    if (request === './CodeEditorClient') return originalLoad('./CodeEditor', parent, isMain);
    if (request === '@/components/ui/mermaid-diagram') return { MermaidDiagram: () => null };
    if (request === '@/app/components/shared/MarkdownRenderer') return { MarkdownRenderer: ({ content }: { content: string }) => <pre>{content}</pre> };
    if (request === '@/app/components/ThemeProvider') return { useTheme: () => ({ resolvedTheme: 'light' }) };
    if (request === '@/app/components/shared/WorkspaceDocumentPreviewDialog') return { WorkspaceDocumentPreviewDialog: () => null };
    if (request === 'sonner') return { toast: { error() {}, warning() {}, success() {} } };
    return originalLoad(request, parent, isMain);
  };
  const { createRichMarkdownYDoc, convertRichMarkdownYDoc, validateRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
  const { MarkdownEditor } = await import('../app/components/editor/MarkdownEditor');
  const markdown = '| A | B |\n| --- | --- |\n| one | two |';
  const legacy = createRichMarkdownYDoc(markdown);
  const left = convertRichMarkdownYDoc(legacy, 'tiptap_blocks'); legacy.destroy();
  const right = new Y.Doc(); Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  let state: ReturnType<typeof createInitialTextCollaborationClientState> = { ...createInitialTextCollaborationClientState(), ready: true, indexedDbHydrated: true,
    remoteSynced: true, connection: 'live' as const, documentSequence: 1, checkpointSequence: 1 };
  let settleCheckpoint: (() => void) | undefined;
  const refresh = () => { collaboration = { ...collaboration, clientState: state, connection: state.connection,
    durability: state.durability, ready: state.ready, status: textCollaborationLegacyStatus(state), error: state.error }; };
  collaboration = { registryKey: ['workspace', 'owner', 'doc', '1', 'tiptap_blocks'].join('\0'), doc: left,
    provider: { awareness: null } as unknown as NonNullable<CollaborationDocument['provider']>,
    session: { success: true, documentId: 'doc', documentName: 'doc', provider: 'yjs', representation: 'tiptap_blocks',
      lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, blockTreeFormatVersion: 1, permission: 'write',
      documentSequence: 1, checkpointSequence: 1, stateVector: '', stateProof: null, token: 'test',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), websocketUrl: '/ws/collaboration',
      user: { id: 'user', name: 'User', color: '#123456', colorLight: '#abcdef' } },
    clientState: state, connection: 'live', durability: state.durability, ready: true, status: 'live', error: null,
    setComposition() {}, requestCheckpoint: async () => {
      assert.equal(validateRichMarkdownYDoc(left).valid, true, 'the actual validator accepts the repaired block tree');
      const proof = collaborationStateProof(left, Y);
      assert(proof, 'the repaired document has a complete checkpoint proof');
      await new Promise<void>((resolve) => { settleCheckpoint = () => {
        state = reduceTextCollaborationClientState(state, { type: 'checkpointed', sequence: 10,
          stateVector: Buffer.from(Y.encodeStateVector(left)).toString('base64'), stateProof: proof,
          matchesCurrentDocument: collaborationStateProof(left, Y) === proof });
        refresh(); resolve();
      }; });
    } };
  const onUpdate = () => { state = reduceTextCollaborationClientState(state, { type: 'document_changed' }); refresh(); };
  left.on('update', onUpdate);
  const file: CurrentFile = { path: 'document.md', content: markdown, editorIdentity: 'owner', collaboration: {
    path: 'document.md', strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
    requiresRevisionCheck: false, latestRevision: null, activeLock: null,
    document: { id: 'doc', provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' },
  } };
  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
  useFileStore.setState({ currentFile: file, currentFileWorkspaceId: 'workspace', treeGeneration: 1 });
  const peer = new Editor({ extensions: [
    ...richMarkdownCodecExtensions().map((extension) => extension.name === 'starterKit' ? extension.configure({ undoRedo: false })
      : extension.name === 'uniqueID' ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (transaction: import('@tiptap/pm/state').Transaction) => !isRemoteRichEditorTransaction(transaction) }) : extension),
    ...createRichEditorCollaborationExtensions({ document: right, representation: 'tiptap_blocks', awareness: null,
      user: { name: 'Peer', color: '#123456' } }),
  ] });
  const root = createRoot(document.getElementById('root')!);
  const render = () => act(async () => root.render(<StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
    <MarkdownEditor value={markdown} filePath={file.path} documentKey="owner" expectedCollaborationDocumentId="doc"
      collaborationEnabled mode="rich" onChange={() => {}} />
  </NextIntlClientProvider></StrictMode>));
  const editor = () => {
    const element = document.querySelector('#root .tiptap') as HTMLElement & { editor?: Editor };
    assert(element?.editor); return element.editor;
  };
  const position = (view: Editor, text: string) => {
    let found = -1; view.state.doc.descendants((node, from) => { if (node.isText && node.text === text) found = from; });
    assert(found >= 0, `missing ${text}`); return found;
  };
  const undoButton = () => [...document.querySelectorAll('button')].find((button) => button.textContent === messages.notebook.editorModes.undoRecovery);
  const heldUndo = () => {
    const button = undoButton(); assert(button);
    const key = Object.keys(button).find((name) => name.startsWith('__reactProps')); assert(key);
    return (button as unknown as Record<string, { onClick: () => void }>)[key].onClick;
  };
  const failure = async (code?: string) => {
    state = reduceTextCollaborationClientState({ ...state, connection: 'live' }, { type: 'degraded', code, message: 'Checkpoint rejected' });
    refresh(); await render();
  };
  try {
    await render(); await act(async () => { await Promise.resolve(); });
    await act(async () => {
      const current = editor(); current.commands.setTextSelection(position(current, 'one'));
      assert(current.commands.addRowAfter());
      peer.commands.setTextSelection(position(peer, 'one')); assert(peer.commands.addColumnAfter());
      peer.view.dispatch(peer.state.tr.insertText('Peer ', position(peer, 'one')));
    });
    const expectedPeer = peer.getJSON();
    const visibleBeforeConflict = editor();
    await act(async () => {
      const own = Y.encodeStateAsUpdate(left); const other = Y.encodeStateAsUpdate(right);
      Y.applyUpdate(left, other, 'peer'); Y.applyUpdate(right, own, 'peer');
      assert.equal(validateRichMarkdownYDoc(left).code, 'schema_invalid');
    });
    await failure(COLLABORATION_CHECKPOINT_ERROR_CODES.schemaInvalid);
    assert.equal(document.querySelector('#root .tiptap'), null, 'the actual MarkdownEditor removes an invalid projection');
    assert(visibleBeforeConflict.isDestroyed);
    const history = findBlockTreeHistory(left); assert(history); assert(history.can('undo'));
    assert(undoButton(), 'the document offers its local history even without an editor view');
    const blocked = Y.encodeStateAsUpdate(left);
    const oldUndo = heldUndo();
    for (const code of [COLLABORATION_FAILURE_CODES.persistenceFailed, COLLABORATION_FAILURE_CODES.generationChanged,
      COLLABORATION_FAILURE_CODES.authenticationFailed, COLLABORATION_FAILURE_CODES.startupFailed, undefined]) {
      await failure(code); assert.equal(undoButton(), undefined);
      await act(async () => oldUndo()); assert.deepEqual(Y.encodeStateAsUpdate(left), blocked);
    }
    await failure(COLLABORATION_CHECKPOINT_ERROR_CODES.schemaInvalid);
    await act(async () => oldUndo());
    assert.deepEqual(Y.encodeStateAsUpdate(left), blocked, 'returning to a validation failure cannot revive the old callback');
    const beforeWorkspaceChange = heldUndo();
    await act(async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'other' }); beforeWorkspaceChange();
    });
    assert.deepEqual(Y.encodeStateAsUpdate(left), blocked, 'store changes revoke the command before React finishes rendering');
    await act(async () => useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' }));
    await render();
    const beforePermissionLoss = heldUndo();
    collaboration = { ...collaboration, session: { ...collaboration.session!, permission: 'read' } };
    await render(); assert.equal(undoButton(), undefined);
    await act(async () => beforePermissionLoss()); assert.deepEqual(Y.encodeStateAsUpdate(left), blocked);
    collaboration = { ...collaboration, session: { ...collaboration.session!, permission: 'write' } };
    await render();
    const beforeUnmount = heldUndo();
    await act(async () => root.render(null));
    await act(async () => beforeUnmount()); assert.deepEqual(Y.encodeStateAsUpdate(left), blocked);
    await render(); assert(undoButton());
    await act(async () => beforeUnmount()); assert.deepEqual(Y.encodeStateAsUpdate(left), blocked);
    await act(async () => undoButton()!.click());
    assert.equal(validateRichMarkdownYDoc(left).valid, true);
    assert.deepEqual(readRichDocumentJson(left), expectedPeer, 'own row undo retains every peer column ID and the peer text edit');
    assert.equal(history.can('undo'), false, 'peer changes never enter the local history');
    assert.equal(history.can('redo'), true, 'the inverse remains available to later valid views');
    assert.equal(collaboration.durability, 'degraded'); assert.equal(editor().isEditable, false,
      'repairing the projection does not bypass the paused checkpoint gate');
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left), 'peer');
    assert.deepEqual(readRichDocumentJson(right), readRichDocumentJson(left));
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === messages.notebook.editorModes.retry);
    assert(retry); await act(async () => retry.click());
    assert(settleCheckpoint); assert.equal(editor().isEditable, false);
    await act(async () => settleCheckpoint!()); await render();
    assert.equal(collaboration.durability, 'checkpointed_file'); assert.equal(editor().isEditable, true);
    await act(async () => {
      const current = editor(); current.view.dispatch(current.state.tr.insertText('Restored ', position(current, 'Peer one')));
    });
    assert.match(editor().state.doc.textContent, /Restored Peer one/);
    assert.equal(validateRichMarkdownYDoc(left).valid, true);
    await act(async () => root.render(null));
    left.destroy(); assert.equal(history.can('undo'), false); assert.equal(history.undoLastLocalChange(), false);
    assert.equal(findBlockTreeHistory(left), null, 'destroyed document histories cannot be reopened through recovery');
    console.log('Actual MarkdownEditor recovers an invalid merged table after view removal, preserves peer IDs/text, fences stale recovery commands and waits for an exact checkpoint.');
  } finally {
    await act(async () => root.unmount());
    peer.destroy(); if (!left.isDestroyed) left.destroy(); right.destroy();
    internals._load = originalLoad; dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
