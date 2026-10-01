import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { analyzeMarkdownRichMode, serializeRichMarkdownBody } from '../app/lib/markdown/rich-markdown-codec';

const fixtureUrl = 'http://editor-local-mode.test/';
const imageUrl = 'https://editor-mode-position.test/delayed.svg';
type Mode = 'Read' | 'Edit' | 'Source';
let bundle: string;
let css: string;
const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(10_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
});

test.afterEach(async ({ page }, info) => {
  const errors = browserErrors.get(page) ?? [];
  await info.attach('browser-errors', { body: JSON.stringify(errors), contentType: 'application/json' });
  if (info.status !== info.expectedStatus) {
    console.log('Local MarkdownEditor browser errors:', JSON.stringify(errors));
    console.log('Local MarkdownEditor viewport:', JSON.stringify(await page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller') as HTMLElement | null;
      const content = document.querySelector('.cm-content') as HTMLElement | null;
      return { scrollTop: scroller?.scrollTop, scrollHeight: scroller?.scrollHeight,
        viewportHeight: scroller?.clientHeight, classes: content?.className,
        gutterCount: document.querySelectorAll('.cm-gutters').length,
        firstLines: [...document.querySelectorAll('.cm-line')].slice(0, 8).map(line => line.textContent) };
    })));
    await page.screenshot({ path: info.outputPath('local-mode-failure.png') });
  }
  expect(errors).toEqual([]);
});

test.beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/markdown-mode-position-browser.tsx'],
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' } });
  bundle = result.outputFiles[0].text;
  const from = path.resolve('app/globals.css');
  css = (await postcss([tailwindcss()]).process(await readFile(from, 'utf8'), { from })).css;
});

function documentContent(delayedImage = false) {
  const sections = Array.from({ length: 30 }, (_, number) => [
    `## Local landmark ${number}`,
    'This repeated paragraph is deliberately identical in every section.',
    `Paragraph ${number} wraps across several lines. `
      + 'Changing the view should keep the visible text at the same place. '.repeat(5),
    '- First item\n- Second item',
    '| Item | Value |\n| --- | --- |\n| A | B |',
    `\`\`\`text\nCode ${number}\nAnother line\n\`\`\``,
    ...(delayedImage && number === 18 ? [`![Delayed mode image](${imageUrl})`] : []),
  ].join('\n\n'));
  const content = `---\ntitle: Local position test\n---\n\n${serializeRichMarkdownBody(['# Local position test', ...sections].join('\n\n'))}`;
  expect(analyzeMarkdownRichMode(content).mode).toBe('rich');
  return content;
}

async function mount(page: Page, content: string, initialMode: 'read' | 'source' = 'read') {
  await page.route(`${fixtureUrl}api/**`, route => route.fulfill({ json: {
    success: true, data: [], links: [], backlinks: [], files: [],
  } }));
  await page.route(fixtureUrl, route => route.fulfill({ contentType: 'text/html', body:
    `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0"><div id="root"></div></body></html>` }));
  await page.addInitScript(fixture => { window.modePositionFixture = fixture; }, { content, initialMode });
  await page.goto(fixtureUrl);
  await page.addScriptTag({ content: bundle });
}

function view(page: Page, mode: Mode) {
  return page.locator(mode === 'Read' ? '.markdown-read-viewport'
    : mode === 'Edit' ? '[data-testid="markdown-scroll-container"]' : '.markdown-source-shell .cm-scroller');
}

function anchor(page: Page, mode: Mode, number: number, suffix = '') {
  const text = `Local landmark ${number}${suffix}`;
  return mode === 'Source' ? page.locator('.cm-line').filter({ hasText: new RegExp(`^## ${text}$`, 'u') })
    : view(page, mode).getByRole('heading', { name: text, exact: true });
}

async function position(page: Page, mode: Mode, number: number, suffix = '') {
  if (mode === 'Source') {
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+f');
    const search = page.locator('.cm-search input[name="search"]');
    await search.fill(`Local landmark ${number}${suffix}`);
    // CodeMirror commits its query on keyup/change rather than the input event emitted by fill.
    await search.press('ArrowRight'); await search.press('Enter'); await search.press('Escape');
  }
  await anchor(page, mode, number, suffix).scrollIntoViewIfNeeded();
  const difference = await locationOffset(page, mode, number, suffix) - 12;
  await view(page, mode).evaluate((element, adjustment) => { element.scrollTop += adjustment; }, difference);
  await expect.poll(async () => Math.abs(await locationOffset(page, mode, number, suffix) - 12)).toBeLessThanOrEqual(1);
  return locationOffset(page, mode, number, suffix);
}

async function locationOffset(page: Page, mode: Mode, number: number, suffix = '') {
  const [viewBox, anchorBox] = await Promise.all([view(page, mode).boundingBox(), anchor(page, mode, number, suffix).boundingBox()]);
  return viewBox && anchorBox ? anchorBox.y - viewBox.y : Number.POSITIVE_INFINITY;
}

async function switchMode(page: Page, mode: Mode) {
  const button = page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: mode, exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(view(page, mode)).toBeVisible();
  if (mode !== 'Read') await expect(page.locator(mode === 'Edit' ? '.ProseMirror' : '.cm-content')).toHaveAttribute('contenteditable', 'true');
}

async function expectPosition(page: Page, mode: Mode, number: number, expectedOffset: number, suffix = '') {
  await expect(anchor(page, mode, number, suffix)).toBeInViewport();
  await expect.poll(async () => Math.abs(await locationOffset(page, mode, number, suffix) - expectedOffset)).toBeLessThanOrEqual(36);
}

test.describe('Local MarkdownEditor uses the real rich and source editor bindings', () => {
  test.setTimeout(90_000);

  test('writable source changes, rich changes and undo survive all mode directions', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await mount(page, documentContent());
    const expectedOffset = await position(page, 'Read', 21);
    for (const mode of ['Edit', 'Source', 'Read', 'Source', 'Edit', 'Read'] as const) {
      await switchMode(page, mode); await expectPosition(page, mode, 21, expectedOffset);
    }
    await switchMode(page, 'Source');
    await expectPosition(page, 'Source', 21, expectedOffset);
    await anchor(page, 'Source', 21).click();
    await page.keyboard.press('End'); await page.keyboard.insertText(' source change');
    await expect(page.getByTestId('local-saved-markdown')).toContainText('## Local landmark 21 source change');
    await switchMode(page, 'Read');
    await expectPosition(page, 'Read', 21, expectedOffset, ' source change');
    await switchMode(page, 'Edit');
    await expectPosition(page, 'Edit', 21, expectedOffset, ' source change');
    await anchor(page, 'Edit', 21, ' source change').click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByTestId('local-saved-markdown')).not.toContainText('source change');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.getByTestId('local-saved-markdown')).toContainText('source change');
    await anchor(page, 'Edit', 21, ' source change').click();
    await page.keyboard.press('End'); await page.keyboard.insertText(' rich change');
    await expect(page.getByTestId('local-saved-markdown')).toContainText('source change rich change');
    const afterRichEditOffset = await position(page, 'Edit', 21, ' source change rich change');
    await switchMode(page, 'Source');
    await expectPosition(page, 'Source', 21, afterRichEditOffset, ' source change rich change');
    await anchor(page, 'Source', 21, ' source change rich change').click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByTestId('local-saved-markdown')).toContainText('source change');
    await expect(page.getByTestId('local-saved-markdown')).not.toContainText('rich change');
    const afterUndoOffset = await position(page, 'Source', 21, ' source change');
    await switchMode(page, 'Read');
    await expectPosition(page, 'Read', 21, afterUndoOffset, ' source change');
    await page.screenshot({ path: info.outputPath('local-source-and-rich-roundtrip.png') });
    expect(errors).toEqual([]);
  });

  test('normalization keeps the source location when Edit prepares formatted text', async ({ page }) => {
    const content = documentContent().replace('- First item\n- Second item', '1. First item\n1. Second item');
    expect(analyzeMarkdownRichMode(content).mode).toBe('normalizable');
    await mount(page, content, 'source');
    const expectedOffset = await position(page, 'Source', 21);
    await switchMode(page, 'Edit');
    await expectPosition(page, 'Edit', 21, expectedOffset);
    await expect(page.getByTestId('local-saved-markdown')).toContainText('2. Second item');
    await switchMode(page, 'Read');
    await expectPosition(page, 'Read', 21, expectedOffset);
    await switchMode(page, 'Source');
    await expectPosition(page, 'Source', 21, expectedOffset);
  });

  test('unavailable formatted editing does not retain a stale source scroll handoff', async ({ page }) => {
    const content = `${documentContent()}\n\n<!-- paginate: true -->\n`;
    expect(analyzeMarkdownRichMode(content).mode).toBe('source');
    await mount(page, content);
    const initialOffset = await position(page, 'Read', 21);
    await switchMode(page, 'Source');
    await expectPosition(page, 'Source', 21, initialOffset);
    await page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Document view' }).getByRole('button', { name: 'Source', exact: true }))
      .toHaveAttribute('aria-pressed', 'true');
    await expectPosition(page, 'Source', 21, initialOffset);
    const newerOffset = await position(page, 'Source', 24);
    await switchMode(page, 'Read');
    await expectPosition(page, 'Read', 24, newerOffset);
    await expect(page.getByTestId('local-saved-markdown')).toHaveText(content);
  });

  test('the document beginning and frontmatter stay at the top in every mode', async ({ page }) => {
    await mount(page, documentContent());
    await expect(view(page, 'Read')).toBeVisible();
    expect(await view(page, 'Read').evaluate(element => element.scrollTop)).toBe(0);
    for (const mode of ['Source', 'Edit', 'Read', 'Edit', 'Source', 'Read'] as const) {
      await switchMode(page, mode);
      expect(await view(page, mode).evaluate(element => element.scrollTop)).toBe(0);
      if (mode === 'Source') await expect(page.locator('.cm-line').filter({ hasText: /^title: Local position test$/u })).toBeInViewport();
      else await expect(view(page, mode).getByRole('heading', { name: 'Local position test', exact: true })).toBeInViewport();
    }
  });

  for (const userScrolls of [false, true]) {
    test(`a delayed image ${userScrolls ? 'respects a newer user scroll' : 'keeps the restored text stable'}`, async ({ page }) => {
      let release!: () => void;
      const imageReady = new Promise<void>(resolve => { release = resolve; });
      let requested = false;
      await page.route(imageUrl, async route => {
        requested = true;
        await imageReady;
        await route.fulfill({ contentType: 'image/svg+xml', body:
          '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="480"><rect width="600" height="480" fill="#aaccee"/></svg>' });
      });
      try {
        await mount(page, documentContent(true), 'source');
        const expectedOffset = await position(page, 'Source', 19);
        await switchMode(page, 'Read');
        await expectPosition(page, 'Read', 19, expectedOffset);
        await expect.poll(() => requested).toBe(true);
        let afterUserScrollOffset = expectedOffset;
        if (userScrolls) {
          const box = (await view(page, 'Read').boundingBox())!;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.wheel(0, 180);
          await expect.poll(async () => Math.abs(await locationOffset(page, 'Read', 19) - expectedOffset)).toBeGreaterThan(100);
          afterUserScrollOffset = await locationOffset(page, 'Read', 19);
        }
        release();
        await expect(page.getByRole('img', { name: 'Delayed mode image' })).toHaveCount(1);
        await expect.poll(() => page.getByRole('img', { name: 'Delayed mode image' }).evaluate(image =>
          (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalHeight > 0)).toBe(true);
        await expect.poll(async () => Math.abs(await locationOffset(page, 'Read', 19) - afterUserScrollOffset)).toBeLessThanOrEqual(36);
        // Observe after the image's own layout and the controller's pending animation frames.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(Math.abs(await locationOffset(page, 'Read', 19) - afterUserScrollOffset)).toBeLessThanOrEqual(36);
      } finally { release(); }
    });
  }
});
