import { expect, test } from '@playwright/test';
import { parse as parseEnv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';

const envFile = process.env.CANVAS_ENV_FILE || '.env.local';
const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile)) : {};

const testEmail = fileEnv.TEST_LOGIN_EMAIL || fileEnv.BOOTSTRAP_ADMIN_EMAIL
  || process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
const testPassword = fileEnv.TEST_LOGIN_PASSWORD || fileEnv.BOOTSTRAP_ADMIN_PASSWORD
  || process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;

test('a completed managed worker can be selected for a follow-up in the chat', async ({ page }) => {
  expect(testEmail).toBeTruthy();
  expect(testPassword).toBeTruthy();

  const signIn = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: String(test.info().project.use.baseURL || 'http://localhost:3000') },
    data: { email: testEmail, password: testPassword },
  });
  expect(signIn.ok()).toBeTruthy();

  const created = await page.request.post('/api/sessions', {
    data: { agentId: 'bradley', title: 'Subagent session reuse UI test' },
  });
  expect(created.ok()).toBeTruthy();
  const createdPayload = await created.json() as { session?: { sessionId?: string } };
  const sourceSessionId = createdPayload.session?.sessionId;
  expect(sourceSessionId).toBeTruthy();

  const now = new Date().toISOString();
  const task = (id: string, workerSessionId: string, targetAgentId: string, status: 'completed' | 'running') => ({
    id, sourceSessionId, sourceAgentId: 'bradley', workerSessionId, targetAgentId,
    workerType: 'managed', goal: `Prior task ${id}`, workerRole: null,
    toolsets: ['web'], status, resultStatus: status === 'completed' ? 'ok' : null,
    resultText: null, errorText: null, deliveryStatus: 'delivered', deliveryErrorText: null,
    attemptCount: 1, cancelRequestedAt: null, startedAt: now,
    completedAt: status === 'completed' ? now : null, deliveredAt: now, createdAt: now, updatedAt: now,
  });
  const tasks = [
    task('eligible', 'worker-reusable', 'research-agent', 'completed'),
    task('old-active', 'worker-busy', 'research-agent', 'completed'),
    task('active', 'worker-busy', 'research-agent', 'running'),
    task('other-agent', 'worker-other-agent', 'editor-agent', 'completed'),
  ];
  let posted: Record<string, unknown> | null = null;
  const submitted = (): Record<string, unknown> | null => posted;
  await page.route('**/api/delegations**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      posted = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    } else if (url.searchParams.get('options') === 'true') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        success: true,
        agents: [
          { agentId: 'research-agent', name: 'Research', iconId: null },
          { agentId: 'editor-agent', name: 'Editor', iconId: null },
        ],
        toolsets: [{ name: 'web', label: 'Web', description: 'Web access' }],
      }) });
    } else {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, delegations: tasks }) });
    }
  });

  try {
    await page.goto(`/notebook?chat=open&session=${encodeURIComponent(sourceSessionId!)}`);
    await expect(page.getByTestId('chat-delegation-panel')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('chat-delegation-start').click();
    const sessionSelect = page.getByLabel(/Agenten-Session|Agent session/i);
    await expect(sessionSelect).toBeVisible();
    await expect(sessionSelect.locator('option')).toHaveCount(2);
    await expect(sessionSelect.locator('option[value="worker-reusable"]')).toHaveCount(1);
    await expect(sessionSelect.locator('option[value="worker-busy"]')).toHaveCount(0);
    await sessionSelect.selectOption('worker-reusable');
    await page.getByLabel(/^Aufgabe$|^Task$/i).fill('Continue the saved work');
    await page.getByRole('button', { name: /start|starte/i }).last().click();
    await expect.poll(() => submitted()?.sessionId).toBe('worker-reusable');
    expect(submitted()?.sourceSessionId).toBe(sourceSessionId);
    expect(submitted()?.targetAgentId).toBe('research-agent');
  } finally {
    await page.request.delete(`/api/sessions?sessionId=${encodeURIComponent(sourceSessionId!)}`).catch(() => undefined);
  }
});
