import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as decoding from 'lib0/decoding';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3100';
const PHASE = process.env.COLLABORATION_RESTART_PHASE;
const STATE_FILE = process.env.COLLABORATION_RESTART_STATE;
const CONTAINER = 'canvas-local-prod-notebook';
const WORKSPACE_ID_HEADER = 'x-canvas-workspace-id';
const execFileAsync = promisify(execFile);
const initialContent = 'Agent draft\n\nPeer paragraph\n';
const editedContent = 'Agent approved\n\nPeer paragraph while output failed while output waited\n';
type Workspace = { id: string; name: string; type: string; rootRelativePath: string;
  organizationId?: string; customerId?: string; projectId?: string; legacy?: boolean;
  permissions: { canWrite: boolean; canDelete?: boolean; canCreatePublicLinks?: boolean } };
type Receipt = { operationId: string; status: string; resultHash: string; snapshotHash: string;
  reverseHash: string; appliedAt: number; persistedAt: number; casVersion: number };
type StorageEvidence = { documentId: string; generation: number; documentSequence: number; checkpointSequence: number;
  canonicalContent: string; binaryHash: string; stateProof: string; degraded: boolean; receipt: Receipt | null };
type Ack = { type: string; documentId: string; lifecycleGeneration: number; documentSequence: number;
  checkpointSequence: number; stateProof: string; code?: string };
type ProcessIdentity = { id: string; startedAt: string; pid: number; user: string };
type RestartState = { filePath: string; workspace: Workspace; sessionId: string; operationId: string;
  directory: string; originalMode: number | null; prepared: boolean; evidence: StorageEvidence; process: ProcessIdentity; acks: Ack[] };

async function fixtureContext(browser: Browser): Promise<BrowserContext> {
  const { baseURL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor } = test.info().project.use;
  return browser.newContext({ baseURL: baseURL || BASE_URL, viewport, isMobile, hasTouch, userAgent, deviceScaleFactor });
}

function assertOwnedFixture(state: RestartState): void {
  expect(state.workspace.name).toBe('Shared Test Workspace');
  expect(state.filePath).toMatch(/^collaboration-restart-[a-f0-9-]+\/document\.md$/u);
  expect(path.isAbsolute(state.workspace.rootRelativePath)).toBe(false);
  expect(state.workspace.rootRelativePath.split(/[\\/]/u)).not.toContain('..');
  expect(state.directory).toBe(path.resolve(process.env.DATA!, state.workspace.rootRelativePath, path.posix.dirname(state.filePath)));
  if (state.originalMode !== null) {
    expect(Number.isInteger(state.originalMode)).toBe(true);
    expect(state.originalMode).toBeGreaterThanOrEqual(0);
    expect(state.originalMode).toBeLessThanOrEqual(0o777);
  }
}

async function paragraphEnd(paragraph: Locator): Promise<void> {
  await paragraph.click();
  await paragraph.press('End');
}

async function login(page: Page, peer = false): Promise<string> {
  const email = peer ? process.env.TEST_SECONDARY_EMAIL : process.env.TEST_LOGIN_EMAIL;
  const password = peer ? process.env.TEST_SECONDARY_PASSWORD : process.env.TEST_LOGIN_PASSWORD;
  expect(Boolean(email && password), 'Managed fixture credentials must be configured.').toBe(true);
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: BASE_URL }, data: { email, password },
  });
  expect(response.ok(), 'Managed fixture login must succeed.').toBe(true);
  return (await (await page.request.get('/api/auth/get-session')).json()).user.id;
}

async function organizationWorkspace(page: Page): Promise<Workspace> {
  const response = await page.request.get('/api/workspaces');
  expect(response.ok()).toBe(true);
  const payload = await response.json() as { workspaces: Workspace[] };
  const workspace = payload.workspaces.find((item) => item.name === 'Shared Test Workspace' && item.permissions.canWrite);
  expect(workspace, 'Use the existing managed shared fixture, never create another workspace.').toBeTruthy();
  return workspace!;
}

async function useWorkspace(context: BrowserContext, workspaceId: string): Promise<void> {
  await context.addInitScript((id) => {
    localStorage.setItem('canvas.activeWorkspaceId', id);
    localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspaceId);
}

async function openEditor(page: Page, filePath: string): Promise<Locator> {
  await page.goto(`/notebook?path=${encodeURIComponent(filePath)}`, { waitUntil: 'domcontentloaded' });
  const editor = page.locator('.tiptap-editor-shell .ProseMirror');
  await page.getByRole('group', { name: /Document view|Dokumentansicht/u })
    .getByRole('button', { name: /^(Edit|Bearbeiten)$/u }).click();
  await expect(editor).toHaveAttribute('contenteditable', 'true', { timeout: 30_000 });
  return editor;
}

async function editorText(editor: Locator): Promise<string> {
  return editor.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.collaboration-carets__label').forEach((label) => label.remove());
    return clone.textContent || '';
  });
}

function observeAcks(page: Page): Ack[] {
  const acks: Ack[] = [];
  page.on('websocket', (socket) => {
    if (!new URL(socket.url()).pathname.startsWith('/ws/collaboration')) return;
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') return;
      try {
        const decoder = decoding.createDecoder(new Uint8Array(payload));
        decoding.readVarString(decoder); // Hocuspocus room routing key, never a token.
        const type = decoding.readVarUint(decoder);
        if (type !== 5 && type !== 6) return;
        const message = JSON.parse(decoding.readVarString(decoder)) as Ack;
        if (!['durability_snapshot', 'projection_failed', 'checkpointed'].includes(message.type)) return;
        // Retain only public durability evidence, never raw frames or authentication messages.
        acks.push({ type: message.type, documentId: message.documentId,
          lifecycleGeneration: message.lifecycleGeneration, documentSequence: message.documentSequence,
          checkpointSequence: message.checkpointSequence, stateProof: message.stateProof, code: message.code });
      } catch { /* Other protocol messages are not durability evidence. */ }
    });
  });
  return acks;
}

async function runDriver<T>(script: string, input: Record<string, unknown>): Promise<T> {
  const { stdout } = await execFileAsync(path.join(process.cwd(), 'node_modules/.bin/tsx'),
    ['--conditions', 'react-server', script, Buffer.from(JSON.stringify(input)).toString('base64url')],
    { cwd: process.cwd(), env: process.env, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

async function processIdentity(): Promise<ProcessIdentity> {
  const { stdout } = await execFileAsync('docker', ['inspect', '--format',
    '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"pid":{{.State.Pid}},"user":{{json .Config.User}}}', CONTAINER]);
  const identity = JSON.parse(stdout) as ProcessIdentity;
  expect(identity.pid).toBeGreaterThan(0);
  expect(identity.user).toBe('node');
  const { stdout: uid } = await execFileAsync('docker', ['exec', CONTAINER, 'id', '-u']);
  expect(Number(uid.trim()), 'The actual application user must not bypass the directory fault as root.').toBeGreaterThan(0);
  return identity;
}

async function holdWorkspaceOutput(workspaceId: string): Promise<() => Promise<void>> {
  expect(process.env.COLLABORATION_RESTART_EXCLUSIVE, 'The workspace-wide output fence requires the coordinated exclusive window.').toBe('1');
  const lockPath = `/data/canvas-file-locks/${createHash('sha256').update(workspaceId).digest('hex')}.lock`;
  // The real Linux kernel fence is cancellable before acquisition and has a bounded
  // lease. If a runner dies, stdin EOF releases it; a hung runner fails after 25s.
  const python = [
    'import fcntl,select,sys,time',
    'f=open(sys.argv[1],"r+")',
    'deadline=time.monotonic()+9',
    'while True:',
    ' try:',
    '  fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',
    '  break',
    ' except BlockingIOError:',
    '  if time.monotonic()>deadline: sys.exit(2)',
    '  if select.select([sys.stdin],[],[],0.05)[0] and not sys.stdin.read(1): sys.exit(0)',
    'print("locked",flush=True)',
    'if not select.select([sys.stdin],[],[],25)[0]: sys.exit(3)',
    'sys.stdin.read()',
  ].join('\n');
  const holder = spawn('docker', ['exec', '-i', CONTAINER, 'python3', '-c', python, lockPath],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  holder.stderr.on('data', (data) => { diagnostics += String(data); });
  const exited = new Promise<void>((resolve, reject) => {
    holder.on('error', reject);
    holder.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Output lease failed (${code}): ${diagnostics}`)));
  });
  // Attach the rejection handler immediately, including failures before the ready line.
  void exited.catch(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Output lease acquisition timed out.')), 10_000);
      holder.stdout.once('data', (data) => {
        clearTimeout(timer);
        if (String(data).includes('locked')) resolve();
        else reject(new Error('Invalid output lease signal.'));
      });
      holder.once('exit', () => { clearTimeout(timer); reject(new Error('Output lease exited before acquisition.')); });
      holder.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  } catch (error) { holder.stdin.end(); await exited.catch(() => undefined); throw error; }
  return async () => { holder.stdin.end(); await exited; };
}

async function cleanup(page: Page, state: RestartState): Promise<void> {
  assertOwnedFixture(state);
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<void>) => { try { await operation(); } catch (error) { failures.push(error); } };
  await attempt(async () => {
    if (state.originalMode !== null) await chmod(state.directory, state.originalMode).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  });
  const headers = { [WORKSPACE_ID_HEADER]: state.workspace.id };
  if (state.operationId) await attempt(async () => {
    // Reject only an outstanding proposal; the real endpoint leaves confirmed terminal receipts intact.
    const response = await page.request.post(`/api/files/collaboration/operations/${state.operationId}/reject`, {
      headers, data: { idempotencyKey: `restart-cleanup-${state.operationId}` },
    });
    expect(response.ok() || response.status() === 404, 'The owned proposal must be settled during cleanup.').toBe(true);
  });
  if (state.sessionId) await attempt(async () => {
    const response = await page.request.delete('/api/sessions', { headers,
      params: { sessionId: state.sessionId, agentId: 'canvas-agent', workspaceId: state.workspace.id } });
    expect(response.ok() || response.status() === 404, 'The owned agent session must be removed.').toBe(true);
  });
  await attempt(async () => {
    const response = await page.request.delete('/api/files/delete', { headers, data: { path: path.posix.dirname(state.filePath) } });
    expect(response.ok() || response.status() === 404, 'The owned restart fixture directory must be removed.').toBe(true);
  });
  if (failures.length) throw new AggregateError(failures, 'Restart fixture cleanup was incomplete; retain the private state file.');
}

test.describe('collaboration process restart durability', () => {
  test.skip(process.env.COLLABORATION_E2E !== '1' || !STATE_FILE || (PHASE !== 'prepare' && PHASE !== 'verify'),
    'Requires the explicit two-phase managed stack restart profile and a private state file.');
  test.setTimeout(PHASE === 'verify' ? 390_000 : 150_000);

  test('preserves a confirmed Yjs operation before file output, while peers outlive failed and slow export', async ({ browser }, testInfo) => {
    expect(new URL(BASE_URL).origin).toBe('http://127.0.0.1:3100');
    const ownerContext = await fixtureContext(browser);
    const peerContext = await fixtureContext(browser);
    const owner = await ownerContext.newPage();
    const peer = await peerContext.newPage();
    const ownerAcks = observeAcks(owner);
    const peerAcks = observeAcks(peer);
    let state: RestartState | undefined;
    let preserveForRestart = false;
    let ownsStateFile = false;
    let releaseOutput: (() => Promise<void>) | undefined;
    try {
      if (PHASE === 'verify') {
        const restoredState = JSON.parse(await readFile(STATE_FILE!, 'utf8')) as RestartState;
        assertOwnedFixture(restoredState);
        state = restoredState; ownsStateFile = true;
        expect(state.prepared, 'Only a fully completed prepare phase may be verified.').toBe(true);
      }
      const userId = await login(owner);
      expect(await login(peer, true)).not.toBe(userId);
      if (PHASE === 'prepare') {
        expect(process.env.COLLABORATION_RESTART_EXCLUSIVE).toBe('1');
        await writeFile(STATE_FILE!, JSON.stringify({ prepared: false }), { mode: 0o600, flag: 'wx' });
        ownsStateFile = true;
        const processBefore = await processIdentity();
        const workspace = await organizationWorkspace(owner);
        expect((await organizationWorkspace(peer)).id).toBe(workspace.id);
        const directoryName = `collaboration-restart-${randomUUID()}`;
        const filePath = `${directoryName}/document.md`;
        const workspaceRoot = path.resolve(process.env.DATA!, workspace.rootRelativePath);
        const directory = path.join(workspaceRoot, directoryName);
        const headers = { [WORKSPACE_ID_HEADER]: workspace.id };
        const created = await owner.request.post('/api/files/create', { headers, data: { path: directoryName, type: 'directory' } });
        expect(created.ok()).toBe(true);
        state = { filePath, workspace, directory, originalMode: null, prepared: false,
          sessionId: '', operationId: '', evidence: {} as StorageEvidence, process: processBefore, acks: [] };
        state.originalMode = (await stat(directory)).mode & 0o777;
        await writeFile(STATE_FILE!, JSON.stringify(state, null, 2), { mode: 0o600 });
        const upload = await owner.request.post('/api/files/upload', { headers, multipart: { path: directoryName,
          files: { name: 'document.md', mimeType: 'text/markdown', buffer: Buffer.from(initialContent) } } });
        expect(upload.ok()).toBe(true);
        await Promise.all([useWorkspace(ownerContext, workspace.id), useWorkspace(peerContext, workspace.id)]);
        const [editor, peerEditor] = await Promise.all([openEditor(owner, filePath), openEditor(peer, filePath)]);
        await expect.poll(() => editorText(peerEditor)).toBe('Agent draftPeer paragraph');
        const session = await owner.request.post('/api/sessions', { headers,
          data: { agentId: 'canvas-agent', workspaceId: workspace.id, title: 'Restart durability acceptance' } });
        expect(session.ok()).toBe(true);
        const storedSession = (await session.json()).session;
        state.sessionId = storedSession.sessionId;
        expect(state.sessionId).toBeTruthy();
        expect(storedSession.agentId).toBeTruthy();
        const agentContext = { userId, sessionId: state.sessionId, agentId: storedSession.agentId, workspaceId: workspace.id,
          workspaceType: workspace.type, workspaceName: workspace.name, organizationId: workspace.organizationId || null,
          customerId: workspace.customerId || null, projectId: workspace.projectId || null, workspaceRoot,
          workspaceRootRelativePath: workspace.rootRelativePath, canWrite: true,
          canDelete: workspace.permissions.canDelete !== false, canShare: workspace.permissions.canCreatePublicLinks !== false,
          legacy: Boolean(workspace.legacy) };
        const read = await runDriver<{ details: { document: { documentId: string }; sha256: string } }>(
          'scripts/collaboration-agent-tool-driver.ts', { toolName: 'read', toolCallId: randomUUID(),
            params: { path: filePath, includeStructure: true }, context: agentContext });
        const documentId = read.details.document.documentId;
        // Record the owned path/mode before injecting a fault, so an interrupted runner can be cleaned up.
        await writeFile(STATE_FILE!, JSON.stringify(state, null, 2), { mode: 0o600 });
        await chmod(directory, 0o555);
        expect((await stat(directory)).mode & 0o777).toBe(0o555);
        const proposal = await runDriver<{ details: { collaboration: { operationId: string; reviewRequired: boolean } } }>(
          'scripts/collaboration-agent-tool-driver.ts', { toolName: 'edit_file', toolCallId: randomUUID(),
            params: { path: filePath, expectedSha256: read.details.sha256, oldText: 'Agent draft', newText: 'Agent approved' }, context: agentContext });
        expect(proposal.details.collaboration.reviewRequired).toBe(true);
        state.operationId = proposal.details.collaboration.operationId;
        await writeFile(STATE_FILE!, JSON.stringify(state, null, 2), { mode: 0o600 });
        const operationUrl = `/api/files/collaboration/operations/${state.operationId}`;
        const version = (await (await owner.request.get(operationUrl, { headers })).json()).operation.proposalVersion;
        // This authenticated approval executes the real app-process room bridge; the host worker only proposes.
        const accepted = await owner.request.post(`${operationUrl}/accept`, { headers,
          data: { idempotencyKey: randomUUID(), proposalVersion: version } });
        expect(accepted.ok(), await accepted.text()).toBe(true);
        expect((await accepted.json()).operation).toMatchObject({ operationStatus: 'persisted_yjs', durability: 'persisted_yjs', conflicts: [] });
        await expect.poll(() => editorText(peerEditor)).toContain('Agent approved');
        await expect.poll(() => ownerAcks.some((ack) => ack.documentId === documentId && ack.type === 'projection_failed'), { timeout: 20_000 }).toBe(true);
        await expect(owner.getByTestId('markdown-save-state')).toHaveCount(0);
        await expect(peer.getByTestId('markdown-save-state')).toHaveCount(0);
        const peerParagraph = peerEditor.locator('p').filter({ hasText: 'Peer paragraph' });
        await paragraphEnd(peerParagraph);
        await peer.keyboard.insertText(' while output failed');
        await expect.poll(() => editorText(editor)).toContain('Peer paragraph while output failed');
        const readStorage = () => runDriver<StorageEvidence>('scripts/collaboration-e2e-storage-read.ts',
          { documentId, workspaceId: workspace.id, path: filePath, operationId: state!.operationId });
        await expect.poll(async () => (await readStorage()).canonicalContent).toContain('while output failed');
        const beforeSlow = await readStorage();
        releaseOutput = await holdWorkspaceOutput(workspace.id);
        await chmod(directory, state.originalMode);
        await paragraphEnd(peerParagraph);
        await peer.keyboard.insertText(' while output waited');
        await expect.poll(() => editorText(editor)).toContain('while output waited');
        await expect.poll(async () => (await readStorage()).canonicalContent).toBe(editedContent);
        const whileSlow = await readStorage();
        expect(whileSlow.documentSequence).toBeGreaterThan(beforeSlow.documentSequence);
        await expect.poll(() => peerAcks.some((ack) => ack.documentId === documentId
          && ack.stateProof === whileSlow.stateProof && ack.type === 'durability_snapshot')).toBe(true);
        // Keep the lease beyond the real 2s export idle deadline; peer sockets and persistence remain active.
        await owner.waitForTimeout(3_000);
        expect(await readFile(path.join(directory, 'document.md'), 'utf8')).toBe(initialContent);
        await expect(editor).toHaveAttribute('contenteditable', 'true');
        await expect(peerEditor).toHaveAttribute('contenteditable', 'true');
        await expect(owner.getByTestId('markdown-save-state')).toHaveCount(0);
        await expect(peer.getByTestId('markdown-save-state')).toHaveCount(0);
        await chmod(directory, 0o555);
        await releaseOutput(); releaseOutput = undefined;
        state.evidence = await readStorage();
        expect(state.evidence.canonicalContent).toBe(editedContent);
        expect(state.evidence.documentSequence).toBeGreaterThan(state.evidence.checkpointSequence);
        expect(state.evidence.degraded).toBe(false);
        expect(state.evidence.receipt).toMatchObject({ operationId: state.operationId, status: 'persisted_yjs',
          snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/u), reverseHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
        expect(state.evidence.receipt!.persistedAt).toBeGreaterThan(0);
        expect(await readFile(path.join(directory, 'document.md'), 'utf8')).toBe(initialContent);
        state.acks = [...ownerAcks, ...peerAcks].filter((ack) => ack.documentId === documentId);
        expect(releaseOutput, 'No workspace-wide lock may cross the process restart boundary.').toBeUndefined();
        state.prepared = true;
        await writeFile(STATE_FILE!, JSON.stringify(state, null, 2), { mode: 0o600 });
        await testInfo.attach('durable state before process restart', { body: Buffer.from(JSON.stringify(state.evidence)), contentType: 'application/json' });
        preserveForRestart = true;
      } else {
        if (!state) throw new Error('The prepared restart fixture is missing.');
        expect((await organizationWorkspace(owner)).id).toBe(state.workspace.id);
        expect((await organizationWorkspace(peer)).id).toBe(state.workspace.id);
        expect(state.originalMode).not.toBeNull();
        const processNow = await processIdentity();
        expect(processNow.startedAt, 'The Notebook process must actually restart between phases.').not.toBe(state.process.startedAt);
        expect((await stat(state.directory)).mode & 0o777).toBe(0o555);
        expect(await readFile(path.join(state.directory, 'document.md'), 'utf8')).toBe(initialContent);
        await Promise.all([useWorkspace(ownerContext, state.workspace.id), useWorkspace(peerContext, state.workspace.id)]);
        const [editor, peerEditor] = await Promise.all([openEditor(owner, state.filePath), openEditor(peer, state.filePath)]);
        await expect.poll(() => editorText(editor)).toBe(editedContent.replace(/\n/gu, ''));
        await expect.poll(() => editorText(peerEditor)).toBe(editedContent.replace(/\n/gu, ''));
        const restored = await runDriver<StorageEvidence>('scripts/collaboration-e2e-storage-read.ts', {
          documentId: state.evidence.documentId, workspaceId: state.workspace.id, path: state.filePath, operationId: state.operationId });
        expect(restored.stateProof).toBe(state.evidence.stateProof);
        expect(restored.generation).toBe(state.evidence.generation);
        expect(restored.canonicalContent).toBe(state.evidence.canonicalContent);
        expect(restored.receipt, 'No replay or new receipt may replace the confirmed operation after restart.').toEqual(state.evidence.receipt);
        expect(restored.documentSequence).toBeGreaterThan(restored.checkpointSequence);
        await expect(owner.getByTestId('markdown-save-state')).toHaveCount(0);
        await expect(peer.getByTestId('markdown-save-state')).toHaveCount(0);
        expect(await readFile(path.join(state.directory, 'document.md'), 'utf8')).toBe(initialContent);
        await chmod(state.directory, state.originalMode!);
        // Startup scan plus bounded retry must publish without another edit. Allow the real 300s
        // retry ceiling if a slow browser login exhausts the initial 1/2/4/8s attempts.
        await expect.poll(() => readFile(path.join(state!.directory, 'document.md'), 'utf8'), { timeout: 320_000 }).toBe(editedContent);
        await testInfo.attach('restored receipt and process identity', { body: Buffer.from(JSON.stringify({ previousProcess: state.process,
          processNow, beforeOutput: restored })), contentType: 'application/json' });
      }
    } finally {
      const failures: unknown[] = [];
      // Always release the probe before attempting network cleanup, even if restoring mode fails.
      if (releaseOutput) {
        try { await releaseOutput(); } catch (error) { failures.push(error); }
        releaseOutput = undefined;
      }
      if (!preserveForRestart && ownsStateFile) {
        try {
          if (state) await cleanup(owner, state);
          await unlink(STATE_FILE!);
        } catch (error) { failures.push(error); }
      }
      const closed = await Promise.allSettled([ownerContext.close(), peerContext.close()]);
      for (const result of closed) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, 'Restart fixture cleanup failed; inspect the private state file.');
    }
  });
});
