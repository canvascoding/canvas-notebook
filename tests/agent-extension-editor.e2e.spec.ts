import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Locator, type Page, type Request, type Response, type Route } from '@playwright/test';
import { z } from 'zod';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackagePublishedSummary } from '../app/lib/capabilities/packages/contracts';
import type { PluginExtensionSearchResponse } from '../app/lib/plugins/plugin-extension-contracts';
import type { AgentProfile } from '../app/lib/chat/types';
import type { AgentExtensionConfigurationInput, ExtensionPackagePin, StandaloneExtensionSelection } from '../app/lib/capabilities/extensions/contracts';
import type { AgentExtensionOptionsResponse } from '../app/lib/agents/extension-options-contracts';
import type { PluginExtensionIcon } from '../app/lib/plugins/plugin-extension-icons';
import type { AgentFormDraftFields } from '../app/components/agents/agent-form-draft-storage';
import en from '../messages/en.json';
import de from '../messages/de.json';

// Actual production UI, authenticated HTTP and published package bytes. The owned
// runner supplies local providers. The refresh-fault case injects only an Agent-list
// refresh failure after the real Create acknowledgement; no source/authority,
// Inspect, Options or POST responses are mocked. No model/business calls.
type Fixture = { version: 1; nonce: string; repo: string; root: string; dataRoot: string; actorId: string;
  baseURL: string; buildId: string; mcpUrl: string; mcpSpki: string; composioOrigin: string; logoUrl: string;
  model?: { providerInstallationId: string; providerId: string; modelId: string; thinkingLevel: 'off'; expectedCatalogRevision: number };
  toolAgent?: { agentId: string; agentName: string; sessionId: string } };
type Locale = 'en' | 'de';
type Inspection = { agent: AgentProfile; extensions: { configuration: AgentExtensionConfigurationInput | null; workflowRevision: number;
  standaloneSummaries?: Array<{ configurationId: string; choiceId?: string; selection: StandaloneExtensionSelection; label: string;
    scopeLabel: 'personal' | 'organization' | 'team' | 'system'; profileLabel?: string; icon?: PluginExtensionIcon }> } };
type Accounts = Extract<AgentExtensionOptionsResponse, { operation: 'connection_choices' }>;
let fixture: Fixture, owner: BrowserContext, page: Page;
let workspaceId = '', otherWorkspaceId = '', profileId = '', profileName = '', originalProfileId = '', originalProfileSource = '';
let pluginName = '', skillName = '', mcpName = '', agentId = '';
let pluginPin: ExtensionPackagePin, skillPin: ExtensionPackagePin, accountB: StandaloneExtensionSelection;
let pluginDisplayName = '', skillDisplayName = '';
let mcpRef = '';
const runtimeErrors: string[] = [], forbiddenCalls: string[] = [];
const uiRequests: Array<{ method: string; path: string; workspaceId: string | null; actorParameter: boolean }> = [];
const screenshots: string[] = [];
const refreshFaultProof: Array<{ surface: 'home' | 'chat'; agentId: string; realCreateRequests: number; failedListRefreshes: number; recovered: boolean }> = [];
const httpTimings: Array<{ method: string; path: string; status: number | null; failure: string | null;
  elapsedMs: number; responseStartMs: number | null; responseEndMs: number | null }> = [];
const observedHttp = new Map<Request, { startedAt: number; method: string; path: string; status: number | null }>();
let profileArchived = false;
const dictionary = { en, de };
const emptyTarget = { kind: 'prospective' as const, scopeType: 'user' as const };

test.describe.configure({ mode: 'serial', retries: 0 });
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

async function json<T>(response: APIResponse | Response, phase: string, status = 200): Promise<T> {
  // Never print response bodies, which can carry short-lived account receipts.
  expect(response.status(), `${phase}: exact HTTP status`).toBe(status);
  return response.json() as Promise<T>;
}
async function data<T>(response: APIResponse | Response, phase: string): Promise<T> {
  const result = await json<{ success: boolean; data: T }>(response, phase);
  expect(result.success, `${phase}: success`).toBe(true);
  return result.data;
}
function scoped(pathname: string, values: Record<string, string> = {}, selectedWorkspace = workspaceId) {
  return `${pathname}?${new URLSearchParams({ workspaceId: selectedWorkspace, ...values })}`;
}
async function options(value: Record<string, unknown>) {
  return data<AgentExtensionOptionsResponse>(await owner.request.post(scoped('/api/agents/extension-options'), { data: value }), 'Actual Agent extension options');
}
async function inspect() {
  return data<Inspection>(await owner.request.get(scoped('/api/agents', { agentId, includeAccess: 'true' })), 'Fresh saved Agent inspection');
}
async function publishOwnPackage(name: string, kind: 'plugin' | 'skill') {
  const listing = await data<PluginExtensionSearchResponse>(await owner.request.get(scoped('/api/plugins/search', { q: name, types: kind })), 'Own installed package discovery');
  const matches = listing.items.filter(item => item.kind === kind && item.name === name);
  expect(matches).toHaveLength(1);
  const selected = matches[0];
  const resourceRef = selected.kind === 'plugin' || selected.kind === 'skill' ? selected.package?.resourceRef : undefined;
  expect(resourceRef).toBeTruthy();
  const current = (await data<{ package: CapabilityPackageDescriptor }>(await owner.request.get(scoped(`/api/capabilities/packages/${encodeURIComponent(resourceRef!)}`)), 'Actual unpublished package')).package;
  const revisions = { expectedMetadataRevision: current.resource.metadataRevision, expectedGrantsRevision: current.resource.grantsRevision,
    expectedPackageRevision: current.state?.packageRevision ?? 0, expectedPublishedRevisionRef: current.state?.currentPublishedRevisionRef ?? null };
  const draft = (await data<{ draft: CapabilityPackageDraft }>(await owner.request.post(scoped('/api/capabilities/packages/drafts'), {
    data: { operation: 'edit', resourceRef, ...revisions },
  }), 'Create actual owned package draft')).draft;
  // A genuine legacy import can acquire its first governed metadata revision
  // while creating the draft. Publish against that current server observation.
  const refreshed = (await data<{ package: CapabilityPackageDescriptor }>(await owner.request.get(scoped(`/api/capabilities/packages/${encodeURIComponent(draft.resourceRef)}`)), 'Fresh publication revisions')).package;
  const result = await data<{ published: CapabilityPackagePublishedSummary }>(await owner.request.post(scoped(`/api/capabilities/packages/drafts/${encodeURIComponent(draft.draftRef)}/publish`), {
    data: { draftRef: draft.draftRef, expectedDraftRevision: draft.draftRevision,
      expectedMetadataRevision: refreshed.resource.metadataRevision, expectedGrantsRevision: refreshed.resource.grantsRevision,
      expectedPackageRevision: refreshed.state?.packageRevision ?? 0, expectedPublishedRevisionRef: refreshed.state?.currentPublishedRevisionRef ?? null },
  }), 'Publish actual immutable package');
  return { resourceRef: draft.resourceRef, publishedRevisionRef: result.published.revisionRef, checksum: result.published.checksum };
}
function optionResponse(operation: 'search' | 'preview' | 'package_version' | 'connection_choices',
  predicate?: (body: Record<string, unknown>) => boolean) {
  // Read-only catalogue sources get 15s plus grace, followed by fresh context/ACL checks.
  // Their response budget is separate from the 15s click/mutation action timeout.
  return page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/agents/extension-options'
    && response.request().postDataJSON()?.operation === operation
    && (!predicate || predicate(response.request().postDataJSON() as Record<string, unknown>)), { timeout: 30_000 });
}
async function openCreate(locale: Locale = 'en', selectedWorkspace = workspaceId) {
  await page.goto(`/${locale}/settings?${new URLSearchParams({ tab: 'agent-settings', workspaceId: selectedWorkspace })}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: dictionary[locale].settings.agentPanel.selector.create, exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ has: page.locator('#create-agent-name') });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('agent-extension-editor')).toBeVisible();
  return dialog;
}
async function searchResult(editor: Locator, query: string, kind: 'plugin' | 'skill' | 'integration' | 'mcp', locale: Locale = 'en') {
  const response = optionResponse('search', body => body.q === query);
  await editor.getByRole('textbox', { name: locale === 'en' ? 'Search plugins, skills, integrations and MCP' : 'Plugins, Skills, Integrationen und MCP suchen', exact: true }).fill(query);
  const result = await data<Extract<AgentExtensionOptionsResponse, { operation: 'search' }>>(await response, 'Actual common Agent search');
  const entry = result.items.find(row => row.item.kind === kind && (kind === 'integration' ? row.item.kind === 'integration' && row.item.toolkit.slug === query : row.item.name === query));
  expect(entry, 'An exact source, rather than a display-name guess, is returned.').toBeDefined();
  const row = editor.getByTestId('agent-extension-results').getByRole('button', { name: new RegExp(`^${escapeRegExp(entry!.item.displayName)} · `, 'u') });
  await expect(row).toHaveCount(1);
  await row.click();
  const detail = editor.getByTestId('agent-extension-result-detail'); await expect(detail).toBeVisible();
  return { detail, entry: entry! };
}
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
async function selectPackage(editor: Locator, name: string, kind: 'plugin' | 'skill', pin: ExtensionPackagePin) {
  const { detail } = await searchResult(editor, name, kind);
  const version = detail.getByRole('combobox', { name: 'Published version', exact: true });
  await expect(version).toHaveValue(pin.publishedRevisionRef);
  await detail.getByRole('button', { name: 'Select for agent', exact: true }).click();
  const displayName = kind === 'plugin' ? pluginDisplayName : skillDisplayName;
  expect(displayName, 'The selected card uses the actual held package display name.').toBeTruthy();
  await expect(editor.getByTestId('agent-extension-package').filter({ hasText: displayName })).toHaveCount(1);
}
async function selectOwnMcp(editor: Locator) {
  const { detail } = await searchResult(editor, mcpName, 'mcp');
  const chooser = detail.getByTestId('agent-extension-connection-chooser');
  const row = chooser.locator('div.rounded-md.border').filter({ has: page.getByText(mcpName, { exact: true }) });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Choose', exact: true }).click();
  await expect(editor.getByTestId('agent-extension-standalone')).toHaveCount(1);
}
async function openEdit(name: string, locale: Locale = 'en') {
  await page.goto(`/${locale}?${new URLSearchParams({ workspaceId })}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-prompt-hero-textarea]')).toBeVisible();
  await page.locator('[data-prompt-hero-textarea]').focus();
  await expect(page.getByTestId('home-agent-id')).toBeVisible();
  await page.getByTestId('home-agent-id').click();
  await page.getByTestId('chat-agent-selector-popover').getByRole('button', {
    name: dictionary[locale].chat.editAgent.replace('{name}', name), exact: true,
  }).click();
  const dialog = page.getByTestId('edit-agent-dialog'); await expect(dialog.getByTestId('agent-extension-editor')).toBeVisible();
  return dialog;
}
async function finishPersonalCreate(acknowledgedAgent: Pick<AgentProfile, 'name'>, locale: Locale = 'en') {
  // Create replaces its form, so the original name-input locator no longer
  // identifies the success view. Bind this view to the genuine ACK name.
  const completed = page.getByRole('dialog', {
    name: dictionary[locale].settings.agentPanel.createDialog.accessTitle.replace('{name}', acknowledgedAgent.name), exact: true,
  });
  await expect(completed).toBeVisible();
  await expect(completed.getByTestId('personal-agent-created')).toBeVisible();
  await completed.getByRole('button', { name: dictionary[locale].settings.agentPanel.createDialog.done, exact: true }).click();
  await expect(completed).toHaveCount(0);
}
async function snapshot(name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no document overflow`).toBe(true);
  const file = path.join(fixture.root, `agent-editor-${name}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' });
  screenshots.push(path.basename(file)); await test.info().attach(name, { path: file, contentType: 'image/png' });
}
async function expectRealImage(avatar: Locator) {
  await avatar.scrollIntoViewIfNeeded();
  const image = avatar.getByTestId('plugin-extension-avatar-image'); await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
  expect(new URL((await image.getAttribute('src'))!, fixture.baseURL).origin).toBe(fixture.baseURL);
}

test.beforeAll(async ({ browser }) => {
  expect(process.env.CANVAS_PLUGIN_EXTENSION_E2E).toBe('1');
  const file = process.env.PLUGIN_EXTENSION_E2E_FIXTURE;
  if (!file || !path.isAbsolute(file)) throw new Error('The exact isolated runner fixture is required.');
  const stat = await fs.lstat(file);
  expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600).toBe(true);
  fixture = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture;
  expect(fixture.version).toBe(1); expect(fixture.nonce).toMatch(/^[a-f0-9]{32}$/u);
  expect(fixture.root).toBe(path.dirname(file)); expect(fixture.repo).toBe(await fs.realpath(process.cwd()));
  expect(fixture.dataRoot).toBe(path.join(fixture.root, 'data'));
  expect(fixture.buildId).toBe((await fs.readFile('.next/BUILD_ID', 'utf8')).trim());
  expect(fixture.baseURL).toBe('http://127.0.0.1:3001'); expect(fixture.mcpSpki).toBe(process.env.PLUGIN_EXTENSION_E2E_MCP_SPKI);
  owner = await createAuthenticatedContext(browser, { baseURL: fixture.baseURL, extraHTTPHeaders: { Origin: fixture.baseURL }, viewport: { width: 1280, height: 900 } });
  await runManagedTestPreflight(owner, { baseURL: fixture.baseURL });
  const session = await json<{ user: { id: string; role: string } }>(await requestManagedTestSession(owner.request), 'Actual isolated owner');
  expect(session.user.id).toBe(fixture.actorId); expect(session.user.role).toBe('admin');
  const workspaces = await json<{ workspaces: Array<{ id: string; type: string; ownerUserId: string; status: string }> }>(await owner.request.get('/api/workspaces'), 'Current owned workspaces');
  workspaceId = workspaces.workspaces.find(row => row.type === 'personal' && row.ownerUserId === fixture.actorId && row.status === 'active')!.id;
  expect(workspaceId).toBeTruthy();
  otherWorkspaceId = (await json<{ workspace: { id: string } }>(await owner.request.post('/api/workspaces', {
    data: { type: 'team', name: `Agent editor scope ${fixture.nonce.slice(0, 10)}` },
  }), 'Independent editor scope', 201)).workspace.id;
  await owner.addInitScript(({ workspaceId: value, origin }) => {
    if (location.origin === origin && !localStorage.getItem('canvas.activeWorkspaceId')) localStorage.setItem('canvas.activeWorkspaceId', value);
  }, { workspaceId, origin: fixture.baseURL });
  owner.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === fixture.baseURL && /^\/api\/(?:agents(?:\/|$)|plugins\/search$|composio\/(?:profiles(?:\/|$)|connect\/|callback$)|integrations\/(?:mcp-|shared-connections)|auth\/get-session$)/u.test(url.pathname)) {
      observedHttp.set(request, { startedAt: Date.now(), method: request.method(), path: url.pathname, status: null });
    }
    if (url.origin === fixture.baseURL && url.pathname.startsWith('/api/agents')) uiRequests.push({ method: request.method(), path: url.pathname,
      workspaceId: url.searchParams.get('workspaceId'), actorParameter: url.searchParams.has('actorId') });
    if (/\/tools\/execute\//u.test(url.pathname) || /^\/api\/integrations\/gateway\/call/u.test(url.pathname)) forbiddenCalls.push(`${request.method()} ${url.pathname}`);
  });
  owner.on('response', response => {
    const observed = observedHttp.get(response.request()); if (observed) observed.status = response.status();
  });
  const recordHttpTiming = (request: Request, failed: boolean) => {
    const observed = observedHttp.get(request); if (!observed) return;
    observedHttp.delete(request);
    const timing = request.timing(), failure = failed ? request.failure()?.errorText : null;
    httpTimings.push({ method: observed.method, path: observed.path, status: observed.status,
      failure: failed ? failure && /^net::[A-Z0-9_]+$/u.test(failure) ? failure : 'request_failed' : null,
      elapsedMs: Math.max(0, Date.now() - observed.startedAt),
      responseStartMs: timing.responseStart >= 0 ? timing.responseStart : null,
      responseEndMs: timing.responseEnd >= 0 ? timing.responseEnd : null });
    if (httpTimings.length > 1000) httpTimings.shift();
  };
  owner.on('requestfinished', request => recordHttpTiming(request, false));
  owner.on('requestfailed', request => recordHttpTiming(request, true));
  owner.on('page', current => current.on('pageerror', error => runtimeErrors.push(error.name.slice(0, 100))));
  page = await owner.newPage();
  const suffix = fixture.nonce.slice(0, 10);
  pluginName = `agent-ui-plugin-${suffix}`; skillName = `agent-ui-skill-${suffix}`; mcpName = `Agent UI MCP ${suffix}`;
  const inputRoot = path.join(fixture.dataRoot, 'intake', pluginName);
  await fs.mkdir(path.join(inputRoot, '.canvas-plugin'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(inputRoot, 'skills', `${pluginName}-child`), { recursive: true, mode: 0o700 });
  const logo = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2563eb"/></svg>';
  await fs.writeFile(path.join(inputRoot, '.canvas-plugin/plugin.json'), JSON.stringify({ name: pluginName, version: '1.0.0',
    description: 'Independent Agent UI acceptance package', interface: { displayName: pluginName, logo: './logo.svg' }, skills: './skills' }), { mode: 0o600 });
  await fs.writeFile(path.join(inputRoot, 'logo.svg'), logo, { mode: 0o600 });
  await fs.writeFile(path.join(inputRoot, 'skills', `${pluginName}-child`, 'SKILL.md'), `---\nname: ${pluginName}-child\ndescription: Exact published Agent editor child\n---\nUse this selected context.\n`, { mode: 0o600 });
  const installed = await json<{ success: boolean }>(await owner.request.post('/api/plugins/install', {
    data: { sourcePath: inputRoot, scope: 'user', enable: true },
  }), 'Install owned nonce Plugin'); expect(installed.success).toBe(true);
  const skill = await json<{ success: boolean }>(await owner.request.post('/api/skills/upload', {
    data: { content: `---\nname: ${skillName}\ndescription: Independent published Agent skill without a logo\nmetadata:\n  version: 1.0.0\n---\nUse the explicit selected skill.\n` },
  }), 'Import owned nonce Skill'); expect(skill.success).toBe(true);
  pluginPin = await publishOwnPackage(pluginName, 'plugin'); skillPin = await publishOwnPackage(skillName, 'skill');
  const metadata = await options({ operation: 'package_version', target: emptyTarget, ...pluginPin });
  expect(metadata.operation).toBe('package_version');
  if (metadata.operation !== 'package_version') throw new Error('The exact held package metadata is required.');
  expect(metadata.package.pin).toEqual(pluginPin);
  pluginDisplayName = metadata.package.displayName;
  expect(metadata.package.declarations).toEqual([]); // This actual fixture declares context only; no account is inferred.
  const skillMetadata = await options({ operation: 'package_version', target: emptyTarget, ...skillPin });
  if (skillMetadata.operation !== 'package_version') throw new Error('The exact held Skill metadata is required.');
  expect(skillMetadata.package.pin).toEqual(skillPin);
  skillDisplayName = skillMetadata.package.displayName;
  const state = await data<{ rawContent: string }>(await owner.request.get('/api/integrations/mcp-config'), 'Own MCP config');
  const config = JSON.parse(state.rawContent) as { mcpServers: Record<string, { connectionId?: string }> };
  const saved = await data<{ rawContent: string }>(await owner.request.put('/api/integrations/mcp-config', {
    data: { rawContent: JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, [mcpName]: { url: fixture.mcpUrl } } }) },
  }), 'Create exact owned MCP for editor selection');
  mcpRef = `mcp-personal:${(JSON.parse(saved.rawContent) as typeof config).mcpServers[mcpName].connectionId}`;
  expect(mcpRef).toMatch(/^mcp-personal:[a-f0-9-]{36}$/u);
});

test.afterEach(async ({}, info) => {
  if (fixture) await fs.writeFile(path.join(fixture.root, 'agent-editor-http-timing.json'), JSON.stringify({
    version: 1, source: 'passive_browser_http_events', queriesAndBodiesCaptured: false, entries: httpTimings,
    inFlight: [...observedHttp.values()].slice(-1000).map(({ startedAt, ...entry }) => ({ ...entry, failure: null,
      elapsedMs: Math.max(0, Date.now() - startedAt), responseStartMs: null, responseEndMs: null })),
  }), { mode: 0o600 });
  if (info.status !== info.expectedStatus && page && !page.isClosed()) await snapshot(`failure-${info.line}`);
  expect(runtimeErrors, 'No unhandled Agent UI runtime errors.').toEqual([]);
  expect(forbiddenCalls, 'Configuration browsing and saves never execute provider business actions.').toEqual([]);
});
test.afterAll(async () => {
  try {
    if (owner && originalProfileId) {
      const headers = { 'x-canvas-workspace-id': workspaceId };
      if (profileId) {
        // This spec runs before the catalogue spec. Archive only our exact own
        // profile, keeping the catalogue's initial account inventory independent.
        expect(profileId).not.toBe(originalProfileId);
        const before = await json<{ profiles: Array<{ id: string; name: string; isDefault: boolean }> }>(
          await owner.request.get('/api/composio/profiles', { headers }), 'Own fixture profile before cleanup');
        expect(before.profiles.find(profile => profile.id === profileId)).toMatchObject({ name: profileName, isDefault: false });
        const archived = await json<{ success: boolean }>(await owner.request.delete(
          `/api/composio/profiles/${encodeURIComponent(profileId)}`, { headers }), 'Archive only the owned fixture profile');
        expect(archived.success).toBe(true);
        const after = await json<{ profiles: Array<{ id: string }> }>(
          await owner.request.get('/api/composio/profiles', { headers }), 'Archived fixture profile is absent');
        expect(after.profiles.some(profile => profile.id === profileId)).toBe(false);
        const catalogue = await data<PluginExtensionSearchResponse>(await owner.request.get(scoped('/api/plugins/search', {
          q: 'canva', types: 'integration',
        })), 'Fresh catalogue after fixture profile cleanup');
        expect(catalogue.coverage.find(source => source.source === 'composio')?.status).toBe('complete');
        expect(catalogue.items.some(item => item.kind === 'integration' && item.toolkit.slug === 'canva')).toBe(true);
        expect(catalogue.items.some(item => item.kind === 'integration'
          && item.connections.some(connection => connection.profileId === profileId))).toBe(false);
        profileArchived = true;
      }
      const current = await json<{ effectiveProfile: { id: string; source: string } }>(
        await owner.request.get('/api/composio/profiles', { headers }), 'Original default profile remains unchanged');
      expect(current.effectiveProfile.id).toBe(originalProfileId);
      expect(current.effectiveProfile.source).toBe(originalProfileSource);
    }
    if (fixture) await fs.writeFile(path.join(fixture.root, 'agent-editor-browser-proof.json'), JSON.stringify({ version: 1, nonce: fixture.nonce,
      actorId: fixture.actorId, workspaceId, otherWorkspaceId, agentId, pluginPin, skillPin, mcpRef,
      fixtureProfileCleanup: { profileId: profileId || null, archived: profileArchived },
      refreshFaultProof, screenshots, runtimeErrors, forbiddenCalls, requests: uiRequests }), { mode: 0o600 });
  } finally { await owner?.close(); }
});

test('actual Settings Create selects a published Plugin, standalone Skill and exact MCP, then genuine inspection retains each identity', async () => {
  const dialog = await openCreate(), editor = dialog.getByTestId('agent-extension-editor');
  await dialog.locator('#create-agent-name').fill(`Agent editor ${fixture.nonce.slice(0, 10)}`);
  await selectPackage(editor, pluginName, 'plugin', pluginPin);
  await selectPackage(editor, skillName, 'skill', skillPin);
  await selectOwnMcp(editor);
  await expectRealImage(editor.getByTestId('agent-extension-package').filter({ hasText: pluginDisplayName }).locator(':scope > summary').getByTestId('plugin-extension-avatar'));
  await expect(editor.getByTestId('agent-extension-package').filter({ hasText: skillDisplayName }).locator(':scope > summary').getByTestId('plugin-extension-avatar-initials')).toBeVisible();
  const button = dialog.getByRole('button', { name: en.settings.agentPanel.createDialog.create, exact: true });
  await expect(button).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents' && response.request().method() === 'POST'),
    button.click(),
  ]);
  const body = response.request().postDataJSON() as Record<string, unknown>;
  for (const field of ['capabilities', 'relevantSkills', 'relevantConnections', 'workflow']) expect(Object.hasOwn(body, field)).toBe(false);
  const acknowledged = await data<Inspection>(response, 'Actual UI Agent Create');
  agentId = acknowledged.agent.agentId;
  await finishPersonalCreate(acknowledged.agent);
  const actual = await inspect(); expect(actual.agent.workflowVersion).toBe(2);
  const fixed = actual.extensions.configuration; expect(fixed?.mode).toBe('fixed');
  if (fixed?.mode !== 'fixed') throw new Error('A complete fixed configuration must be persisted.');
  expect(fixed.selections.some(row => row.selection.kind === 'plugin' && row.selection.package.publishedRevisionRef === pluginPin.publishedRevisionRef)).toBe(true);
  expect(fixed.selections.some(row => row.selection.kind === 'skill' && row.selection.package.publishedRevisionRef === skillPin.publishedRevisionRef)).toBe(true);
  expect(fixed.standalone.some(row => row.mode === 'fixed' && row.entry.selection.kind === 'mcp'
    && row.entry.selection.target.connectionRef === mcpRef)).toBe(true);
  await snapshot('created-source-identities');
});

test('actual profile Edit keeps extension/model/native state on a name change and replaces only an explicitly edited extension configuration', async () => {
  const before = await inspect(), nextName = `${before.agent.name} renamed`;
  let dialog = await openEdit(before.agent.name);
  const mcpSummary = before.extensions.standaloneSummaries?.find(summary => summary.selection.kind === 'mcp'
    && summary.selection.target.kind === 'personal' && summary.selection.target.connectionRef === mcpRef);
  expect(mcpSummary?.label).toBe(mcpName);
  expect(mcpSummary?.icon?.url).toBeTruthy();
  expect(new URL(mcpSummary!.icon!.url, fixture.baseURL).pathname).toBe(`/api/plugins/mcp-icons/${encodeURIComponent(mcpRef)}`);
  const savedMcp = dialog.getByTestId('agent-extension-standalone').filter({ hasText: mcpName });
  await expect(savedMcp).toHaveCount(1);
  await expectRealImage(savedMcp.locator(':scope > summary').getByTestId('plugin-extension-avatar'));
  await dialog.getByRole('textbox', { name: en.settings.agentPanel.createDialog.nameLabel, exact: true }).fill(nextName);
  const keepButton = dialog.getByTestId('edit-agent-save');
  await expect(keepButton).toBeEnabled();
  const [patched] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents' && response.request().method() === 'PATCH'),
    keepButton.click(),
  ]);
  const payload = patched.request().postDataJSON() as Record<string, unknown>;
  expect(Object.keys(payload).sort()).toEqual(['agentId', 'expectedRevision', 'name']);
  await data<Inspection>(patched, 'Name-only keep save'); await expect(dialog).toHaveCount(0);
  const kept = await inspect(); expect(kept.extensions.workflowRevision).toBe(before.extensions.workflowRevision);
  expect(kept.agent.enabledTools).toEqual(before.agent.enabledTools); expect(kept.agent.defaultModel).toBe(before.agent.defaultModel);
  dialog = await openEdit(nextName);
  const editor = dialog.getByTestId('agent-extension-editor');
  const removableMcp = editor.getByTestId('agent-extension-standalone').filter({ hasText: mcpName });
  await expect(removableMcp).toHaveCount(1);
  await removableMcp.locator(':scope > summary').click();
  await expect(removableMcp).toHaveAttribute('open', '');
  const remove = removableMcp.getByRole('button', { name: 'Remove extension', exact: true });
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(editor.getByTestId('agent-extension-standalone')).toHaveCount(0);
  const replaceButton = dialog.getByTestId('edit-agent-save');
  await expect(replaceButton).toBeEnabled();
  const [replaced] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents' && response.request().method() === 'PATCH'),
    replaceButton.click(),
  ]);
  const replacement = replaced.request().postDataJSON() as Record<string, unknown>;
  expect(replacement.expectedWorkflowRevision).toBe(kept.extensions.workflowRevision); expect(replacement.extensions).toBeTruthy();
  expect(Object.hasOwn(replacement, 'enabledTools')).toBe(false); expect(Object.hasOwn(replacement, 'defaultProvider')).toBe(false);
  await data<Inspection>(replaced, 'Explicit full extension replacement'); await expect(dialog).toHaveCount(0);
  const actual = await inspect(); expect(actual.extensions.workflowRevision).toBe(kept.extensions.workflowRevision + 1);
  expect(actual.extensions.configuration?.mode === 'fixed' ? actual.extensions.configuration.standalone : null).toEqual([]);
});

test('an explicit profile and second real OAuth account are selected and persisted without first-account fallback', async () => {
  const headers = { 'x-canvas-workspace-id': workspaceId };
  const original = await json<{ effectiveProfile: { id: string; source: string } }>(await owner.request.get('/api/composio/profiles', { headers }), 'Original profile context');
  originalProfileId = original.effectiveProfile.id; originalProfileSource = original.effectiveProfile.source;
  profileName = `Agent editor profile ${fixture.nonce.slice(0, 10)}`;
  profileId = (await json<{ profile: { id: string } }>(await owner.request.post('/api/composio/profiles', { headers, data: { name: profileName } }), 'Own chooser profile', 201)).profile.id;
  for (let index = 0; index < 2; index++) {
    const connected = await json<{ redirectUrl: string; effectiveProfile: { id: string } }>(await owner.request.post('/api/composio/connect/canva', {
      headers, data: { profileId, returnPath: `/en/settings?${new URLSearchParams({ tab: 'agent-settings', workspaceId })}` },
    }), 'Actual personal account authorization start');
    expect(connected.effectiveProfile.id).toBe(profileId); expect(new URL(connected.redirectUrl).origin).toBe(fixture.composioOrigin);
    await owner.setExtraHTTPHeaders({});
    try {
      await page.goto(connected.redirectUrl, { waitUntil: 'domcontentloaded' });
      const callback = page.waitForResponse(response => new URL(response.url()).origin === fixture.baseURL && new URL(response.url()).pathname === '/api/composio/callback');
      await page.getByRole('button', { name: 'Approve', exact: true }).click(); expect((await callback).status()).toBe(307);
      await page.waitForURL(url => url.origin === fixture.baseURL && url.pathname === '/en/settings');
    } finally { await owner.setExtraHTTPHeaders({ Origin: fixture.baseURL }); }
    const unchanged = await json<{ effectiveProfile: { id: string; source: string } }>(
      await owner.request.get('/api/composio/profiles', { headers }), 'Explicit OAuth profile does not change the workspace default');
    expect(unchanged.effectiveProfile.id).toBe(originalProfileId);
    expect(unchanged.effectiveProfile.source).toBe(originalProfileSource);
  }
  const before = await inspect(), dialog = await openEdit(before.agent.name), editor = dialog.getByTestId('agent-extension-editor');
  const { detail, entry } = await searchResult(editor, 'canva', 'integration');
  const chooser = detail.getByTestId('agent-extension-connection-chooser');
  const profileButton = chooser.getByRole('button', { name: new RegExp(`^${escapeRegExp(profileName)}`, 'u') });
  await expect(profileButton).toBeVisible();
  await expect(profileButton).toBeEnabled();
  const [loaded] = await Promise.all([
    optionResponse('connection_choices', body => body.profileId === profileId),
    profileButton.click(),
  ]);
  const choices = await data<Accounts>(loaded, 'Exact profile account chooser');
  expect(choices.accounts.length).toBe(2); expect(choices.accounts.every(row => row.selectable)).toBe(true);
  accountB = choices.accounts[1].selection;
  expect(accountB.kind).toBe('composio');
  const account = chooser.locator('div.rounded-md.border').filter({ has: page.getByText(choices.accounts[1].label, { exact: true }) });
  await expect(account).toHaveCount(1); await account.getByRole('button', { name: 'This account', exact: true }).click();
  const saveButton = dialog.getByTestId('edit-agent-save');
  await expect(saveButton).toBeEnabled();
  const [saved] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents' && response.request().method() === 'PATCH'),
    saveButton.click(),
  ]);
  await data<Inspection>(saved, 'Save exact second account'); await expect(dialog).toHaveCount(0);
  const actual = await inspect(), config = actual.extensions.configuration;
  if (config?.mode !== 'fixed') throw new Error('The saved Agent must remain fixed.');
  expect(config.standalone.some(row => row.mode === 'fixed' && JSON.stringify(row.entry.selection) === JSON.stringify(accountB))).toBe(true);
  expect(config.standalone.some(row => row.mode === 'fixed' && JSON.stringify(row.entry.selection) === JSON.stringify(choices.accounts[0].selection))).toBe(false);
  expect(JSON.stringify(config)).not.toContain('accountSelectionRef');
  const summaries = actual.extensions.standaloneSummaries;
  expect(summaries).toHaveLength(1);
  const summary = summaries![0];
  expect(summary.selection).toEqual(accountB);
  expect(summary.label).toBe(entry.item.displayName);
  expect(summary.profileLabel).toBe(profileName);
  expect(summary.scopeLabel).toBe('personal');
  expect(summary.icon?.url).toBe(fixture.logoUrl);
  const reopened = await openEdit(actual.agent.name);
  const savedCanva = reopened.getByTestId('agent-extension-standalone').filter({ hasText: profileName });
  await expect(savedCanva).toHaveCount(1);
  await expect(savedCanva.locator(':scope > summary')).toContainText(summary.label);
  const avatar = savedCanva.locator(':scope > summary').getByTestId('plugin-extension-avatar');
  await expect(avatar).toHaveAttribute('data-source-key', summary.icon!.sourceKey);
  await avatar.scrollIntoViewIfNeeded();
  // The owned catalogue TLS image is deliberately untrusted in the existing
  // fixture. Preserve that genuine image-error contract rather than trust it.
  await expect(avatar.getByTestId('plugin-extension-avatar-initials')).toBeVisible();
  await expect(savedCanva.locator(':scope > summary').getByText(`Profile: ${profileName}`, { exact: true })).toBeVisible();
  await expect(savedCanva.locator(':scope > summary').getByText(/Saved personal account/u)).toBeVisible();
  // Reopen resolves exact published metadata independently for each saved pin.
  // Wait for those genuine names and image states before recording the view.
  const savedPlugin = reopened.getByTestId('agent-extension-package').filter({ hasText: pluginDisplayName });
  const savedSkill = reopened.getByTestId('agent-extension-package').filter({ hasText: skillDisplayName });
  await expect(savedPlugin).toHaveCount(1);
  await expect(savedSkill).toHaveCount(1);
  await expectRealImage(savedPlugin.locator(':scope > summary').getByTestId('plugin-extension-avatar'));
  await expect(savedSkill.locator(':scope > summary').getByTestId('plugin-extension-avatar-initials')).toBeVisible();
  await avatar.scrollIntoViewIfNeeded();
  await snapshot('saved-profile-toolkit-logo-fallback');
  await reopened.getByRole('button', { name: en.settings.agentPanel.createDialog.cancel, exact: true }).click();
  await expect(reopened).toHaveCount(0);
});

test('reload resumes exact parent and extension drafts, while another workspace and an anonymous actor cannot adopt the selection', async ({ browser }) => {
  let dialog = await openCreate();
  const draftName = `Reload draft ${fixture.nonce.slice(0, 10)}`;
  await dialog.locator('#create-agent-name').fill(draftName);
  await selectPackage(dialog.getByTestId('agent-extension-editor'), pluginName, 'plugin', pluginPin);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('canvas-agent-extension-draft:')))).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: en.settings.agentPanel.selector.create, exact: true }).click();
  dialog = page.getByRole('dialog').filter({ has: page.locator('#create-agent-name') });
  await expect(dialog.locator('#create-agent-name')).toHaveValue(draftName);
  await dialog.getByRole('button', { name: 'Resume draft', exact: true }).click();
  await expect(dialog.getByTestId('agent-extension-package').filter({ hasText: pluginDisplayName })).toHaveCount(1);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('canvas-agent-extension-draft:'))
    .some(key => localStorage.getItem(key)?.includes('accountSelectionRef')))).toBe(false);
  dialog = await openCreate('en', otherWorkspaceId);
  await expect(dialog.locator('#create-agent-name')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Resume draft', exact: true })).toHaveCount(0);
  await expect(dialog.getByTestId('agent-extension-package')).toHaveCount(0);
  const anonymous = await browser.newContext({ baseURL: fixture.baseURL });
  try { expect((await anonymous.request.get(scoped('/api/agents', { agentId }))).status()).toBe(401); }
  finally { await anonymous.close(); }
  const denied = await owner.request.post(scoped('/api/agents/extension-options', {}, 'missing-workspace'), { data: { operation: 'search', target: emptyTarget } });
  expect(denied.status()).toBe(403);
  expect((await denied.json() as { code: string }).code).toBe('AGENT_ACTOR_CONTEXT_DENIED');
  await snapshot('draft-scope-boundary');
});

test('English and German real editor support narrow layout, keyboard disclosure, images and initials without automatic selection', async () => {
  for (const locale of ['en', 'de'] as const) {
    await page.setViewportSize({ width: locale === 'en' ? 1280 : 390, height: 900 });
    const dialog = await openCreate(locale), editor = dialog.getByTestId('agent-extension-editor');
    const filters = editor.locator('summary').filter({ hasText: locale === 'en' ? /^Filters$/u : /^Filter$/u });
    await filters.focus(); await page.keyboard.press('Enter');
    await expect(editor.getByRole('combobox', { name: locale === 'en' ? 'Extension type' : 'Erweiterungstyp', exact: true })).toBeVisible();
    const { detail } = await searchResult(editor, pluginName, 'plugin', locale);
    await expectRealImage(detail.getByTestId('plugin-extension-avatar'));
    await expect(editor.getByTestId('agent-extension-package')).toHaveCount(0);
    await detail.getByRole('button', { name: locale === 'en' ? 'Back to results' : 'Zurück zu Treffern', exact: true }).click();
    await searchResult(editor, skillName, 'skill', locale);
    await expect(editor.getByTestId('agent-extension-result-detail').getByTestId('plugin-extension-avatar-initials')).toBeVisible();
    await snapshot(`${locale}-${locale === 'en' ? 'desktop' : 'narrow'}`);
    await dialog.getByRole('button', { name: dictionary[locale].settings.agentPanel.createDialog.discardDraft, exact: true }).click();
  }
  expect(uiRequests.filter(row => row.path === '/api/agents/extension-options').length).toBeGreaterThan(0);
  expect(uiRequests.every(row => !row.actorParameter)).toBe(true);
  expect(uiRequests.filter(row => row.path === '/api/agents/extension-options').every(row => row.workspaceId === workspaceId || row.workspaceId === otherWorkspaceId || row.workspaceId === 'missing-workspace')).toBe(true);
});

test('Home and full-chat Create retain the acknowledged Agent when only the subsequent list refresh fails', async () => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const surface of ['home', 'chat'] as const) {
    const pathname = surface === 'home' ? '/en' : '/en/chat';
    await page.goto(`${pathname}?${new URLSearchParams({ workspaceId })}`, { waitUntil: 'domcontentloaded' });
    if (surface === 'chat') await page.waitForURL(url => url.pathname === '/en/notebook' && url.searchParams.get('chat') === 'open');
    else {
      await expect(page.locator('[data-prompt-hero-textarea]')).toBeVisible();
      await page.locator('[data-prompt-hero-textarea]').focus();
    }
    const selector = page.getByTestId(surface === 'home' ? 'home-agent-id' : 'chat-agent-id');
    await expect(selector).toBeVisible(); await selector.click();
    await page.getByTestId('chat-agent-selector-popover').getByRole('button', { name: en.chat.createAgent, exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.locator('#create-agent-name') });
    await expect(dialog.getByTestId('agent-extension-editor')).toBeVisible();
    const name = `Acknowledged ${surface} ${fixture.nonce.slice(0, 10)}`;
    await dialog.locator('#create-agent-name').fill(name);
    const create = dialog.getByRole('button', { name: en.settings.agentPanel.createDialog.create, exact: true });

    let faultActive = true, createRequests = 0, failedListRefreshes = 0;
    let releaseRefresh!: () => void;
    const acknowledged = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const exactAgentRoute = (url: URL) => url.origin === fixture.baseURL && url.pathname === '/api/agents';
    const observeCreate = (request: Request) => {
      if (exactAgentRoute(new URL(request.url())) && request.method() === 'POST') createRequests += 1;
    };
    const listFault = async (route: Route) => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET' || url.searchParams.has('agentId') || !faultActive) return route.continue();
      // Hold only the list GET until the real POST body is acknowledged below.
      // POST/Inspect/Options always reach the actual application unchanged.
      await acknowledged;
      if (!faultActive) return route.continue();
      failedListRefreshes += 1;
      return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({ success: false, error: 'Owned E2E Agent-list refresh fault' }) });
    };
    page.on('request', observeCreate);
    let createdId = '';
    try {
      await page.route(exactAgentRoute, listFault);
      try {
        await expect(create).toBeEnabled();
        const [saved] = await Promise.all([
          page.waitForResponse(response => exactAgentRoute(new URL(response.url())) && response.request().method() === 'POST'),
          create.click(),
        ]);
        const actual = await data<Inspection>(saved, `Actual ${surface} Create before refresh failure`);
        createdId = actual.agent.agentId;
        expect(actual.agent.name).toBe(name); expect(actual.agent.workflowVersion).toBe(2);
        expect(actual.extensions.configuration).toEqual({ version: 1, origin: 'agent_configuration', mode: 'fixed',
          selections: [], workflow: null, standalone: [] });
        releaseRefresh();
        await expect.poll(() => failedListRefreshes).toBeGreaterThan(0);
        await finishPersonalCreate(actual.agent);
        await expect(selector).toContainText(name);
        await selector.click();
        await expect(page.getByTestId('chat-agent-selector-popover').getByRole('alert')).toHaveText(en.chat.agentLoadFailed);
        await expect(page.getByTestId('chat-agent-selector-popover').getByRole('button', { name: `${name} ${createdId}`, exact: true })).toBeVisible();
        await selector.click();
        await expect(selector).toContainText(name); expect(createRequests).toBe(1);
        await snapshot(`${surface}-acknowledged-agent-after-refresh-failure`);
      } finally {
        faultActive = false; releaseRefresh();
        await page.unroute(exactAgentRoute, listFault);
      }

      // Recovery is another genuine HTTP list, not a fulfilled success fixture.
      const refreshed = page.waitForResponse(response => response.request().method() === 'GET'
        && exactAgentRoute(new URL(response.url())) && !new URL(response.url()).searchParams.has('agentId'));
      await selector.click();
      const current = await data<{ agents: AgentProfile[] }>(await refreshed, `Fresh real ${surface} list after removing the fault`);
      expect(current.agents.some(agent => agent.agentId === createdId && agent.name === name)).toBe(true);
      const popover = page.getByTestId('chat-agent-selector-popover');
      await expect(popover.getByRole('alert')).toHaveCount(0);
      await expect(popover.getByRole('button', { name: `${name} ${createdId}`, exact: true })).toBeVisible();
      await selector.click(); await expect(selector).toContainText(name);
      expect(createRequests).toBe(1);
      refreshFaultProof.push({ surface, agentId: createdId, realCreateRequests: createRequests, failedListRefreshes, recovered: true });
    } finally { page.off('request', observeCreate); }
  }
});

test('a complete Create draft survives real new-tab integration setup, OAuth and reload before an explicit account choice', async () => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const model = fixture.model;
  expect(model, 'The owned runner must seed a genuine ready model catalogue for the full draft.').toBeDefined();
  if (!model) throw new Error('The actual owned model catalogue fixture is required.');
  const name = `OAuth draft ${fixture.nonce.slice(0, 10)}`;
  let dialog = await openCreate();
  await dialog.locator('#create-agent-name').fill(name);
  await dialog.getByRole('button', { name: en.settings.agentPanel.createDialog.changeIcon, exact: true }).click();
  await page.getByRole('dialog', { name: en.settings.agentPanel.iconPicker.title, exact: true })
    .getByRole('button', { name: en.settings.agentPanel.iconPicker.icons.rocket, exact: true }).click();
  await selectPackage(dialog.getByTestId('agent-extension-editor'), pluginName, 'plugin', pluginPin);
  let advanced = dialog.getByTestId('create-agent-advanced');
  if (await advanced.getAttribute('open') === null) await advanced.locator(':scope > summary').click();
  const modelOverride = advanced.getByRole('switch', { name: en.settings.agentPanel.createDialog.model.title, exact: true });
  await expect(modelOverride).not.toBeChecked();
  await modelOverride.check();
  await advanced.getByRole('combobox', { name: en.settings.agentPanel.inheritance.providerInstallation, exact: true }).selectOption(model.providerInstallationId);
  await advanced.getByRole('combobox', { name: en.settings.agentPanel.inheritance.catalogModel, exact: true }).selectOption(model.modelId);
  await advanced.getByRole('combobox', { name: en.settings.agentPanel.inheritance.intelligence, exact: true }).selectOption(model.thinkingLevel);

  const nativeRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents/tools' && response.request().method() === 'GET');
  await advanced.getByRole('switch', { name: en.settings.agentPanel.createDialog.tools.title, exact: true }).check();
  const tools = await data<{ tools: Array<{ name: string; label: string }> }>(await nativeRead, 'Actual native tool metadata for the unsaved draft');
  const read = tools.tools.find(tool => tool.name === 'read'); expect(read).toBeDefined();
  await advanced.getByRole('button', { name: en.settings.agentPanel.tools.disableAll, exact: true }).click();
  await advanced.getByPlaceholder(en.settings.agentPanel.tools.searchPlaceholder, { exact: true }).fill('read');
  await advanced.getByRole('switch', { name: read!.label || read!.name, exact: true }).check();
  await advanced.getByRole('button', { name: new RegExp(`^${escapeRegExp(en.settings.agentPanel.createDialog.files.title)}`, 'u') }).click();
  const files = ['AGENTS.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md'] as const;
  for (const file of files) {
    await advanced.getByRole('tab', { name: file, exact: true }).click();
    const editor = advanced.getByTestId('agent-managed-file-editor').locator('[contenteditable="true"]');
    await expect(editor).toHaveCount(1); await editor.click(); await editor.press('ControlOrMeta+A');
    await editor.pressSequentially(`Own draft ${file} ${fixture.nonce.slice(0, 10)}`);
    await expect(editor).toContainText(`Own draft ${file}`);
  }
  await dialog.locator('#create-agent-name').click();
  const readForm = () => page.evaluate((draftName): AgentFormDraftFields | null => {
    for (const key of Object.keys(localStorage).filter(value => value.startsWith('canvas.agent-form-draft:v1:'))) {
      const stored = JSON.parse(localStorage.getItem(key) || '{}') as { fields?: AgentFormDraftFields };
      if (stored.fields?.name === draftName) return stored.fields;
    }
    return null;
  }, name);
  await expect.poll(readForm).toMatchObject({ name, iconId: 'rocket', modelOverrideEnabled: true,
    modelDraft: { providerInstallationId: model.providerInstallationId, providerId: model.providerId,
      modelId: model.modelId, thinkingLevel: model.thinkingLevel }, toolsOverrideEnabled: true, customEnabledTools: ['read'] });
  const beforeDraft = (await readForm())!;
  for (const file of files) expect(beforeDraft.fileDrafts?.[file]).toContain(`Own draft ${file}`);
  expect(JSON.stringify(beforeDraft)).not.toContain('accountSelectionRef');

  const { detail } = await searchResult(dialog.getByTestId('agent-extension-editor'), 'github', 'integration');
  const chooser = detail.getByTestId('agent-extension-connection-chooser');
  const profileButton = chooser.getByRole('button', { name: new RegExp(`^${escapeRegExp(profileName)}`, 'u') });
  await expect(profileButton).toBeVisible();
  await expect(profileButton).toBeEnabled();
  const [emptyAccounts] = await Promise.all([
    optionResponse('connection_choices', body => body.profileId === profileId),
    profileButton.click(),
  ]);
  const beforeAccounts = await data<Accounts>(emptyAccounts, 'Chosen own profile has no GitHub account before setup');
  expect(beforeAccounts.accounts).toEqual([]);
  await expect(chooser.getByText('No matching connection found.', { exact: true })).toBeVisible();
  const setupLink = chooser.getByTestId('agent-extension-setup-links').getByRole('link').filter({ hasText: 'GitHub' });
  await expect(setupLink).toHaveCount(1);
  const href = new URL((await setupLink.getAttribute('href'))!, fixture.baseURL);
  expect(href.pathname).toBe('/en/plugins');
  expect(Object.fromEntries(href.searchParams)).toEqual({ view: 'browse', workspaceId, extensionId: 'composio:github' });
  const opened = owner.waitForEvent('page'); await setupLink.click(); const setupPage = await opened;
  try {
    await setupPage.waitForURL(url => url.pathname === '/en/plugins' && url.searchParams.get('extensionId') === 'composio:github');
    await expect(setupPage.getByTestId('plugin-integration-detail')).toBeVisible();
    await setupPage.locator('#plugin-integration-profile').selectOption(profileId);
    await owner.setExtraHTTPHeaders({});
    try {
      const connect = setupPage.getByTestId('plugin-integration-connect');
      await expect(connect).toBeVisible();
      await expect(connect).toBeEnabled();
      const [authorization] = await Promise.all([
        setupPage.waitForResponse(response => new URL(response.url()).pathname === '/api/composio/connect/github'
          && response.request().method() === 'POST'),
        connect.click(),
      ]);
      expect(authorization.status()).toBe(200);
      expect(authorization.request().postDataJSON()?.profileId).toBe(profileId);
      await setupPage.waitForURL(url => url.origin === fixture.composioOrigin);
      const callback = setupPage.waitForResponse(response => new URL(response.url()).origin === fixture.baseURL
        && new URL(response.url()).pathname === '/api/composio/callback');
      await setupPage.getByRole('button', { name: 'Approve', exact: true }).click();
      expect((await callback).status()).toBe(307);
      await setupPage.waitForURL(url => url.pathname === '/en/plugins' && url.searchParams.get('extensionId') === 'composio:github');
    } finally { await owner.setExtraHTTPHeaders({ Origin: fixture.baseURL }); }
  } finally { await setupPage.close(); }
  await page.bringToFront();
  expect(await readForm()).toEqual(beforeDraft);
  const unchanged = await json<{ effectiveProfile: { id: string; source: string } }>(await owner.request.get('/api/composio/profiles', {
    headers: { 'x-canvas-workspace-id': workspaceId },
  }), 'Setup preserves the actual workspace default');
  expect(unchanged.effectiveProfile).toMatchObject({ id: originalProfileId, source: originalProfileSource });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: en.settings.agentPanel.selector.create, exact: true }).click();
  dialog = page.getByRole('dialog').filter({ has: page.locator('#create-agent-name') });
  await expect(dialog.locator('#create-agent-name')).toHaveValue(name);
  await expect(dialog.getByRole('button', { name: en.settings.agentPanel.createDialog.changeIcon, exact: true }).locator('[data-agent-icon-id]')).toHaveAttribute('data-agent-icon-id', 'rocket');
  await dialog.getByRole('button', { name: 'Resume draft', exact: true }).click();
  await expect(dialog.getByTestId('agent-extension-package').filter({ hasText: pluginDisplayName })).toHaveCount(1);
  advanced = dialog.getByTestId('create-agent-advanced');
  await expect(advanced.getByRole('switch', { name: en.settings.agentPanel.createDialog.model.title, exact: true })).toBeChecked();
  await expect(advanced.getByRole('combobox', { name: en.settings.agentPanel.inheritance.providerInstallation, exact: true })).toHaveValue(model.providerInstallationId);
  await expect(advanced.getByRole('combobox', { name: en.settings.agentPanel.inheritance.catalogModel, exact: true })).toHaveValue(model.modelId);
  await expect(advanced.getByRole('combobox', { name: en.settings.agentPanel.inheritance.intelligence, exact: true })).toHaveValue(model.thinkingLevel);
  await expect(advanced.getByRole('switch', { name: en.settings.agentPanel.createDialog.tools.title, exact: true })).toBeChecked();
  await expect(advanced.getByRole('switch', { name: read!.label || read!.name, exact: true })).toBeChecked();
  await advanced.getByRole('button', { name: new RegExp(`^${escapeRegExp(en.settings.agentPanel.createDialog.files.title)}`, 'u') }).click();
  for (const file of files) {
    await advanced.getByRole('tab', { name: file, exact: true }).click();
    await expect(advanced.getByTestId('agent-managed-file-editor').locator('[contenteditable="true"]')).toContainText(`Own draft ${file}`);
  }
  await dialog.locator('#create-agent-name').click();
  expect(await readForm()).toEqual(beforeDraft);
  const restored = await searchResult(dialog.getByTestId('agent-extension-editor'), 'github', 'integration');
  const restoredChooser = restored.detail.getByTestId('agent-extension-connection-chooser');
  const restoredProfileButton = restoredChooser.getByRole('button', { name: new RegExp(`^${escapeRegExp(profileName)}`, 'u') });
  await expect(restoredProfileButton).toBeVisible();
  await expect(restoredProfileButton).toBeEnabled();
  const [loaded] = await Promise.all([
    optionResponse('connection_choices', body => body.profileId === profileId),
    restoredProfileButton.click(),
  ]);
  const accounts = await data<Accounts>(loaded, 'Fresh explicitly chosen GitHub account after returning to the draft');
  expect(accounts.accounts).toHaveLength(1); expect(accounts.accounts[0].selectable).toBe(true);
  await expect(dialog.getByTestId('agent-extension-standalone')).toHaveCount(0);
  const optionalPreview = optionResponse('preview', value => JSON.stringify(value.configuration ?? null).includes('github'));
  await restoredChooser.getByRole('button', { name: 'This account', exact: true }).click();
  const draftPreview = await data<Extract<AgentExtensionOptionsResponse, { operation: 'preview' }>>(await optionalPreview,
    'Read-only native tool limit leaves the optional GitHub route unavailable');
  expect(draftPreview.preview.providerHealth).toBe('unknown');
  expect(draftPreview.preview.issues).toContainEqual(expect.objectContaining({
    code: 'AGENT_EXTENSION_DISCOVERY_DISABLED', severity: 'warning',
  }));
  await expect(dialog.getByTestId('agent-extension-preview-status')).toContainText('An optional selected connection has no permitted tool search/schema route.');
  const createButton = dialog.getByRole('button', { name: en.settings.agentPanel.createDialog.create, exact: true });
  await expect(createButton).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents' && response.request().method() === 'POST'),
    createButton.click(),
  ]);
  const body = response.request().postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({ name, iconId: 'rocket', enabledTools: ['read'], defaultProviderInstallationId: model.providerInstallationId,
    defaultProvider: model.providerId, defaultModel: model.modelId, defaultThinking: model.thinkingLevel, files: beforeDraft.fileDrafts });
  const saved = await data<Inspection>(response, 'Actual Create after full draft OAuth/Reload recovery');
  const actual = await data<Inspection>(await owner.request.get(scoped('/api/agents', { agentId: saved.agent.agentId, includeAccess: 'true' })), 'Genuine resumed draft Agent inspection');
  expect(actual.agent).toMatchObject({ name, iconId: 'rocket', enabledTools: ['read'], defaultModel: model.modelId });
  expect(actual.extensions.configuration?.mode).toBe('fixed');
  if (actual.extensions.configuration?.mode !== 'fixed') throw new Error('The resumed fixed draft must persist.');
  expect(actual.extensions.configuration.selections.some(entry => entry.selection.kind === 'plugin'
    && JSON.stringify(entry.selection.package) === JSON.stringify(pluginPin))).toBe(true);
  expect(actual.extensions.configuration.standalone).toHaveLength(1);
  expect(actual.extensions.configuration.standalone[0].mode === 'fixed'
    ? actual.extensions.configuration.standalone[0].entry.requirement : null).toBe('optional');
  expect(actual.extensions.configuration.standalone[0].mode === 'fixed'
    ? actual.extensions.configuration.standalone[0].entry.selection : null).toEqual(accounts.accounts[0].selection);
  expect(JSON.stringify(actual.extensions.configuration)).not.toContain('accountSelectionRef');
  const savedFiles = await data<{ files: Record<string, string> }>(await owner.request.get(scoped('/api/agents/files', { agentId: saved.agent.agentId })), 'Actual instruction files after resumed creation');
  for (const file of files) {
    const content = beforeDraft.fileDrafts?.[file];
    if (typeof content !== 'string') throw new Error('The complete original instruction draft must remain present.');
    // Managed-file storage preserves bytes and adds a final LF to nonempty text.
    // Draft and POST-body checks above remain exact; no whitespace is trimmed.
    expect(savedFiles.files[file]).toBe(content.length && !content.endsWith('\n') ? `${content}\n` : content);
  }
  await finishPersonalCreate(saved.agent);
});

test('a genuine tool-created Agent is configured from Settings and renamed in the profile UI before independent tool inspection', async () => {
  const toolAgent = fixture.toolAgent;
  if (!toolAgent) throw new Error('The actual create_agent fixture is required for the Tool/UI/Tool acceptance.');
  const receiptFile = path.join(fixture.root, 'agent-tool-prepare-receipt.json');
  const receiptStat = await fs.lstat(receiptFile);
  expect(receiptStat.isFile() && !receiptStat.isSymbolicLink() && receiptStat.nlink === 1
    && (receiptStat.mode & 0o777) === 0o600 && receiptStat.size <= 65_536,
  'The actual tool Create acknowledgement must be a bounded private owned regular file.').toBe(true);
  const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const prepared = z.object({ version: z.literal(1), nonce: z.literal(fixture.nonce), actorId: z.literal(fixture.actorId),
    agentId: z.literal(toolAgent.agentId), agentName: z.literal(toolAgent.agentName), sessionId: z.literal(toolAgent.sessionId),
    before: z.object({ revision, workflowRevision: revision }).strict(),
  }).strict().parse(JSON.parse(await fs.readFile(receiptFile, 'utf8')));
  const inspectToolCreated = async () => data<Inspection>(await owner.request.get(scoped('/api/agents', {
    agentId: toolAgent.agentId, includeAccess: 'true',
  })), 'Current tool-created Agent inspection');
  const before = await inspectToolCreated();
  if (typeof before.agent.revision !== 'number') throw new Error('The actual tool-created profile revision is required.');
  expect(before.agent).toMatchObject({ agentId: toolAgent.agentId, name: toolAgent.agentName,
    revision: prepared.before.revision, enabledTools: ['read'], ownerUserId: fixture.actorId });
  expect(before.extensions.workflowRevision).toBe(prepared.before.workflowRevision);
  expect(before.extensions.configuration?.mode).toBe('fixed');
  if (before.extensions.configuration?.mode !== 'fixed') throw new Error('The actual tool-created fixed configuration is required.');
  expect(before.extensions.configuration.selections).toEqual([]);
  expect(before.extensions.configuration.standalone).toEqual([]);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/en/settings?${new URLSearchParams({ tab: 'agent-settings', workspaceId })}`, { waitUntil: 'domcontentloaded' });
  const settingsAgent = page.getByRole('button').filter({ has: page.getByText(toolAgent.agentName, { exact: true }) });
  await expect(settingsAgent).toHaveCount(1);
  await settingsAgent.click();
  await expect(settingsAgent).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('agent-settings-workflow-management-open').click();
  const management = page.getByTestId('agent-workflow-management-dialog');
  const editor = management.getByTestId('agent-extension-editor');
  await expect(editor).toBeVisible();
  await selectPackage(editor, pluginName, 'plugin', pluginPin);
  await selectPackage(editor, skillName, 'skill', skillPin);
  const { detail } = await searchResult(editor, mcpName, 'mcp');
  const chooser = detail.getByTestId('agent-extension-connection-chooser');
  const mcpRow = chooser.locator('div.rounded-md.border').filter({ has: page.getByText(mcpName, { exact: true }) });
  await expect(mcpRow).toHaveCount(1);
  const chooseMcp = mcpRow.getByRole('button', { name: 'Choose', exact: true });
  await expect(chooseMcp).toBeVisible();
  await expect(chooseMcp).toBeEnabled();
  const [optionalPreview] = await Promise.all([
    optionResponse('preview', value => JSON.stringify(value.configuration ?? null).includes(mcpRef)),
    chooseMcp.click(),
  ]);
  await expect(editor.getByTestId('agent-extension-standalone')).toHaveCount(1);
  const preview = await data<Extract<AgentExtensionOptionsResponse, { operation: 'preview' }>>(optionalPreview,
    'Actual read-only tool limit keeps optional MCP search unavailable');
  expect(preview.preview.providerHealth).toBe('unknown');
  expect(preview.preview.issues).toContainEqual(expect.objectContaining({
    code: 'AGENT_EXTENSION_DISCOVERY_DISABLED', severity: 'warning',
  }));
  await expect(editor.getByTestId('agent-extension-preview-status')).toContainText('An optional selected connection has no permitted tool search/schema route.');
  const saveExtensions = management.getByRole('button', { name: en.agentWorkflowManagement.save, exact: true });
  await expect(saveExtensions).toBeEnabled();
  const [configurationResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents'
      && response.request().method() === 'PATCH' && response.request().postDataJSON()?.agentId === toolAgent.agentId),
    saveExtensions.click(),
  ]);
  const configurationBody = configurationResponse.request().postDataJSON() as Record<string, unknown>;
  expect(configurationBody.expectedRevision).toBe(before.agent.revision);
  expect(configurationBody.expectedWorkflowRevision).toBe(before.extensions.workflowRevision);
  expect(configurationBody.extensions).toBeTruthy();
  for (const field of ['workflow', 'capabilities', 'relevantSkills', 'relevantConnections', 'enabledTools',
    'defaultProviderInstallationId', 'defaultProvider', 'defaultModel', 'defaultThinking']) {
    expect(Object.hasOwn(configurationBody, field), `The extension edit preserves ${field}.`).toBe(false);
  }
  await data<Inspection>(configurationResponse, 'Actual Settings full extension replacement');
  await expect(management.getByText(en.agentWorkflowManagement.saved, { exact: true })).toBeVisible();
  const closeManagement = management.locator('[data-slot="dialog-footer"]').getByRole('button', { name: en.agentWorkflowManagement.close, exact: true });
  await expect(closeManagement).toBeEnabled();
  await closeManagement.click();
  const configured = await inspectToolCreated();
  expect(configured.agent.enabledTools).toEqual(['read']);
  expect(configured.extensions.workflowRevision).toBeGreaterThan(before.extensions.workflowRevision);
  expect(configured.extensions.configuration?.mode).toBe('fixed');
  if (configured.extensions.configuration?.mode !== 'fixed') throw new Error('Settings must preserve the complete fixed configuration.');
  const key = (pin: ExtensionPackagePin) => JSON.stringify([pin.resourceRef, pin.publishedRevisionRef, pin.checksum]);
  expect((configured.extensions.configuration.workflow?.packages ?? []).map(key).sort()).toEqual([pluginPin, skillPin].map(key).sort());
  expect(configured.extensions.configuration.selections).toHaveLength(2);
  expect(configured.extensions.configuration.standalone).toHaveLength(1);
  const slot = configured.extensions.configuration.standalone[0];
  expect(slot.mode === 'fixed' ? slot.entry.requirement : null).toBe('optional');
  expect(slot.mode === 'fixed' && slot.entry.selection.kind === 'mcp' ? slot.entry.selection.target.connectionRef : null).toBe(mcpRef);

  // Settings exposes the shared configuration editor. The existing profile
  // dialog is reached through the Home selector for an actual name-only edit.
  const renamed = `${toolAgent.agentName} UI edited`;
  const profile = await openEdit(configured.agent.name);
  await profile.getByRole('textbox', { name: en.settings.agentPanel.createDialog.nameLabel, exact: true }).fill(renamed);
  const renameButton = profile.getByTestId('edit-agent-save');
  await expect(renameButton).toBeEnabled();
  const [nameResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents'
      && response.request().method() === 'PATCH' && response.request().postDataJSON()?.agentId === toolAgent.agentId),
    renameButton.click(),
  ]);
  expect(nameResponse.request().postDataJSON()).toEqual({ agentId: toolAgent.agentId,
    expectedRevision: configured.agent.revision, name: renamed });
  await data<Inspection>(nameResponse, 'Actual tool-created Agent profile rename');
  await expect(profile).toHaveCount(0);
  const after = await inspectToolCreated();
  expect(after.agent.name).toBe(renamed);
  expect(after.agent.revision).toBeGreaterThan(before.agent.revision);
  expect(after.agent.enabledTools).toEqual(['read']);
  expect(after.extensions.workflowRevision).toBe(configured.extensions.workflowRevision);
  const afterConfiguration = after.extensions.configuration;
  if (afterConfiguration?.mode !== 'fixed') throw new Error('The profile-only edit must preserve the fixed configuration.');
  expect(afterConfiguration.workflow).toEqual(configured.extensions.configuration.workflow);
  expect(afterConfiguration.selections).toEqual(configured.extensions.configuration.selections);
  expect(afterConfiguration.standalone).toHaveLength(1);
  const afterSlot = afterConfiguration.standalone[0];
  if (afterSlot.mode !== 'fixed' || slot.mode !== 'fixed') throw new Error('The exact selected MCP must remain fixed.');
  // Retained edit handles intentionally bind the current profile revision; compare
  // the durable slot identity and limits rather than an obsolete edit seal.
  expect(afterSlot.configurationId).toBe(slot.configurationId);
  expect(afterSlot.entry.selection).toEqual(slot.entry.selection);
  expect(afterSlot.entry.requirement).toBe(slot.entry.requirement);
  expect(afterSlot.entry.toolCap).toEqual(slot.entry.toolCap);
  await fs.writeFile(path.join(fixture.root, 'agent-tool-browser-proof.json'), JSON.stringify({
    version: 1, nonce: fixture.nonce, actorId: fixture.actorId, agentId: toolAgent.agentId, sessionId: toolAgent.sessionId,
    before: { revision: before.agent.revision, workflowRevision: before.extensions.workflowRevision },
    after: { revision: after.agent.revision, workflowRevision: after.extensions.workflowRevision, name: renamed },
    packagePins: [pluginPin, skillPin], mcpConnectionRefs: [mcpRef],
  }), { mode: 0o600 });
  await snapshot('tool-created-settings-and-profile-edits');
});
