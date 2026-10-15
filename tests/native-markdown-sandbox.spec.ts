import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import type { JSONContent } from '@tiptap/core';
import { COLLABORATION_CLIENT_CAPABILITIES } from '../app/lib/collaboration/types';
import { requireOwnedYjsQaTarget } from '../scripts/lib/owned-yjs-authority-qa';
import type { OwnedYjsSandboxPackageUnsealInput } from '../scripts/owned-yjs-sandbox-package-unseal';
import { createAuthenticatedContext } from './helpers/managed-test-context';
import { waitForFileCreateBudget } from './helpers/create-request-budget';
import { readNativeRichCandidate } from './helpers/native-rich-candidate';
import { observeNativeDurabilityAcknowledgements } from './helpers/native-durability-ack';
import { runOwnedNativeCommand, aggregateOwnedNativeErrors } from './helpers/owned-native-command';
import { startOwnedAgentToolModel, type OwnedModelStep, type ObservedToolResult } from './helpers/owned-agent-tool-model';
import { comparableOwnedSandboxToolResult, createOwnedSandboxAgentChat } from './helpers/owned-sandbox-agent-chat';
import { createNativeMarkdownSandboxPackage, NativeMarkdownSandboxPackageSetupError } from './helpers/native-markdown-sandbox-package';

const editorSelector = '.tiptap-editor-shell .ProseMirror';
const initialText = 'XSandbox target.', baselineText = 'Sandbox target.', editedText = 'Sandbox target. Authorized edit.';
type Candidate = Awaited<ReturnType<typeof readNativeRichCandidate>>;
type Workspace = { id: string; name: string; rootRelativePath: string; legacy: boolean; status: string;
  permissions: { canRead: boolean; canWrite: boolean; canRunAgent: boolean } };
type Identity = { documentId: string; lifecycleGeneration: number; representation: string; schemaVersion: number };
type Durable = { documentId: string; generation: number; sequence: number; stateProof: string;
  content: { kind: 'rich_text'; document: JSONContent };
  projection: { checkpointSequence: number; checkpointedAt: number | null; error?: unknown } };
type Script = { scriptRef: string; id: string; skillName: string; publishedRevisionRef: string;
  runtime: { kind: string }; readiness: { available: boolean }; requiresBindings: unknown[];
  inputSchema?: unknown; toolRequirements?: unknown; outputs?: unknown };
type Package = Awaited<ReturnType<typeof createNativeMarkdownSandboxPackage>>;
type Chat = Awaited<ReturnType<typeof createOwnedSandboxAgentChat>>;
type Turn = Awaited<ReturnType<Chat['turn']>>;

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function json<T>(response: APIResponse): Promise<T> {
  try { expect(response.ok()).toBe(true); return await response.json() as T; }
  finally { await response.dispose(); }
}

/** OpenAI tool messages can contain the tool's text JSON or its content array.
 * Decode the actual value with a bounded number of wrappers, never synthesize metadata.
 */
function modelPayload(value: unknown, depth = 0): Record<string, unknown> {
  assert(depth < 5);
  if (typeof value === 'string') { assert(Buffer.byteLength(value) <= 256 * 1024); return modelPayload(JSON.parse(value), depth + 1); }
  if (Array.isArray(value)) {
    assert(value.length === 1); const part = record(value[0]);
    assert.equal(part.type, 'text'); assert.equal(typeof part.text, 'string');
    return modelPayload(part.text, depth + 1);
  }
  const object = record(value);
  return Array.isArray(object.content) ? modelPayload(object.content, depth + 1) : object;
}

function lastModelPayload(results: readonly ObservedToolResult[], name: string) {
  const result = results.at(-1); assert(result); assert.equal(result.name, name);
  return modelPayload(result.content);
}

function scriptSteps(pkg: Package, runtime: 'node' | 'python', mode: 'deny' | 'edit', filePath: string, absolutePath: string): OwnedModelStep[] {
  let selected: Script | undefined;
  return [
    () => ({ name: 'list_canvas_skill_scripts', arguments: {} }),
    results => {
      const listed = lastModelPayload(results, 'list_canvas_skill_scripts'); assert(Array.isArray(listed.scripts));
      const matches = (listed.scripts as Script[]).filter(entry => entry.skillName === pkg.skillName && entry.id === runtime);
      assert.equal(matches.length, 1); selected = matches[0];
      assert.equal(selected.runtime.kind, runtime); assert.equal(selected.readiness.available, true);
      assert.equal(selected.publishedRevisionRef, pkg.publishedRevisionRef); assert.deepEqual(selected.requiresBindings, []);
      assert.match(selected.scriptRef, /^skill-script:v1:[A-Za-z0-9_-]{43}$/u);
      return { name: 'describe_canvas_skill_script', arguments: { scriptRef: selected.scriptRef } };
    },
    results => {
      assert(selected);
      const described = record(lastModelPayload(results, 'describe_canvas_skill_script').script) as unknown as Script;
      assert.equal(described.scriptRef, selected.scriptRef); assert.equal(described.id, runtime);
      assert.equal(described.skillName, pkg.skillName); assert.equal(described.runtime.kind, runtime);
      assert.equal(described.publishedRevisionRef, pkg.publishedRevisionRef); assert.equal(described.readiness.available, true);
      assert.deepEqual(described.requiresBindings, []); assert.deepEqual(described.outputs, []);
      assert.deepEqual(described.toolRequirements, [
        { alias: 'read_doc', kind: 'native', toolName: 'read' }, { alias: 'edit_doc', kind: 'native', toolName: 'edit_file' },
      ]);
      const schema = record(described.inputSchema);
      assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, ['path', 'absolutePath', 'mode']);
      assert.deepEqual(record(record(schema.properties).mode).enum, ['deny', 'edit']);
      return { name: 'run_canvas_skill_script', arguments: { scriptRef: described.scriptRef,
        arguments: { path: filePath, absolutePath, mode }, selectedBindings: [], outputs: [] } };
    },
  ];
}

function runDetails(turn: Turn, pkg: Package, runtime: 'node' | 'python', mode: 'deny' | 'edit', identity: Identity, blockId: string) {
  expect(turn.model.failures).toEqual([]); expect(turn.model.active?.completed).toBe(true);
  expect(turn.model.active?.issued.map(entry => entry.name)).toEqual([
    'list_canvas_skill_scripts', 'describe_canvas_skill_script', 'run_canvas_skill_script',
  ]);
  const ends = turn.events.flatMap(packet => packet.type === 'agent_event' && packet.event
    && record(packet.event).type === 'tool_execution_end' ? [record(packet.event)] : []);
  expect(ends.map(event => event.toolName)).toEqual(['list_canvas_skill_scripts', 'describe_canvas_skill_script', 'run_canvas_skill_script']);
  expect(ends.every(event => event.isError === false)).toBe(true);
  const live = record(ends[2].result);
  const original = turn.originalToolResults.find(value => value.toolCallId === ends[2].toolCallId);
  assert(original && original.toolName === 'run_canvas_skill_script' && original.isError === false);
  const result = original.result, details = record(result.details);
  expect(details).toMatchObject({ kind: 'skill_script_result', success: true, safeToAutoRetry: false,
    id: runtime, runtime, publishedRevisionRef: pkg.publishedRevisionRef, checksum: pkg.published.checksum, stderr: '', files: [] });
  expect(details.error).toBeUndefined(); expect(details.terminateAgentTurn).toBeUndefined();
  const saved = turn.messages.filter(message => message.role === 'toolResult' && message.toolName === 'run_canvas_skill_script');
  expect(saved).toHaveLength(1);
  expect(comparableOwnedSandboxToolResult(saved[0])).toEqual(comparableOwnedSandboxToolResult(live));
  expect(typeof details.stdout).toBe('string');
  const receipt = record(JSON.parse(String(details.stdout).trim()));
  expect(receipt).toMatchObject({ kind: 'native-markdown-sandbox-receipt', runtime, mode, scratchWritten: true,
    blockedMutations: ['write', 'append', 'replace', 'rename', 'unlink'], blockId,
    beforeText: baselineText, afterText: mode === 'edit' ? editedText : baselineText, edited: mode === 'edit',
    document: { documentId: identity.documentId, lifecycleGeneration: identity.lifecycleGeneration, schemaVersion: identity.schemaVersion } });
  assert(Array.isArray(details.toolResults));
  const effects = details.toolResults.map(value => record(value));
  expect(effects.map(effect => effect.toolName)).toEqual(mode === 'edit' ? ['read', 'read', 'edit_file', 'read'] : ['read', 'read']);
  for (const effect of effects.filter(value => value.toolName === 'read')) {
    expect(record(record(effect.result).details).collaboration).toMatchObject({ source: 'live_yjs', representation: 'tiptap_blocks',
      documentId: identity.documentId, lifecycleGeneration: identity.lifecycleGeneration });
  }
  return { receipt, details, effects };
}

async function session(request: APIRequestContext, workspace: Workspace, filePath: string) {
  const value = await json<Identity & { success: boolean; provider: string; richTextSchemaVersion: number; blockTreeFormatVersion: number }>(
    await request.post('/api/files/collaboration/session', { headers: { 'x-canvas-workspace-id': workspace.id },
      data: { path: filePath, representation: 'auto', ...COLLABORATION_CLIENT_CAPABILITIES } }));
  expect(value).toMatchObject({ success: true, provider: 'yjs', representation: 'tiptap_blocks', schemaVersion: 1,
    richTextSchemaVersion: 3, blockTreeFormatVersion: 1 });
  return { documentId: value.documentId, lifecycleGeneration: value.lifecycleGeneration, representation: value.representation, schemaVersion: value.schemaVersion };
}

async function durable(workspace: Workspace, filePath: string, identity: Identity): Promise<Durable> {
  const input = Buffer.from(JSON.stringify({ documentId: identity.documentId, workspaceId: workspace.id,
    path: filePath, generation: identity.lifecycleGeneration })).toString('base64url');
  const result = await runOwnedNativeCommand(['--conditions=react-server', '--import', 'tsx', 'scripts/owned-yjs-authority-storage-read.ts', input],
    { label: 'storage-evidence', timeoutMs: 30_000, maxBuffer: 2 * 1024 * 1024 });
  expect(result.receipt).toMatchObject({ exitVerified: true, exitCode: 0 });
  return JSON.parse(result.stdout) as Durable;
}

async function awaitDurable(workspace: Workspace, filePath: string, identity: Identity, candidate: Candidate) {
  await expect.poll(async () => {
    const value = await durable(workspace, filePath, identity);
    return { documentId: value.documentId, generation: value.generation, stateProof: value.stateProof,
      document: value.content.document, projected: value.projection.checkpointSequence === value.sequence, error: value.projection.error };
  }, { timeout: 45_000, intervals: [250, 500, 1_000] }).toEqual({ documentId: identity.documentId, generation: identity.lifecycleGeneration,
    stateProof: candidate.stateProof, document: candidate.document, projected: true, error: undefined });
  return durable(workspace, filePath, identity);
}

async function physical(filePath: string) {
  const before = await fs.lstat(filePath);
  expect(before.isFile() && !before.isSymbolicLink() && before.nlink === 1).toBe(true);
  expect(before.uid).toBe(process.getuid!()); expect(before.mode & 0o200).not.toBe(0);
  expect(before.size).toBeLessThanOrEqual(64 * 1024);
  expect(await fs.realpath(filePath)).toBe(filePath);
  const metadata = (stat: typeof before) => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode,
    uid: stat.uid, nlink: stat.nlink, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    expect(metadata(await handle.stat())).toEqual(metadata(before));
    const bytes = await handle.readFile(), after = await fs.lstat(filePath);
    expect(metadata(await handle.stat())).toEqual(metadata(before)); expect(metadata(after)).toEqual(metadata(before));
    expect(bytes.length).toBe(before.size); expect(await fs.realpath(filePath)).toBe(filePath);
    return { ...metadata(after), sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') };
  } finally { await handle.close(); }
}

async function createDocument(page: Page, workspace: Workspace, filePath: string) {
  await page.addInitScript(id => {
    localStorage.setItem('canvas.activeWorkspaceId', id); localStorage.setItem('canvas.notebook.chatVisible', 'false');
  }, workspace.id);
  await page.goto('/en');
  await page.getByTestId('home-files').getByRole('button', { name: 'New note', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New note', exact: true });
  await dialog.getByLabel('Note name', { exact: true }).fill(filePath); await waitForFileCreateBudget();
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/files/create'
    && response.request().method() === 'POST' && response.request().headers()['x-canvas-workspace-id'] === workspace.id
    && response.request().postDataJSON()?.path === filePath);
  await dialog.getByRole('button', { name: 'Create and open', exact: true }).click();
  expect((await created).ok()).toBe(true); await expect(dialog).toHaveCount(0);
  await expect(page.locator(editorSelector)).toHaveAttribute('contenteditable', 'true', { timeout: 45_000 });
  await expect(page.locator(editorSelector)).toHaveText('');
}

test('Real native Markdown denies Node/Python raw mutations and accepts the declared Python SDK edit', async ({ browser }, info) => {
  test.setTimeout(600_000);
  const target = await requireOwnedYjsQaTarget();
  const context = await createAuthenticatedContext(browser, { viewport: { width: 1440, height: 950 } });
  const page = await context.newPage(), acknowledgements = observeNativeDurabilityAcknowledgements(page);
  const token = randomBytes(8).toString('hex'), filePath = `owned-yjs-restart-${randomUUID()}.md`;
  let model: Awaited<ReturnType<typeof startOwnedAgentToolModel>> | undefined, chat: Chat | undefined, pkg: Package | undefined;
  let failed = false, failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const off = await json<{ success: boolean; data: { documentReviewEnabled: boolean } }>(await context.request.patch('/api/admin/experimental-settings', {
      headers: { Origin: process.env.BASE_URL! }, data: { documentReviewEnabled: false } }));
    expect(off.data.documentReviewEnabled).toBe(false);
    expect((await json<{ data: { documentReviewEnabled: boolean } }>(await context.request.get('/api/server-settings'))).data.documentReviewEnabled).toBe(false);
    const actor = await json<{ user: { id: string } }>(await context.request.get('/api/auth/get-session'));
    expect(actor.user.id).toBe(target.actorId);
    const listing = await json<{ workspaces: Workspace[] }>(await context.request.get('/api/workspaces'));
    const workspace = listing.workspaces.find(value => value.name === 'Shared Test Workspace' && !value.legacy && value.status === 'active'
      && value.permissions.canRead && value.permissions.canWrite && value.permissions.canRunAgent);
    assert(workspace); assert(workspace.rootRelativePath && !path.isAbsolute(workspace.rootRelativePath));
    const workspaceRoot = path.resolve(target.dataRoot, workspace.rootRelativePath);
    expect(workspaceRoot.startsWith(`${target.dataRoot}${path.sep}`)).toBe(true); expect(await fs.realpath(workspaceRoot)).toBe(workspaceRoot);
    const absolutePath = path.join(workspaceRoot, filePath);
    await createDocument(page, workspace, filePath);
    const identity = await session(context.request, workspace, filePath);
    await page.locator(editorSelector).focus(); await page.keyboard.insertText(initialText);
    await expect(page.locator(editorSelector)).toHaveText(initialText);
    const beforeDelete = await readNativeRichCandidate(page, editorSelector);
    await awaitDurable(workspace, filePath, identity, beforeDelete);
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Delete');
    await expect(page.locator(editorSelector)).toHaveText(baselineText);
    const baseline = await readNativeRichCandidate(page, editorSelector);
    expect(baseline.stateVector).toBe(beforeDelete.stateVector); expect(baseline.stateProof).not.toBe(beforeDelete.stateProof);
    expect(baseline.guid).toBe(beforeDelete.guid); expect(baseline.localClient).toBe(beforeDelete.localClient);
    const saved = await awaitDurable(workspace, filePath, identity, baseline);
    await expect.poll(() => acknowledgements.hasAcknowledged(identity, baseline), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await physical(absolutePath)).text, { timeout: 30_000 }).toBe(baselineText);
    const disk = await physical(absolutePath);
    const nodes = baseline.document.content; expect(nodes).toHaveLength(1); expect(nodes![0].type).toBe('paragraph');
    expect(nodes![0].content).toEqual([{ type: 'text', text: baselineText }]);
    const blockId = nodes![0].attrs?.id; assert.equal(typeof blockId, 'string'); assert(blockId);
    pkg = await createNativeMarkdownSandboxPackage({ request: context.request, workspaceId: workspace.id, ownerId: actor.user.id, nonce: target.nonce });
    model = await startOwnedAgentToolModel(`owned-sandbox-${token}`);
    chat = await createOwnedSandboxAgentChat({ context, workspaceId: workspace.id, ownerId: actor.user.id, skillName: pkg.skillName, model });
    for (const runtime of ['node', 'python'] as const) {
      const result = await chat.turn(`OWNED_SANDBOX_${token}_${runtime}_deny`, scriptSteps(pkg, runtime, 'deny', filePath, absolutePath));
      runDetails(result, pkg, runtime, 'deny', identity, blockId);
      expect(await readNativeRichCandidate(page, editorSelector)).toEqual(baseline);
      expect(await session(context.request, workspace, filePath)).toEqual(identity);
      expect(await durable(workspace, filePath, identity)).toEqual(saved);
      expect(await physical(absolutePath)).toEqual(disk);
      await info.attach(`${runtime}-native-denial.json`, { contentType: 'application/json', body: JSON.stringify({
        documentId: identity.documentId, generation: identity.lifecycleGeneration, stateProof: saved.stateProof, sequence: saved.sequence,
        sha256: disk.sha256, physicalMetadataUnchanged: true, run: result,
      }) });
    }
    const result = await chat.turn(`OWNED_SANDBOX_${token}_python_edit`, scriptSteps(pkg, 'python', 'edit', filePath, absolutePath));
    const applied = runDetails(result, pkg, 'python', 'edit', identity, blockId);
    const mutation = record(record(applied.effects.find(effect => effect.toolName === 'edit_file')!.result).details);
    expect(mutation).toMatchObject({ kind: 'file_mutation', operation: 'edit_file', outcome: 'applied', path: filePath,
      collaboration: { reviewRequired: false } });
    const collaboration = record(mutation.collaboration);
    expect([['persisted_yjs', 'persisted_yjs'], ['checkpointed_file', 'checkpointed_file']])
      .toContainEqual([collaboration.operationStatus, collaboration.durability]);
    expect(mutation.proposal).toBeUndefined(); expect(mutation.error).toBeUndefined();
    await expect(page.locator(editorSelector)).toHaveText(editedText);
    const expected = structuredClone(baseline.document); expected.content![0].content![0].text = editedText;
    const final = await readNativeRichCandidate(page, editorSelector);
    expect(final.document).toEqual(expected); expect(final.guid).toBe(baseline.guid); expect(final.localClient).toBe(baseline.localClient);
    expect(final.stateProof).not.toBe(baseline.stateProof);
    const persisted = await awaitDurable(workspace, filePath, identity, final);
    expect(persisted.sequence).toBeGreaterThan(saved.sequence);
    await expect.poll(() => acknowledgements.hasAcknowledged(identity, final), { timeout: 30_000 }).toBe(true);
    const projected = await physical(absolutePath); expect(projected.text).toBe(editedText); expect(mutation.afterSha256).toBe(projected.sha256);
    expect(await session(context.request, workspace, filePath)).toEqual(identity);
    const readback = await json<{ data: { content: string } }>(await context.request.get('/api/files/read', {
      headers: { 'x-canvas-workspace-id': workspace.id }, params: { path: filePath } }));
    expect(readback.data.content).toBe(projected.text);
    expect((await json<{ data: { documentReviewEnabled: boolean } }>(await context.request.get('/api/server-settings'))).data.documentReviewEnabled).toBe(false);
    await info.attach('python-native-apply.json', { contentType: 'application/json', body: JSON.stringify({ identity,
      beforeProof: saved.stateProof, afterProof: persisted.stateProof, beforeSequence: saved.sequence, afterSequence: persisted.sequence,
      beforeSha256: disk.sha256, afterSha256: projected.sha256, result }) });
    await page.screenshot({ path: info.outputPath('native-markdown-sandbox-applied.png'), animations: 'disabled' });
  } catch (cause) {
    failed = true; failure = cause;
    if (cause instanceof NativeMarkdownSandboxPackageSetupError) {
      try {
        await info.attach('native-sandbox-incomplete-package.json', { contentType: 'application/json', body: JSON.stringify(cause.cleanupReceipt) });
      } catch (diagnosticFailure) { cleanupErrors.push(diagnosticFailure); }
    }
  }
  let closed: Awaited<ReturnType<Chat['close']>> | undefined;
  try {
    if (chat && failed) {
      const preserved = await chat.stopAndPreserve();
      try { await info.attach('native-sandbox-preserved-runtime.json', { contentType: 'application/json', body: JSON.stringify(preserved) }); }
      catch (diagnosticFailure) { cleanupErrors.push(diagnosticFailure); }
    } else if (chat) closed = await chat.close();
  } catch (cause) { cleanupErrors.push(cause); }
  try { await model?.close(); } catch (cause) { cleanupErrors.push(cause); }
  if (!failed && cleanupErrors.length === 0 && pkg && closed) {
    try {
      expect(closed).toMatchObject({ sessionDeleted: true, agentDeleted: true, providerRestored: true, allTurnsCompleted: true });
      const personalSelection = await json<{ success: boolean; name: string; enabledSkills: string[] }>(
        await context.request.post(`/api/skills/${encodeURIComponent(pkg.skillName)}/disable`));
      expect(personalSelection.success).toBe(true); expect(personalSelection.name).toBe(pkg.skillName);
      expect(personalSelection.enabledSkills).not.toContain(pkg.skillName);
      const route = `/api/capabilities/packages/${encodeURIComponent(pkg.resourceRef)}`;
      const current = (await json<{ data: { package: { defaultEnabled: boolean; resource: { metadataRevision: number; grantsRevision: number };
        state: { packageRevision: number; currentPublishedRevisionRef: string } } } }>(await context.request.get(route,
        { params: { workspaceId: pkg.cleanupReceipt.workspaceId } }))).data.package;
      expect(current.state.currentPublishedRevisionRef).toBe(pkg.publishedRevisionRef);
      const activation = await json<{ success: boolean; data: { enabled: boolean; resourceRef: string; publishedRevisionRef: string } }>(
        await context.request.patch(route + '/activation', { params: { workspaceId: pkg.cleanupReceipt.workspaceId }, data: {
          enabled: false, expectedDefaultEnabled: current.defaultEnabled, expectedMetadataRevision: current.resource.metadataRevision,
          expectedGrantsRevision: current.resource.grantsRevision, expectedPackageRevision: current.state.packageRevision,
          expectedPublishedRevisionRef: current.state.currentPublishedRevisionRef } }));
      expect(activation.data).toMatchObject({ enabled: false, resourceRef: pkg.resourceRef, publishedRevisionRef: pkg.publishedRevisionRef });
      const receiptFile = path.join(process.env.CANVAS_YJS_QA_RESULTS!, `native-sandbox-unseal-${target.nonce}.json`);
      const unsealInput: OwnedYjsSandboxPackageUnsealInput = { version: 1, kind: 'owned-yjs-sandbox-package-unseal-v1', fixtureNonce: target.nonce,
        packageReceipt: pkg.cleanupReceipt, closure: closed.closure, activation, personalSelection };
      await fs.writeFile(receiptFile, JSON.stringify(unsealInput), { mode: 0o600, flag: 'wx' });
      const unsealed = await runOwnedNativeCommand(['--conditions=react-server', '--import', 'tsx', 'scripts/owned-yjs-sandbox-package-unseal.ts', receiptFile],
        { label: 'storage-evidence', timeoutMs: 30_000, maxBuffer: 64 * 1024 });
      expect(unsealed.receipt).toMatchObject({ exitVerified: true, exitCode: 0 }); expect(unsealed.stdout).toContain('OWNED_YJS_SANDBOX_PACKAGE_UNSEAL_PASS');
      await info.attach('native-sandbox-runtime-closure.json', { contentType: 'application/json', body: JSON.stringify({ closed,
        model: model?.evidence(), unseal: unsealed.receipt, acknowledgement: unsealed.stdout }) });
    } catch (cause) { cleanupErrors.push(cause); }
  }
  acknowledgements.dispose();
  try { await page.close(); } catch (cause) { cleanupErrors.push(cause); }
  try { await context.close(); } catch (cause) { cleanupErrors.push(cause); }
  if (cleanupErrors.length) throw aggregateOwnedNativeErrors(failed ? failure : undefined, cleanupErrors, 'Owned sandbox acceptance or closure failed; preserve its fixture.');
  if (failed) throw failure;
});
