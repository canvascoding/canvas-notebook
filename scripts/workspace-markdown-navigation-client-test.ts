import assert from 'node:assert/strict';

import { useFileStore } from '../app/store/file-store';
import {
  buildWorkspaceMarkdownNotebookHref,
  isNotebookWorkspaceEditorPath,
  openWorkspaceMarkdownPath,
} from '../app/lib/markdown/workspace-markdown-navigation-client';
import { consumeWorkspaceMarkdownLocation } from '../app/lib/markdown/workspace-markdown-navigation';

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

  console.log('workspace-markdown-navigation-client-test: ok');
}

void main();
