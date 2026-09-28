import { expect, test } from '@playwright/test';
import { parse as parseEnv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';

const envFile = process.env.CANVAS_ENV_FILE || '.env.local';
const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile)) : {};
const testEmail = fileEnv.TEST_LOGIN_EMAIL || fileEnv.BOOTSTRAP_ADMIN_EMAIL
  || process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
const testPassword = fileEnv.TEST_LOGIN_PASSWORD || fileEnv.BOOTSTRAP_ADMIN_PASSWORD
  || process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;

test('inline subagent cards keep separate task IDs across reload and parent compaction', async ({ page }) => {
  expect(testEmail).toBeTruthy();
  expect(testPassword).toBeTruthy();
  const signIn = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: String(test.info().project.use.baseURL || 'http://localhost:3000') },
    data: { email: testEmail, password: testPassword },
  });
  expect(signIn.ok()).toBeTruthy();
  const created = await page.request.post('/api/sessions', {
    data: { agentId: 'bradley', title: 'Inline subagent cards UI test' },
  });
  expect(created.ok()).toBeTruthy();
  const sourceSessionId = (await created.json() as { session?: { sessionId?: string } }).session?.sessionId;
  expect(sourceSessionId).toBeTruthy();

  const now = Date.now();
  await page.route(`**/api/sessions/${sourceSessionId}/bootstrap?**`, async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as { messages: { messages: unknown[] } };
    payload.messages.messages = [
      { id: 1, sequence: 1, role: 'assistant', content: [
        { type: 'toolCall', id: 'call-one', name: 'delegate_task', arguments: { goal: 'Same goal' } },
        { type: 'toolCall', id: 'call-two', name: 'delegate_task', arguments: { goal: 'Same goal' } },
      ], provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: now },
      ...(['one', 'two'] as const).map((id, index) => ({
        id: index + 2, sequence: index + 2, role: 'toolResult', toolCallId: `call-${id}`,
        toolName: 'delegate_task', content: [{ type: 'text', text: 'Delegated task accepted.' }],
        details: { status: 'accepted', delegation_id: `inline-${id}` }, timestamp: now + index + 1,
      })),
      { id: 4, sequence: 4, role: 'compact-break', kind: 'automatic',
        attemptId: 'parent-compaction', omittedMessageCount: 3, timestamp: now + 3 },
    ];
    await route.fulfill({ response, json: payload });
  });
  await page.route('**/api/delegations**', async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/^\/api\/delegations\/(inline-one|inline-two)(?:\/(progress))?$/u);
    if (!match) return route.continue();
    const id = match[1];
    const status = id === 'inline-one' ? 'completed' : 'running';
    if (match[2] === 'progress') {
      return route.fulfill({ json: { success: true, delegation: {
        id, status, displayStatus: status, revision: 3,
      }, events: [{ revision: 3, kind: 'tool_end', preview: id === 'inline-one' ? 'read_file' : 'web_search' }],
      transcript: [] } });
    }
    return route.fulfill({ json: { success: true, delegation: {
      id, workerSessionId: `worker-${id}`, workerType: 'managed', targetAgentId: 'research-agent',
      goal: 'Same goal', status, resultText: id === 'inline-one' ? 'First result' : null,
      errorText: null, createdAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString(),
      completedAt: id === 'inline-one' ? new Date(now).toISOString() : null,
    } } });
  });

  try {
    await page.goto(`/notebook?chat=open&session=${encodeURIComponent(sourceSessionId!)}`);
    const cards = page.getByTestId('chat-inline-delegation');
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator('[data-delegation-id="inline-one"]')).toContainText('First result');
    await expect(page.locator('[data-delegation-id="inline-two"]')).toContainText('web_search');
    await page.reload();
    await expect(cards).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator('[data-delegation-id="inline-one"]')).toContainText('First result');
    await expect(page.locator('[data-delegation-id="inline-two"]')).toContainText('web_search');
  } finally {
    await page.request.delete(`/api/sessions?sessionId=${encodeURIComponent(sourceSessionId!)}`).catch(() => undefined);
  }
});
