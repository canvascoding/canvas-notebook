import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const EXTERNAL_LINK = 'https://example.com/pdf-viewer-link';

test.beforeEach(async ({ page }) => {
  // Keep local viewer checks independent of the external telemetry transport.
  // Application page errors remain observed normally by each test.
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url, location.href);
      if (url.hostname.endsWith('.ingest.de.sentry.io') && url.pathname.endsWith('/envelope/')) {
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return fetch(input, init);
    };
  });
});

type PdfLifecycleWindow = Window & {
  pdfLifecycleIdentity?: string;
  activePdfSelectionListeners?: () => number;
};

async function expectLayersAligned(page: Page, pageNumber: number) {
  await expect.poll(async () => page.locator(`[data-pdf-page="${pageNumber}"]`).evaluate((element) => {
    const canvas = element.querySelector('canvas');
    const layers = element.querySelector('[aria-hidden]');
    const textLayer = element.querySelector('.textLayer');
    const annotationLayer = element.querySelector('.annotationLayer');
    if (!canvas || !layers || !textLayer || !annotationLayer) return false;

    const canvasRect = canvas.getBoundingClientRect();
    const layersRect = layers.getBoundingClientRect();
    return textLayer.childElementCount > 0
      && annotationLayer.childElementCount > 0
      && Math.abs(canvasRect.width - layersRect.width) <= 1
      && Math.abs(canvasRect.height - layersRect.height) <= 1;
  })).toBe(true);
}

async function expectExternalLinkAligned(page: Page, pageNumber: number) {
  await expect.poll(async () => page.locator(`[data-pdf-page="${pageNumber}"]`).evaluate((element, href) => {
    const text = [...element.querySelectorAll('.textLayer span')]
      .find((span) => span.textContent?.includes('External link fixture'));
    const link = [...element.querySelectorAll<HTMLAnchorElement>('.annotationLayer a')]
      .find((anchor) => anchor.href === href);
    if (!text || !link) return false;

    const textRect = text.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    const intersectionWidth = Math.max(0, Math.min(textRect.right, linkRect.right) - Math.max(textRect.left, linkRect.left));
    const intersectionHeight = Math.max(0, Math.min(textRect.bottom, linkRect.bottom) - Math.max(textRect.top, linkRect.top));
    return intersectionWidth * intersectionHeight > 0;
  }, EXTERNAL_LINK)).toBe(true);
}

test('closing a multi-page PDF leaves Markdown selection usable in the same notebook page', async ({ page }, info) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    // PDF.js owns abortable document selection listeners. Observe registration
    // lifetimes without altering the callbacks or suppressing browser errors.
    const listeners: Array<{ listener: EventListenerOrEventListenerObject; signal: AbortSignal; removed: boolean }> = [];
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (this === document && type === 'selectionchange' && listener
        && typeof options === 'object' && options.signal) {
        listeners.push({ listener, signal: options.signal, removed: false });
      }
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function(type, listener, options) {
      if (this === document && type === 'selectionchange') {
        for (const entry of listeners) if (entry.listener === listener) entry.removed = true;
      }
      return remove.call(this, type, listener, options);
    };
    (window as PdfLifecycleWindow).activePdfSelectionListeners = () => listeners.filter((entry) => !entry.removed && !entry.signal.aborted).length;
  });
  const login = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL,
      password: process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD },
  });
  expect(login.ok()).toBe(true);
  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: { name: string; permissions: { canWrite: boolean } }) =>
    entry.name === 'Shared Test Workspace' && entry.permissions.canWrite);
  expect(workspace).toBeTruthy();
  const headers = { 'x-canvas-workspace-id': workspace.id as string };
  const suffix = randomUUID();
  const pdfName = `pdf-lifecycle-${suffix}.pdf`;
  const markdownName = `pdf-lifecycle-${suffix}.md`;
  const fixture = await readFile(path.join(process.cwd(), 'tests/fixtures/pdf-viewer-layers.pdf'));
  await page.addInitScript((id) => {
    if (window !== window.top || !location.protocol.startsWith('http')) return;
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace.id);
  for (const file of [{ name: pdfName, mimeType: 'application/pdf', buffer: fixture },
    { name: markdownName, mimeType: 'text/markdown', buffer: Buffer.from(`Markdown remains selectable.\n\n[Open lifecycle PDF](${pdfName})`) }]) {
    expect((await page.request.post('/api/files/upload', { headers, multipart: { path: '.', files: file } })).ok()).toBe(true);
  }
  try {
    await page.goto(`/notebook?path=${encodeURIComponent(markdownName)}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /^(Read|Lesen)$/u }).click();
    await expect(page.getByRole('link', { name: 'Open lifecycle PDF', exact: true })).toBeVisible();
    await page.evaluate((identity) => { (window as PdfLifecycleWindow).pdfLifecycleIdentity = identity; }, suffix);
    const baselineListeners = await page.evaluate(() => (window as PdfLifecycleWindow).activePdfSelectionListeners!());
    for (let iteration = 0; iteration < 3; iteration++) {
      const mobileExplorer = page.getByRole('button', { name: 'Open file explorer', exact: true });
      if (await mobileExplorer.isVisible()) {
        await mobileExplorer.tap();
        await page.getByRole('option').filter({ hasText: pdfName }).tap({ timeout: 15_000 });
      } else {
        await page.getByRole('treeitem', { name: pdfName, exact: true }).click({ timeout: 15_000 });
      }
      await expect(page.locator('[data-pdf-page="1"]')).toBeVisible({ timeout: 30_000 });
      if (iteration === 0) {
        await expect(page.locator('[data-pdf-page="1"] .textLayer')).toContainText('Alpha Bravo Charlie');
        const selectedPdfText = await page.locator('[data-pdf-page="1"] .textLayer').evaluate((element) => {
          const range = document.createRange(); range.selectNodeContents(element);
          const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
          document.dispatchEvent(new Event('selectionchange'));
          return selection?.toString();
        });
        expect(selectedPdfText).toContain('Alpha Bravo Charlie');
        await expect.poll(() => page.evaluate(() => (window as PdfLifecycleWindow).activePdfSelectionListeners!())).toBeGreaterThan(baselineListeners);
        await page.locator('[data-pdf-page="2"]').scrollIntoViewIfNeeded();
        await expect(page.locator('[data-pdf-page="2"] .textLayer')).toContainText('Internal destination reached');
      }
      await page.getByRole('button', { name: /Zoom in|Vergrößern/ }).click();
      // Later passes close immediately after a render-invalidating zoom.
      await page.getByRole('tab', { name: pdfName, exact: true }).locator('..')
        .getByRole('button', { name: /Close|Schließen/i }).click();
      await expect(page.locator('[data-pdf-page]')).toHaveCount(0);
      await expect(page.getByRole('tab', { name: markdownName, exact: true })).toHaveAttribute('aria-selected', 'true');
      expect(await page.evaluate(() => (window as PdfLifecycleWindow).pdfLifecycleIdentity)).toBe(suffix);
      await page.getByRole('button', { name: /^(Edit|Bearbeiten)$/u }).click();
      const editor = page.locator('.tiptap-editor-shell .ProseMirror');
      await expect(editor).toHaveAttribute('contenteditable', 'true');
      const selected = await editor.locator('p').first().evaluate((element) => {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        return selection?.toString();
      });
      expect(selected).toBe('Markdown remains selectable.');
      await expect.poll(() => page.evaluate(() => (window as PdfLifecycleWindow).activePdfSelectionListeners!())).toBe(baselineListeners);
      await page.getByRole('button', { name: /^(Read|Lesen)$/u }).click();
    }
    await page.screenshot({ path: info.outputPath('pdf-closed-markdown-usable.png') });
    expect(pageErrors).toEqual([]);
  } finally {
    await page.goto('about:blank').catch(() => undefined);
    await page.request.delete('/api/files/delete', { headers, data: { path: [pdfName, markdownName] } });
  }
});

test('PDF text and links remain interactive in private and public previews', async ({ page }) => {
  test.skip(process.env.COLLABORATION_E2E !== '1', 'Requires the managed local Postgres stack.');
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  expect((await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BETTER_AUTH_BASE_URL || process.env.BASE_URL || 'http://localhost:3000' },
    data: {
      email: process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL,
      password: process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD,
    },
  })).ok()).toBe(true);

  const { workspaces } = await (await page.request.get('/api/workspaces')).json();
  const workspace = workspaces.find((entry: {
    permissions: { canCreatePublicLinks: boolean; canWrite: boolean };
  }) => entry.permissions.canWrite && entry.permissions.canCreatePublicLinks);
  expect(workspace).toBeTruthy();

  const workspaceId = workspace.id as string;
  const headers = { 'x-canvas-workspace-id': workspaceId };
  const fileName = `pdf-viewer-layers-${randomUUID()}.pdf`;
  const fixture = await readFile(path.join(process.cwd(), 'tests/fixtures/pdf-viewer-layers.pdf'));
  let shareId: string | null = null;

  await page.addInitScript((id) => {
    if (window !== window.top || !location.protocol.startsWith('http')) return;
    localStorage.setItem('canvas.activeWorkspaceId', id);
  }, workspaceId);
  expect((await page.request.post('/api/files/upload', {
    headers,
    multipart: {
      path: '.',
      files: { name: fileName, mimeType: 'application/pdf', buffer: fixture },
    },
  })).ok()).toBe(true);

  try {
    await page.goto(`/notebook?path=${encodeURIComponent(fileName)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const firstPage = page.locator('[data-pdf-page="1"]');
    const textLayer = firstPage.locator('.textLayer');
    await expect(textLayer).toContainText('Selectable fixture text: Alpha Bravo Charlie.', { timeout: 45_000 });
    await expectLayersAligned(page, 1);
    await expectExternalLinkAligned(page, 1);

    const selectedText = await textLayer.evaluate((element) => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return selection?.toString() ?? '';
    });
    expect(selectedText).toContain('Alpha Bravo Charlie');

    const externalLink = firstPage.locator(`.annotationLayer .linkAnnotation a[href="${EXTERNAL_LINK}"]`);
    await expect(externalLink).toHaveAttribute('target', '_blank');
    await expect(externalLink).toHaveAttribute('rel', 'noopener noreferrer');
    await externalLink.evaluate((element) => {
      element.addEventListener('click', (event) => {
        event.preventDefault();
        document.body.dataset.pdfExternalLinkClicked = 'true';
      }, { once: true });
    });
    await externalLink.click();
    await expect(page.locator('body')).toHaveAttribute('data-pdf-external-link-clicked', 'true');

    const canvasWidth = await firstPage.locator('canvas').evaluate((element) => element.getBoundingClientRect().width);
    await page.getByRole('button', { name: /Zoom in|Vergrößern/ }).click();
    await expect.poll(async () => firstPage.locator('canvas').evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(canvasWidth);
    await expectLayersAligned(page, 1);

    const sizeBeforeRotation = await firstPage.locator('canvas').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height) };
    });
    expect(sizeBeforeRotation.height).toBeGreaterThan(sizeBeforeRotation.width);
    await page.getByRole('button', { name: /Rotate|Drehen/ }).click();
    await expect.poll(async () => firstPage.locator('canvas').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > rect.height;
    })).toBe(true);
    await expectLayersAligned(page, 1);
    await expectExternalLinkAligned(page, 1);

    await page.getByRole('button', { name: /Rotate|Drehen/ }).click();
    await page.getByRole('button', { name: /Rotate|Drehen/ }).click();
    await page.getByRole('button', { name: /Rotate|Drehen/ }).click();
    const internalLink = firstPage.locator('.annotationLayer .linkAnnotation a[href^="#"]');
    await internalLink.click();
    await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
    await expect(page.locator('[data-pdf-page="2"] .textLayer')).toContainText('Internal destination reached');

    const shareResponse = await page.request.post('/api/security/public-shares', {
      headers,
      data: { path: fileName, securityMode: 'strict' },
    });
    expect(shareResponse.ok()).toBe(true);
    const shareResult = await shareResponse.json();
    shareId = shareResult.shares[0].id as string;

    await page.goto(shareResult.shares[0].publicUrl as string, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const publicFirstPage = page.locator('[data-pdf-page="1"]');
    await expect(publicFirstPage.locator('.textLayer')).toContainText('Alpha Bravo Charlie', { timeout: 45_000 });
    await expect(publicFirstPage.locator(`.annotationLayer a[href="${EXTERNAL_LINK}"]`)).toHaveAttribute('target', '_blank');
    await expectLayersAligned(page, 1);
    await expectExternalLinkAligned(page, 1);
    expect(pageErrors).toEqual([]);
  } finally {
    if (shareId) {
      await page.request.delete(`/api/security/public-shares/${shareId}`, { headers });
    }
    await page.request.delete('/api/files/delete', { headers, data: { path: fileName } });
  }
});
