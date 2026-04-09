# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: multiple-file-upload.spec.ts >> Multiple File Upload >> allows selecting multiple files via paperclip
- Location: tests/multiple-file-upload.spec.ts:40:7

# Error details

```
Test timeout of 90000ms exceeded.
```

```
Error: locator.click: Test timeout of 90000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: /new chat/i })

```

# Page snapshot

```yaml
- generic:
  - generic [active]:
    - generic [ref=e3]:
      - generic [ref=e4]:
        - generic [ref=e5]:
          - navigation [ref=e6]:
            - button "previous" [disabled] [ref=e7]:
              - img "previous" [ref=e8]
            - generic [ref=e10]:
              - generic [ref=e11]: 1/
              - text: "1"
            - button "next" [disabled] [ref=e12]:
              - img "next" [ref=e13]
          - img
        - generic [ref=e15]:
          - link "Next.js 16.2.2 (stale) Webpack" [ref=e16] [cursor=pointer]:
            - /url: https://nextjs.org/docs/messages/version-staleness
            - img [ref=e17]
            - generic "There is a newer version (16.2.3) available, upgrade recommended!" [ref=e19]: Next.js 16.2.2 (stale)
            - generic [ref=e20]: Webpack
          - img
      - dialog "Build Error" [ref=e22]:
        - generic [ref=e25]:
          - generic [ref=e26]:
            - generic [ref=e27]:
              - generic [ref=e29]: Build Error
              - generic [ref=e30]:
                - button "Copy Error Info" [ref=e31] [cursor=pointer]:
                  - img [ref=e32]
                - link "Go to related documentation" [ref=e34] [cursor=pointer]:
                  - /url: https://nextjs.org/docs/app/api-reference/directives/use-client
                  - img [ref=e35]
                - button "Attach Node.js inspector" [ref=e37] [cursor=pointer]:
                  - img [ref=e38]
            - generic [ref=e47]: "x You're importing a module that depends on `useEffect` into a React Server Component module. This API is only available in Client Components. To fix, mark the file (or its parent) with the `\"use client\"` directive."
          - generic [ref=e49]:
            - generic [ref=e51]:
              - img [ref=e53]
              - generic [ref=e56]: ./app/[locale]/(routes)/chat/page.tsx
              - button "Open in editor" [ref=e57] [cursor=pointer]:
                - img [ref=e59]
            - generic [ref=e63]:
              - text: "Error: x You're importing a module that depends on `useEffect` into a React Server Component module. This API is only available in Client Components. To fix, mark the file (or its parent) with the `\"use client\"` directive. | Learn more:"
              - link "https://nextjs.org/docs/app/api-reference/directives/use-client" [ref=e64] [cursor=pointer]:
                - /url: https://nextjs.org/docs/app/api-reference/directives/use-client
              - text: "| ,-[/Users/frankalexanderweber/.openclaw/workspace-mango-jerry/canvasstudios-notebook/app/[locale]/(routes)/chat/page.tsx:6:1] 3 | import { Link } from '@/i18n/navigation'; 4 | import { ArrowLeft, PanelLeft } from 'lucide-react'; 5 | import { getTranslations } from 'next-intl/server'; 6 | import { useEffect } from 'react'; : ^^^^^^^^^ 7 | 8 | import CanvasAgentChat from '@/app/components/canvas-agent-chat/CanvasAgentChat'; 9 | import { LanguageSwitcher } from '@/app/components/language-switcher'; `----"
        - generic [ref=e65]: "1"
        - generic [ref=e66]: "2"
    - generic [ref=e71] [cursor=pointer]:
      - button "Open Next.js Dev Tools" [ref=e72]:
        - img [ref=e73]
      - button "Open issues overlay" [ref=e77]:
        - generic [ref=e78]:
          - generic [ref=e79]: "0"
          - generic [ref=e80]: "1"
        - generic [ref=e81]: Issue
  - alert [ref=e82]
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
  22  |   expect(response.ok()).toBeTruthy();
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
> 44  |     await page.getByRole('button', { name: /new chat/i }).click();
      |                                                           ^ Error: locator.click: Test timeout of 90000ms exceeded.
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
  123 |     await fileInput.setInputFiles([
  124 |       {
  125 |         name: 'too-large.txt',
  126 |         mimeType: 'text/plain',
  127 |         buffer: largeBuffer,
  128 |       },
  129 |     ]);
  130 |     
  131 |     // Wait for error message
  132 |     await page.waitForTimeout(2000);
  133 |     
  134 |     // Verify error is shown
  135 |     const errorBanner = page.locator('[class*="bg-destructive/10"]');
  136 |     await expect(errorBanner).toBeVisible();
  137 |     await expect(errorBanner).toContainText(/too large|File too large/i);
  138 |   });
  139 | 
  140 |   test('allows removing individual attachments', async ({ page }) => {
  141 |     await page.goto('/chat');
  142 |     
  143 |     // Start fresh chat
  144 |     await page.getByRole('button', { name: /new chat/i }).click();
```