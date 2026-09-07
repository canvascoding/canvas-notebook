import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';

let bundle: string;
test.beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/markdown-adjacent-lists-browser.ts'],
    bundle: true, write: false, format: 'iife', platform: 'browser' });
  bundle = result.outputFiles[0].text;
});

const validateCheckpoint = (update: string) => JSON.parse(execFileSync(process.execPath, [
  '--conditions', 'react-server', '--import', 'tsx', '-e', `
    const fs = require('node:fs');
    const {Y} = require('./app/lib/collaboration/server-runtime.ts');
    const {validateRichMarkdownYDoc,createRichMarkdownYDoc} = require('./app/lib/collaboration/markdown-state.ts');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(fs.readFileSync(0,'utf8'), 'base64'));
    const result = validateRichMarkdownYDoc(doc);
    const reopened = result.valid ? createRichMarkdownYDoc(result.markdown) : null;
    console.log(JSON.stringify({valid:result.valid, code:result.code, reloaded:reopened && validateRichMarkdownYDoc(reopened).valid}));
    reopened?.destroy(); doc.destroy();
  `,
], { input: update, encoding: 'utf8' }));

test('removing the middle item and its empty paragraph keeps a valid server checkpoint', async ({ page }, testInfo) => {
  await page.setContent(`<style>body{font:18px system-ui;margin:30px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:30px}.tiptap{border:1px solid #aaa;padding:20px;min-height:300px}</style>
    <h1>List deletion regression copy</h1><div class="grid"><div id="author"></div><div id="peer"></div></div><pre id="update" hidden></pre>`);
  await page.addScriptTag({ content: bundle });
  const author = page.locator('#author .tiptap');
  await author.locator('li p').filter({ hasText: /^Middle item$/ }).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+ArrowRight' : 'Shift+End');
  await expect.poll(() => page.evaluate(() => String(getSelection()))).toBe('Middle item');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(author.locator('ol')).toHaveCount(2);
  expect(validateCheckpoint((await page.locator('#update').textContent())!).valid).toBe(true);
  await page.keyboard.press('Backspace');
  await expect(author.locator(':scope > ol + ol')).toHaveCount(1);
  await expect(page.locator('#peer .tiptap > ol + ol')).toHaveCount(1);
  expect(validateCheckpoint((await page.locator('#update').textContent())!)).toEqual({ valid: true, reloaded: true });
  await expect(author).not.toContainText('Middle item');
  await expect(page.locator('#peer .tiptap')).not.toContainText('Middle item');
  await page.screenshot({ path: testInfo.outputPath('adjacent-lists-checkpoint.png') });
  await page.keyboard.press('ControlOrMeta+z');
  expect(validateCheckpoint((await page.locator('#update').textContent())!).valid).toBe(true);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(author.locator(':scope > ol + ol')).toHaveCount(1);
  expect(validateCheckpoint((await page.locator('#update').textContent())!).valid).toBe(true);
});
