import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

let bundle: string;
test.beforeAll(async () => {
  const built = await build({ entryPoints: ['tests/fixtures/collaboration-recovery-browser.tsx'],
    bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
  bundle = built.outputFiles[0].text;
});

for (const action of ['Close document', 'Open other document', 'Delete document']) {
  test(`${action} preserves degraded edits and releases the document`, async ({ page }) => {
    await page.route('http://localhost:43121/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/files/delete') return route.fulfill({ json: { success: true, deleted: ['broken.md'] } });
      if (url.pathname === '/api/files/read') return route.fulfill({ json: { success: true, data: { path: 'other.md', content: 'Other document' } } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { success: true, data: [], tree: [] } });
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><pre id="restored"></pre>' });
    });
    await page.goto('http://localhost:43121/');
    await page.addScriptTag({ content: bundle });
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByTestId('current-path')).toHaveText(action === 'Open other document' ? 'other.md' : 'closed');
    await expect(page.locator('#restored')).toHaveText('First item\nLast item');
  });
}

test('recovery export allows closing when local storage fails', async ({ page }) => {
  await page.route('http://localhost:43121/**', (route) => route.fulfill({
    contentType: 'text/html', body: '<div id="root"></div><pre id="restored"></pre>',
  }));
  await page.goto('http://localhost:43121/?fail-storage');
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: 'Close document', exact: true }).click();
  await expect(page.getByTestId('current-path')).toHaveText('broken.md');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download recovery state', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('canvas-recovery.yjs');
  await page.getByRole('button', { name: 'Close document', exact: true }).click();
  await expect(page.getByTestId('current-path')).toHaveText('closed');
});

test('creates a separate editable recovery copy from the live content', async ({ page }, testInfo) => {
  let copy: { path: string; content: string } | undefined;
  await page.route('http://localhost:43121/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/files/write') {
      copy = route.request().postDataJSON();
      return route.fulfill({ json: { success: true, data: { path: copy!.path } } });
    }
    if (url.pathname === '/api/files/read') return route.fulfill({ json: { success: true, data: copy } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { success: true, data: [], tree: [] } });
    return route.fulfill({ contentType: 'text/html', body: '<style>body{font:16px system-ui;margin:32px}button{padding:10px;margin:5px}p{max-width:800px}</style><div id="root"></div><pre id="restored"></pre>' });
  });
  await page.goto('http://localhost:43121/');
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: 'Create editable recovery copy' }).waitFor();
  await page.screenshot({ path: testInfo.outputPath('recovery-actions.png') });
  await page.getByRole('button', { name: 'Create editable recovery copy' }).click();
  await expect(page.getByTestId('current-path')).toHaveText(/^broken\.recovered-.+\.md$/);
  expect(copy?.content).toBe('First item\nLast item');
});
