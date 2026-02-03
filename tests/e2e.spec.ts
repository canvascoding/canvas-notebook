import { test, expect } from '@playwright/test';

const baseUrl = process.env.BASE_URL || 'http://localhost:3001';

function parseSetCookie(value: string) {
  const [cookiePart] = value.split(';');
  const separatorIndex = cookiePart.indexOf('=');
  if (separatorIndex === -1) return null;
  const name = cookiePart.slice(0, separatorIndex).trim();
  const cookieValue = cookiePart.slice(separatorIndex + 1).trim();
  if (!name) return null;
  return { name, value: cookieValue };
}

test('login and load dashboard', async ({ page }) => {
  const response = await page.request.post(`${baseUrl}/api/auth/sign-in/email`, {
    data: { email: 'admin.com', password: 'change-me' },
  });

  expect(response.ok()).toBeTruthy();

  const setCookie = response.headers()['set-cookie'];
  if (setCookie) {
    const cookie = parseSetCookie(setCookie);
    if (cookie) {
      await page.context().addCookies([
        {
          ...cookie,
          url: baseUrl,
        },
      ]);
    }
  }

  await page.goto(`${baseUrl}/`);
  await expect(page.getByRole('heading', { name: 'Canvas Notebook' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible();
  await expect(page.getByText('Terminal', { exact: true })).toBeVisible();
});
