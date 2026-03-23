import { test, expect, type Page, type Browser } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'info@canvasstudios.store';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Canvas2026!';
const AUTH_STATE_PATH = path.join('test-results', 'md-preview-auth.json');

const WORKSPACE_PATH = path.resolve('data/workspace');
const MD_FILENAME = 'test-markdown-preview.md';
const MD_CONTENT = '# Hello World\n\nThis is a **bold** test paragraph.\n\n- Item 1\n- Item 2\n';

async function login(page: Page) {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: BASE_URL },
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

test.describe('Markdown Preview', () => {
  test.setTimeout(60_000);
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    // Create test markdown file in workspace root
    fs.mkdirSync(WORKSPACE_PATH, { recursive: true });
    fs.writeFileSync(path.join(WORKSPACE_PATH, MD_FILENAME), MD_CONTENT);

    // Login and save auth state
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await login(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
  });

  test.afterAll(() => {
    const filePath = path.join(WORKSPACE_PATH, MD_FILENAME);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  test('preview renders markdown content when file is opened', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Debug: screenshot to see what page we're on
    await page.screenshot({ path: 'test-results/md-preview-debug.png' });

    // Click on the test markdown file in the file browser
    const fileEntry = page.getByText(MD_FILENAME);
    await fileEntry.waitFor({ timeout: 10_000 });
    await fileEntry.click();

    // Wait for the md editor to load
    await page.waitForSelector('.w-md-editor', { timeout: 10_000 });

    // The editor should be in preview mode by default
    const preview = page.locator('.w-md-editor-preview');
    await expect(preview).toBeVisible({ timeout: 5_000 });

    // The preview should contain the rendered markdown — h1 "Hello World"
    await expect(preview.locator('h1')).toContainText('Hello World', { timeout: 5_000 });

    // Bold text should be rendered
    await expect(preview.locator('strong')).toContainText('bold');

    // List items should be rendered
    await expect(preview.locator('li').first()).toContainText('Item 1');
  });
});
