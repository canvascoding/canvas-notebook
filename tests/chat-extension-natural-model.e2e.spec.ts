import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import { MAIN_AGENT_DISPLAY_NAME, MAIN_AGENT_ID } from '../app/lib/agents/main-agent';
import { deriveChatBodySelection, parseChatBody, projectChatBodyText, type ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import type { ExtensionPackagePin } from '../app/lib/capabilities/extensions/contracts';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackageFileRead, CapabilityPackagePublishedSummary } from '../app/lib/capabilities/packages/contracts';
import type { PluginExtensionSearchResponse } from '../app/lib/plugins/plugin-extension-contracts';
import { provisionNaturalWorkflowModel } from './helpers/natural-workflow-model-setup';
import { assertNaturalModelToolResults } from './helpers/natural-model-tool-validation';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import en from '../messages/en.json';

// Real external Ollama/Kimi, actual production app/SDK, SQL admission and source authorization.
// Only the exact OAuth MCP echo transport is controlled. No app/model route is intercepted.
type Fixture = { version: 1; nonce: string; repo: string; root: string; dataRoot: string; actorId: string;
  baseURL: string; buildId: string; mcpUrl: string; mcpSpki: string };
type Block = { type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Message = { role: string; content?: string | Block[]; toolName?: string; toolCallId?: string; isError?: boolean;
  stopReason?: string; clientMessageId?: string; serverMessageId?: string; details?: Record<string, unknown> };
type OriginalSend = { requestId: string; sessionId: string; clientMessageId: string; message: { content: unknown }; body?: ChatBodyV1; selection?: unknown };
type SendAcknowledgement = { requestId: string; success: boolean; code?: string };
type CaseProof = { kind: 'natural_discovery' | 'inline_plugin'; sessionId: string; agentId: string; workspaceId: string;
  clientMessageId: string; serverMessageId: string; packagePin: ExtensionPackagePin;
  expectedSkill: { relativeRoot: string; sha256: string }; readToolCallIds: string[];
  discoveryToolCallId?: string; describeToolCallId?: string; callToolCallId?: string; connectionRef?: string;
  contentSHA256: string; bodySHA256?: string };
type Gateway = { integrationToolGatewayEnabled: boolean; updatedAt: string | null };
let fixture: Fixture, owner: BrowserContext, page: Page, workspaceId = '', organizationId = '';
let model: Awaited<ReturnType<typeof provisionNaturalWorkflowModel>>, gateway: Gateway;
let naturalPin: ExtensionPackagePin, naturalSource = '', naturalName = '', escalation = '';
const cases: CaseProof[] = [], sends: OriginalSend[] = [], runtimeErrors: string[] = [], forbidden: string[] = [];
const acknowledgements = new WeakMap<OriginalSend, SendAcknowledgement>();
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const blocks = (message: Message): Block[] => typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
const text = (message: Message) => blocks(message).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
test.describe.configure({ mode: 'serial', retries: 0, timeout: 360_000 });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

async function json<T>(response: APIResponse | Response, phase: string, status = 200): Promise<T> {
  expect(response.status(), `${phase}: actual HTTP status`).toBe(status); return response.json() as Promise<T>;
}
async function data<T>(response: APIResponse | Response, phase: string): Promise<T> {
  const result = await json<{ success: boolean; data: T }>(response, phase); expect(result.success, phase).toBe(true); return result.data;
}
const scoped = (url: string, extra: Record<string, string> = {}) => `${url}?${new URLSearchParams({ workspaceId, ...extra })}`;
const editor = () => page.locator('[data-testid="chat-inline-editor"] [role="textbox"][contenteditable="true"]:visible');
async function focusEnd(input: Locator) { await input.focus(); await input.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); }
async function flags(): Promise<Gateway> { return data(await owner.request.get('/api/admin/experimental-settings'), 'Actual nonce gateway setting'); }
async function publish(name: string, kind: 'plugin' | 'skill'): Promise<ExtensionPackagePin> {
  const listing = await data<PluginExtensionSearchResponse>(await owner.request.get(scoped('/api/plugins/search', { q: name, types: kind })), 'Find actual installed source');
  const matches = listing.items.filter(item => item.kind === kind && item.name === name && (item.kind === 'plugin' || item.kind === 'skill') && item.package);
  expect(matches).toHaveLength(1); const selected = matches[0]!;
  if (selected.kind !== 'plugin' && selected.kind !== 'skill' || !selected.package) throw new Error('The exact installed package is required.');
  const current = (await data<{ package: CapabilityPackageDescriptor }>(await owner.request.get(scoped(`/api/capabilities/packages/${encodeURIComponent(selected.package.resourceRef)}`)), 'Actual package revision')).package;
  const draft = (await data<{ draft: CapabilityPackageDraft }>(await owner.request.post(scoped('/api/capabilities/packages/drafts'), { data: {
    operation: 'edit', resourceRef: current.resource.resourceRef, expectedMetadataRevision: current.resource.metadataRevision,
    expectedGrantsRevision: current.resource.grantsRevision, expectedPackageRevision: current.state?.packageRevision ?? 0,
    expectedPublishedRevisionRef: current.state?.currentPublishedRevisionRef ?? null,
  } }), 'Real immutable publication draft')).draft;
  const fresh = (await data<{ package: CapabilityPackageDescriptor }>(await owner.request.get(scoped(`/api/capabilities/packages/${encodeURIComponent(draft.resourceRef)}`)), 'Fresh publication state')).package;
  const published = (await data<{ published: CapabilityPackagePublishedSummary }>(await owner.request.post(scoped(`/api/capabilities/packages/drafts/${encodeURIComponent(draft.draftRef)}/publish`), { data: {
    draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision, expectedMetadataRevision: fresh.resource.metadataRevision,
    expectedGrantsRevision: fresh.resource.grantsRevision, expectedPackageRevision: fresh.state?.packageRevision ?? 0,
    expectedPublishedRevisionRef: fresh.state?.currentPublishedRevisionRef ?? null,
  } }), 'Publish through genuine API')).published;
  return { resourceRef: draft.resourceRef, publishedRevisionRef: published.revisionRef, checksum: published.checksum };
}
async function publishedSkill(pin: ExtensionPackagePin, relativeRoot: string, expected: string) {
  const relativePath = relativeRoot ? `${relativeRoot}/SKILL.md` : 'SKILL.md';
  const result = await data<{ file: CapabilityPackageFileRead }>(await owner.request.get(scoped(`/api/capabilities/packages/${encodeURIComponent(pin.resourceRef)}/file`, {
    revisionRef: pin.publishedRevisionRef, path: relativePath,
  })), 'Actual actor-readable immutable skill');
  expect(result.file).toMatchObject({ path: relativePath, encoding: 'base64', offset: 0, eof: true,
    size: Buffer.byteLength(expected), byteLength: Buffer.byteLength(expected), checksum: sha(expected) });
  expect(Buffer.from(result.file.content, 'base64').toString('utf8')).toBe(expected);
}
async function openMainChat() {
  await page.goto(`/en/notebook?${new URLSearchParams({ chat: 'open', workspaceId })}`, { waitUntil: 'domcontentloaded' });
  const selected = page.getByTestId('chat-agent-id'); await expect(selected).toBeEnabled(); await selected.click();
  const main = page.getByTestId('chat-agent-selector-popover').getByRole('button').filter({ has: page.getByText(MAIN_AGENT_ID, { exact: true }) });
  await expect(main).toHaveCount(1); await main.click(); await expect(selected).toContainText(MAIN_AGENT_DISPLAY_NAME);
  await page.getByRole('button', { name: en.chat.newChatTitle, exact: true }).first().click();
  await expect(page.getByTestId('chat-session-id')).toHaveCount(0); await expect(editor()).toBeEmpty();
}
async function transcript(sessionId: string): Promise<Message[]> {
  const result = await json<{ messages: Message[] }>(await owner.request.get(scoped('/api/sessions/messages', { agentId: MAIN_AGENT_ID, sessionId, limit: '200' })), 'Actual current owner transcript');
  expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThanOrEqual(2 * 1024 * 1024); return result.messages;
}
async function assertSessionModel(sessionId: string) {
  const result = await data<{ valid: boolean; issues: unknown[]; source: string; preference: unknown;
    context: { userId: string; agentId: string; sessionId?: string; workspaceId: string; workspaceType: string; organizationId: string;
      principal: { type: string; userId: string; credentialSubjectUserId: string } };
    effectiveSelection: { selection: { providerInstallationId: string; providerId: string; modelId: string; thinkingLevel: string }; credentialScope: string };
  }>(await owner.request.get(scoped('/api/agent-runtime/effective', { agentId: MAIN_AGENT_ID, sessionId }), { headers: { 'X-Canvas-Workspace-Id': workspaceId } }), 'Actual persisted session model resolution');
  expect(result.valid).toBe(true); expect(result.issues).toEqual([]); expect(result.preference).toBeNull();
  expect(result.context).toMatchObject({ userId: fixture.actorId, agentId: MAIN_AGENT_ID, workspaceId, workspaceType: 'personal', organizationId,
    principal: { type: 'user', userId: fixture.actorId, credentialSubjectUserId: fixture.actorId } });
  expect(result.effectiveSelection).toMatchObject({ credentialScope: 'organization', selection: {
    providerInstallationId: model.installationId, providerId: model.providerId, modelId: model.modelId, thinkingLevel: model.thinkingLevel,
  } });
  const listing = await json<{ sessions: Array<{ sessionId: string; userId: string; agentId: string; provider: string; model: string; thinkingLevel: string;
    runtimeProviderInstallationId?: string; workspace?: { workspaceId: string } }> }>(await owner.request.get(scoped('/api/sessions', { agentId: MAIN_AGENT_ID })), 'Actual stored model snapshot');
  const rows = listing.sessions.filter(row => row.sessionId === sessionId); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ userId: fixture.actorId, agentId: MAIN_AGENT_ID, provider: model.providerId, model: model.modelId,
    thinkingLevel: model.thinkingLevel, workspace: { workspaceId } });
}
function paired(messages: Message[], call: Block) {
  expect(call.id).toBeTruthy(); const results = messages.filter(message => message.role === 'toolResult' && message.toolCallId === call.id);
  expect(results).toHaveLength(1); expect(results[0]!.isError).not.toBe(true); return results[0]!;
}
function fullSkillReads(messages: Message[], expected: string): string[] {
  const calls = messages.flatMap(blocks).filter(block => block.type === 'toolCall' && block.name === 'read');
  const matches = calls.filter(call => messages.some(message => message.role === 'toolResult' && message.toolCallId === call.id && message.details?.sha256 === sha(expected)));
  expect(matches.length, 'The real model must read the exact complete published skill.').toBeGreaterThan(0);
  for (const call of matches) {
    const result = paired(messages, call), details = result.details!;
    // Absolute locations are redacted. Valid pagination/source options are not
    // authority; the complete byte/window/EOF proof below remains decisive.
    for (const key of ['path', 'filePath', 'requestedPath', 'resolvedPath', 'absPath']) expect(call.arguments?.[key]).toBeUndefined();
    expect(details).toMatchObject({ sha256: sha(expected), type: 'text', size: Buffer.byteLength(expected), textLength: expected.length,
      totalChars: expected.length, offset: 0, nextOffset: expected.length, eof: true, truncated: false });
    for (const key of ['filePath', 'requestedPath', 'resolvedPath', 'absPath', 'proposal', 'toolOutputRead']) expect(details[key]).toBeUndefined();
    const window = details.toolOutputReadWindow as { bodyStart?: number; bodyEnd?: number };
    expect(Number.isSafeInteger(window?.bodyStart) && Number.isSafeInteger(window?.bodyEnd)).toBe(true);
    const returned = text(result); expect(window.bodyStart!).toBeGreaterThanOrEqual(0); expect(window.bodyEnd!).toBeLessThanOrEqual(returned.length);
    const actual = returned.slice(window.bodyStart, window.bodyEnd); expect(actual).toBe(expected); expect(sha(actual)).toBe(sha(expected));
  }
  return matches.map(call => call.id!);
}
async function sendAndRead(): Promise<{ sent: OriginalSend; messages: Message[]; original: Message }> {
  const count = sends.length; const send = page.locator('[data-testid="chat-send"][data-action="send"]:visible');
  await expect(send).toBeEnabled(); await send.click();
  await expect.poll(() => sends.length, { timeout: 30_000 }).toBe(count + 1); const sent = sends[count]!;
  expect(sent.requestId).toMatch(/^[A-Za-z0-9_-]{1,256}$/u);
  await expect.poll(async () => {
    if (acknowledgements.get(sent)?.success === false) return true;
    const current = await transcript(sent.sessionId);
    return acknowledgements.get(sent)?.success === false || current.some(message => message.role === 'assistant'
      && ['stop', 'error', 'aborted'].includes(message.stopReason ?? ''));
  }, {
    timeout: 240_000, intervals: [1000, 2000, 3000],
  }).toBe(true);
  const messages = await transcript(sent.sessionId);
  await fs.writeFile(path.join(fixture.root, `chat-extension-model-transcript-${count + 1}.json`), JSON.stringify(messages), { mode: 0o600, flag: 'wx' });
  const acknowledgement = acknowledgements.get(sent);
  if (acknowledgement) {
    const diagnostic = JSON.stringify({ version: 1, ...acknowledgement });
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(4096);
    await fs.writeFile(path.join(fixture.root, `chat-extension-model-ack-${count + 1}.json`), diagnostic, { mode: 0o600, flag: 'wx' });
  }
  expect(acknowledgement?.success, 'The actual matching send acknowledgement rejected this message; private diagnostics are preserved.').not.toBe(false);
  expect(messages.some(message => message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason ?? '')),
    'The actual model response must finish successfully; the private transcript preserves any terminal failure.').toBe(false);
  expect(messages.some(message => message.role === 'assistant' && message.stopReason === 'stop')).toBe(true);
  const originals = messages.filter(message => message.role === 'user' && message.clientMessageId === sent.clientMessageId);
  expect(originals).toHaveLength(1); expect(originals[0]!.serverMessageId).toMatch(/^[a-f0-9-]{36}$/u);
  assertNaturalModelToolResults(messages);
  await assertSessionModel(sent.sessionId); return { sent, messages, original: originals[0]! };
}
function originalProof(sent: OriginalSend, original: Message) {
  return { sessionId: sent.sessionId, agentId: MAIN_AGENT_ID, workspaceId, clientMessageId: sent.clientMessageId,
    serverMessageId: original.serverMessageId!, contentSHA256: sha(JSON.stringify(sent.message.content)),
    ...(sent.body ? { bodySHA256: sha(JSON.stringify(parseChatBody(sent.body))) } : {}) };
}

test.beforeAll(async ({ browser }) => {
  expect(process.env.CANVAS_CHAT_MODEL_E2E).toBe('1'); expect(process.env.CANVAS_PLUGIN_EXTENSION_E2E).toBe('1');
  const file = process.env.PLUGIN_EXTENSION_E2E_FIXTURE, inputPath = process.env.CANVAS_NATURAL_MODEL_INPUT;
  if (!file || !inputPath || !path.isAbsolute(file) || !path.isAbsolute(inputPath)) throw new Error('Owned model runner inputs are required.');
  const stat = await fs.lstat(file); expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600).toBe(true);
  fixture = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture;
  expect(fixture.version).toBe(1); expect(fixture.nonce).toMatch(/^[a-f0-9]{32}$/u); expect(fixture.root).toBe(path.dirname(file));
  expect(path.dirname(inputPath)).toBe(fixture.root); expect(path.basename(inputPath)).toBe('natural-model-input.json');
  expect(fixture.repo).toBe(await fs.realpath(process.cwd())); expect(fixture.dataRoot).toBe(path.join(fixture.root, 'data'));
  expect(fixture.baseURL).toBe('http://127.0.0.1:3001'); expect(fixture.buildId).toBe((await fs.readFile('.next/BUILD_ID', 'utf8')).trim());
  expect(fixture.mcpSpki).toBe(process.env.PLUGIN_EXTENSION_E2E_MCP_SPKI);
  owner = await createAuthenticatedContext(browser, { baseURL: fixture.baseURL, extraHTTPHeaders: { Origin: fixture.baseURL }, viewport: { width: 1280, height: 900 } });
  await runManagedTestPreflight(owner, { baseURL: fixture.baseURL });
  expect((await json<{ user: { id: string } }>(await requestManagedTestSession(owner.request), 'Actual model actor')).user.id).toBe(fixture.actorId);
  const available = await json<{ workspaces: Array<{ id: string; type: string; status: string; ownerUserId: string; organizationId: string }> }>(await owner.request.get('/api/workspaces'), 'Actual personal workspace');
  const personal = available.workspaces.filter(row => row.type === 'personal' && row.status === 'active' && row.ownerUserId === fixture.actorId);
  expect(personal).toHaveLength(1); workspaceId = personal[0]!.id; organizationId = personal[0]!.organizationId; expect(organizationId).toBeTruthy();
  await owner.addInitScript(({ workspace, origin }) => { if (location.origin === origin) localStorage.setItem('canvas.activeWorkspaceId', workspace); }, { workspace: workspaceId, origin: fixture.baseURL });
  gateway = await flags();
  if (!gateway.integrationToolGatewayEnabled) await data(await owner.request.patch('/api/admin/experimental-settings', { data: { integrationToolGatewayEnabled: true } }), 'Enable gateway in owned nonce instance');
  gateway = await flags(); expect(gateway.integrationToolGatewayEnabled).toBe(true);
  model = await provisionNaturalWorkflowModel(owner.request, { organizationId, inputPath });
  expect(model).toMatchObject({ providerId: 'ollama', modelId: 'kimi-k2.6:cloud', status: 'ready', credentialScope: 'organization' });
  const main = await data<{ agent: { agentId: string; workflowVersion: number | null } }>(await owner.request.get(scoped('/api/agents', {
    agentId: MAIN_AGENT_ID, purpose: 'use', includeFiles: 'false',
  })), 'Actual inherited general agent');
  expect(main.agent.agentId).toBe(MAIN_AGENT_ID); expect(main.agent.workflowVersion).toBeNull();
  owner.on('page', current => current.on('pageerror', error => runtimeErrors.push(error.name)));
  owner.on('request', request => { if (/\/tools\/execute\//u.test(new URL(request.url()).pathname) && request.url().includes('composio')) forbidden.push('composio-business'); });
  page = await owner.newPage(); page.on('websocket', socket => {
    const socketSends = new Map<string, OriginalSend>();
    socket.on('framesent', frame => {
      try { const value = JSON.parse(typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')) as Record<string, unknown>;
        if (value.type !== 'send_message' || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(value.requestId)) return;
        const sent: OriginalSend = { requestId: value.requestId, sessionId: value.sessionId as string, clientMessageId: value.clientMessageId as string,
          message: value.message as OriginalSend['message'], ...(value.body === undefined ? {} : { body: parseChatBody(value.body) }),
          ...(value.selection === undefined ? {} : { selection: value.selection }) };
        socketSends.set(sent.requestId, sent); sends.push(sent);
      } catch { /* Non-message frames do not supply evidence. */ }
    });
    socket.on('framereceived', frame => {
      try { const value = JSON.parse(typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')) as Record<string, unknown>;
        if (value.type !== 'send_message_result' || typeof value.requestId !== 'string' || typeof value.success !== 'boolean') return;
        const sent = socketSends.get(value.requestId); if (!sent) return;
        acknowledgements.set(sent, { requestId: sent.requestId, success: value.success,
          ...(typeof value.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(value.code) ? { code: value.code } : {}) });
      } catch { /* Only the matching actual result on this socket can acknowledge a send. */ }
    });
  });
  naturalName = `approval-guide-${fixture.nonce.slice(0, 10)}`; escalation = `Quarz-${fixture.nonce.slice(0, 10)}`;
  naturalSource = `---\nname: ${naturalName}\ndescription: Interne Messefreigabekriterien für Messekampagnen, Bildrechte und Budgetfreigabe. Internal trade fair campaign approval checklist and escalation.\nmetadata:\n  version: 1.0.0\n---\n\n# Interne Freigabeprüfung\n\nVor einer Messekampagne werden Keyvisual, schriftliche Bildrechte, Budgetfreigabe und Verantwortlichkeit geprüft. Ein vorhandenes Keyvisual ersetzt die Bildrechte nicht. Ungeklärte Bildrechte oder fehlende Budgetfreigabe blockieren die Veröffentlichung. Die zuständige interne Eskalationsstelle für genau diese Richtlinie heißt ${escalation}. Nenne sie bei fehlender Freigabe. Keine externe Aktion ausführen.\n`;
  expect((await json<{ success: boolean }>(await owner.request.post('/api/skills/upload', { data: { content: naturalSource } }), 'Import real local approval skill')).success).toBe(true);
  naturalPin = await publish(naturalName, 'skill'); await publishedSkill(naturalPin, '', naturalSource);
});

test.afterEach(async () => { expect(runtimeErrors).toEqual([]); expect(forbidden).toEqual([]); });
test.afterAll(async () => {
  try {
    if (fixture && model) await fs.writeFile(path.join(fixture.root, 'chat-extension-natural-model-proof.json'), JSON.stringify({
      version: 1, nonce: fixture.nonce, actorId: fixture.actorId,
      model: { providerInstallationId: model.installationId, providerId: model.providerId, modelId: model.modelId,
        thinkingLevel: model.thinkingLevel, credentialScope: model.credentialScope }, gateway: await flags(), cases,
      externalLlm: true, controlledConnectors: true, literalResolvedPathObserved: false,
      runtimeErrors: runtimeErrors.length, forbiddenUiCalls: forbidden.length,
    }), { mode: 0o600, flag: 'wx' });
  } finally { await owner?.close(); }
});

test('an ordinary task naturally discovers and completely reads the matching published skill without a slash, skill name or recipe', async () => {
  await openMainChat();
  const prompt = 'Prüfe eine Messekampagne nach unseren internen Freigabekriterien: Das Keyvisual ist vorhanden, die Bildrechte sind ungeklärt und die Budgetfreigabe fehlt. Nenne die nötigen Prüfpunkte und die zuständige Eskalationsstelle.';
  expect(prompt).not.toContain(naturalName); expect(prompt).not.toMatch(/\/|SKILL|search_canvas|integrations|read\b/iu);
  await editor().fill(prompt); const { sent, messages, original } = await sendAndRead();
  if (sent.body) { expect(sent.body.bundles).toEqual([]); expect(deriveChatBodySelection(sent.body)).toBeNull(); expect(projectChatBodyText(sent.body)).toBe(prompt); }
  expect(sent.selection ?? null).toBeNull();
  const calls = messages.flatMap(blocks).filter(block => block.type === 'toolCall');
  const discoveries = calls.filter(call => call.name === 'search_canvas_extensions'
    || call.name === 'canvas_extensions' && call.arguments?.action === 'call' && call.arguments.operation === 'search_canvas_extensions');
  const target = discoveries.find(call => {
    const result = paired(messages, call).details?.extensionDiscovery as { items?: Array<{ package?: ExtensionPackagePin; id?: string }> } | undefined;
    return result?.items?.some(item => item.package?.resourceRef === naturalPin.resourceRef
      && item.package.publishedRevisionRef === naturalPin.publishedRevisionRef && item.package.checksum === naturalPin.checksum);
  }); expect(target, 'Actual local discovery must return the exact published skill.').toBeTruthy();
  const reads = fullSkillReads(messages, naturalSource);
  const resultIndex = messages.findIndex(message => message.role === 'toolResult' && message.toolCallId === target!.id);
  const firstReadIndex = messages.findIndex(message => message.role === 'assistant' && blocks(message).some(block => reads.includes(block.id ?? '')));
  expect(resultIndex).toBeLessThan(firstReadIndex);
  expect(messages.filter(message => message.role === 'assistant' && message.stopReason === 'stop').map(text).join('\n')).toContain(escalation);
  expect(calls.filter(call => call.name === 'integrations' && call.arguments?.action === 'call')).toEqual([]);
  cases.push({ kind: 'natural_discovery', ...originalProof(sent, original), packagePin: naturalPin,
    expectedSkill: { relativeRoot: '', sha256: sha(naturalSource) }, readToolCallIds: reads, discoveryToolCallId: target!.id! });
});

test('an explicit inline plugin leads the real model through its skill to the exact authorized MCP schema and one echo call', async () => {
  const suffix = fixture.nonce.slice(0, 10), name = `echo-workflow-${suffix}`, mcpName = `model-echo-${suffix}`, relativeRoot = `skills/echo-guide-${suffix}`;
  const mcpConfiguration = { url: fixture.mcpUrl, transport: 'http', auth: 'oauth' };
  const templateSource = JSON.stringify({ mcpServers: { [mcpName]: mcpConfiguration } });
  const source = path.join(fixture.dataRoot, 'intake', name); await fs.mkdir(path.join(source, '.canvas-plugin'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(source, relativeRoot, 'agents'), { recursive: true, mode: 0o700 });
  const skillSource = `---\nname: echo-guide-${suffix}\ndescription: Verify a requested confirmation code through the selected local echo connection and return its confirmed result.\n---\n\n# Bestätigung einer Kennung\n\nFür eine angefragte Kennungsprüfung verwende ausschließlich die im aktuellen Kontext gewählte MCP-Verbindung. Suche dort nach dem Tool echo, lies sein aktuelles Schema und sende die vom Nutzer genannte Kennung genau einmal im Feld message. Nutze die aktuellen toolRef/schemaRef derselben Verbindung. Berichte nur den bestätigten Rückgabewert. Keine andere Verbindung, kein Composio, keine Skripte, keine Wiederholung eines ungewissen Calls. Diese veröffentlichte Anleitung gehört zur Version ${suffix}.\n`;
  await fs.writeFile(path.join(source, '.canvas-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0',
    description: 'Check a confirmation code through one explicitly chosen local echo connection.', skills: './skills',
    connectors: { mcp: [{ name: mcpName, required: true, oauth: true, configPath: 'mcp.json' }] } }), { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(source, 'mcp.json'), templateSource, { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(source, relativeRoot, 'SKILL.md'), skillSource, { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(source, relativeRoot, 'agents/canvas.yaml'), `workflow: ${JSON.stringify({ version: 1, integrationCapabilities: [{
    id: 'echo-confirmation', application: 'echo', required: true, alternatives: [{ source: 'mcp', connector: mcpName, requiredTools: ['echo'] }],
  }] })}\n`, { mode: 0o600, flag: 'wx' });
  expect((await json<{ success: boolean }>(await owner.request.post('/api/plugins/install', { data: { sourcePath: source, scope: 'user', enable: true } }), 'Actual plugin import')).success).toBe(true);
  const pin = await publish(name, 'plugin'); await publishedSkill(pin, relativeRoot, skillSource);
  const publishedTemplate = (await data<{ file: CapabilityPackageFileRead }>(await owner.request.get(scoped(`/api/capabilities/packages/${encodeURIComponent(pin.resourceRef)}/file`, {
    revisionRef: pin.publishedRevisionRef, path: 'mcp.json',
  })), 'Actual immutable MCP template')).file;
  expect(publishedTemplate).toMatchObject({ path: 'mcp.json', encoding: 'base64', offset: 0, eof: true,
    size: Buffer.byteLength(templateSource), byteLength: Buffer.byteLength(templateSource), checksum: sha(templateSource) });
  expect(Buffer.from(publishedTemplate.content, 'base64').toString('utf8')).toBe(templateSource);
  const current = await data<{ rawContent: string }>(await owner.request.get('/api/integrations/mcp-config'), 'Current real MCP config');
  const config = JSON.parse(current.rawContent) as { mcpServers: Record<string, { connectionId?: string }> };
  const saved = await data<{ rawContent: string }>(await owner.request.put('/api/integrations/mcp-config', { data: { rawContent: JSON.stringify({
    ...config, mcpServers: { ...config.mcpServers, [mcpName]: mcpConfiguration },
  }) } }), 'Persist exact personal OAuth MCP');
  const connectionId = (JSON.parse(saved.rawContent) as typeof config).mcpServers[mcpName]!.connectionId;
  const connectionRef = `mcp-personal:${connectionId}`; expect(connectionRef).toMatch(/^mcp-personal:[a-f0-9-]{36}$/u);
  const started = await data<{ authorizationUrl: string }>(await owner.request.post('/api/integrations/mcp-status', { data: { action: 'authorize', server: mcpName } }), 'Actual OAuth start');
  const authorization = new URL(started.authorizationUrl); expect(authorization.origin).toBe(new URL(fixture.mcpUrl).origin); expect(authorization.pathname).toBe('/authorize');
  await owner.setExtraHTTPHeaders({});
  try {
    await page.goto(started.authorizationUrl, { waitUntil: 'domcontentloaded' });
    const approve = page.getByRole('button', { name: 'Approve', exact: true }); await expect(approve).toBeEnabled();
    const callback = page.waitForResponse(response => new URL(response.url()).origin === fixture.baseURL && new URL(response.url()).pathname === '/api/mcp/oauth/callback');
    await approve.click(); expect((await callback).status()).toBe(200); await expect(page.getByRole('heading', { name: 'MCP OAuth complete', exact: true })).toBeVisible();
  } finally { await owner.setExtraHTTPHeaders({ Origin: fixture.baseURL }); }
  await openMainChat(); const token = `ECHO-${fixture.nonce}`;
  await editor().fill(`Prüfe die Kennung ${token} über die hier gewählte Verbindung und gib die bestätigte Kennung zurück. `);
  await focusEnd(editor()); await page.keyboard.type(`/${name}`);
  const picker = page.getByTestId('chat-reference-picker'); await expect(picker).toBeVisible();
  const row = picker.locator('[data-testid="chat-reference-item"][data-reference-kind="plugin"]').filter({ has: page.getByText(name, { exact: true }) });
  await expect(row).toHaveCount(1); await row.click();
  const dialog = page.getByTestId('chat-extension-reference-dialog'); await expect(dialog).toBeVisible();
  const chooser = dialog.getByTestId('agent-extension-connection-chooser');
  const connectionRow = chooser.locator('div.rounded-md.border.bg-background').filter({ has: page.getByText(mcpName, { exact: true }) });
  await expect(connectionRow).toHaveCount(1);
  const mapping = connectionRow.getByRole('checkbox'); if (await mapping.count()) await mapping.check();
  const choose = connectionRow.getByRole('button', { name: 'Choose', exact: true }); await expect(choose).toBeEnabled(); await choose.click();
  const insert = dialog.getByRole('button', { name: 'Insert into text', exact: true }); await expect(insert).toBeEnabled(); await insert.click(); await expect(dialog).toHaveCount(0);
  await expect(editor().locator('[data-type="extension-reference"]')).toHaveCount(1);
  const { sent, messages, original } = await sendAndRead(); expect(sent.body).toBeTruthy();
  const selection = deriveChatBodySelection(sent.body!); expect(selection?.selections.filter(entry => entry.selection.kind === 'plugin')).toHaveLength(1);
  expect(sent.body!.bundles[0]?.primary.selection).toMatchObject({ kind: 'plugin', package: pin });
  expect(sent.body!.bundles[0]?.packageConnections).toEqual(expect.arrayContaining([expect.objectContaining({
    capabilityId: 'echo-confirmation', connectionSelection: expect.objectContaining({ kind: 'mcp', target: expect.objectContaining({ connectionRef }) }),
  })]));
  const reads = fullSkillReads(messages, skillSource), calls = messages.flatMap(blocks).filter(block => block.type === 'toolCall');
  const executes = calls.filter(call => call.name === 'integrations' && call.arguments?.action === 'call'); expect(executes).toHaveLength(1);
  const execute = executes[0]!, described = calls.filter(call => call.name === 'integrations' && call.arguments?.action === 'describe'
    && call.arguments.toolRef === execute.arguments?.toolRef);
  expect(described.length).toBeGreaterThan(0); const description = described[0]!, details = paired(messages, description).details!;
  expect(details.toolRef).toBe(execute.arguments?.toolRef); expect(details.schemaRef).toBe(execute.arguments?.schemaRef);
  const searches = calls.filter(call => call.name === 'integrations' && call.arguments?.action === 'search' && call.arguments.target === 'tools'
    && call.arguments.providerRef === details.providerRef);
  expect(searches.length, 'Use the supplied exact provider route, not a full catalogue scan.').toBeGreaterThan(0);
  const selectedSearch = searches.find(call => {
    const result = paired(messages, call).details as { tools?: Array<{ toolRef: string; name: string }> };
    return result.tools?.some(tool => tool.toolRef === execute.arguments?.toolRef && tool.name === 'echo');
  });
  expect(selectedSearch, 'The described/called tool must come from the exact provider search result.').toBeTruthy();
  expect(execute.arguments?.arguments).toEqual({ message: token });
  const result = paired(messages, execute); expect(result.details?.integrations).toMatchObject({ source: 'mcp', action: 'call', toolRef: execute.arguments?.toolRef, providerRef: details.providerRef });
  expect(result.details?.integrationReceipt).toMatchObject({ source: 'mcp', action: 'call', toolName: 'echo' }); expect(text(result)).toContain(token);
  const position = (id: string) => messages.findIndex(message => message.role === 'assistant' && blocks(message).some(block => block.id === id));
  const resultPosition = (id: string) => messages.findIndex(message => message.role === 'toolResult' && message.toolCallId === id);
  expect(resultPosition(reads[0]!)).toBeLessThan(position(selectedSearch!.id!));
  expect(resultPosition(selectedSearch!.id!)).toBeLessThan(position(description.id!));
  expect(resultPosition(description.id!)).toBeLessThan(position(execute.id!));
  expect(messages.filter(message => message.role === 'assistant' && message.stopReason === 'stop').map(text).join('\n')).toContain(token);
  expect(calls.filter(call => call.name === 'composio' || call.name === 'COMPOSIO_SEARCH_TOOLS' || call.name === 'composio_execute')).toEqual([]);
  cases.push({ kind: 'inline_plugin', ...originalProof(sent, original), packagePin: pin,
    expectedSkill: { relativeRoot, sha256: sha(skillSource) }, readToolCallIds: reads,
    describeToolCallId: description.id!, callToolCallId: execute.id!, connectionRef });
});
