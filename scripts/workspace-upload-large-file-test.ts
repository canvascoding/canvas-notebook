import assert from 'node:assert/strict';

import { WORKSPACE_UPLOAD_BROWSER_CHUNK_SIZE, WORKSPACE_UPLOAD_CHUNK_SIZE } from '../app/lib/files/upload-limits';
import { uploadWorkspaceFilesInChunks } from '../app/lib/files/workspace-upload-client';

const fileSize = 24 * 1024 * 1024;
const proxyBodyLimit = 10 * 1024 * 1024;
const sentChunks: Array<{ offset: number; size: number }> = [];

class ProxyLimitedXMLHttpRequest {
  status = 0;
  statusText = '';
  responseText = '';
  withCredentials = false;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private url = '';

  open(_method: string, url: string) {
    this.url = url;
  }

  setRequestHeader() {}

  send(body: Blob) {
    const query = new URL(this.url, 'http://localhost').searchParams;
    const offset = Number(query.get('offset'));
    const expectedBytes = Number(query.get('expectedBytes'));
    assert.equal(body.size, expectedBytes);
    sentChunks.push({ offset, size: body.size });
    queueMicrotask(() => {
      this.status = body.size > proxyBodyLimit ? 400 : 200;
      this.responseText = body.size > proxyBodyLimit
        ? JSON.stringify({ success: false, error: `Upload chunk size mismatch: expected ${expectedBytes} bytes, received ${proxyBodyLimit}.` })
        : JSON.stringify({ success: true });
      this.onload?.();
    });
  }
}

async function main() {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = ProxyLimitedXMLHttpRequest as unknown as typeof XMLHttpRequest;
  try {
    const file = new File([new Uint8Array(fileSize)], 'Werkvertrag.pdf', { type: 'application/pdf' });
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/files/uploads' && init?.method === 'POST') {
        return Response.json({
          success: true,
          upload: {
            id: '11111111-1111-4111-8111-111111111111',
            files: [{
              id: '22222222-2222-4222-8222-222222222222',
              sourceIndex: 0,
              relativePath: file.name,
              targetPath: file.name,
              size: file.size,
              uploadedBytes: 0,
              status: 'pending',
            }],
          },
          limits: { chunkBytes: 16 * 1024 * 1024 },
        }, { status: 201 });
      }
      if (url.endsWith('/complete') && init?.method === 'POST') {
        return Response.json({ success: true, committed: { targetPath: file.name } });
      }
      if (init?.method === 'DELETE') return Response.json({ success: true });
      throw new Error(`Unexpected fetch: ${url}`);
    };

    const result = await uploadWorkspaceFilesInChunks({
      files: [{ file, path: file.name }],
      targetDir: '.',
      workspaceId: 'workspace-1',
    });

    assert.equal(WORKSPACE_UPLOAD_CHUNK_SIZE, 16 * 1024 * 1024);
    assert.equal(WORKSPACE_UPLOAD_BROWSER_CHUNK_SIZE, 8 * 1024 * 1024);
    assert.equal(result.completed.length, 1);
    assert.equal(result.failed.length, 0);
    assert.deepEqual(sentChunks, [
      { offset: 0, size: WORKSPACE_UPLOAD_BROWSER_CHUNK_SIZE },
      { offset: WORKSPACE_UPLOAD_BROWSER_CHUNK_SIZE, size: WORKSPACE_UPLOAD_BROWSER_CHUNK_SIZE },
      { offset: 2 * WORKSPACE_UPLOAD_BROWSER_CHUNK_SIZE, size: WORKSPACE_UPLOAD_BROWSER_CHUNK_SIZE },
    ]);
    console.log('workspace-upload-large-file-test: ok');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXhr;
  }
}

void main();
