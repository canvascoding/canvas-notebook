import { expect, test, type BrowserContext } from '@playwright/test';

import { createAuthenticatedContext } from './helpers/managed-test-context';

type SessionPayload = {
  user?: { email?: string } | null;
};

async function sessionEmail(context: BrowserContext): Promise<string | null> {
  const response = await context.request.get('/api/auth/get-session');
  expect(response.ok(), await response.text()).toBeTruthy();
  const payload = await response.json() as SessionPayload | null;
  return payload?.user?.email || null;
}

test.describe('Managed authenticated browser contexts', () => {
  test('isolates shared admin and member states while preserving an anonymous context', async ({ browser }) => {
    const memberEmail = process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
    const memberPassword = process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
    test.skip(!memberEmail || !memberPassword, 'Managed Team Seat secondary credentials are not configured.');

    const adminEmail = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
    expect(adminEmail).toBeTruthy();

    const [adminContextA, adminContextB, memberContext] = await Promise.all([
      createAuthenticatedContext(browser),
      createAuthenticatedContext(browser),
      createAuthenticatedContext(browser, {}, { email: memberEmail, password: memberPassword }),
    ]);
    const anonymousContext = await browser.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3000' });

    try {
      const [adminA, adminB, member, anonymous] = await Promise.all([
        sessionEmail(adminContextA),
        sessionEmail(adminContextB),
        sessionEmail(memberContext),
        sessionEmail(anonymousContext),
      ]);
      expect(adminA).toBe(adminEmail);
      expect(adminB).toBe(adminEmail);
      expect(member).toBe(memberEmail);
      expect(anonymous).toBeNull();
    } finally {
      await Promise.all([
        adminContextA.close(),
        adminContextB.close(),
        memberContext.close(),
        anonymousContext.close(),
      ]);
    }
  });
});
