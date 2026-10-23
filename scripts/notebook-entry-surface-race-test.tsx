import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import React, { act, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NotebookSurfaceMount } from '../app/components/notebook/NotebookSurfaceMount';
import { initialNotebookLayoutState, notebookLayoutReducer } from '../app/lib/notebook/layout-state';
import { resolveNotebookEntry } from '../app/lib/notebook/notebook-entry';
import { getNotebookNavigationIntent } from '../app/lib/chat/chat-navigation-intent';
import { workspaceScopedNavigationMatches } from '../app/lib/workspaces/navigation-sync';

// Execute the production entry effect itself, avoiding unrelated Dashboard apps
// and transports. This catches the render between tab hydration and file lookup.
const source = ts.createSourceFile('DashboardShell.tsx', readFileSync(new URL('../app/components/DashboardShell.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let entryCallback = '', entryDependencies = '', routeCallback = '', routeDependencies = '';
function findEffect(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') {
    const callback = node.arguments[0]?.getText(source);
    const dependencies = node.arguments[1];
    if (callback?.includes('initialNotebookStateResolvedRef.current = true')) {
      assert.ok(dependencies && ts.isArrayLiteralExpression(dependencies));
      assert.equal(entryCallback, '', 'the production entry effect is unique');
      entryCallback = callback;
      entryDependencies = dependencies.getText(source);
    } else if (callback?.includes('const pendingBridgeRequest = window.name === NOTEBOOK_WINDOW_NAME')) {
      assert.ok(dependencies && ts.isArrayLiteralExpression(dependencies));
      assert.equal(routeCallback, '', 'the production route effect is unique');
      routeCallback = callback;
      routeDependencies = dependencies.getText(source);
    }
  }
  ts.forEachChild(node, findEffect);
}
findEffect(source);
assert.ok(entryCallback && entryDependencies && routeCallback && routeDependencies);
const bindEntryEffect = new Function('bindings', `with (bindings) { return (${entryCallback}); }`) as (bindings: object) => () => void;
type BoundEffect = { callback: () => void; dependencies: unknown[] };
// Execute the actual dependency arrays as well as both callbacks. A copied
// dependency list would make the old production scheduling bug invisible.
const bindEntrySchedule = new Function('bindings', `with (bindings) { return { callback: (${entryCallback}), dependencies: (${entryDependencies}) }; }`) as (bindings: object) => BoundEffect;
const bindRouteSchedule = new Function('bindings', `with (bindings) { return { callback: (${routeCallback}), dependencies: (${routeDependencies}) }; }`) as (bindings: object) => BoundEffect;

async function main() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById('root')!);
  let chatMounts = 0;
  let finishDocumentLookup: (() => void) | undefined;
  function Chat() {
    useEffect(() => { chatMounts++; }, []);
    return <span>chat</span>;
  }
  function Entry({ search, restoredPath, docked = false }: { search: string; restoredPath: string | null; docked?: boolean }) {
    const [state, dispatch] = useReducer(notebookLayoutReducer, { ...initialNotebookLayoutState, chatDocked: docked });
    const [tabsReady, setTabsReady] = useState(false);
    const [pendingDocumentOpen, setPendingDocumentOpen] = useState<{ path: string } | null>(null);
    const initialNotebookStateResolvedRef = useRef(false);
    const documentOpenGenerationRef = useRef(0);
    const openedPathRef = useRef<string | null>(null);
    const searchParams = new URLSearchParams(search);
    const intent = getNotebookNavigationIntent(searchParams);
    // The callback is extracted from production specifically to test its effect ordering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(bindEntryEffect({
      layout: { preferencesHydrated: true, viewportWidth: 1200 },
      activeWorkspaceId: 'workspace-a', workspaceReady: true, routeWorkspaceId: intent.workspaceId,
      workspaceScopedNavigationMatches, initialNotebookStateResolvedRef,
      documentOpenGenerationRef, setPendingDocumentOpen,
      hydrateDocumentTabs: () => { setTabsReady(true); return { activePath: restoredPath }; },
      resolveNotebookEntry, getNotebookNavigationIntent, searchParams, hasStoredInitialPrompt: false,
      shouldForceChatOpen: intent.shouldOpenChat, routeFilePath: intent.path, dispatch, openedPathRef,
      openNotebookEntry: () => new Promise<void>(resolve => { finishDocumentLookup = resolve; }),
      useFileStore: { getState: () => ({ clearCurrentFile() {}, openFileRequestId: 0 }) },
    }), []);
    return tabsReady ? <>
      {pendingDocumentOpen ? <span data-testid="pending-document">{pendingDocumentOpen.path}</span> : null}
      <NotebookSurfaceMount active={state.mainSurface === 'chat' || state.chatDocked}><Chat /></NotebookSurfaceMount>
    </> : <span>loading entry</span>;
  }
  type ReadinessGate = 'preferencesHydrated' | 'viewportWidth' | 'workspaceReady';
  type RouteProbe = { opens: string[]; hydrations: number; finish?: () => void };
  function LateEntry({ gate, ready, probe }: { gate: ReadinessGate; ready: boolean; probe: RouteProbe }) {
    const [state, dispatch] = useReducer(notebookLayoutReducer, initialNotebookLayoutState);
    // WORKSPACE_CHANGED may have hydrated this exact target before the final
    // initial-entry gate is ready. Setting the same string again cannot wake an effect.
    const [documentTabsHydratedFor, setDocumentTabsHydratedFor] = useState('workspace-a');
    const [pendingDocumentOpen, setPendingDocumentOpen] = useState<{ path: string } | null>(null);
    const [loadedPath, setLoadedPath] = useState<string | null>(null);
    const [searchParams] = useState(() => new URLSearchParams('path=report.md&workspaceId=workspace-a'));
    const [fileStore] = useState(() => ({ getState: () => ({ clearCurrentFile() {}, openFileRequestId: 0 }) }));
    const initialNotebookStateResolvedRef = useRef(false);
    const documentOpenGenerationRef = useRef(0);
    const openedPathRef = useRef<string | null>(null);
    const openedRouteIdentityRef = useRef<string | null>(null);
    const hydrateDocumentTabs = useCallback((workspaceId: string) => {
      probe.hydrations++;
      setPendingDocumentOpen(null);
      setDocumentTabsHydratedFor(workspaceId);
      return { activePath: null };
    }, [probe]);
    // Declared asynchronous loader seam: the extracted route callback must invoke
    // it once. This is not a browser request or a Scene transport fixture.
    const openNotebookEntry = useCallback((path: string) => {
      probe.opens.push(path);
      return new Promise<void>(resolve => {
        probe.finish = () => { setLoadedPath(path); setPendingDocumentOpen(null); resolve(); };
      });
    }, [probe]);
    const intent = getNotebookNavigationIntent(searchParams);
    const bindings = {
      layout: { preferencesHydrated: gate !== 'preferencesHydrated' || ready, viewportWidth: gate === 'viewportWidth' && !ready ? 0 : 1200 },
      activeWorkspaceId: 'workspace-a', workspaceReady: gate !== 'workspaceReady' || ready,
      documentTabsHydratedFor, routeWorkspaceId: intent.workspaceId, routeFilePath: intent.path,
      routeDocumentId: intent.documentId, routeLineageId: intent.lineageId,
      workspaceScopedNavigationMatches, initialNotebookStateResolvedRef, documentOpenGenerationRef,
      openedPathRef, openedRouteIdentityRef, setPendingDocumentOpen, hydrateDocumentTabs,
      resolveNotebookEntry, getNotebookNavigationIntent, searchParams, hasStoredInitialPrompt: false,
      shouldForceChatOpen: intent.shouldOpenChat, dispatch, openNotebookEntry, useFileStore: fileStore,
      NOTEBOOK_WINDOW_NAME: 'canvas-notebook', readPendingNotebookFileReference: () => null,
    };
    const entry = bindEntrySchedule(bindings);
    const route = bindRouteSchedule(bindings);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- use the production AST array, not a mirror.
    useEffect(entry.callback, entry.dependencies);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- use the production AST array, not a mirror.
    useEffect(route.callback, route.dependencies);
    return <>
      {pendingDocumentOpen ? <span data-testid="late-entry-pending">{pendingDocumentOpen.path}</span> : null}
      {loadedPath ? <span data-testid="late-entry-loaded">{loadedPath}</span> : null}
      <span data-testid="late-entry-surface">{state.mainSurface}</span>
    </>;
  }
  try {
    await act(async () => { root.render(<Entry key="explicit-document" search="path=report.md&workspaceId=workspace-a" restoredPath={null} />); });
    assert.equal(chatMounts, 0, 'explicit document entry never mounts the default chat between hydration and route effects');
    await act(async () => { root.render(<Entry key="restored-document" search="workspaceId=workspace-a" restoredPath="report.md" />); });
    assert.ok(finishDocumentLookup, 'restored document starts asynchronous lookup');
    assert.equal(document.querySelector('[data-testid="pending-document"]')?.textContent, 'report.md', 'restored document is pending before lookup finishes');
    assert.equal(chatMounts, 0, 'pending restored document lookup does not mount the default chat');
    await act(async () => { finishDocumentLookup!(); });
    assert.equal(chatMounts, 0);
    await act(async () => { root.render(<Entry key="docked-document" search="path=report.md&workspaceId=workspace-a" restoredPath={null} docked />); });
    assert.equal(chatMounts, 1, 'an explicitly saved visible dock still mounts chat');
    await act(async () => { root.render(<Entry key="explicit-chat" search="chat=open&workspaceId=workspace-a" restoredPath="report.md" />); });
    assert.equal(chatMounts, 2, 'explicit chat entry still mounts immediately');

    for (const gate of ['preferencesHydrated', 'viewportWidth', 'workspaceReady'] as const) {
      const probe: RouteProbe = { opens: [], hydrations: 0 };
      const render = (ready: boolean) => root.render(<LateEntry key={gate} gate={gate} ready={ready} probe={probe} />);
      await act(async () => { render(false); });
      assert.deepEqual(probe.opens, [], `${gate}: no route opens before the last gate`);
      assert.equal(probe.hydrations, 0, `${gate}: initial entry is still waiting`);
      await act(async () => { render(false); });
      assert.deepEqual(probe.opens, [], `${gate}: an identical render cannot wake a route`);
      await act(async () => { render(true); });
      assert.equal(probe.hydrations, 1, `${gate}: initial entry hydrates once`);
      assert.deepEqual(probe.opens, ['report.md'], `${gate}: readiness releases exactly one route open with tabs already hydrated`);
      assert.equal(document.querySelector('[data-testid="late-entry-pending"]')?.textContent, 'report.md', `${gate}: the document stays pending during the loader`);
      assert.equal(document.querySelector('[data-testid="late-entry-surface"]')?.textContent, 'document');
      assert.equal(document.querySelector('[data-testid="late-entry-loaded"]'), null);
      assert.ok(probe.finish, `${gate}: the declared loader can complete`);
      await act(async () => { probe.finish!(); });
      assert.equal(document.querySelector('[data-testid="late-entry-pending"]'), null, `${gate}: loader completion clears pending state`);
      assert.equal(document.querySelector('[data-testid="late-entry-loaded"]')?.textContent, 'report.md');
      await act(async () => { render(true); });
      assert.deepEqual(probe.opens, ['report.md'], `${gate}: settled and identical renders do not reopen the document`);
      assert.equal(probe.hydrations, 1);
    }
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
  }
  console.log('notebook-entry-surface-race-test: ok');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
