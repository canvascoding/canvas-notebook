import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { getSchema } from '@tiptap/core';
import { createRichMarkdownManager, richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { equivalentRichDocument } from '../app/lib/markdown/core/equivalence';

test('list deletion converges in two editors and preserves a reloadable checkpoint', async ({ page }, testInfo) => {
  const bundle = await build({ entryPoints: ['tests/fixtures/markdown-list-identities-browser.ts'],
    bundle: true, write: false, format: 'iife', platform: 'browser' });
  await page.setContent(`<style>
    body{font:18px system-ui;margin:40px;color:#222}.grid{display:grid;grid-template-columns:1fr 1fr;gap:40px}
    .ProseMirror{border:1px solid #aaa;padding:24px;min-height:350px}pre{white-space:pre-wrap;font-size:14px}
    </style><h1>Collaboration regression copy</h1><div class="grid">
    <section><h2>Author</h2><div id="author"></div></section>
    <section><h2>Connected editor</h2><div id="peer"></div></section></div>
    <pre id="markdown"></pre><pre id="snapshot" hidden></pre>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const editor = page.locator('#author .ProseMirror');
  await editor.locator('li p').filter({ hasText: /^Middle item$/ }).click();
  const lineStart = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';
  const selectLine = process.platform === 'darwin' ? 'Meta+Shift+ArrowRight' : 'Shift+End';
  await page.keyboard.press(lineStart);
  await page.keyboard.press(selectLine);
  await expect.poll(() => page.evaluate(() => String(getSelection()))).toBe('Middle item');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(editor.locator('ol')).toHaveCount(2);
  await expect(page.locator('#peer ol')).toHaveCount(2);
  await expect(editor).toContainText('First item');
  await expect(editor).toContainText('Last item');
  await expect(editor).not.toContainText('Middle item');
  const ids = await editor.locator('[data-id]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-id')));
  expect(new Set(ids).size).toBe(ids.length);
  const markdown = (await page.locator('#markdown').textContent())!;
  const json = JSON.parse((await page.locator('#snapshot').textContent())!);
  const manager = createRichMarkdownManager();
  const reopened = getSchema(richMarkdownCodecExtensions()).nodeFromJSON(manager.parse(markdown));
  reopened.check();
  expect(equivalentRichDocument(json, reopened.toJSON())).toBe(true);
  expect(manager.serialize(manager.parse(markdown))).toBe(markdown);
  await page.screenshot({ path: testInfo.outputPath('list-split-saved.png'), fullPage: true });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor.locator('ol')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(editor.locator('ol')).toHaveCount(2);
  await expect(page.locator('#peer ol')).toHaveCount(2);
  await expect(page.locator('#markdown')).toHaveText(markdown);
});
