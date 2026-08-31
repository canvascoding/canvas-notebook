import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createDesktopFileDragCache,
  normalizeDesktopFileDragRequest,
} from './file-drag.mjs';

test('normalizes only safe workspace drag requests', () => {
  assert.deepEqual(normalizeDesktopFileDragRequest({
    workspaceId: 'workspace-one',
    paths: ['reports/q1.pdf', 'reports/q1.pdf', 'brief.md'],
  }), {
    workspaceId: 'workspace-one',
    paths: ['reports/q1.pdf', 'brief.md'],
  });
  assert.equal(normalizeDesktopFileDragRequest({ workspaceId: 'workspace-one', paths: ['../secrets.txt'] }), null);
  assert.equal(normalizeDesktopFileDragRequest({ workspaceId: '', paths: ['brief.md'] }), null);
});

test('downloads workspace files through the renderer session before starting native drag', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'canvas-file-drag-test-'));
  const cache = createDesktopFileDragCache({ tempRoot, iconPath: '/tmp/icon.png' });
  const requests = [];
  const startedDrags = [];
  const webContents = {
    session: {
      fetch: async (url, options) => {
        requests.push({ url, options });
        return new Response('workspace file', {
          headers: { 'content-type': 'text/plain' },
        });
      },
    },
    startDrag: (item) => startedDrags.push(item),
  };
  const request = { workspaceId: 'workspace-one', paths: ['reports/q1.txt'] };

  assert.equal(cache.start(webContents, request), false);
  const [localPath] = await cache.prepare(webContents, 'https://canvas.example', request);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://canvas.example/api/files/download?path=reports%2Fq1.txt&workspaceId=workspace-one');
  assert.equal(requests[0].options.headers['x-canvas-workspace-id'], 'workspace-one');
  assert.equal(await readFile(localPath, 'utf8'), 'workspace file');
  assert.equal(cache.start(webContents, request), true);
  assert.deepEqual(startedDrags, [{ files: [localPath], icon: '/tmp/icon.png' }]);

  await cache.dispose();
  await rm(tempRoot, { recursive: true, force: true });
});
