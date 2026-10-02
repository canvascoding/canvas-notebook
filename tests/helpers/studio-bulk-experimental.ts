import { expect, test as base, type APIRequestContext } from '@playwright/test';

import { createAuthenticatedContext } from './managed-test-context';

export type StudioBulkAvailability = { studioBulkEnabled: boolean; updatedAt: string | null };

export async function readStudioBulkAvailability(request: APIRequestContext): Promise<StudioBulkAvailability> {
  const response = await request.get('/api/studio/bulk/availability', { timeout: 30_000 });
  expect(response.status(), 'Authenticated Studio Bulk availability').toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  const payload = await response.json();
  expect(payload.success).toBe(true);
  expect(typeof payload.data.studioBulkEnabled).toBe('boolean');
  return payload.data;
}

export async function readDocumentReviewEnabled(request: APIRequestContext): Promise<boolean> {
  const response = await request.get('/api/document-review/availability', { timeout: 30_000 });
  expect(response.status(), 'Document Review availability stays available').toBe(200);
  return (await response.json()).data.documentReviewEnabled;
}

export async function setStudioBulkEnabled(request: APIRequestContext, studioBulkEnabled: boolean): Promise<void> {
  const response = await request.patch('/api/admin/experimental-settings', {
    headers: { Origin: process.env.BASE_URL! }, data: { studioBulkEnabled }, timeout: 30_000,
  });
  expect(response.status(), 'Admin updates Studio Bulk flag').toBe(200);
  const payload = await response.json();
  expect(payload.success).toBe(true);
  expect(payload.data.studioBulkEnabled).toBe(studioBulkEnabled);
  expect(typeof payload.data.studioBulkUpdatedAt).toBe('string');
  expect((await readStudioBulkAvailability(request)).studioBulkEnabled).toBe(studioBulkEnabled);
}

// Existing Bulk navigation/product suites intentionally exercise the enabled
// feature. Restore the previous instance setting even if an assertion fails.
export const test = base.extend<{ studioBulkFlag: void }>({
  page: async ({ browser, viewport }, runFixture) => {
    const context = await createAuthenticatedContext(browser, { viewport });
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(30_000);
    try {
      await runFixture(await context.newPage());
    } finally {
      await context.close();
    }
  },
  studioBulkFlag: [async ({ page }, runFixture) => {
    const initial = await readStudioBulkAvailability(page.request);
    const documentReviewEnabled = await readDocumentReviewEnabled(page.request);
    try {
      await setStudioBulkEnabled(page.request, true);
      await runFixture();
    } finally {
      await setStudioBulkEnabled(page.request, initial.studioBulkEnabled);
      expect(await readDocumentReviewEnabled(page.request)).toBe(documentReviewEnabled);
    }
  }, { auto: true }],
});
