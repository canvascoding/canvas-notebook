import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import * as Y from 'yjs';
import enMessages from '../messages/en.json';
import deMessages from '../messages/de.json';
import type * as Modes from '../app/components/editor/MarkdownDocumentModes';
import type { CollaborationDocument } from '../app/lib/collaboration/client';
import { createInitialTextCollaborationClientState } from '../app/lib/collaboration/client-state';
import { COLLABORATION_FAILURE_CODES } from '../app/lib/collaboration/failure';

type Controls = { owner: object; copies: number; documentId?: string; path: string; workspaceId: string };

async function compileUi(controls: Controls, locale: 'de' | 'en') {
  const filename = path.resolve('app/components/editor/MarkdownDocumentModes.tsx');
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const messages = locale === 'de' ? deMessages : enMessages;
  const fileState = () => ({ currentFileWorkspaceId: controls.workspaceId, treeGeneration: 1,
    currentFile: { path: controls.path, editorIdentity: controls.owner,
      collaboration: { crdtCapable: true, document: { id: controls.documentId } } } });
  const workspaceState = () => ({ activeWorkspaceId: controls.workspaceId });
  const translate = (namespace: string) => (key: string, values?: Record<string, string | number>) => {
    const value = `${namespace}.${key}`.split('.').reduce<unknown>((object, part) => object && typeof object === 'object'
      ? (object as Record<string, unknown>)[part] : null, messages);
    assert.equal(typeof value, 'string', `Missing ${locale} translation: ${namespace}.${key}`);
    return String(value).replace(/\{(\w+)\}/gu, (_, name: string) => String(values?.[name] ?? `{${name}}`));
  };
  const mocks: Record<string, unknown> = {
    'next-intl': { useTranslations: translate },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '@/components/ui/button': { Button: ({ children, variant: _variant, size: _size, ...props }:
      React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props}>{children}</button> },
    '@/app/lib/collaboration/editor-presentation': load('../../lib/collaboration/editor-presentation'),
    '@/app/components/notebook/NotebookFocusContext': { NotebookFocusContext: React.createContext(null) },
    '@/app/lib/files/client': { workspaceHeaders: () => ({}) },
    '@/app/lib/collaboration/local-recovery': { recordExportedCollaborationRecovery: () => {} },
    '@/app/store/file-store': { useFileStore: Object.assign((selector: (state: ReturnType<typeof fileState>) => unknown) => selector(fileState()),
      { getState: fileState }) },
    '@/app/store/workspace-store': { useWorkspaceStore: Object.assign((selector: (state: ReturnType<typeof workspaceState>) => unknown) => selector(workspaceState()),
      { getState: workspaceState }) },
    '@/app/lib/collaboration/markdown-recovery-client': { useMarkdownRecoveryCopy: (collaboration: CollaborationDocument) => {
      const owner = controls.owner;
      const permission = collaboration.session?.permission;
      const denied = collaboration.connection === 'denied';
      const actionScope = React.useMemo(() => ({ owner, permission, denied }), [owner, permission, denied]);
      const eligible = permission === 'write' && !denied;
      return { actionScope, canCreate: eligible, busy: false, error: null, copyPath: null,
        isCurrent: () => eligible && controls.owner === owner, createCopy: async () => { controls.copies++; } };
    } },
    '@/app/lib/collaboration/block-tree-history': { findBlockTreeHistory: () => null },
    '@/app/lib/collaboration/block-tree': { BLOCK_TREE_KEY: 'unused-rich-tree' },
    '@/app/lib/markdown/rich-markdown-codec': {},
    '@/app/lib/markdown/core/equivalence': {},
    '@/app/lib/markdown/obsidian-metadata': {},
    '@/app/lib/collaboration/rich-document': {},
    '@/app/lib/collaboration/types': load('../../lib/collaboration/types'),
  };
  const exports = {} as typeof Modes;
  new Function('require', 'module', 'exports', compiled)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : load(name),
    { exports }, exports);
  return exports.MarkdownSaveState;
}

function document(doc: Y.Doc, id: string, request: () => Promise<void>, checkpoint: () => Promise<void>): CollaborationDocument {
  return {
    registryKey: `workspace\0user\0${id}`, doc, provider: null, status: 'degraded', connection: 'denied', durability: 'degraded',
    ready: true, error: 'The previous location needs fresh authorization.', setComposition: () => {}, requestCheckpoint: checkpoint,
    session: { success: true, provider: 'yjs', documentId: id, documentName: id, lifecycleGeneration: 1,
      representation: 'plain_text', permission: 'read', schemaVersion: 1, richTextSchemaVersion: 3,
      token: 'test-only-ticket', websocketUrl: '/ws/collaboration', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { id: 'user', name: 'User', color: '#123456', colorLight: '#abcdef' } },
    clientState: { ...createInitialTextCollaborationClientState(), connection: 'denied', durability: 'degraded',
      ready: true, indexedDbHydrated: true, remoteSynced: true,
      failure: { kind: 'authentication', code: COLLABORATION_FAILURE_CODES.authenticationFailed } },
    requestLocationRevalidation: request, canRevalidateLocation: true, revalidatingLocation: false,
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function main() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://canvas.test' });
  for (const key of ['window', 'document', 'HTMLElement'] as const) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(globalThis.document.getElementById('root')!);
  const docs: Y.Doc[] = [];
  try {
    for (const locale of ['de', 'en'] as const) {
      const controls: Controls = { owner: {}, copies: 0, path: 'Ziel/Gemeinsam.md', workspaceId: 'workspace' };
      const SaveState = await compileUi(controls, locale);
      const labels = (locale === 'de' ? deMessages : enMessages).notebook.editorModes;
      const seed = new Y.Doc(); seed.getText('content').insert(0, 'Accepted local draft'); docs.push(seed);
      let locationCalls = 0;
      let checkpointCalls = 0;
      let reloadCalls = 0;
      let gate = deferred();
      const request = async () => { locationCalls++; await gate.promise; };
      const checkpoint = async () => { checkpointCalls++; };
      let current = document(seed, `doc-${locale}`, request, checkpoint);
      const render = () => {
        controls.documentId = current.session?.documentId;
        return act(async () => root.render(<SaveState collaboration={current} content="Accepted local draft"
          available filePath={controls.path} onReload={() => { reloadCalls++; }} />));
      };
      const button = (label: string) => [...globalThis.document.querySelectorAll<HTMLButtonElement>('button')]
        .find((element) => element.textContent === label);
      const revalidation = () => globalThis.document.querySelector<HTMLButtonElement>('[data-testid="markdown-location-revalidation"]');
      const heldHandler = () => {
        const element = revalidation(); assert.ok(element);
        const key = Object.keys(element).find((name) => name.startsWith('__reactProps')); assert.ok(key);
        return (element as unknown as Record<string, { onClick: () => Promise<void> }>)[key].onClick;
      };

      await render();
      assert.equal(revalidation()?.textContent, labels.revalidateLocation);
      assert.equal(button(labels.retry), undefined, 'location recovery never masquerades as a checkpoint retry');
      assert.equal(button(labels.reopen), undefined, 'one relevant reconnect action replaces the generic reopen action');
      const firstHandler = heldHandler();
      let pending!: Promise<void>;
      await act(async () => { pending = firstHandler(); await firstHandler(); });
      assert.equal(locationCalls, 1, 'a denied/read session may reconnect, and two immediate invocations start one core request');
      assert.equal(checkpointCalls, 0);
      assert.equal(revalidation()?.disabled, true);
      assert.equal(revalidation()?.textContent, labels.revalidatingLocation);
      assert.ok(button(labels.backup), 'download remains available during reconnection');
      current = { ...current, canRevalidateLocation: false, revalidatingLocation: true,
        requestLocationRevalidation: async () => { throw new Error('This newly emitted callback must not replace the running request'); },
        connection: 'reconnecting', session: { ...current.session!, permission: 'write' },
        clientState: { ...current.clientState, connection: 'reconnecting' } };
      await render();
      assert.equal(revalidation()?.textContent, labels.revalidatingLocation, 'core Pending stays visible when its capability is temporarily false');
      await act(async () => { gate.reject(new Error('Internal endpoint detail')); await pending; });
      current = { ...current, canRevalidateLocation: true, revalidatingLocation: false,
        requestLocationRevalidation: () => request() };
      await render();
      assert.equal(globalThis.document.querySelector('[data-testid="markdown-location-revalidation-error"]')?.textContent,
        labels.locationRevalidationFailed, 'Pending capability toggles cannot discard a genuine failure');
      assert.ok(!globalThis.document.body.textContent?.includes('Internal endpoint detail'), 'the UI shows localized guidance, not the raw error');
      assert.equal(revalidation()?.disabled, false);

      current = { ...current, requestLocationRevalidation: () => request(), provider: {} as CollaborationDocument['provider'] };
      await render();
      assert.equal(globalThis.document.querySelector('[data-testid="markdown-location-revalidation-error"]')?.textContent,
        labels.locationRevalidationFailed, 'same-path provider and callback rotation cannot discard a failed reconnect');

      gate = deferred();
      let refreshedCalls = 0;
      current = { ...current, requestLocationRevalidation: async () => { refreshedCalls++; await request(); } };
      await render();
      await act(async () => { pending = firstHandler(); });
      assert.equal(refreshedCalls, 1, 'a held control in the same open view uses the refreshed scoped callback');
      current = { ...current, session: { ...current.session!, permission: 'read' }, canRevalidateLocation: false,
        revalidatingLocation: false, status: 'read_only', connection: 'read_only', durability: 'checkpointed_file', error: null,
        clientState: { ...current.clientState, connection: 'read_only', durability: 'checkpointed_file', failure: null, error: null } };
      await render();
      await act(async () => { gate.resolve(); await pending; });
      assert.equal(revalidation(), null, 'a read-only result does not keep an enabled reconnect control');
      assert.equal(globalThis.document.querySelector('[data-testid="markdown-save-state"]'), null,
        'successful connection does not introduce a write-success message for a read-only session');
      assert.equal(reloadCalls, 0);

      controls.owner = {};
      current = document(seed, `doc-${locale}`, request, checkpoint);
      await render();
      const beforeOwnerChange = heldHandler();
      controls.workspaceId = 'another-workspace';
      await act(async () => beforeOwnerChange());
      assert.equal(locationCalls, 2, 'a workspace change revokes a held callback before React rerenders');
      controls.workspaceId = 'workspace';
      controls.path = 'Another.md';
      await act(async () => beforeOwnerChange());
      assert.equal(locationCalls, 2, 'a path change revokes a held callback before React rerenders');
      controls.path = 'Ziel/Gemeinsam.md';
      controls.owner = {};
      await act(async () => beforeOwnerChange());
      assert.equal(locationCalls, 2, 'an owner change revokes a held callback before the next React render');
      await render();
      const beforeGenerationChange = heldHandler();
      current = { ...current, session: { ...current.session!, lifecycleGeneration: 2 } };
      await render();
      await act(async () => beforeGenerationChange());
      assert.equal(locationCalls, 2, 'a generation change invalidates a held action even while the Y.Doc remains the same');
      current = { ...current, session: { ...current.session!, lifecycleGeneration: 1 } };
      await render();
      await act(async () => beforeGenerationChange());
      assert.equal(locationCalls, 2, 'returning to an earlier generation does not revive its previous control');
      gate = deferred();
      await act(async () => { pending = heldHandler()(); });
      const peer = new Y.Doc(); peer.getText('content').insert(0, 'Other document'); docs.push(peer);
      controls.owner = {};
      current = document(peer, `other-${locale}`, request, checkpoint);
      await render();
      await act(async () => { gate.reject(new Error('Old document request failed')); await pending; });
      assert.equal(globalThis.document.querySelector('[data-testid="markdown-location-revalidation-error"]'), null,
        'an old document result cannot contaminate the current document');

      const beforeUnmount = heldHandler();
      await act(async () => root.render(null));
      await act(async () => beforeUnmount());
      assert.equal(locationCalls, 3, 'an unmounted action cannot start another core request');
      controls.owner = {};
      current = document(seed, `doc-${locale}`, request, checkpoint);
      await render();
      await act(async () => beforeOwnerChange());
      assert.equal(locationCalls, 3, 'returning to the original document does not revive its previous callback');

      controls.owner = {};
      current = { ...document(seed, `storage-${locale}`, request, checkpoint), canRevalidateLocation: false, connection: 'live',
        session: { ...current.session!, documentId: `storage-${locale}`, permission: 'write' },
        clientState: { ...current.clientState, connection: 'live', failure: { kind: 'storage', code: COLLABORATION_FAILURE_CODES.persistenceFailed } } };
      await render();
      assert.equal(revalidation(), null);
      assert.ok(button(labels.retry));
      await act(async () => button(labels.retry)!.click());
      assert.equal(checkpointCalls, 1, 'ordinary storage retry still requests its checkpoint');
      assert.equal(locationCalls, 3);
      current = { ...current, clientState: { ...current.clientState, failure: { kind: 'unknown', code: null } } };
      await render();
      assert.equal(revalidation(), null, 'a free-form unknown quarantine gains no new recovery authority');
      await act(async () => root.render(null));
    }
    console.log('Markdown location UI: localized capability CTA, Pending/double-call protection, scoped failures, read-only results and unchanged checkpoint retry passed.');
  } finally {
    await act(async () => root.unmount());
    for (const doc of docs) doc.destroy();
    dom.window.close();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
