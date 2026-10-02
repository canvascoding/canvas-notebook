import { expect, test } from '@playwright/test';
import { parse as parseEnv } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { authenticateManagedTestPage } from './helpers/managed-test-context';

const envFile = process.env.CANVAS_ENV_FILE || '.env.local';
const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile)) : {};
const testEmail = fileEnv.TEST_LOGIN_EMAIL || fileEnv.BOOTSTRAP_ADMIN_EMAIL
  || process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
const testPassword = fileEnv.TEST_LOGIN_PASSWORD || fileEnv.BOOTSTRAP_ADMIN_PASSWORD
  || process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;

test('worker progress, transcript and steering stay bound to the selected delegation after reload', async ({ page }) => {
  expect(testEmail).toBeTruthy();
  expect(testPassword).toBeTruthy();
  await authenticateManagedTestPage(page, { email: testEmail, password: testPassword });
  const created = await page.request.post('/api/sessions', {
    data: { agentId: 'bradley', title: 'Subagent live inspection UI test' },
  });
  expect(created.ok()).toBeTruthy();
  const sourceSessionId = (await created.json() as { session?: { sessionId?: string } }).session?.sessionId;
  expect(sourceSessionId).toBeTruthy();

  const now = new Date().toISOString();
  const task = (id: string, workerSessionId: string) => ({
    id, sourceSessionId, sourceAgentId: 'bradley', workerSessionId,
    targetAgentId: 'research-agent', workerType: 'managed', goal: 'Check the same goal', workerRole: null,
    toolsets: ['web'], status: 'running', resultStatus: null, resultText: null, errorText: null,
    deliveryStatus: 'pending', deliveryErrorText: null, attemptCount: 1, progressRevision: 3,
    cancelRequestedAt: null, startedAt: now, completedAt: null, deliveredAt: null, createdAt: now, updatedAt: now,
  });
  const tasks = [task('delegation-one', 'worker-one'), task('delegation-two', 'worker-two')];
  const sent: Array<{ id: string; body: Record<string, unknown> }> = [];
  await page.route('**/api/delegations**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const match = url.pathname.match(/^\/api\/delegations\/([^/]+)\/(progress|steering)$/u);
    if (match?.[2] === 'progress') {
      const id = decodeURIComponent(match[1]);
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        success: true,
        delegation: { id, workerSessionId: id === 'delegation-one' ? 'worker-one' : 'worker-two',
          status: 'running', displayStatus: 'running', leaseState: 'active', revision: 3 },
        events: [{ revision: 3, kind: 'tool_end', preview: `step for ${id}`, createdAt: now }], transcript: [],
      }) });
    } else if (match?.[2] === 'steering') {
      const id = decodeURIComponent(match[1]);
      if (request.method() === 'POST') {
        sent.push({ id, body: request.postDataJSON() as Record<string, unknown> });
      }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        success: true, receipt: { id: 'receipt-one', delegationId: id,
          status: request.method() === 'POST' ? 'accepted' : 'delivered',
          createdAt: now, deliveredAt: request.method() === 'POST' ? null : now, missedAt: null },
      }) });
    } else if (request.method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, delegations: tasks }) });
    } else {
      await route.continue();
    }
  });
  await page.route('**/api/sessions/messages?**', async (route) => {
    const url = new URL(route.request().url());
    const workerSessionId = url.searchParams.get('sessionId');
    if (!workerSessionId?.startsWith('worker-')) return route.continue();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      success: true,
      messages: [{ id: workerSessionId === 'worker-one' ? 1 : 2, sequence: 1, role: 'assistant',
        content: [{ type: 'text', text: `Transcript for ${workerSessionId}` }], createdAt: now }],
      hasMoreBefore: false, oldestSequence: 1, oldestMessageId: 1,
    }) });
  });

  try {
    await page.goto(`/notebook?chat=open&session=${encodeURIComponent(sourceSessionId!)}`);
    await expect(page.getByTestId('chat-delegation-item')).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId('delegation-progress-delegation-one')).toContainText('step for delegation-one');
    await expect(page.getByTestId('delegation-progress-delegation-two')).toContainText('step for delegation-two');

    await page.getByTestId('delegation-open-delegation-two').click();
    await expect(page.getByTestId('delegation-detail')).toBeVisible();
    await expect(page.getByTestId('chat-delegation-transcript')).toContainText('Transcript for worker-two');
    await expect(page.getByTestId('chat-delegation-transcript')).not.toContainText('worker-one');
    await page.getByTestId('delegation-steer-input-delegation-two').fill('Inspect the second case');
    await page.getByTestId('delegation-steer-delegation-two').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].id).toBe('delegation-two');
    expect(sent[0].body.sourceSessionId).toBe(sourceSessionId);
    expect(sent[0].body.message).toBe('Inspect the second case');

    await page.reload();
    await expect(page.getByTestId('delegation-open-delegation-one')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('delegation-open-delegation-one').click();
    await expect(page.getByTestId('chat-delegation-transcript')).toContainText('Transcript for worker-one');
  } finally {
    await page.request.delete(`/api/sessions?sessionId=${encodeURIComponent(sourceSessionId!)}`).catch(() => undefined);
  }
});
