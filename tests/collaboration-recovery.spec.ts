import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import * as Y from 'yjs';

const fixtureOrigin = 'http://localhost:43121';
const workspaceId = 'recovery-workspace';
const recoveryContent = 'First item\nLast item';
const recoveryPath = /^broken\.recovered-[a-f0-9-]+\.md$/;
let bundle: string;
test.beforeAll(async () => {
  const built = await build({ entryPoints: ['tests/fixtures/collaboration-recovery-browser.tsx'],
    bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  bundle = built.outputFiles[0].text;
});

async function mountFixture(page: Page, options: { failStorage?: boolean; allowCopy?: boolean } = {}) {
  const files = new Map([['broken.md', recoveryContent], ['other.md', 'Other document']]);
  const writes: Array<{ path: string; content: string; expectedSha256: null; baseRevisionId: null }> = [];
  const reads: string[] = [];
  const treeReads: string[] = [];
  const unexpected: string[] = [];
  await page.route(`${fixtureOrigin}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/' && request.method() === 'GET') {
      return route.fulfill({ contentType: 'text/html', body: '<style>body{font:16px system-ui;margin:32px}button{padding:10px;margin:5px}p{max-width:800px}output{display:block}</style><div id="root"></div><pre id="restored"></pre>' });
    }
    if (url.pathname.startsWith('/api/files/')) expect(request.headers()['x-canvas-workspace-id']).toBe(workspaceId);
    if (url.pathname === '/api/files/delete' && request.method() === 'DELETE') {
      expect(request.postDataJSON()).toEqual({ path: ['broken.md'] });
      files.delete('broken.md');
      return route.fulfill({ json: { deleted: ['broken.md'], failed: [] } });
    }
    if (url.pathname === '/api/files/write' && request.method() === 'POST' && options.allowCopy) {
      const write = request.postDataJSON();
      expect(write).toEqual({ path: expect.stringMatching(recoveryPath), content: recoveryContent,
        expectedSha256: null, baseRevisionId: null });
      writes.push(write);
      files.set(write.path, write.content);
      return route.fulfill({ json: { success: true, data: { path: write.path } } });
    }
    if (url.pathname === '/api/files/read' && request.method() === 'GET') {
      const filePath = url.searchParams.get('path') ?? '';
      if (filePath === 'other.md' || writes.some(write => write.path === filePath)) {
        reads.push(filePath);
        return route.fulfill({ json: { success: true, data: { path: filePath, content: files.get(filePath),
          collaboration: { crdtCapable: false } } } });
      }
    }
    if (url.pathname === '/api/files/tree' && request.method() === 'GET'
      && url.searchParams.get('path') === '.' && url.searchParams.get('workspaceId') === workspaceId) {
      treeReads.push('.');
      return route.fulfill({ json: { success: true, data: [...files.keys()].map(filePath => ({
        name: filePath, path: filePath, type: 'file',
      })) } });
    }
    if (url.pathname === '/api/files/quick-access' && request.method() === 'POST'
      && reads.includes(request.postDataJSON().path)) {
      return route.fulfill({ json: { success: true } });
    }
    unexpected.push(`${request.method()} ${url.pathname}${url.search}`);
    return route.fulfill({ status: 404, json: { success: false, error: 'Unexpected recovery fixture request.' } });
  });
  await page.goto(`${fixtureOrigin}/${options.failStorage ? '?fail-storage' : ''}`);
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('button', { name: 'Close document', exact: true })).toBeEnabled();
  return { writes, reads, treeReads, unexpected };
}

async function expectCompleteBackup(page: Page) {
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Back up complete document', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('canvas-recovery.yjs');
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const snapshot = new Uint8Array(await readFile(downloadPath!));
  expect(Y.decodeUpdate(snapshot).ds.clients.size).toBeGreaterThan(0);
  const restored = new Y.Doc();
  try {
    Y.applyUpdate(restored, snapshot);
    expect(restored.getText('content').toString()).toBe(recoveryContent);
  } finally { restored.destroy(); }
}

for (const action of ['Close document', 'Open other document', 'Delete document']) {
  test(`${action} preserves degraded edits through its document transition`, async ({ page }) => {
    const requests = await mountFixture(page);
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.locator('#restored')).toHaveText(recoveryContent);
    await expect(page.getByTestId('fixture-error')).toHaveText('');
    if (action === 'Delete document') {
      await expect(page.getByTestId('current-path')).toHaveText('broken.md');
      await expect(page.getByTestId('current-unavailable')).toHaveText('deleted');
      await expect(page.getByTestId('current-content')).toHaveText(recoveryContent);
      await expect(page.getByTestId('editor-draft')).toHaveText(recoveryContent);
      await expect(page.getByTestId('collaboration-view')).toHaveText('retained');
      await expectCompleteBackup(page);
      await page.getByRole('button', { name: 'Close document', exact: true }).click();
      await expect(page.getByTestId('editor-draft')).toHaveText('');
    }
    await expect(page.getByTestId('current-path')).toHaveText(action === 'Open other document' ? 'other.md' : 'closed');
    await expect(page.getByTestId('collaboration-view')).toHaveText('detached');
    await expect(page.locator('#restored')).toHaveText(recoveryContent);
    await expect(page.getByTestId('fixture-error')).toHaveText('');
    expect(requests.unexpected).toEqual([]);
    expect(requests.writes).toEqual([]);
  });
}

test('recovery export allows closing when local storage fails', async ({ page }) => {
  const requests = await mountFixture(page, { failStorage: true });
  await page.getByRole('button', { name: 'Close document', exact: true }).click();
  await expect(page.getByTestId('current-path')).toHaveText('broken.md');
  await expect(page.getByTestId('fixture-error')).toContainText('Local storage unavailable');
  await expect(page.getByTestId('collaboration-view')).toHaveText('retained');
  await expectCompleteBackup(page);
  await page.getByRole('button', { name: 'Close document', exact: true }).click();
  await expect(page.getByTestId('current-path')).toHaveText('closed');
  await expect(page.getByTestId('collaboration-view')).toHaveText('detached');
  await expect(page.locator('#restored')).toHaveText(recoveryContent);
  await expect(page.getByTestId('fixture-error')).toHaveText('');
  expect(requests.unexpected).toEqual([]);
});

test('creates a separate editable recovery copy from the live content', async ({ page }, testInfo) => {
  const requests = await mountFixture(page, { allowCopy: true });
  await page.getByRole('button', { name: 'Create editable copy', exact: true }).waitFor();
  await page.screenshot({ path: testInfo.outputPath('recovery-actions.png') });
  await page.getByRole('button', { name: 'Create editable copy', exact: true }).click();
  await expect(page.getByTestId('current-path')).toHaveText(recoveryPath);
  await expect(page.getByTestId('current-content')).toHaveText(recoveryContent);
  await expect(page.getByTestId('browser-reveal')).toHaveText('ready');
  await expect(page.getByTestId('collaboration-view')).toHaveText('detached');
  await expect(page.getByTestId('fixture-error')).toHaveText('');
  expect(requests.writes).toHaveLength(1);
  expect(requests.reads).toEqual([requests.writes[0].path]);
  expect(requests.treeReads.length).toBeGreaterThan(0);
  expect(requests.unexpected).toEqual([]);
});
