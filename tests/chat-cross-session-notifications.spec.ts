import { test, expect, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

async function login(page: Page) {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: {
      Origin: process.env.BASE_URL || 'http://localhost:3000',
    },
    data: {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    },
  });

  expect(response.ok()).toBeTruthy();
}

test('shows a completion toast fallback and unread badge for another session', async ({ page }) => {
  await login(page);

  const createdAt = '2026-04-18T09:00:00.000Z';
  const currentSessionId = 'sess-current';
  const backgroundSessionId = 'sess-background';

  await page.route('**/api/agents/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          piConfig: {
            activeProvider: 'openai',
            providers: {
              openai: { model: 'gpt-4o' },
            },
          },
          discovery: {
            openai: {
              models: [{ id: 'gpt-4o', name: 'GPT-4o', supportsVision: true }],
            },
          },
        },
      }),
    });
  });

  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        sessions: [
          {
            id: 1,
            sessionId: currentSessionId,
            title: 'Current session',
            model: 'gpt-4o',
            engine: 'pi',
            createdAt,
            lastMessageAt: createdAt,
            lastViewedAt: createdAt,
            hasUnread: false,
            creator: null,
          },
          {
            id: 2,
            sessionId: backgroundSessionId,
            title: 'Background session',
            model: 'gpt-4o',
            engine: 'pi',
            createdAt,
            lastMessageAt: null,
            lastViewedAt: null,
            hasUnread: false,
            creator: null,
          },
        ],
      }),
    });
  });

  await page.goto('/chat', { waitUntil: 'networkidle' });
  await page.getByTestId('chat-history-toggle').click();
  await expect(page.getByText('Background session')).toBeVisible();
  await expect(page.getByTestId('chat-history-unread-indicator')).toHaveCount(0);

  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('session_updated', { detail }));
  }, {
    sessionId: backgroundSessionId,
    lastMessageAt: '2026-04-18T10:00:00.000Z',
    title: 'Background session',
  });

  await expect(page.getByTestId('chat-history-unread-indicator')).toHaveCount(1);
  await expect(page.locator('[data-sonner-toast]')).toContainText('Background session');
});

test('suppresses toast and unread when the finished response belongs to the visible active session', async ({ page }) => {
  await login(page);

  const createdAt = '2026-04-18T09:00:00.000Z';
  const currentSessionId = 'sess-current';
  let markAsReadCalls = 0;

  await page.route('**/api/agents/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          piConfig: {
            activeProvider: 'openai',
            providers: {
              openai: { model: 'gpt-4o' },
            },
          },
          discovery: {
            openai: {
              models: [{ id: 'gpt-4o', name: 'GPT-4o', supportsVision: true }],
            },
          },
        },
      }),
    });
  });

  await page.route('**/api/sessions', async (route) => {
    const method = route.request().method();

    if (method === 'PATCH') {
      const payload = route.request().postDataJSON() as { markAsRead?: boolean } | undefined;
      if (payload?.markAsRead) {
        markAsReadCalls += 1;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
      return;
    }

    if (method !== 'GET') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        sessions: [
          {
            id: 1,
            sessionId: currentSessionId,
            title: 'Current session',
            model: 'gpt-4o',
            engine: 'pi',
            createdAt,
            lastMessageAt: createdAt,
            lastViewedAt: createdAt,
            hasUnread: false,
            creator: null,
          },
        ],
      }),
    });
  });

  await page.goto(`/chat?session=${encodeURIComponent(currentSessionId)}`, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('chat-session-id')).toContainText('Current session');
  await page.getByTestId('chat-history-toggle').click();
  await expect(page.getByTestId('chat-history-unread-indicator')).toHaveCount(0);

  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('notification', { detail }));
  }, {
    sessionId: currentSessionId,
    sessionTitle: 'Current session',
    notificationType: 'new_response',
    messagePreview: 'Done',
    lastMessageAt: '2026-04-18T10:00:00.000Z',
  });

  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('session_updated', { detail }));
  }, {
    sessionId: currentSessionId,
    lastMessageAt: '2026-04-18T10:00:00.000Z',
    title: 'Current session',
  });

  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  await expect(page.getByTestId('chat-history-unread-indicator')).toHaveCount(0);
  await expect.poll(() => markAsReadCalls).toBeGreaterThan(0);
});
