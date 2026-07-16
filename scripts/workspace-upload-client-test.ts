import assert from 'node:assert/strict';

import {
  WorkspaceBatchUploadError,
  uploadWorkspaceFilesInChunks,
  type WorkspaceUploadFileProgress,
} from '../app/lib/files/workspace-upload-client';

type XhrOutcome =
  | { type: 'success' }
  | { type: 'network' }
  | { type: 'http'; status: number; body: string };

class FakeXMLHttpRequest {
  static outcomes: XhrOutcome[] = [];
  static sentPaths: string[] = [];

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
    FakeXMLHttpRequest.sentPaths.push(this.url);
    const outcome = FakeXMLHttpRequest.outcomes.shift() ?? { type: 'success' as const };
    queueMicrotask(() => {
      if (outcome.type === 'network') {
        this.onerror?.();
        return;
      }
      if (outcome.type === 'http') {
        this.status = outcome.status;
        this.responseText = outcome.body;
        this.onload?.();
        return;
      }
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: body.size,
        total: body.size,
      } as ProgressEvent);
      this.status = 200;
      this.responseText = JSON.stringify({ success: true });
      this.onload?.();
    });
  }
}

function uploadSessionResponse(files: File[]) {
  return Response.json({
    success: true,
    upload: {
      id: '11111111-1111-4111-8111-111111111111',
      files: files.map((file, sourceIndex) => ({
        id: `${sourceIndex + 1}`.repeat(8).slice(0, 8) + '-1111-4111-8111-111111111111',
        sourceIndex,
        relativePath: file.name,
        targetPath: file.name,
        size: file.size,
        uploadedBytes: 0,
        status: 'pending',
      })),
    },
    limits: { chunkBytes: 16 * 1024 * 1024 },
  }, { status: 201 });
}

async function successfulRetryScenario() {
  const files = [
    new File(['first'], 'first.txt', { type: 'text/plain' }),
    new File(['second'], 'second.txt', { type: 'text/plain' }),
  ];
  const events: WorkspaceUploadFileProgress[] = [];
  let createCalls = 0;
  let completeCalls = 0;
  let deleteCalls = 0;

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/files/uploads' && init?.method === 'POST') {
      createCalls += 1;
      if (createCalls === 1) throw new TypeError('Temporary network failure');
      return uploadSessionResponse(files);
    }
    if (url.endsWith('/complete') && init?.method === 'POST') {
      completeCalls += 1;
      if (completeCalls === 1) {
        return Response.json({ success: false, error: 'Temporary server problem', code: 'TEMPORARY' }, { status: 503 });
      }
      return Response.json({ success: true });
    }
    if (init?.method === 'DELETE') {
      deleteCalls += 1;
      return Response.json({ success: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  FakeXMLHttpRequest.outcomes = [
    { type: 'network' },
    { type: 'success' },
    { type: 'success' },
  ];
  FakeXMLHttpRequest.sentPaths = [];

  const result = await uploadWorkspaceFilesInChunks({
    files: files.map((file) => ({ file, path: file.name })),
    targetDir: '.',
    workspaceId: 'workspace-1',
    onFileProgress: (event) => events.push(event),
  });

  assert.equal(createCalls, 2, 'session creation should retry a transient network error');
  assert.equal(result.completed.length, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(deleteCalls, 1);
  assert.ok(completeCalls >= 3, 'completion should retry once, then complete both files');
  assert.equal(FakeXMLHttpRequest.sentPaths.length, 3, 'first chunk should retry, second should upload once');
  assert.ok(events.some((event) => event.status === 'retrying' && event.path === 'first.txt'));
  assert.equal(events.filter((event) => event.status === 'completed').length, 2);
}

async function partialFailureScenario() {
  const files = [
    new File(['broken'], 'broken.txt', { type: 'text/plain' }),
    new File(['works'], 'works.txt', { type: 'text/plain' }),
  ];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/files/uploads' && init?.method === 'POST') return uploadSessionResponse(files);
    if (url.endsWith('/complete') && init?.method === 'POST') return Response.json({ success: true });
    if (init?.method === 'DELETE') return Response.json({ success: true });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  FakeXMLHttpRequest.outcomes = [
    { type: 'http', status: 400, body: JSON.stringify({ success: false, error: 'Invalid file content', code: 'INVALID_FILE' }) },
    { type: 'success' },
  ];
  FakeXMLHttpRequest.sentPaths = [];

  await assert.rejects(
    () => uploadWorkspaceFilesInChunks({
      files: files.map((file) => ({ file, path: file.name })),
      targetDir: '.',
      workspaceId: 'workspace-1',
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceBatchUploadError);
      assert.equal(error.result.completed.length, 1);
      assert.equal(error.result.completed[0].path, 'works.txt');
      assert.equal(error.result.failed.length, 1);
      assert.equal(error.result.failed[0].path, 'broken.txt');
      assert.match(error.message, /1 of 2 files uploaded successfully/);
      assert.match(error.message, /Invalid file content/);
      return true;
    },
  );
  assert.equal(FakeXMLHttpRequest.sentPaths.length, 2, 'queue should continue after a permanent file error');
}

async function proxyLimitScenario() {
  const file = new File(['test'], 'proxy.txt');
  globalThis.fetch = async () => new Response('<html>Payload Too Large</html>', {
    status: 413,
    statusText: 'Payload Too Large',
  });
  await assert.rejects(
    () => uploadWorkspaceFilesInChunks({
      files: [{ file, path: file.name }],
      targetDir: '.',
      workspaceId: 'workspace-1',
    }),
    /server or reverse proxy rejected the upload as too large \(HTTP 413\)/i,
  );
}

async function main() {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
  try {
    await successfulRetryScenario();
    await partialFailureScenario();
    await proxyLimitScenario();
    console.log('workspace-upload-client-test: ok');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXhr;
  }
}

void main();
