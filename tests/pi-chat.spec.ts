import { test, expect } from '@playwright/test';

const TEST_EMAIL = 'admin.com';
const TEST_PASSWORD = 'change-me';

test.describe('PI Chat E2E', () => {
  test.beforeEach(async ({ page }) => {
    // Login
    await page.goto('/login');
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('/');
  });

  test('should bootstrap a session before first stream and show it in history', async ({ page }) => {
    // Go to Chat
    await page.goto('/chat');
    
    // Type a message
    const textarea = page.locator('textarea');
    await textarea.fill('Hello from E2E test - bootstrap session');
    await textarea.press('Enter'); // sends message in chat composer

    // New session id badge should appear after first send
    const sessionBadge = page.locator('span').filter({ hasText: /^#/ }).first();
    await expect(sessionBadge).toBeVisible({ timeout: 15000 });
    const badgeText = await sessionBadge.textContent();
    expect((badgeText || '').trim().length).toBeGreaterThan(1);
    const sessionPrefix = (badgeText || '').trim().replace('#', '');

    const sessionsPayload = await page.evaluate(async () => {
      const response = await fetch('/api/sessions');
      return response.json();
    });
    expect(sessionsPayload?.success).toBeTruthy();
    expect(Array.isArray(sessionsPayload?.sessions)).toBeTruthy();
    const hasSessionWithPrefix = sessionsPayload.sessions.some((s: { sessionId?: string }) =>
      typeof s.sessionId === 'string' && s.sessionId.startsWith(sessionPrefix)
    );
    expect(hasSessionWithPrefix).toBeTruthy();

    // Open history to ensure the toggle still works after bootstrap
    await page.locator('button').filter({ has: page.locator('.lucide-history') }).first().click();
    await expect(page.getByText('Sessions', { exact: true })).toBeVisible();
  });
});
