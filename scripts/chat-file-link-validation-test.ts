import assert from 'node:assert/strict';
import { validateFileExists } from '../app/lib/chat/validate-file-paths';
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
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('chat-file-link-validation-test: ok');
}

void main();
