import { expect, test } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import type { EmailOutboxDraft } from '../app/apps/email/components/email-client-types';
import en from '../messages/en.json';

// Acceptance against an existing agent-generated fixture in the managed stack.
// Only an explicitly supplied QA source file may change; the email stays untouched.
test('persisted agent attachment opens and downloads without altering the stored draft', async ({ browser }, info) => {
  test.setTimeout(90_000);
  test.skip(process.env.EMAIL_ATTACHMENT_PERSISTED_E2E !== '1', 'Requires persisted Canvas email review fixtures in the managed local stack.');
  const context = await createAuthenticatedContext(browser, { viewport: { width: 390, height: 844 }, locale: 'en-US' });
  const writes: string[] = [];
  try {
    // Own the session used for the logout check; do not invalidate the shared QA login.
    expect((await context.request.post('/api/auth/sign-in/email', { headers: { Origin: process.env.BASE_URL! }, data: {
      email: process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL,
      password: process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD,
    } })).ok()).toBe(true);
    const listing = await context.request.get('/api/email/outbox');
    expect(listing.ok()).toBe(true);
    const { data } = await listing.json() as { data: Array<EmailOutboxDraft & { origin: string }> };
    const draft = data.find(entry => (!process.env.EMAIL_ATTACHMENT_PERSISTED_DRAFT_ID || entry.id === process.env.EMAIL_ATTACHMENT_PERSISTED_DRAFT_ID)
      && entry.origin === 'agent' && ['editing', 'awaiting_review'].includes(entry.status!)
      && entry.subject.includes('Canvas email review') && entry.senderAddress?.endsWith('@canvas-email-review.test')
      && entry.attachments?.some(attachment => attachment.source === 'upload' && attachment.name?.endsWith('.txt')));
    expect(draft, 'Managed stack needs an existing agent email review fixture with a frozen text attachment.').toBeTruthy();
    const endpoint = `/api/email/outbox/${encodeURIComponent(draft!.id)}`;
    const before = (await (await context.request.get(endpoint)).json()).data;
    const attachment = draft!.attachments!.find(item => item.source === 'upload' && item.name?.endsWith('.txt'))!;
    const fileURL = `/api/files/${encodeURIComponent(attachment.uploadId!)}`;
    const original = await context.request.get(fileURL);
    expect(original.ok()).toBe(true);
    const bytes = await original.body();
    if (process.env.EMAIL_ATTACHMENT_PERSISTED_SOURCE_PATH && process.env.EMAIL_ATTACHMENT_PERSISTED_WORKSPACE_ID) {
      expect(process.env.EMAIL_ATTACHMENT_PERSISTED_SOURCE_PATH).toMatch(/^email-preview-e2e-[a-f0-9]+\.txt$/u);
      const sourceURL = `/api/media/${process.env.EMAIL_ATTACHMENT_PERSISTED_SOURCE_PATH.split('/').map(encodeURIComponent).join('/')}?workspaceId=${encodeURIComponent(process.env.EMAIL_ATTACHMENT_PERSISTED_WORKSPACE_ID)}`;
      let currentSource = await context.request.get(sourceURL);
      expect(currentSource.ok()).toBe(true);
      if ((await currentSource.body()).equals(bytes)) {
        const sourcePage = await context.newPage();
        await sourcePage.addInitScript(id => localStorage.setItem('canvas.activeWorkspaceId', id), process.env.EMAIL_ATTACHMENT_PERSISTED_WORKSPACE_ID);
        await sourcePage.goto(`/en/notebook?path=${encodeURIComponent(process.env.EMAIL_ATTACHMENT_PERSISTED_SOURCE_PATH)}`, { waitUntil: 'domcontentloaded' });
        const editor = sourcePage.locator('.cm-content[contenteditable="true"]');
        await expect(editor).toBeVisible({ timeout: 30_000 });
        await editor.click(); await sourcePage.keyboard.press('ControlOrMeta+a');
        await sourcePage.keyboard.insertText('Changed workspace source. The email must retain its frozen original attachment.');
        await expect.poll(async () => (await (await context.request.get(sourceURL)).body()).equals(bytes), { timeout: 20_000 }).toBe(false);
        await sourcePage.close();
        currentSource = await context.request.get(sourceURL);
      }
      expect(await currentSource.body(), 'The source was changed after the agent made the attachment snapshot.').not.toEqual(bytes);
    }
    await context.route('**/api/**', route => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      if (path.includes('/email/') && !['GET', 'HEAD'].includes(request.method())) {
        writes.push(path);
        return route.fulfill({ status: 403, json: { success: false, error: 'Read-only persisted attachment acceptance.' } });
      }
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`/en/?outboxDraft=${encodeURIComponent(draft!.id)}`, { waitUntil: 'domcontentloaded' });
    const review = page.getByTestId('email-review-host');
    await expect(review.getByTestId('email-review-subject')).toHaveValue(before.subject);
    await expect(review.getByTestId('email-review-save')).toBeDisabled();
    const trigger = review.getByTestId('email-attachment-preview-trigger').filter({ hasText: attachment.name! });
    await review.locator('details').filter({ has: page.getByTestId('email-attachment-preview-trigger') }).locator('summary').click();
    await trigger.click();
    const popup = page.getByTestId('email-attachment-preview');
    await expect(popup.locator('pre')).toHaveText(bytes.toString('utf8'));
    const downloading = page.waitForEvent('download');
    await popup.getByLabel(en.emailAttachmentPreview.download, { exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(attachment.name);
    expect(await fs.readFile((await download.path())!)).toEqual(bytes);
    await page.screenshot({ path: info.outputPath('persisted-agent-attachment-mobile.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(review.getByTestId('email-review-save')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(review).toBeHidden();
    await expect(page.getByTestId('email-review-unsaved-dialog')).toBeHidden();
    const after = (await (await context.request.get(endpoint)).json()).data;
    expect(after).toEqual(before);
    expect(writes).toEqual([]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(review.getByTestId('email-review-subject')).toHaveValue(before.subject);
    await review.locator('details').filter({ has: page.getByTestId('email-attachment-preview-trigger') }).locator('summary').click();
    await trigger.click(); await expect(popup.locator('pre')).toHaveText(bytes.toString('utf8'));
    const logout = await context.request.post('/api/auth/sign-out', { headers: { Origin: process.env.BASE_URL! }, data: {} });
    expect(logout.status()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(popup.locator('pre')).toHaveCount(0);
  } finally { await context.close(); }
});
