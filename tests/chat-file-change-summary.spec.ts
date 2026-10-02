import { expect, test, type Page, type TestInfo, type WebSocketRoute } from '@playwright/test';
import type { FileChangeAppData } from '@/app/lib/tool-apps/file-change-data';
import type { FileChangeGroupV1 } from '@/app/lib/file-version-center/contracts/v1';
import type { PiRuntimeStatus } from '@/app/lib/pi/live-runtime';
import { authenticateManagedTestPage } from './helpers/managed-test-context';

const SESSION_ID = 'chat-file-change-summary-regression';
const FILES = ['summary-plan.txt', 'summary-notes.ts', 'summary-report.md'];
const EDITOR_MARKER = 'File opened from the collected change summary.';
const EMPTY_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function runtimeStatus(sessionId: string, phase: PiRuntimeStatus['phase'] = 'idle', revision = 0) {
  return {
    sessionId, revision, phase, activeTool: null, pendingToolCalls: 0,
    followUpQueue: [], steeringQueue: [], canAbort: phase !== 'idle',
    contextWindow: 128000, estimatedHistoryTokens: 0, availableHistoryTokens: 100000,
    contextUsagePercent: 0, includedSummary: false, omittedMessageCount: 0,
    summaryUpdatedAt: null, lastCompactionAt: null, lastCompactionKind: null,
    lastCompactionOmittedCount: 0,
    compactionStatus: {
      state: 'idle', attemptId: null, trigger: null, reasonCode: null,
      retryAfter: null, omittedMessageCount: 0,
    },
  };
}

function changeGroup(workspaceId: string, index: number, operation: FileChangeGroupV1['operation'], paths: string[]): FileChangeGroupV1 {
  return {
    contractVersion: 1, id: `fvcg-${String(index).repeat(64)}`, workspaceId,
    sourceSessionId: SESSION_ID, toolCallId: `summary-tool-${index}`, operation,
    status: 'applied', createdAt: '2026-09-30T10:00:00.000Z',
    entries: paths.map((pathHint, ordinal) => ({
      id: `summary-entry-${index}-${ordinal}`, ordinal, pathHint, outcome: 'applied',
      revisionId: `summary-revision-${index}-${ordinal}`, additions: index, deletions: 0,
    })),
  };
}

function authorizedData(group: FileChangeGroupV1): FileChangeAppData {
  return {
    contractVersion: 1, id: group.id, workspaceId: group.workspaceId,
    operation: group.operation, status: group.status, createdAt: group.createdAt,
    entries: group.entries.map((entry) => ({
      id: entry.id, ordinal: entry.ordinal, pathHint: entry.pathHint, state: entry.outcome,
      operationId: entry.operationId ?? null, revisionId: entry.revisionId ?? null,
      additions: entry.additions ?? null, deletions: entry.deletions ?? null,
    })),
  };
}

function fixtureMessages(groups: FileChangeGroupV1[]) {
  let id = 1;
  const assistant = (text: string, calls: FileChangeGroupV1[] = []) => ({
    id: id++, role: 'assistant',
    content: [{ type: 'text', text }, ...calls.map((group) => ({
      type: 'toolCall', id: group.toolCallId, name: group.operation,
      arguments: group.operation === 'apply_patch' ? { patch: 'fixture patch' } : { path: group.entries[0].pathHint },
    }))],
    api: 'mock', provider: 'mock', model: 'mock-model', usage: EMPTY_USAGE,
    stopReason: calls.length ? 'toolUse' : 'stop', timestamp: 1_800_000_000_000 + id,
  });
  const result = (group: FileChangeGroupV1) => ({
    id: id++, role: 'toolResult', toolName: group.operation, toolCallId: group.toolCallId,
    content: [{ type: 'text', text: 'Updated a file safely.' }],
    details: {
      changeGroup: group,
      chatFileReferences: { version: 1, references: group.entries.map((entry) => ({
        workspaceId: group.workspaceId, path: entry.pathHint, kind: 'changed', toolCallId: group.toolCallId,
      })) },
      toolApp: {
        kind: 'builtin', version: 1, resourceUri: 'ui://canvas/file-change-group/v1',
        entityId: group.id, toolCallId: group.toolCallId, operation: group.operation,
      },
    },
    timestamp: 1_800_000_000_000 + id,
  });
  return [
    { id: id++, role: 'user', content: 'Update these three files in several tool rounds.', timestamp: 1_800_000_000_001 },
    assistant('I will first update the plan.', [groups[0]]), result(groups[0]),
    assistant('I will revise the plan again and update the other files.', [groups[1], groups[2]]),
    result(groups[1]), result(groups[2]), assistant('All requested file changes are complete.'),
  ];
}

async function loginWorkspace(page: Page) {
  const email = process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.TEST_LOGIN_PASSWORD || process.env.BOOTSTRAP_ADMIN_PASSWORD;
  expect(email, 'BOOTSTRAP_ADMIN_EMAIL is required').toBeTruthy();
  expect(password, 'BOOTSTRAP_ADMIN_PASSWORD is required').toBeTruthy();
  await authenticateManagedTestPage(page, { email, password });
  const response = await page.request.get('/api/workspaces');
  expect(response.ok()).toBeTruthy();
  const { workspaces } = await response.json() as { workspaces: Array<{ id: string; type: string }> };
  const workspaceId = (workspaces.find((workspace) => workspace.type === 'personal') || workspaces[0])?.id;
  expect(workspaceId).toBeTruthy();
  await page.addInitScript((id) => localStorage.setItem('canvas.activeWorkspaceId', id), workspaceId!);
  return workspaceId!;
}

async function installFixtures(page: Page, workspaceId: string, active = false) {
  const groups = [
    changeGroup(workspaceId, 1, 'write', [FILES[0]]),
    changeGroup(workspaceId, 2, 'edit_file', [FILES[0]]),
    changeGroup(workspaceId, 3, 'apply_patch', [FILES[1], FILES[2]]),
  ];
  let socket: WebSocketRoute | undefined;
  let phase: PiRuntimeStatus['phase'] = active ? 'streaming' : 'idle';
  const summaryRequests: Array<Record<string, unknown>> = [];
  const widgetRequests: string[] = [];
  let denied = false;
  await page.route('**/api/agent-runtime/effective**', async (route) => route.fulfill({
    json: {
      success: true, data: {
        context: { organizationId: null, userId: 'summary-user', workspaceId, workspaceType: 'personal', agentId: 'bradley' },
        catalogRevision: 1, policyRevision: 1, providers: [], inheritedSelection: null,
        preference: null, effectiveSelection: null, source: 'app_default', valid: true, issues: [],
      },
    },
  }));
  await page.route('**/api/sessions**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/sessions/messages') {
      await route.fulfill({ json: {
        success: true, messages: fixtureMessages(groups), hasMoreBefore: false,
        oldestTimestamp: null, oldestMessageId: null, oldestSequence: null,
      } });
    } else if (pathname === `/api/sessions/${SESSION_ID}/bootstrap`) {
      const createdAt = new Date().toISOString();
      await route.fulfill({ json: { success: true, session: {
        id: 1, sessionId: SESSION_ID, title: 'Collected file changes regression', agentId: 'bradley',
        model: 'mock-model', provider: 'mock', thinkingLevel: null, createdAt, engine: 'pi',
        lastMessageAt: createdAt, lastViewedAt: createdAt, hasUnread: false, creator: null,
      }, messages: {
        success: true, messages: fixtureMessages(groups), hasMoreBefore: false,
        oldestTimestamp: null, oldestMessageId: null, oldestSequence: null,
      } } });
    } else if (pathname === '/api/sessions') {
      const createdAt = new Date().toISOString();
      await route.fulfill({ json: { success: true, sessions: [{
        id: 1, sessionId: SESSION_ID, title: 'Collected file changes regression', agentId: 'bradley',
        model: 'mock-model', provider: 'mock', thinkingLevel: null, createdAt, engine: 'pi',
        lastMessageAt: createdAt, lastViewedAt: createdAt, hasUnread: false, creator: null,
      }] } });
    } else await route.continue();
  });
  await page.route('**/api/chat/file-changes', async (route) => {
    const request = route.request().postDataJSON() as Record<string, unknown>;
    summaryRequests.push(request);
    await route.fulfill({ json: { success: true, data: {
      groups: denied ? [] : groups.map(authorizedData),
      unavailable: denied ? groups.map((group) => ({ entityId: group.id, toolCallId: group.toolCallId, status: 403, retryable: false })) : [],
    } } });
  });
  await page.route('**/api/chat/tool-apps', async (route) => {
    widgetRequests.push(route.request().url());
    await route.fulfill({ status: 500, json: { success: false, code: 'UNEXPECTED_FILE_CHANGE_WIDGET' } });
  });
  await page.route('**/api/files/tree**', async (route) => route.fulfill({ json: {
    success: true, data: FILES.map((path) => ({ path, name: path, type: 'file' })),
  } }));
  await page.route('**/api/files/read**', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (!FILES.includes(path || '')) return route.continue();
    await route.fulfill({ json: { success: true, data: { path, content: EDITOR_MARKER, collaboration: null, revision: null } } });
  });
  await page.routeWebSocket('**/ws/chat', (webSocket) => {
    socket = webSocket;
    webSocket.send(JSON.stringify({ type: 'auth_success', userId: 'summary-user' }));
    webSocket.onMessage((rawMessage) => {
      const message = JSON.parse(typeof rawMessage === 'string' ? rawMessage : rawMessage.toString());
      if (message.type === 'subscribe_session') webSocket.send(JSON.stringify({
        type: 'subscribe_result', requestId: message.requestId, success: true, sessionId: SESSION_ID,
      }));
      if (message.type === 'get_status') webSocket.send(JSON.stringify({
        type: 'status_result', requestId: message.requestId, success: true, status: runtimeStatus(SESSION_ID, phase),
      }));
    });
  });
  return {
    summaryRequests, widgetRequests,
    denyCurrentStatuses: () => { denied = true; },
    endInternalTurn: () => {
      expect(socket).toBeTruthy();
      socket!.send(JSON.stringify({ type: 'agent_event', sessionId: SESSION_ID, event: { type: 'turn_end' } }));
    },
    finishRun: () => {
      expect(socket).toBeTruthy();
      phase = 'idle';
      socket!.send(JSON.stringify({ type: 'agent_event', sessionId: SESSION_ID, event: { type: 'agent_end' } }));
      socket!.send(JSON.stringify({ type: 'agent_event', sessionId: SESSION_ID, event: {
        type: 'runtime_status', status: runtimeStatus(SESSION_ID, 'idle', 1),
      } }));
    },
  };
}

async function openFixtureChat(page: Page) {
  await page.goto('/de/notebook?chat=open');
  await page.getByTestId('chat-open-latest-session').click();
  await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', SESSION_ID);
}

async function assertCollectedSummary(page: Page) {
  const card = page.getByTestId('chat-file-references');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('chat-file-reference-item')).toHaveCount(3);
  for (const path of FILES) await expect(card.locator(`[data-testid="chat-file-reference-item"][data-path="${path}"]`)).toHaveCount(1);
  await expect(page.getByTestId('canvas-tool-app-widget')).toHaveCount(0);
  await expect(page.getByTestId('tool-app-slot')).toHaveCount(0);
  await expect(card.locator('iframe')).toHaveCount(0);
  await expect(card.getByTestId('chat-file-reference-status')).toHaveText(['Angewendet', 'Angewendet', 'Angewendet']);
  // Repeated edits cannot be added up into a trustworthy net diff.
  await expect(card.locator(`[data-testid="chat-file-reference-item"][data-path="${FILES[0]}"]`)).not.toContainText('+');
  await expect(card.locator(`[data-testid="chat-file-reference-item"][data-path="${FILES[1]}"]`)).toContainText('+3');
  return card;
}

test('collects multiple tool rounds, deduplicates paths, opens the editor, and survives reload', async ({ page }, testInfo: TestInfo) => {
  test.setTimeout(90_000);
  const workspaceId = await loginWorkspace(page);
  const fixture = await installFixtures(page, workspaceId);
  await openFixtureChat(page);
  const card = await assertCollectedSummary(page);
  await expect.poll(() => fixture.summaryRequests.length).toBe(1);
  expect(fixture.summaryRequests[0]).toMatchObject({ sessionId: SESSION_ID, agentId: 'bradley' });
  expect(fixture.summaryRequests[0].apps).toHaveLength(3);
  expect(fixture.widgetRequests).toHaveLength(0);
  await card.screenshot({ path: testInfo.outputPath('collected-file-changes-desktop.png') });
  const read = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/files/read'
    && new URL(request.url()).searchParams.get('path') === FILES[0]);
  await card.locator(`[data-testid="chat-file-reference-item"][data-path="${FILES[0]}"]`).click();
  const request = await read;
  expect(request.headers()['x-canvas-workspace-id']).toBe(workspaceId);
  await expect(page.locator('.cm-content')).toContainText(EDITOR_MARKER, { timeout: 30_000 });
  await page.reload();
  await assertCollectedSummary(page);
  await expect.poll(() => fixture.summaryRequests.length).toBe(2);
  expect(fixture.widgetRequests).toHaveLength(0);
  fixture.denyCurrentStatuses();
  await page.getByTestId('chat-file-references-refresh').click();
  await expect(page.getByTestId('chat-file-reference-status')).toHaveText([
    'Prüfung nicht verfügbar', 'Prüfung nicht verfügbar', 'Prüfung nicht verfügbar',
  ]);
  await expect(page.getByTestId('chat-file-reference-review')).toHaveCount(0);
  expect(fixture.widgetRequests).toHaveLength(0);
});

test('waits for the full run to finish before displaying the summary, including internal turn ends', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const workspaceId = await loginWorkspace(page);
  const fixture = await installFixtures(page, workspaceId, true);
  await openFixtureChat(page);
  await expect(page.getByTestId('chat-file-references')).toHaveCount(0);
  expect(fixture.summaryRequests).toHaveLength(0);
  fixture.endInternalTurn();
  await page.waitForTimeout(250);
  await expect(page.getByTestId('chat-file-references')).toHaveCount(0);
  fixture.finishRun();
  const card = await assertCollectedSummary(page);
  await expect.poll(() => fixture.summaryRequests.length).toBe(1);
  expect(fixture.widgetRequests).toHaveLength(0);
  await card.screenshot({ path: testInfo.outputPath('collected-file-changes-mobile.png') });
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
