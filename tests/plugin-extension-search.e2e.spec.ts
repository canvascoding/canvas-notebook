import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Locator, type Page, type Request, type Response } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import type { PluginExtensionItem, PluginExtensionSearchResponse } from '../app/lib/plugins/plugin-extension-contracts';
import type { CapabilityPackageStoreApplicationResult, CapabilityPackageStoreSelection } from '../app/lib/capabilities/packages/store-contracts';
import type { CapabilityPackageMcpTemplate, CapabilityPackagePresentation } from '../app/lib/capabilities/packages/presentation-contracts';
import type { CapabilityPackageMcpMatches } from '../app/lib/capabilities/packages/mcp-template-matches';
import type { IntegrationConnectionDescriptor } from '../app/lib/integration-tools/connections/contracts';
import type { AgentWorkflowManagement } from '../app/lib/agents/workflow-management-contracts';
import type { AgentWorkflowManagementSaveResult } from '../app/components/agents/agent-workflow-management-client';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';
import de from '../messages/de.json';

type Locale = 'en' | 'de';
type Fixture = { version: 1; nonce: string; repo: string; root: string; actorId: string; databaseName: string; dataRoot: string;
  baseURL: string; buildId: string; packageName: string; skillName: string; mcpUrl: string; mcpSpki: string; composioOrigin: string;
  logoUrl: string; registryId: string; sources: CapabilityPackageStoreSelection[] };
type Workspaces = { organizationId: string; workspaces: ClientWorkspaceSummary[] };
let fixture: Fixture, admin: BrowserContext, member: BrowserContext, page: Page;
let personalId = '', memberPersonalId = '', organizationId = '', teamId = '', memberId = '', packageRef = '', skillRef = '';
let agentId = '';
let sharedMcpRef = '', packagedSharedMcpRef = '', memberPackageRef = '';
let packagePin: { resourceRef: string; revisionRef: string; checksum: string };
const sharedConnections: IntegrationConnectionDescriptor[] = [];
const runtimeErrors: string[] = [], forbiddenCalls: string[] = [];
const logoFailures: string[] = [];
const assetErrors: Array<{path: string; query: Record<string, string>; status: number; code: string}> = [];
let assetErrorWrites = Promise.resolve();
const oauthStartResponses: Array<{operation: string; status: number; success: boolean | null; code: string}> = [];
let oauthResponseWrites = Promise.resolve();
const runtimeErrorDetails: Array<{ name: string; message: string; stack: string; pageOrigin: string; frameOrigins: string[] }> = [];
let runtimeErrorCount = 0, runtimeErrorWrites = Promise.resolve();
const locales = { en, de };

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

function capturePageError(error: Error, target: Page) {
  runtimeErrorCount += 1;
  if (runtimeErrorDetails.length < 20) {
    const redact = (text: string) => ['BOOTSTRAP_ADMIN_PASSWORD', 'TEST_SECONDARY_PASSWORD', 'BETTER_AUTH_SECRET',
      'INTEGRATIONS_ENV_MASTER_KEY', 'PLUGIN_EXTENSION_E2E_CONTROL_TOKEN', 'COMPOSIO_API_KEY']
      .map(key => process.env[key]).filter((value): value is string => Boolean(value))
      .reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text)
      .replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-postgres-url]');
    const origin = (location: string) => {
      try { const url = new URL(location); return url.origin === 'null' ? `opaque (${url.protocol})` : url.origin; }
      catch { return 'unavailable'; }
    };
    runtimeErrors.push(error.name.slice(0, 128));
    runtimeErrorDetails.push({ name: error.name.slice(0, 128), message: redact(error.message).slice(0, 2048),
      stack: redact(error.stack || '').slice(0, 8192), pageOrigin: origin(target.url()),
      frameOrigins: target.frames().slice(0, 8).map(frame => origin(frame.url())) });
  }
  const snapshot = JSON.stringify({ version: 1, nonce: fixture.nonce, count: runtimeErrorCount, errors: runtimeErrorDetails });
  runtimeErrorWrites = runtimeErrorWrites.then(() => fs.writeFile(path.join(fixture.root, 'page-errors.json'), snapshot, { mode: 0o600 }));
}
function captureIconResponse(response: Response) {
  const url = new URL(response.url());
  if (url.origin !== fixture.baseURL || response.status() < 400 || response.request().resourceType() !== 'image'
    || !/^\/api\/capabilities\/packages\/[^/]+\/icon$/u.test(url.pathname) || assetErrors.length >= 40) return;
  const observation = {path: url.pathname.slice(0, 4096), query: Object.fromEntries(['revision', 'workspaceId', 'childName']
    .flatMap(key => url.searchParams.has(key) ? [[key, url.searchParams.get(key)!.slice(0, 2048)]] : [])), status: response.status(), code: 'unavailable'};
  assetErrors.push(observation);
  assetErrorWrites = assetErrorWrites.then(async () => {
    try {
      const bytes = await response.body();
      if (bytes.length <= 64 * 1024) {
        const value: unknown = JSON.parse(bytes.toString('utf8'));
        const code = value && typeof value === 'object' ? Reflect.get(value, 'code') : undefined;
        if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code)) observation.code = code;
      }
    } catch { /* Diagnostics retain public status when the image response body is unavailable. */ }
    await fs.writeFile(path.join(fixture.root, 'asset-errors.json'), JSON.stringify({version: 1, nonce: fixture.nonce, errors: assetErrors}), {mode: 0o600});
  });
}
function captureOAuthStartResponse(response: Response) {
  const url = new URL(response.url());
  if (url.origin !== fixture.baseURL || response.request().method() !== 'POST' || oauthStartResponses.length >= 40) return;
  const operation = url.pathname === '/api/integrations/mcp-status' && response.request().postDataJSON()?.action === 'authorize' ? 'personal_mcp'
    : /^\/api\/mcp\/shared-connections\/[^/]+\/oauth$/u.test(url.pathname) ? 'shared_mcp'
      : /^\/api\/composio\/shared-connections\/[^/]+\/connect$/u.test(url.pathname) ? 'shared_composio'
        : /^\/api\/composio\/connect\/[^/]+$/u.test(url.pathname) ? 'personal_composio' : null;
  if (!operation) return;
  const observation = {operation, status: response.status(), success: null as boolean | null, code: 'unavailable'};
  oauthStartResponses.push(observation);
  oauthResponseWrites = oauthResponseWrites.then(async () => {
    try {
      const bytes = await response.body();
      if (bytes.length <= 64 * 1024) {
        const value: unknown = JSON.parse(bytes.toString('utf8'));
        if (value && typeof value === 'object') {
          const success = Reflect.get(value, 'success'), code = Reflect.get(value, 'code');
          if (typeof success === 'boolean') observation.success = success;
          if (typeof code === 'string' && (/^(?:MCP|CONNECTION|COMPOSIO|SECRETS|INTEGRATIONS)_[A-Z0-9_]{1,60}$/u.test(code)
            || ['unauthorized', 'invalid_request', 'binding_changed', 'provider_denied', 'provider_unavailable', 'rate_limit_exceeded',
              'setup_required', 'authorization_failed', 'authorization_cancelled', 'mcp_connection_changed', 'mcp_environment_binding_changed', 'insufficient_scope'].includes(code))) observation.code = code;
        }
      }
    } catch { /* Only public status/code are retained; response URLs, state, credentials and tokens are never diagnostics. */ }
    await fs.writeFile(path.join(fixture.root, 'oauth-start-responses.json'), JSON.stringify({version: 1, nonce: fixture.nonce, responses: oauthStartResponses}), {mode: 0o600});
  });
}

async function json<T>(response: APIResponse | Response, phase: string, status = 200): Promise<T> {
  if (response.status() !== status) {
    let code = 'unavailable';
    const bytes = await response.body();
    if (bytes.length <= 64 * 1024) {
      try {
        const result: unknown = JSON.parse(bytes.toString('utf8'));
        const value = result && typeof result === 'object' ? Reflect.get(result, 'code') : undefined;
        if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value)) code = value;
      } catch { /* Public status is still reported when this is not a bounded JSON error. */ }
    }
    throw new Error(`${phase}: HTTP ${response.status()} (expected ${status}); public code ${code}`);
  }
  return await response.json() as T;
}
async function data<T>(response: APIResponse | Response, phase: string, status = 200): Promise<T> {
  const result = await json<{ success: boolean; data?: T }>(response, phase, status);
  expect(result.success, `${phase}: public success envelope`).toBe(true);
  expect(result.data, `${phase}: public result`).toBeDefined();
  return result.data!;
}
function href(locale: Locale = 'en', values: Record<string, string> = {}, workspaceId = personalId) {
  const { types, source, ...rest } = values;
  return `/${locale}/plugins?${new URLSearchParams({ workspaceId, scope: 'all', ...rest,
    ...(types ? { kind: types } : {}), ...(source ? { extensionSource: source } : {}),
  })}`;
}
function searchResponse(target: Page, values: Record<string, string> = {}) {
  return target.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET' && url.pathname === '/api/plugins/search'
      && Object.entries(values).every(([key, value]) => url.searchParams.get(key) === value);
  });
}
async function ready(target = page) {
  await expect(target.getByTestId('plugin-extension-results')).toBeVisible();
  await expect(target.getByTestId('plugin-extension-results')).toHaveAttribute('aria-busy', 'false');
}
async function openCatalog(locale: Locale = 'en', values: Record<string, string> = {}, target = page, workspaceId = personalId) {
  const response = searchResponse(target, { workspaceId, ...values });
  await target.goto(href(locale, values, workspaceId), { waitUntil: 'domcontentloaded' });
  const result = await data<PluginExtensionSearchResponse>(await response, 'Actual common extension search');
  await ready(target); return result;
}
async function search(q: string, target = page) {
  const response = searchResponse(target, { q });
  await target.getByTestId('plugin-extension-search-input').fill(q);
  const result = await data<PluginExtensionSearchResponse>(await response, 'Actual searched common catalogue');
  await ready(target); await expect(target.getByTestId('plugin-extension-search-input')).toHaveValue(q);
  return result;
}
function exactRow(kind: PluginExtensionItem['kind'], name: string, target = page) {
  return target.locator(`[data-testid="plugin-extension-row"][data-kind="${kind}"]`).filter({ hasText: name });
}
function requirementRow(label: string) {
  return page.getByTestId('package-requirements-setup').locator('article[data-testid^="package-requirement-"]')
    .filter({ has: page.getByRole('heading', { name: label, exact: true }) });
}
async function openRow(kind: PluginExtensionItem['kind'], name: string, target = page) {
  const current = exactRow(kind, name, target); await expect(current).toHaveCount(1);
  await current.getByTestId('plugin-extension-row-open').click();
  await expect(target.getByTestId('plugin-extension-back')).toBeVisible();
  await expect(target.getByTestId('plugin-extension-search-input')).toBeVisible();
}
async function filter(id: 'stock' | 'source' | 'scope', value: string, target = page) {
  const control = target.getByTestId(`plugin-extension-${id}-filter`);
  if (!await control.isVisible()) await target.getByTestId('plugin-extension-filter-toggle').click();
  const response = searchResponse(target, { [id]: value }); await control.selectOption(value);
  const result = await data<PluginExtensionSearchResponse>(await response, 'Actual filtered common catalogue');
  await ready(target); return result;
}
async function screenshot(name: string, target = page) {
  expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no horizontal document overflow`).toBe(true);
  const file = path.join(fixture.root, `${name}.png`); await target.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' });
  console.info(`PLUGIN_EXTENSION_E2E_SCREENSHOT ${file}`);
  await test.info().attach(name, { path: file, contentType: 'image/png' });
}
async function expectLoadedPackageIcon(avatar: Locator, resourceRef: string) {
  await expect(avatar).toHaveAttribute('aria-hidden', 'true');
  await expect(avatar).toHaveAttribute('data-source-key', /.+/u);
  const image = avatar.getByTestId('plugin-extension-avatar-image'); await expect(image).toBeVisible();
  const source = await image.getAttribute('src'); expect(source).toBeTruthy();
  const url = new URL(source!, fixture.baseURL);
  expect(url.origin).toBe(fixture.baseURL);
  expect(url.pathname).toBe(`/api/capabilities/packages/${encodeURIComponent(resourceRef)}/icon`);
  expect(url.searchParams.get('workspaceId')).toBe(personalId); expect(url.searchParams.get('revision')).toBeTruthy();
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0),
    { message: 'The real authorized package asset loads successfully.' }).toBe(true);
  await expect(avatar.getByTestId('plugin-extension-avatar-initials')).toHaveCount(0);
}
async function catalogue(context = admin, options: Record<string, string> = {}, workspaceId = personalId) {
  const items = new Map<string, PluginExtensionItem>(); let cursor: string | null = null, pages = 0;
  do {
    const result = await data<PluginExtensionSearchResponse>(await context.request.get(`/api/plugins/search?${new URLSearchParams({
      workspaceId, scope: 'all', ...options, ...(cursor ? { cursor } : {}),
    })}`), 'Fresh exact actor search API');
    for (const item of result.items) items.set(item.id, item);
    cursor = result.pagination.nextCursor; expect(++pages, 'The common cursor must make bounded progress.').toBeLessThan(30);
  } while (cursor);
  return [...items.values()];
}
async function readControl() {
  const url = process.env.PLUGIN_EXTENSION_E2E_CONTROL_URL, token = process.env.PLUGIN_EXTENSION_E2E_CONTROL_TOKEN;
  if (!url || !token) throw new Error('The owned private provider control is required.');
  const response = await admin.request.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return json<{ counters: { approvals: number; denials: number; sdkLinks: number; callbackRedirects: number; businessCalls: number; blockedExternalRedirects: number; laterToolkitPageReads: number }; toolkitReads: number }>(response, 'Local provider counters');
}
async function registryStatus(status: 200 | 503) {
  const url = process.env.PLUGIN_EXTENSION_E2E_CONTROL_URL, token = process.env.PLUGIN_EXTENSION_E2E_CONTROL_TOKEN;
  if (!url || !token) throw new Error('The owned private provider control is required.');
  const result = await json<{ success: boolean }>(await admin.request.post(url, {
    headers: { Authorization: `Bearer ${token}` }, data: { operation: 'registry-status', status },
  }), 'Owned local HTTP registry status control'); expect(result.success).toBe(true);
}
async function installVisible(kind: 'plugin' | 'skill', name: string, targetOwnership = 'user') {
  await openCatalog('en', { q: name });
  const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/capabilities/packages/store/preview'
    && response.request().method() === 'POST' && response.request().postDataJSON()?.source?.kind === kind
    && response.request().postDataJSON()?.source?.entryKey === name);
  await openRow(kind, name);
  const preview = (await data<{ presentation: CapabilityPackagePresentation }>(await previewResponse, 'Actual exact Store package preview')).presentation;
  expect(preview.kind).toBe(kind); expect(preview.name).toBe(name); expect(preview.title).toBeTruthy();
  expect(preview.source).toEqual(fixture.sources.find(value => value.kind === kind && value.entryKey === name));
  const wizard = page.getByTestId('store-package-wizard'); await expect(wizard).toHaveAttribute('aria-busy', 'false');
  await wizard.getByTestId('store-wizard-target').selectOption(targetOwnership);
  const options = page.waitForResponse(response => new URL(response.url()).pathname === '/api/capabilities/packages/store/install-options' && response.request().method() === 'POST');
  await wizard.getByRole('button', { name: en.skills.workspace.storeWizard.confirmTarget, exact: true }).click();
  await data<unknown>(await options, 'Actual Store installation target options');
  const installed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/capabilities/packages/store/install' && response.request().method() === 'POST');
  await wizard.getByRole('button', { name: en.skills.workspace.storeWizard.install, exact: true }).click();
  const result = await data<CapabilityPackageStoreApplicationResult>(await installed, 'Actual package installation through UI');
  expect(result.state.kind).toBe(kind); expect(result.state.name).toBe(name);
  expect(result.resource.ownership.type).toBe(targetOwnership); expect(result.published.version).toBe('1.0.0');
  await expect(page.getByTestId('package-detail-title')).toHaveText(result.resource.displayName || preview.title);
  await expectLoadedPackageIcon(page.getByTestId('package-detail-workspace').locator('header').getByTestId('plugin-extension-avatar'), result.resource.resourceRef);
  return result;
}
async function consent(action: () => Promise<void>, decision: 'approve' | 'deny', mode: 'popup' | 'same-tab' = 'same-tab') {
  // API fixture requests use Canvas Origin. Native provider forms must supply their own browser-computed Origin.
  await page.context().setExtraHTTPHeaders({});
  try {
    const popupPromise = mode === 'popup' ? page.waitForEvent('popup') : null;
    await action(); const consentPage = popupPromise ? await popupPromise : page;
    const mcpOrigin = new URL(fixture.mcpUrl).origin;
    await consentPage.waitForURL(url => url.origin === fixture.composioOrigin || url.origin === mcpOrigin);
    await consentPage.waitForLoadState('domcontentloaded');
    const target = new URL(consentPage.url()); expect(target.hostname).toBe('127.0.0.1');
    expect(target.protocol).toBe(target.origin === mcpOrigin ? 'https:' : 'http:');
    await expect(consentPage.getByRole('heading', { name: 'Connect Canvas Notebook', exact: true })).toBeVisible();
    const returned = consentPage.waitForResponse(response => {
      const url = new URL(response.url()); return url.origin === fixture.baseURL && /\/api\/(?:composio|mcp)\//u.test(url.pathname) && /callback$/u.test(url.pathname);
    });
    await consentPage.getByRole('button', { name: decision === 'approve' ? 'Approve' : 'Deny', exact: true }).click();
    const callback = await returned, callbackURL = new URL(callback.url());
    if (decision === 'deny' && target.origin === mcpOrigin && callbackURL.pathname === '/api/mcp/oauth/callback') {
      // A validated personal denial consumes its pending state and intentionally renders HTTP 400.
      // No other provider failure or callback may satisfy this exception.
      const state = target.searchParams.get('state'), redirect = new URL(target.searchParams.get('redirect_uri') || 'https://invalid.test');
      expect(target.pathname).toBe('/authorize');
      expect(target.searchParams.getAll('state')).toHaveLength(1);
      expect(target.searchParams.getAll('redirect_uri')).toHaveLength(1);
      expect(Boolean(state && /^[A-Za-z0-9_-]{32}$/u.test(state)), 'The owned personal flow has a valid pending state.').toBe(true);
      expect(redirect.origin === fixture.baseURL && redirect.pathname === '/api/mcp/oauth/callback' && !redirect.search && !redirect.hash,
        'The registered redirect is the exact personal MCP callback.').toBe(true);
      expect(['state', 'iss', 'error'].every(key => callbackURL.searchParams.getAll(key).length === 1)
        && callbackURL.searchParams.get('state') === state && callbackURL.searchParams.get('iss') === mcpOrigin
        && callbackURL.searchParams.get('error') === 'access_denied' && !callbackURL.searchParams.has('code'),
      'The denial returns the exact owned state/issuer and access_denied without an authorization code.').toBe(true);
      expect(callback.status()).toBe(400);
      const headers = callback.headers();
      expect(headers['content-type']).toBe('text/html; charset=utf-8');
      expect(headers['cache-control']).toBe('no-store');
      // Next's global proxy applies its own Referrer-Policy/CSP after the route response.
      // They are independent of the validated personal-denial callback contract.
      const safeHTML = '<!doctype html><html><head><meta charset="utf-8"><title>MCP OAuth failed</title></head><body><h1>MCP OAuth failed</h1><p>Provider returned: access_denied</p></body></html>';
      expect((await callback.text()) === safeHTML, 'The validated denial renders only the exact public access_denied page.').toBe(true);
    } else {
      expect(callback.status()).toBeGreaterThanOrEqual(200); expect(callback.status()).toBeLessThan(400);
    }
    // The ordinary web callback may leave a tab with the returned exact Plugin entry.
    // Read-back on the original tab is authoritative, independently of popup closure.
    if (consentPage !== page && !consentPage.isClosed()) await consentPage.close();
    if (consentPage === page) await page.waitForURL(url => url.origin === fixture.baseURL && url.pathname.endsWith('/plugins'));
  } finally { await page.context().setExtraHTTPHeaders({ Origin: fixture.baseURL }); }
}
async function navigationDecision(action: () => Promise<unknown>, decision: 'accept' | 'dismiss') {
  const prompt = page.waitForEvent('dialog'); const performed = action(); const dialog = await prompt;
  const type = dialog.type();
  if (decision === 'accept') await dialog.accept(); else await dialog.dismiss();
  expect(type, 'Dirty Plugin setup uses the actual browser confirmation.').toBe('confirm');
  await performed;
}

test.beforeAll(async ({ browser }) => {
  expect(process.env.CANVAS_PLUGIN_EXTENSION_E2E).toBe('1'); expect(process.env.BASE_URL).toBe('http://127.0.0.1:3001');
  const file = process.env.PLUGIN_EXTENSION_E2E_FIXTURE;
  if (!file || !path.isAbsolute(file)) throw new Error('The isolated runner fixture is required.');
  const stat = await fs.lstat(file); expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600).toBe(true);
  fixture = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture;
  expect(fixture.version).toBe(1); expect(fixture.nonce).toMatch(/^[a-f0-9]{32}$/u); expect(fixture.repo).toBe(await fs.realpath(process.cwd()));
  expect(fixture.root).toBe(path.dirname(file)); expect(fixture.buildId).toBe((await fs.readFile('.next/BUILD_ID', 'utf8')).trim());
  expect(fixture.mcpSpki).toBe(process.env.PLUGIN_EXTENSION_E2E_MCP_SPKI); expect(fixture.mcpSpki).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
  const mcp = new URL(fixture.mcpUrl); expect(mcp.protocol).toBe('https:'); expect(mcp.hostname).toBe('127.0.0.1'); expect(mcp.port).toBeTruthy();
  const composio = new URL(fixture.composioOrigin); expect(composio.protocol).toBe('http:'); expect(composio.hostname).toBe('127.0.0.1'); expect(composio.port).toBeTruthy();
  const logo = new URL(fixture.logoUrl); expect(logo.protocol).toBe('https:'); expect(logo.hostname).toBe('127.0.0.1');
  expect(logo.pathname).toBe('/logos/canva.svg'); expect(logo.port).toBeTruthy();
  expect(fixture.databaseName).toBe(`canvas_plugin_extension_test_${fixture.nonce}`);
  admin = await createAuthenticatedContext(browser, { baseURL: fixture.baseURL, viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { Origin: fixture.baseURL } });
  await runManagedTestPreflight(admin, { baseURL: fixture.baseURL });
  const identity = await json<{ user: { id: string; role: string } }>(await requestManagedTestSession(admin.request), 'Actual isolated owner session');
  expect(identity.user.id).toBe(fixture.actorId); expect(identity.user.role).toBe('admin');
  const listing = await json<Workspaces>(await admin.request.get('/api/workspaces'), 'Owner workspaces'); organizationId = listing.organizationId;
  const personal = listing.workspaces.find(value => value.type === 'personal' && value.status === 'active' && value.ownerUserId === fixture.actorId);
  expect(personal).toBeDefined(); personalId = personal!.id;
  const email = process.env.TEST_SECONDARY_EMAIL, password = process.env.TEST_SECONDARY_PASSWORD;
  if (!email || !password) throw new Error('The ordinary member credentials are required.');
  const proposal = await data<{ membershipId: string; approval: { required: boolean }; quote: { nonBillable: boolean } }>(await admin.request.post('/api/admin/organization/memberships', {
    data: { name: `Extension member ${fixture.nonce.slice(0, 10)}`, email, role: 'member' },
  }), 'Real non-billable member proposal', 202);
  expect(proposal.approval.required).toBe(false); expect(proposal.quote.nonBillable).toBe(true);
  const active = await data<{ stage: string }>(await admin.request.post(`/api/admin/organization/memberships/${encodeURIComponent(proposal.membershipId)}/activate`, { data: { password } }), 'Real membership activation');
  expect(active.stage).toBe('active');
  member = await createAuthenticatedContext(browser, { baseURL: fixture.baseURL, viewport: { width: 390, height: 900 }, extraHTTPHeaders: { Origin: fixture.baseURL } }, { email, password });
  const memberSession = await json<{ user: { id: string; role: string } }>(await requestManagedTestSession(member.request), 'Ordinary member session');
  memberId = memberSession.user.id; expect(memberSession.user.role).not.toBe('admin'); expect(memberId).not.toBe(fixture.actorId);
  const memberListing = await json<Workspaces>(await member.request.get('/api/workspaces'), 'Member workspaces'); expect(memberListing.organizationId).toBe(organizationId);
  memberPersonalId = memberListing.workspaces.find(value => value.type === 'personal' && value.ownerUserId === memberId)!.id;
  const created = await json<{ workspace: { id: string } }>(await admin.request.post('/api/workspaces', {
    data: { type: 'team', name: `Extension team ${fixture.nonce.slice(0, 10)}` },
  }), 'Real isolated team workspace', 201); teamId = created.workspace.id;
  expect((await admin.request.post(`/api/workspaces/${encodeURIComponent(teamId)}/members`, { data: {
    userId: memberId, role: 'member', canRead: true, canWrite: false, canManage: false,
  } })).status()).toBe(200);
  for (const [context, workspaceId] of [[admin, personalId], [member, memberPersonalId]] as const) {
    await context.addInitScript(({ workspaceId: value, appOrigin }) => {
      if (location.origin !== appOrigin) return;
      localStorage.setItem('canvas.activeWorkspaceId', value);
      if (!localStorage.getItem('theme')) localStorage.setItem('theme', 'light');
    }, { workspaceId, appOrigin: fixture.baseURL });
    context.on('request', request => {
      const url = new URL(request.url());
      if (/\/tools\/execute\//u.test(url.pathname) || /^\/api\/integrations\/gateway\/call/u.test(url.pathname)) forbiddenCalls.push(`${request.method()} ${url.pathname}`);
    });
    context.on('requestfailed', request => {
      if (request.url() === fixture.logoUrl && request.resourceType() === 'image') logoFailures.push(request.failure()?.errorText || 'image request failed');
    });
    context.on('response', captureIconResponse);
    context.on('response', captureOAuthStartResponse);
    context.on('page', value => value.on('pageerror', error => capturePageError(error, value)));
  }
  page = await admin.newPage();
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && fixture && page && !page.isClosed()) {
    const file = path.join(fixture.root, `failure-case-${info.line}.png`);
    try {
      await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide', timeout: 10_000 });
      console.info(`PLUGIN_EXTENSION_E2E_SCREENSHOT ${file}`);
      await info.attach('actual-ui-failure', { path: file, contentType: 'image/png' });
    } catch { console.info('PLUGIN_EXTENSION_E2E_FAILURE_SCREENSHOT_UNAVAILABLE'); }
  }
  await runtimeErrorWrites;
  await assetErrorWrites;
  await oauthResponseWrites;
  expect(runtimeErrors, 'The real Plugin UI has no unhandled runtime errors.').toEqual([]);
  expect(forbiddenCalls, 'Browsing and setup do not execute provider business actions.').toEqual([]);
});
test.afterAll(async () => {
  try {
    await runtimeErrorWrites;
    await assetErrorWrites;
    await oauthResponseWrites;
    if (admin) {
      const proof = await readControl();
      await fs.writeFile(path.join(fixture.root, 'browser-proof.json'), JSON.stringify({ version: 1, nonce: fixture.nonce, actorId: fixture.actorId,
        packageRef, skillRef, agentId, sharedMcpRef, packagedSharedMcpRef, memberPackageRef, teamId, sharedConnectionRefs: sharedConnections.map(value => value.resource.connectionRef), counters: proof.counters,
        runtimeErrors, forbiddenCalls, logoFailures }), { mode: 0o600 });
      expect(proof.counters.businessCalls).toBe(0); expect(proof.counters.blockedExternalRedirects).toBe(0);
    }
  } finally {
    const closed = await Promise.allSettled([member, admin].filter(Boolean).map(context => context.close()));
    expect(closed.filter(value => value.status === 'rejected'), 'Own browser contexts close on both success and failure.').toEqual([]);
  }
});

test('standalone MCP setup and one real search expose all four types; filters and detail Back preserve query and focus', async () => {
  await openCatalog(); await filter('scope', 'organization'); await page.getByTestId('plugin-extension-add-mcp').click();
  await page.locator('#plugin-mcp-scope').selectOption('user'); await page.getByTestId('plugin-mcp-add-personal').click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await dialog.locator('#mcp-server-name').fill('Canva MCP'); await dialog.locator('#mcp-url').fill(fixture.mcpUrl);
  await dialog.getByRole('tab', { name: en.settings.mcpConfig.authOAuth, exact: true }).click();
  await expect(dialog.getByRole('tab', { name: en.settings.mcpConfig.authOAuth, exact: true })).toHaveAttribute('aria-selected', 'true');
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/integrations/mcp-config' && response.request().method() === 'PUT');
  await dialog.getByRole('button', { name: en.settings.mcpConfig.saveServer, exact: true }).click();
  const persisted = await data<{ rawContent: string }>(await saved, 'Actual standalone MCP form persistence');
  const config = JSON.parse(persisted.rawContent) as { mcpServers: Record<string, { connectionId: string; auth: string }> };
  const server = config.mcpServers['Canva MCP']; expect(server?.connectionId).toBeTruthy(); expect(server.auth).toBe('oauth');
  const selectedId = `mcp-personal:${server.connectionId}`;
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('plugin-integration-detail')).toBeVisible();
  await expect(page.getByTestId('plugin-integration-detail').getByRole('heading', { name: 'Canva MCP', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('scope')).toBe('organization');
  expect(new URL(page.url()).searchParams.get('extensionId')).toBe(selectedId);
  const selected = await data<PluginExtensionSearchResponse>(await admin.request.get(`/api/plugins/search?${new URLSearchParams({
    workspaceId: personalId, scope: 'organization', types: 'mcp', selected: selectedId,
  })}`), 'Fresh authorized personal MCP detail independent from Organization list filter');
  expect(selected.selectedItem?.id).toBe(selectedId);
  expect(selected.selectedItem?.ownership).toMatchObject({ type: 'user', ownerUserId: fixture.actorId });
  expect(selected.items.some(value => value.id === selectedId)).toBe(false);
  await screenshot('personal-mcp-detail-under-organization-filter');
  await page.getByTestId('plugin-extension-back').click(); await ready(); await filter('scope', 'all');
  const result = await search('canva'); expect(new Set(result.items.map(value => value.kind))).toEqual(new Set(['plugin', 'skill', 'integration', 'mcp']));
  for (const [kind, name] of [['plugin', fixture.packageName], ['skill', fixture.skillName], ['integration', 'Canva'], ['mcp', 'Canva MCP']] as const) await expect(exactRow(kind, name)).toHaveCount(1);
  for (const [kind, name, initials] of [['plugin', fixture.packageName, 'CW'], ['skill', fixture.skillName, 'CB'], ['integration', 'Canva', 'CA']] as const) {
    expect(result.items.find(item => item.kind === kind && item.name === name.toLowerCase())?.icon?.url).toBe(fixture.logoUrl);
    const avatar = exactRow(kind, name).getByTestId('plugin-extension-avatar');
    await expect(avatar).toHaveAttribute('aria-hidden', 'true'); await expect(avatar).toHaveAttribute('data-source-key', /.+/u);
    await expect(avatar.getByTestId('plugin-extension-avatar-initials')).toHaveText(initials);
    await expect(avatar.getByTestId('plugin-extension-avatar-image')).toHaveCount(0);
  }
  await expect.poll(() => logoFailures.length, { message: 'Owned HTTPS image genuinely fails browser certificate validation and becomes initials.' }).toBeGreaterThan(0);
  await expect(exactRow('mcp', 'Canva MCP').getByTestId('plugin-extension-avatar-initials')).toHaveText('CM');
  expect(await page.getByRole('searchbox').count(), 'Catalogue discovery exposes one search input.').toBe(1);
  for (const kind of ['plugin', 'skill', 'integration', 'mcp'] as const) {
    const response = searchResponse(page, { types: kind, q: 'canva' }); await page.getByTestId(`plugin-extension-kind-${kind}`).click();
    const filtered = await data<PluginExtensionSearchResponse>(await response, 'Actual type filtered search'); expect(filtered.items.every(value => value.kind === kind)).toBe(true);
    await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue('canva');
  }
  const all = searchResponse(page, { q: 'canva' }); await page.getByTestId('plugin-extension-kind-all').click(); await data<unknown>(await all, 'All types restored'); await ready();
  const stored = await filter('stock', 'installed'); expect(stored.items.every(value => value.stock === 'installed')).toBe(true); await filter('stock', 'all');
  const composio = await filter('source', 'composio'); expect(composio.items.every(value => value.source === 'composio')).toBe(true); await filter('source', 'all');
  await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue('canva');
  const original = exactRow('integration', 'Canva').getByTestId('plugin-extension-row-open'); await original.focus(); await original.press('Enter');
  await expect(page.getByTestId('plugin-extension-back')).toBeVisible(); await page.getByTestId('plugin-extension-back').click(); await ready();
  await expect(original).toBeFocused(); await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue('canva');
  await screenshot('global-search-four-types');
});

test('real second Composio page is searchable, no-auth never starts OAuth, and independent skill installation retains its identity', async () => {
  const before = await readControl(); expect(before.counters.laterToolkitPageReads).toBeGreaterThan(0);
  const results = await openCatalog('en', { q: 'github' });
  expect(results.items.some(value => value.kind === 'integration' && value.toolkit.slug === 'github')).toBe(true);
  await expect(exactRow('integration', 'GitHub')).toBeVisible();
  const later = await catalogue(admin, { q: 'duckduckgo' }); const publicApp = later.find(value => value.kind === 'integration' && value.toolkit.slug === 'duckduckgo');
  expect(publicApp?.kind === 'integration' && publicApp.toolkit.noAuth).toBe(true);
  await openCatalog('en', { q: 'duckduckgo' }); await openRow('integration', 'DuckDuckGo');
  await expect(page.getByTestId('plugin-integration-connect')).toHaveCount(0);
  expect((await readControl()).counters.sdkLinks).toBe(before.counters.sdkLinks);
  const installed = await installVisible('skill', fixture.skillName); skillRef = installed.resource.resourceRef;
  const exact = (await catalogue(admin, { q: fixture.skillName, types: 'skill' })).find(value => value.id === skillRef);
  expect(exact?.kind).toBe('skill'); expect(exact?.stock).toBe('installed'); expect(exact?.kind === 'skill' && exact.package?.parentResourceRef).toBeFalsy();
  await expectLoadedPackageIcon(page.getByTestId('package-detail-workspace').locator('header').getByTestId('plugin-extension-avatar'), skillRef);
  await screenshot('standalone-skill-installed');
});

test('real mixed pagination appends unique rows and resets its cursor when the query changes', async () => {
  const initial = await openCatalog(); expect(initial.pagination.hasNextPage).toBe(true);
  const before = await page.getByTestId('plugin-extension-row').evaluateAll(rows => rows.map(value => value.getAttribute('data-extension-id')));
  const continued = searchResponse(page); await page.getByTestId('plugin-extension-more').click();
  await data<PluginExtensionSearchResponse>(await continued, 'Actual mixed catalogue continuation'); await ready();
  const after = await page.getByTestId('plugin-extension-row').evaluateAll(rows => rows.map(value => value.getAttribute('data-extension-id')));
  expect(after.length).toBeGreaterThan(before.length); expect(new Set(after).size).toBe(after.length);
  expect(before.every(value => after.includes(value))).toBe(true);
  await search('canva'); expect(new URL(page.url()).searchParams.has('extensionCursor')).toBe(false);
  await expect(page.getByTestId('plugin-extension-row').filter({ hasText: 'catalog-extra-' })).toHaveCount(0);
  await screenshot('common-search-paginated-then-refined');
});

test('a real Plugin installation exposes required setup and optional integrations; returning resumes the exact installed package', async () => {
  const before = await catalogue(admin, { types: 'mcp,integration' });
  const installed = await installVisible('plugin', fixture.packageName); packageRef = installed.resource.resourceRef;
  packagePin = { resourceRef: packageRef, revisionRef: installed.published.revisionRef, checksum: installed.published.checksum };
  await page.getByTestId('package-detail-tab-connections').click();
  const setup = page.getByTestId('package-requirements-setup'); await expect(setup).toBeVisible();
  const presentation = (await data<{ presentation: CapabilityPackagePresentation }>(await admin.request.get(
    `/api/capabilities/packages/${encodeURIComponent(packageRef)}/presentation?workspaceId=${encodeURIComponent(personalId)}`), 'Actual installed requirements presentation')).presentation;
  expect(presentation.children.some(value => value.name === `${fixture.packageName}-context`)).toBe(true);
  expect(presentation.icon?.url).toContain(`/api/capabilities/packages/${encodeURIComponent(packageRef)}/icon`);
  expect(presentation.children.find(value => value.name === `${fixture.packageName}-context`)?.icon).toBeDefined();
  expect(presentation.requirements.some(value => value.selector?.source === 'composio' && value.selector.toolkit === 'canva' && value.required)).toBe(true);
  expect(presentation.requirements.some(value => value.selector?.source === 'mcp' && value.selector.connector === 'Canva MCP' && value.required)).toBe(true);
  expect(presentation.requirements.some(value => value.selector?.source === 'composio' && value.selector.toolkit === 'github' && !value.required)).toBe(true);
  await expect(setup.getByTestId('package-optional-requirements')).toBeVisible();
  const template = page.waitForResponse(value => new URL(value.url()).pathname.endsWith('/mcp-template'));
  await requirementRow('Canva MCP').getByRole('button', { name: en.skills.workspace.setup.continueSetup, exact: true }).click();
  const exactTemplate = (await data<{ template: CapabilityPackageMcpTemplate }>(await template, 'Actual exact packaged MCP configuration template')).template;
  expect(exactTemplate.resourceRef).toBe(packageRef); expect(exactTemplate.connector.name).toBe('Canva MCP');
  expect(exactTemplate.config?.url).toBe(fixture.mcpUrl);
  const mcpSetup = page.getByTestId('plugin-mcp-setup'); await expect(mcpSetup).toBeVisible();
  await mcpSetup.locator('#plugin-mcp-scope').selectOption('user'); await mcpSetup.getByTestId('plugin-mcp-add-personal').click();
  const dialog = page.getByRole('dialog'); await expect(dialog.locator('#mcp-server-name')).toHaveValue('Canva MCP');
  await expect(dialog.locator('#mcp-url')).toHaveValue(fixture.mcpUrl); await screenshot('package-mcp-exact-template');
  await dialog.getByRole('button', { name: en.settings.mcpConfig.cancel, exact: true }).click();
  await mcpSetup.getByRole('button', { name: en.skills.workspace.setup.back, exact: true }).click();
  await screenshot('package-required-setup-before-auth');
  const currentURL = page.url(); const response = page.waitForResponse(value => new URL(value.url()).pathname.endsWith('/presentation'));
  await page.reload({ waitUntil: 'domcontentloaded' }); await data<unknown>(await response, 'Real resumed installed package presentation');
  await expect(page.getByTestId('package-detail-title')).toHaveText(fixture.packageName); await expect(page.getByTestId('package-requirements-setup')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('resourceRef')).toBe(new URL(currentURL).searchParams.get('resourceRef'));
  const createTemplate = page.waitForResponse(value => new URL(value.url()).pathname.endsWith('/mcp-template'));
  await requirementRow('Canva MCP').getByRole('button', {name: en.skills.workspace.setup.continueSetup, exact: true}).click();
  const declared = (await data<{template: CapabilityPackageMcpTemplate}>(await createTemplate, 'Manifest-only OAuth template for actual personal creation')).template;
  expect(declared.connector.oauth).toBe(true); expect(declared.config?.auth).toBeUndefined();
  await page.getByTestId('plugin-mcp-setup').locator('#plugin-mcp-scope').selectOption('user');
  await page.getByTestId('plugin-mcp-add-personal').click();
  const personalDialog = page.getByRole('dialog'), personalName = `Package personal ${fixture.nonce.slice(0, 10)}`;
  await personalDialog.locator('#mcp-server-name').fill(personalName);
  await expect(personalDialog.getByRole('tab', {name: en.settings.mcpConfig.authOAuth, exact: true})).toHaveAttribute('aria-selected', 'true');
  const createdPersonal = page.waitForResponse(value => new URL(value.url()).pathname === '/api/integrations/mcp-config' && value.request().method() === 'PUT');
  const refreshedCatalog = searchResponse(page, {q: fixture.packageName});
  await personalDialog.getByRole('button', {name: en.settings.mcpConfig.saveServer, exact: true}).click();
  const personalConfig = JSON.parse((await data<{rawContent: string}>(await createdPersonal, 'Actual packaged personal MCP creation')).rawContent) as {
    mcpServers: Record<string, {connectionId: string; auth?: string}>;
  };
  const createdId = `mcp-personal:${personalConfig.mcpServers[personalName]?.connectionId}`;
  expect(personalConfig.mcpServers[personalName]?.connectionId).toBeTruthy(); expect(personalConfig.mcpServers[personalName]?.auth).toBe('oauth');
  await data<PluginExtensionSearchResponse>(await refreshedCatalog, 'Common catalogue refresh after exact packaged personal creation');
  await expect(page.getByTestId('plugin-mcp-setup')).toHaveCount(0);
  await expect(requirementRow('Canva MCP').locator('select[data-testid^="package-requirement-connection-"]')).toHaveValue(createdId);
  expect(new URL(page.url()).searchParams.get('resourceRef')).toBe(packageRef);
  await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue(fixture.packageName);
  await screenshot('package-personal-created-ref-survives-common-search-refresh');
  const after = await catalogue(admin, { types: 'mcp,integration' });
  expect(after.filter(value => value.kind === 'mcp').map(value => value.id).sort()).toEqual([...before.filter(value => value.kind === 'mcp').map(value => value.id), createdId].sort());
});

test('actual dirty shared MCP drafts guard scope changes and nested package Back before discarding without writes', async () => {
  const before = (await catalogue(admin, {types: 'mcp'})).map(item => item.id).sort();
  const mutations: string[] = [];
  const observe = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin === fixture.baseURL && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())
      && /^\/api\/integrations\/(?:shared-connections(?:\/|$)|mcp-config$|mcp-connections$|mcp-definitions(?:\/|$))/u.test(url.pathname)) {
      mutations.push(`${request.method()} ${url.pathname}`);
    }
  };
  page.on('request', observe);
  try {
    await openCatalog('en', {q: 'canva'}); await page.getByTestId('plugin-extension-add-mcp').click();
    let setup = page.getByTestId('plugin-mcp-setup'); await expect(setup).toBeVisible();
    await setup.locator('#plugin-mcp-scope').selectOption('organization');
    let form = setup.getByTestId('shared-connection-create-form'); await expect(form).toBeVisible();
    const standaloneName = `Canva unsaved Organization ${fixture.nonce.slice(0, 10)}`;
    await form.locator('#shared-name').fill(standaloneName); await form.locator('#shared-url').fill(fixture.mcpUrl);
    const standaloneURL = page.url();
    await navigationDecision(() => setup.locator('#plugin-mcp-scope').selectOption('user'), 'dismiss');
    await expect(setup.locator('#plugin-mcp-scope')).toHaveValue('organization');
    await expect(form.locator('#shared-name')).toHaveValue(standaloneName); await expect(form.locator('#shared-url')).toHaveValue(fixture.mcpUrl);
    expect(page.url()).toBe(standaloneURL); expect(mutations).toEqual([]);
    await screenshot('standalone-mcp-cancelled-scope-discards-nothing');
    await navigationDecision(() => setup.locator('#plugin-mcp-scope').selectOption('user'), 'accept');
    await expect(setup.locator('#plugin-mcp-scope')).toHaveValue('user'); await expect(form).toHaveCount(0);
    await setup.getByTestId('plugin-mcp-add-personal').click(); await expect(page.getByRole('dialog')).toHaveCount(1);
    await page.getByRole('dialog').getByRole('button', {name: en.settings.mcpConfig.cancel, exact: true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0); await page.getByTestId('plugin-extension-back').click(); await ready();
    await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue('canva');

    await openCatalog('en', {q: fixture.packageName}); await openRow('plugin', fixture.packageName);
    await page.getByTestId('package-detail-tab-connections').click();
    const continueMcp = requirementRow('Canva MCP').getByRole('button', {name: en.skills.workspace.setup.continueSetup, exact: true});
    await expect(continueMcp).toBeEnabled();
    const template = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/mcp-template'));
    await continueMcp.click(); await data<{template: CapabilityPackageMcpTemplate}>(await template, 'Actual declared package MCP template before guard test');
    setup = page.getByTestId('plugin-mcp-setup'); await expect(setup).toBeVisible();
    await setup.locator('#plugin-mcp-scope').selectOption(`team:${teamId}`);
    form = setup.getByTestId('shared-connection-create-form'); await expect(form).toBeVisible();
    const nestedName = `Canva unsaved Team ${fixture.nonce.slice(0, 10)}`;
    await form.locator('#shared-name').fill(nestedName); await form.locator('#shared-url').fill(fixture.mcpUrl);
    const nestedURL = page.url(), back = setup.locator('header').getByRole('button', {name: en.skills.workspace.setup.back, exact: true});
    await navigationDecision(() => back.click(), 'dismiss');
    await expect(setup).toBeVisible(); await expect(setup.locator('#plugin-mcp-scope')).toHaveValue(`team:${teamId}`);
    await expect(form.locator('#shared-name')).toHaveValue(nestedName); await expect(form.locator('#shared-url')).toHaveValue(fixture.mcpUrl);
    expect(page.url()).toBe(nestedURL); expect(mutations).toEqual([]);
    await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue(fixture.packageName);
    expect(new URL(page.url()).searchParams.get('resourceRef')).toBe(packageRef);
    await screenshot('package-mcp-cancelled-local-back-retains-shared-draft');
    await navigationDecision(() => back.click(), 'accept'); await expect(setup).toHaveCount(0); await expect(requirementRow('Canva MCP')).toBeVisible();
    await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue(fixture.packageName);
    expect(new URL(page.url()).searchParams.get('resourceRef')).toBe(packageRef); expect(new URL(page.url()).searchParams.get('task')).toBe('connections');
    expect(page.url()).toBe(nestedURL); expect(mutations).toEqual([]);
    const after = (await catalogue(admin, {types: 'mcp'})).map(item => item.id).sort(); expect(after).toEqual(before);
  } finally { page.off('request', observe); }
});

test('a package Composio requirement resumes the exact Plugin after real denial and approval; standalone MCP also authorizes through its real web flow', async () => {
  await openCatalog('en', { q: fixture.packageName }); await openRow('plugin', fixture.packageName);
  await page.getByTestId('package-detail-tab-connections').click();
  await requirementRow('Canva').getByRole('button', { name: en.skills.workspace.setup.continueSetup, exact: true }).click();
  await expect(page.getByTestId('plugin-integration-detail')).toBeVisible();
  const before = await readControl();
  await consent(() => page.getByTestId('plugin-integration-connect').click(), 'deny');
  await expect(page.getByTestId('package-requirements-setup')).toBeVisible();
  await expect(page.getByTestId('package-detail-title')).toHaveText(fixture.packageName);
  await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue(fixture.packageName);
  expect(new URL(page.url()).searchParams.get('resourceRef')).toBe(packageRef);
  expect(new URL(page.url()).searchParams.get('task')).toBe('connections');
  await requirementRow('Canva').getByRole('button', { name: en.skills.workspace.setup.continueSetup, exact: true }).click();
  await expect(page.getByTestId('plugin-integration-detail')).toBeVisible();
  const denied = await readControl(); expect(denied.counters.denials).toBe(before.counters.denials + 1);
  await expect(page.getByTestId('plugin-integration-connect')).toBeEnabled();
  await consent(() => page.getByTestId('plugin-integration-connect').click(), 'approve');
  await expect(page.getByTestId('package-requirements-setup')).toBeVisible();
  await expect(page.getByTestId('package-detail-title')).toHaveText(fixture.packageName);
  await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue(fixture.packageName);
  expect(new URL(page.url()).searchParams.get('resourceRef')).toBe(packageRef);
  expect(new URL(page.url()).searchParams.get('task')).toBe('connections');
  await screenshot('package-personal-composio-consent-resumed');
  const canva = (await catalogue(admin, { q: 'canva', types: 'integration' })).find(value => value.kind === 'integration' && value.toolkit.slug === 'canva');
  expect(canva?.kind).toBe('integration');
  const personal = canva?.kind === 'integration' ? canva.connections.filter(value => value.ownership.type === 'user' && value.authorization === 'authorized') : [];
  expect(personal).toHaveLength(1); expect(personal[0].health).toBe('unknown');
  expect(personal[0].profileId).toBeTruthy(); expect(personal[0].accountId).toBeTruthy();
  await openCatalog('en', { q: 'canva' }); await openRow('integration', 'Canva');
  await expect(page.getByTestId('plugin-integration-detail')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('extensionId')).toBe('composio:canva');
  await screenshot('personal-composio-authorized');
  await openCatalog('en', { q: 'Canva MCP' }); await openRow('mcp', 'Canva MCP');
  await consent(() => page.getByTestId('plugin-mcp-authorize').click(), 'deny', 'popup');
  await expect(page.getByTestId('plugin-mcp-authorize')).toBeEnabled();
  await consent(() => page.getByTestId('plugin-mcp-authorize').click(), 'approve', 'popup');
  // Finish the real client poll and refreshed detail before exercising the guarded Back action.
  await expect(page.getByTestId('plugin-mcp-authorize')).toBeEnabled();
  await page.getByTestId('plugin-extension-back').click(); await ready();
  await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue('Canva MCP');
  expect(new URL(page.url()).searchParams.get('q')).toBe('Canva MCP');
  expect(new URL(page.url()).searchParams.has('extensionId')).toBe(false);
  const servers = await catalogue(admin, { q: 'Canva MCP', types: 'mcp' });
  expect(servers.some(value => value.kind === 'mcp' && value.connections.some(connection => connection.authorization === 'authorized'))).toBe(true);
  expect((await readControl()).counters.approvals).toBe(before.counters.approvals + 1);
});

test('manifest-only package OAuth creates a shared MCP and retains its exact chosen reference after refresh and actual consent', async () => {
  await openCatalog('en', {q: fixture.packageName}); await openRow('plugin', fixture.packageName);
  await page.getByTestId('package-detail-tab-connections').click();
  const templateResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/mcp-template'));
  await requirementRow('Canva MCP').getByRole('button', {name: en.skills.workspace.setup.continueSetup, exact: true}).click();
  const template = (await data<{template: CapabilityPackageMcpTemplate}>(await templateResponse, 'Actual manifest-only shared MCP requirement')).template;
  expect(template.connector.oauth).toBe(true); expect(template.config?.auth).toBeUndefined(); expect(template.config?.url).toBe(fixture.mcpUrl);
  const setup = page.getByTestId('plugin-mcp-setup'); await setup.locator('#plugin-mcp-scope').selectOption('organization');
  const form = setup.getByTestId('shared-connection-create-form'); await expect(form).toBeVisible();
  await expect(form.getByRole('checkbox', {name: en.sharedConnections.oauth, exact: true})).toBeChecked();
  await expect(form.locator('#shared-token')).toHaveCount(0); await expect(form.locator('#shared-url')).toHaveValue(fixture.mcpUrl);
  await form.locator('#shared-name').fill(`Package shared ${fixture.nonce.slice(0, 10)}`);
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/integrations/shared-connections' && response.request().method() === 'POST');
  const refreshed = searchResponse(page, {q: fixture.packageName});
  await form.getByRole('button', {name: en.sharedConnections.create, exact: true}).click();
  const createResponse = await created;
  expect(createResponse.request().postDataJSON()?.config?.auth).toBe('oauth');
  const connection = (await data<{connection: IntegrationConnectionDescriptor}>(createResponse, 'Actual packaged shared OAuth connection creation')).connection;
  packagedSharedMcpRef = connection.resource.connectionRef; expect(connection.resource.source).toBe('mcp'); expect(connection.resource.ownership.type).toBe('organization');
  await data<PluginExtensionSearchResponse>(await refreshed, 'Actual common catalogue refresh after packaged shared MCP creation');
  await expect(setup).toHaveCount(0);
  const selected = requirementRow('Canva MCP').locator('select[data-testid^="package-requirement-connection-"]');
  await expect(selected).toHaveValue(packagedSharedMcpRef);
  await screenshot('package-shared-created-exact-ref-after-refresh');
  await requirementRow('Canva MCP').getByRole('button', {name: en.skills.workspace.setup.manage, exact: true}).click();
  await expect(page.getByTestId('shared-connection-editor')).toBeVisible();
  await consent(() => page.getByTestId('shared-connection-authorize').click(), 'approve');
  await expect(page.getByTestId('package-requirements-setup')).toBeVisible();
  await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue(fixture.packageName);
  expect(new URL(page.url()).searchParams.get('resourceRef')).toBe(packageRef);
  expect(new URL(page.url()).searchParams.get('connectionRef')).toBe(packagedSharedMcpRef);
  expect(new URL(page.url()).searchParams.get('sharedOAuth')).toBe('connected');
  await expect(requirementRow('Canva MCP').locator('select[data-testid^="package-requirement-connection-"]')).toHaveValue(packagedSharedMcpRef);
  const status = await data<{configured: boolean; authorized: boolean}>(await admin.request.get(
    `/api/mcp/shared-connections/${encodeURIComponent(packagedSharedMcpRef)}/oauth?workspaceId=${encodeURIComponent(personalId)}`), 'Exact packaged shared MCP actual OAuth read-back');
  expect(status.configured).toBe(true); expect(status.authorized).toBe(true);
  await screenshot('package-shared-oauth-return-retains-exact-choice');
});

test('standalone shared Composio setup preserves Organization and Team instances through real consent, with use and manage independent', async () => {
  for (const scope of ['organization', 'team'] as const) {
    await openCatalog('en', { q: 'canva' }); await openRow('integration', 'Canva');
    await page.getByTestId('plugin-integration-new-shared').click();
    const form = page.getByTestId('shared-connection-create-form'); await expect(form).toBeVisible();
    await form.locator('#shared-owner').selectOption({ label: scope === 'organization' ? en.sharedConnections.organization
      : `${en.sharedConnections.team} · Extension team ${fixture.nonce.slice(0, 10)}` });
    await expect(form.getByText('canva', { exact: true })).toBeVisible();
    const name = `Canva ${scope} ${fixture.nonce.slice(0, 10)}`; await form.locator('#shared-name').fill(name);
    await form.getByText(en.sharedConnections.newProfile, { exact: true }).click();
    await form.locator('#shared-profile-name').fill(`Canva ${scope} profile ${fixture.nonce.slice(0, 10)}`);
    await form.locator('#shared-profile-mode').selectOption('local');
    const profile = page.waitForResponse(value => new URL(value.url()).pathname === '/api/composio/shared-profiles' && value.request().method() === 'POST');
    await form.getByRole('button', { name: en.sharedConnections.createProfile, exact: true }).click(); await data<unknown>(await profile, 'Actual scoped shared profile creation');
    const created = page.waitForResponse(value => new URL(value.url()).pathname === '/api/integrations/shared-connections' && value.request().method() === 'POST');
    await form.getByRole('button', { name: en.sharedConnections.create, exact: true }).click();
    let connection = (await data<{ connection: IntegrationConnectionDescriptor }>(await created, 'Actual standalone shared Composio resource')).connection;
    expect(connection.resource.ownership.type).toBe(scope); expect(connection.resource.application).toBe('canva');
    if (connection.resource.ownership.type === 'team') expect(connection.resource.ownership.workspaceId).toBe(teamId);
    await expect(page.getByTestId('shared-connection-editor')).toBeVisible();
    await expect(page.locator('#plugin-integration-account')).toHaveValue(connection.resource.connectionRef);
    if (scope === 'team') {
      await consent(() => page.getByTestId('shared-connection-authorize').click(), 'deny');
      await expect(page.getByTestId('shared-connection-authorize')).toBeEnabled();
    }
    await consent(() => page.getByTestId('shared-connection-authorize').click(), 'approve');
    await expect(page.getByTestId('plugin-integration-detail')).toBeVisible();
    await expect(page.locator('#plugin-integration-account')).toHaveValue(connection.resource.connectionRef);
    await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue('canva');
    const endpoint = `/api/integrations/shared-connections/${encodeURIComponent(connection.resource.connectionRef)}?workspaceId=${encodeURIComponent(scope === 'team' ? teamId : personalId)}`;
    connection = (await data<{ connection: IntegrationConnectionDescriptor }>(await admin.request.get(endpoint), 'Actual exact shared resource after callback')).connection;
    const granted = (await data<{ connection: IntegrationConnectionDescriptor }>(await admin.request.patch(endpoint, { data: {
      expectedMetadataRevision: connection.resource.metadataRevision, expectedGrantsRevision: connection.resource.grantsRevision,
      expectedBindingRevision: connection.resource.bindingRevision,
      grants: [{ targetType: 'user', targetId: fixture.actorId, canUse: true, canManage: true, allowedToolNames: null },
        { targetType: 'user', targetId: memberId, canUse: true, canManage: false, allowedToolNames: null }],
    } }), 'Actual current shared resource grants')).connection;
    sharedConnections.push(granted);
    await screenshot(`shared-composio-${scope}-consent-return`);
  }
  const app = (await catalogue(admin, { q: 'canva', types: 'integration' })).find(value => value.kind === 'integration' && value.toolkit.slug === 'canva');
  expect(app?.kind).toBe('integration');
  const connections = app?.kind === 'integration' ? app.connections : [];
  expect(new Set(connections.map(value => value.connectionRef)).size).toBe(connections.length);
  for (const shared of sharedConnections) expect(connections.some(value => value.connectionRef === shared.resource.connectionRef)).toBe(true);
  expect(connections.some(value => value.ownership.type === 'user')).toBe(true);
});

test('standalone shared MCP setup uses real OAuth and the exact template matcher respects ordinary member use, privacy, and revocation', async () => {
  await openCatalog(); await page.getByTestId('plugin-extension-add-mcp').click();
  const setup = page.getByTestId('plugin-mcp-setup'); await expect(setup).toBeVisible();
  await setup.locator('#plugin-mcp-scope').selectOption('organization');
  const form = setup.getByTestId('shared-connection-create-form'); await expect(form).toBeVisible();
  const name = `Shared local MCP ${fixture.nonce.slice(0, 10)}`;
  await form.locator('#shared-name').fill(name); await form.locator('#shared-url').fill(fixture.mcpUrl);
  await form.getByRole('checkbox', { name: en.sharedConnections.oauth, exact: true }).check();
  const created = page.waitForResponse(value => new URL(value.url()).pathname === '/api/integrations/shared-connections' && value.request().method() === 'POST');
  await form.getByRole('button', { name: en.sharedConnections.create, exact: true }).click();
  let connection = (await data<{ connection: IntegrationConnectionDescriptor }>(await created, 'Actual standalone shared MCP creation')).connection;
  expect(connection.resource.ownership.type).toBe('organization'); expect(connection.resource.source).toBe('mcp'); sharedMcpRef = connection.resource.connectionRef;
  await expect(page.getByTestId('plugin-integration-detail')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('extensionId')).toBe(sharedMcpRef);
  await consent(() => page.getByTestId('shared-connection-authorize').click(), 'deny');
  await expect(page.getByTestId('shared-connection-authorize')).toBeEnabled();
  expect(new URL(page.url()).searchParams.get('extensionId')).toBe(sharedMcpRef);
  await consent(() => page.getByTestId('shared-connection-authorize').click(), 'approve');
  await expect(page.getByTestId('plugin-integration-detail')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('extensionId')).toBe(sharedMcpRef);
  const endpoint = `/api/integrations/shared-connections/${encodeURIComponent(sharedMcpRef)}?workspaceId=${encodeURIComponent(personalId)}`;
  connection = (await data<{ connection: IntegrationConnectionDescriptor }>(await admin.request.get(endpoint), 'Current actual shared MCP after OAuth')).connection;
  connection = (await data<{ connection: IntegrationConnectionDescriptor }>(await admin.request.patch(endpoint, { data: {
    expectedMetadataRevision: connection.resource.metadataRevision, expectedGrantsRevision: connection.resource.grantsRevision,
    expectedBindingRevision: connection.resource.bindingRevision,
    grants: [{ targetType: 'user', targetId: fixture.actorId, canUse: true, canManage: true, allowedToolNames: null },
      { targetType: 'user', targetId: memberId, canUse: true, canManage: false, allowedToolNames: null }],
  } }), 'Real shared MCP use without management grant')).connection;
  const source = fixture.sources.find(value => value.kind === 'plugin'); expect(source).toBeDefined();
  const installed = await data<CapabilityPackageStoreApplicationResult>(await member.request.post(
    `/api/capabilities/packages/store/install?workspaceId=${encodeURIComponent(memberPersonalId)}`, { data: { source, ownership: { type: 'user' }, grants: [] } }), 'Actual ordinary member package fixture from real HTTP source');
  memberPackageRef = installed.resource.resourceRef;
  const matcher = `/api/capabilities/packages/${encodeURIComponent(memberPackageRef)}/mcp-matches?${new URLSearchParams({
    workspaceId: memberPersonalId, connector: 'Canva MCP', expectedChecksum: installed.published.checksum,
  })}`;
  const matches = await data<CapabilityPackageMcpMatches>(await member.request.get(matcher), 'Real exact MCP compatibility for use-only member');
  expect(matches.matches).toContainEqual({ connectionRef: sharedMcpRef, compatibility: 'endpoint' });
  expect(matches.coverage).toBe('complete');
  for (const match of matches.matches) expect(Object.keys(match).sort()).toEqual(['compatibility', 'connectionRef']);
  const serialized = JSON.stringify(matches); expect(serialized).not.toContain(fixture.mcpUrl); expect(serialized).not.toMatch(/backend|connectionId|oauth|token|config/iu);
  const memberPage = await member.newPage();
  try {
    await openCatalog('de', { q: name }, memberPage, memberPersonalId); await openRow('mcp', name, memberPage);
    await expect(memberPage.getByTestId('shared-connection-authorize')).toHaveCount(0);
    await screenshot('member-shared-mcp-use-without-manage', memberPage);
  } finally { await memberPage.close(); }
  await screenshot('shared-mcp-real-consent-return');
  await data<unknown>(await admin.request.patch(endpoint, { data: {
    expectedMetadataRevision: connection.resource.metadataRevision, expectedGrantsRevision: connection.resource.grantsRevision,
    expectedBindingRevision: connection.resource.bindingRevision,
    grants: [{ targetType: 'user', targetId: fixture.actorId, canUse: true, canManage: true, allowedToolNames: null }],
  } }), 'Actual shared MCP member revocation');
  const revoked = await data<CapabilityPackageMcpMatches>(await member.request.get(matcher), 'Fresh exact MCP matcher after revocation');
  expect(revoked.matches.some(value => value.connectionRef === sharedMcpRef)).toBe(false);
  expect((await member.request.get(`/api/integrations/shared-connections/${encodeURIComponent(sharedMcpRef)}?workspaceId=${encodeURIComponent(memberPersonalId)}`)).status()).toBe(404);
});

test('ordinary member sees exact shared instances without management, private backend identities, or hidden personal accounts; revocation removes access', async () => {
  const memberPage = await member.newPage();
  try {
    const listing = await catalogue(member, { q: 'canva', types: 'integration' }, memberPersonalId);
    const app = listing.find(value => value.kind === 'integration' && value.toolkit.slug === 'canva'); expect(app?.kind).toBe('integration');
    const connections = app?.kind === 'integration' ? app.connections : [];
    for (const shared of sharedConnections) {
      const current = connections.find(value => value.connectionRef === shared.resource.connectionRef);
      expect(current?.access).toEqual({ canRead: true, canUse: true, canManage: false });
      expect(current).not.toHaveProperty('profileId'); expect(current).not.toHaveProperty('accountId');
    }
    expect(connections.some(value => value.ownership.type === 'user' && value.ownership.ownerUserId === fixture.actorId)).toBe(false);
    await openCatalog('de', { q: 'canva' }, memberPage, memberPersonalId); await openRow('integration', 'Canva', memberPage);
    await expect(memberPage.getByTestId('shared-connection-authorize')).toHaveCount(0);
    await screenshot('member-shared-canva-read-use-without-manage', memberPage);
    const team = sharedConnections.find(value => value.resource.ownership.type === 'team')!;
    const endpoint = `/api/integrations/shared-connections/${encodeURIComponent(team.resource.connectionRef)}?workspaceId=${encodeURIComponent(teamId)}`;
    const denied = await member.request.patch(endpoint, { data: { expectedMetadataRevision: team.resource.metadataRevision,
      expectedGrantsRevision: team.resource.grantsRevision, expectedBindingRevision: team.resource.bindingRevision, metadata: { displayName: 'Forbidden rename' } } });
    expect(denied.status()).toBe(403);
    const revoked = (await data<{ connection: IntegrationConnectionDescriptor }>(await admin.request.patch(endpoint, { data: {
      expectedMetadataRevision: team.resource.metadataRevision, expectedGrantsRevision: team.resource.grantsRevision,
      expectedBindingRevision: team.resource.bindingRevision,
      grants: [{ targetType: 'user', targetId: fixture.actorId, canUse: true, canManage: true, allowedToolNames: null }],
    } }), 'Actual shared access revocation')).connection;
    sharedConnections[sharedConnections.indexOf(team)] = revoked;
    expect((await member.request.get(endpoint)).status()).toBe(404);
    const remaining = (await catalogue(member, { q: 'canva', types: 'integration' }, memberPersonalId)).find(value => value.kind === 'integration' && value.toolkit.slug === 'canva');
    expect(remaining?.kind === 'integration' && remaining.connections.some(value => value.connectionRef === team.resource.connectionRef)).toBe(false);
    await openCatalog('de', { q: 'canva' }, memberPage, memberPersonalId); await openRow('integration', 'Canva', memberPage);
    await expect(memberPage.getByText(team.resource.displayName, { exact: true })).toHaveCount(0);
    await screenshot('member-revoked-team-connection-hidden', memberPage);
  } finally { await memberPage.close(); }
});

test('installed package setup reuses exact existing connections and keeps optional Github separate; contained skill keeps Plugin provenance', async () => {
  const before = await catalogue(admin, { types: 'mcp,integration' });
  await openCatalog('en', { q: fixture.packageName }); await openRow('plugin', fixture.packageName);
  await page.getByTestId('package-detail-tab-connections').click(); await expect(page.getByTestId('package-requirements-setup')).toBeVisible();
  const presentation = (await data<{ presentation: CapabilityPackagePresentation }>(await admin.request.get(
    `/api/capabilities/packages/${encodeURIComponent(packageRef)}/presentation?workspaceId=${encodeURIComponent(personalId)}`), 'Current exact package requirements')).presentation;
  for (const requirement of presentation.requirements) {
    if (!requirement.required || !requirement.selector) continue;
    const control = requirementRow(requirement.label).locator('select[data-testid^="package-requirement-connection-"]'); await expect(control).toBeVisible();
    const available = await control.locator('option').evaluateAll(options => options.map(value => ({ value: (value as HTMLOptionElement).value, disabled: (value as HTMLOptionElement).disabled })));
    const candidates = available.filter(value => value.value && !value.disabled); expect(candidates.length).toBeGreaterThan(0);
    await control.selectOption(candidates[0].value);
  }
  await expect(page.getByTestId('package-optional-requirements')).toBeVisible(); await screenshot('package-existing-connections-reused');
  const after = await catalogue(admin, { types: 'mcp,integration' });
  const ids = (values: PluginExtensionItem[]) => values.flatMap(value => value.kind === 'integration' || value.kind === 'mcp' ? value.connections.map(connection => connection.connectionRef) : []).sort();
  expect(ids(after)).toEqual(ids(before));
  const child = (await catalogue(admin, { q: `${fixture.packageName}-context`, types: 'skill' })).find(value => value.kind === 'skill' && value.package?.parentResourceRef === packageRef);
  expect(child?.kind).toBe('skill');
  await openCatalog('en', { q: `${fixture.packageName}-context`, types: 'skill' }); await openRow('skill', `${fixture.packageName}-context`);
  await expect(page.getByTestId('package-detail-parent')).toBeVisible();
  const childIcon = page.getByTestId('package-detail-workspace').locator('header').getByTestId('plugin-extension-avatar-image');
  await expect(childIcon).toBeVisible();
  await expect.poll(() => childIcon.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0),
    { message: 'Contained skill loads its own exact authorized local icon.' }).toBe(true);
  expect((await catalogue(admin, { q: fixture.skillName, types: 'skill' })).some(value => value.id === skillRef)).toBe(true);
});

test('optional Agent setup opens the real manager and saves the exact published Plugin version on an editable Agent', async () => {
  const created = await data<{ agent: { agentId: string; revision: number }; access: { canEdit: boolean } }>(
    await admin.request.post(`/api/agents?workspaceId=${encodeURIComponent(personalId)}`, { data: {
      name: `Extension Agent ${fixture.nonce.slice(0, 10)}`, scopeType: 'user', enabledTools: [],
    } }), 'Actual editable Agent fixture');
  expect(created.access.canEdit).toBe(true); agentId = created.agent.agentId;
  const endpoint = `/api/agents/workflow?${new URLSearchParams({ view: 'management', agentId, workspaceId: personalId })}`;
  const initial = await data<AgentWorkflowManagement>(await admin.request.get(endpoint), 'Current actual Agent management snapshot');
  expect(initial.access.canEdit).toBe(true); expect(initial.configurationState).toBe('legacy');
  await openCatalog('en', { q: fixture.packageName }); await openRow('plugin', fixture.packageName);
  await page.getByTestId('package-detail-tab-connections').click();
  const setup = page.getByTestId('package-agent-setup'); await expect(setup).toHaveAttribute('data-resource-ref', packageRef);
  await expect(page.getByTestId('package-agent-setup-expand')).toHaveAttribute('aria-expanded', 'false');
  const configured = page.waitForResponse(response => {
    const url = new URL(response.url()); return url.pathname === '/api/agents' && url.searchParams.get('purpose') === 'configure'
      && url.searchParams.get('workspaceId') === personalId;
  });
  await page.getByTestId('package-agent-setup-expand').click();
  const choices = await data<{ agents: Array<{ agentId: string; type: string; access: { canEdit: boolean } }> }>(await configured, 'Actual editable Agent choices');
  expect(choices.agents.some(value => value.agentId === agentId && value.access.canEdit)).toBe(true);
  const selection = page.getByTestId('package-agent-setup-select');
  if (choices.agents.filter(value => value.type !== 'main' && value.access.canEdit).length > 1) {
    await expect(selection).toBeVisible(); await selection.selectOption(agentId);
  }
  await page.getByTestId('package-agent-setup-open').click();
  const manager = page.getByTestId('agent-workflow-management-dialog'); await expect(manager).toBeVisible();
  await manager.getByRole('button', { name: en.agentWorkflowManagement.legacy.configure, exact: true }).click();
  await manager.getByRole('button', { name: en.agentWorkflowManagement.packages.add, exact: true }).click();
  const packageSearch = manager.getByRole('textbox', { name: en.agentWorkflowManagement.packages.search, exact: true });
  await packageSearch.fill(fixture.packageName);
  await manager.getByRole('button', { name: en.agentWorkflowManagement.search, exact: true }).click();
  const version = manager.getByRole('combobox', { name: en.agentWorkflowManagement.packages.versionFor.replace('{name}', fixture.packageName), exact: true });
  await expect(version).toBeVisible(); await version.selectOption(packagePin.revisionRef);
  await manager.getByRole('button', { name: en.agentWorkflowManagement.packages.addSelected, exact: true }).click();
  await expect(manager.getByTestId('workflow-management-package')).toContainText(fixture.packageName);
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agents'
    && response.request().method() === 'PATCH' && response.request().postDataJSON()?.agentId === agentId);
  await manager.getByTestId('workflow-management-save').click();
  const result = await data<AgentWorkflowManagementSaveResult>(await saved, 'Actual CAS workflow save through Plugin setup');
  expect(result.agent.agentId).toBe(agentId); expect(result.agent.revision).toBe(initial.revision + 1);
  expect(result.agent.workflowRevision).toBe(initial.workflowRevision + 1);
  const current = await data<AgentWorkflowManagement>(await admin.request.get(endpoint), 'Persisted exact Agent workflow read-back');
  expect(current.configurationState).toBe('available'); expect(current.workflowVersion).toBe(1);
  expect(current.configuration?.packages).toEqual([{ resourceRef: packageRef, publishedRevisionRef: packagePin.revisionRef,
    checksum: packagePin.checksum, skillSelection: { kind: 'plugin' }, declarations: [] }]);
  expect(current.unavailablePackageCount).toBe(0); expect(current.unavailableConnectionCount).toBe(0);
  await expect(manager.getByTestId('workflow-management-save')).toBeDisabled(); await screenshot('plugin-actual-agent-published-workflow');
  await manager.getByRole('button', { name: en.agentWorkflowManagement.close, exact: true }).click();
  await expect(page.getByTestId('package-agent-setup-open')).toBeFocused();
  await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue(fixture.packageName);
});

test('a real upstream Store outage keeps MCP and Composio results, shows incomplete coverage, and recovers by Retry', async () => {
  await registryStatus(503);
  try {
    const result = await openCatalog('en', { q: 'canva' });
    expect(result.coverage.find(value => value.source === 'store')?.status).toMatch(/partial|unavailable/u);
    expect(result.items.some(value => value.kind === 'integration')).toBe(true); expect(result.items.some(value => value.kind === 'mcp')).toBe(true);
    await expect(page.getByTestId('plugin-extension-coverage')).toBeVisible(); await expect(exactRow('mcp', 'Canva MCP')).toBeVisible();
    await screenshot('partial-upstream-store'); await registryStatus(200);
    const retried = searchResponse(page, { q: 'canva' }); await page.getByTestId('plugin-extension-retry').click();
    const recovered = await data<PluginExtensionSearchResponse>(await retried, 'Actual recovered catalogue');
    expect(recovered.coverage.find(value => value.source === 'store')?.status).toBe('complete'); await ready();
    await expect(exactRow('plugin', fixture.packageName)).toBeVisible();
  } finally { await registryStatus(200); }
});

test('English and German desktop/mobile light/dark catalogue keeps one query and accessible filters without overflow', async () => {
  for (const locale of ['en', 'de'] as const) for (const [width, theme] of [[1280, 'light'], [390, 'dark']] as const) {
    await page.setViewportSize({ width, height: 900 });
    await openCatalog(locale, { q: 'canva' }); await page.evaluate(value => localStorage.setItem('theme', value), theme);
    const reloaded = searchResponse(page, { q: 'canva' }); await page.reload({ waitUntil: 'domcontentloaded' }); await data<unknown>(await reloaded, 'Actual locale/theme catalogue'); await ready();
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/u : /\blight\b/u);
    await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue('canva');
    await expectLoadedPackageIcon(exactRow('plugin', fixture.packageName).getByTestId('plugin-extension-avatar'), packageRef);
    await expectLoadedPackageIcon(exactRow('skill', fixture.skillName).getByTestId('plugin-extension-avatar'), skillRef);
    await expect(exactRow('integration', 'Canva').getByTestId('plugin-extension-avatar-initials')).toHaveText('CA');
    await screenshot(`${locale}-${width}-${theme}-catalogue-all-types`);
    const filteredResponse = searchResponse(page, {q: 'canva', types: 'integration'});
    await page.getByTestId('plugin-extension-kind-integration').focus(); await page.keyboard.press('Enter');
    const filtered = await data<PluginExtensionSearchResponse>(await filteredResponse, 'Actual settled locale/viewport integration filter');
    expect(filtered.items.some(item => item.kind === 'integration' && item.toolkit.slug === 'canva')).toBe(true);
    expect(filtered.items.every(item => item.kind === 'integration')).toBe(true); await ready();
    await expect(page.getByTestId('plugin-extension-kind-integration')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue('canva');
    await page.getByTestId('plugin-extension-filter-toggle').click(); await expect(page.getByTestId('plugin-extension-filter-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('plugin-extension-stock-filter')).toBeVisible(); await expect(page.getByTestId('plugin-extension-source-filter')).toBeVisible();
    await expect(exactRow('integration', 'Canva')).toHaveCount(1); await expect(exactRow('integration', 'Canva')).toBeVisible();
    await expect(page.locator('[data-testid="plugin-extension-row"]:not([data-kind="integration"])')).toHaveCount(0);
    await expect(exactRow('integration', 'Canva').getByTestId('plugin-extension-avatar-initials')).toHaveText('CA');
    await expect(exactRow('integration', 'Canva').getByTestId('plugin-extension-avatar-image')).toHaveCount(0);
    await screenshot(`${locale}-${width}-${theme}-catalogue`);
    const source = locales[locale].skills.workspace.shell.title; expect(source).toBeTruthy();
    if (width === 390) {
      await openCatalog(locale, { q: fixture.packageName }); await openRow('plugin', fixture.packageName);
      await expectLoadedPackageIcon(page.getByTestId('package-detail-workspace').locator('header').getByTestId('plugin-extension-avatar'), packageRef);
      await page.getByTestId('package-detail-tab-connections').click(); await expect(page.getByTestId('package-requirements-setup')).toBeVisible();
      await screenshot(`${locale}-${width}-${theme}-package-setup`);
      await openCatalog(locale); await page.getByTestId('plugin-extension-add-mcp').click();
      await expect(page.getByTestId('plugin-mcp-setup')).toBeVisible(); await screenshot(`${locale}-${width}-${theme}-standalone-mcp-setup`);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('Settings creates and applies a personal profile, opens the common integration catalogue in that workspace, and restores the exact original profile', async () => {
  type EffectiveProfile = {id: string; name: string; source: 'default' | 'workspace_override'; workspaceId: string; isDefault: boolean};
  type Profiles = {success: boolean; profiles: Array<{id: string; name: string; isDefault: boolean; status: string}>;
    effectiveProfile: EffectiveProfile; workspace: {id: string}};
  type Status = {configured: boolean; effectiveProfile: EffectiveProfile; workspace: {id: string}; connectedAccounts: Array<{id: string}>};
  const headers = {'x-canvas-workspace-id': personalId};
  const initial = await json<Profiles>(await admin.request.get('/api/composio/profiles', {headers}), 'Original actual personal profile context');
  expect(initial.success).toBe(true); expect(initial.workspace.id).toBe(personalId);
  const original = initial.profiles.find(profile => profile.id === initial.effectiveProfile.id);
  expect(original?.status).toBe('active');
  const initialStatus = await json<Status>(await admin.request.get('/api/composio/status', {headers}), 'Original actual runtime Composio context');
  expect(initialStatus.effectiveProfile.id).toBe(initial.effectiveProfile.id); expect(initialStatus.workspace.id).toBe(personalId);
  const initialCanva = (await catalogue(admin, {q: 'canva', types: 'integration'})).find(item => item.kind === 'integration' && item.toolkit.slug === 'canva');
  if (!initialCanva || initialCanva.kind !== 'integration') throw new Error('The actual Canva offering is required for Settings acceptance.');
  const personalAccounts = initialCanva.connections.filter(connection => connection.ownership.type === 'user');
  expect(personalAccounts.some(connection => connection.profileId === original!.id && connection.authorization === 'authorized')).toBe(true);
  const settingsURL = `/en/settings?${new URLSearchParams({tab: 'integrations', section: 'composio', workspaceId: personalId})}`;
  const statusResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/composio/status'
    && response.request().method() === 'GET' && response.request().headers()['x-canvas-workspace-id'] === personalId);
  await page.setViewportSize({width: 1280, height: 900}); await page.evaluate(() => localStorage.setItem('theme', 'light'));
  const settingsStatus = statusResponse(); await page.goto(settingsURL, {waitUntil: 'domcontentloaded'});
  expect((await json<Status>(await settingsStatus, 'Real Settings Composio card context')).effectiveProfile.id).toBe(original!.id);
  const profileContext = page.getByTestId('composio-profile-context');
  await expect(profileContext.getByRole('heading', {name: original!.name, exact: true})).toBeVisible();
  await expect(page.getByTestId('composio-open-catalog')).toBeVisible();
  await page.getByTestId('composio-change-profile').click();
  let dialog = page.getByRole('dialog'); await expect(dialog.getByTestId('composio-profile-list')).toBeVisible();
  await dialog.getByRole('button', {name: en.settings.connectedApps.profiles.create, exact: true}).click();
  const profileName = `Settings profile ${fixture.nonce.slice(0, 10)}`; await dialog.locator('#composio-profile-name').fill(profileName);
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/composio/profiles'
    && response.request().method() === 'POST' && response.request().postDataJSON()?.name === profileName);
  const appliedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/composio/workspace-profile'
    && response.request().method() === 'PUT' && response.request().postDataJSON()?.workspaceId === personalId);
  const changedStatus = statusResponse();
  await dialog.getByRole('button', {name: en.settings.connectedApps.profiles.createAndUse, exact: true}).click();
  const created = await json<{success: boolean; profile: {id: string; name: string}}>(await createdResponse, 'Actual Settings profile creation', 201);
  expect(created.success).toBe(true); expect(created.profile.name).toBe(profileName); expect(created.profile.id).not.toBe(original!.id);
  const applied = await json<{success: boolean; effectiveProfile: EffectiveProfile}>(await appliedResponse, 'Actual Settings profile application');
  expect(applied.success).toBe(true); expect(applied.effectiveProfile).toMatchObject({id: created.profile.id, workspaceId: personalId, source: 'workspace_override'});
  const newStatus = await json<Status>(await changedStatus, 'Actual Settings runtime context after profile application');
  expect(newStatus.effectiveProfile.id).toBe(created.profile.id); expect(newStatus.workspace.id).toBe(personalId); expect(newStatus.connectedAccounts).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(profileContext.getByRole('heading', {name: profileName, exact: true})).toBeVisible();
  const current = await json<Profiles>(await admin.request.get('/api/composio/profiles', {headers}), 'Fresh persisted workspace profile read-back');
  expect(current.effectiveProfile.id).toBe(created.profile.id); expect(current.profiles.some(profile => profile.id === original!.id && profile.status === 'active')).toBe(true);
  await screenshot('settings-created-profile-current-context');

  const link = page.getByTestId('composio-open-catalog'), hrefValue = await link.getAttribute('href'); expect(hrefValue).toBeTruthy();
  const destination = new URL(hrefValue!, fixture.baseURL);
  expect(destination.origin).toBe(fixture.baseURL); expect(destination.pathname).toBe('/en/plugins');
  expect(destination.searchParams.get('view')).toBe('browse'); expect(destination.searchParams.get('kind')).toBe('integration');
  expect(destination.searchParams.get('workspaceId')).toBe(personalId);
  const catalogueResponse = searchResponse(page, {workspaceId: personalId, types: 'integration'});
  await link.click(); const entered = await data<PluginExtensionSearchResponse>(await catalogueResponse, 'Real Settings link enters shared catalogue');
  expect(entered.items.every(item => item.kind === 'integration')).toBe(true); await ready();
  await expect(page.getByTestId('plugin-extension-kind-integration')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('searchbox')).toHaveCount(1); await expect(page.getByTestId('plugin-extension-search-input')).toHaveValue('');
  expect(new URL(page.url()).searchParams.get('workspaceId')).toBe(personalId);
  const searched = await search('canva'), canva = searched.items.find(item => item.kind === 'integration' && item.toolkit.slug === 'canva');
  if (!canva || canva.kind !== 'integration') throw new Error('The real common search must preserve the Canva offering after profile switch.');
  expect(canva.connections.filter(connection => connection.ownership.type === 'user').map(connection => connection.connectionRef).sort())
    .toEqual(personalAccounts.map(connection => connection.connectionRef).sort());
  expect(canva.connections.some(connection => connection.ownership.type === 'user' && connection.profileId === created.profile.id)).toBe(false);
  await openRow('integration', 'Canva');
  const profileSelect = page.locator('#plugin-integration-profile'); await expect(profileSelect).toHaveValue(created.profile.id);
  await expect(profileSelect.locator('option', {hasText: `${profileName} · ${en.skills.workspace.setup.currentProfile}`})).toHaveCount(1);
  const previousAccount = personalAccounts.find(connection => connection.profileId === original!.id && connection.authorization === 'authorized')!;
  const accountSelect = page.locator('#plugin-integration-account'); await expect(accountSelect).toBeVisible();
  await expect(accountSelect.locator(`option[value="${previousAccount.connectionRef}"]`)).toHaveCount(1);
  await screenshot('settings-common-catalogue-current-profile-separate-accounts');
  await accountSelect.selectOption(previousAccount.connectionRef); await expect(profileSelect).toHaveValue(original!.id);
  await expect(page.getByText(en.skills.workspace.setup.profileChangedHint, {exact: true})).toBeVisible();
  const unchanged = await json<Status>(await admin.request.get('/api/composio/status', {headers}), 'Choosing an existing account does not apply its profile');
  expect(unchanged.effectiveProfile.id).toBe(created.profile.id); expect(unchanged.connectedAccounts).toEqual([]);

  const beforeRestore = statusResponse(); await page.goto(settingsURL, {waitUntil: 'domcontentloaded'});
  expect((await json<Status>(await beforeRestore, 'Actual Settings retains current profile before restore')).effectiveProfile.id).toBe(created.profile.id);
  await expect(profileContext.getByRole('heading', {name: profileName, exact: true})).toBeVisible();
  await page.getByTestId('composio-change-profile').click(); dialog = page.getByRole('dialog');
  const restoreResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/composio/workspace-profile'
    && response.request().method() === (original!.isDefault ? 'DELETE' : 'PUT'));
  const restoredStatus = statusResponse(); await dialog.getByTestId(`composio-profile-option-${original!.id}`).click();
  const restored = await json<{success: boolean; effectiveProfile: EffectiveProfile}>(await restoreResponse, 'Actual GUI restores exact original profile');
  expect(restored.success).toBe(true); expect(restored.effectiveProfile).toMatchObject({id: original!.id, workspaceId: personalId, source: initial.effectiveProfile.source});
  const restoredRuntime = await json<Status>(await restoredStatus, 'Actual runtime profile and accounts restored');
  expect(restoredRuntime.effectiveProfile.id).toBe(original!.id);
  expect(restoredRuntime.connectedAccounts.map(account => account.id).sort()).toEqual(initialStatus.connectedAccounts.map(account => account.id).sort());
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(profileContext.getByRole('heading', {name: original!.name, exact: true})).toBeVisible();
  const restoredCanva = (await catalogue(admin, {q: 'canva', types: 'integration'})).find(item => item.kind === 'integration' && item.toolkit.slug === 'canva');
  expect(restoredCanva?.kind === 'integration' ? restoredCanva.connections.filter(connection => connection.ownership.type === 'user').map(connection => connection.connectionRef).sort() : [])
    .toEqual(personalAccounts.map(connection => connection.connectionRef).sort());
  await screenshot('settings-original-profile-restored');
});
