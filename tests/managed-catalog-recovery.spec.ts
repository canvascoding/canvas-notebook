import { expect, test } from '@playwright/test';
import { parse as parseEnv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';

const envFile = process.env.CANVAS_ENV_FILE || '.env.local';
const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile)) : {};
const email = fileEnv.BOOTSTRAP_ADMIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = fileEnv.BOOTSTRAP_ADMIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// Transport fixtures exercise the real chat renderer and composer; the matching
// backend tests exercise discovery and the SDK tool chain without UI mocks.
const cases = [
  { name: 'timeout', retry: true, message: 'The Control Plane AI catalog request timed out. Model validation could not be completed. Wait briefly, then send a new message to try again. A catalog sync is not required for a temporary connection failure.' },
  { name: 'credentials', retry: false, message: 'The Control Plane rejected the instance credentials (HTTP 401). Ask an administrator to check the instance connection before trying again.' },
  { name: 'model changed', retry: false, message: 'The selected managed model changed or was removed. Sync and review the app model catalog before trying again.' },
];

for (const scenario of cases) {
  test(`managed catalog ${scenario.name} shows the appropriate recovery instructions`, async ({ page }) => {
    test.setTimeout(90_000);
    expect(email).toBeTruthy(); expect(password).toBeTruthy();
    const baseURL = String(test.info().project.use.baseURL || 'http://localhost:3000');
    const signIn = await page.request.post('/api/auth/sign-in/email', {
      headers: { Origin: baseURL }, data: { email, password },
    });
    expect(signIn.ok()).toBeTruthy();
    const created = await page.request.post('/api/sessions', {
      data: { agentId: 'bradley', title: `Managed catalog ${scenario.name} UI fixture` },
    });
    expect(created.ok()).toBeTruthy();
    const sessionId = (await created.json() as { session: { sessionId: string } }).session.sessionId;
    let sends = 0;
    const now = Date.now();
    const failed = { role: 'assistant', api: 'openai-completions', provider: 'canvas-control-plane',
      model: 'fixture-model', content: [], usage, stopReason: 'error', errorMessage: scenario.message, timestamp: now };
    const status = { sessionId, revision: 1, phase: 'idle', activeTool: null, pendingToolCalls: 0,
      followUpQueue: [], steeringQueue: [], canAbort: false, contextWindow: 128000,
      estimatedHistoryTokens: 0, availableHistoryTokens: 100000, contextUsagePercent: 0,
      includedSummary: false, omittedMessageCount: 0, summaryUpdatedAt: null,
      lastCompactionAt: null, lastCompactionKind: null, lastCompactionOmittedCount: 0,
      compactionStatus: { state: 'idle', attemptId: null, trigger: null, reasonCode: null,
        retryAfter: null, omittedMessageCount: 0 } };

    await page.route(`**/api/sessions/${sessionId}/bootstrap?**`, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.messages.messages = [{ ...failed, id: 1, sequence: 1 }];
      await route.fulfill({ response, json: payload });
    });
    await page.routeWebSocket('**/ws/chat', (ws) => {
      ws.send(JSON.stringify({ type: 'auth_success', userId: 'fixture-user' }));
      ws.onMessage((raw) => {
        const message = JSON.parse(raw.toString());
        const requestId = message.requestId;
        if (message.type === 'subscribe_session') {
          ws.send(JSON.stringify({ type: 'subscribe_result', requestId, success: true, sessionId }));
        } else if (message.type === 'get_status') {
          ws.send(JSON.stringify({ type: 'status_result', requestId, success: true, status }));
        } else if (message.type === 'send_message') {
          sends += 1;
          ws.send(JSON.stringify({ type: 'send_message_result', requestId, success: true,
            status: { ...status, revision: 2, phase: 'streaming', canAbort: true } }));
          const recovered = { ...failed, stopReason: 'stop', errorMessage: undefined,
            content: [{ type: 'text', text: 'Connection restored. Continuing with the completed tool result.' }], timestamp: now + 2 };
          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'agent_event', sessionId,
              event: { type: 'agent_end', messages: [failed, message.message, recovered] } }));
            ws.send(JSON.stringify({ type: 'agent_event', sessionId,
              event: { type: 'runtime_status', status: { ...status, revision: 3 } } }));
          }, 100);
        }
      });
    });

    try {
      await page.goto(`/notebook?chat=open&session=${encodeURIComponent(sessionId)}`);
      const error = page.getByTestId('chat-message-assistant').filter({ hasText: scenario.message });
      await expect(error).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('chat-input')).toBeVisible();
      await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 30_000 });
      await expect(page.getByTestId('chat-provider-selector')).toBeEnabled({ timeout: 30_000 });
      expect(sends, 'an error must not replay the prompt automatically').toBe(0);
      await page.screenshot({ path: test.info().outputPath(`${scenario.name}-desktop.png`) });
      if (scenario.retry) {
        await page.getByTestId('chat-input').fill('Continue with the completed result.');
        await page.getByTestId('chat-input').press('Enter');
        await expect(page.getByTestId('chat-message-assistant').filter({
          hasText: 'Connection restored. Continuing with the completed tool result.',
        })).toBeVisible();
        expect(sends, 'one explicit user message produces one request without a catalog sync').toBe(1);
      }
      await page.setViewportSize({ width: 768, height: 850 });
      await expect(page.getByTestId('chat-input')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      const bounds = await page.getByTestId('chat-input').boundingBox();
      expect(bounds).toBeTruthy();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(850);
      await page.screenshot({ path: test.info().outputPath(`${scenario.name}-narrow.png`) });
    } finally {
      await page.request.delete(`/api/sessions?sessionId=${encodeURIComponent(sessionId)}`);
    }
  });
}
