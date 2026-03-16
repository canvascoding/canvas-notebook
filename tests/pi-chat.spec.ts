import { test, expect, type Browser, type Page } from '@playwright/test';

const TEST_EMAIL = 'admin.com';
const TEST_PASSWORD = 'change-me';
const AUTH_STATE_PATH = 'test-results/pi-chat-auth.json';
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
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    await login(page);
    await context.storageState({ path: AUTH_STATE_PATH });
    await context.close();
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

        return payload.sessions.find((session: { sessionId?: string; title?: string }) => session.sessionId === sessionId) || null;
      }, fullSessionId);

      return currentSession?.title || null;
    }, { timeout: 60000 }).not.toBe('New session');

    const resolvedSession = currentSession as { sessionId?: string; title?: string } | null;
    expect(resolvedSession).toBeTruthy();
    expect(resolvedSession?.title?.startsWith(prompt.slice(0, 20))).toBeTruthy();
    expect((resolvedSession?.title || '').length).toBeLessThanOrEqual(48);

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

    const messageOrder = await page.locator('[data-testid^="chat-message-"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid')),
    );
    expect(messageOrder.indexOf('chat-message-toolResult')).toBeLessThan(messageOrder.indexOf('chat-message-assistant'));
  });

  test('should render compact usage footer for assistant responses', async ({ page }) => {
    await page.route('**/api/stream', async (route) => {
      const body = [
        JSON.stringify({
          type: 'message_update',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Usage enabled answer.' }],
            api: 'mock',
            provider: 'mock',
            model: 'mock-model',
            usage: {
              input: 123,
              output: 456,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 579,
              cost: {
                input: 0.001,
                output: 0.0113,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.0123,
              },
            },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
          assistantMessageEvent: {
            type: 'text_delta',
            delta: 'Usage enabled answer.',
          },
        }),
        JSON.stringify({
          type: 'agent_end',
          messages: [
            {
              role: 'user',
              content: 'Show usage',
              timestamp: Date.now(),
            },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Usage enabled answer.' }],
              api: 'mock',
              provider: 'mock',
              model: 'mock-model',
              usage: {
                input: 123,
                output: 456,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 579,
                cost: {
                  input: 0.001,
                  output: 0.0113,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0.0123,
                },
              },
              stopReason: 'stop',
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
    await input.fill('Render usage footer.');
    await input.press('Enter');

    const assistantMessage = page.getByTestId('chat-message-assistant').filter({ hasText: 'Usage enabled answer.' }).last();
    await expect(assistantMessage).toBeVisible();

    const usageFooter = assistantMessage.getByTestId('chat-usage-footer');
    await expect(usageFooter).toBeVisible();
    await expect(usageFooter).toContainText('579 tok · $0.0123');
    await expect(usageFooter).toContainText('123 in / 456 out');
  });

  test('should render the usage analytics page and apply provider filters', async ({ page }) => {
    await page.route('**/api/usage/summary**', async (route) => {
      const url = new URL(route.request().url());
      const provider = url.searchParams.get('provider');
      const payload = provider === 'openai'
        ? {
            success: true,
            filters: {
              from: '2026-03-01T00:00:00.000Z',
              to: '2026-03-30T23:59:59.999Z',
              provider: 'openai',
              model: null,
              sessionId: null,
              sessionQuery: null,
              stopReason: null,
              groupBy: 'provider',
              userId: null,
            },
            totals: {
              totalCost: 1.2345,
              totalTokens: 1500,
              inputTokens: 900,
              outputTokens: 600,
              cacheTokens: 0,
              sessionCount: 3,
              eventCount: 4,
            },
            rows: [
              {
                groupKey: 'openai',
                label: 'openai',
                totalCost: 1.2345,
                totalTokens: 1500,
                inputTokens: 900,
                outputTokens: 600,
                cacheTokens: 0,
                sessionCount: 3,
                eventCount: 4,
              },
            ],
          }
        : {
            success: true,
            filters: {
              from: '2026-03-01T00:00:00.000Z',
              to: '2026-03-30T23:59:59.999Z',
              provider: null,
              model: null,
              sessionId: null,
              sessionQuery: null,
              stopReason: null,
              groupBy: 'day',
              userId: null,
            },
            totals: {
              totalCost: 2.468,
              totalTokens: 2200,
              inputTokens: 1300,
              outputTokens: 900,
              cacheTokens: 0,
              sessionCount: 5,
              eventCount: 6,
            },
            rows: [
              {
                groupKey: '2026-03-16',
                label: '2026-03-16',
                totalCost: 2.468,
                totalTokens: 2200,
                inputTokens: 1300,
                outputTokens: 900,
                cacheTokens: 0,
                sessionCount: 5,
                eventCount: 6,
              },
            ],
          };

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });

    await page.route('**/api/usage/events**', async (route) => {
      const url = new URL(route.request().url());
      const provider = url.searchParams.get('provider');
      const payload = provider === 'openai'
        ? {
            success: true,
            filters: {
              from: '2026-03-01T00:00:00.000Z',
              to: '2026-03-30T23:59:59.999Z',
              provider: 'openai',
              model: null,
              sessionId: null,
              sessionQuery: null,
              stopReason: null,
              groupBy: 'provider',
              userId: null,
            },
            page: 1,
            pageSize: 50,
            totalRows: 1,
            rows: [
              {
                id: 1,
                userId: 'user-main',
                userLabel: 'Main User',
                sessionId: 'sess-openai',
                sessionTitleSnapshot: 'OpenAI Session',
                provider: 'openai',
                model: 'gpt-4o',
                stopReason: 'stop',
                assistantTimestamp: '2026-03-16T10:00:00.000Z',
                totalTokens: 1500,
                inputTokens: 900,
                outputTokens: 600,
                cacheTokens: 0,
                totalCost: 1.2345,
              },
            ],
          }
        : {
            success: true,
            filters: {
              from: '2026-03-01T00:00:00.000Z',
              to: '2026-03-30T23:59:59.999Z',
              provider: null,
              model: null,
              sessionId: null,
              sessionQuery: null,
              stopReason: null,
              groupBy: 'day',
              userId: null,
            },
            page: 1,
            pageSize: 50,
            totalRows: 1,
            rows: [
              {
                id: 1,
                userId: 'user-main',
                userLabel: 'Main User',
                sessionId: 'sess-1',
                sessionTitleSnapshot: 'Daily Session',
                provider: 'anthropic',
                model: 'claude-sonnet-4',
                stopReason: 'toolUse',
                assistantTimestamp: '2026-03-16T10:00:00.000Z',
                totalTokens: 2200,
                inputTokens: 1300,
                outputTokens: 900,
                cacheTokens: 0,
                totalCost: 2.468,
              },
            ],
          };

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });

    await page.goto('/usage');
    await expect(page.getByTestId('usage-page')).toBeVisible();
    await expect(page.getByText('Usage Analytics')).toBeVisible();
    await expect(page.getByTestId('usage-summary-table')).toContainText('2026-03-16');

    await page.getByPlaceholder('openai, anthropic, ollama').fill('openai');
    await page.getByRole('button', { name: /apply filters/i }).click();

    await expect(page.getByTestId('usage-summary-table')).toContainText('openai');
    await expect(page.getByTestId('usage-event-row')).toContainText('OpenAI Session');
    await expect(page.getByText('$1.2345').first()).toBeVisible();
  });

  test('should save managed prompt files in settings and keep chat working', async ({ page }) => {
    await page.goto('/settings?tab=agent-settings');

    const editor = page.getByTestId('agent-managed-file-editor');
    const saveButton = page.getByTestId('agent-managed-file-save');
    const marker = `PLAYWRIGHT_PROMPT_MARKER_${Date.now()}`;
    const existingValue = await editor.inputValue();

    await editor.fill(`${existingValue.trim()}\n\n- UI marker: ${marker}\n`);
    await saveButton.click();

    await expect(page.getByText('AGENTS.md gespeichert.')).toBeVisible({ timeout: 15000 });

    await page.reload();
    await expect(page.getByTestId('agent-managed-file-editor')).toHaveValue(new RegExp(marker));

    await page.getByRole('button', { name: /doctor ausführen/i }).click();
    await expect(page.getByText('Prompt files included:')).toContainText('AGENTS.md', { timeout: 15000 });
    await expect(page.getByText('Prompt fallback:')).toContainText('Inactive', { timeout: 15000 });

    await page.goto('/chat');

    const input = page.getByTestId('chat-input');
    await input.fill('Antworte nur mit READY.');
    await input.press('Enter');

    const assistantMessages = page.getByTestId('chat-message-assistant');
    await expect(assistantMessages).toHaveCount(1, { timeout: 60000 });
    await expect
      .poll(async () => ((await assistantMessages.first().textContent()) || '').replace(/\s+/g, ' ').trim(), {
        timeout: 60000,
      })
      .toContain('READY');
  });
});
