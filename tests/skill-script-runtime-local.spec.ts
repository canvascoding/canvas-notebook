import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createAuthenticatedContext, runManagedTestPreflight } from './helpers/managed-test-context';
import { cleanupOwnedCapabilityPackageFixture, type OwnedCapabilityPackageFixture } from './helpers/capability-package-test-cleanup';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackagePublishedRevision, CapabilityPackageState } from '../app/lib/capabilities/packages/contracts';
import type { AiEffectiveRuntimeResolution } from '../app/lib/agent-runtime-policy/types';
import en from '../messages/en.json';
import de from '../messages/de.json';

const nonce = randomBytes(5).toString('hex');
const packageName = `package-editor-qa-${nonce}`;
const skillName = `script-runtime-qa-${nonce}`;
const agentName = `Skill Script QA ${nonce}`;
const scriptTools = ['list_canvas_skill_scripts', 'describe_canvas_skill_script', 'run_canvas_skill_script'];
type Agent = { agentId: string; name: string; revision: number; type: string; scopeType?: string; ownerUserId?: string; createdByUserId?: string; enabledTools?: string[]; relevantSkills?: string[] };
type ScriptMetadata = { scriptRef: string; id: string; skillName: string; publishedRevisionRef: string; runtime: { kind: string }; readiness: { available: boolean } };
type ContentBlock = { type?: string; name?: string; text?: string; arguments?: unknown };
type Message = { role: string; content?: string | ContentBlock[]; stopReason?: string; toolName?: string; details?: Record<string, unknown> };
let admin: BrowserContext, page: Page, ownerId = '', workspaceId = '', resourceRef = '';
let ownedAgent: Agent | null = null, receipt: OwnedCapabilityPackageFixture | undefined, published: CapabilityPackagePublishedRevision;
const ownedSessions = new Set<string>(), sessionReceipts: Promise<void>[] = [];
test.use({ trace: 'off', video: 'off' });

async function payload<T>(response: Pick<APIResponse, 'ok' | 'status' | 'json'>, phase: string): Promise<T> {
  if (!response.ok()) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  return await response.json() as T;
}

function blocks(message: Message): ContentBlock[] {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
}

function messageText(messages: Message[]): string {
  return messages.flatMap(blocks).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
}

async function transcript(sessionId: string): Promise<Message[]> {
  const query = new URLSearchParams({ agentId: ownedAgent!.agentId, sessionId, workspaceId, limit: '200' });
  return (await payload<{ messages: Message[] }>(await admin.request.get(`/api/sessions/messages?${query}`), 'Actual persisted script transcript')).messages;
}

async function openOwnedChat() {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto(`/notebook?chat=open&workspaceId=${encodeURIComponent(workspaceId)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('chat-agent-id').click();
  await page.getByTestId('chat-agent-selector-popover').getByRole('button').filter({ hasText: agentName }).click();
  await expect(page.getByTestId('chat-agent-id')).toContainText(agentName);
  await page.getByRole('button', { name: /new chat|neuen chat|neuer chat/i }).click();
  await expect(page.getByTestId('chat-session-id')).toHaveCount(0);
  await expect(page.getByTestId('chat-input')).toBeEnabled();
}

async function sendPrompt(prompt: string): Promise<string> {
  await page.getByTestId('chat-input').fill(prompt);
  await expect(page.getByTestId('chat-send')).toBeEnabled();
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', /.+/u, { timeout: 30_000 });
  const sessionId = (await page.getByTestId('chat-session-id').getAttribute('title'))!;
  ownedSessions.add(sessionId);
  return sessionId;
}

async function noOverflow() {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'The actual chat must fit its viewport.').toBe(true);
}

async function screenshots(info: TestInfo, runtime: 'node' | 'python', marker: string) {
  const readyPlaceholders = new Set([en.chat, de.chat].flatMap(labels => [labels.composerPlaceholderMobile,
    labels.composerPlaceholderCompact, labels.composerPlaceholderDefault]));
  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']] as const) {
    const sessionId = await page.getByTestId('chat-session-id').getAttribute('title');
    expect(sessionId).toBeTruthy();
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(value => localStorage.setItem('theme', value), theme);
    const runtimeResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/api/agent-runtime/effective'
        && url.searchParams.get('agentId') === ownedAgent!.agentId && url.searchParams.get('workspaceId') === workspaceId
        && url.searchParams.get('sessionId') === sessionId;
    }, { timeout: 30_000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const loaded = await payload<{ data?: AiEffectiveRuntimeResolution; resolution?: AiEffectiveRuntimeResolution }>(await runtimeResponse, 'Actual screenshot runtime hydration');
    const resolution = loaded.resolution || loaded.data;
    expect(resolution?.valid).toBe(true); expect(resolution?.effectiveSelection).toBeTruthy();
    await expect(page.getByTestId('chat-agent-id')).toHaveAttribute('aria-label', new RegExp(`${agentName}$`, 'u'));
    await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', sessionId!);
    await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 30_000 });
    await expect.poll(async () => readyPlaceholders.has(await page.getByTestId('chat-input').getAttribute('placeholder') || ''),
      { timeout: 30_000 }).toBe(true);
    if (width === 1280) {
      for (const name of [en.navigation.showSidebar, de.navigation.showSidebar]) {
        const showSidebar = page.getByTestId('notebook-toolbar').getByRole('button', { name, exact: true });
        if (await showSidebar.isVisible()) { await showSidebar.click(); break; }
      }
      await expect(page.locator('[data-file-scroll-container]')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('file-tree-loading-skeleton')).toHaveCount(0);
      await expect(page.getByTestId('file-tree-refresh-status')).toHaveCount(0);
    }
    const headers = page.getByTestId('chat-run-disclosure-toggle');
    await expect(headers.last()).toBeVisible();
    for (const header of await headers.all()) if (await header.getAttribute('aria-expanded') === 'true') await header.click();
    await headers.last().evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await expect(headers.last()).toBeInViewport({ ratio: 1 });
    expect((await headers.allTextContents()).join(' ')).not.toMatch(/skill-script:v1:|canvas-package-revision:/u);
    await noOverflow();
    await page.screenshot({ path: info.outputPath(`${runtime}-${width}-${theme}-compact.png`), fullPage: true, animations: 'disabled' });
    for (const header of await headers.all()) if (await header.getAttribute('aria-expanded') === 'false') await header.click();
    const runPill = page.getByTestId('chat-run-step').getByRole('button').last();
    await expect(runPill).toBeVisible();
    await runPill.click();
    const panel = width === 390 ? page.getByRole('dialog').filter({ hasText: 'run_canvas_skill_script' })
      : page.locator('[data-slot="popover-content"][data-state="open"]').filter({ hasText: 'run_canvas_skill_script' });
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-state', 'open');
    await expect(panel).toHaveCSS('opacity', '1');
    await expect(panel).toContainText(marker);
    await expect(panel).toContainText(published.revisionRef);
    expect(await panel.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= -1 && bounds.right <= window.innerWidth + 1;
    }), 'Expanded runtime details remain inside the viewport.').toBe(true);
    await noOverflow();
    await page.screenshot({ path: info.outputPath(`${runtime}-${width}-${theme}-expanded.png`), fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  }
}

async function cleanup() {
  const failures: unknown[] = [];
  if (page) await page.close().catch(error => failures.push(error));
  await Promise.allSettled(sessionReceipts);
  if (admin && ownedAgent) {
    try {
      const current = (await payload<{ data: { agent: Agent } }>(await admin.request.get(`/api/agents?agentId=${encodeURIComponent(ownedAgent.agentId)}`), 'Owned script agent cleanup snapshot')).data.agent;
      expect(current.name).toBe(agentName); expect(current.ownerUserId).toBe(ownerId); expect(current.createdByUserId).toBe(ownerId); expect(current.type).not.toBe('main');
      const sessions = await payload<{ sessions: Array<{ sessionId: string; agentId: string }> }>(await admin.request.get(`/api/sessions?agentId=${encodeURIComponent(current.agentId)}`), 'Exact owned script session inventory');
      for (const session of sessions.sessions) {
        if (session.agentId !== current.agentId || !ownedSessions.has(session.sessionId)) throw new Error('Unreceipted agent session must be preserved.');
        await payload(await admin.request.delete(`/api/sessions?agentId=${encodeURIComponent(current.agentId)}&sessionId=${encodeURIComponent(session.sessionId)}`), 'Exact owned script session deletion');
      }
      const preview = (await payload<{ data: { agent: Agent; confirmationToken: string } }>(await admin.request.post('/api/agents/delete-preview', { data: { agentId: current.agentId } }), 'Current own agent delete preview')).data;
      expect(preview.agent.name).toBe(agentName); expect(preview.agent.createdByUserId).toBe(ownerId); expect(preview.agent.ownerUserId).toBe(ownerId); expect(preview.agent.revision).toBe(current.revision);
      await payload(await admin.request.delete('/api/agents', { data: { agentId: current.agentId, expectedRevision: preview.agent.revision, confirmationToken: preview.confirmationToken } }), 'CAS confirmed owned script agent deletion');
      ownedAgent = null;
    } catch (error) { failures.push(error); }
  }
  if (receipt && failures.length === 0) await cleanupOwnedCapabilityPackageFixture(receipt).catch(error => failures.push(error));
  if (admin) await admin.close().catch(error => failures.push(error));
  if (failures.length) throw new AggregateError(failures, 'Owned script acceptance cleanup stopped; unmatched resources were preserved.');
}

test.describe('Actual published Node/Python scripts through the real selected agent', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000, retries: 0 });
  test.beforeAll(async ({ browser }) => {
    const intake = process.env.CAPABILITY_PACKAGE_E2E_SOURCE_ROOT;
    if (process.env.E2E_EXTERNAL_SERVER !== '1' || !process.env.DATA || !intake || !path.isAbsolute(intake)) {
      throw new Error('Existing production server, actual managed DATA and absolute CAPABILITY_PACKAGE_E2E_SOURCE_ROOT are required; no acceptance skip.');
    }
    admin = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 850 } });
    await runManagedTestPreflight(admin);
    ownerId = (await payload<{ user: { id: string } }>(await admin.request.get('/api/auth/get-session'), 'Actual script actor identity')).user.id;
    const listing = await payload<{ defaultWorkspace?: { id: string }; workspaces: Array<{ id: string; status: string; permissions?: { canRead: boolean; canRunAgent: boolean } }> }>(await admin.request.get('/api/workspaces'), 'Actual script workspace preflight');
    workspaceId = process.env.SKILL_SCRIPT_E2E_WORKSPACE_ID || listing.defaultWorkspace?.id || listing.workspaces.find(item => item.status === 'active' && item.permissions?.canRead && item.permissions.canRunAgent)?.id || '';
    if (!workspaceId) throw new Error('No actual readable agent workspace is configured.');
    await fs.mkdir(intake, { recursive: true });
    const sourceDirectory = await fs.mkdtemp(path.join(intake, `${packageName}-`)), child = path.join(sourceDirectory, 'skills', skillName);
    await fs.mkdir(path.join(sourceDirectory, '.canvas-plugin'));
    await fs.mkdir(path.join(child, '.canvas-skill'), { recursive: true });
    await fs.mkdir(path.join(child, 'scripts'));
    await fs.writeFile(path.join(sourceDirectory, '.canvas-plugin/plugin.json'), JSON.stringify({ name: packageName, version: '1.0.0', description: 'Owned actual script runtime acceptance', skills: './skills' }));
    await fs.writeFile(path.join(child, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Run the selected published Node or Python entrypoint and report its verified standard output.\nmetadata:\n  version: "1.0.0"\n---\n\nThis skill contains Node and Python entrypoints. Each accepts the required label argument, creates and rereads one private scratch file, and prints a JSON receipt. Choose the runtime requested by the user. Discover the entrypoints and check the selected current schema and runtime readiness before running. Report the returned marker and label; leave output files in scratch.\n`);
    await fs.writeFile(path.join(child, 'scripts/main.js'), `const fs = require('node:fs');\nconst sdk = require(process.env.CANVAS_SKILL_BRIDGE_MODULE);\nconst args = sdk.arguments();\nconst marker = 'NODE_SCRIPT_QA_${nonce}';\nfs.writeFileSync('node-scratch.txt', marker);\nconst scratchWritten = fs.readFileSync('node-scratch.txt', 'utf8') === marker;\nif (!scratchWritten) throw new Error('Scratch verification failed');\nprocess.stdout.write(JSON.stringify({ marker, label: args.label, scratchWritten }) + '\\n');\n`);
    await fs.writeFile(path.join(child, 'scripts/main.py'), `import json\nimport canvas_skill as sdk\nargs = sdk.arguments()\nmarker = 'PYTHON_SCRIPT_QA_${nonce}'\nwith open('python-scratch.txt', 'w') as handle:\n handle.write(marker)\nwith open('python-scratch.txt') as handle:\n scratch_written = handle.read() == marker\nassert scratch_written\nprint(json.dumps({'marker': marker, 'label': args['label'], 'scratchWritten': scratch_written}))\n`);
    const argumentsSchema = { type: 'object', required: ['label'], additionalProperties: false, properties: { label: { type: 'string', minLength: 1, maxLength: 128 } } };
    await fs.writeFile(path.join(child, '.canvas-skill/runtime.json'), JSON.stringify({ version: 1, scripts: (['node', 'python'] as const).map(kind => ({
      id: kind, displayName: kind === 'node' ? 'Node scratch verification' : 'Python scratch verification', runtime: { kind }, path: `scripts/main.${kind === 'node' ? 'js' : 'py'}`,
      argumentsSchema, tools: [], outputs: [],
    })) }));
    const installed = await payload<{ success: boolean; plugin: { name: string; resourceId: string; checksum: string; version: string } }>(await admin.request.post('/api/plugins/install', { data: { sourcePath: sourceDirectory, scope: 'organization', enable: true, replace: false } }), 'Actual complete runtime plugin installation');
    expect(installed.success).toBe(true); expect(installed.plugin.name).toBe(packageName);
    const initial = (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await admin.request.get(`/api/capabilities/resources/${encodeURIComponent(installed.plugin.resourceId)}`), 'Installed exact own resource inspection')).data.resource;
    expect(initial.metadata.ownership.type).toBe('organization');
    if (initial.metadata.ownership.type !== 'organization') throw new Error('Actual organization package ownership required.');
    receipt = { nonce, names: [packageName], actorIds: [ownerId], adminId: ownerId, organizationId: initial.metadata.ownership.organizationId,
      dataRoot: await fs.realpath(process.env.DATA), sourceDirectory, sourceName: packageName, initialChecksum: installed.plugin.checksum, initialVersion: installed.plugin.version, publications: [], resourceRevisions: [] };
    const resource = (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await admin.request.post(`/api/capabilities/resources/${encodeURIComponent(installed.plugin.resourceId)}`, { data: {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'organization' }, accessMode: 'restricted',
      grants: [{ targetType: 'user', targetId: ownerId, canUse: true, canEdit: false, canManage: false }],
    } }), 'Explicit own actor script use grant')).data.resource;
    resourceRef = resource.metadata.resourceRef; receipt.sourceResourceRef = resourceRef;
    receipt.resourceRevisions.push({ resourceRef, metadataRevision: resource.metadata.metadataRevision, grantsRevision: resource.metadata.grantsRevision });
    const descriptor = (await payload<{ data: { package: CapabilityPackageDescriptor } }>(await admin.request.get(`/api/capabilities/packages/${encodeURIComponent(resourceRef)}`), 'Actual own complete package publication preparation')).data.package;
    const revisions = { expectedMetadataRevision: descriptor.resource.metadataRevision, expectedGrantsRevision: descriptor.resource.grantsRevision,
      expectedPackageRevision: descriptor.state?.packageRevision || 0, expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef || null };
    const draft = (await payload<{ data: { draft: CapabilityPackageDraft } }>(await admin.request.post('/api/capabilities/packages/drafts', { data: { operation: 'edit', resourceRef, ...revisions } }), 'Actual private runtime draft')).data.draft;
    const validation = await payload<{ data: { validation: { valid: boolean } } }>(await admin.request.post(`/api/capabilities/packages/drafts/${encodeURIComponent(draft.draftRef)}/validate`), 'Actual complete script package validation');
    expect(validation.data.validation.valid).toBe(true);
    const publication = (await payload<{ data: { state: CapabilityPackageState; published: CapabilityPackagePublishedRevision } }>(await admin.request.post(`/api/capabilities/packages/drafts/${encodeURIComponent(draft.draftRef)}/publish`, { data: { draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision, ...revisions } }), 'Actual immutable script package publication')).data;
    published = publication.published;
    receipt.publications.push({ resourceRef, revisionRef: published.revisionRef, checksum: published.checksum, version: published.version });
    expect(publication.state.packageRevision).toBe(1); expect(publication.state.currentPublishedRevisionRef).toBe(published.revisionRef);
    const activation = await payload<{ resourceId: string; preference: { enabled: boolean; revision: number } }>(await admin.request.put('/api/skills/preferences', { data: { resourceId: installed.plugin.resourceId, enabled: true, expectedRevision: 0 } }), 'Explicit own personal organization plugin activation');
    expect(activation.resourceId).toBe(installed.plugin.resourceId); expect(activation.preference.enabled).toBe(true); expect(activation.preference.revision).toBe(1);
    receipt.preferences = [{ userId: ownerId, resourceId: activation.resourceId, revision: activation.preference.revision, enabled: activation.preference.enabled }];
    const runtime = (await payload<{ data: AiEffectiveRuntimeResolution }>(await admin.request.get(`/api/agent-runtime/effective?workspaceId=${encodeURIComponent(workspaceId)}&agentId=bradley`), 'Actual inherited runtime')).data;
    if (!runtime.valid || !runtime.effectiveSelection) throw new Error('The actual inherited model is not ready.');
    const selection = runtime.effectiveSelection.selection;
    const created = (await payload<{ data: { agent: Agent } }>(await admin.request.post('/api/agents', { headers: { 'x-canvas-workspace-id': workspaceId }, data: {
      name: agentName, scopeType: 'user', enabledTools: scriptTools, relevantSkills: [skillName],
      defaultProviderInstallationId: selection.providerInstallationId, defaultProvider: selection.providerId, defaultModel: selection.modelId,
      defaultThinking: selection.thinkingLevel, expectedCatalogRevision: runtime.catalogRevision,
      files: { 'AGENTS.md': `Du führst die veröffentlichten Einstiegspunkte des Skills ${skillName} aus. Prüfe die aktuelle Deklaration und Laufzeitbereitschaft vor jedem angeforderten Lauf. Verwende die gewünschte Node- oder Python-Laufzeit und die Kennung des Benutzers. Berichte nur bestätigte Standardausgabe. Veröffentliche keine Scratchdateien in den Workspace. Antworte knapp auf Deutsch.` },
    } }), 'Owned personal script specialist creation')).data.agent;
    ownedAgent = created;
    expect(created.ownerUserId).toBe(ownerId); expect(created.createdByUserId).toBe(ownerId); expect(created.scopeType).toBe('user');
    page = await admin.newPage();
    page.on('response', response => {
      if (new URL(response.url()).pathname !== '/api/sessions' || response.request().method() !== 'POST' || response.request().postDataJSON()?.agentId !== created.agentId) return;
      sessionReceipts.push((async () => {
        if (!response.ok()) return;
        const result = await response.json() as { success?: boolean; session?: { sessionId?: string; agentId?: string } };
        if (result.success && result.session?.agentId === created.agentId && result.session.sessionId) ownedSessions.add(result.session.sessionId);
      })());
    });
  });
  test.afterAll(async () => { test.setTimeout(180_000); await cleanup(); });

  for (const runtime of ['node', 'python'] as const) test(`natural request executes the immutable ${runtime} entrypoint`, async ({}, info) => {
    await openOwnedChat();
    const label = `Abnahme-${runtime}-${nonce}`, marker = `${runtime === 'node' ? 'NODE' : 'PYTHON'}_SCRIPT_QA_${nonce}`;
    const sessionId = await sendPrompt(`Führe jetzt den veröffentlichten ${runtime === 'node' ? 'Node' : 'Python'}-Einstiegspunkt des Skills „${skillName}“ mit der Kennung „${label}“ aus. Prüfe erst die Deklaration und die Laufzeitbereitschaft. Lass die Scratchdatei im privaten Laufverzeichnis und gib mir den bestätigten Marker sowie die Kennung aus der Standardausgabe zurück.`);
    await expect.poll(async () => messageText((await transcript(sessionId)).filter(message => message.role === 'assistant' && message.stopReason === 'stop')),
      { timeout: 140_000, intervals: [1000, 2000, 3000] }).toContain(marker);
    const messages = await transcript(sessionId), results = messages.filter(message => message.role === 'toolResult');
    const calls = messages.flatMap(blocks).filter(block => block.type === 'toolCall');
    expect(calls.length).toBeGreaterThanOrEqual(3); expect(calls.every(call => scriptTools.includes(call.name || ''))).toBe(true);
    expect(results.every(result => scriptTools.includes(result.toolName || ''))).toBe(true);
    const entries = results.filter(result => result.toolName === 'list_canvas_skill_scripts').flatMap(result => (result.details?.scripts || []) as ScriptMetadata[]);
    const listed = entries.find(entry => entry.id === runtime && entry.skillName === skillName);
    expect(listed).toBeDefined(); expect(listed!.runtime.kind).toBe(runtime); expect(listed!.publishedRevisionRef).toBe(published.revisionRef); expect(listed!.readiness.available).toBe(true);
    const descriptions = results.filter(result => result.toolName === 'describe_canvas_skill_script').map(result => result.details?.script as ScriptMetadata);
    expect(descriptions.some(script => script.scriptRef === listed!.scriptRef && script.id === runtime && script.publishedRevisionRef === published.revisionRef)).toBe(true);
    const runs = results.filter(result => result.toolName === 'run_canvas_skill_script');
    expect(runs).toHaveLength(1);
    const run = runs[0].details!;
    expect(run.kind).toBe('skill_script_result'); expect(run.success).toBe(true); expect(run.safeToAutoRetry).toBe(false);
    expect(run.scriptRef).toBe(listed!.scriptRef); expect(run.id).toBe(runtime); expect(run.runtime).toBe(runtime);
    expect(run.publishedRevisionRef).toBe(published.revisionRef); expect(run.checksum).toBe(published.checksum);
    expect(run.stderr).toBe(''); expect(run.files).toEqual([]); expect(run.toolResults).toBeUndefined();
    expect(JSON.parse(String(run.stdout).trim())).toEqual({ marker, label, scratchWritten: true });
    const runCall = calls.find(call => call.name === 'run_canvas_skill_script')!;
    expect((runCall.arguments as { scriptRef: string; arguments: unknown }).scriptRef).toBe(listed!.scriptRef);
    expect((runCall.arguments as { arguments: unknown }).arguments).toEqual({ label });
    expect((runCall.arguments as { outputs?: unknown[] }).outputs || []).toEqual([]);
    await screenshots(info, runtime, marker);
  });

  test('planning describes the script without running a process', async () => {
    await openOwnedChat();
    await page.getByRole('button', { name: 'Standard Mode', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Planning Mode', exact: true })).toBeVisible();
    const sessionId = await sendPrompt(`Plane, wie du den Node-Einstiegspunkt des Skills „${skillName}“ mit einer Kennung ausführen würdest. Prüfe bei Bedarf die deklarierte Eingabe und Laufzeit, starte aber keinen Scriptlauf und veröffentliche keine Dateien. Beschreibe nur den Plan.`);
    await expect.poll(async () => (await transcript(sessionId)).some(message => message.role === 'assistant' && message.stopReason === 'stop'),
      { timeout: 140_000, intervals: [1000, 2000, 3000] }).toBe(true);
    const messages = await transcript(sessionId), calls = messages.flatMap(blocks).filter(block => block.type === 'toolCall');
    expect(calls.every(call => ['list_canvas_skill_scripts', 'describe_canvas_skill_script'].includes(call.name || ''))).toBe(true);
    expect(messages.some(message => message.toolName === 'run_canvas_skill_script')).toBe(false);
    expect(messageText(messages.filter(message => message.role === 'assistant')).trim().length).toBeGreaterThan(10);
  });
});
