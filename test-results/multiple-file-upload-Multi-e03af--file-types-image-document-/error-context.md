# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: multiple-file-upload.spec.ts >> Multiple File Upload >> uploads mixed file types (image + document)
- Location: tests/multiple-file-upload.spec.ts:76:7

# Error details

```
Error: expect(received).toBeTruthy()

Received: false
```

# Test source

```ts
  1   | import { expect, test, type Browser, type Page } from '@playwright/test';
  2   | import dotenv from 'dotenv';
  3   | import path from 'node:path';
  4   | 
  5   | dotenv.config({ path: path.join(process.cwd(), '.env.local') });
  6   | 
  7   | const TEST_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
  8   | const TEST_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
  9   | const AUTH_STATE_PATH = 'test-results/multiple-file-upload-auth.json';
  10  | 
  11  | async function login(page: Page) {
  12  |   const response = await page.request.post('/api/auth/sign-in/email', {
  13  |     headers: {
  14  |       Origin: process.env.BASE_URL || 'http://localhost:3000',
  15  |     },
  16  |     data: {
  17  |       email: TEST_EMAIL,
  18  |       password: TEST_PASSWORD,
  19  |     },
  20  |   });
  21  | 
> 22  |   expect(response.ok()).toBeTruthy();
      |                         ^ Error: expect(received).toBeTruthy()
  23  |   await page.goto('/chat', { waitUntil: 'domcontentloaded' });
  24  |   await expect(page).toHaveURL(/\/chat$/, { timeout: 15000 });
  25  | }
  26  | 
  27  | test.describe('Multiple File Upload', () => {
  28  |   test.setTimeout(90000);
  29  |   test.use({ storageState: AUTH_STATE_PATH });
  30  | 
  31  |   test.beforeAll(async ({ browser }: { browser: Browser }) => {
  32  |     test.setTimeout(120000);
  33  |     const context = await browser.newContext({ storageState: undefined });
  34  |     const page = await context.newPage();
  35  |     await login(page);
  36  |     await context.storageState({ path: AUTH_STATE_PATH });
  37  |     await context.close();
  38  |   });
  39  | 
  40  |   test('allows selecting multiple files via paperclip', async ({ page }) => {
  41  |     await page.goto('/chat');
  42  |     
  43  |     // Start fresh chat
  44  |     await page.getByRole('button', { name: /new chat/i }).click();
  45  |     
  46  |     // Click paperclip to open file dialog
  47  |     const fileInput = page.locator('input[type="file"]');
  48  |     
  49  |     // Set multiple files at once
  50  |     await fileInput.setInputFiles([
  51  |       {
  52  |         name: 'test1.txt',
  53  |         mimeType: 'text/plain',
  54  |         buffer: Buffer.from('Test content 1'),
  55  |       },
  56  |       {
  57  |         name: 'test2.txt',
  58  |         mimeType: 'text/plain',
  59  |         buffer: Buffer.from('Test content 2'),
  60  |       },
  61  |     ]);
  62  |     
  63  |     // Wait for attachments to appear
  64  |     await page.waitForTimeout(2000);
  65  |     
  66  |     // Verify both attachments are shown
  67  |     const attachmentBadges = page.locator('[class*="bg-accent/70"]').filter({ hasText: /test/ });
  68  |     await expect(attachmentBadges).toHaveCount(2);
  69  |     
  70  |     // Verify filenames are visible
  71  |     const attachmentText = await page.locator('[class*="bg-accent/70"]').allTextContents();
  72  |     expect(attachmentText.join(' ')).toContain('test1.txt');
  73  |     expect(attachmentText.join(' ')).toContain('test2.txt');
  74  |   });
  75  | 
  76  |   test('uploads mixed file types (image + document)', async ({ page }) => {
  77  |     await page.goto('/chat');
  78  |     
  79  |     // Start fresh chat
  80  |     await page.getByRole('button', { name: /new chat/i }).click();
  81  |     
  82  |     const fileInput = page.locator('input[type="file"]');
  83  |     
  84  |     // Upload mixed file types
  85  |     await fileInput.setInputFiles([
  86  |       {
  87  |         name: 'test-image.png',
  88  |         mimeType: 'image/png',
  89  |         buffer: Buffer.from('fake-png-content'),
  90  |       },
  91  |       {
  92  |         name: 'test-doc.pdf',
  93  |         mimeType: 'application/pdf',
  94  |         buffer: Buffer.from('fake-pdf-content'),
  95  |       },
  96  |     ]);
  97  |     
  98  |     // Wait for uploads
  99  |     await page.waitForTimeout(2000);
  100 |     
  101 |     // Verify both attachments appear
  102 |     const attachmentBadges = page.locator('[class*="bg-accent/70"]');
  103 |     await expect(attachmentBadges).toHaveCount(2);
  104 |     
  105 |     // Check that both files are present
  106 |     const allText = await page.locator('[class*="bg-accent/70"]').allTextContents();
  107 |     const allTextCombined = allText.join(' ');
  108 |     expect(allTextCombined).toContain('test-image.png');
  109 |     expect(allTextCombined).toContain('test-doc.pdf');
  110 |   });
  111 | 
  112 |   test('shows upload error for oversized files', async ({ page }) => {
  113 |     await page.goto('/chat');
  114 |     
  115 |     // Start fresh chat
  116 |     await page.getByRole('button', { name: /new chat/i }).click();
  117 |     
  118 |     const fileInput = page.locator('input[type="file"]');
  119 |     
  120 |     // Create a file larger than 10MB limit
  121 |     const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
  122 |     
```