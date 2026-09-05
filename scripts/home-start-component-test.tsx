import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import de from '../messages/de.json';
import { NextIntlClientProvider } from 'next-intl';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['self', 'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLTextAreaElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });

async function main() {
  const { render, fireEvent, cleanup } = await import('@testing-library/react');
  const { HomeFilesPanel } = await import('../app/components/home/HomeFilesPanel');
  const { HomeNewNoteDialog } = await import('../app/components/home/HomeNewNoteDialog');
  const { HomeAttentionPanel } = await import('../app/components/home/HomeAttentionPanel');
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const navigations: string[] = [];
  const router = { push: (url: string) => navigations.push(url), replace: () => {}, prefetch: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, hmrRefresh: () => {} };
  const workspace: ClientWorkspaceSummary = { id: 'one', type: 'personal', name: 'Mein Workspace', color: 'gray' as ClientWorkspaceSummary['color'], status: 'active', permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
  const file = (n: number) => ({ path: `Notes/file-${n}.md`, name: `file-${n}.md`, title: `Notiz ${n}`, openedAt: 1700000000000, isFavorite: false });
  const wrap = (children: React.ReactNode) => <AppRouterContext.Provider value={router}><NextIntlClientProvider locale="de" timeZone="Europe/Berlin" messages={de}>{children}</NextIntlClientProvider></AppRouterContext.Provider>;
  let fail = false;
  let empty = false;
  let lastCreation: unknown;
  const fetches: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    fetches.push(url.pathname + url.search);
    if (url.pathname === '/api/files/create') {
      lastCreation = JSON.parse(String(init?.body));
      return Response.json({ success: true });
    }
    if (url.pathname === '/api/files/quick-access') {
      if (fail) return Response.json({ success: false }, { status: 503 });
      const view = url.searchParams.get('view');
      const search = url.searchParams.get('q');
      const all = view === 'favorites' ? [] : Array.from({ length: 8 }, (_, i) => file(i));
      const files = empty || search ? [] : all.slice(0, Number(url.searchParams.get('limit')));
      return Response.json({ success: true, data: { files, total: empty || search ? 0 : all.length, workspaceFileCount: empty ? 0 : 8 } });
    }
    throw new Error(`Unexpected fetch ${url.pathname}`);
  };
  useWorkspaceStore.setState({ activeWorkspaceId: 'one', workspaces: [workspace] });
  const settle = async (delay = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, delay)); });

  let screen = render(wrap(<HomeFilesPanel workspace={workspace} />));
  await settle();
  assert.equal(screen.getAllByRole('link').filter((link) => link.getAttribute('href')?.includes('path=')).length, 5);
  assert.equal(screen.getByRole('link', { name: /Notiz 0/ }).getAttribute('href'), '/de/notebook?path=Notes%2Ffile-0.md&workspaceId=one');
  fireEvent.click(screen.getByRole('button', { name: 'Weitere Dateien anzeigen' }));
  await settle();
  assert.ok(screen.getByRole('link', { name: /Notiz 7/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Notizen und Dateien suchen …' }), { target: { value: 'nicht vorhanden' } });
  await settle(280);
  assert.ok(screen.getByText('Keine passenden Dateien'));
  assert.ok(!screen.queryByText('Platz für deine erste Idee'), 'search misses must not look like an empty workspace');
  cleanup();

  fail = true;
  screen = render(wrap(<HomeFilesPanel workspace={workspace} />));
  await settle();
  assert.ok(screen.getByRole('alert'));
  assert.ok(!screen.queryByText('Platz für deine erste Idee'));
  fail = false;
  empty = true;
  fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
  await settle();
  assert.ok(screen.getByText('Platz für deine erste Idee'));
  cleanup();

  screen = render(wrap(<HomeFilesPanel workspace={{ ...workspace, permissions: { ...workspace.permissions, canWrite: false } }} />));
  await settle();
  assert.ok(!screen.queryByRole('button', { name: 'Neue Notiz' }));
  assert.ok(!screen.queryByRole('button', { name: 'Dateien importieren' }));
  assert.ok(screen.getByRole('link', { name: 'Notizbuch öffnen' }));
  cleanup();

  const regularFetch = globalThis.fetch;
  let releaseOld!: () => void;
  let oldStarted!: () => void;
  const oldRequestStarted = new Promise<void>((resolve) => { oldStarted = resolve; });
  const oldResponse = new Promise<void>((resolve) => { releaseOld = resolve; });
  globalThis.fetch = async (_input, init) => {
    const id = new Headers(init?.headers).get('x-canvas-workspace-id');
    if (id === 'one') { oldStarted(); await oldResponse; }
    return Response.json({ success: true, data: { files: [{ ...file(0), title: id === 'one' ? 'Alte private Notiz' : 'Neuer Workspace' }], total: 1, workspaceFileCount: 1, favorites: [], view: 'recent' } });
  };
  screen = render(wrap(<HomeFilesPanel key="one" workspace={workspace} />));
  await act(async () => { await oldRequestStarted; });
  screen.rerender(wrap(<HomeFilesPanel key="two" workspace={{ ...workspace, id: 'two' }} />));
  await settle();
  assert.ok(screen.getByText('Neuer Workspace'));
  await act(async () => { releaseOld(); await oldResponse; });
  assert.ok(!screen.queryByText('Alte private Notiz'), 'late responses from the previous workspace must never replace the active list');
  cleanup();
  globalThis.fetch = regularFetch;

  screen = render(wrap(<HomeNewNoteDialog workspaceId="one" onClose={() => {}} />));
  assert.equal(document.querySelector('details')?.open, false, 'folder choice is disclosed on demand');
  fireEvent.change(screen.getByLabelText('Name der Notiz'), { target: { value: 'Neue Idee' } });
  fireEvent.click(screen.getByRole('button', { name: 'Erstellen und öffnen' }));
  await settle();
  assert.deepEqual(lastCreation, { path: 'Neue Idee.md', type: 'file' });
  assert.ok(navigations[0]?.includes('path=Neue+Idee.md&workspaceId=one'));
  cleanup();

  screen = render(wrap(<HomeAttentionPanel summary={null} isLoading={false} />));
  assert.ok(screen.getByText('Hinweise konnten nicht geladen werden.'));
  assert.ok(!screen.queryByText('Gerade braucht nichts deine Aufmerksamkeit.'));
  const toggle = screen.getByRole('button', { name: 'Benachrichtigungen anzeigen' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  fireEvent.click(toggle);
  assert.equal(screen.getByRole('button', { name: 'Weniger anzeigen' }).getAttribute('aria-expanded'), 'true');
  cleanup();
  assert.ok(fetches.length > 0);
  console.log('Home components: direct file access, disclosure, search, errors, empty/read-only states, note creation and notification disclosure passed');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
