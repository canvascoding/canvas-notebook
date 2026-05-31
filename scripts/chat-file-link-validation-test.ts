import assert from 'node:assert/strict';
import { extractFilePaths, normalizeChatFilePath } from '../app/lib/chat/extract-file-paths';
import { validateFileExists } from '../app/lib/chat/validate-file-paths';
import { useFileStore } from '../app/store/file-store';
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

const fetchCalls: string[] = [];
const originalFetch = globalThis.fetch;

async function main() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    return Response.json({
      success: true,
      data: {
        exists: url.includes(encodeURIComponent('generated/new-file.md')),
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

    assert.equal(await validateFileExists('docs/loaded.md', fileTree), true);
    assert.deepEqual(fetchCalls, [], 'loaded tree entries should not hit the API');

    assert.equal(await validateFileExists('/data/workspace/docs/loaded.md', fileTree), true);
    assert.deepEqual(fetchCalls, [], 'absolute workspace tree entries should not hit the API');

    assert.equal(await validateFileExists('generated/new-file.md', fileTree), true);
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0], /\/api\/files\/exists\?/);

    assert.equal(await validateFileExists('missing/nope.md', fileTree), false);
    assert.equal(await validateFileExists('missing/nope.md', fileTree), false);
    const missingFetchMatches = fetchCalls.join('\n').match(new RegExp(encodeURIComponent('missing/nope.md'), 'g')) ?? [];
    assert.equal(missingFetchMatches.length, 1);

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
