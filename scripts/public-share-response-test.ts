import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { fileContentDisposition } from '../app/lib/files/content-disposition';

for (const fileName of ['日本語.pdf', 'Notizen 📎.pdf', 'evil"\r\nheader.pdf', '\ud800.pdf']) {
  const headers = new Headers({ 'Content-Disposition': fileContentDisposition(fileName) });
  assert.doesNotMatch(headers.get('Content-Disposition') || '', /[\r\n]/);
  assert.match(headers.get('Content-Disposition') || '', /filename\*=UTF-8''/);
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-public-response-'));
  process.env.DATA = tempRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  try {
    const { publicShareFileStreamResponse } = await import('../app/lib/public-sharing/public-file-response');
    const file = {
      workspacePath: 'Notizen 📎.md', fileName: 'Notizen 📎.md',
      fullPath: '/not-opened-for-head', mimeType: 'text/markdown', sizeBytes: 10, asSiteAsset: false,
    };
    const head = (range?: string, sizeBytes = 10) => publicShareFileStreamResponse(
      new NextRequest('http://localhost/public/files/token/file.md?download=1', {
        method: 'HEAD', headers: range ? { range } : undefined,
      }), { ...file, sizeBytes }, 'HEAD', 'strict',
    );
    const normal = head();
    assert.equal(normal.status, 200);
    assert.equal(normal.headers.get('content-length'), '10');
    assert.match(normal.headers.get('content-disposition') || '', /filename\*=UTF-8''Notizen%20%F0%9F%93%8E\.md/);
    for (const [range, contentRange] of [
      ['bytes=0-999', 'bytes 0-9/10'], ['bytes=5-', 'bytes 5-9/10'],
      ['bytes=-3', 'bytes 7-9/10'], ['bytes=-999', 'bytes 0-9/10'],
    ]) {
      const response = head(range);
      assert.equal(response.status, 206, range);
      assert.equal(response.headers.get('content-range'), contentRange);
    }
    for (const range of ['bytes=10-', 'bytes=8-3', 'bytes=-0', 'bytes=-', 'bytes=0-9007199254740993']) {
      assert.equal(head(range).status, 416, range);
    }
    assert.equal(head(undefined, 0).status, 200);
    assert.equal(head('bytes=0-', 0).status, 416);
    console.log('public-share-response-test: ok');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
