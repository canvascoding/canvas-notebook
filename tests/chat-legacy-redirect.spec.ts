import { expect, test } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
const TEST_ORIGIN = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Legacy chat route', () => {
  test('keeps unauthenticated legacy links behind the login guard', async ({ page }) => {
    await page.goto('/chat?session=private-session', { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveURL(/\/login\?from=%2Fchat%3Fsession%3Dprivate-session$/);
  });

  test('redirects authenticated session links into the notebook', async ({ page }) => {
    const response = await page.request.post('/api/auth/sign-in/email', {
      headers: { Origin: TEST_ORIGIN },
      data: {
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      },
    });
    expect(response.ok()).toBeTruthy();

    await page.goto(
      '/chat?session=legacy-session&workspaceId=legacy-workspace&chat=closed&filter=unread&filter=assigned',
      { waitUntil: 'domcontentloaded' },
    );
    await expect(page).toHaveURL(/\/notebook\?/);

    const url = new URL(page.url());
    expect(url.pathname.endsWith('/notebook')).toBeTruthy();
    expect(url.searchParams.get('session')).toBe('legacy-session');
    expect(url.searchParams.get('workspaceId')).toBe('legacy-workspace');
    expect(url.searchParams.get('chat')).toBe('open');
    expect(url.searchParams.getAll('filter')).toEqual(['unread', 'assigned']);
  });
});
