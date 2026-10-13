import path from 'node:path';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import type { RichMigrationRequest } from '../app/lib/collaboration/representation-migration-contract';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';

const migrationResponse = { success: true, representation: 'tiptap_blocks', ...COLLABORATION_CLIENT_CAPABILITIES };

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

test('normalizable Markdown remains editable Source until explicit formatted preparation', async ({ page }, testInfo) => {
  const requests: unknown[] = [];
  await page.route('**/api/files/collaboration/session', async (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { ...migrationResponse, migration: { requestId: route.request().postDataJSON().migration.requestId, status: 'migrated', documentId: 'migration-copy', lifecycleGeneration: 2 } } });
  });
  await page.goto('http://localhost:43122/');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('button', { name: /^(Read|Edit)$/u })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toBeEditable();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('1. First item\n\n2. Second item\n');
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Prepare formatted editing', exact: true }).click();
  await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible();
  await expect(page.locator('.tiptap li')).toHaveCount(2);
  expect(requests).toEqual([{ path: 'copy.md', representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES,
    migration: { requestId: expect.any(String), expectedDocumentId: 'migration-copy', expectedLifecycleGeneration: 1, documentSequence: 1, stateProof: expect.stringMatching(/^yjs-snapshot-sha256-v1:/) } }]);
  await expect(page.locator('body')).toHaveAttribute('data-checkpoints', '1');
  await page.screenshot({ path: testInfo.outputPath('edit-prepared.png') });
});

test('Source is read-only while the provider is paused and disappears when rich authority is admitted', async ({ page }) => {
  let finish!: () => void;
  const response = new Promise<void>((resolve) => { finish = resolve; });
  await page.route('**/api/files/collaboration/session', async (route) => {
    await response;
    return route.fulfill({ json: { ...migrationResponse, migration: { requestId: route.request().postDataJSON().migration.requestId, status: 'migrated', documentId: 'migration-copy', lifecycleGeneration: 2 } } });
  });
  await page.goto('http://localhost:43122/?canonical');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('button', { name: 'Preparing…', exact: true })).toBeDisabled();
  await expect(page.locator('.markdown-read-viewport')).toContainText('Canonical document');
  await expect(page.locator('body')).toHaveAttribute('data-disconnected', 'true');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).not.toBeEditable();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('# Canonical document\n\nUnchanged paragraph.\n');
  finish();
  await expect(page.locator('body')).toHaveAttribute('data-refreshed', 'true');
  await expect(page.getByRole('button', { name: /^(Source|Read|Edit)$/u })).toHaveCount(0);
  await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible();
  await expect(page.locator('.tiptap')).toContainText('Unchanged paragraph.');
});

test('late preparation cannot override a revoked parent write permission', async ({ page }) => {
  let finish!: () => void;
  const response = new Promise<void>((resolve) => { finish = resolve; });
  await page.route('**/api/files/collaboration/session', async (route) => {
    await response;
    return route.fulfill({ json: { ...migrationResponse, migration: { requestId: route.request().postDataJSON().migration.requestId,
      status: 'migrated', documentId: 'migration-copy', lifecycleGeneration: 2 } } });
  });
  await page.goto('http://localhost:43122/?canonical&revocable');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('button', { name: 'Preparing…', exact: true })).toBeDisabled();
  await expect(page.locator('body')).toHaveAttribute('data-disconnected', 'true');
  await page.getByRole('button', { name: 'Revoke fixture write permission', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).not.toBeEditable();
  finish();
  await expect(page.locator('body')).toHaveAttribute('data-refreshed', 'true');
  await expect(page.locator('.tiptap[contenteditable="false"]')).toBeVisible();
  await expect(page.locator('.tiptap[contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Source|Read|Edit|Prepare formatted editing)$/u })).toHaveCount(0);
  await expect(page.locator('.tiptap')).toContainText('Unchanged paragraph.');
  await expect(page.locator('#saved-value')).toHaveJSProperty('textContent', '# Canonical document\n\nUnchanged paragraph.\n');
});

test('switching Source presentation during preparation does not start a second migration', async ({ page }) => {
  let requests = 0;
  let finish!: () => void;
  const response = new Promise<void>((resolve) => { finish = resolve; });
  await page.route('**/api/files/collaboration/session', async (route) => {
    requests += 1;
    await response;
    return route.fulfill({ json: { ...migrationResponse, migration: { requestId: route.request().postDataJSON().migration.requestId, status: 'migrated', documentId: 'migration-copy', lifecycleGeneration: 2 } } });
  });
  await page.goto('http://localhost:43122/?canonical');
  await page.addScriptTag({ content: bundle });
  await expect.poll(() => requests).toBe(1);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).not.toBeEditable();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
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
    return route.fulfill({ json: { success: true, migration: { requestId: route.request().postDataJSON().migration.requestId, status: 'blocked', reason: 'room_active', documentId: 'migration-copy', lifecycleGeneration: 1 } } });
  });
  await page.goto('http://localhost:43122/');
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: 'Prepare formatted editing', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Other editors or pending changes' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preparing…', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).toHaveAttribute('data-disconnected', 'false');
  expect(requests).toBe(1);
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toBeEditable();
  await expect(page.getByRole('button', { name: /^(Source|Read|Edit)$/u })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Other editors or pending changes' })).toBeVisible();
  expect(requests).toBe(1);
  await page.getByRole('button', { name: 'Prepare formatted editing', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-checkpoints', '2');
  await expect.poll(() => requests).toBe(2);
});

test('editable Source alone does not migrate and manual preparation opens the writable document', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/files/collaboration/session', (route) => {
    requests += 1;
    return route.fulfill({ json: { ...migrationResponse, migration: { requestId: route.request().postDataJSON().migration.requestId, status: 'migrated', documentId: 'migration-copy', lifecycleGeneration: 2 } } });
  });
  await page.goto('http://localhost:43122/');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toBeEditable();
  expect(requests).toBe(0);
  await page.getByRole('button', { name: 'Prepare formatted editing', exact: true }).click();
  await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Source|Read|Edit)$/u })).toHaveCount(0);
  expect(requests).toBe(1);
});

test('local normalizable Markdown enters the writable rich document through explicit normalization', async ({ page }) => {
  await page.goto('http://localhost:43122/?local');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toBeEditable();
  await expect(page.getByRole('button', { name: /^(Read|Edit)$/u })).toHaveCount(0);
  await page.getByTestId('markdown-normalize-rich-text').click();
  await expect(page.locator('.tiptap[contenteditable="true"]')).toBeVisible();
  await expect(page.locator('#saved-value')).toHaveJSProperty('textContent', '1. First item\n2. Second item\n');
});

test('permission-derived read-only documents preserve Source and cannot prepare formatted editing', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/files/collaboration/session', (route) => { requests += 1; return route.abort(); });
  await page.goto('http://localhost:43122/?read-only');
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole('button', { name: /^(Read|Edit)$/u })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).not.toBeEditable();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('1. First item\n\n2. Second item\n');
  await expect(page.getByRole('button', { name: 'Prepare formatted editing', exact: true })).toHaveCount(0);
  await expect(page.locator('#saved-value')).toHaveJSProperty('textContent', '1. First item\n\n2. Second item\n');
  expect(requests).toBe(0);
});

test('unsupported Markdown preserves the exact editable Source and never starts migration', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/files/collaboration/session', (route) => { requests += 1; return route.abort(); });
  await page.goto('http://localhost:43122/?unsupported');
  await page.addScriptTag({ content: bundle });
  const original = '# Raw HTML\n\n<div>Keep exactly</div>\n';
  await expect(page.getByRole('button', { name: /^(Read|Edit)$/u })).toHaveCount(0);
  await expect(page.locator('.tiptap[contenteditable="true"]')).toHaveCount(0);
  await expect(page.locator('#saved-value')).toHaveJSProperty('textContent', original);
  expect(requests).toBe(0);
  await expect(page.getByTestId('markdown-source-preservation-warning')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(original);
  await expect(page.getByRole('textbox', { name: 'Markdown source' })).toBeEditable();
  await expect(page.locator('#saved-value')).toHaveJSProperty('textContent', original);
  await expect(page.getByRole('button', { name: 'Prepare formatted editing', exact: true })).toHaveCount(0);
  expect(requests).toBe(0);
});


test('an unknown response keeps the old provider paused and cancellation uses the same request', async ({ page }) => {
  const requests: Array<{ migration: RichMigrationRequest; migrationAction?: 'cancel' }> = [];
  await page.route('**/api/files/collaboration/session', route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.migrationAction === 'cancel') return route.fulfill({ json: { success: true, migration: {
      requestId: body.migration.requestId, status: 'blocked', reason: 'cancelled', documentId: 'migration-copy', lifecycleGeneration: 1 } } });
    return route.fulfill({ status: 503, json: { success: false } });
  });
  await page.goto('http://localhost:43122/');
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: 'Prepare formatted editing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-disconnected', 'true');
  expect(requests).toHaveLength(3);
  expect(new Set(requests.map(body => body.migration.requestId)).size).toBe(1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-disconnected', 'false');
  expect(requests[3].migration).toEqual(requests[0].migration);
});
