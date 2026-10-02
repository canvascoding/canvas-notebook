import { test, expect, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';
import { authenticateManagedTestPage } from './helpers/managed-test-context';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';

async function login(page: Page) {
  await page.route('**/api/agent-runtime/effective**', async (route) => {
    const selection = {
      providerInstallationId: 'test-openai',
      providerId: 'openai',
      modelId: 'gpt-4o',
      thinkingLevel: 'off',
    };
    const resolvedSelection = {
      selection,
      catalogRevision: 1,
      policyRevision: 1,
      selectionSource: 'app_default',
      credentialScope: 'system',
    };
    const resolution = {
      context: {
        organizationId: 'test-organization',
        userId: 'test-user',
        workspaceId: new URL(route.request().url()).searchParams.get('workspaceId') || 'test-workspace',
        workspaceType: 'personal',
        agentId: 'canvas-agent',
      },
      catalogRevision: 1,
      policyRevision: 1,
      providers: [{
        installationId: 'test-openai',
        providerId: 'openai',
        name: 'OpenAI',
        source: 'built-in',
        credentialScope: 'system',
        credentialAvailable: true,
        selectable: true,
        status: 'ready',
        models: [{
          id: 'gpt-4o',
          name: 'GPT-4o',
          enabled: true,
          isProviderDefault: true,
          reasoning: false,
          supportsVision: true,
          thinkingLevels: ['off'],
          metadata: {},
          revision: 1,
        }],
      }],
      inheritedSelection: resolvedSelection,
      preference: null,
      effectiveSelection: resolvedSelection,
      source: 'app_default',
      valid: true,
      issues: [],
    };
    await route.fulfill({ json: { success: true, data: resolution, resolution } });
  });
  await authenticateManagedTestPage(page, { email: TEST_EMAIL, password: TEST_PASSWORD });
}

async function mockSessionBootstrap(page: Page, sessionId: string, title: string, createdAt: string) {
  await page.route(`**/api/sessions/${sessionId}/bootstrap?*`, async (route) => {
    const workspaceId = new URL(route.request().url()).searchParams.get('workspaceId');
    await route.fulfill({ json: {
      success: true,
      session: {
        id: 1, sessionId, title, agentId: 'bradley', model: 'gpt-4o', provider: 'openai',
        engine: 'pi', createdAt, lastMessageAt: createdAt, lastViewedAt: createdAt,
        hasUnread: false, creator: null,
        workspace: workspaceId ? { workspaceId, workspaceType: 'personal', workspaceName: 'Personal Workspace' } : null,
      },
      messages: { success: true, messages: [], hasMoreBefore: false },
    } });
  });
}

test('shows a completion toast fallback and unread badge for another session', async ({ page }) => {
  await login(page);

  const createdAt = '2026-04-18T09:00:00.000Z';
  const currentSessionId = 'sess-current';
  const backgroundSessionId = 'sess-background';

  await page.route('**/api/sessions**', async (route) => {
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

  await mockSessionBootstrap(page, currentSessionId, 'Current session', createdAt);
  await page.goto(`/notebook?chat=open&session=${encodeURIComponent(currentSessionId)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chat-session-id')).toContainText('Current session');
  await page.getByTestId('chat-history-toggle').click();
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

  await page.route('**/api/sessions**', async (route) => {
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

  await mockSessionBootstrap(page, currentSessionId, 'Current session', createdAt);

  await page.goto(`/notebook?chat=open&session=${encodeURIComponent(currentSessionId)}`, { waitUntil: 'domcontentloaded' });
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

function chatNotificationSummary(sessionId: string, unread = true) {
  const item = {
    id: `chat:${sessionId}`,
    type: 'chat.response',
    title: 'Agent response',
    detail: 'Done',
    occurredAt: '2026-04-18T10:00:00.000Z',
    unread,
    priority: 'normal',
    workspaceId: 'test-workspace',
    workspaceName: 'Test workspace',
    target: { kind: 'chat', sessionId },
  };
  const items = unread ? [item] : [];
  const count = items.length;
  return {
    success: true,
    data: {
      unreadCount: count,
      counts: {
        unread: count,
        chat: count,
        todos: 0,
        todoUnread: 0,
        todoAttention: 0,
        emailAttention: 0,
        studio: 0,
        automation: 0,
        memoryApprovals: 0,
      },
      items,
      sections: { notifications: items, todos: [], todoUnread: [], todoAttention: [], emailAttention: [] },
    },
  };
}

test('hides the visible chat notification while mark-as-read PATCH and summary GET are delayed', async ({ page }) => {
  await login(page);

  const sessionId = 'sess-visible-race';
  const createdAt = '2026-04-18T09:00:00.000Z';
  let beginDelayedRequests = false;
  let releasePatch!: () => void;
  let releaseSummary!: () => void;
  let markReadStarted!: () => void;
  let summaryStarted!: () => void;
  let sawActiveChatFilter = false;
  const patchStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
  const summaryGetStarted = new Promise<void>((resolve) => { summaryStarted = resolve; });
  const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
  const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });

  await page.route('**/api/sessions**', async (route) => {
    if (route.request().method() === 'PATCH') {
      const payload = route.request().postDataJSON() as { markAsRead?: boolean } | undefined;
      if (payload?.markAsRead && beginDelayedRequests) {
        markReadStarted();
        await patchGate;
      }
      await route.fulfill({ json: { success: true } });
      return;
    }
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { success: true, sessions: [{
        id: 1, sessionId, title: 'Visible session', model: 'gpt-4o', engine: 'pi',
        createdAt, lastMessageAt: createdAt, lastViewedAt: createdAt, hasUnread: false, creator: null,
      }] } });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/notifications/summary**', async (route) => {
    sawActiveChatFilter ||= new URL(route.request().url()).searchParams.get('activeChatSessionId') === sessionId;
    if (beginDelayedRequests) {
      summaryStarted();
      await summaryGate;
    }
    await route.fulfill({ json: chatNotificationSummary(sessionId) });
  });

  await mockSessionBootstrap(page, sessionId, 'Visible session', createdAt);

  await page.goto(`/notebook?chat=open&session=${encodeURIComponent(sessionId)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chat-session-id')).toContainText('Visible session');
  await page.getByTestId('notification-bell').click();
  await page.evaluate(() => new Promise<void>((resolve) => window.setTimeout(resolve, 150)));
  await expect(page.locator('[data-notification-id="chat:sess-visible-race"]')).toHaveCount(0);
  await expect(page.getByTestId('notification-bell')).toHaveAttribute('aria-label', /0 unread/);
  expect(sawActiveChatFilter).toBe(true);

  beginDelayedRequests = true;
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('session_updated', { detail }));
  }, { sessionId, lastMessageAt: '2026-04-18T10:00:00.000Z', title: 'Visible session' });
  await patchStarted;
  await summaryGetStarted;

  // Both requests are unresolved, but the visible chat must already be excluded locally.
  await expect(page.locator('[data-notification-id="chat:sess-visible-race"]')).toHaveCount(0);
  await expect(page.getByTestId('notification-bell')).toHaveAttribute('aria-label', /0 unread/);
  releasePatch();
  releaseSummary();
  await page.evaluate(() => new Promise<void>((resolve) => window.setTimeout(resolve, 150)));
  await expect(page.locator('[data-notification-id="chat:sess-visible-race"]')).toHaveCount(0);
});

test('does not let an older notification summary GET overwrite a newer response', async ({ page }) => {
  await login(page);

  const sessionId = 'sess-background-race';
  let summaryRequestCount = 0;
  let releaseOlderResponse!: () => void;
  let olderRequestStarted!: () => void;
  const olderResponseGate = new Promise<void>((resolve) => { releaseOlderResponse = resolve; });
  const olderStarted = new Promise<void>((resolve) => { olderRequestStarted = resolve; });

  await page.route('**/api/notifications/summary**', async (route) => {
    summaryRequestCount += 1;
    if (summaryRequestCount === 2) {
      olderRequestStarted();
      await olderResponseGate;
      await route.fulfill({ json: chatNotificationSummary(sessionId) });
      return;
    }
    await route.fulfill({ json: chatNotificationSummary(sessionId, false) });
  });

  await page.goto('/notebook?chat=open', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => summaryRequestCount).toBeGreaterThanOrEqual(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('notification_summary_updated')));
  await olderStarted;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('notification_summary_updated')));
  await expect.poll(() => summaryRequestCount).toBeGreaterThanOrEqual(3);
  await page.getByTestId('notification-bell').click();
  await expect(page.locator('[data-notification-id="chat:sess-background-race"]')).toHaveCount(0);

  releaseOlderResponse();
  await page.evaluate(() => new Promise<void>((resolve) => window.setTimeout(resolve, 150)));
  await expect(page.locator('[data-notification-id="chat:sess-background-race"]')).toHaveCount(0);
});
