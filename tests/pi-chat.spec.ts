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

  test('should configure PI engine and chat', async ({ page }) => {
    // Go to settings
    await page.goto('/settings');
    
    // Check if PI Runtime Settings card is visible
    await expect(page.locator('text=PI Runtime Settings')).toBeVisible();
    
    // Select a provider (e.g., openrouter if available)
    const providerSelect = page.locator('select').first();
    await providerSelect.selectOption({ label: 'openrouter' });
    
    // Save config
    await page.click('button:has-text("PI-Konfiguration speichern")');
    await expect(page.locator('text=Agent-Konfiguration gespeichert')).toBeVisible();

    // Go to Chat
    await page.goto('/chat');
    
    // Type a message
    const textarea = page.locator('textarea');
    await textarea.fill('Hello from E2E test');
    await page.click('button >> svg'); // Send button

    // Check for assistant response
    // In PI mode, the agent label might change, but we look for assistant message container
    await expect(page.locator('text=user: admin.com')).toBeVisible();
    
    // Wait for response text (best effort check)
    // We expect some text to appear in the assistant message
    const assistantMessage = page.locator('.justify-start .text-sm').first();
    await expect(assistantMessage).not.toBeEmpty({ timeout: 15000 });

    // History check
    await page.click('button >> .lucide-history');
    await expect(page.locator('text=Integration PI Session')).toBeVisible();
  });
});
