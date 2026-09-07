import path from 'node:path';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

let bundle: string;
let browserErrors: string[];
test.beforeAll(async () => {
  const built = await build({ entryPoints: ['tests/fixtures/markdown-migration-browser.tsx'],
    bundle: true, write: false, format: 'iife', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [{ name: 'mock-external-editor-services', setup(builder) {
      builder.onResolve({ filter: /collaboration\/client$/ }, (args) => args.importer.endsWith('/MarkdownEditor.tsx')
        ? { path: path.resolve('tests/fixtures/markdown-migration-session.ts') } : undefined);
      // Source editing is a separate Monaco surface. Keep its real readOnly contract visible.
      builder.onResolve({ filter: /^\.\/CodeEditorClient$/ }, () => ({ path: 'source-editor', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'tsx', resolveDir: process.cwd(),
        contents: 'import React from "react"; export function CodeEditor({value,readOnly,onChange}) { return <textarea aria-label="Markdown source" value={value} readOnly={readOnly} onChange={e=>onChange(e.target.value)}/>; }',
      }));
    } }],
  });
  bundle = built.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.route('http://localhost:43122/**', (route) => route.fulfill({
    contentType: 'text/html', body: '<style>body{font:16px system-ui;margin:24px}button{padding:8px;margin:4px}#root{height:650px}textarea{width:90%;height:200px}</style><div id="root"></div>',
  }));
});
test.afterEach(() => expect(browserErrors).toEqual([]));

test('Edit prepares normalizable Markdown and opens the actual rich editor with one click', async ({ page }, testInfo) => {
  const requests: unknown[] = [];
  await page.route('**/api/files/collaboration/session', async (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { success: true, representation: 'tiptap_xml' } });
  });
  await page.goto('http://localhost:43122/');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('button', { name: 'Read', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible();
  await expect(page.locator('.tiptap li')).toHaveCount(2);
  expect(requests).toEqual([{ path: 'copy.md', representation: 'auto', allowRichMigration: true, expectedLifecycleGeneration: 1 }]);
  await expect(page.locator('body')).toHaveAttribute('data-checkpoints', '1');
  await page.screenshot({ path: testInfo.outputPath('edit-prepared.png') });
});

for (const chosenMode of ['Source', 'Read']) {
  test(`keeps ${chosenMode} selected when preparation completes`, async ({ page }) => {
    let finish!: () => void;
    const response = new Promise<void>((resolve) => { finish = resolve; });
    await page.route('**/api/files/collaboration/session', async (route) => {
      await response;
      return route.fulfill({ json: { success: true, representation: 'tiptap_xml' } });
    });
    await page.goto('http://localhost:43122/');
    await page.addScriptTag({ content: bundle });
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Preparing…', exact: true })).toBeDisabled();
    await expect(page.locator('.markdown-read-viewport')).toContainText('First item');
    await page.getByRole('button', { name: chosenMode, exact: true }).click();
    if (chosenMode === 'Source') await expect(page.getByRole('textbox', { name: 'Markdown source' })).not.toBeEditable();
    finish();
    await expect(page.locator('body')).toHaveAttribute('data-refreshed', 'true');
    await expect(page.getByRole('button', { name: chosenMode, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.tiptap[contenteditable="true"]')).toHaveCount(0);
  });
}

test('returning to Edit during preparation does not start a second migration', async ({ page }) => {
  let requests = 0;
  let finish!: () => void;
  const response = new Promise<void>((resolve) => { finish = resolve; });
  await page.route('**/api/files/collaboration/session', async (route) => {
    requests += 1;
    await response;
    return route.fulfill({ json: { success: true, representation: 'tiptap_xml' } });
  });
  await page.goto('http://localhost:43122/');
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preparing…', exact: true })).toBeDisabled();
  finish();
  await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-checkpoints', '1');
  expect(requests).toBe(1);
});

test('a blocked preparation leaves source usable and retries only when requested', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/files/collaboration/session', (route) => {
    requests += 1;
    return route.fulfill({ status: 409, json: { success: false, error: 'active_editors' } });
  });
  await page.goto('http://localhost:43122/');
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Other editors or pending changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preparing…', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-disconnected', 'false');
  expect(requests).toBe(3);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toBeEditable();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Other editors or pending changes' })).toBeVisible();
  expect(requests).toBe(3);
  await page.getByRole('button', { name: 'Prepare formatted editing', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-checkpoints', '2');
  await expect.poll(() => requests).toBe(6);
});

test('Source alone does not migrate and manual preparation opens Edit', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/files/collaboration/session', (route) => {
    requests += 1;
    return route.fulfill({ json: { success: true, representation: 'tiptap_xml' } });
  });
  await page.goto('http://localhost:43122/');
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toBeEditable();
  expect(requests).toBe(0);
  await page.getByRole('button', { name: 'Prepare formatted editing', exact: true }).click();
  await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(requests).toBe(1);
});

test('local normalizable Markdown also enters Edit with one click', async ({ page }) => {
  await page.goto('http://localhost:43122/?local');
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible();
  await expect(page.locator('#saved-value')).toHaveJSProperty('textContent', '1. First item\n2. Second item\n');
});

test('read-only and unsupported documents keep the existing content protection', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/files/collaboration/session', (route) => { requests += 1; return route.abort(); });
  await page.goto('http://localhost:43122/?read-only');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Prepare formatted editing', exact: true })).toHaveCount(0);
  await page.goto('http://localhost:43122/?unsupported');
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Raw HTML\n\n<div>Keep exactly</div>\n');
  await expect(page.getByRole('button', { name: 'Prepare formatted editing', exact: true })).toHaveCount(0);
  expect(requests).toBe(0);
});
