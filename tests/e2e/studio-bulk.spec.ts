import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { test } from '../helpers/studio-bulk-experimental';

test.describe('Studio Bulk Generate', () => {
  test.describe.configure({ mode: 'serial' });

  test('navigates to bulk page and sees product selection', async ({ page }) => {
    await page.goto('/studio/bulk', { waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', { name: /^(?:Bulk Generate|Bulk-Generierung)$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^(?:Product Selection|Produktauswahl)$/ })).toBeVisible();
  });

  test('selects products for bulk generation', async ({ page }) => {
    const name = `E2E Bulk Product ${randomUUID()}`;
    const createRes = await page.request.post('/api/studio/products', {
      headers: { Origin: process.env.BASE_URL! },
      data: { name, description: 'Isolated product-selection regression; no generation.' },
    });
    expect(createRes.status()).toBe(201);
    const product = (await createRes.json()).product;
    try {
      await page.goto('/studio/bulk', { waitUntil: 'domcontentloaded' });
      const productButton = page.getByRole('button', { name: new RegExp(name) });
      await expect(productButton).toBeVisible();
      await productButton.click();
      await expect(productButton).toContainText('✓');
      await expect(page.getByText(/1\/20 (?:selected|ausgewählt)/)).toBeVisible();
      await expect(page.getByRole('button', { name: /^(?:Start Bulk Generation|Bulk-Generierung starten)$/ })).toBeDisabled();
    } finally {
      const response = await page.request.delete(`/api/studio/products/${product.id}`);
      expect(response.ok(), 'Delete only the UUID product fixture').toBe(true);
    }
  });
});
