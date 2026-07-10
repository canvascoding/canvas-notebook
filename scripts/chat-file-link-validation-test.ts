import assert from 'node:assert/strict';
import { extractFilePaths, normalizeChatFilePath } from '../app/lib/chat/extract-file-paths';
import {
  createNotebookFileReferenceRequest,
  NOTEBOOK_FILE_REFERENCE_MESSAGE_TYPE,
  parseNotebookFileReferenceRequest,
} from '../app/lib/chat/notebook-file-reference-bridge';
import {
  invalidateFileReferenceValidationCache,
  validateFileExists,
  validateFileReference,
} from '../app/lib/chat/validate-file-paths';
import { getFileDisplayName, getFileDisplayPath } from '../app/lib/files/display-name';
import { useFileStore } from '../app/store/file-store';
import { useWorkspaceStore } from '../app/store/workspace-store';
import { LEGACY_PERSONAL_WORKSPACE_ID } from '../app/lib/workspaces/constants';
import type { FileNode } from '../app/store/file-store';

const fileTree: FileNode[] = [
  {
    name: 'docs',
    path: 'docs',
    type: 'directory',
    children: [
      {
        name: 'loaded.md',
        path: 'docs/loaded.md',
        type: 'file',
      },
    ],
  },
];

const fetchCalls: Array<{ url: string; workspaceHeader: string | null }> = [];
const originalFetch = globalThis.fetch;

async function main() {
  useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    fetchCalls.push({ url, workspaceHeader: headers.get('X-Canvas-Workspace-Id') });
    return Response.json({
      success: true,
      data: {
        exists: url.includes(encodeURIComponent('generated/new-file.md')),
        type: url.includes(encodeURIComponent('generated/new-file.md')) ? 'file' : undefined,
      },
    });
  }) as typeof fetch;

  try {
    assert.equal(normalizeChatFilePath('/data/workspace/generated/page.html'), 'generated/page.html');
    assert.deepEqual(
      extractFilePaths('Open [/data/workspace/generated/page.html](/data/workspace/generated/page.html).'),
      [{ path: 'generated/page.html', label: '/data/workspace/generated/page.html' }],
    );
    assert.deepEqual(
      extractFilePaths('Das Bild liegt im Workspace unter test-bild-0-5k.jpg.'),
      [{ path: 'test-bild-0-5k.jpg', label: 'test-bild-0-5k.jpg' }],
    );
    assert.deepEqual(
      extractFilePaths('Das Video liegt im Workspace unter preview-clip.mp4.'),
      [{ path: 'preview-clip.mp4', label: 'preview-clip.mp4' }],
    );
    assert.deepEqual(
      extractFilePaths('Inline API URLs like /api/media/test-bild-0-5k.jpg should not become workspace refs.'),
      [],
    );
    assert.deepEqual(
      extractFilePaths('Inline API URLs like /api/media/preview-clip.mp4 should not become workspace refs.'),
      [],
    );

    const bridgeRequest = createNotebookFileReferenceRequest('/data/workspace/generated/page.html');
    assert.ok(bridgeRequest);
    assert.equal(bridgeRequest.type, NOTEBOOK_FILE_REFERENCE_MESSAGE_TYPE);
    assert.equal(bridgeRequest.path, 'generated/page.html');
    assert.deepEqual(parseNotebookFileReferenceRequest(bridgeRequest, bridgeRequest.createdAt), bridgeRequest);
    assert.equal(
      parseNotebookFileReferenceRequest({ ...bridgeRequest, path: '../outside.md' }, bridgeRequest.createdAt),
      null,
    );
    assert.equal(
      parseNotebookFileReferenceRequest(bridgeRequest, bridgeRequest.createdAt + 30_001),
      null,
    );

    assert.equal(await validateFileExists('docs/loaded.md', fileTree), true);
    assert.deepEqual(await validateFileReference('docs/loaded.md', fileTree), {
      path: 'docs/loaded.md',
      type: 'file',
      exists: true,
    });
    assert.equal(fetchCalls.length, 0, 'loaded tree entries should not hit the API');

    assert.equal(await validateFileExists('/data/workspace/docs/loaded.md', fileTree), true);
    assert.equal(fetchCalls.length, 0, 'absolute workspace tree entries should not hit the API');

    assert.deepEqual(
      await validateFileReference('docs/loaded.md', fileTree, { fileTreeWorkspaceId: 'workspace-b' }),
      { path: 'docs/loaded.md', type: 'missing', exists: false },
      'a file tree from another workspace must never validate the active workspace',
    );
    assert.equal(fetchCalls.length, 1, 'workspace-mismatched trees must fall back to the scoped API');
    fetchCalls.length = 0;

    assert.deepEqual(await validateFileReference('docs', fileTree), {
      path: 'docs',
      type: 'directory',
      exists: true,
    });
    assert.equal(await validateFileExists('docs', fileTree), false);
    assert.equal(fetchCalls.length, 0, 'loaded tree directories should not hit the API');

    assert.equal(await validateFileExists('generated/new-file.md', fileTree), true);
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /\/api\/files\/exists\?/);
    assert.match(fetchCalls[0].url, /workspaceId=workspace-a/);
    assert.equal(fetchCalls[0].workspaceHeader, 'workspace-a');

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      fetchCalls.push({ url, workspaceHeader: headers.get('X-Canvas-Workspace-Id') });
      return Response.json({
        success: true,
        data: {
          exists: url.includes(encodeURIComponent('generated/folder')),
          type: url.includes(encodeURIComponent('generated/folder')) ? 'directory' : undefined,
        },
      });
    }) as typeof fetch;

    assert.deepEqual(await validateFileReference('generated/folder', fileTree), {
      path: 'generated/folder',
      type: 'directory',
      exists: true,
    });
    assert.equal(await validateFileExists('generated/folder', fileTree), false);

    assert.equal(await validateFileExists('missing/nope.md', fileTree), false);
    assert.equal(await validateFileExists('missing/nope.md', fileTree), false);
    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-b' });
    assert.equal(await validateFileExists('missing/nope.md', fileTree), false);
    const missingFetchMatches = fetchCalls.map((call) => call.url).join('\n').match(new RegExp(encodeURIComponent('missing/nope.md'), 'g')) ?? [];
    assert.equal(missingFetchMatches.length, 2, 'validation cache must be scoped by workspace');

    useWorkspaceStore.setState({ activeWorkspaceId: 'workspace-a' });
    invalidateFileReferenceValidationCache({ workspaceId: 'workspace-a', path: 'missing/nope.md' });
    assert.equal(await validateFileExists('missing/nope.md', fileTree), false);
    const invalidatedMissingFetchMatches = fetchCalls.map((call) => call.url).join('\n').match(new RegExp(encodeURIComponent('missing/nope.md'), 'g')) ?? [];
    assert.equal(invalidatedMissingFetchMatches.length, 3, 'file mutation invalidation must revalidate missing links immediately');

    useWorkspaceStore.setState({ activeWorkspaceId: null });
    assert.equal(await validateFileExists('legacy/missing.md', fileTree), false);
    invalidateFileReferenceValidationCache({ workspaceId: LEGACY_PERSONAL_WORKSPACE_ID, path: 'legacy/missing.md' });
    assert.equal(await validateFileExists('legacy/missing.md', fileTree), false);
    const legacyMissingFetchMatches = fetchCalls.map((call) => call.url).join('\n').match(new RegExp(encodeURIComponent('legacy/missing.md'), 'g')) ?? [];
    assert.equal(legacyMissingFetchMatches.length, 2, 'legacy watcher events must invalidate legacy validation entries');

    assert.equal(getFileDisplayName({ name: 'loaded.md', type: 'file' }), 'loaded');
    assert.equal(getFileDisplayPath('docs/loaded.md'), 'docs/loaded');
    assert.equal(getFileDisplayPath('/data/workspace/docs/loaded.md'), '/data/workspace/docs/loaded');
    assert.equal(getFileDisplayPath('assets/photo.jpg'), 'assets/photo.jpg');

    const revealFetchCalls: string[] = [];
    useFileStore.setState({
      fileTree: [],
      currentDirectory: '.',
      expandedDirs: new Set<string>(),
      selectedNode: null,
      currentFile: null,
      searchQuery: 'old query',
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      revealFetchCalls.push(`${url.pathname}?${url.searchParams.toString()}`);

      if (url.pathname === '/api/files/tree') {
        const path = url.searchParams.get('path');
        const nodesByPath: Record<string, FileNode[]> = {
          '.': [{ name: 'generated', path: 'generated', type: 'directory' }],
          generated: [{ name: 'nested', path: 'generated/nested', type: 'directory' }],
          'generated/nested': [{ name: 'new-file.md', path: 'generated/nested/new-file.md', type: 'file' }],
        };
        return Response.json({ success: true, data: nodesByPath[path || '.'] ?? [] });
      }

      if (url.pathname === '/api/files/read') {
        return Response.json({
          success: true,
          data: {
            path: 'generated/nested/new-file.md',
            content: '# New file',
            stats: { size: 10, modified: 1, permissions: '100644' },
          },
        });
      }

      return new Response(null, { status: 404 });
    }) as typeof fetch;

    await useFileStore.getState().revealAndLoadFile('generated/nested/new-file.md');

    const state = useFileStore.getState();
    assert.equal(state.selectedNode?.path, 'generated/nested/new-file.md');
    assert.equal(state.currentDirectory, 'generated/nested');
    assert.equal(state.currentFile?.path, 'generated/nested/new-file.md');
    assert.equal(state.searchQuery, '');
    assert.equal(state.expandedDirs.has('generated'), true);
    assert.equal(state.expandedDirs.has('generated/nested'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('chat-file-link-validation-test: ok');
}

void main();
