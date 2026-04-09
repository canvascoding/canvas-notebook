import { expect, test, type Browser, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const TEST_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const AUTH_STATE_PATH = 'test-results/multiple-file-upload-auth.json';

async function login(page: Page) {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: {
      Origin: process.env.BASE_URL || 'http://localhost:3000',
    },
    data: {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    },
  });

  expect(response.ok()).toBeTruthy();
  await page.goto('/chat', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/chat$/, { timeout: 15000 });
}

test.describe('Multiple File Upload', () => {
  test.setTimeout(90000);
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    test.setTimeout(120000);
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await login(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
  });

  test('allows selecting multiple files via paperclip', async ({ page }) => {
    await page.goto('/chat');
    
    // Start fresh chat
    await page.getByRole('button', { name: /new chat/i }).click();
    
    // Click paperclip to open file dialog
    const fileInput = page.locator('input[type="file"]');
    
    // Set multiple files at once
    await fileInput.setInputFiles([
      {
        name: 'test1.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Test content 1'),
      },
      {
        name: 'test2.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Test content 2'),
      },
    ]);
    
    // Wait for attachments to appear
    await page.waitForTimeout(2000);
    
    // Verify both attachments are shown
    const attachmentBadges = page.locator('[class*="bg-accent/70"]').filter({ hasText: /test/ });
    await expect(attachmentBadges).toHaveCount(2);
    
    // Verify filenames are visible
    const attachmentText = await page.locator('[class*="bg-accent/70"]').allTextContents();
    expect(attachmentText.join(' ')).toContain('test1.txt');
    expect(attachmentText.join(' ')).toContain('test2.txt');
  });

  test('uploads mixed file types (image + document)', async ({ page }) => {
    await page.goto('/chat');
    
    // Start fresh chat
    await page.getByRole('button', { name: /new chat/i }).click();
    
    const fileInput = page.locator('input[type="file"]');
    
    // Upload mixed file types
    await fileInput.setInputFiles([
      {
        name: 'test-image.png',
        mimeType: 'image/png',
        buffer: Buffer.from('fake-png-content'),
      },
      {
        name: 'test-doc.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('fake-pdf-content'),
      },
    ]);
    
    // Wait for uploads
    await page.waitForTimeout(2000);
    
    // Verify both attachments appear
    const attachmentBadges = page.locator('[class*="bg-accent/70"]');
    await expect(attachmentBadges).toHaveCount(2);
    
    // Check that both files are present
    const allText = await page.locator('[class*="bg-accent/70"]').allTextContents();
    const allTextCombined = allText.join(' ');
    expect(allTextCombined).toContain('test-image.png');
    expect(allTextCombined).toContain('test-doc.pdf');
  });

  test('shows upload error for oversized files', async ({ page }) => {
    await page.goto('/chat');
    
    // Start fresh chat
    await page.getByRole('button', { name: /new chat/i }).click();
    
    const fileInput = page.locator('input[type="file"]');
    
    // Create a file larger than 10MB limit
    const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
    
    await fileInput.setInputFiles([
      {
        name: 'too-large.txt',
        mimeType: 'text/plain',
        buffer: largeBuffer,
      },
    ]);
    
    // Wait for error message
    await page.waitForTimeout(2000);
    
    // Verify error is shown
    const errorBanner = page.locator('[class*="bg-destructive/10"]');
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText(/too large|File too large/i);
  });

  test('allows removing individual attachments', async ({ page }) => {
    await page.goto('/chat');
    
    // Start fresh chat
    await page.getByRole('button', { name: /new chat/i }).click();
    
    const fileInput = page.locator('input[type="file"]');
    
    // Upload 3 files
    await fileInput.setInputFiles([
      {
        name: 'file1.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('content1'),
      },
      {
        name: 'file2.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('content2'),
      },
      {
        name: 'file3.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('content3'),
      },
    ]);
    
    // Wait for uploads
    await page.waitForTimeout(2000);
    
    // Verify 3 attachments
    let attachmentBadges = page.locator('[class*="bg-accent/70"]');
    await expect(attachmentBadges).toHaveCount(3);
    
    // Remove middle attachment (file2)
    const allBadges = await page.locator('[class*="bg-accent/70"]').all();
    await allBadges[1].locator('button').click();
    
    // Wait for removal
    await page.waitForTimeout(500);
    
    // Verify only 2 remain
    attachmentBadges = page.locator('[class*="bg-accent/70"]');
    await expect(attachmentBadges).toHaveCount(2);
  });
});
