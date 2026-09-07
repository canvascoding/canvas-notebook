import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const EXTERNAL_LINK = 'https://example.com/pdf-viewer-link';

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

  await page.addInitScript((id) => localStorage.setItem('canvas.activeWorkspaceId', id), workspaceId);
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
