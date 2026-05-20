import assert from 'node:assert/strict';
import { useFileStore, type FileNode } from '../app/store/file-store';

const originalFetch = globalThis.fetch;

async function main() {
  const calls: string[] = [];
  const responses: Record<string, FileNode[]> = {
    '.': [
      { name: 'docs', path: 'docs', type: 'directory' },
      { name: 'src', path: 'src', type: 'directory' },
    ],
    docs: [
      { name: 'fresh.md', path: 'docs/fresh.md', type: 'file' },
    ],
    src: [
      { name: 'app', path: 'src/app', type: 'directory' },
    ],
    'src/app': [
      { name: 'page.tsx', path: 'src/app/page.tsx', type: 'file' },
    ],
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.searchParams.get('path') || '.';
    calls.push(path);
    return Response.json({ success: true, data: responses[path] ?? [] });
  }) as typeof fetch;

  try {
    useFileStore.setState({
      fileTree: [
        {
          name: 'docs',
          path: 'docs',
          type: 'directory',
          children: [{ name: 'stale.md', path: 'docs/stale.md', type: 'file' }],
        },
        {
          name: 'src',
          path: 'src',
          type: 'directory',
          children: [{ name: 'app', path: 'src/app', type: 'directory', children: [] }],
        },
      ],
      browserMode: 'tree',
      currentDirectory: 'docs',
      expandedDirs: new Set(['src', 'src/app']),
    });

    await useFileStore.getState().refreshVisibleTree();

    assert.deepEqual(calls, ['.', 'docs', 'src', 'src/app']);

    const state = useFileStore.getState();
    const docs = state.fileTree.find((node) => node.path === 'docs');
    const src = state.fileTree.find((node) => node.path === 'src');
    const app = src?.children?.find((node) => node.path === 'src/app');

    assert.equal(docs?.children?.[0]?.path, 'docs/fresh.md');
    assert.equal(app?.children?.[0]?.path, 'src/app/page.tsx');
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('file-browser-refresh-test: ok');
}

void main();
