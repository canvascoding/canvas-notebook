import { test, expect, type Page } from '@playwright/test';

const TEST_EMAIL = 'admin.com';
const TEST_PASSWORD = 'change-me';
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/');
}

test.describe('PI Chat E2E', () => {
  test.setTimeout(90000);

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('should bootstrap a session, show the session id, and derive a history title', async ({ page }) => {
    await page.goto('/chat');

    const prompt = `Session title smoke ${Date.now()} should become the visible history title after the first streamed reply finishes.`;
    const input = page.getByTestId('chat-input');

    await input.fill(prompt);
    await input.press('Enter');

    const sessionIdBadge = page.getByTestId('chat-session-id');
    await expect(sessionIdBadge).toBeVisible({ timeout: 15000 });
    await expect(sessionIdBadge).not.toContainText('Main Agent');
    await expect.poll(async () => sessionIdBadge.getAttribute('title'), { timeout: 15000 }).toMatch(/^sess-/);

    const fullSessionId = await sessionIdBadge.getAttribute('title');
    expect(fullSessionId).toMatch(/^sess-/);

    let currentSession: { sessionId?: string; title?: string } | null = null;
    await expect.poll(async () => {
      currentSession = await page.evaluate(async (sessionId) => {
        const response = await fetch('/api/sessions');
        const payload = await response.json();
        if (!payload?.success || !Array.isArray(payload.sessions)) {
          return null;
        }

        return payload.sessions.find((session: { sessionId?: string }) => session.sessionId === sessionId) || null;
      }, fullSessionId);

      return currentSession?.title || null;
    }, { timeout: 60000 }).not.toBe('New session');

    expect(currentSession).toBeTruthy();
    expect(currentSession?.title?.startsWith(prompt.slice(0, 20))).toBeTruthy();
    expect((currentSession?.title || '').length).toBeLessThanOrEqual(48);

    await page.locator('button').filter({ has: page.locator('.lucide-history') }).first().click();
    await expect(page.getByText('Sessions', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /session title smoke/i }).first()).toBeVisible();
  });

  test('should keep structured PI context for a second turn', async ({ page }) => {
    await page.goto('/chat');

    const input = page.getByTestId('chat-input');
    const assistantMessages = page.getByTestId('chat-message-assistant');
    const marker = 'RESUME_MARKER_ALPHA';

    await input.fill(`Merke dir exakt dieses Token: ${marker}. Antworte nur mit OK.`);
    await input.press('Enter');

    await expect(assistantMessages).toHaveCount(1, { timeout: 60000 });
    await expect.poll(async () => {
      const text = await assistantMessages.first().textContent();
      return (text || '').replace(/\s+/g, ' ').trim();
    }, { timeout: 60000 }).toContain('OK');

    await input.fill('Gib exakt das Token aus, das ich dir gerade gegeben habe, und nichts anderes.');
    await input.press('Enter');

    await expect(assistantMessages).toHaveCount(2, { timeout: 60000 });
    await expect.poll(async () => {
      const text = await assistantMessages.last().textContent();
      return (text || '').replace(/\s+/g, ' ').trim();
    }, { timeout: 60000 }).toContain(marker);
  });

  test('should render markdown and tool output separately in the chat UI', async ({ page }) => {
    await page.route('**/api/stream', async (route) => {
      const body = [
        JSON.stringify({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: '   Here is **bold** output\n\n- first item\n- second item',
          },
        }),
        JSON.stringify({
          type: 'tool_execution_start',
          toolCallId: 'tool-call-1',
          toolName: 'ls',
          args: {
            path: '.',
          },
        }),
        JSON.stringify({
          type: 'tool_execution_end',
          toolCallId: 'tool-call-1',
          toolName: 'ls',
          result: {
            content: [{ type: 'text', text: 'alpha.md\\nbeta.ts' }],
          },
        }),
        JSON.stringify({
          type: 'agent_end',
          messages: [
            {
              role: 'user',
              content: 'Show markdown and tool output.',
              timestamp: Date.now(),
            },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Here is **bold** output\n\n- first item\n- second item' }],
              api: 'mock',
              provider: 'mock',
              model: 'mock-model',
              usage: EMPTY_USAGE,
              stopReason: 'stop',
              timestamp: Date.now(),
            },
            {
              role: 'toolResult',
              content: [{ type: 'text', text: 'alpha.md\\nbeta.ts' }],
              timestamp: Date.now(),
            },
          ],
        }),
      ].join('\n') + '\n';

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body,
      });
    });

    await page.goto('/chat');
    const input = page.getByTestId('chat-input');
    await input.fill('Render markdown and tools.');
    await input.press('Enter');

    const assistantMessage = page.getByTestId('chat-message-assistant').first();
    await expect(assistantMessage.locator('strong')).toHaveText('bold');
    await expect(assistantMessage.locator('li')).toHaveCount(2);
    await expect(assistantMessage.locator('p').first()).toHaveText(/Here is bold output/);

    const toolMessage = page.getByTestId('chat-message-toolResult').first();
    await expect(toolMessage).toContainText('ls');
    await expect(toolMessage).toContainText('alpha.md');
    await expect(toolMessage).toContainText('beta.ts');
    await expect(toolMessage).not.toContainText('Assistant');
  });
});
