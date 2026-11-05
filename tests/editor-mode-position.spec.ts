import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { authenticateManagedTestPage, enterMarkdownEditMode } from './helpers/managed-test-context';
import { deleteOwnedFixtureFiles } from './helpers/owned-fixture-files';
import { analyzeMarkdownRichMode, serializeRichMarkdownBody } from '../app/lib/markdown/rich-markdown-codec';

type Mode = 'Read' | 'Edit' | 'Source';
type Fixture = { path: string; content: string; headers: Record<string, string> };
const richEditor = '.tiptap-editor-shell .ProseMirror';
const repeatedParagraph = 'The same paragraph occurs throughout this document. Its position matters as much as its text.';
const imageUrl = 'https://editor-mode-position.test/fixture.svg';
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#ccddee"/><text x="20" y="85" font-size="24">Mode switch fixture</text></svg>';
test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(45_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function login(page: Page) {
  expect(Boolean(process.env.TEST_LOGIN_EMAIL && process.env.TEST_LOGIN_PASSWORD)).toBe(true);
  await authenticateManagedTestPage(page);
  const response = await page.request.get('/api/workspaces');
  expect(response.ok()).toBe(true);
  const { workspaces } = await response.json();
  const workspace = workspaces.find((entry: { name: string; permissions?: { canWrite: boolean } }) =>
    entry.name === 'Shared Test Workspace' && entry.permissions?.canWrite !== false);
  expect(workspace?.id).toBeTruthy();
  await page.context().addInitScript((id) => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
    localStorage.setItem('canvas.notebookLayout.v2', JSON.stringify({ version: 2, explorerOpen: false,
      explorerWidth: 240, chatDocked: false, chatWidth: 360, terminalOpen: false }));
  }, workspace.id);
  await page.route(imageUrl, route => route.fulfill({ contentType: 'image/svg+xml', body: image }));
  return { 'x-canvas-workspace-id': workspace.id as string };
}

function longMarkdown(path: string) {
  const sections = Array.from({ length: 42 }, (_, index) => {
    const number = String(index).padStart(2, '0');
    return [
      `## Landmark ${number}`,
      repeatedParagraph,
      `Section ${number} has a uniquely identifiable paragraph with **bold text** and a [link](https://example.com). `
        + 'Its lines wrap differently in reading, formatted editing, and source views. '.repeat(4),
      '- First list item\n- Second list item\n  - Nested list item',
      '| Column | Value |\n| :--- | ---: |\n| Measurement | 123 |',
      `\`\`\`typescript\nconst section${number} = ${index};\nconsole.log(section${number});\n\`\`\``,
      'Inline equation $x + y = z$.',
      ...(index % 7 === 0 ? [`<img src="${imageUrl}" alt="Mode position fixture ${number}" width="320" height="160">`] : []),
    ].join('\n\n');
  });
  const body = serializeRichMarkdownBody([
    '# Editor mode position',
    `[Jump to early heading](${path}#Landmark%2003)`,
    ...sections,
  ].join('\n\n'));
  const content = `---\ntitle: Editor mode position\ntags:\n  - regression\n  - editor\n---\n\n${body}`;
  expect(analyzeMarkdownRichMode(content).mode).toBe('rich');
  return content;
}

async function upload(page: Page, headers: Record<string, string>, path: string, content: string): Promise<Fixture> {
  const result = await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: {
    name: path, mimeType: 'text/markdown', buffer: Buffer.from(content),
  } } });
  expect(result.ok(), await result.text()).toBe(true);
  return { path, content, headers };
}

async function focusRoundtrip(page: Page) {
  await page.getByRole('button', { name: 'Focus document', exact: true }).click();
  await page.getByRole('button', { name: 'Exit focus', exact: true }).click();
  await enterMarkdownEditMode(page);
}

function viewport(page: Page, mode: Mode) {
  return page.locator(mode === 'Read' ? '.markdown-read-viewport'
    : mode === 'Edit' ? '[data-testid="markdown-scroll-container"]' : '.markdown-source-shell .cm-scroller');
}

function landmark(page: Page, mode: Mode, number: number) {
  const text = `Landmark ${String(number).padStart(2, '0')}`;
  return mode === 'Source'
    ? page.locator('.markdown-source-shell .cm-line').filter({ hasText: new RegExp(`^## ${text}$`, 'u') })
    : viewport(page, mode).getByRole('heading', { name: text, exact: true });
}

async function settleLayout(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** Complete fixture layout before choosing the initial viewport position. */
async function settleFixtureLayout(page: Page, mode: Mode) {
  await page.evaluate(() => document.fonts.ready);
  if (mode !== 'Source') {
    const view = viewport(page, mode);
    await expect(view.locator(`img[src="${imageUrl}"]`)).toHaveCount(6);
    await expect.poll(() => view.evaluate(element => {
      const viewport = element.getBoundingClientRect();
      return [...element.querySelectorAll<HTMLImageElement>('img')].every(image => {
        const rect = image.getBoundingClientRect();
        const visible = rect.bottom > viewport.top && rect.top < viewport.bottom;
        return !visible || (image.complete && image.naturalHeight > 0);
      });
    })).toBe(true);
  }
  await settleLayout(page);
}

async function offset(view: Locator, anchor: Locator) {
  const [viewBox, anchorBox] = await Promise.all([view.boundingBox(), anchor.boundingBox()]);
  return viewBox && anchorBox ? anchorBox.y - viewBox.y : Number.POSITIVE_INFINITY;
}

/** Setup scroll only; assertions never scroll or refocus the destination editor. */
async function positionLandmark(page: Page, mode: Mode, number: number, top = 12) {
  const anchor = landmark(page, mode, number);
  if (mode === 'Source') {
    // Use the built-in search UI to render a far-away source line before positioning it.
    await page.locator('.markdown-source-shell .cm-content').click();
    await page.keyboard.press('ControlOrMeta+f');
    const search = page.locator('.cm-search input[name="search"]');
    await expect(search).toBeVisible();
    await search.fill(`Landmark ${String(number).padStart(2, '0')}`);
    await search.press('ArrowRight');
    await search.press('Enter');
    await search.press('Escape');
  }
  await anchor.scrollIntoViewIfNeeded();
  await settleFixtureLayout(page, mode);
  const view = viewport(page, mode);
  const difference = await offset(view, anchor) - top;
  await view.evaluate((element, adjustment) => { element.scrollTop += adjustment; }, difference);
  await settleLayout(page);
  await expect.poll(async () => Math.abs(await offset(view, anchor) - top)).toBeLessThanOrEqual(1);
  expect(await view.evaluate(element => element.scrollTop)).toBeGreaterThan(500);
  return offset(view, anchor);
}

async function expectLandmark(page: Page, mode: Mode, number: number, expectedOffset: number) {
  const anchor = landmark(page, mode, number);
  await expect(anchor).toHaveCount(1);
  await expect(anchor).toBeInViewport();
  // One visual line accommodates heading/line metrics; a paragraph jump still fails.
  await expect.poll(async () => Math.abs(await offset(viewport(page, mode), anchor) - expectedOffset), {
    message: `Landmark ${number} should retain its visible offset after switching to ${mode}`,
  }).toBeLessThanOrEqual(36);
  await settleLayout(page);
  expect(Math.abs(await offset(viewport(page, mode), anchor) - expectedOffset)).toBeLessThanOrEqual(36);
}

function wrappedParagraph(page: Page, mode: Mode, number: number) {
  const prefix = new RegExp(`^Section ${String(number).padStart(2, '0')} has a uniquely identifiable paragraph`, 'u');
  return mode === 'Source' ? page.locator('.markdown-source-shell .cm-line').filter({ hasText: prefix })
    : viewport(page, mode).locator('p').filter({ hasText: prefix });
}

async function fragmentOffset(page: Page, mode: Mode, number: number) {
  const paragraph = wrappedParagraph(page, mode, number);
  if (!await paragraph.count()) return Number.POSITIVE_INFINITY;
  const y = await paragraph.evaluate(element => {
    const phrase = 'Its lines wrap differently in reading, formatted editing, and source views.';
    const text = element.textContent ?? '';
    const first = text.indexOf(phrase);
    const second = text.indexOf(phrase, first + phrase.length);
    const target = text.indexOf(phrase, second + phrase.length);
    if (target < 0) throw new Error('Wrapped paragraph fixture is missing its third repeated sentence.');
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let count = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (target < count + length) {
        const range = document.createRange();
        range.setStart(node, target - count); range.setEnd(node, target - count + 1);
        return range.getBoundingClientRect().y;
      }
      count += length;
    }
    throw new Error('Wrapped paragraph has no rendered text range.');
  });
  return y - (await viewport(page, mode).boundingBox())!.y;
}

async function positionWrappedParagraph(page: Page, mode: Mode, number: number) {
  await wrappedParagraph(page, mode, number).scrollIntoViewIfNeeded();
  await settleFixtureLayout(page, mode);
  const difference = await fragmentOffset(page, mode, number) - 12;
  await viewport(page, mode).evaluate((element, adjustment) => { element.scrollTop += adjustment; }, difference);
  await settleLayout(page);
  await expect.poll(async () => Math.abs(await fragmentOffset(page, mode, number) - 12)).toBeLessThanOrEqual(1);
  return fragmentOffset(page, mode, number);
}

async function expectWrappedParagraph(page: Page, mode: Mode, number: number, expectedOffset: number) {
  await expect.poll(async () => Math.abs(await fragmentOffset(page, mode, number) - expectedOffset), {
    message: `The third wrapped sentence in section ${number} should remain at its visible offset in ${mode}`,
  }).toBeLessThanOrEqual(36);
  await settleLayout(page);
  expect(Math.abs(await fragmentOffset(page, mode, number) - expectedOffset)).toBeLessThanOrEqual(36);
}

function observeReloads(page: Page) {
  const requests: string[] = [];
  const sockets: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/files/collaboration/session'
      || url.pathname === '/api/mobile/v1/notebook/document'
      || (url.pathname === '/api/files/read' && url.searchParams.get('meta') !== '1')) requests.push(url.pathname);
  });
  page.on('websocket', socket => { if (socket.url().includes('collaboration')) sockets.push(socket.url()); });
  return { requests, sockets };
}

async function read(page: Page, fixture: Fixture) {
  const response = await page.request.get('/api/files/read', { headers: fixture.headers, params: { path: fixture.path } });
  expect(response.ok()).toBe(true);
  return (await response.json()).data?.content as string;
}

async function cleanup(page: Page, fixtures: Fixture[]) {
  await page.goto('about:blank');
  for (const fixture of fixtures) {
    await deleteOwnedFixtureFiles(page.request, fixture.headers['x-canvas-workspace-id'], [fixture.path]);
  }
}

async function jumpToEarlyHeading(page: Page) {
  await page.locator(richEditor).locator('button[data-canvas-wiki-status], a')
    .filter({ hasText: 'Jump to early heading' }).click({ modifiers: ['ControlOrMeta'] });
  // Native Markdown links navigate directly; embedded wiki links use previews.
  await expect(landmark(page, 'Edit', 3)).toBeInViewport();
  await settleFixtureLayout(page, 'Edit');
}

test.describe('Native document viewport and identity', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(150_000);

  for (const device of ['desktop', 'mobile'] as const) {
    test.describe(device, () => {
      test.use(device === 'mobile'
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
        : { viewport: { width: 1440, height: 1000 } });

      test('focus round trips retain landmarks and the same live native editor', async ({ page }, info) => {
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        const headers = await login(page), path = `editor-position-${randomUUID()}.md`;
        const fixture = await upload(page, headers, path, longMarkdown(path));
        const observed = observeReloads(page);
        try {
          await page.goto(`/notebook?path=${path}`, { waitUntil: 'domcontentloaded' });
          await enterMarkdownEditMode(page);
          await expect(page.getByRole('button', { name: /^(Read|Edit|Source)$/u })).toHaveCount(0);
          const node = await page.locator(richEditor).elementHandle();
          const expectedOffset = await positionLandmark(page, 'Edit', 25);
          const baseline = { requests: observed.requests.length, sockets: observed.sockets.length };
          for (let index = 0; index < 3; index++) {
            await focusRoundtrip(page);
            await expectLandmark(page, 'Edit', 25, expectedOffset);
            expect(await page.locator(richEditor).evaluate((current, before) => current === before, node)).toBe(true);
          }
          const paragraphOffset = await positionWrappedParagraph(page, 'Edit', 31);
          for (let index = 0; index < 3; index++) {
            await focusRoundtrip(page);
            await expectWrappedParagraph(page, 'Edit', 31, paragraphOffset);
          }
          expect(observed.requests.slice(baseline.requests)).toEqual([]);
          expect(observed.sockets.slice(baseline.sockets)).toEqual([]);
          expect(await read(page, fixture)).toBe(fixture.content);
          expect(errors).toEqual([]);
          if (device === 'mobile') expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ path: info.outputPath(`${device}-native-position.png`) });
        } finally { await cleanup(page, [fixture]); }
      });
    });
  }

  test('edits and editor history survive focus changes without replaying a heading jump', async ({ page }, info) => {
    const headers = await login(page), path = `editor-position-history-${randomUUID()}.md`;
    const fixture = await upload(page, headers, path, longMarkdown(path));
    try {
      await page.goto(`/notebook?path=${path}`, { waitUntil: 'domcontentloaded' });
      await enterMarkdownEditMode(page);
      await jumpToEarlyHeading(page);
      const expectedOffset = await positionLandmark(page, 'Edit', 29);
      await focusRoundtrip(page);
      await expectLandmark(page, 'Edit', 29, expectedOffset);
      const paragraph = page.locator(richEditor).locator('p').filter({ hasText: /^Section 29 has a uniquely identifiable paragraph/u });
      await paragraph.click();
      await paragraph.evaluate(element => {
        const selection = getSelection(), range = document.createRange();
        range.selectNodeContents(element); range.collapse(false);
        selection?.removeAllRanges(); selection?.addRange(range);
      });
      await page.keyboard.insertText(' Roundtrip edit marker.');
      await expect.poll(() => read(page, fixture), { timeout: 20_000 }).toContain('Roundtrip edit marker.');
      const afterEditOffset = await positionLandmark(page, 'Edit', 29);
      await focusRoundtrip(page);
      await expectLandmark(page, 'Edit', 29, afterEditOffset);
      await expect(page.locator(richEditor)).toContainText('Roundtrip edit marker.');
      await paragraph.click(); await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => read(page, fixture)).not.toContain('Roundtrip edit marker.');
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect.poll(() => read(page, fixture)).toContain('Roundtrip edit marker.');
      await jumpToEarlyHeading(page);
      await expect(page.getByTestId('markdown-save-state')).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('native-history-and-heading-navigation.png') });
    } finally { await cleanup(page, [fixture]); }
  });

  test('source-only documents keep exact edits and their viewport through focus changes', async ({ page }, info) => {
    const headers = await login(page), path = `editor-position-source-${randomUUID()}.md`;
    const content = `${longMarkdown(path)}\n\n<!-- paginate: true -->\n`;
    expect(analyzeMarkdownRichMode(content).mode).toBe('source');
    const fixture = await upload(page, headers, path, content);
    try {
      await page.goto(`/notebook?path=${path}`, { waitUntil: 'domcontentloaded' });
      const source = page.locator('.markdown-source-shell .cm-content');
      await expect(source).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      const expectedOffset = await positionLandmark(page, 'Source', 33);
      const observed = observeReloads(page);
      await focusRoundtrip(page);
      await expectLandmark(page, 'Source', 33, expectedOffset);
      await landmark(page, 'Source', 33).click(); await page.keyboard.press('End');
      await page.keyboard.insertText(' Source edit marker');
      await expect.poll(() => read(page, fixture), { timeout: 20_000 }).toContain('Landmark 33 Source edit marker');
      const edited = page.locator('.cm-line').filter({ hasText: /^## Landmark 33 Source edit marker$/u });
      await focusRoundtrip(page);
      await expect(edited).toBeInViewport();
      await edited.click(); await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(() => read(page, fixture), { timeout: 20_000 }).toBe(content);
      expect(observed.requests).toEqual([]); expect(observed.sockets).toEqual([]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(source).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
      expect(await read(page, fixture)).toBe(content);
      await page.screenshot({ path: info.outputPath('source-only-native-position.png') });
    } finally { await cleanup(page, [fixture]); }
  });

  test('viewport positions are scoped to the document when switching actual tabs', async ({ page }) => {
    const headers = await login(page), path = `editor-position-isolation-${randomUUID()}.md`;
    const fixture = await upload(page, headers, path, longMarkdown(path));
    const shortPath = `editor-position-short-${randomUUID()}.md`;
    const short = await upload(page, headers, shortPath, '# A separate short document\n\nVisible at the beginning.\n');
    try {
      await page.goto(`/notebook?path=${path}`, { waitUntil: 'domcontentloaded' });
      await enterMarkdownEditMode(page);
      await positionLandmark(page, 'Edit', 37);
      await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
      await page.getByRole('treeitem', { name: shortPath.replace(/\.md$/u, ''), exact: true }).click();
      await enterMarkdownEditMode(page);
      await expect(page.getByRole('heading', { name: 'A separate short document', exact: true })).toBeInViewport();
      expect(await viewport(page, 'Edit').evaluate(element => element.scrollTop)).toBe(0);
      await page.getByRole('tab', { name: path, exact: true }).click();
      await enterMarkdownEditMode(page); await positionLandmark(page, 'Edit', 37);
      await page.getByRole('tab', { name: shortPath, exact: true }).click();
      await enterMarkdownEditMode(page);
      await expect(page.locator(richEditor).getByText('Visible at the beginning.', { exact: true })).toBeInViewport();
      expect(await viewport(page, 'Edit').evaluate(element => element.scrollTop)).toBe(0);
    } finally { await cleanup(page, [fixture, short]); }
  });
});
