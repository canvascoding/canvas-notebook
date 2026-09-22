import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import React, { act, useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NotebookSurfaceMount } from '../app/components/notebook/NotebookSurfaceMount';
import { initialNotebookLayoutState, notebookLayoutReducer } from '../app/lib/notebook/layout-state';
import { resolveNotebookEntry } from '../app/lib/notebook/notebook-entry';
import { getNotebookNavigationIntent } from '../app/lib/chat/chat-navigation-intent';
import { workspaceScopedNavigationMatches } from '../app/lib/workspaces/navigation-sync';

// Execute the production entry effect itself, avoiding unrelated Dashboard apps
// and transports. This catches the render between tab hydration and file lookup.
const source = ts.createSourceFile('DashboardShell.tsx', readFileSync(new URL('../app/components/DashboardShell.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let entryCallback = '';
function findEffect(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
    && node.arguments[0]?.getText(source).includes('initialNotebookStateResolvedRef.current = true')) {
    entryCallback = node.arguments[0].getText(source);
  }
  ts.forEachChild(node, findEffect);
}
findEffect(source);
assert.ok(entryCallback);
const bindEntryEffect = new Function('bindings', `with (bindings) { return (${entryCallback}); }`) as (bindings: object) => () => void;

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
    const initialNotebookStateResolvedRef = useRef(false);
    const openedPathRef = useRef<string | null>(null);
    const searchParams = new URLSearchParams(search);
    const intent = getNotebookNavigationIntent(searchParams);
    // The callback is extracted from production specifically to test its effect ordering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(bindEntryEffect({
      layout: { preferencesHydrated: true, viewportWidth: 1200 },
      activeWorkspaceId: 'workspace-a', workspaceReady: true, routeWorkspaceId: intent.workspaceId,
      workspaceScopedNavigationMatches, initialNotebookStateResolvedRef,
      hydrateDocumentTabs: () => { setTabsReady(true); return { activePath: restoredPath }; },
      resolveNotebookEntry, getNotebookNavigationIntent, searchParams, hasStoredInitialPrompt: false,
      shouldForceChatOpen: intent.shouldOpenChat, routeFilePath: intent.path, dispatch, openedPathRef,
      openNotebookFile: () => new Promise<void>(resolve => { finishDocumentLookup = resolve; }),
      useFileStore: { getState: () => ({ clearCurrentFile() {} }) },
    }), []);
    return tabsReady ? <NotebookSurfaceMount active={state.mainSurface === 'chat' || state.chatDocked}><Chat /></NotebookSurfaceMount> : <span>loading entry</span>;
  }
  try {
    await act(async () => { root.render(<Entry key="explicit-document" search="path=report.md&workspaceId=workspace-a" restoredPath={null} />); });
    assert.equal(chatMounts, 0, 'explicit document entry never mounts the default chat between hydration and route effects');
    await act(async () => { root.render(<Entry key="restored-document" search="workspaceId=workspace-a" restoredPath="report.md" />); });
    assert.ok(finishDocumentLookup, 'restored document starts asynchronous lookup');
    assert.equal(chatMounts, 0, 'pending restored document lookup does not mount the default chat');
    await act(async () => { finishDocumentLookup!(); });
    assert.equal(chatMounts, 0);
    await act(async () => { root.render(<Entry key="docked-document" search="path=report.md&workspaceId=workspace-a" restoredPath={null} docked />); });
    assert.equal(chatMounts, 1, 'an explicitly saved visible dock still mounts chat');
    await act(async () => { root.render(<Entry key="explicit-chat" search="chat=open&workspaceId=workspace-a" restoredPath="report.md" />); });
    assert.equal(chatMounts, 2, 'explicit chat entry still mounts immediately');
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
  }
  console.log('notebook-entry-surface-race-test: ok');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
