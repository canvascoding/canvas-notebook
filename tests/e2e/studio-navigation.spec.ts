import { expect } from '@playwright/test';

import { test } from '../helpers/studio-bulk-experimental';

test.describe('Studio Navigation', () => {
  test.describe.configure({ mode: 'serial' });

  test('navigates from home to studio page', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: /^(?:Apps öffnen|Open apps)$/ }).click();
    await page.getByRole('menuitem', { name: 'Studio', exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/?$/);
    await expect(page.getByRole('navigation', { name: 'Studio', exact: true })).toBeVisible();
  });

  test('studio navigation switches between views with bulk explicitly enabled', async ({ page }) => {
    await page.goto('/studio', { waitUntil: 'domcontentloaded' });
    const navigation = page.getByRole('navigation', { name: 'Studio', exact: true });
    await navigation.getByRole('link', { name: 'Bulk', exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/bulk\/?$/);
    await navigation.getByRole('link', { name: /^(?:Models|Modelle)$/ }).click();
    await expect(page).toHaveURL(/\/studio\/models\/?$/);
    await navigation.getByRole('link', { name: 'Presets', exact: true }).click();
    await expect(page).toHaveURL(/\/studio\/presets\/?$/);
    await navigation.getByRole('link', { name: /^(?:Create|Erstellen)$/ }).click();
    await expect(page).toHaveURL(/\/studio\/?$/);
  });

  test('back navigation returns to previous view', async ({ page }) => {
    await page.goto('/studio', { waitUntil: 'domcontentloaded' });
    await page.getByRole('navigation', { name: 'Studio', exact: true })
      .getByRole('link', { name: /^(?:Models|Modelle)$/ }).click();
    await expect(page).toHaveURL(/\/studio\/models\/?$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/studio\/?$/);
  });
});
