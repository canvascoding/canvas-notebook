import { expect, test, type Page, type TestInfo, type WebSocketRoute } from '@playwright/test';

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
const SESSION_ID = 'chat-widget-scroll-regression';
const TOOL_CALL_ID = 'chat-widget-scroll-tool-call';
const JOB_ID = 'job-00000000-0000-4000-8000-000000000042';
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

function runtimeStatus(sessionId: string) {
  return {
    sessionId,
    revision: 0,
    phase: 'idle',
    activeTool: null,
    pendingToolCalls: 0,
    followUpQueue: [],
    steeringQueue: [],
    canAbort: false,
    contextWindow: 128000,
    estimatedHistoryTokens: 0,
    availableHistoryTokens: 100000,
    contextUsagePercent: 0,
    includedSummary: false,
    omittedMessageCount: 0,
    summaryUpdatedAt: null,
    lastCompactionAt: null,
    lastCompactionKind: null,
    lastCompactionOmittedCount: 0,
    compactionStatus: {
      state: 'idle',
      attemptId: null,
      trigger: null,
      reasonCode: null,
      retryAfter: null,
      omittedMessageCount: 0,
    },
  };
}

function textMessage(id: number, role: 'user' | 'assistant', text: string) {
  if (role === 'user') {
    return {
      id,
      role,
      content: text,
      timestamp: 1_800_000_000_000 + id,
    };
  }

  return {
    id,
    role,
    content: [{ type: 'text', text }],
    api: 'mock',
    provider: 'mock',
    model: 'mock-model',
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: 1_800_000_000_000 + id,
  };
}

function fixtureMessages(laterMessagePairs: number) {
  const messages: Array<Record<string, unknown>> = [];
  let id = 1;
  const paragraph = 'A deliberately tall chat message used to create a realistic scroll surface. '.repeat(8);

  for (let index = 0; index < 5; index += 1) {
    messages.push(textMessage(id++, 'user', `Earlier request ${index + 1}. ${paragraph}`));
    messages.push(textMessage(id++, 'assistant', `Earlier response ${index + 1}. ${paragraph}`));
  }

  messages.push({
    ...textMessage(id++, 'assistant', 'I created the automation.'),
    content: [
      { type: 'text', text: 'I created the automation.' },
      {
        type: 'toolCall',
        id: TOOL_CALL_ID,
        name: 'automation_manage',
        arguments: {
          action: 'call',
          operation: 'create_automation_job',
          arguments: {},
        },
      },
    ],
  });
  messages.push({
    id: id++,
    role: 'toolResult',
    toolName: 'automation_manage',
    toolCallId: TOOL_CALL_ID,
    content: [{ type: 'text', text: 'Automation created.' }],
    details: {
      action: 'call',
      operation: 'create_automation_job',
      job: { id: JOB_ID, name: 'Widget scroll regression fixture' },
      toolApp: {
        kind: 'builtin',
        version: 1,
        resourceUri: 'ui://canvas/automation-job/v1',
        entityId: JOB_ID,
        toolCallId: TOOL_CALL_ID,
        operation: 'create_automation_job',
      },
    },
    timestamp: 1_800_000_000_000 + id,
  });

  for (let index = 0; index < laterMessagePairs; index += 1) {
    messages.push(textMessage(id++, 'user', `Later request ${index + 1}. ${paragraph}`));
    messages.push(textMessage(id++, 'assistant', `Later response ${index + 1}. ${paragraph}`));
  }

  return messages;
}

async function installFixtures(page: Page, laterMessagePairs: number, sessionId: string) {
  await page.route('**/api/agent-runtime/effective**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          context: {
            organizationId: null,
            userId: 'widget-scroll-user',
            workspaceId: 'widget-scroll-workspace',
            workspaceType: 'personal',
            agentId: 'bradley',
          },
          catalogRevision: 1,
          policyRevision: 1,
          providers: [],
          inheritedSelection: null,
          preference: null,
          effectiveSelection: null,
          source: 'app_default',
          valid: true,
          issues: [],
        },
      }),
    });
  });

  await page.route('**/api/sessions**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/sessions/messages') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          messages: fixtureMessages(laterMessagePairs),
          hasMoreBefore: false,
          oldestTimestamp: null,
          oldestMessageId: null,
          oldestSequence: null,
        }),
      });
      return;
    }

    if (url.pathname === '/api/sessions') {
      const createdAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          sessions: [{
            id: 1,
            sessionId,
            title: 'Widget scroll regression',
            agentId: 'bradley',
            model: 'mock-model',
            provider: 'mock',
            thinkingLevel: null,
            createdAt,
            engine: 'pi',
            lastMessageAt: createdAt,
            lastViewedAt: createdAt,
            hasUnread: false,
            creator: null,
          }],
        }),
      });
      return;
    }

    await route.continue();
  });

  await page.route('**/api/chat/tool-apps', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, code: 'TEST_RENDER_DELAY' }),
    });
  });

  await page.routeWebSocket('**/ws/chat', (webSocket: WebSocketRoute) => {
    webSocket.send(JSON.stringify({ type: 'auth_success', userId: 'widget-scroll-user' }));
    webSocket.onMessage((rawMessage) => {
      const message = JSON.parse(typeof rawMessage === 'string' ? rawMessage : rawMessage.toString());
      if (message.type === 'subscribe_session') {
        webSocket.send(JSON.stringify({
          type: 'subscribe_result',
          requestId: message.requestId,
          success: true,
          sessionId,
        }));
      }
      if (message.type === 'get_status') {
        webSocket.send(JSON.stringify({
          type: 'status_result',
          requestId: message.requestId,
          success: true,
          status: runtimeStatus(sessionId),
        }));
      }
    });
  });
}

async function login(page: Page) {
  expect(TEST_EMAIL, 'BOOTSTRAP_ADMIN_EMAIL or TEST_LOGIN_EMAIL is required').toBeTruthy();
  expect(TEST_PASSWORD, 'BOOTSTRAP_ADMIN_PASSWORD or TEST_LOGIN_PASSWORD is required').toBeTruthy();
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: process.env.BASE_URL || 'http://localhost:3000' },
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, laterMessagePairs: 3 },
  { name: 'mobile', width: 390, height: 844, laterMessagePairs: 3 },
] as const;

async function runWidgetScrollRegression(
  page: Page,
  testInfo: TestInfo,
  viewport: (typeof VIEWPORTS)[number],
) {
  const sessionId = `${SESSION_ID}-${viewport.name}`;
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await login(page);
  await installFixtures(page, viewport.laterMessagePairs, sessionId);
  await page.goto('/de/notebook?chat=open');
  await page.getByTestId('chat-open-latest-session').click();

  const scrollRegion = page.getByTestId('chat-scroll-region');
  const slot = page.getByTestId('tool-app-slot');
  await expect(slot).toHaveCount(1);
  await expect.poll(() => scrollRegion.evaluate((element) => element.scrollHeight)).toBeGreaterThan(2_000);
  await page.waitForTimeout(400);

  const scrollBox = await scrollRegion.boundingBox();
  expect(scrollBox).not.toBeNull();
  await page.mouse.move(scrollBox!.x + scrollBox!.width / 2, scrollBox!.y + Math.min(100, scrollBox!.height / 3));
  await page.mouse.wheel(0, -45);
  await page.waitForTimeout(50);
  await expect(slot.locator('[data-testid="canvas-tool-app-widget"]')).toHaveCount(0);

  await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('[data-testid="chat-scroll-region"]');
    const toolSlot = document.querySelector<HTMLElement>('[data-testid="tool-app-slot"]');
    if (!scroll || !toolSlot) throw new Error('Chat scroll fixture is incomplete.');
    const scrollRect = scroll.getBoundingClientRect();
    const slotRect = toolSlot.getBoundingClientRect();
    const targetTop = scrollRect.top - 480 - slotRect.height - 80;
    scroll.scrollTop += slotRect.top - targetTop;
  });
  await page.waitForTimeout(900);
  await expect(slot.locator('[data-testid="canvas-tool-app-widget"]')).toHaveCount(0);

  const initialHeight = await slot.evaluate((element) => element.getBoundingClientRect().height);
  await page.evaluate(() => {
    type TraceWindow = Window & typeof globalThis & {
      __chatWidgetSamples?: Array<{ t: number; height: number; scrollHeight: number }>;
      __chatWidgetSampling?: boolean;
    };
    const traceWindow = window as TraceWindow;
    const scroll = document.querySelector<HTMLElement>('[data-testid="chat-scroll-region"]');
    const toolSlot = document.querySelector<HTMLElement>('[data-testid="tool-app-slot"]');
    if (!scroll || !toolSlot) throw new Error('Chat scroll fixture is incomplete.');
    traceWindow.__chatWidgetSamples = [];
    traceWindow.__chatWidgetSampling = true;
    const startedAt = performance.now();
    const sample = () => {
      traceWindow.__chatWidgetSamples?.push({
        t: performance.now() - startedAt,
        height: toolSlot.getBoundingClientRect().height,
        scrollHeight: scroll.scrollHeight,
      });
      if (traceWindow.__chatWidgetSampling && performance.now() - startedAt < 2_200) {
        requestAnimationFrame(sample);
      }
    };
    requestAnimationFrame(sample);
  });

  const activationSamples: Array<{ scrollTop: number; slotTop: number; slotBottom: number }> = [];
  for (let step = 0; step < 18; step += 1) {
    await page.mouse.wheel(0, -45);
    await page.waitForTimeout(35);
    activationSamples.push(await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('[data-testid="chat-scroll-region"]');
      const toolSlot = document.querySelector<HTMLElement>('[data-testid="tool-app-slot"]');
      if (!scroll || !toolSlot) throw new Error('Chat scroll fixture is incomplete.');
      const slotRect = toolSlot.getBoundingClientRect();
      return { scrollTop: scroll.scrollTop, slotTop: slotRect.top, slotBottom: slotRect.bottom };
    }));
    if (await slot.locator('[data-testid="canvas-tool-app-widget"]').count()) break;
  }
  await expect(slot.locator('[data-testid="canvas-tool-app-widget"]'), JSON.stringify(activationSamples, null, 2)).toHaveCount(1);
  test.fail(true, 'Known regression: the slot height feeds back into its own reserved height while loading.');
  await page.waitForTimeout(2_200);

  const samples = await page.evaluate(() => {
    type TraceWindow = Window & typeof globalThis & {
      __chatWidgetSamples?: Array<{ t: number; height: number; scrollHeight: number }>;
      __chatWidgetSampling?: boolean;
    };
    const traceWindow = window as TraceWindow;
    traceWindow.__chatWidgetSampling = false;
    return traceWindow.__chatWidgetSamples || [];
  });
  const heights = samples.map((sample) => sample.height);
  const scrollHeights = samples.map((sample) => sample.scrollHeight);
  const metrics = {
    initialHeight,
    minHeight: Math.min(...heights),
    maxHeight: Math.max(...heights),
    minScrollHeight: Math.min(...scrollHeights),
    maxScrollHeight: Math.max(...scrollHeights),
    samples,
  };
  await testInfo.attach('chat-widget-scroll-metrics.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  await page.screenshot({
    path: testInfo.outputPath('chat-widget-scroll.png'),
    animations: 'disabled',
  });

  expect(metrics.maxHeight - initialHeight, JSON.stringify(metrics, null, 2)).toBeLessThanOrEqual(1);
  expect(metrics.maxScrollHeight - metrics.minScrollHeight, JSON.stringify(metrics, null, 2)).toBeLessThanOrEqual(1);
}

for (const viewport of VIEWPORTS) {
  test(`keeps the chat viewport stable while a built-in widget starts (${viewport.name})`, async ({ page }, testInfo) => {
    await runWidgetScrollRegression(page, testInfo, viewport);
  });
}
