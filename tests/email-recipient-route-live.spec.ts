import { expect, test } from '@playwright/test';
import { createAuthenticatedContext } from './helpers/managed-test-context';

test('recipient API authenticates, validates input and rejects inaccessible mailbox scopes', async ({ request, browser }) => {
  test.setTimeout(60_000);
  const anonymous = await request.post('/api/email/recipients', {
    data: { mode: 'find', accountId: 'recipient-qa-missing', query: 'Anna' },
  });
  expect(anonymous.status()).toBe(401);
  expect((await anonymous.json()).success).toBe(false);

  const context = await createAuthenticatedContext(browser);
  try {
    const invalid = await context.request.post('/api/email/recipients', {
      data: { mode: 'find', accountId: 'recipient-qa-missing', query: 'A' },
    });
    expect(invalid.status()).toBe(400);
    expect(invalid.headers()['cache-control']).toContain('no-store');
    expect((await invalid.json()).code).toBe('INVALID_RECIPIENT_QUERY');

    const spoofed = await context.request.post('/api/email/recipients', {
      data: { mode: 'find', accountId: 'recipient-qa-missing', query: 'Anna', actorUserId: 'other-user', purpose: 'agent' },
    });
    expect(spoofed.status()).toBe(403);
    expect((await spoofed.json()).code).toBe('MAILBOX_ACCESS_UNAVAILABLE');

    for (const mailboxWorkspaceId of [null, 'recipient-qa-inaccessible-workspace']) {
      const denied = await context.request.post('/api/email/recipients', {
        data: { mode: 'find', accountId: 'recipient-qa-missing', mailboxWorkspaceId, query: 'Anna' },
      });
      expect(denied.status()).toBe(403);
      expect(denied.headers()['cache-control']).toContain('no-store');
      const result = await denied.json();
      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.code).toBe('MAILBOX_ACCESS_UNAVAILABLE');
    }
  } finally {
    await context.close();
  }
});
