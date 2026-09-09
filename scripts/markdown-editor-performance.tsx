import assert from 'node:assert/strict';
import Module from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import type { CollaborationDocument } from '../app/lib/collaboration/client';
import { createInitialTextCollaborationClientState } from '../app/lib/collaboration/client-state';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';
import { getReorderableBlockRangeAt, moveReorderableBlock } from '../app/lib/editor/reorderable-blocks';
import messages from '../messages/en.json';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://canvas.test', pretendToBeVisual: true });
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
dom.window.HTMLElement.prototype.scrollIntoView = () => {};

const samples = 7;
const warmups = 2;
const sizes = (process.env.CANVAS_EDITOR_BENCH_SIZES ?? '100,1000,5000').split(',').map(Number);
assert(sizes.length && sizes.every(size => Number.isInteger(size) && size >= 3 && size <= 5000));
const modes = ['binding', 'react-local', 'react-collaboration'].filter(mode => !process.env.CANVAS_EDITOR_BENCH_MODES
  || process.env.CANVAS_EDITOR_BENCH_MODES.split(',').includes(mode));
assert(modes.length, 'CANVAS_EDITOR_BENCH_MODES must select a known mode');

function quantiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], samplesMs: values };
}

function identities(editor: Editor) {
  const values = new Map<string, string>();
  editor.state.doc.descendants(node => {
    if (node.isText) return;
    assert.equal(typeof node.attrs.id, 'string');
    assert.equal(values.has(node.attrs.id), false, 'no duplicate block identity');
    values.set(node.attrs.id, node.textContent);
  });
  return values;
}

async function main() {
  const { useFileStore } = await import('../app/store/file-store');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  let collaboration: CollaborationDocument | null = null;
  // The production component and bindings run unchanged. Only transport and
  // unrelated previews/theme are stubbed. This is not a browser benchmark.
  internals._load = (request, parent, isMain) => {
    if (request === 'server-only') return {};
    if (request === '@/app/lib/collaboration/client') return {
      useCollaborationDocument: () => collaboration,
      useTextCollaborationSession: () => ({ session: collaboration?.session ?? null, error: null, loading: false, retry() {} }),
    };
    if (request === './CodeEditorClient') return originalLoad('./CodeEditor', parent, isMain);
    if (request === '@/components/ui/mermaid-diagram') return { MermaidDiagram: () => null };
    if (request === '@/app/components/shared/MarkdownRenderer') return { MarkdownRenderer: ({ content }: { content: string }) => <pre>{content}</pre> };
    if (request === '@/app/components/ThemeProvider') return { useTheme: () => ({ resolvedTheme: 'light' }) };
    if (request === '@/app/components/shared/WorkspaceDocumentPreviewDialog') return { WorkspaceDocumentPreviewDialog: () => null };
    return originalLoad(request, parent, isMain);
  };
  try {
    const { createRichMarkdownYDoc, convertRichMarkdownYDoc, validateRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { MarkdownEditor } = await import('../app/components/editor/MarkdownEditor');
    const results = [];
    for (const size of sizes) for (const mode of modes) {
      console.log(`Measuring ${mode}, ${size} paragraphs...`);
      const markdown = Array.from({ length: size }, (_, i) => `P${i}: **bold** text.`).join('\n\n');
      const legacy = createRichMarkdownYDoc(markdown);
      const doc = convertRichMarkdownYDoc(legacy, 'tiptap_blocks'); legacy.destroy();
      const peer = new Y.Doc();
      const reopened = new Y.Doc();
      const container = document.createElement('div'); document.body.append(container);
      const root = mode === 'binding' ? null : createRoot(container);
      let editor: Editor | undefined;
      let emitted: string | undefined;
      try {
        const filePath = `benchmark-${mode}-${size}.md`;
        const owner = `${mode}-${size}`;
        useWorkspaceStore.setState({ activeWorkspaceId: 'benchmark' });
        useFileStore.setState({ currentFile: { path: filePath, content: markdown, editorIdentity: owner }, currentFileWorkspaceId: 'benchmark' });
        const state = { ...createInitialTextCollaborationClientState(), ready: true, indexedDbHydrated: true,
          remoteSynced: true, connection: 'live' as const, documentSequence: 1, checkpointSequence: 1 };
        collaboration = mode !== 'react-collaboration' ? null : {
          registryKey: ['benchmark', owner, 'doc', '1', 'tiptap_blocks'].join('\0'), doc,
          provider: { awareness: null } as unknown as NonNullable<CollaborationDocument['provider']>,
          session: { success: true, documentId: 'doc', documentName: 'doc', provider: 'yjs', representation: 'tiptap_blocks',
            lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3, blockTreeFormatVersion: 1, permission: 'write',
            documentSequence: 1, checkpointSequence: 1, stateVector: '', stateProof: null, token: 'benchmark',
            expiresAt: new Date(Date.now() + 60_000).toISOString(), websocketUrl: '/ws/collaboration',
            user: { id: 'user', name: 'User', color: '#123456', colorLight: '#abcdef' } },
          clientState: state, connection: 'live', durability: state.durability, ready: true, status: 'live', error: null,
          setComposition() {}, requestCheckpoint: async () => {},
        };
        const mountStart = performance.now();
        if (mode === 'binding') {
          editor = new Editor({ element: container, extensions: [
            ...richMarkdownCodecExtensions().map(extension => extension.name === 'starterKit' ? extension.configure({ undoRedo: false })
              : extension.name === 'uniqueID' ? CanvasUniqueID.configure({ types: 'all', filterTransaction: transaction => !isRemoteRichEditorTransaction(transaction) }) : extension),
            ...createRichEditorCollaborationExtensions({ document: doc, representation: 'tiptap_blocks', awareness: null, user: { name: 'User', color: '#123456' } }),
          ] });
          await Promise.resolve();
        } else {
          await act(async () => root!.render(<StrictMode><NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
            <MarkdownEditor value={markdown} filePath={filePath} documentKey={owner} expectedCollaborationDocumentId="doc"
              collaborationEnabled={mode === 'react-collaboration'} mode="rich" onChange={value => { emitted = value; }} />
          </NextIntlClientProvider></StrictMode>));
          editor = (container.querySelector('.tiptap') as HTMLElement & { editor?: Editor })?.editor;
        }
        const mountMs = performance.now() - mountStart;
        assert(editor && !editor.isDestroyed, 'the real rich editor must be mounted');
        const current = editor;
        assert.equal(current.state.doc.childCount, size);
        const initialJson = JSON.stringify(current.getJSON());
        const initialContents = identities(current);
        const firstId = current.state.doc.firstChild!.attrs.id;
        const move: number[] = [], undo: number[] = [], redo: number[] = [], remote: number[] = [];
        const dispatchMove: number[] = [];
        const run = async (operation: () => void) => {
          if (mode === 'binding') { operation(); await Promise.resolve(); }
          else await act(async () => operation());
        };
        const measure = async (operation: () => void, values: number[], recorded: boolean) => {
          const start = performance.now(); await run(operation);
          if (recorded) values.push(performance.now() - start);
        };
        for (let iteration = 0; iteration < warmups + samples; iteration++) {
          const recorded = iteration >= warmups;
          await measure(() => {
            const start = performance.now();
            assert(moveReorderableBlock(current, getReorderableBlockRangeAt(current, 1)!, current.state.doc.content.size));
            if (recorded) dispatchMove.push(performance.now() - start);
          }, move, recorded);
          assert.equal(current.state.doc.lastChild!.attrs.id, firstId);
          await measure(() => { assert(current.commands.undo()); }, undo, recorded);
          assert.equal(JSON.stringify(current.getJSON()), initialJson, 'one undo restores IDs, marks and order');
          await measure(() => { assert(current.commands.redo()); }, redo, recorded);
          assert.equal(current.state.doc.lastChild!.attrs.id, firstId);
          await run(() => { assert(current.commands.undo()); });
        }
        assert.equal(JSON.stringify(current.getJSON()), initialJson);
        assert.equal(JSON.stringify([...identities(current)]), JSON.stringify([...initialContents]));
        let checkpointMs: number | null = null;
        if (mode !== 'react-local') {
          Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
          const peerTree = new CollaborationBlockTree(peer, current.schema);
          const text = peerTree.content(firstId).get(0) as Y.XmlText;
          for (let iteration = 0; iteration < warmups + samples; iteration++) {
            const before = Y.encodeStateVector(doc);
            text.insert(0, 'x');
            const update = Y.encodeStateAsUpdate(peer, before);
            await measure(() => Y.applyUpdate(doc, update, 'benchmark-peer'), remote, iteration >= warmups);
          }
          assert.equal(current.state.doc.firstChild!.textContent, 'x'.repeat(warmups + samples) + initialContents.get(firstId));
          const bytes = Y.encodeStateAsUpdate(doc);
          const start = performance.now();
          const result = validateRichMarkdownYDoc(doc); checkpointMs = performance.now() - start;
          assert.equal(result.valid, true, result.code ?? 'the checkpoint must be valid');
          assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes, 'validation is read-only');
          Y.applyUpdate(reopened, bytes);
          assert.equal(JSON.stringify(new CollaborationBlockTree(reopened, current.schema).read().toJSON()), JSON.stringify(current.getJSON()));
        } else assert.equal(emitted?.trim(), markdown, 'the real local model emits the restored Markdown');
        results.push({ mode, paragraphs: size, mountMs, moveDispatch: quantiles(dispatchMove), moveSettled: quantiles(move),
          undoSettled: quantiles(undo), redoSettled: quantiles(redo), remoteSettled: remote.length ? quantiles(remote) : null, checkpointMs });
      } finally {
        if (root) await act(async () => root.unmount());
        if (editor && !editor.isDestroyed) editor.destroy();
        container.remove(); doc.destroy(); peer.destroy(); reopened.destroy(); collaboration = null;
      }
    }
    const report = {
      schemaVersion: 1, measuredAt: new Date().toISOString(),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
      runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
      method: { samples, warmups, units: 'milliseconds',
        scope: 'JSDOM CPU and actual Tiptap/React component work. React development build under StrictMode. No browser paint/layout, native pointer latency, network, database or IndexedDB.',
        setup: 'Document seeding, peer update generation, assertions and cleanup excluded. Mount is a single cold observation per case, not a quantile.',
        settled: 'Synchronous command plus React act completion (binding: one microtask). Scheduled animation frames and unrelated future timers excluded.',
        validation: 'Each move/undo/redo verifies current IDs/order. Collaborative cases verify peer text, read-only strict checkpoint and binary reopen. No timing pass/fail threshold.' },
      results,
    };
    const index = process.argv.indexOf('--output');
    if (index >= 0) { assert(process.argv[index + 1]); writeFileSync(process.argv[index + 1], JSON.stringify(report, null, 2) + '\n'); }
    console.table(results.map(row => ({ mode: row.mode, paragraphs: row.paragraphs, mountMs: row.mountMs.toFixed(1),
      dispatchP50: row.moveDispatch.p50Ms.toFixed(1), settledP50: row.moveSettled.p50Ms.toFixed(1), settledP95: row.moveSettled.p95Ms.toFixed(1),
      undoP50: row.undoSettled.p50Ms.toFixed(1), remoteP50: row.remoteSettled?.p50Ms.toFixed(1) ?? '-' })));
  } finally { internals._load = originalLoad; dom.window.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
