import { expect, test, type Locator, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import { installEmailAttachmentPreviewFixture } from './helpers/email-attachment-preview-fixture';
import { OFFICE_ROUNDTRIP_TEXT } from '../scripts/fixtures/office-docx-roundtrip';
import en from '../messages/en.json';

async function openReview(page: Page) {
  await page.goto('/?outboxDraft=attachment-draft', { waitUntil: 'domcontentloaded' });
  const review = page.getByTestId('email-review-host');
  await expect(review).toBeVisible();
  await review.getByText('Attachments (14)', { exact: true }).click();
  return review;
}
async function assertPopupFits(page: Page, popup: Locator) {
  const box = await popup.boundingBox(); const viewport = page.viewportSize()!;
  expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1); expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  await expect(popup.getByLabel(en.emailAttachmentPreview.close, { exact: true })).toBeVisible();
  await expect(popup.getByLabel(en.emailAttachmentPreview.download, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test.describe('Email attachment previews', () => {
  test.setTimeout(150_000);
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    test(`agent review opens all supported formats without changing the draft at ${viewport.width}px`, async ({ browser }, info) => {
      const context = await createAuthenticatedContext(browser, { viewport });
      const fixture = await installEmailAttachmentPreviewFixture(context);
      const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      try {
        const review = await openReview(page);
        await review.getByTestId('email-review-subject').fill('Keep this actual edit');
        const trigger = review.getByTestId('email-attachment-preview-trigger').filter({ hasText: 'notes.txt' });
        await trigger.click();
        const popup = page.getByTestId('email-attachment-preview');
        await expect(popup.locator('pre')).toHaveText('Frozen agent attachment contents');
        const downloadPromise = page.waitForEvent('download'); await popup.getByLabel(en.emailAttachmentPreview.download, { exact: true }).click();
        const download = await downloadPromise; expect(download.suggestedFilename()).toBe('notes.txt');
        expect(await fs.readFile((await download.path())!, 'utf8')).toBe('Frozen agent attachment contents');
        await assertPopupFits(page, popup);
        await page.screenshot({ path: info.outputPath(`preview-text-${viewport.width}-light.png`), animations: 'disabled' });
        for (const id of ['pdf', 'image', 'markdown', 'html', 'svg', 'zip', 'empty', 'json', 'docx', 'xlsx']) {
          await popup.getByTestId('email-attachment-preview-next').click();
          await expect(popup.getByRole('heading', { name: fixture.files.get(id)!.name, exact: true })).toBeVisible();
          await expect(popup.getByText(en.emailAttachmentPreview.loading, { exact: true })).toBeHidden();
          if (id === 'pdf') {
            await expect(popup.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
            await page.screenshot({ path: info.outputPath(`preview-pdf-${viewport.width}-light.png`), animations: 'disabled' });
          } else if (id === 'image') {
            const image = popup.getByRole('img', { name: 'image.png' }); await expect(image).toBeVisible();
            await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
          } else if (id === 'markdown') {
            await expect(popup.getByRole('heading', { name: 'Attachment heading' })).toBeVisible();
            await expect(popup.locator('img')).toHaveCount(0);
          } else if (id === 'html' || id === 'svg') {
            await expect(popup.locator('pre')).toContainText('<script>');
            await expect(popup.locator('iframe, script')).toHaveCount(0);
            expect(await page.evaluate(() => (window as unknown as { previewExecuted?: boolean }).previewExecuted)).toBeUndefined();
          } else if (id === 'zip') await expect(popup).toContainText(en.emailAttachmentPreview.unsupported);
          else if (id === 'empty') await expect(popup.locator('pre')).toHaveText(en.emailAttachmentPreview.empty);
          else if (id === 'json') await expect(popup.locator('pre')).toHaveText('{"preview":true}');
          else if (id === 'docx') {
            await expect(popup).toContainText(OFFICE_ROUNDTRIP_TEXT, { timeout: 30_000 });
            await expect(popup.locator('[contenteditable="true"]')).toHaveCount(0);
          } else if (id === 'xlsx') {
            await expect(popup).toContainText('Preview fixture', { timeout: 30_000 });
          }
          await assertPopupFits(page, popup);
        }
        const lightBackground = await popup.evaluate(element => getComputedStyle(element).backgroundColor);
        await page.evaluate(() => {
          localStorage.setItem('theme', 'dark');
          window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'dark' }));
        });
        await expect.poll(() => popup.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(lightBackground);
        await page.screenshot({ path: info.outputPath(`preview-office-${viewport.width}-dark.png`), animations: 'disabled' });
        await page.keyboard.press('Escape'); await expect(popup).toBeHidden();
        await expect(review).toBeVisible(); await expect(trigger).toBeFocused();
        await expect(review.getByTestId('email-review-subject')).toHaveValue('Keep this actual edit');
        await expect(review.getByTestId('email-review-save')).toBeEnabled();
        expect(fixture.entry.version).toBe(1); expect(fixture.writes).toEqual([]); expect(fixture.external).toEqual([]); expect(errors).toEqual([]);
        await page.keyboard.press('Escape'); await expect(page.getByTestId('email-review-unsaved-dialog')).toBeVisible();
      } finally { await context.close(); }
    });
  }

  for (const shared of [false, true]) {
    test(`received ${shared ? 'workspace' : 'personal'} mail keeps its source on preview and download`, async ({ browser }) => {
      const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 960 } });
      const fixture = await installEmailAttachmentPreviewFixture(context, { shared }); const page = await context.newPage();
      try {
        await page.goto('/emails', { waitUntil: 'domcontentloaded' });
        await page.getByLabel(en.emailFocus.scopeLabel).selectOption(`mailbox:${fixture.origin.mailboxRef}`);
        await page.getByText('Preview incoming message', { exact: true }).first().click();
        await expect(page.frameLocator('iframe').getByText('Received email with attachments')).toBeVisible();
        await page.getByTestId('email-attachment-preview-trigger').filter({ hasText: 'notes.txt' }).click();
        const popup = page.getByTestId('email-attachment-preview'); await expect(popup.locator('pre')).toHaveText('Frozen agent attachment contents');
        const read = fixture.reads.find(path => path.includes('/attachments/notes'))!; expect(read).toContain('folder=INBOX');
        expect(read.includes('mailboxWorkspaceId=preview-workspace')).toBe(shared);
        await popup.getByLabel(en.emailAttachmentPreview.close, { exact: true }).click(); await expect(popup).toBeHidden();
        expect(fixture.writes).toEqual([]);
      } finally { await context.close(); }
    });
  }

  test('manual compose uploads open in a preview and keep the message intact', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser); const fixture = await installEmailAttachmentPreviewFixture(context); const page = await context.newPage();
    try {
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: en.emailFocus.compose, exact: true }).click();
      await page.getByRole('button', { name: en.emailFocus.composeWithSender, exact: true }).click();
      const compose = page.getByRole('dialog').filter({ has: page.locator('#email-compose-subject') });
      await compose.locator('#email-compose-subject').fill('Manual message remains intact');
      await compose.getByRole('button', { name: 'Attach files', exact: true }).click();
      const picker = page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: 'Upload', exact: true }) });
      await picker.getByRole('tab', { name: 'Upload', exact: true }).click();
      await picker.locator('input[type="file"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Frozen agent attachment contents') });
      await expect(picker.getByRole('button', { name: 'Attach selected', exact: true })).toBeEnabled();
      await picker.getByRole('button', { name: 'Attach selected', exact: true }).click();
      await compose.getByTestId('email-attachment-preview-trigger').click();
      const popup = page.getByTestId('email-attachment-preview'); await expect(popup.locator('pre')).toHaveText('Frozen agent attachment contents');
      await page.keyboard.press('Escape'); await expect(popup).toBeHidden();
      await expect(compose.locator('#email-compose-subject')).toHaveValue('Manual message remains intact');
      expect(fixture.writes).toEqual(['/api/email/attachments/upload']);
    } finally { await context.close(); }
  });

  test('missing, forbidden, oversized and changed attachments have useful states', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser); const fixture = await installEmailAttachmentPreviewFixture(context); const page = await context.newPage();
    try {
      const review = await openReview(page); const popup = page.getByTestId('email-attachment-preview');
      for (const [id, code] of [['missing', 'unavailable'], ['forbidden', 'forbidden'], ['large', 'large']] as const) {
        await review.getByTestId('email-attachment-preview-trigger').filter({ hasText: fixture.files.get(id)!.name }).click();
        await expect(popup.getByRole('alert')).toHaveText(en.emailAttachmentPreview.errors[code]);
        await popup.getByLabel(en.emailAttachmentPreview.close, { exact: true }).click();
      }
      expect(fixture.reads.some(path => path.includes('preview-large'))).toBe(false);
      fixture.corruptImage = true;
      await review.getByTestId('email-attachment-preview-trigger').filter({ hasText: 'image.png' }).click();
      await expect(popup.getByRole('alert')).toHaveText(en.emailAttachmentPreview.errors.failed);
      await popup.getByLabel(en.emailAttachmentPreview.close, { exact: true }).click();
      fixture.changed = true;
      await review.getByTestId('email-attachment-preview-trigger').filter({ hasText: 'notes.txt' }).click();
      await expect(popup.getByRole('alert')).toHaveText(en.emailAttachmentPreview.errors.changed);
      await expect(popup.getByLabel(en.emailAttachmentPreview.download, { exact: true })).toBeDisabled();
      expect(fixture.writes).toEqual([]);
    } finally { await context.close(); }
  });

  test('workspace compose previews the selected source and its PDF delivery format', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser);
    const { workspaces } = await (await context.request.get('/api/workspaces')).json();
    const workspace = workspaces.find((entry: { name: string; permissions: { canRead: boolean } }) => entry.name === 'Shared Test Workspace' && entry.permissions.canRead);
    expect(workspace).toBeTruthy();
    await context.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), workspace.id);
    const fixture = await installEmailAttachmentPreviewFixture(context);
    const reads: string[] = [];
    await context.route('**/api/files/list?**', route => {
      expect(new URL(route.request().url()).searchParams.get('workspaceId')).toBe(workspace.id);
      expect(route.request().headers()['x-canvas-workspace-id']).toBe(workspace.id);
      return route.fulfill({ json: { success: true, files: [{ path: 'preview/source.md', name: 'source.md', type: 'file', size: 28 }], total: 1 } });
    });
    await context.route('**/api/media/preview/source.md?**', route => {
      expect(new URL(route.request().url()).searchParams.get('workspaceId')).toBe(workspace.id);
      reads.push('source'); return route.fulfill({ contentType: 'text/markdown', body: '# Selected workspace source' });
    });
    await context.route('**/api/files/markdown-pdf', route => {
      expect(route.request().method()).toBe('POST');
      expect(route.request().headers()['x-canvas-workspace-id']).toBe(workspace.id);
      expect(route.request().postDataJSON()).toEqual({ path: 'preview/source.md' });
      reads.push('pdf'); return route.fulfill({ contentType: 'application/pdf', body: fixture.files.get('pdf')!.body });
    });
    const page = await context.newPage();
    try {
      await page.goto('/emails', { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: en.emailFocus.compose, exact: true }).click();
      await page.getByRole('button', { name: en.emailFocus.composeWithSender, exact: true }).click();
      const compose = page.getByRole('dialog').filter({ has: page.locator('#email-compose-subject') });
      await compose.getByRole('button', { name: 'Attach files', exact: true }).click();
      const picker = page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: en.emails.attachmentsTabWorkspace, exact: true }) });
      await picker.getByTitle('preview/source.md', { exact: true }).click();
      await picker.getByRole('button', { name: 'Attach selected', exact: true }).click();
      const trigger = compose.getByTestId('email-attachment-preview-trigger');
      await trigger.click();
      const popup = page.getByTestId('email-attachment-preview');
      await expect(popup.getByRole('heading', { name: 'Selected workspace source', exact: true })).toBeVisible();
      await page.keyboard.press('Escape'); await expect(popup).toBeHidden();
      await compose.getByRole('switch', { name: 'Send source as PDF', exact: true }).click();
      await trigger.click(); await expect(popup.getByRole('heading', { name: 'source.pdf', exact: true })).toBeVisible();
      await expect(popup.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
      const downloading = page.waitForEvent('download'); await popup.getByLabel(en.emailAttachmentPreview.download, { exact: true }).click();
      expect((await downloading).suggestedFilename()).toBe('source.pdf');
      expect(reads).toEqual(['source', 'pdf']); expect(fixture.writes).toEqual([]);
    } finally { await context.close(); }
  });

  test('late file responses cannot replace another attachment and access loss clears loaded bytes', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser); const fixture = await installEmailAttachmentPreviewFixture(context); const page = await context.newPage();
    await page.addInitScript(() => {
      const revoke = URL.revokeObjectURL.bind(URL);
      const revoked: string[] = [];
      (window as unknown as { emailPreviewRevoked: string[] }).emailPreviewRevoked = revoked;
      URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
    });
    let release!: () => void; fixture.delay = new Promise<void>(resolve => { release = resolve; });
    try {
      const review = await openReview(page);
      await review.getByTestId('email-attachment-preview-trigger').filter({ hasText: 'notes.txt' }).click();
      const popup = page.getByTestId('email-attachment-preview'); await expect(popup.getByRole('status')).toBeVisible();
      await popup.getByTestId('email-attachment-preview-next').click(); await expect(popup.locator('canvas').first()).toBeVisible();
      release(); fixture.delay = null; await expect(popup.getByRole('heading')).toHaveText('report.pdf');
      await expect(popup.locator('pre')).toHaveCount(0);
      await popup.getByTestId('email-attachment-preview-previous').click(); await expect(popup.locator('pre')).toHaveText('Frozen agent attachment contents');
      const objectURL = await popup.getByLabel(en.emailAttachmentPreview.download, { exact: true }).getAttribute('href');
      fixture.deny = true; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(popup.getByRole('alert')).toHaveText(en.emailAttachmentPreview.errors.forbidden);
      await expect(popup.locator('pre')).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { emailPreviewRevoked: string[] }).emailPreviewRevoked)).toContain(objectURL);
      expect(fixture.writes).toEqual([]);
    } finally { release(); await context.close(); }
  });

  test('uncertain delivery stays read-only while its attachments remain readable on mobile', async ({ browser }) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 390, height: 844 } });
    const fixture = await installEmailAttachmentPreviewFixture(context, { uncertain: true }); const page = await context.newPage();
    try {
      const review = await openReview(page); await expect(review.getByTestId('email-review-send')).toBeDisabled();
      await review.getByTestId('email-attachment-preview-trigger').filter({ hasText: 'notes.txt' }).click();
      const popup = page.getByTestId('email-attachment-preview'); await expect(popup.locator('pre')).toHaveText('Frozen agent attachment contents');
      await assertPopupFits(page, popup); await page.keyboard.press('Escape');
      await expect(review).toBeVisible(); await expect(review.getByTestId('email-review-send')).toBeDisabled(); expect(fixture.writes).toEqual([]);
    } finally { await context.close(); }
  });
});
