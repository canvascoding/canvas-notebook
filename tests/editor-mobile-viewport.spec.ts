import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { serializeRichMarkdownBody } from '../app/lib/markdown/rich-markdown-codec';

let bundle: string;
let css: string;
const fixtureUrl = 'http://mobile-editor-viewport.test/';
const content = serializeRichMarkdownBody(Array.from({ length: 60 }, (_, index) => `Paragraph ${index}. `
  + 'Surrounding text stays visible while writing. '.repeat(3).trimEnd()).join('\n\n'));

test.beforeAll(async () => {
  bundle = (await build({ entryPoints: ['tests/fixtures/markdown-mode-position-browser.tsx'], bundle: true,
    write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' } })).outputFiles[0].text;
  const from = path.resolve('app/globals.css');
  css = (await postcss([tailwindcss()]).process(await readFile(from, 'utf8'), { from })).css;
});

async function mount(page: Page, mode: 'rich' | 'source') {
  await page.route(`${fixtureUrl}api/**`, route => route.fulfill({ json: { success: true, data: [], links: [], backlinks: [], files: [] } }));
  await page.route(fixtureUrl, route => route.fulfill({ contentType: 'text/html', body:
    `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div></body></html>` }));
  await page.addInitScript(({ markdown, initialMode }) => {
    window.modePositionFixture = { content: markdown, initialMode };
    const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0, pageLeft: 0 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  }, { markdown: content, initialMode: mode });
  await page.goto(fixtureUrl);
  await page.addScriptTag({ content: bundle });
  await expect(page.locator(mode === 'rich' ? '.ProseMirror' : '.cm-content')).toHaveAttribute('contenteditable', 'true');
}

async function viewport(page: Page, height: number, offsetTop = 0, scale = 1) {
  await page.evaluate(values => {
    Object.assign(window.visualViewport!, values, { width: innerWidth });
    window.visualViewport!.dispatchEvent(new Event('resize'));
    window.visualViewport!.dispatchEvent(new Event('scroll'));
    let keyboard = document.getElementById('emulated-keyboard');
    if (!keyboard) {
      keyboard = document.createElement('div'); keyboard.id = 'emulated-keyboard';
      keyboard.textContent = 'Emulated keyboard area';
      keyboard.style.cssText = 'position:fixed;inset:auto 0 0;background:#cbd5e1;color:#334155;z-index:200;padding:24px;box-sizing:border-box';
      document.body.append(keyboard);
    }
    keyboard.style.height = `${Math.max(0, innerHeight - values.height - values.offsetTop)}px`;
    keyboard.style.display = values.height < innerHeight ? 'block' : 'none';
  }, { height, offsetTop, scale });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function caretTop(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection()!;
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(false);
    let rect = range.getBoundingClientRect();
    if (!rect.height && range.endContainer.nodeType === Node.TEXT_NODE && range.endOffset > 0) {
      range.setStart(range.endContainer, range.endOffset - 1);
      rect = range.getBoundingClientRect();
    }
    return rect.top;
  });
}

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const mode of ['rich', 'source'] as const) test(`${mode}: keyboard clipping, typing, manual scrolling and keyboard dismissal`, async ({ page }, info) => {
    test.setTimeout(90_000);
    info.annotations.push({ type: 'input-scope', description: 'Actual MarkdownEditor/bindings and browser input; VisualViewport keyboard geometry is emulated, not a native OS keyboard.' });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await mount(page, mode);
    const editor = page.locator(mode === 'rich' ? '.ProseMirror' : '.cm-content');
    const scroller = page.locator(mode === 'rich' ? '[data-testid="markdown-scroll-container"]' : '.cm-scroller');
    const target = mode === 'rich' ? editor.locator('p').filter({ hasText: /^Paragraph 20\./ })
      : page.locator('.cm-line').filter({ hasText: /^Paragraph 20\./ });
    if (mode === 'source') {
      await editor.click();
      await page.keyboard.press('ControlOrMeta+f');
      const search = page.locator('.cm-search input[name="search"]');
      await search.fill('Paragraph 20.'); await search.press('ArrowRight'); await search.press('Enter'); await search.press('Escape');
    }
    await target.scrollIntoViewIfNeeded(); await target.tap();
    await viewport(page, 470, 60);
    await expect.poll(() => scroller.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(530);

    // Stage the chosen writing position, then use real tap/type/wheel input.
    await scroller.evaluate((element, y) => {
      const line = [...element.querySelectorAll('p, .cm-line')].find(node => node.textContent?.startsWith('Paragraph 20.'))!;
      element.scrollTop += line.getBoundingClientRect().top - y;
    }, 200);
    await target.tap();
    await page.keyboard.type('Typed');
    await expect(page.getByTestId('local-saved-markdown')).toContainText('Typed');
    // Model a user-chosen scroll offset. Mobile WebKit does not expose a native
    // swipe/wheel API in Playwright; the following typing remains real input.
    await scroller.evaluate(element => element.scrollBy(0, 24));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await scroller.evaluate(element => element.scrollTop);
    await page.keyboard.type(' again');
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeCloseTo(before, 0);
    expect(await target.evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThan(110);

    // Hide the caret just below the safe writing area. Typing must reveal it
    // with a small correction, without taking it to the top of the pane.
    await scroller.evaluate(element => { element.scrollTop -= 240; });
    const hidden = await scroller.evaluate(element => element.scrollTop);
    await page.keyboard.type(' revealed');
    await expect(page.getByTestId('local-saved-markdown')).toContainText('revealed');
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(hidden);
    expect(await caretTop(page)).toBeGreaterThan(200);
    await page.screenshot({ path: info.outputPath(`${mode}-keyboard-visible.png`) });
    const saved = await page.getByTestId('local-saved-markdown').textContent();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => page.getByTestId('local-saved-markdown').textContent()).not.toBe(saved);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.getByTestId('local-saved-markdown')).toHaveText(saved!);

    // Pinch zoom is left to the browser; dismissing the keyboard restores the pane.
    await viewport(page, 470, 60, 1.5);
    await expect(page.locator('.markdown-editor-pane')).toHaveCSS('padding-bottom', '0px');
    await viewport(page, 844);
    await expect(page.locator('.markdown-editor-pane')).toHaveCSS('padding-bottom', '0px');
    await expect(editor).toBeFocused();

    await page.setViewportSize({ width: 844, height: 390 });
    await viewport(page, 270);
    await expect.poll(() => scroller.evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(270);
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' EOF landscape');
    await expect(page.getByTestId('local-saved-markdown')).toContainText('EOF landscape');
    const toolbarTop = await page.locator('.tiptap-mobile-toolbar-visible').evaluate(element => element.getBoundingClientRect().top);
    expect(await caretTop(page)).toBeLessThan(toolbarTop - 8);
    expect(await caretTop(page)).toBeGreaterThan(44);
    expect(errors).toEqual([]);
  });
