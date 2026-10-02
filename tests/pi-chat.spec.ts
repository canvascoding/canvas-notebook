import { test, expect, request, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import type { PiRuntimeStatus } from '@/app/lib/pi/live-runtime';
import type { AISession } from '@/app/lib/chat/types';
import type { AgentProfile } from '@/app/lib/agents/registry';
import { MAIN_AGENT_ID } from '@/app/lib/agents/main-agent';
import dotenv from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { authenticateManagedTestPage } from './helpers/managed-test-context';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const TEST_EMAIL = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@example.com';
const TEST_PASSWORD = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD || 'change-me';
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

function createMockRuntimeStatus(sessionId: string, overrides: Partial<PiRuntimeStatus> = {}): PiRuntimeStatus {
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
    ...overrides,
    compactionStatus: overrides.compactionStatus ?? {
      state: 'idle',
      attemptId: null,
      trigger: null,
      reasonCode: null,
      retryAfter: null,
      omittedMessageCount: 0,
    },
  };
}

async function mockEffectiveAgentRuntime(page: Page) {
  await page.route('**/api/agent-runtime/effective**', async (route) => {
    const url = new URL(route.request().url());
    const agentId = url.searchParams.get('agentId') || 'canvas-agent';
    const isResearchAgent = agentId === 'research-agent';
    const providerId = isResearchAgent ? 'anthropic' : 'openai';
    const modelId = isResearchAgent ? 'claude-sonnet-4.5' : 'gpt-4o';
    const thinkingLevel = isResearchAgent ? 'medium' : 'off';
    const installationId = `test-${providerId}`;
    const models = (isResearchAgent
      ? [
          { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' },
          { id: 'claude-opus-4.1', name: 'Claude Opus 4.1' },
        ]
      : [{ id: 'gpt-4o', name: 'GPT-4o' }]
    ).map((model, index) => ({
      ...model,
      enabled: true,
      isProviderDefault: index === 0,
      reasoning: isResearchAgent,
      supportsVision: !isResearchAgent,
      thinkingLevels: isResearchAgent ? ['off', 'medium', 'high'] : ['off'],
      metadata: {},
      revision: 1,
    }));
    const selection = {
      providerInstallationId: installationId,
      providerId,
      modelId,
      thinkingLevel,
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
        workspaceId: url.searchParams.get('workspaceId') || 'test-workspace',
        workspaceType: 'personal',
        agentId,
      },
      catalogRevision: 1,
      policyRevision: 1,
      providers: [{
        installationId,
        providerId,
        name: isResearchAgent ? 'Anthropic' : 'OpenAI',
        source: 'built-in',
        credentialScope: 'system',
        credentialAvailable: true,
        selectable: true,
        status: 'ready',
        models,
      }],
      inheritedSelection: resolvedSelection,
      preference: null,
      effectiveSelection: resolvedSelection,
      source: 'app_default',
      valid: true,
      issues: [],
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: resolution, resolution }),
    });
  });
}

async function login(page: Page) {
  await mockEffectiveAgentRuntime(page);
  await authenticateManagedTestPage(page, { email: TEST_EMAIL, password: TEST_PASSWORD });
  await page.goto('/notebook?chat=open', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/notebook\?chat=open$/, { timeout: 15000 });
}

async function startFreshChat(page: Page) {
  await page.getByRole('button', { name: /new chat/i }).click();
  await expect(page.getByTestId('chat-session-id')).toHaveCount(0);
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await expect(page.getByTestId('chat-provider-selector')).toBeEnabled({ timeout: 15_000 });
}

async function startLiveMainAgentChat(page: Page) {
  const agentsResponse = await page.request.get('/api/agents', { timeout: 15_000 });
  expect(agentsResponse.ok()).toBe(true);
  const agentsPayload = await agentsResponse.json() as { success?: boolean; data?: { agents?: AgentProfile[] } };
  expect(agentsPayload.success).toBe(true);
  const mainAgent = agentsPayload.data?.agents?.find((agent) => agent.agentId === MAIN_AGENT_ID && agent.type === 'main');
  expect(mainAgent, 'The real main agent must be available to the authenticated test user.').toBeDefined();
  const effectiveResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/agent-runtime/effective'
      && url.searchParams.get('agentId') === MAIN_AGENT_ID;
  }, { timeout: 15_000 });
  void effectiveResponse.catch(() => undefined);
  await page.goto('/notebook?chat=open');
  await page.getByTestId('chat-agent-id').click();
  const mainOption = page.getByRole('button').filter({ has: page.getByText(MAIN_AGENT_ID, { exact: true }) });
  await mainOption.click();
  await expect(page.getByTestId('chat-agent-id')).toHaveAttribute('aria-label', `Select agent: ${mainAgent!.name}`);
  const response = await effectiveResponse;
  expect(response.ok()).toBe(true);
  const payload = await response.json() as { success?: boolean; data?: { valid?: boolean }; resolution?: { valid?: boolean } };
  expect(payload.success).toBe(true);
  expect((payload.resolution ?? payload.data)?.valid, 'The live test must use an actual valid runtime resolution.').toBe(true);
  await startFreshChat(page);
  await expect(page.getByTestId('chat-agent-id')).toHaveAttribute('aria-label', `Select agent: ${mainAgent!.name}`);
}

async function mockEmptyDelegations(page: Page, sessionId: string) {
  await page.route((url) => url.pathname === '/api/delegations' && url.searchParams.get('sourceSessionId') === sessionId, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: { success: true, delegations: [] } });
  });
}

async function mockEmptyChatBootstrap(page: Page, options: {
  sessionId?: string; title?: string; agentId?: string;
  persisted?: boolean; messages?: Record<string, unknown>[];
} = {}) {
  const mockSessionId = options.sessionId || `sess-mock-${Date.now()}`;
  const mockTitle = options.title || 'New session';
  const createdAt = new Date().toISOString();
  const initialSession: AISession = {
    id: 1, sessionId: mockSessionId, title: mockTitle, agentId: options.agentId || 'canvas-agent',
    model: 'gpt-4o', provider: 'openai', engine: 'pi', createdAt,
    lastMessageAt: createdAt, lastViewedAt: createdAt, hasUnread: false,
  };
  let mockSession: AISession | null = options.persisted ? { ...initialSession } : null;
  const history = () => ({ success: true, engine: 'pi', messages: options.messages || [], hasMoreBefore: false });
  await mockEmptyDelegations(page, mockSessionId);

  await page.route('**/api/sessions**', async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const isList = url.pathname === '/api/sessions';
    const isBootstrap = url.pathname === `/api/sessions/${mockSessionId}/bootstrap`;
    const isMessages = url.pathname === '/api/sessions/messages' && url.searchParams.get('sessionId') === mockSessionId;
    if (!isList && !isBootstrap && !isMessages) return route.fallback();
    const workspaceId = url.searchParams.get('workspaceId');
    if (mockSession && workspaceId) {
      if (mockSession.workspace) expect(mockSession.workspace.workspaceId).toBe(workspaceId);
      else mockSession = { ...mockSession, workspace: {
        workspaceId, workspaceType: 'personal', workspaceName: 'Personal Workspace',
      } };
    }

    if (method === 'POST' && isList) {
      let payload: { agentId?: string; model?: string; thinkingLevel?: AISession['thinkingLevel']; title?: string; workspace?: AISession['workspace']; workspaceId?: string } = {};
      try {
        payload = request.postDataJSON() as typeof payload;
      } catch {
        payload = {};
      }
      mockSession = {
        id: 1,
        sessionId: mockSessionId,
        title: payload.title || mockTitle,
        agentId: payload.agentId || 'canvas-agent',
        model: payload.model || 'gpt-4o',
        provider: 'openai',
        thinkingLevel: payload.thinkingLevel || null,
        createdAt,
        engine: 'pi',
        lastMessageAt: createdAt,
        lastViewedAt: createdAt,
        hasUnread: false,
        workspace: payload.workspace || (payload.workspaceId ? {
          workspaceId: payload.workspaceId, workspaceType: 'personal', workspaceName: 'Personal Workspace',
        } : null),
      };

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          session: mockSession,
        }),
      });
      return;
    }

    if (method === 'PATCH' && isList) {
      let payload: { title?: string; sessionId?: string } = {};
      try {
        payload = request.postDataJSON() as typeof payload;
      } catch {
        payload = {};
      }
      if (payload.sessionId && payload.sessionId !== mockSessionId) return route.fallback();

      if (mockSession && payload.title) {
        mockSession = {
          ...mockSession,
          title: payload.title,
          lastMessageAt: new Date().toISOString(),
        };
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          session: mockSession,
          sessions: mockSession ? [mockSession] : [],
        }),
      });
      return;
    }

    if (method !== 'GET') {
      await route.fallback();
      return;
    }

    if (isBootstrap) {
      expect(mockSession?.sessionId).toBe(mockSessionId);
      expect(mockSession?.workspace?.workspaceId).toBe(workspaceId);
      expect(workspaceId).toBeTruthy();
      await route.fulfill({ json: { success: true, session: mockSession, messages: history() } });
      return;
    }
    if (isMessages) {
      await route.fulfill({ json: history() });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        sessions: mockSession ? [mockSession] : [],
      }),
    });
  });

  return {
    updateTitle(title: string) {
      if (!mockSession) {
        return;
      }

      mockSession = {
        ...mockSession,
        title,
        titleGenerationState: 'generated',
        lastMessageAt: new Date().toISOString(),
      };
    },
  };
}

async function getChatInputMetrics(page: Page) {
  return page.getByTestId('chat-input').evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    const style = window.getComputedStyle(textarea);
    return {
      height: textarea.getBoundingClientRect().height,
      clientHeight: textarea.clientHeight,
      scrollHeight: textarea.scrollHeight,
      styleHeight: Number.parseFloat(textarea.style.height || '0'),
      overflowY: style.overflowY,
    };
  });
}

type AgentEventPayload = Record<string, unknown>;
type MockControlResult = Record<string, unknown> | {
  status: Record<string, unknown>;
  agentEvents?: AgentEventPayload[];
};

interface MockWsConfig {
  sessionId: string;
  onSubscribe?: () => void;
  onSendMessage?: (message: Record<string, unknown>, context: Record<string, unknown> | undefined, requestId: string) => void;
  onSendResultStatus?: (message: Record<string, unknown>, context: Record<string, unknown> | undefined, requestId: string) => Record<string, unknown>;
  onGetStatus?: (requestId: string) => Record<string, unknown> | null;
  onControl?: (
    action: string,
    message: Record<string, unknown> | undefined,
    requestId: string,
    queueItemId?: string,
    focusTopic?: string,
  ) => MockControlResult;
  agentEvents?: AgentEventPayload[];
  eventStartDelayMs?: number;
  sendEventsAfterSendMessage?: boolean;
  runtimeStatus?: Record<string, unknown>;
  sessionTitleUpdate?: {
    title: string;
    titleGenerationState?: string;
  };
}

function isMockControlEnvelope(value: MockControlResult): value is { status: Record<string, unknown>; agentEvents?: AgentEventPayload[] } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'status' in value &&
    value.status &&
    typeof value.status === 'object',
  );
}

async function setupMockWebSocket(page: Page, config: MockWsConfig) {
  const {
    sessionId,
    agentEvents = [],
    eventStartDelayMs = 0,
    sendEventsAfterSendMessage = true,
    runtimeStatus,
    onGetStatus,
    onControl,
  } = config;

  let eventQueue: AgentEventPayload[] = [...agentEvents];
  let activeSocket: WebSocketRoute | null = null;
  await mockEmptyDelegations(page, sessionId);

  await page.routeWebSocket('**/ws/chat', (ws: WebSocketRoute) => {
    activeSocket = ws;
    ws.send(JSON.stringify({ type: 'auth_success', userId: 'test-user' }));

    ws.onMessage((rawMessage) => {
      const message = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : JSON.parse(rawMessage.toString());
      const { type, requestId } = message;

      switch (type) {
        case 'subscribe_session': {
          ws.send(JSON.stringify({ type: 'subscribe_result', requestId, success: true, sessionId }));
          config.onSubscribe?.();
          break;
        }

        case 'send_message': {
          ws.send(JSON.stringify({
            type: 'send_message_result',
            requestId,
            success: true,
            status: {
              ...createMockRuntimeStatus(sessionId, { phase: 'streaming', canAbort: true }),
              ...(runtimeStatus ?? {}),
              ...(config.onSendResultStatus?.(message.message, message.context, requestId) ?? {}),
            },
          }));

          config.onSendMessage?.(message.message, message.context, requestId);

          let delay = eventStartDelayMs;
          if (sendEventsAfterSendMessage) {
            for (const event of eventQueue) {
              const currentDelay = delay;
              setTimeout(() => {
                ws.send(JSON.stringify({ type: 'agent_event', sessionId, event }));
              }, currentDelay);
              delay += 50;
            }
            eventQueue = [];
          }

          if (config.sessionTitleUpdate) {
            const currentDelay = delay;
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'session_title_updated',
                sessionId,
                title: config.sessionTitleUpdate?.title,
                titleGenerationState: config.sessionTitleUpdate?.titleGenerationState ?? 'generated',
              }));
            }, currentDelay);
          }
          break;
        }

        case 'get_status': {
          let status: Record<string, unknown> | null = runtimeStatus
            ? { ...createMockRuntimeStatus(sessionId), ...runtimeStatus }
            : createMockRuntimeStatus(sessionId);
          if (onGetStatus) {
            status = onGetStatus(requestId);
          }
          if (status) {
            ws.send(JSON.stringify({ type: 'status_result', requestId, success: true, status }));
          } else {
            ws.send(JSON.stringify({ type: 'status_result', requestId, success: false, error: 'Session not found' }));
          }
          break;
        }

        case 'control': {
          const action = message.action as string;
          let status: Record<string, unknown> = runtimeStatus
            ? { ...createMockRuntimeStatus(sessionId), ...runtimeStatus }
            : createMockRuntimeStatus(sessionId);
          let controlEvents: AgentEventPayload[] = [];
          if (onControl) {
            const result = onControl(
              action,
              message.message,
              requestId,
              message.queueItemId,
              message.focusTopic,
            );
            if (isMockControlEnvelope(result)) {
              status = result.status;
              controlEvents = result.agentEvents ?? [];
            } else {
              status = result;
            }
          }
          ws.send(JSON.stringify({ type: 'control_result', requestId, success: true, status }));
          controlEvents.forEach((event, index) => {
            setTimeout(() => {
              ws.send(JSON.stringify({ type: 'agent_event', sessionId, event }));
            }, 50 + index * 50);
          });
          break;
        }

        case 'unsubscribe_session': {
          break;
        }
      }
    });
  });
  return {
    emitAgentEvent(event: AgentEventPayload) {
      expect(activeSocket, 'The owned mock chat socket must be connected.').not.toBeNull();
      activeSocket!.send(JSON.stringify({ type: 'agent_event', sessionId, event }));
    },
  };
}

function _sendAgentEvents(ws: WebSocketRoute, sessionId: string, events: AgentEventPayload[], delayMs = 50) {
  let delay = 0;
  for (const event of events) {
    const currentDelay = delay;
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'agent_event', sessionId, event }));
    }, currentDelay);
    delay += delayMs;
  }
}

test.describe('PI Chat E2E', () => {
  test.setTimeout(90000);
  test.use({ storageState: AUTH_STATE_PATH });

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    test.setTimeout(120000);
    const context = await browser.newContext({ storageState: undefined });
    try {
      const page = await context.newPage();
      await login(page);
      await mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true, mode: 0o700 });
      await chmod(path.dirname(AUTH_STATE_PATH), 0o700);
      await context.storageState({ path: AUTH_STATE_PATH });
      await chmod(AUTH_STATE_PATH, 0o600);
    } finally {
      await context.close();
    }
  });

  test.beforeEach(async ({ page }, testInfo) => {
    const usesLiveRuntime = testInfo.title === 'should keep structured PI context for a second turn'
      || testInfo.title === 'should send a chat prompt over WebSocket without surfacing an HTTP 401 runtime error';
    if (!usesLiveRuntime) await mockEffectiveAgentRuntime(page);
  });

  test('should render persisted upload references as preview attachments without metadata duplication', async ({ page }) => {
    const sessionId = 'sess-attachment-history';
    const imageId = 'reference---mock.png';
    const documentId = 'briefing---mock.pdf';
    const userText = `Please inspect these uploads.
--- Attachment: reference.png ---
containerFilePath: /data/user-uploads/image/${imageId}
fileId: ${imageId}
mimeType: image/png
category: image
contentKind: image

[Agent-Hinweis: Verwende containerFilePath, wenn du die Datei per Tool lesen, kopieren, verschieben oder im Workspace organisieren sollst.]
--- Ende Attachment: reference.png ---
--- Attachment: briefing.pdf ---
containerFilePath: /data/user-uploads/document/${documentId}
fileId: ${documentId}
mimeType: application/pdf
category: document
contentKind: document

[Agent-Hinweis: Verwende containerFilePath, wenn du die Datei per Tool lesen, kopieren, verschieben oder im Workspace organisieren sollst.]
--- Ende Attachment: briefing.pdf ---`;

    await page.addInitScript(() => {
      window.sessionStorage.clear();
      window.localStorage.removeItem('canvas.chat.sessionMessages.v1');
    });

    await page.route(/\/api\/agents$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { agents: [] } }),
      });
    });

    await mockEmptyChatBootstrap(page, {
      sessionId, title: 'Attachment history', persisted: true,
      messages: [
        {
          id: 1, role: 'user', timestamp: Date.now(),
          content: [
            { type: 'text', text: userText },
            { type: 'image', data: `/api/files/${encodeURIComponent(imageId)}`, mimeType: 'image/png' },
          ],
        },
        {
          id: 2, role: 'assistant', content: [{ type: 'text', text: 'I can see both uploads.' }],
          api: 'mock', provider: 'mock', model: 'mock-model', usage: EMPTY_USAGE,
          stopReason: 'stop', timestamp: Date.now() + 1,
        },
      ],
    });

    await page.route(/\/api\/files\/[^/]+\/preview\?.*$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    });

    await setupMockWebSocket(page, { sessionId, sendEventsAfterSendMessage: false });

    await page.goto(`/notebook?chat=open&session=${encodeURIComponent(sessionId)}`);

    const userMessage = page.getByTestId('chat-message-user').filter({ hasText: 'Please inspect these uploads.' });
    await expect(userMessage).toBeVisible({ timeout: 15000 });
    await expect(userMessage).not.toContainText('containerFilePath');
    await expect(userMessage).not.toContainText('Agent-Hinweis');
    await expect(userMessage.getByTestId('chat-message-attachment')).toHaveCount(2);
    await expect(userMessage.getByTestId('chat-message-attachment').nth(0)).toContainText('reference.png');
    await expect(userMessage.getByTestId('chat-message-attachment').nth(0).locator('img')).toHaveAttribute('src', new RegExp(`/api/files/${imageId}/preview\\?`));
    await expect(userMessage.getByTestId('chat-message-attachment').nth(1)).toContainText('briefing.pdf');
  });

  test('should bootstrap a session, show the session id, and derive a history title', async ({ page }) => {
    const sessionId = `sess-bootstrap-${Date.now()}`;
    const prompt = `Session title smoke ${Date.now()} should become the visible history title after the first streamed reply finishes.`;
    const generatedTitle = prompt.slice(0, 48);

    const sessionBootstrap = await mockEmptyChatBootstrap(page, { sessionId });
    await setupMockWebSocket(page, {
      sessionId,
      onSendMessage: () => {
        sessionBootstrap.updateTitle(generatedTitle);
      },
      sessionTitleUpdate: {
        title: generatedTitle,
        titleGenerationState: 'generated',
      },
      agentEvents: [
        {
          type: 'agent_end',
          messages: [
            {
              role: 'user',
              content: prompt,
              timestamp: Date.now(),
            },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Done.' }],
              api: 'mock',
              provider: 'mock',
              model: 'mock-model',
              usage: EMPTY_USAGE,
              stopReason: 'stop',
              timestamp: Date.now() + 1,
            },
          ],
        },
        {
          type: 'runtime_status',
          status: createMockRuntimeStatus(sessionId, { phase: 'idle' }),
        },
      ],
    });

    await page.goto('/notebook?chat=open');
    await startFreshChat(page);

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
    await expect(page.getByText('Chat History', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /session title smoke/i }).first()).toBeVisible();
  });

  test('should keep structured PI context for a second turn', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await startLiveMainAgentChat(page);

    const input = page.getByTestId('chat-input');
    const assistantMessages = page.getByTestId('chat-message-assistant');
    const marker = `RESUME_MARKER_${randomUUID().replaceAll('-', '')}`;

    await input.fill(`Merke dir exakt dieses Token: ${marker}. Antworte nur mit OK.`);
    const creationResponse = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions'
      && response.request().postDataJSON()?.agentId === MAIN_AGENT_ID);
    await input.press('Enter');
    const response = await creationResponse;
    expect(response.ok()).toBe(true);
    const receipt = await response.json() as { success?: boolean; created?: boolean; session?: AISession };
    expect(receipt.success).toBe(true);
    expect(receipt.created).toBe(true);
    expect(receipt.session?.agentId).toBe(MAIN_AGENT_ID);
    expect(receipt.session?.sessionId).toBeTruthy();
    await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', receipt.session!.sessionId);
    await testInfo.attach('live-pi-session-receipt', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      sessionId: receipt.session!.sessionId, agentId: receipt.session!.agentId,
      workspaceId: receipt.session!.workspace?.workspaceId, created: receipt.created,
    })) });

    await expect(assistantMessages).toHaveCount(1, { timeout: 60000 });
    await expect.poll(async () => {
      const text = await assistantMessages.first().textContent();
      return (text || '').replace(/\s+/g, ' ').trim();
    }, { timeout: 60000 }).toContain('OK');
    await expect(page.getByTestId('chat-send')).toHaveAttribute('data-action', 'send');

    await input.fill('Gib exakt das Token aus, das ich dir gerade gegeben habe, und nichts anderes.');
    await input.press('Enter');

    await expect(assistantMessages).toHaveCount(2, { timeout: 60000 });
    await expect.poll(async () => {
      const text = await assistantMessages.last().textContent();
      return (text || '').replace(/\s+/g, ' ').trim();
    }, { timeout: 60000 }).toContain(marker);
    await expect(page.getByTestId('chat-send')).toHaveAttribute('data-action', 'send');
  });

  test('should send a chat prompt over WebSocket without surfacing an HTTP 401 runtime error', async ({ page }) => {
    let websocket401Count = 0;
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('[WebSocket] Server error:') && text.includes('HTTP 401')) websocket401Count += 1;
    });

    await startLiveMainAgentChat(page);

    const input = page.getByTestId('chat-input');
    await input.fill('Antworte kurz, damit ich den WebSocket-Versand prüfen kann.');
    await input.press('Enter');

    await expect(page.getByTestId('chat-message-user')).toHaveCount(1, { timeout: 15000 });

    await expect.poll(() => websocket401Count, { timeout: 15000 }).toBe(0);

    const assistantMessages = page.getByTestId('chat-message-assistant');
    await expect(assistantMessages.first()).toBeVisible({ timeout: 60000 });
    await expect(assistantMessages.last().locator('p').first()).toContainText(/\S/, { timeout: 60000 });
    await expect(assistantMessages.last().getByTestId('chat-assistant-streaming-indicator')).toHaveCount(0);
    await expect(page.getByTestId('chat-send')).toHaveAttribute('data-action', 'send');
    expect(websocket401Count).toBe(0);
  });

  test('should navigate previous chat inputs with arrow keys', async ({ page }) => {
    const sessionId = 'sess-input-history';

    await setupMockWebSocket(page, {
      sessionId,
      sendEventsAfterSendMessage: false,
      runtimeStatus: createMockRuntimeStatus(sessionId, { phase: 'idle' }),
    });

    await mockEmptyChatBootstrap(page, { sessionId });
    await page.goto('/notebook?chat=open');
    await startFreshChat(page);

    const input = page.getByTestId('chat-input');
    await input.fill('First history message');
    await input.press('Enter');
    await expect(page.getByTestId('chat-message-user')).toHaveCount(1);

    await input.fill('Second history message');
    await input.press('Enter');
    await expect(page.getByTestId('chat-message-user')).toHaveCount(2);

    await input.fill('Draft before history navigation');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('Second history message');

    await input.press('ArrowUp');
    await expect(input).toHaveValue('First history message');

    await input.press('ArrowDown');
    await expect(input).toHaveValue('Second history message');

    await input.press('ArrowDown');
    await expect(input).toHaveValue('Draft before history navigation');

    const multilineDraft = 'Draft line one\nDraft line two\nDraft line three';
    await input.fill(multilineDraft);
    await input.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });

    await input.press('ArrowUp');
    await expect(input).toHaveValue(multilineDraft);
    await expect
      .poll(async () => input.evaluate((element) => (element as HTMLTextAreaElement).selectionStart))
      .toBeLessThan(multilineDraft.length);

    await input.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      textarea.focus();
      textarea.setSelectionRange(0, 0);
    });
    await input.press('ArrowUp');
    await expect(input).toHaveValue('Second history message');

    await input.press('ArrowDown');
    await expect(input).toHaveValue(multilineDraft);
  });

  test('should start a new chat with send_message before runtime status exists', async ({ page }) => {
    const sessionId = 'sess-new-chat-first-send';
    let sendCount = 0;
    const controlActions: string[] = [];

    await setupMockWebSocket(page, {
      sessionId,
      agentEvents: [
        {
          type: 'message_start',
          message: {
            role: 'user',
            content: 'hi',
            timestamp: Date.now() + 30000,
          },
        },
      ],
      onSendMessage: () => {
        sendCount += 1;
      },
      onControl: (action) => {
        controlActions.push(action);
        return createMockRuntimeStatus(sessionId) as unknown as Record<string, unknown>;
      },
    });

    await page.route('**/api/sessions**', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            session: {
              id: 1,
              sessionId,
              title: 'First prompt',
              model: 'gpt-4o',
              provider: 'openai',
              createdAt: new Date().toISOString(),
            },
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, sessions: [] }),
      });
    });

    await page.goto('/notebook?chat=open');
    await startFreshChat(page);

    await page.getByTestId('chat-input').fill('hi');
    await page.getByTestId('chat-send').click();

    await expect.poll(() => sendCount, { timeout: 15000 }).toBe(1);
    expect(controlActions).not.toContain('follow_up');
    await expect(page.getByTestId('chat-message-user').filter({ hasText: 'hi' })).toHaveCount(1);
    await expect(page.getByText('No active agent run to queue a follow-up message.')).toHaveCount(0);
  });

  test('should render markdown and tool output separately in the chat UI', async ({ page }) => {
    const sessionId = 'sess-markdown-tool';

    await setupMockWebSocket(page, {
      sessionId,
      agentEvents: [
        {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            delta: '   Here is **bold** output\n\n- first item\n- second item',
          },
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-call-1',
          toolName: 'ls',
          args: {
            path: '.',
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-call-1',
          toolName: 'ls',
          result: {
            content: [{ type: 'text', text: 'alpha.md\nbeta.ts' }],
          },
        },
        {
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
              content: [{ type: 'text', text: 'alpha.md\nbeta.ts' }],
              timestamp: Date.now(),
            },
          ],
        },
      ],
    });

    await mockEmptyChatBootstrap(page, { sessionId });
    await page.addInitScript(() => window.localStorage.setItem('canvas-tool-verbosity', 'subtle'));
    await page.goto('/notebook?chat=open');
    await startFreshChat(page);
    const input = page.getByTestId('chat-input');
    await input.fill('Render markdown and tools.');
    await input.press('Enter');

    const assistantMessage = page.getByTestId('chat-message-assistant').first();
    await expect(assistantMessage.locator('strong')).toHaveText('bold');
    await expect(assistantMessage.locator('li')).toHaveCount(2);
    await expect(assistantMessage.locator('p').first()).toHaveText(/Here is bold output/);

    await expect(page.getByTestId('chat-message-toolResult')).toHaveCount(0);

    const runDisclosure = page.getByTestId('chat-run-disclosure').first();
    await expect(runDisclosure).toBeVisible();
    await runDisclosure.getByTestId('chat-run-disclosure-toggle').click();
    const runSteps = runDisclosure.getByTestId('chat-run-steps');
    const toolPill = runSteps.getByTestId('chat-tool-subtle').first();
    await expect(toolPill).toBeVisible();
    await toolPill.locator('button').click();
    await expect(page.getByTestId('chat-tool-body')).toContainText('alpha.md');
    await expect(page.getByTestId('chat-tool-body')).toContainText('beta.ts');
    await expect(page.getByText('Input')).toBeVisible();
  });

  test('should present file write tool output as markdown preview and diff', async ({ page }) => {
    const sessionId = 'sess-file-write-output';
    const writeOutput = [
      'Created file: notes/plan.md',
      'Snapshot: 2026-06-19T16-19-03-006Z-6818b8cf',
      'Before SHA-256: new file',
      'After SHA-256: 30a0ff2e8e2918f7cc038f7a8aec9d5354ee730cbf8d6f20cf7166ac7c9acf0e',
      'Size: 6775 bytes',
      'Validation: passed',
      '- OK markdown-tables: Markdown table structure OK (0 tables checked).',
      '',
      'Diff:',
      '```diff',
      '--- /dev/null',
      '+++ notes/plan.md',
      '@@ -0,0 +1,8 @@',
      '+# Fix Plan',
      '+',
      '+- Docker online',
      '+- Host agent offline',
      '+',
      '+| Status | Value |',
      '+| --- | --- |',
      '+| Agent | offline |',
      '```',
    ].join('\n');

    await setupMockWebSocket(page, {
      sessionId,
      agentEvents: [
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-call-write-1',
          toolName: 'write',
          args: {
            path: 'notes/plan.md',
            content: '# Fix Plan\n\n- Docker online\n- Host agent offline',
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-call-write-1',
          toolName: 'write',
          result: {
            content: [{ type: 'text', text: writeOutput }],
          },
        },
        {
          type: 'agent_end',
          messages: [
            {
              role: 'user',
              content: 'Create a markdown plan.',
              timestamp: Date.now(),
            },
            {
              role: 'toolResult',
              content: [{ type: 'text', text: writeOutput }],
              timestamp: Date.now(),
            },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'Created the markdown plan.' }],
              api: 'mock',
              provider: 'mock',
              model: 'mock-model',
              usage: EMPTY_USAGE,
              stopReason: 'stop',
              timestamp: Date.now(),
            },
          ],
        },
      ],
    });

    await mockEmptyChatBootstrap(page, { sessionId });
    await page.addInitScript(() => window.localStorage.setItem('canvas-tool-verbosity', 'subtle'));
    await page.goto('/notebook?chat=open');
    await startFreshChat(page);
    const input = page.getByTestId('chat-input');
    await input.fill('Create a markdown plan.');
    await input.press('Enter');

    const runDisclosure = page.getByTestId('chat-run-disclosure').first();
    await expect(runDisclosure).toBeVisible();
    await runDisclosure.getByTestId('chat-run-disclosure-toggle').click();
    const toolPill = runDisclosure.getByTestId('chat-tool-subtle').first();
    await expect(toolPill).toBeVisible();
    await toolPill.locator('button').click();

    const fileChange = page.getByTestId('tool-file-change');
    await expect(fileChange).toContainText('File created');
    await expect(fileChange).toContainText('notes/plan.md');
    await expect(fileChange).toContainText('Validation passed');
    await expect(page.getByTestId('tool-markdown-preview').locator('h1')).toHaveText('Fix Plan');
    await expect(page.getByTestId('tool-markdown-preview').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('tool-markdown-preview').locator('table')).toContainText('Agent');
    await expect(page.getByTestId('tool-file-diff')).toContainText('+# Fix Plan');
  });

  test('should show studio media tool inputs for image and video generation calls', async ({ page }) => {
    const sessionId = 'sess-studio-media';
    const imageReferencePath = 'public/images/examples/aura_serum_produktfoto.png';
    const videoStartFramePath = 'public/images/examples/tech_banner_future_of_innovation.png';
    const videoEndFramePath = 'public/images/examples/reise_banner_find_your_paradise.png';

    await setupMockWebSocket(page, {
      sessionId,
      agentEvents: [
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-call-image-1',
          toolName: 'studio_generate_image',
          args: {
            count: 1,
            prompt: 'Use the same composition with a colder blue palette.',
            extra_reference_urls: [imageReferencePath],
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-call-image-1',
          toolName: 'studio_generate_image',
          result: {
            content: [
              {
                type: 'text',
                text: 'Studio image generation completed (1 output(s))\n\nOutput 1:\n  File: /data/studio/outputs/generated.png\n  URL:  /api/studio/media/studio/outputs/generated.png\n  ![studio-0](/api/studio/media/studio/outputs/generated.png)\n',
              },
            ],
          },
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-call-video-1',
          toolName: 'studio_generate_video',
          args: {
            prompt: 'Animate a slow camera move from the first frame into the second.',
            start_frame_path: videoStartFramePath,
            end_frame_path: videoEndFramePath,
            resolution: '720p',
            is_looping: true,
          },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-call-video-1',
          toolName: 'studio_generate_video',
          result: {
            content: [
              {
                type: 'text',
                text: 'Studio video generation completed (1 output(s))\n\nOutput:\n  File: /data/studio/outputs/generated.mp4\n  URL:  /api/studio/media/studio/outputs/generated.mp4\n',
              },
            ],
          },
        },
        {
          type: 'agent_end',
          messages: [
            {
              role: 'user',
              content: 'Generate media from workspace assets.',
              timestamp: Date.now(),
            },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'I used the Studio media tools with workspace-relative asset paths.' }],
              api: 'mock',
              provider: 'mock',
              model: 'mock-model',
              usage: EMPTY_USAGE,
              stopReason: 'stop',
              timestamp: Date.now(),
            },
          ],
        },
      ],
    });

    await mockEmptyChatBootstrap(page, { sessionId });
    await page.addInitScript(() => window.localStorage.setItem('canvas-tool-verbosity', 'verbose'));
    await page.goto('/notebook?chat=open');
    await startFreshChat(page);
    const input = page.getByTestId('chat-input');
    await input.fill('Use the Studio media tools with workspace assets.');
    await page.getByTestId('chat-send').click();

    await expect(page.getByTestId('chat-message-toolResult')).toHaveCount(0);
    const runDisclosure = page.getByTestId('chat-run-disclosure').first();
    await expect(runDisclosure).toBeVisible();
    await runDisclosure.getByTestId('chat-run-disclosure-toggle').click();
    const runSteps = runDisclosure.getByTestId('chat-run-steps');
    const toolPills = runSteps.getByTestId('chat-tool-subtle');
    await expect(toolPills).toHaveCount(2);

    await toolPills.nth(0).locator('button').click();
    await expect(page.getByTestId('chat-tool-body').last()).toContainText('extra_reference_urls');
    await expect(page.getByTestId('chat-tool-body').last()).toContainText(imageReferencePath);
    await expect(page.getByTestId('chat-tool-body').last()).toContainText('Use the same composition with a colder blue palette.');

    await toolPills.nth(1).locator('button').click();
    await expect(page.getByTestId('chat-tool-body').last()).toContainText('start_frame_path');
    await expect(page.getByTestId('chat-tool-body').last()).toContainText(videoStartFramePath);
    await expect(page.getByTestId('chat-tool-body').last()).toContainText('end_frame_path');
    await expect(page.getByTestId('chat-tool-body').last()).toContainText(videoEndFramePath);
    await expect(page.getByTestId('chat-tool-body').last()).toContainText('is_looping');
  });

  test('should show read image tool results as small clickable previews grouped by run', async ({ page }) => {
    const sessionId = 'sess-read-image-previews';
    const firstPath = 'tesla-dcf/screenshots/screenshot-a.png';
    const secondPath = 'tesla-dcf/screenshots/screenshot-b.png';
    const firstPreviewUrl = `/api/files/preview?path=${encodeURIComponent(firstPath)}&w=192&preset=mini`;
    const secondPreviewUrl = `/api/files/preview?path=${encodeURIComponent(secondPath)}&w=192&preset=mini`;
    const firstMediaUrl = '/api/media/tesla-dcf/screenshots/screenshot-a.png';
    const secondMediaUrl = '/api/media/tesla-dcf/screenshots/screenshot-b.png';
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );

    await page.route(/\/api\/files\/preview\?.*$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: tinyPng,
      });
    });
    await page.route(/\/api\/media\/tesla-dcf\/screenshots\/screenshot-[ab]\.png$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: tinyPng,
      });
    });

    await setupMockWebSocket(page, {
      sessionId,
      agentEvents: [
        {
          type: 'tool_execution_start',
          toolCallId: 'read-image-a',
          toolName: 'read',
          args: { path: firstPath },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'read-image-a',
          toolName: 'read',
          result: {
            content: [{ type: 'text', text: `Image loaded for visual analysis: ${firstPath}` }],
            details: {
              filePath: firstPath,
              requestedPath: firstPath,
              type: 'image',
              mimeType: 'image/png',
              size: 143264,
              previewUrl: firstPreviewUrl,
              mediaUrl: firstMediaUrl,
            },
          },
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'read-image-b',
          toolName: 'read',
          args: { path: secondPath },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'read-image-b',
          toolName: 'read',
          result: {
            content: [{ type: 'text', text: `Image loaded for visual analysis: ${secondPath}` }],
            details: {
              filePath: secondPath,
              requestedPath: secondPath,
              type: 'image',
              mimeType: 'image/png',
              size: 2048,
              previewUrl: secondPreviewUrl,
              mediaUrl: secondMediaUrl,
            },
          },
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'I inspected both screenshots.' }],
            api: 'mock',
            provider: 'mock',
            model: 'mock-model',
            usage: EMPTY_USAGE,
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        },
        { type: 'agent_end' },
      ],
    });

    await mockEmptyChatBootstrap(page, { sessionId });
    await page.addInitScript(() => window.localStorage.setItem('canvas-tool-verbosity', 'verbose'));
    await page.goto('/notebook?chat=open');
    await startFreshChat(page);
    await page.getByTestId('chat-input').fill('Read both screenshots.');
    await page.getByTestId('chat-send').click();

    const runDisclosure = page.getByTestId('chat-run-disclosure').first();
    await expect(runDisclosure).toBeVisible({ timeout: 15000 });
    await runDisclosure.getByTestId('chat-run-disclosure-toggle').click();

    const toolPills = runDisclosure.getByTestId('chat-tool-subtle');
    await expect(toolPills).toHaveCount(2);
    await expect(toolPills.nth(0)).toContainText('screenshot-a.png');

    await toolPills.nth(0).locator('button').click();
    const toolAttachments = page.getByTestId('chat-tool-attachments').filter({ hasText: 'screenshot-a.png' });
    await expect(toolAttachments).toBeVisible();
    const attachment = toolAttachments.getByTestId('chat-message-attachment').first();
    await expect(attachment).toContainText('screenshot-a.png');
    await expect(attachment.locator('img')).toHaveAttribute('src', new RegExp(`/api/files/preview\\?path=${encodeURIComponent(firstPath)}`));

    await attachment.locator('button').click();
    await expect(page.getByTestId('attachment-preview-full-image')).toBeVisible();
    await expect(page.getByTestId('attachment-preview-full-image')).toHaveAttribute('src', firstMediaUrl);
    await expect(page.getByTestId('attachment-preview-next')).toBeVisible();

    await page.getByTestId('attachment-preview-next').click();
    await expect(page.getByTestId('attachment-preview-full-image')).toHaveAttribute('src', secondMediaUrl);
  });

  test('should render incremental assistant text and the final formatted message', async ({ page }) => {
    const sessionId = 'sess-streaming-placeholder';
    let currentStatus = createMockRuntimeStatus(sessionId);
    const finalMessage = {
      role: 'assistant', content: [{ type: 'text', text: 'Streaming **bold** answer' }],
      api: 'mock', provider: 'mock', model: 'mock-model', usage: EMPTY_USAGE,
      stopReason: 'stop', timestamp: Date.now(),
    };
    const socket = await setupMockWebSocket(page, {
      sessionId,
      onGetStatus: () => currentStatus as unknown as Record<string, unknown>,
      onSendMessage: () => {
        currentStatus = createMockRuntimeStatus(sessionId, { revision: 1, phase: 'streaming', canAbort: true });
      },
      agentEvents: [{ type: 'message_start', message: { ...finalMessage, content: [], stopReason: 'streaming' } }],
    });
    await mockEmptyChatBootstrap(page, { sessionId });
    await page.goto('/notebook?chat=open');
    await startFreshChat(page);
    await page.getByTestId('chat-input').fill('Show streaming state.');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-message-user')).toHaveCount(1, { timeout: 15000 });
    const assistantMessages = page.getByTestId('chat-message-assistant');
    await expect(assistantMessages).toHaveCount(1, { timeout: 15000 });
    const assistantMessage = assistantMessages.first();
    await expect(assistantMessage.getByTestId('chat-assistant-streaming-indicator')).toBeVisible();
    await expect(assistantMessage).not.toContainText('Streaming');
    await expect(assistantMessage.locator('strong')).toHaveCount(0);

    socket.emitAgentEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Streaming **bold' } });
    await expect(assistantMessage).toContainText('Streaming **bold');
    await expect(assistantMessage).not.toContainText('answer');
    await expect(assistantMessage.locator('strong')).toHaveCount(0);
    await expect(assistantMessage.getByTestId('chat-assistant-streaming-indicator')).toHaveCount(0);
    await expect(page.getByTestId('chat-send')).toHaveAttribute('data-action', 'stop');

    currentStatus = createMockRuntimeStatus(sessionId, { revision: 2 });
    socket.emitAgentEvent({ type: 'message_end', message: finalMessage });
    socket.emitAgentEvent({ type: 'agent_end' });
    socket.emitAgentEvent({ type: 'runtime_status', status: currentStatus });
    await expect(assistantMessage).toContainText('Streaming bold answer');
    await expect(assistantMessage.locator('strong')).toHaveText('bold');
    await expect(assistantMessage.getByTestId('chat-assistant-streaming-indicator')).toHaveCount(0);
    await expect(page.getByTestId('chat-send')).toHaveAttribute('data-action', 'send');
  });

  test('should switch the composer to stop immediately on send and back to send when the final message lands', async ({ page }) => {
    const sessionId = 'sess-runtime-badge';
    await setupMockWebSocket(page, {
      sessionId,
      eventStartDelayMs: 400,
      agentEvents: [
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'OK' }],
            api: 'mock',
            provider: 'mock',
            model: 'mock-model',
            usage: EMPTY_USAGE,
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        },
        { type: 'agent_end' },
        { type: 'runtime_status', status: createMockRuntimeStatus(sessionId) },
      ],
    });
    await mockEmptyChatBootstrap(page, { sessionId });
    await page.goto('/notebook?chat=open');
    await startFreshChat(page);

    const input = page.getByTestId('chat-input');
    const sendButton = page.getByTestId('chat-send');
    await expect(sendButton).toHaveAttribute('data-action', 'send');

    await input.fill('Reply with exactly OK.');
    await sendButton.click();

    await expect(sendButton).toHaveAttribute('data-action', 'stop', { timeout: 1000 });
    const assistantMessage = page.getByTestId('chat-message-assistant').first();
    await expect(assistantMessage).toContainText(/\S/, { timeout: 30000 });
    await expect(assistantMessage.getByTestId('chat-assistant-streaming-indicator')).toHaveCount(0, { timeout: 30000 });
    await expect(sendButton).toHaveAttribute('data-action', 'send', { timeout: 5000 });
  });

  test('should keep the current scroll position when streaming continues after the user scrolls up', async ({ page }) => {
    const sessionId = 'sess-scroll';
    let streamCallCount = 0;
    let currentStatus = createMockRuntimeStatus(sessionId);
    const assistantMessagePayload = (text: string) => ({
      role: 'assistant', content: [{ type: 'text', text }],
      api: 'mock', provider: 'mock', model: 'mock-model', usage: EMPTY_USAGE,
      stopReason: 'stop', timestamp: Date.now(),
    });
    const socket = await setupMockWebSocket(page, {
      sessionId, sendEventsAfterSendMessage: false,
      onGetStatus: () => currentStatus as unknown as Record<string, unknown>,
      onSendMessage: () => {
        streamCallCount += 1;
        currentStatus = createMockRuntimeStatus(sessionId, {
          revision: streamCallCount, phase: streamCallCount <= 5 ? 'idle' : 'streaming', canAbort: streamCallCount > 5,
        });
        if (streamCallCount <= 5) {
          const seedText = Array.from({ length: 6 }, (_, index) =>
            `Seed reply ${streamCallCount}, line ${index + 1}: keep the transcript tall before streaming starts.`).join('\n');
          socket.emitAgentEvent({ type: 'message_end', message: assistantMessagePayload(seedText) });
          socket.emitAgentEvent({ type: 'agent_end' });
        } else {
          socket.emitAgentEvent({ type: 'message_start', message: { ...assistantMessagePayload(''), content: [], stopReason: 'streaming' } });
        }
        socket.emitAgentEvent({ type: 'runtime_status', status: currentStatus });
      },
    });
    await mockEmptyChatBootstrap(page, { sessionId });
    await page.goto('/notebook?chat=open');
    await startFreshChat(page);
    const input = page.getByTestId('chat-input');
    const scrollRegion = page.getByTestId('chat-scroll-region');
    const assistantMessages = page.getByTestId('chat-message-assistant');
    for (let index = 0; index < 5; index += 1) {
      await input.fill(`Seed transcript turn ${index + 1}.`);
      await input.press('Enter');
      await expect(assistantMessages).toHaveCount(index + 1, { timeout: 10000 });
      await expect(assistantMessages.nth(index)).toContainText(`Seed reply ${index + 1}, line 1`);
    }
    await expect.poll(() => scrollRegion.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(240);
    await input.fill('Stream a long answer so I can scroll away from the bottom.');
    await input.press('Enter');
    await expect(assistantMessages).toHaveCount(6);
    const assistantMessage = assistantMessages.last();
    await expect(assistantMessage.getByTestId('chat-assistant-streaming-indicator')).toBeVisible();
    await expect(assistantMessage).not.toContainText('Stream line 30');
    const lines = Array.from({ length: 54 }, (_, index) =>
      `Stream line ${index + 1}: keep this answer growing while I inspect older history.`);
    socket.emitAgentEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: lines.slice(0, 3).join('\n') } });
    await expect(assistantMessage).toContainText('Stream line 3');
    await scrollRegion.hover();
    await page.mouse.wheel(0, -520);
    await expect.poll(() => scrollRegion.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThan(120);
    const lockedScrollTop = await scrollRegion.evaluate((element) => element.scrollTop);
    await expect(page.getByTitle('Scroll to bottom')).toBeVisible();

    for (let chunk = 1; chunk < 18; chunk += 1) {
      socket.emitAgentEvent({ type: 'message_update', assistantMessageEvent: {
        type: 'text_delta', delta: '\n' + lines.slice(chunk * 3, (chunk + 1) * 3).join('\n'),
      } });
      await expect(assistantMessage).toContainText(`Stream line ${(chunk + 1) * 3}`);
    }
    await expect(assistantMessage).toContainText('Stream line 30');
    await expect(assistantMessage).toContainText('Stream line 48');
    expect((await assistantMessage.textContent())?.match(/Stream line 1:/g)).toHaveLength(1);
    currentStatus = createMockRuntimeStatus(sessionId, { revision: streamCallCount + 1 });
    socket.emitAgentEvent({ type: 'message_end', message: assistantMessagePayload(lines.join('\n')) });
    socket.emitAgentEvent({ type: 'agent_end' });
    socket.emitAgentEvent({ type: 'runtime_status', status: currentStatus });
    await expect(page.getByTestId('chat-send')).toHaveAttribute('data-action', 'send');
    await expect(assistantMessage.getByTestId('chat-assistant-streaming-indicator')).toHaveCount(0);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const scrollMetricsAfterStreaming = await scrollRegion.evaluate((element) => ({
      scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
    }));
    expect(Math.abs(scrollMetricsAfterStreaming.scrollTop - lockedScrollTop),
      `Scroll metrics: ${JSON.stringify({ lockedScrollTop, ...scrollMetricsAfterStreaming })}`).toBeLessThan(24);
    await expect(page.getByTitle('Scroll to bottom')).toBeVisible();
  });

  test('should render compact usage footer for assistant responses', async ({ page }) => {
    const sessionId = 'sess-usage-footer';

    await setupMockWebSocket(page, {
      sessionId,
      agentEvents: [
        {
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
        },
        {
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
        },
      ],
    });

    await mockEmptyChatBootstrap(page, { sessionId });
    await page.goto('/notebook?chat=open');
    await startFreshChat(page);
    const input = page.getByTestId('chat-input');
    await input.fill('Render usage footer.');
    await input.press('Enter');

    const assistantMessage = page.getByTestId('chat-message-assistant').filter({ hasText: 'Usage enabled answer.' }).last();
    await expect(assistantMessage).toBeVisible();

    await expect(assistantMessage.getByTestId('chat-usage-footer')).toHaveCount(0);
  });

  test('should not render cumulative usage on the final assistant message of a tool chain', async ({ page }) => {
    const sessionId = 'sess-cumulative-usage';

    await setupMockWebSocket(page, {
      sessionId,
      agentEvents: [
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Ich sammle zuerst die Daten.' }],
            api: 'mock',
            provider: 'mock',
            model: 'mock-model',
            usage: {
              input: 50,
              output: 80,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 130,
              cost: {
                input: 0.001,
                output: 0.002,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.003,
              },
            },
            stopReason: 'tool_call',
            timestamp: Date.now(),
          },
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-usage-1',
          toolName: 'search_workspace',
          args: { query: 'usage footer' },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-usage-1',
          toolName: 'search_workspace',
          result: {
            content: [{ type: 'text', text: 'Gefundene Treffer' }],
          },
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hier ist die zusammengefasste Antwort.' }],
            api: 'mock',
            provider: 'mock',
            model: 'mock-model',
            usage: {
              input: 70,
              output: 110,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 180,
              cost: {
                input: 0.004,
                output: 0.005,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.009,
              },
            },
            stopReason: 'stop',
            timestamp: Date.now() + 1,
          },
        },
      ],
    });

    await mockEmptyChatBootstrap(page, { sessionId });
    await page.goto('/notebook?chat=open');
    await startFreshChat(page);

    const input = page.getByTestId('chat-input');
    await input.fill('Nutze ein Tool und zeige nur den kumulierten Footer.');
    await input.press('Enter');

    const firstAssistantMessage = page.getByTestId('chat-message-assistant').filter({ hasText: 'Ich sammle zuerst die Daten.' }).last();
    const finalAssistantMessage = page.getByTestId('chat-message-assistant').filter({ hasText: 'Hier ist die zusammengefasste Antwort.' }).last();

    await expect(firstAssistantMessage).toBeVisible();
    await expect(finalAssistantMessage).toBeVisible();
    await expect(finalAssistantMessage.getByTestId('chat-usage-footer')).toHaveCount(0);
    await expect(page.getByTestId('chat-usage-footer')).toHaveCount(0);

    const runDisclosure = page.getByTestId('chat-run-disclosure').first();
    await expect(runDisclosure).toBeVisible();
    await runDisclosure.getByTestId('chat-run-disclosure-toggle').click();
    await expect(runDisclosure.getByTestId('chat-run-steps')).not.toContainText('Ich sammle zuerst die Daten.');
    await expect(runDisclosure.getByTestId('chat-tool-subtle')).toHaveCount(1);
  });

  test('should keep runtime details progressively disclosed while queue state stays in the chat UI', async ({ page }) => {
    const sessionId = 'sess-runtime-status';
    let currentStatus: PiRuntimeStatus = {
      sessionId,
      revision: 0,
      phase: 'running_tool',
      activeTool: { toolCallId: 'tool-1', name: 'read' },
      pendingToolCalls: 1,
      followUpQueue: [{ id: 'follow-1', text: 'Summarize afterwards', attachmentCount: 0 }],
      steeringQueue: [{ id: 'steer-1', text: 'Stop and inspect README', attachmentCount: 0 }],
      canAbort: true,
      contextWindow: 128000,
      estimatedHistoryTokens: 22560,
      availableHistoryTokens: 23500,
      contextUsagePercent: 96,
      contextPressure: {
        pressureTokens: 22560,
        source: 'rough_estimate',
        effectiveInputBudgetTokens: 100000,
        triggerTokens: 23500,
        targetTokens: 4700,
        percentOfTrigger: 96,
      },
      nextRequestEstimatedTokens: 50560,
      nextRequestEstimateSource: 'rough_estimate',
      includedSummary: true,
      omittedMessageCount: 8,
      summaryUpdatedAt: '2026-03-16T16:00:00.000Z',
      lastCompactionAt: '2026-03-16T16:00:00.000Z',
      lastCompactionKind: 'automatic',
      lastCompactionOmittedCount: 8,
      compactionStatus: {
        state: 'succeeded',
        attemptId: 'compact-runtime-status',
        trigger: 'automatic',
        reasonCode: null,
        retryAfter: null,
        omittedMessageCount: 8,
      },
    };
    const queuedMessages = new Map<string, Record<string, unknown>>();
    const controlActions: string[] = [];

    await mockEmptyChatBootstrap(page, {
      sessionId, title: 'Busy runtime session', persisted: true,
      messages: [
        { id: 'm1', role: 'user', content: 'Check the project status.', timestamp: Date.now() - 1000 },
        {
          id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }],
          api: 'mock', provider: 'mock', model: 'mock-model', usage: EMPTY_USAGE,
          stopReason: 'stop', timestamp: Date.now() - 500,
        },
      ],
    });

    await setupMockWebSocket(page, {
      sessionId,
      runtimeStatus: currentStatus as Record<string, unknown>,
      onGetStatus: () => currentStatus as unknown as Record<string, unknown>,
      onSendResultStatus: (message) => {
        const content = message?.content;
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
              .map((part) => {
                const item = part as { type?: unknown; text?: unknown };
                return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
              })
              .filter(Boolean)
              .join('\n')
            : '';
        currentStatus = {
          ...currentStatus,
          followUpQueue: [
            ...currentStatus.followUpQueue!,
            { id: 'follow-new', text, attachmentCount: 0 },
          ],
        };
        if (message) {
          queuedMessages.set('follow-new', message);
        }
        currentStatus = { ...currentStatus, revision: currentStatus.revision + 1 };
        return currentStatus as unknown as Record<string, unknown>;
      },
      onControl: (action, _message, _requestId, queueItemId) => {
        controlActions.push(action);
        currentStatus = { ...currentStatus, revision: currentStatus.revision + 1 };

        if (action === 'promote_queued_to_steer') {
          const entryIndex = currentStatus.followUpQueue!.findIndex((entry) => entry.id === queueItemId);
          const [entry] = entryIndex === -1 ? [] : currentStatus.followUpQueue!.splice(entryIndex, 1);
          currentStatus = {
            ...currentStatus,
            followUpQueue: currentStatus.followUpQueue!,
            steeringQueue: entry ? [...currentStatus.steeringQueue!, entry] : currentStatus.steeringQueue,
          };
          if (queueItemId === 'follow-new') {
            return {
              status: currentStatus as unknown as Record<string, unknown>,
              agentEvents: [
                {
                  type: 'message_start',
                  message: queuedMessages.get(queueItemId) || {
                    role: 'user',
                    content: entry?.text || '',
                    timestamp: Date.now(),
                  },
                },
              ],
            };
          }
        }

        if (action === 'remove_queued_item') {
          currentStatus = {
            ...currentStatus,
            followUpQueue: currentStatus.followUpQueue!.filter((entry) => entry.id !== queueItemId),
            steeringQueue: currentStatus.steeringQueue!.filter((entry) => entry.id !== queueItemId),
          };
        }

        if (action === 'replace') {
          currentStatus = {
            ...currentStatus,
            phase: 'aborting',
            activeTool: null,
            followUpQueue: [],
            steeringQueue: [],
          };
        }

        if (action === 'abort') {
          currentStatus = {
            ...currentStatus,
            phase: 'aborting',
            activeTool: null,
          };
        }

        return currentStatus as unknown as Record<string, unknown>;
      },
      agentEvents: [
        {
          type: 'runtime_status',
          status: currentStatus,
        },
      ],
      sendEventsAfterSendMessage: true,
    });

    await page.goto('/notebook?chat=open');
    await page.getByRole('button', { name: /Open latest session Busy runtime session/i }).click();

    await expect(page.getByTestId('chat-session-title')).toContainText('Busy runtime session');
    await expect(page.getByTestId('chat-runtime-banner')).toHaveCount(0);
    await expect(page.getByTestId('chat-runtime-busy-badge')).toHaveCount(0);
    await expect(page.getByTestId('chat-context-meter')).toHaveCount(0);
    await page.getByTestId('chat-header-menu-trigger').click();
    await expect(page.getByTestId('chat-context-details')).toContainText('23k/24k trigger', { timeout: 15000 });
    await expect(page.getByTestId('chat-context-details')).toContainText('4.7k target');
    await expect(page.getByTestId('chat-context-details')).toContainText('100k input budget');
    await expect(page.getByTestId('chat-context-details')).toContainText('128k');
    await expect(page.getByTestId('chat-context-details')).toContainText('96% of trigger');
    await expect(page.getByTestId('chat-context-target')).toBeVisible();
    await expect(page.getByTestId('chat-context-details')).toContainText('Earlier messages are available as a summary.');
    await expect(page.getByTestId('chat-compact')).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('chat-runtime-notice')).toHaveCount(0);
    await expect(page.getByTestId('chat-queue-panel')).toContainText('Summarize afterwards', { timeout: 15000 });
    await expect(page.getByTestId('chat-queue-panel')).toContainText('Stop and inspect README');

    await expect(page.getByTestId('chat-send')).toHaveAttribute('data-action', 'stop');
    await page.getByTestId('chat-input').fill('Take over immediately');
    await expect(page.getByTestId('chat-send')).toHaveAttribute('data-action', 'send');
    await page.getByTestId('chat-send').click();

    await expect(page.getByTestId('chat-queue-item')).toHaveCount(3);
    const newQueueItem = page.getByTestId('chat-queue-item').filter({ hasText: 'Take over immediately' }).first();
    await expect(newQueueItem).toHaveAttribute('data-queue-kind', 'follow_up');
    await expect(page.getByTestId('chat-message-user').filter({ hasText: 'Take over immediately' })).toHaveCount(0);
    await expect(page.getByTestId('chat-send')).toHaveAttribute('data-action', 'stop');

    await newQueueItem.getByTestId('chat-queue-item-steer').click();
    await expect(page.getByTestId('chat-queue-item').filter({ hasText: 'Take over immediately' }).first()).toHaveAttribute('data-queue-kind', 'steer');
    await expect(page.getByTestId('chat-message-user').filter({ hasText: 'Take over immediately' })).toHaveCount(1);
    await expect(page.getByTestId('chat-queue-item')).toHaveCount(3);

    const followUpQueueItem = page.getByTestId('chat-queue-item').filter({ hasText: 'Summarize afterwards' }).first();
    await expect(followUpQueueItem).toHaveAttribute('data-queue-kind', 'follow_up');
    await followUpQueueItem.getByTestId('chat-queue-item-steer').click();
    await expect(page.getByTestId('chat-queue-item').filter({ hasText: 'Summarize afterwards' }).first()).toHaveAttribute('data-queue-kind', 'steer');

    await page.getByTestId('chat-queue-item').filter({ hasText: 'Take over immediately' }).first().getByTestId('chat-queue-item-remove').click();
    await expect(page.getByTestId('chat-queue-panel')).not.toContainText('Take over immediately');
    await expect(page.getByTestId('chat-queue-item')).toHaveCount(2);

    const busyInput = page.getByTestId('chat-input');
    await busyInput.fill('Draft while the agent is still working');
    await busyInput.press('Escape');
    await expect.poll(() => controlActions.filter((action) => action === 'abort').length).toBe(1);
    await expect(busyInput).toHaveValue('Draft while the agent is still working');
    currentStatus = {
      ...currentStatus, revision: currentStatus.revision + 1, phase: 'idle',
      activeTool: null, pendingToolCalls: 0, canAbort: false,
    };
    await page.evaluate(({ sessionId: targetSessionId, status }) => {
      window.dispatchEvent(new CustomEvent('agent_event', { detail: { sessionId: targetSessionId, event: { type: 'runtime_status', status } } }));
    }, { sessionId, status: currentStatus });
    await expect(page.getByTestId('chat-runtime-notice')).toContainText('Context is at 96% of the automatic compaction trigger.');
  });

  test('should start a queued follow-up from Steer after the active run was stopped', async ({ page }) => {
    const sessionId = 'sess-stopped-queued-steer';
    let currentStatus = createMockRuntimeStatus(sessionId, {
      phase: 'idle',
      followUpQueue: [{ id: 'follow-after-stop', text: 'Continue after stop', attachmentCount: 0 }],
      canAbort: false,
    });
    const controlActions: string[] = [];

    await page.route('**/api/sessions**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            sessions: [
              {
                id: 1,
                sessionId,
                title: 'Stopped runtime session',
                model: 'gpt-4o',
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          session: {
            id: 1,
            sessionId,
            title: 'Stopped runtime session',
            model: 'gpt-4o',
            createdAt: new Date().toISOString(),
          },
        }),
      });
    });

    await page.route('**/api/sessions/messages**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'Stop the current run.',
              timestamp: Date.now() - 1000,
            },
            {
              id: 'm2',
              role: 'assistant',
              content: [{ type: 'text', text: 'Stopped.' }],
              api: 'mock',
              provider: 'mock',
              model: 'mock-model',
              usage: EMPTY_USAGE,
              stopReason: 'aborted',
              timestamp: Date.now() - 500,
            },
          ],
        }),
      });
    });

    await setupMockWebSocket(page, {
      sessionId,
      runtimeStatus: currentStatus as unknown as Record<string, unknown>,
      onGetStatus: () => currentStatus as unknown as Record<string, unknown>,
      onControl: (action, _message, _requestId, queueItemId) => {
        controlActions.push(action);

        if (action === 'promote_queued_to_steer' && queueItemId === 'follow-after-stop') {
          currentStatus = createMockRuntimeStatus(sessionId, {
            phase: 'streaming',
            followUpQueue: [],
            steeringQueue: [],
            canAbort: true,
          });

          return {
            status: currentStatus as unknown as Record<string, unknown>,
            agentEvents: [
              {
                type: 'message_start',
                message: {
                  role: 'user',
                  content: 'Continue after stop',
                  timestamp: Date.now(),
                },
              },
            ],
          };
        }

        return currentStatus as unknown as Record<string, unknown>;
      },
    });

    const documentRequests: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'document') {
        documentRequests.push(request.url());
      }
    });
    await page.goto('/notebook?chat=open');
    const documentRequestCountBeforeSessionOpen = documentRequests.length;
    await page.getByRole('button', { name: /Open latest session Stopped runtime session/i }).click();

    await expect(page.getByTestId('chat-queue-panel')).toContainText('Continue after stop', { timeout: 15000 });
    await expect(page.getByTestId('chat-queue-item')).toHaveCount(1);
    expect(documentRequests).toHaveLength(documentRequestCountBeforeSessionOpen);
    expect(new URL(page.url()).searchParams.has('session')).toBe(false);

    await page.getByTestId('chat-queue-item').filter({ hasText: 'Continue after stop' }).first().getByTestId('chat-queue-item-steer').click();

    await expect.poll(() => controlActions.includes('promote_queued_to_steer')).toBe(true);
    await expect(page.getByTestId('chat-message-user').filter({ hasText: 'Continue after stop' })).toHaveCount(1);
    await expect(page.getByTestId('chat-queue-item').filter({ hasText: 'Continue after stop' })).toHaveCount(0);
    await expect(page.getByText(/No active agent run to steer/i)).toHaveCount(0);
  });

  test('should show a calm typewriter suggestion in a new mobile chat without overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockEmptyChatBootstrap(page);

    await page.goto('/notebook?chat=open');

    await expect(page.getByTestId('chat-starter-prompts')).toHaveCount(0);
    await expect(page.getByTestId('chat-prompt-suggestion')).toHaveText(/.+/);
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      .toBeTruthy();

    const input = page.getByTestId('chat-input');
    await input.fill('Ich möchte eine Kampagne für mein neues Produkt planen.\n\nBitte gib mir eine klare Struktur.');
    await expect(page.getByTestId('chat-prompt-suggestion')).toHaveCount(0);
    await expect
      .poll(async () => (await getChatInputMetrics(page)).height, { timeout: 15000 })
      .toBeGreaterThan(56);
    await expect
      .poll(async () => (await getChatInputMetrics(page)).styleHeight, { timeout: 15000 })
      .toBeLessThanOrEqual(192);
    await expect(page.getByTestId('chat-mobile-action-toggle')).toHaveCount(0);
    await expect(page.getByTestId('chat-session-id')).toHaveCount(0);
    await expect(page.getByTestId('chat-model-badge')).toHaveCount(0);
  });

  test('should open the latest session inside the mobile notebook without closing the chat', async ({ page }) => {
    const sessionId = 'sess-mobile-latest-session';
    const createdAt = new Date().toISOString();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      window.sessionStorage.clear();
      window.localStorage.removeItem('canvas.chat.sessionMessages.v1');
    });
    await page.route(/\/api\/sessions(?:\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          sessions: [{
            id: 1,
            sessionId,
            title: 'Mobile latest session',
            agentId: 'canvas-agent',
            provider: 'openai',
            model: 'gpt-4o',
            createdAt,
            lastMessageAt: createdAt,
            lastViewedAt: createdAt,
            hasUnread: false,
          }],
        }),
      });
    });
    await page.route(/\/api\/sessions\/messages\?.*$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          messages: [{
            id: 'mobile-session-message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Mobile session stays open.' }],
            api: 'mock',
            provider: 'mock',
            model: 'mock-model',
            usage: EMPTY_USAGE,
            stopReason: 'stop',
            timestamp: Date.now(),
          }],
        }),
      });
    });
    await setupMockWebSocket(page, {
      sessionId,
      runtimeStatus: createMockRuntimeStatus(sessionId) as unknown as Record<string, unknown>,
      sendEventsAfterSendMessage: false,
    });

    const documentRequests: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'document') {
        documentRequests.push(request.url());
      }
    });

    await page.goto('/notebook?chat=open');
    const mobileChat = page.getByTestId('notebook-mobile-chat');
    await expect(mobileChat).toBeVisible();
    const documentRequestCountBeforeSessionOpen = documentRequests.length;

    await page.getByTestId('chat-open-latest-session').click();

    await expect(page.getByText('Mobile session stays open.')).toBeVisible({ timeout: 15000 });
    await expect(mobileChat).toBeVisible();
    expect(documentRequests).toHaveLength(documentRequestCountBeforeSessionOpen);
    expect(new URL(page.url()).searchParams.has('session')).toBe(false);
  });

  test('should auto-grow the composer up to the mobile max height and collapse on reset', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockEmptyChatBootstrap(page);
    await page.goto('/notebook?chat=open');

    const input = page.getByTestId('chat-input');
    const longPrompt = Array.from({ length: 20 }, (_, index) => `Zeile ${index + 1} für den Composer-Wachstumstest.`).join('\n');

    await expect
      .poll(async () => (await getChatInputMetrics(page)).styleHeight, { timeout: 15000 })
      .toBe(56);

    await input.fill(longPrompt);

    await expect
      .poll(async () => (await getChatInputMetrics(page)).height, { timeout: 15000 })
      .toBeGreaterThan(56);
    await expect
      .poll(async () => (await getChatInputMetrics(page)).height, { timeout: 15000 })
      .toBeLessThanOrEqual(192);
    await expect
      .poll(async () => (await getChatInputMetrics(page)).scrollHeight > (await getChatInputMetrics(page)).clientHeight, { timeout: 15000 })
      .toBeTruthy();
    await expect
      .poll(async () => (await getChatInputMetrics(page)).overflowY, { timeout: 15000 })
      .toBe('auto');
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
      .toBeTruthy();

    await page.getByRole('button', { name: /new chat/i }).click();
    await expect(input).toHaveValue('');
    await expect
      .poll(async () => (await getChatInputMetrics(page)).styleHeight, { timeout: 15000 })
      .toBe(56);
    await expect
      .poll(async () => (await getChatInputMetrics(page)).overflowY, { timeout: 15000 })
      .toBe('hidden');
  });

  test('should load the selected agent model before the first chat session starts', async ({ page }) => {
    let savedLastActiveAgentId: string | null = null;

    await page.route(/\/api\/agents(?:\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            agents: [
              { agentId: 'canvas-agent', name: 'Canvas Agent', type: 'main', removable: false },
              { agentId: 'research-agent', name: 'Research Agent', type: 'special', removable: true },
            ],
          },
        }),
      });
    });

    await page.route('**/api/user-preferences', async (route) => {
      if (route.request().method() === 'PATCH') {
        const payload = route.request().postDataJSON() as { lastActiveAgentId?: string };
        savedLastActiveAgentId = payload.lastActiveAgentId || null;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            lastActiveAgentId: savedLastActiveAgentId || 'canvas-agent',
          },
        }),
      });
    });

    await page.route('**/api/sessions**', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, sessions: [] }),
      });
    });

    await login(page);

    await expect(page.getByTestId('chat-model-selector')).toHaveAttribute('title', /openai \/ GPT-4o/i);
    await page.getByTestId('chat-agent-id').click();
    await page.getByRole('button', { name: /Research Agent\s+research-agent/i }).click();

    await expect(page.getByTestId('chat-agent-id')).toContainText('Research Agent');
    await expect(page.getByTestId('chat-model-selector')).toHaveAttribute('title', /anthropic \/ Claude Sonnet 4\.5/i);
    expect(savedLastActiveAgentId).toBe('research-agent');

    await page.getByTestId('chat-model-selector').click();
    await page.getByTestId('chat-model-selector-model-row').click();
    await page.getByText('Claude Opus 4.1').click();

    await expect(page.getByTestId('chat-model-selector')).toHaveAttribute('title', /anthropic \/ Claude Opus 4\.1/i);
  });

  test('should initialize a new chat from the last active agent preference', async ({ page }) => {
    await page.route(/\/api\/agents(?:\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            agents: [
              { agentId: 'canvas-agent', name: 'Canvas Agent', iconId: 'bot', type: 'main', removable: false },
              { agentId: 'research-agent', name: 'Research Agent', iconId: 'search', type: 'special', removable: true },
            ],
          },
        }),
      });
    });

    await page.route('**/api/user-preferences', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            lastActiveAgentId: 'research-agent',
          },
        }),
      });
    });

    await page.route('**/api/sessions**', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, sessions: [] }),
      });
    });

    await login(page);

    await expect(page.getByTestId('chat-agent-id')).toContainText('Research Agent');
    await expect(page.getByTestId('chat-model-selector')).toHaveAttribute('title', /anthropic \/ Claude Sonnet 4\.5/i);
  });

  test('should send with the preferred agent when its preference loads after New Chat', async ({ page }, testInfo) => {
    const unique = randomUUID();
    const agentId = `pi-e2e-preferred-${unique}`;
    const agentName = `PI Preferred Agent ${unique}`;
    const sessionId = `sess-preferred-agent-${unique}`;
    const prompt = 'Antworte nur mit READY.';
    const blockedWrites: string[] = [];
    let releasePreferences!: () => void;
    const preferencesGate = new Promise<void>((resolve) => { releasePreferences = resolve; });
    let preferenceRequests = 0;
    let newChatClicked = false;
    let preferencesReleasedAfterNewChat = false;
    let sessionPosts = 0;
    let subscriptions = 0;
    let sends = 0;
    let currentStatus = createMockRuntimeStatus(sessionId);
    const finalMessage = {
      role: 'assistant', content: [{ type: 'text', text: 'READY' }],
      api: 'mock', provider: 'mock', model: 'mock-model', usage: EMPTY_USAGE,
      stopReason: 'stop', timestamp: Date.now(),
    };

    await page.route((url) => url.pathname === '/api/agents', async (route) => {
      if (route.request().method() !== 'GET') {
        blockedWrites.push('agents');
        return route.abort('blockedbyclient');
      }
      await route.fulfill({ json: { success: true, data: { agents: [
        { agentId: MAIN_AGENT_ID, name: 'Bradley', iconId: 'bot', type: 'main', removable: false },
        { agentId, name: agentName, iconId: 'search', type: 'special', removable: true,
          scopeType: 'user', revision: 1, access: { canUse: true, canEdit: true, canManage: true } },
      ] } } });
    });
    await page.route((url) => url.pathname === '/api/user-preferences', async (route) => {
      if (route.request().method() !== 'GET') {
        blockedWrites.push('preferences');
        return route.abort('blockedbyclient');
      }
      preferenceRequests += 1;
      await preferencesGate;
      expect(newChatClicked, 'Preferences must stay pending until the user has clicked New Chat.').toBe(true);
      preferencesReleasedAfterNewChat = true;
      await route.fulfill({ json: { success: true, data: { lastActiveAgentId: agentId } } });
    });
    await mockEmptyChatBootstrap(page, { sessionId, agentId });
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/sessions') sessionPosts += 1;
    });
    const socket = await setupMockWebSocket(page, {
      sessionId,
      sendEventsAfterSendMessage: false,
      onSubscribe: () => { subscriptions += 1; },
      onGetStatus: () => currentStatus as unknown as Record<string, unknown>,
      onSendResultStatus: (message) => {
        expect(JSON.stringify(message.content)).toContain(prompt);
        sends += 1;
        currentStatus = createMockRuntimeStatus(sessionId, { revision: 1, phase: 'streaming', canAbort: true });
        return currentStatus as unknown as Record<string, unknown>;
      },
    });

    try {
      await page.goto('/notebook?chat=open', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => preferenceRequests, { timeout: 15_000 }).toBeGreaterThan(0);
      await expect(page.getByTestId('chat-agent-id')).toHaveAttribute('aria-label', 'Select agent: Bradley');
      expect(preferencesReleasedAfterNewChat).toBe(false);
      await startFreshChat(page);
      newChatClicked = true;
      expect(sessionPosts).toBe(0);
      expect(subscriptions).toBe(0);
      expect(sends).toBe(0);

      const effectiveResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'GET' && url.pathname === '/api/agent-runtime/effective'
          && url.searchParams.get('agentId') === agentId;
      }, { timeout: 15_000 });
      void effectiveResponse.catch(() => undefined);
      releasePreferences();
      await expect(page.getByTestId('chat-agent-id')).toHaveAttribute('aria-label', `Select agent: ${agentName}`);
      const runtimeResponse = await effectiveResponse;
      expect(runtimeResponse.ok()).toBe(true);
      const runtime = await runtimeResponse.json() as { success?: boolean; resolution?: {
        valid?: boolean; context?: { agentId?: string }; effectiveSelection?: { selection?: { modelId?: string } };
      } };
      expect(runtime.success).toBe(true);
      expect(runtime.resolution?.valid).toBe(true);
      expect(runtime.resolution?.context?.agentId).toBe(agentId);
      expect(runtime.resolution?.effectiveSelection?.selection?.modelId).toBe('gpt-4o');
      await expect(page.getByTestId('chat-provider-selector')).toBeEnabled();
      await expect(page.getByTestId('chat-model-selector')).toHaveAttribute('title', /gpt-4o/i);
      expect(preferencesReleasedAfterNewChat).toBe(true);

      await page.getByTestId('chat-input').fill(prompt);
      await expect(page.getByTestId('chat-send')).toBeEnabled();
      const creationResponse = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/sessions', { timeout: 15_000 });
      void creationResponse.catch(() => undefined);
      // The late preference must be enough: no selector click or second New Chat.
      await page.getByTestId('chat-input').press('Enter');
      const response = await creationResponse;
      expect(response.request().postDataJSON()?.agentId).toBe(agentId);
      expect(response.ok()).toBe(true);
      const created = await response.json() as { success?: boolean; session?: AISession };
      expect(created.success).toBe(true);
      expect(created.session?.agentId).toBe(agentId);
      expect(created.session?.sessionId).toBe(sessionId);
      await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', sessionId);
      await expect.poll(() => sends, { timeout: 15_000 }).toBe(1);
      expect(sessionPosts).toBe(1);
      expect(subscriptions).toBe(1);

      const assistantMessages = page.getByTestId('chat-message-assistant');
      await expect(assistantMessages).toHaveCount(1);
      socket.emitAgentEvent({ type: 'message_start', message: { ...finalMessage, content: [], stopReason: 'streaming' } });
      await expect(assistantMessages.first().getByTestId('chat-assistant-streaming-indicator')).toBeVisible();
      socket.emitAgentEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'READY' } });
      await expect(assistantMessages.first()).toContainText('READY');
      socket.emitAgentEvent({ type: 'message_end', message: finalMessage });
      socket.emitAgentEvent({ type: 'agent_end' });
      currentStatus = createMockRuntimeStatus(sessionId, { revision: 2 });
      socket.emitAgentEvent({ type: 'runtime_status', status: currentStatus });
      await expect(assistantMessages.first()).toContainText('READY');
      await expect(assistantMessages.first().getByTestId('chat-assistant-streaming-indicator')).toHaveCount(0);
      await expect(page.getByTestId('chat-send')).toHaveAttribute('data-action', 'send');
      expect(sessionPosts).toBe(1);
      expect(subscriptions).toBe(1);
      expect(sends).toBe(1);
      expect(blockedWrites).toEqual([]);
      await testInfo.attach('preferred-agent-race-regression', { contentType: 'application/json', body: JSON.stringify({
        agentId, sessionId, preferencesReleasedAfterNewChat, sessionPosts, subscriptions, sends, runtimeRevision: currentStatus.revision,
      }) });
    } finally {
      releasePreferences();
    }
  });

  test('should expose a clickable active agent selector on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    let includeCreatedAgent = false;
    let directoryReads = 0;

    await page.route(/\/api\/agents(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      directoryReads += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            agents: [
              { agentId: 'canvas-agent', name: 'Canvas Agent', iconId: 'bot', type: 'main', removable: false },
              ...(includeCreatedAgent
                ? [{ agentId: 'research-agent', name: 'Research Agent', iconId: 'search', type: 'special', removable: true }]
                : []),
            ],
          },
        }),
      });
    });

    await mockEffectiveAgentRuntime(page);

    await page.route('**/api/user-preferences', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            lastActiveAgentId: 'canvas-agent',
          },
        }),
      });
    });

    await page.route(/\/api\/sessions(\?.*)?$/, async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            sessions: [],
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
        }),
      });
    });

    await page.goto('/notebook?chat=open');

    await expect(page.getByTestId('chat-session-title')).toContainText('New chat');
    await expect(page.getByTestId('chat-runtime-banner')).toHaveCount(0);
    await expect(page.getByTestId('chat-runtime-busy-badge')).toHaveCount(0);
    await expect(page.getByTestId('chat-agent-id')).toBeVisible();
    await expect(page.getByTestId('chat-agent-id')).toHaveAttribute('aria-label', /^Select agent: .+/);
    await expect(page.getByTestId('chat-header-menu-trigger')).toBeVisible();
    await expect(page.getByTestId('chat-mobile-details-toggle')).toHaveCount(0);

    // First open proves the original directory is loaded before the server changes.
    await page.getByTestId('chat-agent-id').click();
    await expect(page.getByTestId('chat-agent-selector-popover')).toBeVisible();
    await expect(page.getByRole('button', { name: /Bradley\s+canvas-agent/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Research Agent\s+research-agent/i })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('chat-agent-selector-popover')).toBeHidden();
    const readsBeforeRefresh = directoryReads;
    includeCreatedAgent = true;
    await page.getByTestId('chat-agent-id').click();
    await expect.poll(() => directoryReads).toBeGreaterThan(readsBeforeRefresh);
    await expect(page.getByTestId('chat-agent-selector-popover')).toBeVisible();
    await expect(page.getByTestId('chat-agent-selector-popover')).toHaveCSS('z-index', '110');
    await expect(page.getByTestId('chat-agent-selector-skeleton')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Research Agent\s+research-agent/i })).toBeVisible();
    await page.getByRole('button', { name: /Research Agent\s+research-agent/i }).click();

    await expect(page.getByTestId('chat-agent-id')).toHaveAttribute('aria-label', /Research Agent/);
    await expect(page.getByTestId('chat-mobile-details-panel')).toHaveCount(0);
    await expect(page.getByTestId('chat-agent-id')).toHaveCount(1);
    await expect(page.getByTestId('chat-session-id')).toHaveCount(0);
    await expect(page.getByTestId('chat-model-badge')).toHaveCount(0);

    await page.getByTestId('chat-provider-selector').click();
    await expect(page.getByRole('heading', { name: 'Provider' })).toBeVisible();
    const providerDialog = page.getByRole('dialog', { name: 'Provider' });
    await providerDialog.getByRole('button', { name: 'Close' }).click();
    await expect(providerDialog).toHaveCount(0);

    await page.getByTestId('chat-model-selector').click();
    await expect(page.getByTestId('chat-model-selector-model-row')).toBeVisible();
    await page.getByTestId('chat-model-selector-model-row').click();
    await expect(page.getByRole('button', { name: /Claude Opus 4\.1/ })).toBeVisible();
    await page.getByRole('button', { name: /Claude Opus 4\.1/ }).click();
    await expect(page.getByTestId('chat-model-selector')).toHaveAttribute('title', /Claude Opus 4\.1/);
  });

  test('should render a compaction break after manual canvas compact', async ({ page }) => {
    const sessionId = 'sess-compact-break';
    let receivedFocusTopic: string | undefined;
    let currentStatus: PiRuntimeStatus = {
      sessionId,
      revision: 0,
      phase: 'idle',
      activeTool: null,
      pendingToolCalls: 0,
      followUpQueue: [],
      steeringQueue: [],
      canAbort: false,
      contextWindow: 128000,
      estimatedHistoryTokens: 8600,
      availableHistoryTokens: 23500,
      contextUsagePercent: 37,
      includedSummary: true,
      omittedMessageCount: 6,
      summaryUpdatedAt: '2026-03-16T16:00:00.000Z',
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

    await mockEmptyChatBootstrap(page, {
      sessionId, title: 'Compact session', persisted: true,
      messages: [
        { id: 'm1', role: 'user', content: 'Compress the old context.', timestamp: Date.now() - 1000 },
        {
          id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Ready when you are.' }],
          api: 'mock', provider: 'mock', model: 'mock-model', usage: EMPTY_USAGE,
          stopReason: 'stop', timestamp: Date.now() - 500,
        },
      ],
    });

    await setupMockWebSocket(page, {
      sessionId,
      runtimeStatus: currentStatus as Record<string, unknown>,
      onGetStatus: () => currentStatus as unknown as Record<string, unknown>,
      onControl: (action, _message, _requestId, _queueItemId, focusTopic) => {
        if (action === 'compact') {
          receivedFocusTopic = focusTopic;
          currentStatus = {
            ...currentStatus,
            lastCompactionAt: '2026-03-16T17:20:00.000Z',
            lastCompactionKind: 'manual',
            lastCompactionOmittedCount: 6,
            compactionStatus: {
              ...currentStatus.compactionStatus,
              state: 'succeeded',
              attemptId: 'compact-manual-1',
              trigger: 'manual',
              omittedMessageCount: 6,
            },
          };
        }

        return currentStatus as unknown as Record<string, unknown>;
      },
      agentEvents: [],
      sendEventsAfterSendMessage: false,
    });

    await page.goto('/notebook?chat=open');
    await page.getByRole('button', { name: /Open latest session Compact session/i }).click();

    await page.getByTestId('chat-header-menu-trigger').click();
    await expect(page.getByTestId('chat-compact')).toBeEnabled({ timeout: 15000 });
    await page.getByTestId('chat-compact').click();

    const breakMarker = page.getByTestId('chat-compaction-break');
    await expect(breakMarker).toBeVisible();
    await expect(breakMarker).toContainText('Canvas context compacted');
    await expect(breakMarker).toContainText('6');

    currentStatus = {
      ...currentStatus,
      lastCompactionAt: null,
      lastCompactionKind: null,
      lastCompactionOmittedCount: 0,
      compactionStatus: {
        ...currentStatus.compactionStatus,
        state: 'idle',
        attemptId: null,
        trigger: null,
        omittedMessageCount: 0,
      },
    };
    await page.reload();
    await expect(page.getByTestId('chat-session-title')).toContainText('Compact session');
    await page.getByTestId('chat-header-menu-trigger').click();
    await expect(page.getByTestId('chat-compact-with-focus')).toBeVisible();
    await page.getByTestId('chat-compact-with-focus').click();
    await expect(page.getByTestId('chat-header-menu')).toBeHidden();
    await expect(page.getByTestId('chat-compaction-focus-submit')).toBeDisabled();
    await page.getByTestId('chat-compaction-focus').fill('database migration safety');
    await expect(page.getByTestId('chat-compaction-focus-submit')).toBeEnabled();
    await page.getByTestId('chat-compaction-focus-submit').click();
    await expect.poll(() => receivedFocusTopic).toBe('database migration safety');
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
                agentId: 'memory-manager',
                sourceAgentId: 'research-agent',
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
                agentId: 'canvas-agent',
                sourceAgentId: null,
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
    await page.getByRole('button', { name: 'Toggle details and events' }).click();
    await expect(page.getByTestId('usage-summary-table')).toContainText('2026-03-16');

    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByPlaceholder('openai, anthropic, ollama').fill('openai');
    await page.getByRole('button', { name: /apply filters/i }).click();

    await expect(page.getByTestId('usage-summary-table')).toContainText('openai');
    await expect(page.getByTestId('usage-event-row')).toContainText('OpenAI Session');
    await expect(page.getByTestId('usage-event-agent')).toContainText('memory-manager');
    await expect(page.getByTestId('usage-event-source-agent')).toContainText('research-agent');
    await expect(page.getByRole('option', { name: 'Agent' })).toBeAttached();
    await expect(page.getByText('$1.23').first()).toBeVisible();
  });

  test('should save managed prompt files in settings and keep chat working', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const unique = randomUUID();
    const requestedAgentId = `pi-e2e-managed-${unique}`;
    const agentName = `PI managed prompt ${unique}`;
    const initialContent = '# PI managed prompt fixture\n\nThis agent belongs only to this test.\n';
    const marker = `PLAYWRIGHT-PROMPT-MARKER-${unique}`;
    const api = await request.newContext({
      baseURL: testInfo.project.use.baseURL, storageState: await page.context().storageState(), timeout: 15_000,
    });
    let ownedAgent: AgentProfile | null = null;
    let creationRevision: number | null = null;
    let expectedContent = initialContent;
    let pendingSaveReceipt: Promise<void> | null = null;
    let primaryError: unknown;
    let blockedFileWrite: Error | null = null;
    let creationAttempted = false;
    const cleanupErrors: unknown[] = [];
    let ownerUserId = '';
    try {
      const identityResponse = await api.get('/api/auth/get-session');
      expect(identityResponse.ok()).toBe(true);
      const identity = await identityResponse.json() as { user?: { id?: string } };
      expect(identity.user?.id).toBeTruthy();
      ownerUserId = identity.user!.id!;
      creationAttempted = true;
      const creationResponse = await api.post('/api/agents', {
        data: { agentId: requestedAgentId, name: agentName, scopeType: 'user', iconId: 'bot', files: { 'AGENTS.md': initialContent } },
      });
      const creation = await creationResponse.json() as { success?: boolean; data?: { agent?: AgentProfile } };
      // Register this exact creation receipt before any UI action or later assertion.
      if (creationResponse.ok() && creation.success && creation.data?.agent?.agentId === requestedAgentId) {
        ownedAgent = creation.data.agent;
        creationRevision = ownedAgent.revision;
      }
      expect(creationResponse.ok(), `Owned agent creation returned HTTP ${creationResponse.status()}.`).toBe(true);
      expect(creation.success).toBe(true);
      expect(ownedAgent).not.toBeNull();
      expect(ownedAgent!.name).toBe(agentName);
      expect(ownedAgent!.type).toBe('special');
      expect(ownedAgent!.scopeType).toBe('user');
      expect(ownedAgent!.ownerUserId).toBe(ownerUserId);
      expect(ownedAgent!.createdByUserId).toBe(ownerUserId);
      expect(Number.isSafeInteger(ownedAgent!.revision) && ownedAgent!.revision > 0).toBe(true);

      await page.route((url) => url.pathname === '/api/agents/files', async (route) => {
        if (route.request().method() !== 'PUT') return route.fallback();
        const payload = route.request().postDataJSON() as { agentId?: string; fileName?: string; expectedRevision?: number };
        if (payload.agentId !== requestedAgentId || payload.fileName !== 'AGENTS.md' || payload.expectedRevision !== ownedAgent?.revision) {
          blockedFileWrite = new Error('Blocked a managed-file write outside this test-owned agent and revision.');
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });
      await page.goto('/settings?tab=agent-settings');
      const ownAgentButton = page.getByRole('button').filter({ has: page.getByText(agentName, { exact: true }) });
      await ownAgentButton.click();
      await expect(ownAgentButton).toHaveAttribute('aria-pressed', 'true');
      const managedFilesCard = page.locator('#onboarding-settings-managedFiles');
      const managedFilesTrigger = managedFilesCard.getByRole('button').first();
      await expect(managedFilesTrigger).toContainText('Agent Managed Files');
      if (await managedFilesTrigger.getAttribute('aria-expanded') === 'false') await managedFilesTrigger.click();
      await expect(managedFilesTrigger).toHaveAttribute('aria-expanded', 'true');
      const editor = page.getByTestId('agent-managed-file-editor').locator('[contenteditable="true"]');
      await expect(editor).toContainText('PI managed prompt fixture');
      await editor.click();
      await editor.press('ControlOrMeta+End');
      await editor.press('Enter');
      await editor.pressSequentially(`UI marker: ${marker}`);
      await expect(editor).toContainText(marker);
      const saveRevision = ownedAgent!.revision;
      pendingSaveReceipt = page.waitForResponse((response) => {
        if (new URL(response.url()).pathname !== '/api/agents/files' || response.request().method() !== 'PUT') return false;
        const payload = response.request().postDataJSON();
        return payload?.agentId === requestedAgentId && payload?.fileName === 'AGENTS.md';
      }, { timeout: 15_000 }).then(async (response) => {
        const submitted = response.request().postDataJSON() as { agentId: string; fileName: string; expectedRevision: number; content: string };
        const receipt = await response.json() as { success?: boolean; data?: { content?: string; agent?: AgentProfile } };
        if (response.ok() && receipt.success && receipt.data?.agent?.agentId === requestedAgentId
          && receipt.data.agent.name === agentName && receipt.data.agent.createdByUserId === ownerUserId
          && receipt.data.agent.ownerUserId === ownerUserId && receipt.data.agent.revision === saveRevision + 1
          && receipt.data.content === submitted.content) {
          ownedAgent = receipt.data.agent;
          expectedContent = receipt.data.content;
        }
        expect(response.ok(), `Owned prompt save returned HTTP ${response.status()}.`).toBe(true);
        expect(receipt.success).toBe(true);
        expect(submitted.expectedRevision).toBe(saveRevision);
        expect(submitted.content).toContain(marker);
        expect(receipt.data?.content).toBe(submitted.content);
        expect(receipt.data?.agent?.revision).toBe(saveRevision + 1);
      });
      // Keep the receipt observed even if the UI action fails after the server saved it.
      void pendingSaveReceipt.catch(() => undefined);
      await page.getByTestId('agent-managed-file-save').click();
      await pendingSaveReceipt;
      await expect(page.getByText('Saved AGENTS.md.')).toBeVisible({ timeout: 15000 });
      const savedResponse = await api.get(`/api/agents/files?agentId=${encodeURIComponent(requestedAgentId)}`);
      expect(savedResponse.ok()).toBe(true);
      const saved = await savedResponse.json() as { success?: boolean; data?: { files?: Record<string, string>; agent?: AgentProfile } };
      expect(saved.success).toBe(true);
      expect(saved.data?.files?.['AGENTS.md']).toBe(expectedContent);
      expect(saved.data?.agent?.revision).toBe(ownedAgent!.revision);

      await page.reload();
      await ownAgentButton.click();
      await expect(ownAgentButton).toHaveAttribute('aria-pressed', 'true');
      if (await managedFilesTrigger.getAttribute('aria-expanded') === 'false') await managedFilesTrigger.click();
      await expect(managedFilesTrigger).toHaveAttribute('aria-expanded', 'true');
      await expect(editor).toContainText(marker, { timeout: 15000 });
      const reloadedResponse = await api.get(`/api/agents/files?agentId=${encodeURIComponent(requestedAgentId)}`);
      expect(reloadedResponse.ok()).toBe(true);
      const reloaded = await reloadedResponse.json() as { success?: boolean; data?: { files?: Record<string, string> } };
      expect(reloaded.success).toBe(true);
      expect(reloaded.data?.files?.['AGENTS.md']).toBe(expectedContent);

      const sessionId = `sess-managed-prompt-${unique}`;
      await page.route((url) => url.pathname === '/api/user-preferences', async (route) => {
        if (!['GET', 'PUT', 'PATCH'].includes(route.request().method())) return route.fallback();
        await route.fulfill({ json: { success: true, data: { lastActiveAgentId: requestedAgentId } } });
      });
      let mockSendCount = 0;
      let mockSubscriptionCount = 0;
      let currentStatus = createMockRuntimeStatus(sessionId);
      const finalMessage = {
        role: 'assistant', content: [{ type: 'text', text: 'READY' }],
        api: 'mock', provider: 'mock', model: 'mock-model', usage: EMPTY_USAGE,
        stopReason: 'stop', timestamp: Date.now(),
      };
      const socket = await setupMockWebSocket(page, {
        sessionId,
        sendEventsAfterSendMessage: false,
        onSubscribe: () => { mockSubscriptionCount += 1; },
        onGetStatus: () => currentStatus as unknown as Record<string, unknown>,
        onSendResultStatus: (message) => {
          expect(JSON.stringify(message.content)).toContain('Antworte nur mit READY.');
          mockSendCount += 1;
          currentStatus = createMockRuntimeStatus(sessionId, { revision: 1, phase: 'streaming', canAbort: true });
          return currentStatus as unknown as Record<string, unknown>;
        },
      });
      await mockEmptyChatBootstrap(page, { sessionId, agentId: requestedAgentId });
      await page.goto('/notebook?chat=open');
      await expect(page.getByTestId('chat-agent-id')).toContainText(agentName);
      await page.getByTestId('chat-agent-id').click();
      await page.getByTestId('chat-agent-selector-popover').getByRole('button')
        .filter({ has: page.getByText(requestedAgentId, { exact: true }) }).click();
      await expect(page.getByTestId('chat-agent-id')).toHaveAttribute('aria-label', `Select agent: ${agentName}`);
      await startFreshChat(page);
      await expect(page.getByTestId('chat-agent-id')).toContainText(agentName);
      await page.getByTestId('chat-input').fill('Antworte nur mit READY.');
      const chatCreationResponse = page.waitForResponse((response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/sessions'
        && response.request().postDataJSON()?.agentId === requestedAgentId, { timeout: 15_000 });
      void chatCreationResponse.catch(() => undefined);
      await page.getByTestId('chat-input').press('Enter');
      const createdResponse = await chatCreationResponse;
      expect(createdResponse.ok()).toBe(true);
      const created = await createdResponse.json() as { success?: boolean; session?: AISession };
      expect(created.success).toBe(true);
      expect(created.session?.sessionId).toBe(sessionId);
      expect(created.session?.agentId).toBe(requestedAgentId);
      await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', sessionId);
      await expect.poll(() => mockSendCount).toBe(1);
      expect(mockSubscriptionCount).toBeGreaterThan(0);
      const assistantMessages = page.getByTestId('chat-message-assistant');
      await expect(assistantMessages).toHaveCount(1, { timeout: 15000 });
      socket.emitAgentEvent({ type: 'message_start', message: { ...finalMessage, content: [], stopReason: 'streaming' } });
      await expect(assistantMessages.first().getByTestId('chat-assistant-streaming-indicator')).toBeVisible();
      socket.emitAgentEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'READY' } });
      await expect(assistantMessages.first()).toContainText('READY');
      socket.emitAgentEvent({ type: 'message_end', message: finalMessage });
      socket.emitAgentEvent({ type: 'agent_end' });
      currentStatus = createMockRuntimeStatus(sessionId, { revision: 2 });
      socket.emitAgentEvent({ type: 'runtime_status', status: currentStatus });
      await expect(assistantMessages.first()).toContainText('READY');
      await expect(assistantMessages.first().getByTestId('chat-assistant-streaming-indicator')).toHaveCount(0);
      await expect(page.getByTestId('chat-send')).toHaveAttribute('data-action', 'send');
      expect(blockedFileWrite).toBeNull();
    } catch (error) {
      primaryError = error;
    } finally {
      if (pendingSaveReceipt) {
        try { await pendingSaveReceipt; } catch (error) { if (error !== primaryError) cleanupErrors.push(error); }
      }
      try { await page.close(); } catch (error) { cleanupErrors.push(error); }
      if (ownedAgent) {
        try {
          expect(ownedAgent.agentId).toBe(requestedAgentId);
          expect(ownedAgent.name).toBe(agentName);
          expect(ownedAgent.type).toBe('special');
          expect(ownedAgent.ownerUserId).toBe(ownerUserId);
          expect(ownedAgent.createdByUserId).toBe(ownerUserId);
          const filesResponse = await api.get(`/api/agents/files?agentId=${encodeURIComponent(requestedAgentId)}`);
          expect(filesResponse.ok()).toBe(true);
          const files = await filesResponse.json() as { success?: boolean; data?: { files?: Record<string, string>; agent?: AgentProfile } };
          expect(files.success).toBe(true);
          expect(files.data?.agent?.revision).toBe(ownedAgent.revision);
          expect(files.data?.files?.['AGENTS.md']).toBe(expectedContent);
          const previewResponse = await api.post('/api/agents/delete-preview', { data: { agentId: requestedAgentId } });
          expect(previewResponse.ok()).toBe(true);
          const preview = await previewResponse.json() as { success?: boolean; data?: {
            agent?: AgentProfile; impacts?: Record<string, unknown>; confirmationToken?: string;
          } };
          expect(preview.success).toBe(true);
          expect(preview.data?.agent?.agentId).toBe(requestedAgentId);
          expect(preview.data?.agent?.createdByUserId).toBe(ownerUserId);
          expect(preview.data?.agent?.revision).toBe(ownedAgent.revision);
          // No real session/runtime is created by this fixture. Fail closed if anything adopted this agent.
          for (const dependency of ['sessions', 'members', 'grants', 'capabilityBindings', 'memoryCollections', 'memoryEntries']) {
            expect(preview.data?.impacts?.[dependency], `Owned agent has unexpected ${dependency}.`).toBe(0);
          }
          expect(preview.data?.confirmationToken).toBeTruthy();
          const deletionResponse = await api.delete('/api/agents', {
            data: { agentId: requestedAgentId, expectedRevision: ownedAgent.revision, confirmationToken: preview.data!.confirmationToken },
          });
          expect(deletionResponse.ok()).toBe(true);
          const deletion = await deletionResponse.json() as { success?: boolean; data?: { deleted?: boolean; agentId?: string } };
          expect(deletion.success).toBe(true);
          expect(deletion.data?.deleted).toBe(true);
          expect(deletion.data?.agentId).toBe(requestedAgentId);
          const listResponse = await api.get('/api/agents');
          expect(listResponse.ok()).toBe(true);
          const list = await listResponse.json() as { success?: boolean; data?: { agents?: AgentProfile[] } };
          expect(list.success).toBe(true);
          expect(list.data?.agents?.some((agent) => agent.agentId === requestedAgentId)).toBe(false);
          await testInfo.attach('owned-managed-agent-cleanup-receipt', {
            contentType: 'application/json', body: Buffer.from(JSON.stringify({
              agentId: requestedAgentId, creationRevision, deletedRevision: ownedAgent.revision,
              contentSha256: createHash('sha256').update(expectedContent).digest('hex'),
              ownedDependencies: 0, deleted: true, absentFromCatalog: true,
            })),
          });
        } catch (error) {
          cleanupErrors.push(new Error(`Owned managed-agent cleanup failed; retained ID ${requestedAgentId}, revision ${ownedAgent.revision}.`, { cause: error }));
        }
      } else if (creationAttempted) {
        cleanupErrors.push(new Error(`No verified creation receipt for requested managed-agent ID ${requestedAgentId}; cleanup requires inspection.`));
      }
      if (blockedFileWrite && blockedFileWrite !== primaryError) cleanupErrors.push(blockedFileWrite);
      try { await api.dispose(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors, 'Managed-prompt test or owned cleanup failed.');
    if (primaryError) throw primaryError;
  });

  for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 390, height: 844 }]) {
    test(`should keep tool file references compact and stable on ${viewport.name}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const sessionId = `sess-reference-summary-${viewport.name}`;
      const timestamp = Date.now();
      const references = Array.from({ length: 14 }, (_, index) => ({
        workspaceId: 'pending-workspace', path: `reports/Report-${String(index + 1).padStart(2, '0')}.odt`,
        kind: index === 1 ? 'changed' : 'created', toolCallId: 'references-write',
      }));
      const readReferences = Array.from({ length: 3 }, (_, index) => ({
        workspaceId: 'pending-workspace', path: `inputs/Brief-${index + 1}.pdf`, kind: 'read', toolCallId: `references-read-${index}`,
      }));
      const outputDetails = { chatFileReferences: { version: 1, references } };
      const reply = 'Die Dokumente sind fertig. reports/example-only.odt ist nur ein Beispiel.\n\n[absolute server path omitted from persisted chat history]';
      const assistant = {
        id: 7, sequence: 7, role: 'assistant', content: [{ type: 'text', text: reply }],
        api: 'mock', provider: 'mock', model: 'mock-model', usage: EMPTY_USAGE, stopReason: 'stop', timestamp: timestamp + 7,
      };
      const toolResults = [
        { id: 3, sequence: 3, role: 'toolResult', toolName: 'apply_patch', toolCallId: 'references-write', content: [{ type: 'text', text: 'Created 14 reports.' }], details: outputDetails, isError: false, timestamp: timestamp + 3 },
        ...readReferences.map((reference, index) => ({
          id: index + 4, sequence: index + 4, role: 'toolResult', toolName: 'read', toolCallId: reference.toolCallId,
          content: [{ type: 'text', text: 'Read briefing.' }], details: { chatFileReferences: { version: 1, references: [reference] } }, isError: false, timestamp: timestamp + index + 4,
        })),
      ];
      const persisted = [
        { id: 1, sequence: 1, role: 'user', content: 'Erstelle die Dokumente aus meinen Briefings.', timestamp },
        { ...assistant, id: 2, sequence: 2, timestamp: timestamp + 1, stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'references-write', name: 'apply_patch', arguments: { patch: 'mock patch' } },
          ...readReferences.map((reference) => ({ type: 'toolCall', id: reference.toolCallId, name: 'read', arguments: { path: reference.path } })),
        ] },
        ...toolResults, assistant,
      ];
      let historyReads = 0;
      let createdSession: Record<string, unknown> | null = null;
      const historyPage = () => ({ success: true, messages: persisted, hasMoreBefore: false, oldestMessageId: 1, oldestSequence: 1, oldestTimestamp: persisted[0].timestamp });
      await mockEmptyChatBootstrap(page, { sessionId, title: 'Document references' });
      await page.route('**/api/sessions/messages?**', async (route) => {
        historyReads += 1;
        await route.fulfill({ json: historyPage() });
      });
      await page.route(`**/api/sessions/${sessionId}/bootstrap?**`, async (route) => {
        historyReads += 1;
        await route.fulfill({ json: { success: true, session: { ...createdSession,
          workspace: { workspaceId: references[0].workspaceId, workspaceType: 'personal', workspaceName: 'Personal Workspace' },
        }, messages: historyPage() } });
      });
      await page.route('**/api/files/exists?**', async (route) => {
        const filePath = new URL(route.request().url()).searchParams.get('path');
        await route.fulfill({ json: { success: true, data: { path: filePath, exists: true, type: 'file' } } });
      });
      await setupMockWebSocket(page, {
        sessionId,
        onSendMessage: (message, context) => {
          expect(typeof message.timestamp).toBe('number');
          persisted[0].timestamp = message.timestamp as number;
          const workspaceId = (context?.workspace as { workspaceId?: string } | undefined)?.workspaceId;
          expect(workspaceId).toBeTruthy();
          [...references, ...readReferences].forEach((reference) => { reference.workspaceId = workspaceId!; });
        },
        agentEvents: [
          ...toolResults.flatMap((result) => [
            { type: 'tool_execution_start', toolCallId: result.toolCallId, toolName: result.toolName, args: {} },
            { type: 'tool_execution_end', toolCallId: result.toolCallId, toolName: result.toolName, result: { content: result.content, details: result.details }, isError: false },
          ]),
          { type: 'message_start', message: assistant },
          { type: 'message_end', message: assistant },
          { type: 'agent_end' },
          { type: 'runtime_status', status: createMockRuntimeStatus(sessionId) },
        ],
      });
      await page.goto('/notebook?chat=open');
      await startFreshChat(page);
      await page.getByTestId('chat-input').fill('Erstelle die Dokumente aus meinen Briefings.');
      const creationResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/sessions' && response.request().method() === 'POST');
      await page.getByTestId('chat-send').click();
      createdSession = (await (await creationResponse).json()).session;

      const panel = page.getByTestId('chat-file-references');
      const items = panel.getByTestId('chat-file-reference-item');
      await expect(panel).toHaveCount(1);
      await expect(items).toHaveCount(5);
      await expect(panel).toHaveAttribute('aria-label', 'Files · 14');
      await expect(panel.getByTestId('chat-read-references-toggle')).toContainText('3');
      await expect(page.getByTestId('chat-message-assistant')).not.toContainText('omitted from');
      await expect(panel.locator('[data-path="reports/example-only.odt"]')).toHaveCount(0);
      await expect(panel.locator('[data-path^="inputs/"]')).toHaveCount(0);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`references-${viewport.name}-collapsed.png`) });
      await panel.getByTestId('chat-file-references-expand').click();
      await expect(items).toHaveCount(14);
      await panel.getByTestId('chat-file-references-search').fill('Report-14');
      await expect(items).toHaveCount(1);
      await expect(items.first()).toHaveAttribute('data-path', 'reports/Report-14.odt');
      await panel.getByTestId('chat-file-references-search').fill('not-a-document');
      await expect(items).toHaveCount(0);
      await panel.getByTestId('chat-file-references-search').fill('');
      await panel.getByTestId('chat-read-references-toggle').click();
      await expect(items).toHaveCount(17);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`references-${viewport.name}-expanded.png`) });
      // The chat's scrollport extends behind its absolute composer. Browser
      // scrollIntoViewIfNeeded checks that larger box, not the unoccluded area.
      // Scroll as a user would, outside the results' nested scrolling list.
      const composer = page.getByTestId('chat-input').locator('xpath=ancestor::div[contains(@class, "bottom-0")][1]');
      const scrollRegionBounds = await page.getByTestId('chat-scroll-region').boundingBox();
      const composerBounds = await composer.boundingBox();
      const lastReadBounds = await items.last().boundingBox();
      expect(scrollRegionBounds).not.toBeNull();
      expect(composerBounds).not.toBeNull();
      expect(lastReadBounds).not.toBeNull();
      await page.mouse.move(scrollRegionBounds!.x + scrollRegionBounds!.width - 4, scrollRegionBounds!.y + 24);
      await page.mouse.wheel(0, Math.max(120, lastReadBounds!.y + lastReadBounds!.height - composerBounds!.y + 24));
      await expect.poll(async () => {
        const row = await items.last().boundingBox();
        const overlay = await composer.boundingBox();
        return Boolean(row && overlay && row.y + row.height <= overlay.y);
      }).toBe(true);
      await expect.poll(() => items.last().evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return hit !== null && element.contains(hit);
      })).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`references-${viewport.name}-reads.png`) });
      const bounds = await panel.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);

      const readsBeforeRefresh = historyReads;
      await page.evaluate((targetSessionId) => {
        window.dispatchEvent(new CustomEvent('agent_event', { detail: { sessionId: targetSessionId, event: { type: 'message_saved' } } }));
      }, sessionId);
      await expect.poll(() => historyReads).toBeGreaterThan(readsBeforeRefresh);
      await expect(items).toHaveCount(17);
      await expect(panel.getByTestId('chat-read-references-toggle')).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('chat-message-assistant').last()).not.toContainText('omitted from');

      await panel.getByTestId('chat-read-references-toggle').click();
      await expect(items).toHaveCount(14);
      await panel.getByTestId('chat-file-references-expand').click();
      await expect(items).toHaveCount(5);

      const readsBeforeReload = historyReads;
      await page.goto(`/notebook?chat=open&session=${sessionId}`);
      await expect.poll(() => historyReads).toBeGreaterThan(readsBeforeReload);
      await expect(panel).toHaveCount(1, { timeout: 15000 });
      await expect(items).toHaveCount(5);
      await panel.getByTestId('chat-file-references-expand').click();
      await expect(items).toHaveCount(14);
      await panel.getByTestId('chat-read-references-toggle').click();
      await expect(items).toHaveCount(17);
      await expect(panel.locator('[data-path="reports/example-only.odt"]')).toHaveCount(0);
    });
  }

});
