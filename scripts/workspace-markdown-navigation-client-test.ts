import assert from 'node:assert/strict';

import { useFileStore } from '../app/store/file-store';
import {
  buildWorkspaceMarkdownNotebookHref,
  isNotebookWorkspaceEditorPath,
  openWorkspaceMarkdownPath,
  openWorkspaceMarkdownTarget,
} from '../app/lib/markdown/workspace-markdown-navigation-client';
import { consumeWorkspaceMarkdownLocation } from '../app/lib/markdown/workspace-markdown-navigation';
import { buildWorkspaceLinkIndexFromDocuments } from '../app/lib/markdown/workspace-link-index-core';
import { resolveWorkspaceMarkdownDocumentReferenceFromIndex } from '../app/lib/markdown/workspace-link-index-client';

async function main() {
  assert.equal(isNotebookWorkspaceEditorPath('/notebook'), true);
  assert.equal(isNotebookWorkspaceEditorPath('/en/notebook'), true);
  assert.equal(isNotebookWorkspaceEditorPath('/de/automations/job-1'), false);
  assert.equal(
    buildWorkspaceMarkdownNotebookHref({
      path: '03_releases/v2026.7.17.7/social-posts.md',
      workspaceId: 'workspace-a',
    }),
    '/notebook?path=03_releases%2Fv2026.7.17.7%2Fsocial-posts.md&workspaceId=workspace-a',
  );

  let revealCalls = 0;
  useFileStore.setState({
    revealAndLoadFile: async (path) => {
      revealCalls += 1;
      return { status: 'opened', path };
    },
  });

  let navigatedHref: string | null = null;
  const routedResult = await openWorkspaceMarkdownPath({
    currentPathname: '/de/automations/job-1',
    heading: 'Social Posts',
    navigateToNotebook: (href) => {
      navigatedHref = href;
    },
    path: '03_releases/v2026.7.17.7/social-posts.md',
    workspaceId: 'workspace-a',
  });

  assert.equal(routedResult.status, 'opened');
  assert.equal(revealCalls, 0, 'cross-route opens must wait for the notebook shell to load the file');
  assert.equal(
    navigatedHref,
    '/notebook?path=03_releases%2Fv2026.7.17.7%2Fsocial-posts.md&workspaceId=workspace-a',
  );
  const pendingLocation = consumeWorkspaceMarkdownLocation('03_releases/v2026.7.17.7/social-posts.md');
  assert.ok(pendingLocation);
  assert.equal(pendingLocation.blockId, null);
  assert.equal(pendingLocation.heading, 'Social Posts');
  assert.equal(pendingLocation.path, '03_releases/v2026.7.17.7/social-posts.md');
  assert.ok(pendingLocation.requestId);
  assert.ok(Number.isFinite(pendingLocation.requestedAt));

  const inNotebookResult = await openWorkspaceMarkdownPath({
    currentPathname: '/notebook',
    navigateToNotebook: () => {
      throw new Error('the active notebook must open the file without another navigation');
    },
    path: 'docs/brief.md',
    workspaceId: 'workspace-a',
  });

  assert.equal(inNotebookResult.status, 'opened');
  assert.equal(revealCalls, 1);

  const index = buildWorkspaceLinkIndexFromDocuments([
    { path: 'Notes/Start.md', content: '# Start' },
    { path: 'Notes/Target.md', content: '# Nearby' },
    { path: 'Notes/|Start.md', content: '# Leading pipe' },
    { path: 'Notes/A|B.md', content: '# Encoded pipe' },
    { path: 'Shared.md', content: '# Shared' },
  ]);
  assert.equal(resolveWorkspaceMarkdownDocumentReferenceFromIndex(
    '../Target.md', index, 'Notes/Start.md',
  ).resolution?.status, 'missing', 'preview must not use Wiki basename fallback');
  assert.equal(resolveWorkspaceMarkdownDocumentReferenceFromIndex(
    '../Shared.md#Section%20A', index, 'Notes/Start.md',
  ).reference?.heading, 'Section A');
  assert.equal(resolveWorkspaceMarkdownDocumentReferenceFromIndex(
    '#Local%20Section', index, 'Notes/Start.md',
  ).reference?.path, 'Notes/Start.md', 'an anchor-only link stays in its source document');
  assert.deepEqual(
    resolveWorkspaceMarkdownDocumentReferenceFromIndex('|Start.md', index, 'Notes/Start.md')
      .resolution?.target,
    { alias: null, blockId: null, heading: null, path: '|Start.md', raw: '|Start.md', target: '|Start.md' },
    'literal pipe at the start of a Markdown filename must not become a Wiki alias',
  );
  assert.equal(resolveWorkspaceMarkdownDocumentReferenceFromIndex(
    './A%7CB.md#Chapter%201', index, 'Notes/Start.md',
  ).reference?.path, 'Notes/A|B.md');
  assert.deepEqual(resolveWorkspaceMarkdownDocumentReferenceFromIndex(
    './A%7CB.md#Chapter%201', index, 'Notes/Start.md',
  ).resolution?.target, {
    alias: null,
    blockId: null,
    heading: 'Chapter 1',
    path: './A|B.md',
    raw: './A%7CB.md#Chapter%201',
    target: './A%7CB.md#Chapter%201',
  });

  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true, index }), {
    headers: { 'Content-Type': 'application/json' }, status: 200,
  });
  try {
    const missing = await openWorkspaceMarkdownTarget({
      sourcePath: 'Notes/Start.md', syntax: 'markdown', target: '../Target.md',
      workspaceId: 'navigation-exact-test',
    });
    assert.equal(missing.status, 'missing');
    assert.equal(revealCalls, 1, 'missing relative target must never open same-name sibling');
    const root = await openWorkspaceMarkdownTarget({
      sourcePath: 'Notes/Start.md', syntax: 'markdown', target: '/Shared.md#Section%20A',
      workspaceId: 'navigation-exact-test',
    });
    assert.equal(root.status, 'opened');
    assert.equal(root.path, 'Shared.md');
    assert.equal(consumeWorkspaceMarkdownLocation('Shared.md')?.heading, 'Section A');
    const localAnchor = await openWorkspaceMarkdownTarget({
      sourcePath: 'Notes/Start.md', syntax: 'markdown', target: '#Local%20Section',
      workspaceId: 'navigation-exact-test',
    });
    assert.equal(localAnchor.status, 'opened');
    assert.equal(localAnchor.path, 'Notes/Start.md');
    assert.equal(consumeWorkspaceMarkdownLocation('Notes/Start.md')?.heading, 'Local Section');
    const legacy = await openWorkspaceMarkdownTarget({
      sourcePath: 'Notes/Start.md', syntax: 'markdown',
      target: 'https://canvas.example/de/notebook?path=Shared.md#Section%20A',
      workspaceId: 'navigation-exact-test',
    });
    assert.equal(legacy.status, 'opened');
    assert.equal(legacy.path, 'Shared.md');
    const wiki = await openWorkspaceMarkdownTarget({
      sourcePath: 'Notes/Start.md', syntax: 'wiki', target: 'Target',
      workspaceId: 'navigation-exact-test',
    });
    assert.equal(wiki.status, 'opened');
    assert.equal(wiki.path, 'Notes/Target.md');
  } finally {
    globalThis.fetch = oldFetch;
  }

  console.log('workspace-markdown-navigation-client-test: ok');
}

void main();
