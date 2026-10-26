import { expect, test } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';
import { authenticateManagedTestPage } from './helpers/managed-test-context';

dotenv.config({ path: process.env.CANVAS_ENV_FILE || path.join(process.cwd(), '.env.local'), quiet: true });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

test.describe('Legacy chat route', () => {
  test('keeps unauthenticated legacy links behind the login guard', async ({ page }) => {
    await page.goto('/chat?session=private-session', { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveURL((url) => /^\/(?:de\/|en\/)?login$/.test(url.pathname));
    const redirect = new URL(new URL(page.url()).searchParams.get('from')!, page.url());
    expect(redirect.pathname).toMatch(/^\/(?:de\/|en\/)?chat$/);
    expect(redirect.searchParams.get('session')).toBe('private-session');
  });

  test('redirects authenticated session links into the notebook', async ({ page }) => {
    await authenticateManagedTestPage(page, { email: TEST_EMAIL, password: TEST_PASSWORD });

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
