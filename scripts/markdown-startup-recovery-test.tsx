import { committedCollaborationTestDatabase } from './collaboration-client-test-storage';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type * as Client from '../app/lib/collaboration/client';
import type { CurrentFile } from '../app/lib/files/types';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
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
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();

async function main() {
  const { useFileStore } = await import('../app/store/file-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Startup recovery must not issue file writes or checkpoints.'); };
  let failure: 'module' | 'storage' | 'hydration' | 'provider' | null = null;
  let current: Client.CollaborationDocument | null = null;
  let session!: CollaborationSessionResponse;
  let owner = 0;
  let file!: CurrentFile;
  const hydrations: { doc: Y.Doc; finish: () => void; reject: () => void }[] = [];
  type ProviderOptions = { awareness: Awareness; onSynced: () => void;
    onStatus: (event: { status: string }) => void; onAuthenticationFailed: (event: { reason: string }) => void };
  const providers: FakeProvider[] = [];
  class FakeProvider {
    awareness: Awareness;
    constructor(readonly options: ProviderOptions) {
      if (failure === 'provider') throw new Error('Provider construction failed');
      this.awareness = options.awareness; providers.push(this);
    }
    setAwarenessField(name: string, value: unknown) { this.awareness.setLocalStateField(name, value); }
    sendStateless() {}
    disconnect() {}
    destroy() { this.awareness.destroy(); }
  }
  class FakePersistence {
    synced = false;
    db = committedCollaborationTestDatabase();
    whenSynced: Promise<void>;
    constructor(_name: string, doc: Y.Doc) {
      if (failure === 'storage') throw new Error('Local storage construction failed');
      this.whenSynced = new Promise<void>((resolve, reject) => {
        hydrations.push({ doc, finish: () => { Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed)); this.synced = true; resolve(); },
          reject: () => reject(new Error('Local hydration failed')) });
      });
    }
    destroy() {}
  }
  // Compile the real registry with controlled startup boundaries. The editor,
  // client state machine, projections and recovery controls remain production code.
  const filename = path.resolve('app/lib/collaboration/client.ts');
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const client = {} as typeof Client;
  const requireMock = (name: string) => {
    if (name === '@hocuspocus/provider') {
      if (failure === 'module') throw new Error('Transport module failed to load');
      return { HocuspocusProvider: FakeProvider };
    }
    return name === 'y-indexeddb' ? { IndexeddbPersistence: FakePersistence } : load(name);
  };
  new Function('require', 'module', 'exports', compiled.outputText)(requireMock, { exports: client }, client);
  internals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/collaboration/client') return { ...client,
      useCollaborationDocument: (input: Parameters<typeof client.useCollaborationDocument>[0]) => {
        current = client.useCollaborationDocument(input); return current;
      },
      useTextCollaborationSession: () => ({ session, error: null, loading: false, retry() {} }),
    };
    if (request === './CodeEditorClient') return originalLoad('./CodeEditor', parent, isMain);
    if (request === '@/components/ui/mermaid-diagram') return { MermaidDiagram: () => null };
    if (request === '@/app/components/shared/MarkdownRenderer') return { MarkdownRenderer: ({ content }: { content: string }) => <pre>{content}</pre> };
    if (request === '@/app/components/ThemeProvider') return { useTheme: () => ({ resolvedTheme: 'light' }) };
    if (request === '@/app/components/shared/WorkspaceDocumentPreviewDialog') return { WorkspaceDocumentPreviewDialog: () => null };
    if (request === 'sonner') return { toast: { error() {}, warning() {}, success() {} } };
    return originalLoad(request, parent, isMain);
  };
  const { createRichMarkdownYDoc, convertRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
  const legacy = createRichMarkdownYDoc('Local draft'); const seed = convertRichMarkdownYDoc(legacy, 'tiptap_blocks'); legacy.destroy();
  const { MarkdownEditor } = await import('../app/components/editor/MarkdownEditor');
  const root = createRoot(document.getElementById('root')!);
  const until = async (predicate: () => boolean) => {
    for (let i = 0; !predicate() && i < 50; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert(predicate());
  };
  const get = () => { assert(current); return current; };
  const text = () => document.body.textContent ?? '';
  const button = (label: string) => [...document.querySelectorAll('button')].find((element) => element.textContent === label);
  const labels = messages.notebook.editorModes;
  const noEditor = () => assert.equal(document.querySelector('.tiptap, .cm-editor'), null);
  const noWriteControls = () => {
    for (const label of [labels.undoRecovery, labels.retry, labels.recoverCopy]) assert.equal(button(label), undefined);
  };
  const fixture = async (next: typeof failure) => {
    failure = next; owner++;
    session = { success: true, documentId: `doc-${owner}`, documentName: `doc-${owner}`, provider: 'yjs', representation: 'tiptap_blocks',
      lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, blockTreeFormatVersion: 1, permission: 'write',
      documentSequence: 1, checkpointSequence: 0, stateVector: '', stateProof: null, token: 'test',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), websocketUrl: '/ws/collaboration',
      user: { id: 'user', name: 'User', color: '#123456', colorLight: '#abcdef' } };
    file = { path: 'document.md', content: 'File fallback', editorIdentity: String(owner), collaboration: {
      path: 'document.md', strategy: 'crdt_text', crdtCapable: true, sceneCapable: false, lockRequired: false,
      requiresRevisionCheck: false, latestRevision: null, activeLock: null,
      document: { id: session.documentId, provider: 'yjs', stateVersion: 1, snapshotRevisionId: null, status: 'active' },
    } };
    await act(async () => {
      useWorkspaceStore.setState({ activeWorkspaceId: 'workspace' });
      useFileStore.setState({ currentFile: file, currentFileWorkspaceId: 'workspace', treeGeneration: owner });
      root.render(<StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        <MarkdownEditor value={file.content} filePath={file.path} documentKey={file.editorIdentity} collaborationEnabled
          expectedCollaborationDocumentId={session.documentId} mode="rich" />
      </NextIntlClientProvider></StrictMode>);
    });
    await until(() => current?.session?.documentId === session.documentId);
    noEditor(); return get().doc;
  };
  const hydration = () => { const item = hydrations.findLast((item) => item.doc === get().doc); assert(item); return item; };
  const originalCreateUrl = URL.createObjectURL;
  const originalRevokeUrl = URL.revokeObjectURL;
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  const downloads: { blob: Blob; name: string }[] = [];
  let pendingBlob: Blob;
  URL.createObjectURL = (blob: Blob) => { pendingBlob = blob; return 'blob:recovery'; };
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push({ blob: pendingBlob, name: this.download }); };
  try {
    for (const next of ['module', 'storage', 'hydration'] as const) {
      const doc = await fixture(next);
      if (next === 'hydration') await act(async () => hydration().reject());
      await until(() => get().clientState.failure?.kind === 'startup');
      assert(text().includes(labels.failure.startup)); assert(text().includes(labels.recoveryNotLoaded));
      assert.equal(get().clientState.indexedDbHydrated, false); assert.equal(get().ready, false);
      assert.equal(button(labels.snapshot), undefined); assert.equal(button(labels.backup), undefined); noWriteControls();
      assert.deepEqual(Y.encodeStateAsUpdate(doc), new Uint8Array([0, 0])); noEditor();
    }
    await fixture('provider'); await act(async () => hydration().finish());
    await until(() => get().clientState.failure?.kind === 'startup');
    assert.equal(get().clientState.indexedDbHydrated, true); assert.equal(get().ready, false);
    assert(text().includes(labels.recoveryLocalOnly)); noEditor();
    assert(button(labels.snapshot)); assert(button(labels.backup), text()); assert(button(labels.recoverCopy));
    assert.equal(button(labels.retry), undefined); assert.equal(button(labels.undoRecovery), undefined);
    await act(async () => { button(labels.snapshot)!.click(); button(labels.backup)!.click(); });
    assert.deepEqual(new Uint8Array(await downloads[0].blob.arrayBuffer()), Y.encodeStateAsUpdate(get().doc));
    assert.equal(await downloads[1].blob.text(), 'Local draft');

    await fixture(null); assert(text().includes(labels.opening)); assert.equal(button(labels.snapshot), undefined);
    const oldHydration = hydration();
    await fixture(null); const nextDoc = get().doc;
    await act(async () => oldHydration.finish());
    assert.equal(get().doc, nextDoc); assert.equal(get().clientState.indexedDbHydrated, false);
    await act(async () => hydration().finish());
    await until(() => !!get().provider);
    assert(get().ready); assert.equal(get().clientState.remoteSynced, false);
    assert(document.querySelector('.tiptap[contenteditable="true"]')?.textContent?.includes('Local draft'));
    assert.equal(document.querySelector('[data-testid="markdown-save-state"]'), null);
    const provider = providers.at(-1)!;
    await act(async () => provider.options.onStatus({ status: 'disconnected' }));
    assert(get().ready); assert.equal(get().connection, 'offline');
    assert(document.querySelector('.tiptap[contenteditable="true"]'));
    await act(async () => provider.options.onAuthenticationFailed({ reason: 'Access denied before first sync' }));
    assert(text().includes(labels.failure.authentication)); assert(button(labels.snapshot)); noWriteControls();
    assert(document.querySelector('.tiptap[contenteditable="false"]')?.textContent?.includes('Local draft'));
    await act(async () => provider.options.onStatus({ status: 'connected' }));
    assert.equal(get().connection, 'denied'); noWriteControls();
    assert(document.querySelector('.tiptap[contenteditable="false"]'));

    await fixture(null); await act(async () => hydration().finish());
    await until(() => !!get().provider);
    await act(async () => providers.at(-1)!.options.onSynced());
    assert(get().ready); assert(document.querySelector('.tiptap[contenteditable="true"]'));
    assert(document.querySelector('.tiptap')?.textContent?.includes('Local draft'));
    assert.equal(text().includes(labels.recoveryNotLoaded), false);
    console.log('Actual MarkdownEditor exposes pre-sync module/storage/provider/auth failures, gates incomplete backups, exports exact local state and rejects stale hydration.');
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    seed.destroy(); internals._load = originalLoad; globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateUrl; URL.revokeObjectURL = originalRevokeUrl;
    dom.window.HTMLAnchorElement.prototype.click = originalClick; dom.window.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
