import { createHash, randomBytes } from 'node:crypto';
import { expect, test, type APIResponse, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createAuthenticatedContext, runManagedTestPreflight } from './helpers/managed-test-context';
import type { IntegrationBrowserProviderCalls } from '../scripts/fixtures/integration-tool-browser-provider';
import type { AiEffectiveRuntimeResolution } from '../app/lib/agent-runtime-policy/types';

type Agent = { agentId: string; name: string; revision: number; type: string; scopeType?: string; createdByUserId?: string; ownerUserId?: string };
type Flag = { integrationToolGatewayEnabled: boolean; updatedAt: string | null };
type Secret = { revision: string; entries: Array<{ key: string; value: string; readable?: boolean }> };
type McpRaw = { rawContent: string };
type Config = { mcpServers?: Record<string, unknown>; [key: string]: unknown };
type Profile = { id: string; name: string; source?: 'default' | 'workspace_override'; workspaceOverrideCount?: number; automationCount?: number };
type MessageContentBlock = { type?: string; name?: string; text?: string; arguments?: unknown };
type Message = { role: string; toolName?: string; content?: string | MessageContentBlock[];
  stopReason?: string; details?: { integrationReceipt?: { action?: string; source?: string; providerName?: string; connectionName?: string } } };
const nonce = randomBytes(5).toString('hex');
const agentName = `Canva Gateway QA ${nonce}`;
const mcpName = `canva-gateway-qa-${nonce}`;
const profileName = `Canva Design QA ${nonce}`;
const inertKey = `integration-browser-inert-${nonce}`;
const secretPath = '/api/integrations/env?scope=integrations&secretScope=system&key=COMPOSIO_API_KEY';
let admin: BrowserContext;
let page: Page;
let ownedAgent: Agent | null = null;
let ownerId = '';
let workspaceId = '';
let fixtureUrl = '';
let originalFlag: Flag | null = null;
let ownedFlagRevision: string | null = null;
let originalKey: string | null = null;
let secretChanged = false;
let originalMcpRaw: string | null = null;
let ownedMcpEntry: unknown;
let ownedProfile: Profile | null = null;
const ownedSessions = new Set<string>();
const sessionReceipts: Promise<void>[] = [];
test.use({ trace: 'off', video: 'off' });

async function payload<T>(response: Pick<APIResponse, 'ok' | 'status' | 'json'>, phase: string): Promise<T> {
  if (!response.ok()) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  return await response.json() as T;
}

function parseConfig(raw: string): Config {
  const value: unknown = raw.trim() ? JSON.parse(raw) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Existing MCP configuration is not a JSON object.');
  return value as Config;
}

async function flag(request = admin.request): Promise<Flag> {
  return (await payload<{ success: boolean; data: Flag }>(await request.get('/api/admin/experimental-settings'), 'Experimental settings read')).data;
}

async function fixtureCalls(): Promise<IntegrationBrowserProviderCalls> {
  return await payload(await admin.request.get(`${fixtureUrl}/__fixture/calls`), 'Provider fixture evidence');
}

async function transcript(sessionId: string): Promise<Message[]> {
  const query = new URLSearchParams({ agentId: ownedAgent!.agentId, sessionId, workspaceId, limit: '200' });
  const result = await payload<{ success: boolean; messages: Message[] }>(await admin.request.get(`/api/sessions/messages?${query}`), 'Persisted chat transcript');
  return result.messages;
}

function contentBlocks(message: Message): MessageContentBlock[] {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return message.content || [];
}

function text(messages: Message[]): string {
  return messages.flatMap(contentBlocks).map(part => part.type === 'text' ? part.text || '' : '').join('\n');
}

async function noOverflow(target: Page) {
  expect(await target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Page must fit the viewport').toBe(true);
}

async function setFlagThroughUi(enabled: boolean) {
  const toggle = page.locator('#integration-tool-gateway-enabled');
  await expect(toggle).toBeEnabled();
  if ((await toggle.getAttribute('aria-checked')) === String(enabled)) return;
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/experimental-settings'
    && response.request().method() === 'PATCH' && response.request().postDataJSON()?.integrationToolGatewayEnabled === enabled);
  await toggle.click();
  const result = await payload<{ success: boolean; data: { integrationToolGatewayEnabled: boolean; integrationToolGatewayUpdatedAt: string } }>(await saved, 'Admin UI gateway toggle');
  expect(result.success).toBe(true);
  expect(result.data.integrationToolGatewayEnabled).toBe(enabled);
  ownedFlagRevision = result.data.integrationToolGatewayUpdatedAt;
  await expect(toggle).toHaveAttribute('aria-checked', String(enabled));
}

async function openOwnedChat() {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto(`/notebook?chat=open&workspaceId=${encodeURIComponent(workspaceId)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await page.getByTestId('chat-agent-id').click();
  await page.getByTestId('chat-agent-selector-popover').getByRole('button').filter({ hasText: agentName }).click();
  await expect(page.getByTestId('chat-agent-id')).toContainText(agentName);
  await page.getByRole('button', { name: /new chat|neuen chat|neuer chat/i }).click();
  await expect(page.getByTestId('chat-session-id')).toHaveCount(0);
  await expect(page.getByTestId('chat-input')).toBeEnabled();
}

async function sendNaturalPrompt(prompt: string): Promise<string> {
  await page.getByTestId('chat-input').fill(prompt);
  await expect(page.getByTestId('chat-send')).toBeEnabled();
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-session-id')).toHaveAttribute('title', /.+/, { timeout: 30_000 });
  const sessionId = (await page.getByTestId('chat-session-id').getAttribute('title'))!;
  ownedSessions.add(sessionId);
  return sessionId;
}

async function screenshots(info: TestInfo, label: 'mcp' | 'composio') {
  const sourceLabel = label === 'mcp' ? 'MCP' : 'Composio';
  const providerLabel = label === 'mcp' ? mcpName : 'Canva';
  const actionLabels = [/Tool prüfen|Inspect tool/u, /Tool ausführen|Run tool/u];
  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']] as const) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(value => localStorage.setItem('theme', value), theme);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 30_000 });
    const batches = page.getByTestId('chat-run-disclosure-toggle');
    await expect(batches.first()).toBeVisible();
    for (const button of await batches.all()) if (await button.getAttribute('aria-expanded') === 'true') await button.click();
    for (const actionLabel of actionLabels) {
      const header = batches.filter({ hasText: actionLabel }).last();
      await expect(header).toBeVisible();
      await expect(header).toHaveAttribute('aria-expanded', 'false');
      await expect(header).toContainText(sourceLabel);
      await expect(header).toHaveAccessibleName(new RegExp(sourceLabel, 'u'));
      await expect(header).toContainText(providerLabel);
      await expect(header).toHaveAccessibleName(new RegExp(providerLabel, 'u'));
      if (label === 'composio') {
        await expect(header).toContainText(profileName);
        await expect(header).toHaveAccessibleName(new RegExp(profileName, 'u'));
      }
    }
    expect((await batches.allTextContents()).join(' ')).toMatch(/Canva|canva/);
    expect((await batches.allTextContents()).join(' ')).not.toMatch(/(?:mcp|composio|tool|schema):v1:/u);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath(`${label}-${width}-${theme}-collapsed.png`), fullPage: true, animations: 'disabled' });
    for (const button of await batches.all()) if (await button.getAttribute('aria-expanded') === 'false') await button.click();
    for (const actionLabel of actionLabels) {
      const pill = page.getByTestId('chat-run-step').getByRole('button', { name: actionLabel }).last();
      await expect(pill).toBeVisible();
      await expect(pill).toHaveAccessibleName(new RegExp(sourceLabel, 'u'));
      await expect(pill).toContainText(providerLabel);
      if (label === 'composio') await expect(pill).toHaveAccessibleName(new RegExp(profileName, 'u'));
    }
    await page.screenshot({ path: info.outputPath(`${label}-${width}-${theme}-steps.png`), fullPage: true, animations: 'disabled' });
    const sourcePill = page.getByTestId('chat-run-step').getByRole('button', { name: /^(?:Tool ausführen|Run tool)/u }).last();
    await expect(sourcePill).toBeVisible();
    await expect(sourcePill).toHaveAccessibleName(new RegExp(sourceLabel, 'u'));
    await sourcePill.click();
    const detailsPanel = page.getByRole('dialog')
      .filter({ has: page.getByTestId('chat-integration-context') }).last();
    await expect(detailsPanel).toBeVisible();
    await expect(detailsPanel).toHaveAttribute('data-state', 'open');
    await expect(detailsPanel).toHaveCSS('opacity', '1');
    await expect(page.getByTestId('chat-integration-context').last()).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${label}-${width}-${theme}-details.png`), fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(detailsPanel).toBeHidden();
  }
}

async function cleanup() {
  if (!admin) return;
  await Promise.allSettled(sessionReceipts);
  const errors: string[] = [];
  const attempt = async (phase: string, operation: () => Promise<void>) => { try { await operation(); } catch { errors.push(phase); } };
  await attempt('owned agent and chats', async () => {
    if (!ownedAgent) return;
    const result = await payload<{ data: { agent: Agent } }>(await admin.request.get(`/api/agents?agentId=${encodeURIComponent(ownedAgent.agentId)}`), 'Owned agent verification');
    if (result.data.agent.name !== agentName || result.data.agent.ownerUserId !== ownerId || result.data.agent.createdByUserId !== ownerId
      || result.data.agent.type === 'main') throw new Error('Owned agent identity changed; preservation required.');
    const sessions = await payload<{ sessions: Array<{ sessionId: string; agentId: string }> }>(await admin.request.get(`/api/sessions?agentId=${encodeURIComponent(ownedAgent.agentId)}`), 'Owned sessions verification');
    for (const item of sessions.sessions) {
      if (item.agentId !== ownedAgent.agentId || !ownedSessions.has(item.sessionId)) throw new Error('An unowned session exists; preservation required.');
      await payload(await admin.request.delete(`/api/sessions?agentId=${encodeURIComponent(ownedAgent.agentId)}&sessionId=${encodeURIComponent(item.sessionId)}`), 'Owned chat deletion');
    }
    const preview = await payload<{ data: { agent: Agent; confirmationToken: string } }>(await admin.request.post('/api/agents/delete-preview', { data: { agentId: ownedAgent.agentId } }), 'Owned agent delete preview');
    if (preview.data.agent.name !== agentName || preview.data.agent.createdByUserId !== ownerId) throw new Error('Delete preview ownership mismatch.');
    await payload(await admin.request.delete('/api/agents', { data: { agentId: ownedAgent.agentId,
      expectedRevision: preview.data.agent.revision, confirmationToken: preview.data.confirmationToken } }), 'Owned agent deletion');
    ownedAgent = null;
  });
  await attempt('fixture MCP entry', async () => {
    if (originalMcpRaw === null || ownedMcpEntry === undefined) return;
    const current = (await payload<{ data: McpRaw }>(await admin.request.get('/api/integrations/mcp-config'), 'MCP cleanup read')).data;
    const config = parseConfig(current.rawContent);
    if (JSON.stringify(config.mcpServers?.[mcpName]) !== JSON.stringify(ownedMcpEntry)) throw new Error('Fixture MCP entry changed; preservation required.');
    delete config.mcpServers![mcpName];
    await payload(await admin.request.put('/api/integrations/mcp-config', { data: { rawContent: JSON.stringify(config, null, 2) } }), 'Fixture MCP removal');
  });
  await attempt('owned Composio profile', async () => {
    if (!ownedProfile) return;
    const headers = { 'x-canvas-workspace-id': workspaceId };
    const current = await payload<{ profiles: Profile[]; effectiveProfile: Profile }>(await admin.request.get('/api/composio/profiles', { headers }), 'Composio profile cleanup read');
    const selected = current.profiles.find(profile => profile.id === ownedProfile!.id);
    if (selected?.name !== profileName || selected.automationCount !== 0) throw new Error('Temporary Composio profile ownership or usage changed.');
    const verified = await payload<{ profiles: Profile[] }>(await admin.request.get('/api/composio/profiles', { headers }), 'Composio profile usage verification');
    const profile = verified.profiles.find(item => item.id === ownedProfile!.id);
    if (profile?.name !== profileName || profile.workspaceOverrideCount !== 0 || profile.automationCount !== 0) throw new Error('The temporary profile has remaining usage; preservation required.');
    await payload(await admin.request.delete(`/api/composio/profiles/${encodeURIComponent(ownedProfile.id)}`), 'Owned Composio profile archival');
    ownedProfile = null;
  });
  await attempt('fixture secret key', async () => {
    if (!secretChanged) return;
    const current = (await payload<{ data: Secret }>(await admin.request.get(secretPath), 'Secret cleanup read')).data;
    if (current.entries.find(entry => entry.key === 'COMPOSIO_API_KEY')?.value !== inertKey) throw new Error('Composio key changed; preservation required.');
    await payload(await admin.request.patch('/api/integrations/env', { data: { scope: 'integrations', secretScope: 'system',
      baseRevision: current.revision, patches: [{ key: 'COMPOSIO_API_KEY', value: originalKey }] } }), 'Fixture secret restoration');
    originalKey = null; secretChanged = false;
  });
  await attempt('owned experimental flag', async () => {
    if (!originalFlag || !ownedFlagRevision) return;
    const current = await flag();
    if (current.updatedAt !== ownedFlagRevision) throw new Error('Gateway flag changed; preservation required.');
    await payload(await admin.request.patch('/api/admin/experimental-settings', { data: { integrationToolGatewayEnabled: originalFlag.integrationToolGatewayEnabled } }), 'Gateway flag restoration');
  });
  await admin.close();
  if (errors.length) throw new Error(`Owned integration acceptance cleanup requires attention: ${errors.join(', ')}. No secret values were included.`);
}

test.describe('actual integration gateway acceptance', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000, retries: 0 });
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const configured = process.env.INTEGRATION_BROWSER_FIXTURE_URL;
    if (!configured) throw new Error('INTEGRATION_BROWSER_FIXTURE_URL is required; this actual acceptance suite never silently skips.');
    const parsed = new URL(configured);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('Integration fixture must use loopback HTTP.');
    fixtureUrl = parsed.origin;
    admin = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 850 } });
    await runManagedTestPreflight(admin);
    page = await admin.newPage();
    const identity = await payload<{ user: { id: string; role?: string } }>(await admin.request.get('/api/auth/get-session'), 'Admin identity');
    ownerId = identity.user.id;
    originalFlag = await flag();
    const workspaces = await payload<{ defaultWorkspace?: { id: string }; workspaces: Array<{ id: string; permissions?: { canRead: boolean; canRunAgent: boolean } }> }>(await admin.request.get('/api/workspaces'), 'Workspace preflight');
    workspaceId = process.env.INTEGRATION_E2E_WORKSPACE_ID || workspaces.defaultWorkspace?.id || workspaces.workspaces.find(item => item.permissions?.canRead && item.permissions.canRunAgent)?.id || '';
    if (!workspaceId) throw new Error('No actual readable agent workspace is configured.');
    const secret = (await payload<{ data: Secret }>(await admin.request.get(secretPath), 'Targeted Composio key backup')).data;
    const entry = secret.entries.find(item => item.key === 'COMPOSIO_API_KEY');
    if (entry?.readable === false) throw new Error('The existing Composio key cannot be safely backed up.');
    originalKey = entry?.value ?? null;
    await payload(await admin.request.patch('/api/integrations/env', { data: { scope: 'integrations', secretScope: 'system',
      baseRevision: secret.revision, patches: [{ key: 'COMPOSIO_API_KEY', value: inertKey }] } }), 'Targeted inert provider key setup');
    secretChanged = true;
    const mcp = (await payload<{ data: McpRaw }>(await admin.request.get('/api/integrations/mcp-config'), 'MCP backup')).data;
    originalMcpRaw = mcp.rawContent;
    const config = parseConfig(mcp.rawContent);
    if (config.mcpServers?.[mcpName]) throw new Error('Owned MCP fixture name already exists.');
    config.mcpServers = { ...config.mcpServers, [mcpName]: { url: `${fixtureUrl}/mcp`, auth: 'none' } };
    const installed = await payload<{ data: McpRaw }>(await admin.request.put('/api/integrations/mcp-config', { data: { rawContent: JSON.stringify(config, null, 2) } }), 'Actual MCP fixture setup');
    ownedMcpEntry = parseConfig(installed.data.rawContent).mcpServers?.[mcpName];
    expect(ownedMcpEntry).toBeDefined();
    const headers = { 'x-canvas-workspace-id': workspaceId };
    const status = await payload<{ configured: boolean; providerHealthy?: boolean; connectedAccounts: Array<{ status: string; toolkit: { slug: string } }> }>(await admin.request.get('/api/composio/status', { headers }), 'Actual Composio profile status');
    expect(status.configured).toBe(true);
    expect(status.providerHealthy).not.toBe(false);
    expect(status.connectedAccounts.some(item => item.toolkit.slug === 'canva' && item.status === 'ACTIVE')).toBe(true);
    const profiles = await payload<{ success: boolean; profiles: Profile[]; effectiveProfile: Profile }>(await admin.request.get('/api/composio/profiles', { headers }), 'Actual Composio profiles');
    expect(profiles.profiles.some(item => item.id === profiles.effectiveProfile.id)).toBe(true);
    const createdProfile = await payload<{ profile: Profile }>(await admin.request.post('/api/composio/profiles', { headers, data: { name: profileName } }), 'Owned Composio profile creation');
    ownedProfile = createdProfile.profile;
    expect(ownedProfile.name).toBe(profileName);
    const verifiedProfiles = await payload<{ profiles: Profile[]; effectiveProfile: Profile }>(await admin.request.get('/api/composio/profiles', { headers }), 'Owned Composio profile verification');
    expect(verifiedProfiles.profiles.some(profile => profile.id === ownedProfile!.id && profile.name === profileName)).toBe(true);
    expect(verifiedProfiles.effectiveProfile.id).toBe(profiles.effectiveProfile.id);
    const runtime = await payload<{ data: AiEffectiveRuntimeResolution }>(await admin.request.get(`/api/agent-runtime/effective?workspaceId=${encodeURIComponent(workspaceId)}&agentId=bradley`), 'Actual model inheritance');
    if (!runtime.data.valid || !runtime.data.effectiveSelection) throw new Error('The actual inherited agent runtime is not ready for acceptance.');
    const selection = runtime.data.effectiveSelection.selection;
    expect(selection.providerId).toBe('ollama');
    expect(selection.modelId).toMatch(/kimi.*2[.-]6/iu);
    const created = await payload<{ data: { agent: Agent } }>(await admin.request.post('/api/agents', { data: {
      name: agentName, scopeType: 'user', enabledTools: ['mcp', 'COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS', 'composio_execute'],
      defaultProviderInstallationId: selection.providerInstallationId, defaultProvider: selection.providerId,
      defaultModel: selection.modelId, defaultThinking: selection.thinkingLevel, expectedCatalogRevision: runtime.data.catalogRevision,
      files: { 'AGENTS.md': `Du hilfst beim Auffinden von Canva-Designs. Nutze die vom Benutzer gewählte Anbindungsart. Bei MCP verwende die Verbindung ${mcpName}; bei Composio das persönliche Profil ${profileName}. Prüfe die erforderlichen Eingaben vor jeder Ausführung. Gib Design-ID und Titel aus. Antworte knapp auf Deutsch.` },
    } }), 'Temporary personal agent creation');
    ownedAgent = created.data.agent;
    expect(ownedAgent.scopeType).toBe('user'); expect(ownedAgent.createdByUserId).toBe(ownerId); expect(ownedAgent.ownerUserId).toBe(ownerId);
    const agentId = ownedAgent.agentId;
    page.on('response', response => {
      if (new URL(response.url()).pathname !== '/api/sessions' || response.request().method() !== 'POST'
        || response.request().postDataJSON()?.agentId !== agentId) return;
      sessionReceipts.push((async () => {
        if (!response.ok()) return;
        const receipt = await response.json() as { success?: boolean; session?: { sessionId?: string; agentId?: string } };
        if (receipt.success && receipt.session?.agentId === agentId && receipt.session.sessionId) ownedSessions.add(receipt.session.sessionId);
      })());
    });
  });
  test.afterAll(async () => { test.setTimeout(180_000); await cleanup(); });

  test('admin activation persists on desktop/mobile, members cannot change it', async ({ browser }, info) => {
    await page.goto('/de/settings?tab=experimental', { waitUntil: 'domcontentloaded' });
    for (const [width, theme, enabled] of [[1280, 'light', false], [1280, 'dark', true], [390, 'light', false], [390, 'dark', true]] as const) {
      await page.setViewportSize({ width, height: 850 });
      await page.evaluate(value => localStorage.setItem('theme', value), theme);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('#integration-tool-gateway-enabled')).toBeEnabled();
      await page.locator('#integration-tool-gateway-enabled').scrollIntoViewIfNeeded();
      await setFlagThroughUi(enabled);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('#integration-tool-gateway-enabled')).toBeEnabled();
      await page.locator('#integration-tool-gateway-enabled').scrollIntoViewIfNeeded();
      await expect(page.locator('#integration-tool-gateway-enabled')).toHaveAttribute('aria-checked', String(enabled));
      await noOverflow(page);
      await page.screenshot({ path: info.outputPath(`settings-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
    const email = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
    const password = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
    if (!email || !password) throw new Error('An existing non-admin TEST_SECONDARY_EMAIL/PASSWORD fixture is required for the access acceptance.');
    const member = await createAuthenticatedContext(browser, {}, { email, password });
    try {
      const before = await flag();
      expect((await member.request.get('/api/admin/experimental-settings')).status()).toBe(403);
      expect((await member.request.patch('/api/admin/experimental-settings', { data: { integrationToolGatewayEnabled: false } })).status()).toBe(403);
      expect(await flag()).toEqual(before);
    } finally { await member.close(); }
  });

  for (const source of ['mcp', 'composio'] as const) {
    test(`natural Canva request routes through ${source} using the real agent`, async ({}, info) => {
      expect((await flag()).integrationToolGatewayEnabled).toBe(true);
      await openOwnedChat();
      const before = await fixtureCalls();
      const query = source === 'mcp' ? 'Frühlingskampagne' : 'Sommerkampagne';
      const sessionId = await sendNaturalPrompt(`Suche in Canva ${source === 'mcp' ? 'über meine MCP-Verbindung' : `über Composio mit meinem Verbindungsprofil „${profileName}“`} nach Designs mit dem Suchwort „${query}“. Führe die Suche jetzt aus und gib mir die Design-ID und den Titel des gefundenen Designs.`);
      const marker = source === 'mcp' ? 'stage3_MCP_DESIGN' : 'stage3_COMPOSIO_DESIGN';
      await expect.poll(async () => text(await transcript(sessionId)), { timeout: 140_000, intervals: [1000, 2000, 3000] }).toContain(marker);
      await expect.poll(async () => {
        const messages = await transcript(sessionId);
        return text(messages.filter(message => message.role === 'assistant' && message.stopReason === 'stop'));
      }, { timeout: 140_000, intervals: [1000, 2000, 3000] }).toContain(marker);
      const messages = await transcript(sessionId);
      const names = messages.flatMap(message => message.role === 'toolResult' ? [message.toolName] : contentBlocks(message).filter(part => part.type === 'toolCall').map(part => part.name));
      expect(names.length).toBeGreaterThan(2);
      expect(names.every(name => name === 'integrations')).toBe(true);
      const receipts = messages.filter(message => message.role === 'toolResult').map(message => message.details?.integrationReceipt);
      expect(receipts.some(receipt => receipt?.action === 'describe' && receipt.source === source)).toBe(true);
      expect(receipts.some(receipt => receipt?.action === 'call' && receipt.source === source)).toBe(true);
      if (source === 'composio') for (const action of ['describe', 'call']) expect(receipts.some(receipt => receipt?.action === action
        && receipt.source === source && receipt.connectionName === profileName)).toBe(true);
      const after = await fixtureCalls();
      const executions = after.executions.slice(before.executions.length);
      expect(executions.length).toBeGreaterThan(0);
      expect(executions.every(execution => execution.source === source && execution.successful && execution.exactBinding)).toBe(true);
      if (source === 'composio') expect(executions.every(execution => execution.versionHash === createHash('sha256').update('20261006_03').digest('base64url'))).toBe(true);
      expect(text(messages.filter(message => message.role === 'assistant'))).toContain(query);
      await screenshots(info, source);
    });
  }

  test('planning mode makes no provider request', async () => {
    await openOwnedChat();
    const planning = page.getByRole('button', { name: 'Standard Mode', exact: true });
    await expect(planning).toBeVisible();
    await planning.click();
    await expect(page.getByRole('button', { name: 'Planning Mode', exact: true })).toBeVisible();
    const before = await fixtureCalls();
    const sessionId = await sendNaturalPrompt('Plane, wie du in Canva über Composio Designs zur Herbstkampagne finden würdest. Führe noch keine Suche und keine externe Aktion aus. Beschreibe ausschließlich die Schritte.');
    await expect.poll(async () => (await transcript(sessionId)).some(message => message.role === 'assistant' && message.stopReason === 'stop'),
      { timeout: 140_000, intervals: [1000, 2000, 3000] }).toBe(true);
    const after = await fixtureCalls();
    expect(after.requests).toBe(before.requests);
    expect(after.executions.length).toBe(before.executions.length);
    await page.getByRole('button', { name: 'Planning Mode', exact: true }).click();
  });
});
