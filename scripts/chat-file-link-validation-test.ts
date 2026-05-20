import assert from 'node:assert/strict';
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
    return new Response(null, {
      status: url.includes(encodeURIComponent('generated/new-file.md')) ? 200 : 404,
    });
  }) as typeof fetch;

  try {
    assert.equal(await validateFileExists('docs/loaded.md', fileTree), true);
    assert.deepEqual(fetchCalls, [], 'loaded tree entries should not hit the API');

    assert.equal(await validateFileExists('generated/new-file.md', fileTree), true);
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0], /\/api\/files\/read\?/);
    assert.match(fetchCalls[0], /meta=1/);

    assert.equal(await validateFileExists('missing/nope.md', fileTree), false);

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
