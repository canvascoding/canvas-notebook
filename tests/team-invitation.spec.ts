import { expect, test } from '@playwright/test';

const INVITATION_TOKEN = 'A'.repeat(43);

test('opens an invitation without authentication and scrolls on a small viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await page.route('**/api/organization/invitations/preview', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          invitationId: 'team-invitation-scroll-test',
          email: 'invited@example.test',
          role: 'member',
          status: 'pending',
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          requestId: null,
        },
      }),
    });
  });

  await page.goto(`/invite/team?token=${INVITATION_TOKEN}`);

  await expect(page).not.toHaveURL(/\/login(?:\?|$)/u);
  await expect(page.getByText(/Dein Workspace wartet|Your workspace is waiting/u, { exact: true })).toBeVisible();
  await expect(page.getByText('invited@example.test')).toBeVisible();

  const scrollRoot = page.locator('main');
  const metrics = await scrollRoot.evaluate((element) => ({
    viewportHeight: element.clientHeight,
    contentHeight: element.scrollHeight,
  }));
  expect(metrics.contentHeight).toBeGreaterThan(metrics.viewportHeight);

  await scrollRoot.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => scrollRoot.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByText(/Das Einladungs-Token bleibt|The invitation token stays/u)).toBeInViewport();
});
