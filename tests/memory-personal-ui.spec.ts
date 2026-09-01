import { expect, test } from '@playwright/test';

const EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
const PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
const enabled = process.env.E2E_MEMORY_UI === '1' && Boolean(EMAIL && PASSWORD);

test.describe('Memory Manager settings', () => {
  test.skip(!enabled, 'Requires an explicitly enabled local server and login credentials.');

  test('renders private memory and the dedicated review configuration without mutation', async ({ page }, testInfo) => {
    await page.goto('/en/login');
    await page.getByRole('textbox', { name: /email/i }).fill(EMAIL!);
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORD!);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes('/login'), { waitUntil: 'domcontentloaded' }),
      page.locator('button[type="submit"]').click(),
    ]);

    await page.goto('/en/settings?tab=memory&scope=user', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Memory Manager', { exact: true })).toBeVisible();
    await expect(page.getByText(/dedicated memory-manager worker/i)).toBeVisible();
    const scopeTabs = page.getByRole('tablist', { name: 'Memory scope' });
    await expect(scopeTabs).toBeVisible();
    await expect(scopeTabs.getByRole('button', { name: 'My memory' })).toBeVisible();
    await expect(scopeTabs.getByRole('button', { name: 'Agent memory' })).toBeVisible();
    await expect(scopeTabs.getByRole('button', { name: 'Workspace' })).toBeDisabled();
    await expect(scopeTabs.getByRole('button', { name: 'Organization' })).toBeVisible();
    await expect(page.getByText('Memory review runtime', { exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Automatic memory' })).toBeVisible();
    await expect(page.getByLabel('Provider installation')).toBeVisible();
    await expect(page.getByLabel('Lightweight review model')).toBeDisabled();
    await expect(page.getByLabel('Prompt budget (tokens)')).toHaveValue('2000');
    await expect(page.getByRole('button', { name: 'Save review settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import JSON' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete all private memory' })).toBeVisible();
    await expect(page.getByText('Loading memory…')).not.toBeVisible();

    await scopeTabs.getByRole('button', { name: 'Agent memory' }).click();
    await expect(page.getByText('Private agent context. Published shared memory is visible to readers; pending suggestions need a manager’s approval.')).toBeVisible();
    await expect(page.getByTestId('agent-memory-owner-card')).toBeVisible();
    await expect(page.getByTestId('agent-memory-owner-select')).toBeVisible();
    await expect(page.getByTestId('agent-memory-owner-select')).not.toHaveValue('');
    await expect(page.getByText('Loading memory…')).not.toBeVisible();

    const missingAgentResponse = await page.request.get('/api/memory?scope=agent');
    expect(missingAgentResponse.ok()).toBe(false);

    await page.goto('/en/settings?tab=agent-settings', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('memory-review-agent-card')).toBeVisible();
    await expect(page.getByText('memory-manager', { exact: true })).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath('memory-manager.png'), fullPage: true });
  });
});
