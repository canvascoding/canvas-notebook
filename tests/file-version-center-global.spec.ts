import { expect, request as requestFactory, test as base, type APIRequestContext, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAIN_AGENT_ID } from '../app/lib/agents/main-agent';
import { requireOwnedCollaborationQaTarget } from '../scripts/lib/owned-collaboration-qa';
import { readExperimentalState, setScopedDocumentReview, type ExperimentalState } from './helpers/document-review-experimental';

import {
  createAuthenticatedContext,
  enterMarkdownEditMode,
  uploadWorkspaceTextFile,
} from './helpers/managed-test-context';

const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';

type Workspace = {
  id: string;
  name: string;
  type: string;
  rootRelativePath: string;
  organizationId?: string | null;
  customerId?: string | null;
  projectId?: string | null;
  legacy?: boolean;
  permissions: { canWrite: boolean };
};

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  details?: {
    code?: string;
    outcome?: string;
    sha256?: string;
    collaboration?: { operationId?: string; reviewRequired?: boolean };
  };
};

type Timeline = {
  capabilities: {
    history: boolean;
    compare: boolean;
    restore: boolean;
    agentReviewPolicy: boolean;
  };
  policy?: { effectiveMode?: string };
  entries: Array<{ kind: string }>;
};


type OwnedSession = {
  sessionId: string; agentId: string; userId: string; workspaceId: string; title: string;
  cleanup?: Promise<void>;
};

type SeedResources = {
  request: APIRequestContext;
  drivers: Set<PersistentAgentToolDriver>;
  sessions: Map<string, OwnedSession>;
};

class PersistentAgentToolDriver {
  private readonly child: ChildProcessWithoutNullStreams & EventEmitter;
  private readonly exited: Promise<void>;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private pending?: { id: string; resolve: (value: ToolResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private startupTimer: NodeJS.Timeout;
  private stdout = '';
  private outputBytes = 0;
  private stderrBytes = 0;
  private stderr = Buffer.alloc(0);
  private exitCode: number | null = null;
  private didExit = false;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor() {
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.child = spawn(process.execPath, [
      '--import', 'tsx', '--conditions', 'react-server', 'scripts/collaboration-agent-tool-driver.ts', '--persistent',
    ], { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams & EventEmitter;
    this.startupTimer = setTimeout(() => this.fail(new Error('Agent test driver startup exceeded 30 seconds.')), 30_000);
    this.exited = new Promise<void>((resolve) => this.child.once('close', (code: number | null) => {
      this.didExit = true;
      this.exitCode = code;
      clearTimeout(this.startupTimer);
      if (this.stderr.length) {
        const evidence = `/tmp/canvas-yjs-426b-agent-driver-stderr-${randomUUID()}.log`;
        try {
          writeFileSync(evidence, this.stderr, { mode: 0o600, flag: 'wx' });
          console.log('[version-center driver]', JSON.stringify({ stderrBytes: this.stderrBytes, evidence,
            stderrHash: createHash('sha256').update(this.stderr).digest('hex') }));
        } catch { this.fail(new Error('Could not retain bounded private agent driver diagnostics.')); }
      }
      if (!this.closing || this.pending) this.fail(new Error('Agent test driver exited before completing its owned request.'));
      resolve();
    }));
    this.child.on('error', () => this.fail(new Error('Agent test driver could not start.')));
    this.child.stdin.on('error', () => this.fail(new Error('Agent test driver stdin failed.')));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      const remaining = 2 * 1024 * 1024 - this.stderr.length;
      if (remaining > 0) this.stderr = Buffer.concat([this.stderr, chunk.subarray(0, remaining)]);
      // Retain bounded private diagnostics without forwarding runtime logs,
      // tool payloads or environment values. Match the legacy 2-MiB limit.
      if (this.stderrBytes > 2 * 1024 * 1024) this.fail(new Error('Agent test driver stderr limit exceeded.'));
    });
  }

  private fail(error: Error): void {
    clearTimeout(this.startupTimer);
    this.rejectReady(error);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    if (!this.didExit) this.child.kill('SIGTERM');
  }

  private receive(chunk: string): void {
    this.outputBytes += Buffer.byteLength(chunk);
    this.stdout += chunk;
    if (this.outputBytes > 8 * 1024 * 1024 || Buffer.byteLength(this.stdout) > 2 * 1024 * 1024) {
      this.fail(new Error('Agent test driver stdout limit exceeded.'));
      return;
    }
    let newline: number;
    while ((newline = this.stdout.indexOf('\n')) !== -1) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      let receipt: { driverProtocol?: number; type?: string; toolCallId?: string; result?: ToolResult };
      try { receipt = JSON.parse(line); } catch { continue; }
      if (!receipt || receipt.driverProtocol !== 1) continue;
      if (receipt.type === 'ready') {
        clearTimeout(this.startupTimer);
        this.resolveReady();
      } else if (receipt.type === 'result' && this.pending && receipt.toolCallId === this.pending.id && receipt.result) {
        clearTimeout(this.pending.timer);
        this.pending.resolve(receipt.result);
        this.pending = undefined;
      } else this.fail(new Error('Agent test driver returned an unexpected protocol receipt.'));
    }
  }

  async execute(input: { toolName: 'read' | 'edit_file'; params: Record<string, unknown>; context: Record<string, unknown> }): Promise<ToolResult> {
    await this.ready;
    if (this.closing || this.didExit || this.pending) throw new Error('Agent test driver is unavailable or already executing.');
    const id = `version-center-browser-${randomUUID()}`;
    const line = `${JSON.stringify({ ...input, toolCallId: id })}\n`;
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error('Agent test driver request limit exceeded.');
    return new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Agent test driver ${input.toolName} exceeded 30 seconds.`)), 30_000);
      this.pending = { id, resolve, reject, timer };
      this.child.stdin.write(line, (error) => { if (error) this.fail(new Error('Agent test driver request write failed.')); });
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      this.child.stdin.end();
      for (const signal of [undefined, 'SIGTERM', 'SIGKILL'] as const) {
        if (this.didExit) break;
        if (signal) this.child.kill(signal);
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); })]);
        clearTimeout(timer);
      }
      if (!this.didExit) throw new Error('Owned agent test driver did not exit after bounded cleanup.');
      if (this.exitCode !== 0) throw new Error('Owned agent test driver exited unsuccessfully.');
    })();
    return this.closePromise;
  }

  hasExited(): boolean { return this.didExit; }
}

async function cleanupOwnedSession(resources: SeedResources, owned: OwnedSession): Promise<void> {
  if (owned.cleanup) return owned.cleanup;
  owned.cleanup = (async () => {
    const authResponse = await resources.request.get('/api/auth/get-session');
    expect(authResponse.status(), 'Independent fixture cleanup requires the original authenticated owner.').toBe(200);
    expect((await authResponse.json()).user?.id).toBe(owned.userId);
    const listed = await resources.request.get('/api/sessions', { params: { agentId: owned.agentId, workspaceId: owned.workspaceId } });
    expect(listed.status()).toBe(200);
    const sessions = (await listed.json()).sessions as Array<{
      sessionId?: string; agentId?: string; userId?: string; title?: string; workspace?: { workspaceId?: string };
    }>;
    expect(Array.isArray(sessions)).toBe(true);
    const exact = sessions.filter((item) => item.sessionId === owned.sessionId);
    expect(exact, 'Delete only the exact API-created fixture session.').toHaveLength(1);
    expect(exact[0]).toMatchObject({ sessionId: owned.sessionId, agentId: owned.agentId, userId: owned.userId, title: owned.title });
    expect(exact[0].workspace?.workspaceId).toBe(owned.workspaceId);
    const deleted = await resources.request.delete('/api/sessions', { params: { sessionId: owned.sessionId, agentId: owned.agentId } });
    expect(deleted.status(), 'The synthetic fixture session must be cleaned up.').toBe(200);
    expect(await deleted.json()).toMatchObject({ success: true, deleted: owned.sessionId });
    resources.sessions.delete(owned.sessionId);
  })();
  return owned.cleanup;
}

async function requireOwnedQAReviewFixture(request: APIRequestContext): Promise<void> {
  await requireOwnedCollaborationQaTarget();
  const response = await request.get('/api/auth/get-session');
  expect(response.status(), 'QA fixture requires an authenticated instance admin.').toBe(200);
  const session = await response.json() as { user?: { id?: string; email?: string; role?: string } };
  expect(session.user?.id).toBeTruthy();
  expect(session.user?.role).toBe('admin');
  expect(session.user?.email === (process.env.TEST_LOGIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL),
    'QA fixture admin must match the configured identity.').toBe(true);
}

const test = base.extend<{ documentReviewFlag: SeedResources }>({
  documentReviewFlag: [async ({ browser }, runFixture) => {
    const context = await createAuthenticatedContext(browser);
    const cleanupRequest = await requestFactory.newContext({
      baseURL: process.env.BASE_URL, storageState: await context.storageState(), timeout: 15_000,
    });
    const resources: SeedResources = { request: cleanupRequest, drivers: new Set(), sessions: new Map() };
    let initial: ExperimentalState | undefined;
    let owned: ExperimentalState | undefined;
    let patchAttempted = false;
    let primaryError: unknown;
    try {
      await requireOwnedQAReviewFixture(cleanupRequest);
      initial = await readExperimentalState(cleanupRequest);
      if (initial.documentReviewEnabled) owned = initial;
      else {
        patchAttempted = true;
        owned = await setScopedDocumentReview(cleanupRequest, true);
      }
      expect(owned.studioBulkEnabled).toBe(initial.studioBulkEnabled);
      expect(owned.studioBulkUpdatedAt).toBe(initial.studioBulkUpdatedAt);
      expect(await readExperimentalState(cleanupRequest)).toEqual(owned);
      await runFixture(resources);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      // A test deadline can outlive its page/request context. Stop every owned
      // native writer and await exit before restoring the instance flag.
      for (const driver of resources.drivers) {
        try { await driver.close(); } catch (error) { cleanupErrors.push(error); }
      }
      for (const session of resources.sessions.values()) {
        try {
          expect([...resources.drivers].every((driver) => driver.hasExited()), 'Do not delete a session with an owned writer still running.').toBe(true);
          await cleanupOwnedSession(resources, session);
        } catch (error) { cleanupErrors.push(error); }
      }
      try {
        expect([...resources.drivers].every((driver) => driver.hasExited()),
          'Keep Document Review enabled if an owned native writer could not be stopped.').toBe(true);
        if (initial && owned) {
          // Fail without overwriting an unexpected writer. A normal partial
          // restore records a new audit timestamp; the API cannot restore it.
          expect(await readExperimentalState(cleanupRequest), 'Document Review fixture ownership changed unexpectedly.').toEqual(owned);
          if (!initial.documentReviewEnabled) {
            const restored = await setScopedDocumentReview(cleanupRequest, initial.documentReviewEnabled);
            expect(restored.studioBulkEnabled).toBe(initial.studioBulkEnabled);
            expect(restored.studioBulkUpdatedAt).toBe(initial.studioBulkUpdatedAt);
            expect(Date.parse(restored.updatedAt!)).toBeGreaterThan(Date.parse(owned.updatedAt!));
            expect(await readExperimentalState(cleanupRequest)).toEqual(restored);
          }
        } else if (patchAttempted) {
          throw new Error('Document Review enable acknowledgment is unverified; retain state for QA inspection.');
        }
      } catch (error) { cleanupErrors.push(error); }
      try { await context.close(); }
      catch (error) { cleanupErrors.push(error); }
      try { await cleanupRequest.dispose(); }
      catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length) throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
        'Document Review fixture cleanup failed.');
    }
  }, { auto: true }],
});

async function workspaces(request: APIRequestContext): Promise<Workspace[]> {
  const response = await request.get('/api/workspaces');
  const payload = await response.json() as { workspaces?: Workspace[]; error?: string };
  expect(response.ok(), payload.error || 'Could not load workspaces').toBeTruthy();
  return payload.workspaces ?? [];
}

async function useWorkspace(context: BrowserContext, workspaceId: string): Promise<void> {
  await context.addInitScript((id) => {
    window.localStorage.setItem('canvas.activeWorkspaceId', id);
    window.localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspaceId);
}

async function createVersionedMarkdown(input: {
  request: APIRequestContext;
  workspaceId: string;
  filePath: string;
}): Promise<void> {
  await uploadWorkspaceTextFile({
    request: input.request,
    workspaceId: input.workspaceId,
    filePath: input.filePath,
    content: '# Version history fixture\n\nRevision marker 1\n',
  });
}

async function runAgentTool(input: {
  driver: PersistentAgentToolDriver;
  toolName: 'read' | 'edit_file';
  params: Record<string, unknown>;
  context: Record<string, unknown>;
}): Promise<ToolResult> {
  const started = Date.now();
  const result = await input.driver.execute({ toolName: input.toolName, params: input.params, context: input.context });
  console.log('[version-center seed]', JSON.stringify({ phase: input.toolName, elapsedMs: Date.now() - started,
    isError: result.isError === true, code: result.details?.code, outcome: result.details?.outcome,
    operationId: result.details?.collaboration?.operationId, reviewRequired: result.details?.collaboration?.reviewRequired }));
  return result;
}

async function seedAgentRevisions(input: {
  request: APIRequestContext;
  resources: SeedResources;
  workspace: Workspace;
  filePath: string;
  revisions: number;
}): Promise<void> {
  const sessionResponse = await input.request.get('/api/auth/get-session');
  const auth = await sessionResponse.json() as { user?: { id?: string } } | null;
  expect(sessionResponse.ok()).toBeTruthy();
  expect(auth?.user?.id).toBeTruthy();
  const title = `File version center browser fixture ${randomUUID()}`;
  const created = await input.request.post('/api/sessions', {
    headers: { [WORKSPACE_ID_HEADER]: input.workspace.id },
    data: {
      agentId: MAIN_AGENT_ID,
      workspaceId: input.workspace.id,
      title,
    },
  });
  expect(created.ok(), 'Create the real API fixture session.').toBeTruthy();
  const stored = (await created.json()).session as { sessionId: string; agentId: string };
  expect(typeof stored?.sessionId === 'string' && stored.sessionId.length > 0
    && typeof stored.agentId === 'string' && stored.agentId.length > 0,
  'Successful creation must acknowledge concrete session and agent IDs.').toBe(true);
  const owned: OwnedSession = { sessionId: stored.sessionId, agentId: stored.agentId,
    userId: auth!.user!.id!, workspaceId: input.workspace.id, title };
  input.resources.sessions.set(owned.sessionId, owned);
  expect(stored.agentId).toBe(MAIN_AGENT_ID);
  const context = {
    userId: auth!.user!.id!,
    sessionId: stored.sessionId,
    agentId: stored.agentId,
    workspaceId: input.workspace.id,
    workspaceType: input.workspace.type,
    workspaceName: input.workspace.name,
    organizationId: input.workspace.organizationId ?? null,
    customerId: input.workspace.customerId ?? null,
    projectId: input.workspace.projectId ?? null,
    workspaceRoot: path.resolve(process.env.DATA || 'data', input.workspace.rootRelativePath),
    workspaceRootRelativePath: input.workspace.rootRelativePath,
    canWrite: true,
    canDelete: false,
    canShare: false,
    legacy: Boolean(input.workspace.legacy),
  };
  const driver = new PersistentAgentToolDriver();
  input.resources.drivers.add(driver);
  let primaryError: unknown;
  try {
    for (let version = 2; version <= input.revisions; version += 1) {
      console.log('[version-center seed]', JSON.stringify({ phase: 'revision-start', version }));
      const read = await runAgentTool({ driver, toolName: 'read', params: { path: input.filePath }, context });
      expect(read.isError, read.details?.code || 'Version fixture read must succeed.').not.toBe(true);
      expect(read.details?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const edited = await runAgentTool({
        driver,
        toolName: 'edit_file',
        params: {
          path: input.filePath,
          expectedSha256: read.details!.sha256,
          oldText: `Revision marker ${version - 1}`,
          newText: `Revision marker ${version}`,
        },
        context,
      });
      expect(edited.isError, edited.details?.code || 'Version fixture edit must succeed.').not.toBe(true);
      const collaboration = edited.details?.collaboration;
      expect(collaboration?.operationId).toBeTruthy();
      if (collaboration?.reviewRequired) {
        const operationResponse = await input.request.get(
          `/api/files/collaboration/operations/${collaboration.operationId}`,
          { headers: { [WORKSPACE_ID_HEADER]: input.workspace.id } },
        );
        const operationPayload = await operationResponse.json() as {
          operation?: { proposalVersion?: string | null };
        };
        expect(operationResponse.ok()).toBeTruthy();
        expect(operationPayload.operation?.proposalVersion).toMatch(/^v1\.[a-f0-9]{64}$/u);
        const accepted = await input.request.post(
          `/api/files/collaboration/operations/${collaboration.operationId}/accept`,
          {
            headers: { [WORKSPACE_ID_HEADER]: input.workspace.id },
            data: {
              idempotencyKey: `version-center-accept-${randomUUID()}`,
              proposalVersion: operationPayload.operation!.proposalVersion,
            },
          },
        );
        expect(accepted.ok(), 'The actual user must accept the exact proposal version.').toBeTruthy();
        console.log('[version-center seed]', JSON.stringify({ phase: 'human-accepted', version, operationId: collaboration.operationId }));
      }
      console.log('[version-center seed]', JSON.stringify({ phase: 'revision-complete', version }));
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try { await driver.close(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length === 0) input.resources.drivers.delete(driver);
    try {
      expect(driver.hasExited(), 'Do not delete a session with an owned writer still running.').toBe(true);
      await cleanupOwnedSession(input.resources, owned);
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
      'Agent revision seed cleanup failed.');
  }
}

async function resolveTimeline(
  request: APIRequestContext,
  workspaceId: string,
  filePath: string,
): Promise<Timeline> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await request.post('/api/files/version-center/v1/resolve', {
      headers: { [WORKSPACE_ID_HEADER]: workspaceId },
      data: {
        contractVersion: 1,
        target: { kind: 'path', workspaceId, pathHint: filePath },
        initialView: 'history',
        source: 'file_browser',
      },
    });
    const payload = await response.json() as Timeline & {
      error?: { code?: string; message?: string };
    };
    if (response.ok()) return payload;
    if (payload.error?.code !== 'FVRC_PERSISTENCE_UNAVAILABLE' || attempt === 5) {
      expect(
        response.ok(),
        `${filePath}: ${payload.error?.message || 'Could not resolve file timeline'}`,
      ).toBeTruthy();
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error('Could not resolve file timeline');
}

async function removeFile(request: APIRequestContext, workspaceId: string, filePath: string): Promise<void> {
  const response = await request.delete('/api/files/delete', {
    headers: { [WORKSPACE_ID_HEADER]: workspaceId },
    data: { path: filePath },
  });
  expect(response.ok(), `Could not delete ${filePath}: ${await response.text()}`).toBeTruthy();
}

async function openEditorHistory(page: Page): Promise<void> {
  const historyButton = page.getByRole('button', {
    name: /^(?:Version history|Versionshistorie)(?: \(view only\)| \(nur ansehen\))?$/iu,
  });
  await expect(historyButton).toBeEnabled({ timeout: 30_000 });
  await historyButton.click();
  await expect(page.getByTestId('file-version-center')).toBeVisible();
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshotPath, type: 'png', animations: 'disabled' });
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
}

test.describe('Global file version center', () => {
  test.setTimeout(180_000);

  test('keeps personal and team capabilities aligned and exposes every document entry point', async ({ browser, documentReviewFlag }, testInfo) => {
    const context = await createAuthenticatedContext(browser, { viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    const suffix = randomUUID();
    const personalPath = `version-center-personal-${suffix}.md`;
    const teamPath = `version-center-team-${suffix}.md`;
    let personalWorkspaceId: string | null = null;
    let teamWorkspaceId: string | null = null;
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      const available = await workspaces(page.request);
      const personal = available.find((workspace) => workspace.type === 'personal' && workspace.permissions.canWrite);
      const team = available.find((workspace) => workspace.name === 'Shared Test Workspace' && workspace.permissions.canWrite);
      expect(personal, 'A writable personal workspace is required').toBeTruthy();
      expect(team, 'The writable managed Team workspace is required').toBeTruthy();
      personalWorkspaceId = personal!.id;
      teamWorkspaceId = team!.id;

      await createVersionedMarkdown({
        request: page.request,
        workspaceId: personalWorkspaceId,
        filePath: personalPath,
      });
      await createVersionedMarkdown({
        request: page.request,
        workspaceId: teamWorkspaceId,
        filePath: teamPath,
      });
      await seedAgentRevisions({ request: page.request, resources: documentReviewFlag, workspace: team!, filePath: teamPath, revisions: 9 });

      const personalTimeline = await resolveTimeline(page.request, personalWorkspaceId, personalPath);
      const teamTimeline = await resolveTimeline(page.request, teamWorkspaceId, teamPath);
      expect(personalTimeline.capabilities).toMatchObject({
        history: true,
        compare: true,
        restore: true,
        agentReviewPolicy: true,
      });
      for (const capability of ['history', 'compare', 'restore', 'agentReviewPolicy'] as const) {
        expect(teamTimeline.capabilities[capability]).toBe(personalTimeline.capabilities[capability]);
      }
      expect(personalTimeline.policy?.effectiveMode).toBe('safe_direct');
      expect(teamTimeline.policy?.effectiveMode).toBe('safe_direct');

      await useWorkspace(context, teamWorkspaceId);
      await page.goto(`/notebook?path=${encodeURIComponent(teamPath)}`, { waitUntil: 'domcontentloaded' });
      await enterMarkdownEditMode(page);
      await expect(page.locator('.tiptap-editor-shell .ProseMirror')).toBeVisible({ timeout: 30_000 });

      const policyControl = page.locator('[data-file-review-policy]');
      const reviewSwitch = policyControl.getByRole('switch');
      await expect(policyControl).toHaveAttribute('data-file-review-policy', 'safe_direct', { timeout: 30_000 });
      await expect(reviewSwitch).not.toBeChecked();
      await reviewSwitch.click();
      await expect(policyControl).toHaveAttribute('data-file-review-policy', 'review_required');
      await expect(reviewSwitch).toBeChecked();
      await reviewSwitch.click();
      await expect(policyControl).toHaveAttribute('data-file-review-policy', 'safe_direct');
      await expect(reviewSwitch).not.toBeChecked();

      await openEditorHistory(page);
      const center = page.getByTestId('file-version-center');
      const revisions = center.locator('[data-entry-kind="revision"]');
      await expect.poll(() => revisions.count()).toBeGreaterThanOrEqual(9);
      const modelRequests: string[] = [];
      const recordModelRequest = (request: { url(): string }) => {
        if (/\/api\/(?:agent-runtime|chat)(?:\/|$)/u.test(new URL(request.url()).pathname)) {
          modelRequests.push(request.url());
        }
      };
      page.on('request', recordModelRequest);
      await revisions.last().click();
      await expect(center.getByRole('tab', { name: /^(?:Changes|Änderungen)$/iu })).toBeVisible({ timeout: 20_000 });
      await expect(center).toContainText(/Compared with the current authoritative document|Mit dem aktuellen autoritativen Dokument verglichen/iu);
      page.off('request', recordModelRequest);
      expect(modelRequests, 'Historical comparison must not call an AI runtime').toEqual([]);
      await attachScreenshot(page, testInfo, 'file-version-center-desktop');

      await page.keyboard.press('Escape');
      await expect(center).toBeHidden();

      const toolbar = page.getByTestId('notebook-toolbar');
      const showSidebar = toolbar.getByRole('button', { name: /^(?:Show sidebar|Sidebar einblenden)$/iu });
      if (await showSidebar.isVisible()) await showSidebar.click();
      await expect(toolbar.getByRole('button', { name: /^(?:Hide sidebar|Sidebar ausblenden)$/iu }))
        .toHaveAttribute('aria-pressed', 'true');
      const browserRow = page.locator(`[data-file-path="${teamPath}"]`).first();
      await expect(browserRow).toBeVisible();
      await browserRow.click({ button: 'right' });
      const browserMenuItem = page.locator('[role="menu"]:visible').last().getByTestId('file-version-menu-item');
      await expect(browserMenuItem).toHaveAttribute('data-file-version-capability', 'full', { timeout: 30_000 });
      await browserMenuItem.click();
      await expect(center).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(center).toBeHidden();
      await page.getByRole('button', { name: /^(?:File actions|Dateiaktionen)$/iu }).click();
      const editorMenuItem = page.locator('[role="menu"]:visible').last().getByTestId('file-version-menu-item');
      await expect(editorMenuItem).toHaveAttribute('data-file-version-capability', 'full', { timeout: 30_000 });
      await editorMenuItem.click();
      await expect(center).toBeVisible();

      await page.setViewportSize({ width: 760, height: 900 });
      const narrowFit = await center.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          viewportWidth: window.innerWidth,
        };
      });
      expect(narrowFit.left).toBeGreaterThanOrEqual(0);
      expect(narrowFit.right).toBeLessThanOrEqual(narrowFit.viewportWidth);
      expect(narrowFit.scrollWidth).toBeLessThanOrEqual(narrowFit.clientWidth);
      await attachScreenshot(page, testInfo, 'file-version-center-narrow');
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close().catch(() => undefined);
      if (teamWorkspaceId) await removeFile(context.request, teamWorkspaceId, teamPath).catch(() => undefined);
      if (personalWorkspaceId) await removeFile(context.request, personalWorkspaceId, personalPath).catch(() => undefined);
      await context.close();
    }
  });

  test('keeps card gutters and the current/history divider inside the mobile scroll area', async ({ browser, documentReviewFlag }, testInfo) => {
    const context = await createAuthenticatedContext(browser, {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const filePath = `version-center-mobile-${randomUUID()}.md`;
    let workspaceId: string | null = null;

    try {
      const available = await workspaces(page.request);
      const team = available.find((workspace) => workspace.name === 'Shared Test Workspace' && workspace.permissions.canWrite);
      expect(team, 'The writable managed Team workspace is required').toBeTruthy();
      workspaceId = team!.id;
      await createVersionedMarkdown({
        request: page.request,
        workspaceId,
        filePath,
      });
      await seedAgentRevisions({ request: page.request, resources: documentReviewFlag, workspace: team!, filePath, revisions: 10 });
      await useWorkspace(context, workspaceId);
      await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
      await openEditorHistory(page);

      const center = page.getByTestId('file-version-center');
      const timeline = center.getByRole('navigation');
      const viewport = timeline.locator('[data-slot="scroll-area-viewport"]');
      const historySection = center.getByTestId('file-version-history-section');
      await expect.poll(() => center.locator('[data-entry-kind="revision"]').count()).toBeGreaterThanOrEqual(10);
      await expect(historySection).toHaveCSS('border-top-style', 'solid');

      const fit = await center.evaluate((element) => ({
        centerScrollWidth: element.scrollWidth,
        centerClientWidth: element.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        documentClientWidth: document.documentElement.clientWidth,
      }));
      expect(fit.centerScrollWidth).toBeLessThanOrEqual(fit.centerClientWidth);
      expect(fit.documentScrollWidth).toBeLessThanOrEqual(fit.documentClientWidth);

      const navBox = await timeline.boundingBox();
      const firstCardBox = await center.locator('[data-entry-kind="current"]').boundingBox();
      expect(navBox).toBeTruthy();
      expect(firstCardBox).toBeTruthy();
      const leftGutter = firstCardBox!.x - navBox!.x;
      const rightGutter = navBox!.x + navBox!.width - (firstCardBox!.x + firstCardBox!.width);
      expect(leftGutter).toBeGreaterThanOrEqual(15);
      expect(leftGutter).toBeLessThanOrEqual(17);
      expect(Math.abs(leftGutter - rightGutter)).toBeLessThanOrEqual(1);

      const beforeTop = (await historySection.boundingBox())!.y;
      const scrollState = await viewport.evaluate((element) => {
        const target = element as HTMLElement;
        const canScroll = target.scrollHeight > target.clientHeight;
        target.scrollTop = Math.min(160, target.scrollHeight - target.clientHeight);
        target.dispatchEvent(new Event('scroll'));
        return { canScroll, scrollTop: target.scrollTop };
      });
      expect(scrollState.canScroll).toBe(true);
      expect(scrollState.scrollTop).toBeGreaterThan(0);
      const afterTop = (await historySection.boundingBox())!.y;
      expect(afterTop).toBeLessThan(beforeTop - 40);
      await attachScreenshot(page, testInfo, 'file-version-center-mobile-dark');
    } finally {
      await page.close().catch(() => undefined);
      if (workspaceId) await removeFile(context.request, workspaceId, filePath).catch(() => undefined);
      await context.close();
    }
  });
});
