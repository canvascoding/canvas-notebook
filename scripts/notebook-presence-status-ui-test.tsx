import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { FilePresenceEntry } from '../app/lib/collaboration/types';
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'Event'] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
async function main() {
  const { useWorkspaceStore } = await import('../app/store/workspace-store');
  const { useFilePresenceStore } = await import('../app/store/file-presence-store');
  const { FilePresenceMarkers } = await import('../app/components/file-browser/FilePresenceMarkers');
  useWorkspaceStore.setState({ activeWorkspaceId: 'presence' });
  const entry: FilePresenceEntry = { workspaceId: 'presence', path: 'docs/deep/a.md', documentId: 'doc-a', userId: 'agent', actorType: 'agent', sessionId: 's', initiatedByUserId: null, displayName: 'Agent', color: '#000', colorLight: '#fff', activity: 'editing', updatedAt: Date.now() };
  useFilePresenceStore.getState().replaceSnapshot({ workspaceId: 'presence', version: 4, entries: [entry, { ...entry, documentId: 'doc-b', path: 'docs/b.md' }] });
  const root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(<FilePresenceMarkers path="docs" />));
  assert.equal(document.querySelectorAll('span[aria-hidden="true"]').length, 1, 'folder activity deduplicates an agent editing two descendants');
  await act(async () => useFilePresenceStore.getState().applyMessage({ type: 'snapshot', workspaceId: 'presence', version: 2, entries: [] }));
  assert.ok(document.querySelector('[aria-label^="Active collaborators"]'), 'older snapshots cannot clear current presence');
  await act(async () => useFilePresenceStore.getState().renamePath('docs', 'archive'));
  assert.equal(document.querySelector('[aria-label^="Active collaborators"]'), null);
  await act(async () => root.render(<FilePresenceMarkers path="archive" />));
  assert.ok(document.querySelector('[aria-label^="Active collaborators"]'));
  await act(async () => useFilePresenceStore.getState().renamePath('docs', 'archive'));
  assert.ok(document.querySelector('[aria-label^="Active collaborators"]'), 'a server snapshot arriving before rename must not be dropped');
  await act(async () => useFilePresenceStore.getState().removePaths(['archive']));
  await act(async () => useFilePresenceStore.getState().applyMessage({ type: 'snapshot', workspaceId: 'presence', version: 8, entries: [{ ...entry, path: 'archive/a.md' }] }));
  assert.equal(document.querySelector('[aria-label^="Active collaborators"]'), null, 'delayed presence cannot revive deleted paths');
  await act(async () => root.unmount()); dom.window.close();
  console.log('notebook-presence-status-ui-test: ok');
}
void main().catch((error) => { console.error(error); dom.window.close(); process.exitCode = 1; });
