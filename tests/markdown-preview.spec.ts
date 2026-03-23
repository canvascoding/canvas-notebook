import { test, expect, type Page, type Browser } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const AUTH_STATE_PATH = path.join('test-results', 'md-preview-auth.json');

const MD_FILENAME = 'test-markdown-preview.md';
const MD_CONTENT = '# Hello World\n\nThis is a **bold** test paragraph.\n\n- Item 1\n- Item 2\n';

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/', { timeout: 15_000 });
}

test.describe('Markdown Preview', () => {
  test.setTimeout(60_000);
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    // Create test markdown file
    const workspacePath = path.resolve('data/workspace');
    fs.writeFileSync(path.join(workspacePath, MD_FILENAME), MD_CONTENT);

    // Login and save auth state
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await login(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
  });

  test.afterAll(() => {
    const workspacePath = path.resolve('data/workspace');
    const filePath = path.join(workspacePath, MD_FILENAME);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  test('preview renders markdown content when file is opened', async ({ page }) => {
    // Go to home page (file browser)
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Click on the test markdown file in the file browser
    await page.getByText(MD_FILENAME).click();

    // Wait for the editor to load
    await page.waitForSelector('.w-md-editor', { timeout: 10_000 });

    // The editor should be in preview mode by default
    // Check that the preview container has rendered content
    const preview = page.locator('.w-md-editor-preview');
    await expect(preview).toBeVisible({ timeout: 5_000 });

    // The preview should contain the rendered markdown
    // h1 "Hello World" should be visible
    await expect(preview.locator('h1')).toContainText('Hello World');

    // Bold text should be rendered
    await expect(preview.locator('strong')).toContainText('bold');

    // List items should be rendered
    await expect(preview.locator('li').first()).toContainText('Item 1');
  });
});
