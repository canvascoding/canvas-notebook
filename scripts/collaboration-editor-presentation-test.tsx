import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import type { CollaborationDocument } from '../app/lib/collaboration/client';
import { createInitialTextCollaborationClientState, textCollaborationLegacyStatus, type TextCollaborationClientState } from '../app/lib/collaboration/client-state';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { collaborationEditorIssue, canRenderCollaborationDocument } from '../app/lib/collaboration/editor-presentation';
import messages from '../messages/en.json';

async function main() {
  const dom = new JSDOM('<main style="position:relative"><div id="root"></div><article id="document">Document content</article></main>', { url: 'https://canvas.test' });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
  const { MarkdownSaveState } = await import('../app/components/editor/MarkdownDocumentModes');
  const { useFileStore } = await import('../app/store/file-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  useFileStore.setState({ currentFile: null, currentFileWorkspaceId: null });
  useWorkspaceStore.setState({ activeWorkspaceId: null });
  const root = createRoot(document.getElementById('root')!);
  const doc = new Y.Doc(); doc.getText('content').insert(0, 'Original text'); doc.getText('content').delete(0, 9);
  const baseline = { ...createInitialTextCollaborationClientState(), ready: true, indexedDbHydrated: true,
    remoteSynced: true, connection: 'live' as const, documentSequence: 2, checkpointSequence: 1 };
  let state: TextCollaborationClientState = { ...baseline };
  let reloads = 0;
  let requests = 0;
  let available = true;
  const baseSession: NonNullable<CollaborationDocument['session']> = {
    success: true, documentId: 'document', documentName: 'document', provider: 'yjs', representation: 'plain_text',
    lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, permission: 'write', documentSequence: 2, checkpointSequence: 1,
    stateVector: '', stateProof: null, token: 'private-token', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    websocketUrl: '/ws/collaboration', user: { id: 'user', name: 'User', color: '#123456', colorLight: '#abcdef' },
  };
  let session = baseSession;
  let currentDoc = doc;
  let current!: CollaborationDocument;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  const blobs: Blob[] = [];
  const originalCreateUrl = URL.createObjectURL;
  const originalRevokeUrl = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { assert(blob instanceof Blob); blobs.push(blob); return 'blob:test'; };
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  const render = async () => {
    current = { registryKey: 'guest:document', doc: currentDoc, provider: null, session, clientState: state,
      ready: state.ready, connection: state.connection, durability: state.durability,
      error: state.error, status: textCollaborationLegacyStatus(state), setComposition() {},
      requestCheckpoint: async () => { requests++; } };
    await act(async () => root.render(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <MarkdownSaveState collaboration={current} available={available} content="text" filePath="private-name.md" onReload={() => { reloads++; }} />
    </NextIntlClientProvider>));
  };
  const button = (name: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === name);
  try {
    const normalStates = ['local_pending', 'server_received', 'checkpoint_pending', 'persisted_yjs', 'checkpointed_file'] as const;
    for (const durability of normalStates) {
      for (let i = 0; i < 20; i++) {
        state = { ...baseline, durability, documentSequence: i + 2, unsyncedChanges: durability === 'local_pending' ? i + 1 : 0 };
        await render();
        assert.equal(document.getElementById('root')!.childElementCount, 0, `${durability} inserts no UI into document layout`);
      }
    }
    for (const connection of ['offline', 'reconnecting', 'read_only', 'connecting'] as const) {
      state = { ...baseline, connection, durability: 'local_pending', unsyncedChanges: 2 };
      await render(); assert.equal(document.getElementById('root')!.textContent, '');
    }
    state = { ...baseline, ready: false, indexedDbHydrated: false, remoteSynced: false };
    await render(); assert.equal(document.getElementById('root')!.childElementCount, 0, 'loading belongs to the document placeholder, not another status row');
    state = { ...baseline, durability: 'persisted_yjs', projectionError: { code: 'COLLABORATION_ROUNDTRIP_UNSTABLE', sequence: 2 } };
    await render(); assert.equal(document.getElementById('root')!.childElementCount, 0);
    assert.equal(requests, 0, 'status rendering never requests a Markdown checkpoint');
    assert.equal(warnings.length, 0, 'routine work has no per-edit log spam');

    state = { ...baseline, durability: 'degraded', failure: { kind: 'storage', code: 'COLLABORATION_YJS_PERSISTENCE_FAILED' }, error: 'secret-stack-and-private-filename' };
    await render();
    const panel = document.querySelector('aside')!;
    assert(panel.classList.contains('absolute'), 'failure overlays the editor without participating in its vertical layout');
    assert(document.querySelector('[role="alert"]')!.textContent!.includes(messages.notebook.editorModes.failure.storage));
    assert(!document.body.textContent!.includes('secret-stack'));
    assert(!document.body.textContent!.includes('private-name'));
    assert.equal(document.querySelector('pre'), null, 'developer details are absent without opt-in');
    await render(); assert.equal(warnings.length, 1, 'one diagnostic for the same ongoing failure');
    assert(!JSON.stringify(warnings).includes('secret-stack')); assert(!JSON.stringify(warnings).includes('private-token'));

    available = false;
    await render();
    assert(!button(messages.notebook.editorModes.backup));
    assert(button(messages.notebook.editorModes.snapshot), 'binary backup survives unavailable Markdown and absent account workspace');
    await act(async () => button(messages.notebook.editorModes.snapshot)!.click());
    assert.equal(blobs.length, 1);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, new Uint8Array(await blobs[0].arrayBuffer()));
    assert.equal(restored.getText('content').toString(), doc.getText('content').toString());
    assert.deepEqual(Y.encodeStateAsUpdate(restored), Y.encodeStateAsUpdate(doc)); restored.destroy();

    state = { ...state, connection: 'denied', failure: { kind: 'authentication', code: 'COLLABORATION_AUTHENTICATION_FAILED' } };
    await render(); assert(button(messages.notebook.editorModes.reopen));
    assert(!button(messages.notebook.editorModes.retry)); assert(!button(messages.notebook.editorModes.recoverCopy));
    await act(async () => button(messages.notebook.editorModes.reopen)!.click()); assert.equal(reloads, 1);

    await act(async () => {
      dom.window.history.pushState({}, '', '?collaborationDebug=1'); dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
    });
    assert(document.querySelector('pre')!.textContent!.includes('secret-stack-and-private-filename'));
    assert(document.querySelector('pre')!.textContent!.includes('documentSequence'));
    assert(!document.querySelector('pre')!.textContent!.includes('private-token'), 'diagnostics never include authentication tokens');
    await act(async () => { dom.window.history.pushState({}, '', '/'); dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate')); });
    assert.equal(document.querySelector('pre'), null);

    state = { ...baseline, durability: 'persisted_yjs' }; available = true;
    await render(); assert.equal(document.getElementById('root')!.childElementCount, 0, 'recovered failure leaves no status indicator');
    const rich = new Y.Doc();
    const schema = getSchema(richMarkdownCodecExtensions());
    CollaborationBlockTree.create(rich, schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'p' }, content: [{ type: 'text', text: 'Live structured content' }] }] }));
    currentDoc = rich; session = { ...baseSession, representation: 'tiptap_blocks' }; available = false;
    await render();
    assert(canRenderCollaborationDocument(current, false));
    assert.equal(collaborationEditorIssue(current, false), null, 'a usable structured document remains editable when text export fails');
    assert.equal(document.getElementById('root')!.childElementCount, 0);
    rich.getMap('canvas-block-tree-v1').set('version', -1);
    await render(); assert.equal(collaborationEditorIssue(current, false), 'unavailable');
    assert(button(messages.notebook.editorModes.snapshot), 'invalid structure retains the independent binary backup');
    rich.destroy();
    assert.equal(document.getElementById('document')!.textContent, 'Document content');
    console.log('Editor presentation: ordinary changes stay invisible; actionable failures preserve recovery without layout rows; diagnostics require opt-in.');
  } finally {
    await act(async () => root.unmount());
    console.warn = originalWarn; URL.createObjectURL = originalCreateUrl; URL.revokeObjectURL = originalRevokeUrl;
    doc.destroy(); dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
