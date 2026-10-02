import { createHash, randomUUID } from 'node:crypto';
import { test, expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import { MAIN_AGENT_ID } from '../app/lib/agents/main-agent';
import type { AutomationJobRecord, AutomationRunRecord } from '../app/lib/automations/types';
import type { ClientWorkspaceResponse } from '../app/lib/workspaces/client-types';
import enMessages from '../messages/en.json';
import deMessages from '../messages/de.json';
import { authenticateManagedTestPage } from './helpers/managed-test-context';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const REQUEST_TIMEOUT_MS = 15_000;
const RUN_COMPLETION_TIMEOUT_MS = 120_000;
const RUN_CLEANUP_TIMEOUT_MS = 10 * 60_000 + 30_000;

type OwnedAutomationFixture = {
  name: string;
  prompt: string;
  filePath: string;
  fileContent: string;
  fileHash: string;
  workspaceId: string;
  userId: string;
  jobId: string | null;
  runId: string | null;
  createAttempted: boolean;
  runAttempted: boolean;
};

type PersistedAutomationMessage = {
  role: string;
  toolName?: string;
  isError?: boolean;
  content?: string | Array<{ type: string; name?: string; text?: string; arguments?: { path?: string; content?: string } }>;
};

async function login(page: Page) {
  await authenticateManagedTestPage(page);
}

function assertOwnedJob(job: AutomationJobRecord, fixture: OwnedAutomationFixture) {
  expect(job.id).toBe(fixture.jobId);
  expect(job.name).toBe(fixture.name);
  expect(job.prompt).toBe(fixture.prompt);
  expect(job.workspaceId).toBe(fixture.workspaceId);
  expect(job.createdByUserId).toBe(fixture.userId);
  expect(job.agentId).toBe(MAIN_AGENT_ID);
  expect(job.deliveryMode).toBe('web');
  expect(job.deliverySessionMode).toBe('new_session');
  expect(job.deliverySessionId).toBeNull();
}

function assertOwnedRun(run: AutomationRunRecord, fixture: OwnedAutomationFixture) {
  expect(run.id).toBe(fixture.runId);
  expect(run.jobId).toBe(fixture.jobId);
  expect(run.workspaceId).toBe(fixture.workspaceId);
  expect(run.actorUserId).toBe(fixture.userId);
  expect(run.triggerType).toBe('manual');
  if (run.piSessionId) expect(run.piSessionId).toBe(`auto-${run.id.replace(/^run-/, '')}`);
}

async function readOwnedJob(api: APIRequestContext, fixture: OwnedAutomationFixture): Promise<AutomationJobRecord> {
  const response = await api.get(`/api/automations/jobs/${fixture.jobId}`);
  expect(response.status()).toBe(200);
  const payload = await response.json();
  expect(payload.success).toBe(true);
  const job = payload.data as AutomationJobRecord;
  assertOwnedJob(job, fixture);
  return job;
}

async function readOwnedRun(api: APIRequestContext, fixture: OwnedAutomationFixture, timeout = REQUEST_TIMEOUT_MS): Promise<AutomationRunRecord> {
  const response = await api.get(`/api/automations/runs/${fixture.runId}`, { timeout });
  expect(response.status()).toBe(200);
  const payload = await response.json();
  expect(payload.success).toBe(true);
  const run = payload.data as AutomationRunRecord;
  assertOwnedRun(run, fixture);
  return run;
}

async function cleanupOwnedAutomation(api: APIRequestContext, fixture: OwnedAutomationFixture) {
  if (!fixture.createAttempted) return;
  if (!fixture.jobId) {
    // Recover an owned creation whose HTTP response was lost before registration.
    const response = await api.get('/api/automations/jobs');
    expect(response.status()).toBe(200);
    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(Array.isArray(payload.data)).toBe(true);
    const matches = (payload.data as AutomationJobRecord[]).filter((job) => job.name === fixture.name
      && job.prompt === fixture.prompt && job.workspaceId === fixture.workspaceId && job.createdByUserId === fixture.userId);
    expect(matches.length, 'An owned UUID automation must resolve to at most one job.').toBeLessThanOrEqual(1);
    if (!matches.length) return;
    fixture.jobId = matches[0].id;
  }

  // A revision-fenced pause blocks scheduled ticks and queued/retry admissions.
  let paused = false;
  for (let attempt = 0; attempt < 3 && !paused; attempt++) {
    const current = await readOwnedJob(api, fixture);
    if (current.status === 'paused') {
      expect(current.nextRunAt).toBeNull();
      paused = true;
      break;
    }
    const response = await api.patch(`/api/automations/jobs/${fixture.jobId}`, {
      data: { status: 'paused', expectedRevision: current.revision },
    });
    if (response.status() === 409) continue; // Re-read and re-establish exact ownership before the next CAS.
    expect(response.status()).toBe(200);
    const payload = await response.json();
    expect(payload.success).toBe(true);
    assertOwnedJob(payload.data, fixture);
    expect(payload.data.status).toBe('paused');
    expect(payload.data.nextRunAt).toBeNull();
    paused = true;
  }
  expect(paused, 'Owned job pause did not pass its revision fence.').toBe(true);

  const runsResponse = await api.get(`/api/automations/jobs/${fixture.jobId}/runs`);
  expect(runsResponse.status()).toBe(200);
  const runsPayload = await runsResponse.json();
  expect(runsPayload.success).toBe(true);
  expect(Array.isArray(runsPayload.data)).toBe(true);
  const runs = runsPayload.data as AutomationRunRecord[];
  expect(runs.length, 'The fixture must own at most one manually queued run.').toBeLessThanOrEqual(1);
  if (runs.length) {
    expect(fixture.runAttempted).toBe(true);
    fixture.runId ??= runs[0].id;
    assertOwnedRun(runs[0], fixture);
  } else expect(fixture.runId).toBeNull();

  let settledRun: AutomationRunRecord | null = null;
  if (fixture.runId) {
    const deadline = Date.now() + RUN_CLEANUP_TIMEOUT_MS;
    let lastStatus: string = 'unknown';
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Owned automation ${fixture.jobId}/${fixture.runId} is still ${lastStatus}; retaining its job, session and ${fixture.filePath}.`);
      }
      const run = await readOwnedRun(api, fixture, Math.min(REQUEST_TIMEOUT_MS, remaining));
      lastStatus = run.status;
      if (run.metadataJson?.loopQuiescent === false) {
        throw new Error(`Owned automation ${fixture.jobId}/${run.id} is not quiescent; retaining its job, session and ${fixture.filePath}.`);
      }
      if (run.status === 'success' || run.status === 'failed'
        || (run.status === 'retry_scheduled' && run.metadataJson?.loopQuiescent === true)) {
        settledRun = run;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, Math.max(1, deadline - Date.now()))));
    }
  }

  const cleanupErrors: unknown[] = [];
  const headers = { 'x-canvas-workspace-id': fixture.workspaceId };
  try {
    expect(fixture.filePath).toMatch(/^pw-automation-[0-9a-f-]{36}\.txt$/);
    const existsResponse = await api.get(`/api/files/exists?path=${encodeURIComponent(fixture.filePath)}`, { headers });
    expect(existsResponse.status()).toBe(200);
    const exists = await existsResponse.json();
    expect(exists.success).toBe(true);
    if (exists.data.exists) {
      const response = await api.get(`/api/files/read?path=${encodeURIComponent(fixture.filePath)}`, { headers });
      expect(response.status()).toBe(200);
      const payload = await response.json();
      expect(payload.success).toBe(true);
      expect(payload.data.path).toBe(fixture.filePath);
      expect(payload.data.content).toBe(fixture.fileContent);
      expect(payload.data.stats.sha256).toBe(fixture.fileHash);
      const deleted = await api.delete('/api/files/delete', { headers, data: { path: fixture.filePath } });
      expect(deleted.status()).toBe(200);
      const deletion = await deleted.json();
      expect(deletion.success).toBe(true);
      expect(deletion.deleted).toEqual([fixture.filePath]);
      expect(deletion.failed).toEqual([]);
      const absent = await api.get(`/api/files/exists?path=${encodeURIComponent(fixture.filePath)}`, { headers });
      expect(absent.status()).toBe(200);
      expect((await absent.json()).data.exists).toBe(false);
    }
  } catch (error) { cleanupErrors.push(error); }

  if (settledRun?.piSessionId) {
    try {
      const sessionId = `auto-${settledRun.id.replace(/^run-/, '')}`;
      expect(settledRun.piSessionId).toBe(sessionId);
      const bootstrap = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/bootstrap?workspaceId=${encodeURIComponent(fixture.workspaceId)}`);
      if (bootstrap.status() === 404) {
        expect(settledRun.hasPersistedSession).toBe(false);
      } else {
        expect(bootstrap.status()).toBe(200);
        const payload = await bootstrap.json();
        expect(payload.success).toBe(true);
        expect(payload.session.sessionId).toBe(sessionId);
        expect(payload.session.agentId).toBe(MAIN_AGENT_ID);
        expect(payload.session.title).toBe(`Automation: ${fixture.name}`.slice(0, 120));
        const query = new URLSearchParams({ sessionId, agentId: MAIN_AGENT_ID });
        const deleted = await api.delete(`/api/sessions?${query}`);
        expect(deleted.status()).toBe(200);
        expect(await deleted.json()).toMatchObject({ success: true, deleted: sessionId });
        const absent = await api.get(`/api/sessions/${encodeURIComponent(sessionId)}/bootstrap?workspaceId=${encodeURIComponent(fixture.workspaceId)}`);
        expect(absent.status()).toBe(404);
      }
    } catch (error) { cleanupErrors.push(error); }
  }

  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, `Owned automation cleanup failed; retaining paused ${fixture.jobId}/${fixture.runId} for ${fixture.filePath}.`);
  }
  try {
    const current = await readOwnedJob(api, fixture);
    expect(current.status).toBe('paused');
    expect(current.nextRunAt).toBeNull();
    const deleted = await api.delete(`/api/automations/jobs/${fixture.jobId}`);
    expect(deleted.status()).toBe(200);
    expect((await deleted.json()).success).toBe(true);
    expect((await api.get(`/api/automations/jobs/${fixture.jobId}`)).status()).toBe(404);
  } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Owned automation cleanup failed for ${fixture.jobId}/${fixture.runId}, ${fixture.filePath}.`);
}

test.describe('Automationen API auth', () => {
  test('automation APIs require auth', async ({ request }) => {
    const response = await request.get('/api/automations/jobs');
    expect(response.status()).toBe(401);
  });
});

test.describe('Automationen UI', () => {
  test.setTimeout(300_000);
  let cleanupApi: APIRequestContext | null = null;
  let owned: OwnedAutomationFixture | null = null;
  let primaryFailure: unknown;

  test.afterEach(async ({}, testInfo) => {
    // A headless run cannot be cancelled through live-runtime WS controls.
    // Teardown has a separate bound for its existing 10-minute deadline and abort grace.
    testInfo.setTimeout(RUN_CLEANUP_TIMEOUT_MS + 90_000);
    const cleanupErrors: unknown[] = [];
    try {
      if (cleanupApi && owned) await cleanupOwnedAutomation(cleanupApi, owned);
    } catch (error) { cleanupErrors.push(error); }
    finally {
      try { await cleanupApi?.dispose(); } catch (error) { cleanupErrors.push(error); }
      cleanupApi = null;
      owned = null;
    }
    if (cleanupErrors.length) {
      const primaryErrors = primaryFailure ? [primaryFailure] : testInfo.errors.map((error) => {
        const failure = new Error(error.message || error.value || 'Automation test failed before teardown.');
        if (error.stack) failure.stack = error.stack;
        return failure;
      });
      throw new AggregateError([...primaryErrors, ...cleanupErrors],
        'Automation test failed to clean up its exact owned resources.');
    }
  });

  test('creates an automation, starts one manual run, and opens its persisted notebook session', async ({ page }) => {
    primaryFailure = undefined;
    try {
      await login(page);
      cleanupApi = await playwrightRequest.newContext({
        baseURL: BASE_URL, storageState: await page.context().storageState(), timeout: REQUEST_TIMEOUT_MS,
        extraHTTPHeaders: { Origin: BASE_URL },
      });
      const sessionResponse = await cleanupApi.get('/api/auth/get-session');
      expect(sessionResponse.status()).toBe(200);
      const session = await sessionResponse.json();
      expect(session.user?.id).toBeTruthy();
      const uuid = randomUUID();
      const marker = `PW-AUTOMATION-${uuid}`;
      const filePath = `pw-automation-${uuid}.txt`;
      const fileContent = `${marker}\n`;
      const prompt = `Use the write tool once to create exactly the workspace-relative file ${filePath}. Write one line containing ${marker} followed by exactly one LF newline. Do not modify any other file or create directories, automations, notifications, run logs or metadata files. After the tool confirms that the file was applied successfully, reply with exactly ${marker}. If human review is required or writing fails, report that explicitly instead of claiming success.`;
      owned = { name: `PW Automation ${uuid} mit langem Titel für Overflow-Test`, prompt, filePath, fileContent,
        fileHash: createHash('sha256').update(fileContent).digest('hex'), workspaceId: '', userId: session.user.id,
        jobId: null, runId: null, createAttempted: false, runAttempted: false };

      const clientFailures: string[] = [];
      // Keep diagnostics useful without recording query credentials from console URLs.
      const recordClientFailure = (message: string) => clientFailures.push(message.replace(/https?:\/\/[^\s)]+/g, (value) => {
        try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[redacted URL]'; }
      }));
      page.on('pageerror', (error) => recordClientFailure(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error' && /^(?:App error:)|Invalid content for node doc/.test(message.text())) recordClientFailure(message.text());
      });
      await page.goto('/automations');
      await expect(page).toHaveURL(/\/(?:[a-z]{2}\/)?automations$/);
      const labels = new URL(page.url()).pathname.startsWith('/de/') ? deMessages.automationen : enMessages.automationen;
      await page.getByTestId('automation-new').click();
      const composer = page.getByRole('dialog', { name: labels.editor.newTitle, exact: true });
      await expect(composer).toBeVisible();
      const workspaceSelector = composer.getByTestId('automation-scheduled-workspace');
      await expect.poll(() => workspaceSelector.inputValue()).not.toBe('');
      owned.workspaceId = await workspaceSelector.inputValue();
      const workspaceResponse = await cleanupApi.get('/api/workspaces');
      expect(workspaceResponse.status()).toBe(200);
      const workspacePayload = await workspaceResponse.json() as ClientWorkspaceResponse;
      expect(workspacePayload.success).toBe(true);
      const workspace = workspacePayload.workspaces?.find((entry) => entry.id === owned!.workspaceId);
      expect(workspace?.permissions).toMatchObject({ canRead: true, canWrite: true, canDelete: true, canRunAgent: true });
      const headers = { 'x-canvas-workspace-id': owned.workspaceId };
      const initialFile = await cleanupApi.get(`/api/files/exists?path=${encodeURIComponent(filePath)}`, { headers });
      expect(initialFile.status()).toBe(200);
      expect(await initialFile.json()).toMatchObject({ success: true, data: { exists: false } });

      await composer.getByTestId('automation-name').fill(owned.name);
      const promptEditor = composer.getByTestId('automation-prompt').locator('.ProseMirror[contenteditable="true"]');
      await expect(promptEditor).toBeVisible({ timeout: 30_000 });
      await promptEditor.fill(prompt);
      await composer.locator('summary').filter({ hasText: labels.trigger.label }).click();
      await composer.getByTestId('automation-schedule-kind').selectOption('once');
      await composer.getByTestId('automation-time-zone').selectOption('UTC');
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString().slice(0, 10);
      await composer.locator('input[type="date"]').fill(futureDate);
      await composer.locator('input[type="time"]').fill('12:00');
      const createResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/automations/jobs'
        && response.request().method() === 'POST', { timeout: REQUEST_TIMEOUT_MS }).then(async (response) => {
        const payload = await response.json();
        if (typeof payload.data?.id === 'string') owned!.jobId = payload.data.id;
        return { response, payload };
      });
      owned.createAttempted = true;
      const [{ response, payload }] = await Promise.all([
        createResponse, composer.getByRole('button', { name: labels.overview.newAutomation, exact: true }).click(),
      ]);
      expect(response.status()).toBe(201);
      expect(payload.success).toBe(true);
      expect(owned.jobId).toMatch(/^job-[0-9a-f-]{36}$/);
      assertOwnedJob(payload.data, owned);
      expect(payload.data.schedule).toMatchObject({ kind: 'once', date: futureDate, time: '12:00', timeZone: 'UTC' });
      expect(Date.parse(payload.data.nextRunAt)).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);
      await expect.poll(() => new URL(page.url()).pathname.replace(/^\/[a-z]{2}(?=\/)/, '')).toBe(`/automations/${owned!.jobId}`);
      await expect(page.getByTestId('automation-run-now')).toBeEnabled();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

      const runResponse = page.waitForResponse((result) => new URL(result.url()).pathname === `/api/automations/jobs/${owned!.jobId}/run-now`
        && result.request().method() === 'POST', { timeout: REQUEST_TIMEOUT_MS }).then(async (result) => {
        const data = await result.json();
        if (typeof data.data?.id === 'string') owned!.runId = data.data.id;
        return { response: result, payload: data };
      });
      owned.runAttempted = true;
      const [queued] = await Promise.all([runResponse, page.getByTestId('automation-run-now').click()]);
      expect(queued.response.status()).toBe(202);
      expect(queued.payload.success).toBe(true);
      expect(owned.runId).toMatch(/^run-[0-9a-f-]{36}$/);
      assertOwnedRun(queued.payload.data, owned);
      let completedRun: AutomationRunRecord | null = null;
      const completionDeadline = Date.now() + RUN_COMPLETION_TIMEOUT_MS;
      while (!completedRun) {
        const remaining = completionDeadline - Date.now();
        if (remaining <= 0) throw new Error(`Owned automation run ${owned.runId} did not complete within 120 seconds.`);
        const run = await readOwnedRun(cleanupApi, owned, Math.min(REQUEST_TIMEOUT_MS, remaining));
        if (run.status === 'failed' || run.status === 'retry_scheduled') {
          throw new Error(`Owned automation run ${run.id} ended as ${run.status}.`);
        }
        if (run.status === 'success') completedRun = run;
        else await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, Math.max(1, completionDeadline - Date.now()))));
      }
      expect(completedRun.hasPersistedSession).toBe(true);
      expect(completedRun.resultText).toBe(marker);
      expect(completedRun.metadataJson?.loopQuiescent).not.toBe(false);
      const sessionId = `auto-${owned.runId!.replace(/^run-/, '')}`;
      expect(completedRun.piSessionId).toBe(sessionId);
      const runs = await cleanupApi.get(`/api/automations/jobs/${owned.jobId}/runs`);
      expect(runs.status()).toBe(200);
      expect((await runs.json()).data.map((entry: AutomationRunRecord) => entry.id)).toEqual([owned.runId]);

      const writtenResponse = await cleanupApi.get(`/api/files/read?path=${encodeURIComponent(filePath)}`, { headers });
      expect(writtenResponse.status()).toBe(200);
      const written = await writtenResponse.json();
      expect(written.success).toBe(true);
      expect(written.data.content).toBe(fileContent);
      expect(written.data.stats.sha256).toBe(owned.fileHash);
      const query = new URLSearchParams({ sessionId, agentId: MAIN_AGENT_ID, workspaceId: owned.workspaceId, raw: 'true' });
      const messagesResponse = await cleanupApi.get(`/api/sessions/messages?${query}`);
      expect(messagesResponse.status()).toBe(200);
      const messagesPayload = await messagesResponse.json();
      expect(messagesPayload.success).toBe(true);
      const messages = messagesPayload.messages as PersistedAutomationMessage[];
      expect(messages.some((message) => message.role === 'user')).toBe(true);
      expect(messages.some((message) => message.role === 'assistant')).toBe(true);
      expect(messages.some((message) => message.role === 'toolResult' && message.toolName === 'write' && message.isError !== true)).toBe(true);
      const calls = messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'toolCall') : []);
      const writes = calls.filter((call) => call.name === 'write');
      expect(writes).toHaveLength(1);
      expect(writes[0].arguments).toMatchObject({ path: filePath, content: fileContent });
      for (const call of calls) {
        expect(['write', 'read', 'ls', 'rg', 'grep', 'glob', 'inspect_document_relations'], 'This fixture authorizes one file write and read-only tools.').toContain(call.name);
      }

      await page.reload();
      await expect(page.getByTestId(`automation-run-${owned.runId}`)).toBeVisible();
      await page.getByTestId(`automation-run-${owned.runId}`).click();
      await expect(page.getByTestId('automation-result-text')).toHaveText(marker);
      const notebookLink = page.getByTestId('automation-open-notebook-session');
      const notebookHref = await notebookLink.getAttribute('href');
      expect(notebookHref).toBeTruthy();
      const notebookTarget = new URL(notebookHref!, BASE_URL);
      expect(notebookTarget.pathname.replace(/^\/[a-z]{2}(?=\/)/, '')).toBe('/notebook');
      expect(notebookTarget.searchParams.get('session')).toBe(sessionId);
      expect(notebookTarget.searchParams.get('workspaceId')).toBe(owned.workspaceId);
      expect(notebookTarget.searchParams.get('chat')).toBe('open');
      await page.getByRole('tab', { name: labels.session.title, exact: true }).click();
      await expect(page.getByTestId('automation-session-scroll')).toBeVisible();
      await expect.poll(() => page.getByTestId('automation-session-message').count()).toBeGreaterThanOrEqual(2);
      await expect(page.getByTestId('automation-session-scroll')).toContainText(marker);
      await page.getByRole('tab', { name: labels.runDetails.summary, exact: true }).click();
      await notebookLink.click();
      await expect.poll(() => new URL(page.url()).searchParams.get('session')).toBe(sessionId);
      await expect.poll(() => new URL(page.url()).searchParams.get('workspaceId')).toBe(owned!.workspaceId);
      await expect(page).toHaveURL(/\/(?:[a-z]{2}\/)?notebook(?:\?.*)?$/);
      await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', sessionId, { timeout: 15_000 });
      expect(clientFailures).toEqual([]);
    } catch (error) {
      primaryFailure = error;
      throw error;
    }
  });
});
