import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import { deriveChatBodySelection, projectChatBodyText, type ChatBodyV1 } from '../app/lib/chat/chat-body-contracts';
import { readMessageChatBody } from '../app/lib/chat/body-state';
import type { ExtensionPackagePin, StandaloneExtensionSelection } from '../app/lib/capabilities/extensions/contracts';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackagePublishedSummary } from '../app/lib/capabilities/packages/contracts';
import type { PluginExtensionSearchResponse } from '../app/lib/plugins/plugin-extension-contracts';
import type { ChatExtensionOptionsResponse } from '../app/lib/chat/extension-options-contracts';
import en from '../messages/en.json';

// Actual isolated production app, SQL/source/Session/Admission, OAuth and SDK.
// The owned model server returns deterministic SSE; this is not LLM/tool-business acceptance.
type Fixture = { version: 1; nonce: string; repo: string; root: string; dataRoot: string; actorId: string; baseURL: string;
  buildId: string; mcpUrl: string; mcpSpki: string; composioOrigin: string; logoUrl: string; modelProofUrl: string;
  model: { providerInstallationId: string; providerId: string; modelId: string; thinkingLevel: string; expectedCatalogRevision: number } };
type Sent = { sessionId: string; clientMessageId: string; body: ChatBodyV1; selection: { selections: Array<{ selection: StandaloneExtensionSelection | unknown; accountSelectionRef?: string }> } };
let fixture: Fixture, owner: BrowserContext, page: Page, workspaceId = '', agentId = '', agentName = '', profileId = '', profileName = '';
let pluginName = '', skillName = '', skillCaption = '', mcpName = '', mcpRef = '', sessionId = '';
let pluginPin: ExtensionPackagePin, skillPin: ExtensionPackagePin;
let selectedAccount: StandaloneExtensionSelection;
let budgetRejectionProof: { firstCode: string; retryCode: string; retryKeptExactIntent: boolean;
  userMessages: number; extraModelRequests: number; unexpectedAutoSends: number } | undefined;
const sends: Sent[] = [], runtimeErrors: string[] = [], forbidden: string[] = [], shots: string[] = [];
test.describe.configure({ mode: 'serial', retries: 0, timeout: 120_000 });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
async function json<T>(response: APIResponse | Response, phase: string, status = 200): Promise<T> {
  // No response body or expiring account receipt is printed or attached.
  expect(response.status(), `${phase}: HTTP status`).toBe(status); return response.json() as Promise<T>;
}
async function data<T>(response: APIResponse | Response, phase: string): Promise<T> {
  const result = await json<{ success: boolean; data: T }>(response, phase); expect(result.success, phase).toBe(true); return result.data;
}
const scoped = (url: string, extra: Record<string, string> = {}) => `${url}?${new URLSearchParams({ workspaceId, ...extra })}`;
const editor = () => page.locator('[data-testid="chat-inline-editor"] [role="textbox"][contenteditable="true"]:visible');
const homeEditor = () => page.locator('[data-home-prompt-editor] [role="textbox"][contenteditable="true"]');
const references = (input: Locator) => input.locator('[data-type="extension-reference"]');
async function focusEnd(input: Locator) {
  await input.focus(); await input.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
}
function optionsResponse(operation: string, predicate: (request: Record<string, unknown>) => boolean = () => true) {
  return page.waitForResponse(response => new URL(response.url()).pathname === '/api/chat/extension-options'
    && response.request().method() === 'POST' && response.request().postDataJSON()?.operation === operation
    && predicate(response.request().postDataJSON() as Record<string, unknown>), { timeout: 30_000 });
}
async function snapshot(name: string) {
  const filename = `chat-inline-${name}.png`; shots.push(filename); await page.screenshot({ path: path.join(fixture.root, filename), fullPage: true });
}
async function publish(name: string, kind: 'plugin' | 'skill') {
  const listing = await data<PluginExtensionSearchResponse>(await owner.request.get(scoped('/api/plugins/search', { q: name, types: kind })), 'Actual imported package');
  const matches = listing.items.filter(item => item.kind === kind && item.name === name && (item.kind === 'plugin' || item.kind === 'skill') && item.package);
  expect(matches).toHaveLength(1); const item = matches[0]!;
  if (item.kind !== 'plugin' && item.kind !== 'skill' || !item.package) throw new Error('Exact imported package required.');
  const current = (await data<{ package: CapabilityPackageDescriptor }>(await owner.request.get(scoped(`/api/capabilities/packages/${encodeURIComponent(item.package.resourceRef)}`)), 'Current source revisions')).package;
  const draft = (await data<{ draft: CapabilityPackageDraft }>(await owner.request.post(scoped('/api/capabilities/packages/drafts'), { data: { operation: 'edit',
    resourceRef: current.resource.resourceRef, expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision,
    expectedPackageRevision: current.state?.packageRevision ?? 0, expectedPublishedRevisionRef: current.state?.currentPublishedRevisionRef ?? null } }), 'Actual publication draft')).draft;
  const fresh = (await data<{ package: CapabilityPackageDescriptor }>(await owner.request.get(scoped(`/api/capabilities/packages/${encodeURIComponent(draft.resourceRef)}`)), 'Fresh source publication revisions')).package;
  const result = await data<{ published: CapabilityPackagePublishedSummary }>(await owner.request.post(scoped(`/api/capabilities/packages/drafts/${encodeURIComponent(draft.draftRef)}/publish`),
    { data: { draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision, expectedMetadataRevision: fresh.resource.metadataRevision,
      expectedGrantsRevision: fresh.resource.grantsRevision, expectedPackageRevision: fresh.state?.packageRevision ?? 0,
      expectedPublishedRevisionRef: fresh.state?.currentPublishedRevisionRef ?? null } }), 'Publish exact source');
  return { resourceRef: draft.resourceRef, publishedRevisionRef: result.published.revisionRef, checksum: result.published.checksum };
}
async function openSearch(input: Locator, query: string, type: 'plugin' | 'skill' | 'integration' | 'mcp') {
  await focusEnd(input); await page.keyboard.type(` /${query}`);
  const picker = page.getByTestId('chat-reference-picker'); await expect(picker).toBeVisible();
  const row = picker.locator(`[data-testid="chat-reference-item"][data-reference-kind="${type}"]`).filter({ hasText: query });
  await expect(row).toHaveCount(1); await row.click();
  const dialog = page.getByTestId('chat-extension-reference-dialog'); await expect(dialog).toBeVisible(); return dialog;
}
async function insertPackage(input: Locator, name: string, type: 'plugin' | 'skill') {
  const dialog = await openSearch(input, name, type);
  const insert = dialog.getByRole('button', { name: 'Insert into text', exact: true }); await expect(insert).toBeEnabled(); await insert.click();
  await expect(dialog).toHaveCount(0); await expect(references(input).filter({ hasText: type === 'skill' ? skillCaption : name })).toHaveCount(1);
}
async function transcript() {
  return json<{ messages: Array<{ role: string; body?: ChatBodyV1; content?: unknown }> }>(await owner.request.get(scoped('/api/sessions/messages',
    { agentId, sessionId, limit: '200' })), 'Actual persisted transcript');
}
async function expectFinishedReplies(count: number) {
  await expect(page.locator('[data-testid="chat-message-assistant"]:visible')).toHaveCount(count);
  await expect(page.getByLabel(en.chat.assistantStreamingAria, { exact: true }).and(page.locator(':visible'))).toHaveCount(0);
}
async function expectReadableUserReferences() {
  for (const bubble of await page.locator('[data-testid="chat-message-user"]:visible').all()) {
    await bubble.scrollIntoViewIfNeeded();
    await expect.poll(() => bubble.evaluate(node => {
      // Read one currently connected subtree in a single browser task. Metadata
      // may replace an avatar between separate asynchronous locator reads.
      const inner = node.querySelector(':scope > div');
      const references = [...node.querySelectorAll('[data-testid="chat-inline-reference"]')];
      const initials = references.flatMap(reference => [...reference.querySelectorAll('[data-testid="plugin-extension-avatar-initials"]')]);
      const connected = node.isConnected && Boolean(inner?.isConnected) && [...references, ...initials].every(element => element.isConnected);
      const foreground = inner ? getComputedStyle(inner).color : '';
      const colors = [...references, ...initials].map(element => getComputedStyle(element).color);
      return { connected, foreground, colors, readable: connected && foreground.length > 0 && references.length > 0
        && colors.every(color => color.length > 0 && color === foreground) };
    })).toMatchObject({ connected: true, readable: true });
  }
}
async function waitReply(count: number) {
  await expect(page.locator('[data-testid="chat-message-assistant"]:visible').filter({ hasText: 'Inline context received.' })).toHaveCount(count, { timeout: 45_000 });
  await expectFinishedReplies(count); await expectReadableUserReferences();
  const send = page.locator('[data-testid="chat-send"][data-action="send"]:visible');
  await expect(send).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="chat-send"][data-action="stop"]:visible')).toHaveCount(0);
  await expect(editor()).toBeEmpty(); await expect(send).toBeDisabled();
}
async function sendCurrent() {
  const count = sends.length, replies = await page.locator('[data-testid="chat-message-assistant"]:visible').filter({ hasText: 'Inline context received.' }).count();
  await page.locator('[data-testid="chat-send"]:visible').click();
  await expect.poll(() => sends.length, { timeout: 30_000 }).toBe(count + 1);
  const sent = sends[count]!; sessionId = sent.sessionId; expect(sent.clientMessageId).toBeTruthy(); await waitReply(replies + 1); return sent;
}

test.beforeAll(async ({ browser }) => {
  expect(process.env.CANVAS_PLUGIN_EXTENSION_E2E).toBe('1'); expect(process.env.CANVAS_CHAT_INLINE_E2E).toBe('1');
  const file = process.env.PLUGIN_EXTENSION_E2E_FIXTURE; if (!file || !path.isAbsolute(file)) throw new Error('Owned runner fixture required.');
  const stat = await fs.lstat(file); expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600).toBe(true);
  fixture = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture;
  expect(fixture.version).toBe(1); expect(fixture.nonce).toMatch(/^[a-f0-9]{32}$/u); expect(fixture.root).toBe(path.dirname(file));
  expect(path.basename(fixture.root)).toMatch(/^canvas-plugin-extension-e2e-[A-Za-z0-9]+$/u);
  expect(fixture.repo).toBe(await fs.realpath(process.cwd())); expect(fixture.dataRoot).toBe(path.join(fixture.root, 'data'));
  expect(fixture.buildId).toBe((await fs.readFile('.next/BUILD_ID', 'utf8')).trim()); expect(fixture.baseURL).toBe('http://127.0.0.1:3001');
  expect(fixture.mcpSpki).toBe(process.env.PLUGIN_EXTENSION_E2E_MCP_SPKI);
  const proofUrl = new URL(fixture.modelProofUrl); expect(proofUrl.hostname).toBe('127.0.0.1'); expect(proofUrl.pathname).toBe(`/__owned/${fixture.nonce}/proof`);
  owner = await createAuthenticatedContext(browser, { baseURL: fixture.baseURL, extraHTTPHeaders: { Origin: fixture.baseURL }, viewport: { width: 1280, height: 900 } });
  await runManagedTestPreflight(owner, { baseURL: fixture.baseURL });
  const auth = await json<{ user: { id: string } }>(await requestManagedTestSession(owner.request), 'Actual owner'); expect(auth.user.id).toBe(fixture.actorId);
  const workspaces = await json<{ workspaces: Array<{ id: string; type: string; ownerUserId: string; status: string }> }>(await owner.request.get('/api/workspaces'), 'Actual workspaces');
  workspaceId = workspaces.workspaces.find(row => row.type === 'personal' && row.ownerUserId === fixture.actorId && row.status === 'active')!.id; expect(workspaceId).toBeTruthy();
  // This existing preference boundary selects a real authorized workspace, not a fabricated API grant.
  await owner.addInitScript(({ workspace, origin }) => { if (location.origin === origin && !localStorage.getItem('canvas.activeWorkspaceId')) localStorage.setItem('canvas.activeWorkspaceId', workspace); },
    { workspace: workspaceId, origin: fixture.baseURL });
  owner.on('request', request => { const url = new URL(request.url()); if (/\/tools\/execute\//u.test(url.pathname) || /^\/api\/integrations\/gateway\/call/u.test(url.pathname)) forbidden.push(`${request.method()} ${url.pathname}`); });
  owner.on('page', current => current.on('pageerror', error => runtimeErrors.push(error.name)));
  page = await owner.newPage();
  page.on('websocket', socket => socket.on('framesent', event => {
    try { const value = JSON.parse(typeof event.payload === 'string' ? event.payload : event.payload.toString('utf8'));
      if (value.type === 'send_message' && value.body) sends.push({ sessionId: value.sessionId, clientMessageId: value.clientMessageId,
        body: value.body, selection: value.selection }); } catch { /* Non-JSON/non-message frames carry no test assertion. */ }
  }));
  const suffix = fixture.nonce.slice(0, 10); pluginName = `inline-plugin-${suffix}`; skillName = `inline-skill-${suffix}`; mcpName = `Inline MCP ${suffix}`;
  const intake = path.join(fixture.dataRoot, 'intake', pluginName); await fs.mkdir(path.dirname(intake), { recursive: true }); await fs.mkdir(intake, { mode: 0o700 });
  await fs.mkdir(path.join(intake, '.canvas-plugin')); await fs.mkdir(path.join(intake, 'skills', `${pluginName}-child`), { recursive: true });
  await fs.writeFile(path.join(intake, '.canvas-plugin/plugin.json'), JSON.stringify({ name: pluginName, version: '1.0.0', skills: './skills',
    description: 'Exact inline UI package with no connection requirements', interface: { logo: './logo.svg' } }), { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(intake, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2471a3"/></svg>', { mode: 0o600, flag: 'wx' });
  await fs.writeFile(path.join(intake, 'skills', `${pluginName}-child`, 'SKILL.md'), `---\nname: ${pluginName}-child\ndescription: Exact inline plugin child context\n---\nUse the explicitly selected published source.\n`, { mode: 0o600, flag: 'wx' });
  expect((await json<{ success: boolean }>(await owner.request.post('/api/plugins/install', { data: { sourcePath: intake, scope: 'user', enable: true } }), 'Install owned Plugin')).success).toBe(true);
  expect((await json<{ success: boolean }>(await owner.request.post('/api/skills/upload', { data: { content: `---\nname: ${skillName}\ndescription: INLINE_CONTEXT_SENTINEL exact selected skill metadata\nmetadata:\n  version: 1.0.0\n---\nINLINE_CONTEXT_SENTINEL. Read only this exact published skill when needed.\n` } }), 'Import owned Skill')).success).toBe(true);
  pluginPin = await publish(pluginName, 'plugin'); skillPin = await publish(skillName, 'skill');
  const configState = await data<{ rawContent: string }>(await owner.request.get('/api/integrations/mcp-config'), 'Own current MCP metadata');
  const config = JSON.parse(configState.rawContent) as { mcpServers: Record<string, { connectionId?: string }> };
  const savedConfig = await data<{ rawContent: string }>(await owner.request.put('/api/integrations/mcp-config', { data: { rawContent: JSON.stringify({ ...config,
    mcpServers: { ...config.mcpServers, [mcpName]: { url: fixture.mcpUrl } } }) } }), 'Own exact MCP creation');
  mcpRef = `mcp-personal:${(JSON.parse(savedConfig.rawContent) as typeof config).mcpServers[mcpName]!.connectionId}`; expect(mcpRef).toMatch(/^mcp-personal:[a-f0-9-]{36}$/u);
  agentName = `Inline specialist ${suffix}`;
  const relevantSkills = [`${pluginName}-child`, skillName];
  const created = await data<{ agent: { agentId: string; relevantSkills: string[] | null } }>(await owner.request.post(scoped('/api/agents'), { data: { name: agentName, scopeType: 'user',
    enabledTools: ['read', 'mcp', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute'],
    relevantSkills, relevantConnections: null,
    defaultProviderInstallationId: fixture.model.providerInstallationId, defaultProvider: fixture.model.providerId, defaultModel: fixture.model.modelId,
    defaultThinking: fixture.model.thinkingLevel, expectedCatalogRevision: fixture.model.expectedCatalogRevision } }), 'Actual source-bounded specialized Agent');
  agentId = created.agent.agentId; expect(created.agent.relevantSkills).toEqual(relevantSkills);
  const publishedSkill = await data<Extract<ChatExtensionOptionsResponse, { operation: 'package_version' }>>(
    await owner.request.post('/api/chat/extension-options', { data: { operation: 'package_version',
      target: { kind: 'draft_turn', agentId, workspaceId }, ...skillPin } }), 'Exact published Skill caption');
  const rootSkills = publishedSkill.package.children.filter(child => child.origin === 'standalone' && child.relativeRoot === '');
  expect(rootSkills).toHaveLength(1); skillCaption = rootSkills[0]!.title ?? rootSkills[0]!.name;
  const headers = { 'x-canvas-workspace-id': workspaceId };
  await json(await owner.request.get('/api/composio/profiles', { headers }), 'Current real default profile');
  profileName = `Inline exact profile ${suffix}`;
  profileId = (await json<{ profile: { id: string } }>(await owner.request.post('/api/composio/profiles', { headers, data: { name: profileName } }), 'Explicit own profile', 201)).profile.id;
  for (let index = 0; index < 2; index++) {
    const connected = await json<{ redirectUrl: string }>(await owner.request.post('/api/composio/connect/canva', { headers,
      data: { profileId, returnPath: `/en/settings?${new URLSearchParams({ tab: 'agent-settings', workspaceId })}` } }), 'Real own OAuth start');
    expect(new URL(connected.redirectUrl).origin).toBe(fixture.composioOrigin); await owner.setExtraHTTPHeaders({});
    try { await page.goto(connected.redirectUrl, { waitUntil: 'domcontentloaded' });
      const callback = page.waitForResponse(response => new URL(response.url()).origin === fixture.baseURL && new URL(response.url()).pathname === '/api/composio/callback');
      await page.getByRole('button', { name: 'Approve', exact: true }).click(); expect((await callback).status()).toBe(307);
      await page.waitForURL(url => url.origin === fixture.baseURL && url.pathname === '/en/settings'); }
    finally { await owner.setExtraHTTPHeaders({ Origin: fixture.baseURL }); }
  }
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) await snapshot(`failure-${info.line}`);
  expect(runtimeErrors).toEqual([]); expect(forbidden, 'No provider business tool is executed.').toEqual([]);
});
test.afterAll(async () => {
  if (fixture) await fs.writeFile(path.join(fixture.root, 'chat-inline-ui-proof.json'), JSON.stringify({ version: 1, nonce: fixture.nonce,
    actorId: fixture.actorId, agentId, workspaceId, screenshots: shots, sendAttemptCount: sends.length,
    pins: [pluginPin, skillPin], mcpRef, controlledSdkTransport: true, modelBusinessAcceptance: false,
    fullSkillReadAcceptance: false, runtimeErrors: runtimeErrors.length, forbiddenUiCalls: forbidden.length,
    ...(budgetRejectionProof ? { budgetRejection: budgetRejectionProof } : {}) }), { mode: 0o600 });
  await owner?.close();
});

test('Home has one four-type slash picker and atomic inline references with icons, Delete/Undo and actual plain-text paste', async () => {
  await page.goto(`/en?${new URLSearchParams({ workspaceId })}`, { waitUntil: 'domcontentloaded' });
  const input = homeEditor(); await expect(input).toBeVisible(); await input.fill('Before ');
  const selector = page.getByTestId('home-agent-id'); await expect(selector).toBeEnabled(); await selector.click();
  await page.getByTestId('chat-agent-selector-popover').getByRole('button').filter({ has: page.getByText(agentName, { exact: true }) }).filter({ has: page.getByText(agentId, { exact: true }) }).click(); await expect(selector).toContainText(agentName);
  const emptyChat = await owner.newPage();
  try {
    await emptyChat.goto(`/en/notebook?${new URLSearchParams({ chat: 'open', workspaceId })}`, { waitUntil: 'domcontentloaded' });
    const blankEditor = emptyChat.locator('[data-testid="chat-inline-editor"] [role="textbox"][contenteditable="true"]:visible');
    await expect(blankEditor).toBeEmpty(); await expect(emptyChat.getByTestId('chat-prompt-suggestion')).toBeVisible();
    const placeholder = blankEditor.locator('p.is-editor-empty'); await expect(placeholder).toHaveAttribute('data-placeholder', '');
    expect(await placeholder.evaluate(node => getComputedStyle(node, '::before').content)).toMatch(/^(?:none|normal|""|'')$/u);
    const filename = 'chat-inline-empty-composer.png'; shots.push(filename); await emptyChat.screenshot({ path: path.join(fixture.root, filename) });
  } finally { await emptyChat.close(); }
  await expect(input).toHaveText('Before'); await focusEnd(input); await page.keyboard.type('/');
  const picker = page.getByTestId('chat-reference-picker'); await expect(picker).toBeVisible();
  for (const [label, type] of [['Plugins', 'plugin'], ['Skills', 'skill'], ['Composio', 'integration'], ['MCP', 'mcp']] as const) {
    const response = optionsResponse('search', body => Array.isArray(body.types) && body.types.length === 1 && body.types[0] === type);
    await picker.getByRole('button', { name: label, exact: true }).click(); await response;
    await expect(picker.getByTestId('chat-reference-item').first()).toBeVisible();
    expect(await picker.getByTestId('chat-reference-item').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-reference-kind')))).toEqual(expect.arrayContaining([type]));
    expect((await picker.getByTestId('chat-reference-item').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-reference-kind')))).every(kind => kind === type)).toBe(true);
  }
  await picker.getByRole('button', { name: en.chat.referenceAllTypes, exact: true }).click();
  await focusEnd(input); await page.keyboard.type(pluginName);
  await picker.locator('[data-reference-kind="plugin"]').filter({ has: page.getByText(pluginName, { exact: true }) }).click();
  const dialog = page.getByTestId('chat-extension-reference-dialog'); await expect(dialog.getByRole('button', { name: 'Insert into text', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Insert into text', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(references(input)).toHaveCount(1); await focusEnd(input); await page.keyboard.type(' after');
  await expect(input).toHaveText(`Before ${pluginName} after`);
  const image = references(input).getByTestId('plugin-extension-avatar').locator('img'); await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await focusEnd(input); for (let index = 0; index < ' after'.length; index++) await input.press('ArrowLeft'); await input.press('Backspace');
  await expect(references(input)).toHaveCount(0); await input.press('ControlOrMeta+z'); await expect(references(input)).toHaveCount(1);
  await focusEnd(input); await owner.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixture.baseURL });
  // Only OS-clipboard preparation. App state/DOM are changed solely by actual Cmd/Ctrl+V.
  const pasted = ` literal <b>owned-${fixture.nonce.slice(0, 6)}</b>`;
  await page.evaluate(value => navigator.clipboard.writeText(value), pasted); await input.press('ControlOrMeta+v');
  await expect(input).toContainText(pasted); await expect(input.locator('b')).toHaveCount(0); await expect(references(input)).toHaveCount(1);
  await insertPackage(input, skillName, 'skill'); await expect(references(input)).toHaveCount(2);
  await expect(references(input).filter({ hasText: skillCaption }).getByTestId('plugin-extension-avatar-initials')).toBeVisible();
  await snapshot('home-inline-picker');
});

test('Home handoff sends exact inline body once, persists highlighted History and exposes the selected metadata to the controlled SDK', async () => {
  const before = sends.length;
  await page.locator('form').filter({ has: page.locator('[data-home-prompt-editor]') }).locator('button[type="submit"]').click();
  await expect.poll(() => sends.length, { timeout: 30_000 }).toBe(before + 1); const sent = sends[before]!; sessionId = sent.sessionId;
  expect(projectChatBodyText(sent.body)).toBe(`Before ${pluginName} after literal <b>owned-${fixture.nonce.slice(0, 6)}</b> ${skillCaption}`); expect(deriveChatBodySelection(sent.body)?.selections).toHaveLength(2);
  expect(sent.body.bundles.map(bundle => bundle.primary.selection.kind).sort()).toEqual(['plugin', 'skill']);
  await waitReply(1); const bubble = page.getByTestId('chat-message-user').last(); await expect(bubble.getByTestId('chat-inline-reference')).toHaveCount(2);
  await expect.poll(async () => (await transcript()).messages.filter(message => message.role === 'user' && readMessageChatBody(message)).length).toBe(1);
  const persisted = (await transcript()).messages.find(message => message.role === 'user' && readMessageChatBody(message)); expect(readMessageChatBody(persisted)).toEqual(sent.body);
  const proof = await json<{ completions: Array<{ hasSkillSentinel: boolean; hasSkillLocation: boolean }> }>(await owner.request.get(fixture.modelProofUrl), 'Owned SDK metadata proof');
  expect(proof.completions.some(value => value.hasSkillSentinel && value.hasSkillLocation)).toBe(true);
  const savedPresentation = optionsResponse('presentation', request =>
    (request.target as { sessionId?: string } | undefined)?.sessionId === sessionId
    && (request.selections as Array<{ kind?: string; package?: ExtensionPackagePin }> | undefined)?.some(selection =>
      selection.kind === 'plugin' && selection.package?.resourceRef === pluginPin.resourceRef
        && selection.package.publishedRevisionRef === pluginPin.publishedRevisionRef
        && selection.package.checksum === pluginPin.checksum) === true);
  await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.getByTestId('chat-message-user').last().getByTestId('chat-inline-reference')).toHaveCount(2);
  const presentationResponse = await savedPresentation;
  const expectedTurnTarget = { kind: 'turn', sessionId, expectedAgentId: agentId, expectedWorkspaceId: workspaceId };
  expect(presentationResponse.request().postDataJSON().target).toEqual(expectedTurnTarget);
  const presentation = await data<Extract<ChatExtensionOptionsResponse, { operation: 'presentation' }>>(presentationResponse, 'Actual saved-pin icon presentation after reload');
  expect(presentation.target).toEqual(expectedTurnTarget);
  const pluginPresentation = presentation.entries.find(entry => entry.selection.kind === 'plugin'
    && entry.selection.package.resourceRef === pluginPin.resourceRef);
  expect(pluginPresentation?.publicIcon).toBeTruthy();
  const savedPluginImage = page.getByTestId('chat-message-user').last().getByTestId('chat-inline-reference')
    .filter({ hasText: pluginName }).getByTestId('plugin-extension-avatar-image');
  await expect(savedPluginImage).toBeVisible();
  await expect.poll(() => savedPluginImage.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expectFinishedReplies(1); await expectReadableUserReferences();
  const input = editor(); await expect(input).toBeVisible(); await input.fill(''); await focusEnd(input);
  const recentResponse = optionsResponse('search', request => request.q === ''
    && (request.target as { sessionId?: string } | undefined)?.sessionId === sessionId);
  await page.keyboard.type('/');
  const picker = page.getByTestId('chat-reference-picker'); const recent = picker.locator('[data-reference-kind="plugin"]').filter({ hasText: pluginName });
  await expect(picker).toBeVisible();
  const searchResponse = await recentResponse;
  expect(searchResponse.request().postDataJSON().target).toEqual(expectedTurnTarget);
  const search = await data<Extract<ChatExtensionOptionsResponse, { operation: 'search' }>>(searchResponse, 'Actual empty search with admitted recent references');
  expect(search.target).toEqual(expectedTurnTarget);
  expect(search.recents.map(item => item.bodyBundle.primary)).toEqual(expect.arrayContaining(sent.body.bundles.map(bundle => bundle.primary)));
  await expect(recent).toContainText(en.chat.referenceRecent); await input.fill('');
  await expectFinishedReplies(1); await expectReadableUserReferences(); await snapshot('persisted-inline-history');
});

test('Full chat restores a structured draft, then uses exact own MCP and the explicitly confirmed second OAuth account', async () => {
  const input = editor(); await expect(input).toBeVisible(); await input.fill('Draft before'); await insertPackage(input, skillName, 'skill');
  await focusEnd(input); await page.keyboard.type(' draft tail');
  await expect.poll(() => page.evaluate(({ actor, workspace, session }) => {
    const entry = JSON.parse(localStorage.getItem('canvas.chat.composerDrafts.v1') ?? '{}')[JSON.stringify([JSON.stringify([actor, workspace]), session])];
    return Boolean(entry?.text?.includes('draft tail') && entry.body?.bundles?.length === 1);
  }, { actor: fixture.actorId, workspace: workspaceId, session: sessionId })).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' }); const restored = editor(); await expect(restored).toContainText('draft tail'); await expect(references(restored)).toHaveCount(1);
  let dialog = await openSearch(restored, mcpName, 'mcp'); let chooser = dialog.getByTestId('agent-extension-connection-chooser');
  await chooser.locator('div.rounded-md.border').filter({ has: page.getByText(mcpName, { exact: true }) }).getByRole('button', { name: 'Choose', exact: true }).click();
  await dialog.getByRole('button', { name: 'Insert into text', exact: true }).click(); await expect(dialog).toHaveCount(0);
  dialog = await openSearch(restored, 'Canva', 'integration'); chooser = dialog.getByTestId('agent-extension-connection-chooser');
  const accountResponse = optionsResponse('connection_choices', body => body.profileId === profileId);
  await chooser.getByRole('button', { name: new RegExp(`^${profileName}`, 'u') }).click();
  const accounts = await data<Extract<ChatExtensionOptionsResponse, { operation: 'connection_choices' }>>(await accountResponse, 'Actual explicit account choices');
  expect(accounts.accounts).toHaveLength(2); const chosen = accounts.accounts[1]!; selectedAccount = chosen.selection;
  await chooser.locator('div.rounded-md.border').filter({ has: page.getByText(chosen.label, { exact: true }) }).getByRole('button', { name: 'This account', exact: true }).click();
  await dialog.getByRole('button', { name: 'Insert into text', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(references(restored)).toHaveCount(3);
  const sent = await sendCurrent();
  expect(sent.body.bundles.some(bundle => JSON.stringify(bundle.primary.selection) === JSON.stringify(selectedAccount))).toBe(true);
  expect(sent.body.bundles.some(bundle => bundle.primary.selection.kind === 'mcp' && bundle.primary.selection.target.connectionRef === mcpRef)).toBe(true);
  expect(sent.selection.selections.filter(entry => Boolean(entry.accountSelectionRef))).toHaveLength(1);
  await expect.poll(async () => (await transcript()).messages.filter(message => message.role === 'user' && readMessageChatBody(message)).length).toBe(2);
  await expect(page.getByTestId('chat-message-user').last().getByTestId('chat-inline-reference')).toHaveCount(3); await snapshot('exact-account-inline-history');
});

test('390px mobile keeps inline references inside the message and accepts the same durable structured send', async () => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/en/notebook?${new URLSearchParams({ chat: 'open', workspaceId, session: sessionId })}`, { waitUntil: 'domcontentloaded' });
  const input = editor(); await expect(input).toBeVisible(); await input.fill('Mobile exact'); await insertPackage(input, skillName, 'skill');
  await expect(references(input)).toHaveCount(1); const sent = await sendCurrent(); expect(sent.body.bundles[0]?.primary.selection.kind).toBe('skill');
  expect(sent.body.bundles[0]?.primary.selection.kind === 'skill' && sent.body.bundles[0].primary.selection.package).toEqual(skillPin);
  await expect(page.getByTestId('chat-message-user').last().getByTestId('chat-inline-reference')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); await snapshot('mobile-390-inline-history');
});

test('Home shows an actual oversized inherited-context rejection without a ghost response and retries only the unchanged original handoff', async () => {
  const inheritedName = `Inline inherited ${fixture.nonce.slice(0, 10)}`;
  const created = await data<{ agent: { agentId: string; relevantSkills: string[] | null } }>(
    await owner.request.post(scoped('/api/agents'), { data: { name: inheritedName, scopeType: 'user',
      relevantSkills: null, relevantConnections: null,
      enabledTools: ['read', 'mcp', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute'],
      defaultProviderInstallationId: fixture.model.providerInstallationId, defaultProvider: fixture.model.providerId,
      defaultModel: fixture.model.modelId, defaultThinking: fixture.model.thinkingLevel,
      expectedCatalogRevision: fixture.model.expectedCatalogRevision } }), 'Actual fully inherited specialized Agent');
  expect(created.agent.relevantSkills).toBeNull(); const inheritedAgentId = created.agent.agentId;
  const modelCount = async () => (await json<{ completions: unknown[] }>(await owner.request.get(fixture.modelProofUrl), 'Owned SDK request count')).completions.length;
  const beforeModels = await modelCount();
  page = await owner.newPage();
  type Attempt = Sent & { requestId: string };
  type Result = { requestId: string; success: boolean; code?: string };
  const attempts: Attempt[] = [], results: Result[] = [];
  let authorizedAttempts = 0, unexpectedAutoSends = 0;
  page.on('websocket', socket => {
    socket.on('framesent', event => {
      try {
        const value = JSON.parse(typeof event.payload === 'string' ? event.payload : event.payload.toString('utf8'));
        if (value.type !== 'send_message' || !value.body) return;
        const attempt = { requestId: value.requestId, sessionId: value.sessionId, clientMessageId: value.clientMessageId,
          body: value.body, selection: value.selection };
        attempts.push(attempt); sends.push(attempt);
        if (attempts.length > authorizedAttempts) unexpectedAutoSends++;
      } catch { /* Only actual JSON user sends participate in this boundary assertion. */ }
    });
    socket.on('framereceived', event => {
      try {
        const value = JSON.parse(typeof event.payload === 'string' ? event.payload : event.payload.toString('utf8'));
        if (value.type === 'send_message_result') results.push({ requestId: value.requestId, success: value.success, code: value.code });
      } catch { /* Unrelated non-JSON frames cannot acknowledge a user send. */ }
    });
  });
  await page.goto(`/en?${new URLSearchParams({ workspaceId })}`, { waitUntil: 'domcontentloaded' });
  const input = homeEditor(); await expect(input).toBeVisible(); await input.fill('Reject inherited');
  const selector = page.getByTestId('home-agent-id'); await expect(selector).toBeEnabled(); await selector.click();
  await page.getByTestId('chat-agent-selector-popover').getByRole('button')
    .filter({ has: page.getByText(inheritedName, { exact: true }) })
    .filter({ has: page.getByText(inheritedAgentId, { exact: true }) }).click();
  await expect(selector).toContainText(inheritedName);
  await insertPackage(input, pluginName, 'plugin'); await insertPackage(input, skillName, 'skill');
  await expect(references(input)).toHaveCount(2);
  authorizedAttempts = 1;
  await page.locator('form').filter({ has: page.locator('[data-home-prompt-editor]') }).locator('button[type="submit"]').click();
  await expect.poll(() => attempts.length).toBe(1); const original = attempts[0]!;
  expect(original.clientMessageId).toBeTruthy();
  expect(projectChatBodyText(original.body)).toBe(`Reject inherited ${pluginName} ${skillCaption}`);
  expect(original.body.bundles.map(bundle => bundle.primary.selection.kind).sort()).toEqual(['plugin', 'skill']);
  const actualPins = original.body.bundles.map(bundle => bundle.primary.selection)
    .filter(selection => selection.kind === 'plugin' || selection.kind === 'skill').map(selection => selection.package);
  expect(actualPins).toEqual([pluginPin, skillPin]);
  await expect.poll(() => results.find(result => result.requestId === original.requestId)).toEqual({
    requestId: original.requestId, success: false, code: 'AGENT_EXTENSION_CONTEXT_TOO_LARGE' });
  const rejection = page.getByRole('alert').filter({ hasText: 'The selected extension identities and required usage guidance exceed the shared 8 KiB context budget.' });
  await expect(rejection).toBeVisible(); await expect(rejection.getByRole('button', { name: en.common.retry, exact: true })).toBeEnabled();
  await expect(page.locator('[data-testid="chat-send"][data-action="stop"]:visible')).toHaveCount(0);
  await expect(page.locator('[data-testid="chat-message-assistant"]:visible')).toHaveCount(0);
  await expect(page.getByTestId('chat-message-user')).toHaveCount(1);
  await expect(page.getByTestId('chat-message-user').getByTestId('chat-inline-reference')).toHaveCount(2);
  const savedIntent = await page.evaluate(() => {
    const handoff = JSON.parse(sessionStorage.getItem('canvas.chat.initialPrompt') ?? 'null');
    const transaction = Object.keys(sessionStorage).filter(key => key.startsWith('canvas.chat.sendTransaction.v1:'))
      .map(key => JSON.parse(sessionStorage.getItem(key) ?? 'null')).find(value => value?.handoffId === handoff?.handoffId);
    return { handoffBody: handoff?.body, retryBody: transaction?.body, clientMessageId: transaction?.message?.clientMessageId,
      targetSessionId: transaction?.targetSessionId, containsTransientSelection: Boolean(transaction && ('selection' in transaction || 'intakeSelection' in transaction)) };
  });
  expect(savedIntent).toEqual({ handoffBody: original.body, retryBody: original.body, clientMessageId: original.clientMessageId,
    targetSessionId: original.sessionId, containsTransientSelection: false });
  const history = async () => json<{ messages: Array<{ role: string }> }>(await owner.request.get(scoped('/api/sessions/messages',
    { agentId: inheritedAgentId, sessionId: original.sessionId, limit: '200' })), 'Actual rejected-send SQL history');
  expect((await history()).messages.filter(message => message.role === 'user')).toHaveLength(0);
  expect(await modelCount()).toBe(beforeModels); expect(attempts).toHaveLength(1); expect(unexpectedAutoSends).toBe(0);
  authorizedAttempts = 2;
  await rejection.getByRole('button', { name: en.common.retry, exact: true }).click();
  await expect.poll(() => attempts.length).toBe(2); const retry = attempts[1]!;
  expect(retry.clientMessageId).toBe(original.clientMessageId); expect(retry.sessionId).toBe(original.sessionId);
  expect(retry.body).toEqual(original.body); expect(retry.selection).toEqual(original.selection);
  await expect.poll(() => results.find(result => result.requestId === retry.requestId)).toEqual({
    requestId: retry.requestId, success: false, code: 'AGENT_EXTENSION_CONTEXT_TOO_LARGE' });
  await expect(rejection).toBeVisible(); await expect(rejection.getByRole('button', { name: en.common.retry, exact: true })).toBeEnabled();
  await expect(page.locator('[data-testid="chat-send"][data-action="stop"]:visible')).toHaveCount(0);
  await expect(page.locator('[data-testid="chat-message-assistant"]:visible')).toHaveCount(0);
  await expect(page.getByTestId('chat-message-user')).toHaveCount(1);
  const userMessages = (await history()).messages.filter(message => message.role === 'user').length;
  const extraModelRequests = await modelCount() - beforeModels;
  expect(userMessages).toBe(0); expect(extraModelRequests).toBe(0); expect(attempts).toHaveLength(2); expect(unexpectedAutoSends).toBe(0);
  budgetRejectionProof = { firstCode: results.find(result => result.requestId === original.requestId)!.code!,
    retryCode: results.find(result => result.requestId === retry.requestId)!.code!, retryKeptExactIntent: true,
    userMessages, extraModelRequests, unexpectedAutoSends };
  await snapshot('home-budget-rejection-retry');
});
