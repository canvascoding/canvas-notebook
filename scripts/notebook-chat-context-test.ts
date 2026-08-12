import assert from 'node:assert/strict';

import { resolveNotebookChatContext } from '../app/lib/notebook/chat-context';

const sideDocument = resolveNotebookChatContext({
  activeDocumentPath: 'briefing.md',
  chatPlacement: 'side',
  mainSurface: 'document',
  openDocumentPaths: ['briefing.md', 'research.md'],
});
assert.deepEqual(sideDocument, {
  activeFilePath: 'briefing.md',
  notebookContext: {
    activeSurface: { kind: 'document', path: 'briefing.md' },
    chatPlacement: 'side',
    openDocuments: [
      { path: 'briefing.md', state: 'active' },
      { path: 'research.md', state: 'background' },
    ],
  },
});

const fullChat = resolveNotebookChatContext({
  activeDocumentPath: 'briefing.md',
  chatPlacement: 'full',
  mainSurface: 'chat',
  openDocumentPaths: ['briefing.md', 'research.md'],
});
assert.equal(fullChat.activeFilePath, null);
assert.equal(fullChat.notebookContext.activeSurface, null);
assert.deepEqual(
  fullChat.notebookContext.openDocuments.map((document) => document.state),
  ['background', 'background'],
);

const sideBrowser = resolveNotebookChatContext({
  activeDocumentPath: 'briefing.md',
  chatPlacement: 'side',
  mainSurface: 'browser',
  openDocumentPaths: ['briefing.md'],
});
assert.deepEqual(sideBrowser.notebookContext.activeSurface, { kind: 'browser' });
assert.equal(sideBrowser.activeFilePath, null);

const overlayDocument = resolveNotebookChatContext({
  activeDocumentPath: 'briefing.md',
  chatPlacement: 'overlay',
  mainSurface: 'document',
  openDocumentPaths: ['briefing.md'],
});
assert.equal(overlayDocument.notebookContext.activeSurface, null);
assert.equal(overlayDocument.activeFilePath, null);

console.log('notebook-chat-context-test: ok');
