import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Locator, type Page, type Response, type Route } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import { cleanupOwnedCapabilityPackageFixture, type OwnedCapabilityPackageFixture, type OwnedCapabilityPackageSourceDirectoryProof } from './helpers/capability-package-test-cleanup';
import { assertOwnedCapabilityPackageSourceDirectory } from './helpers/capability-package-cleanup-guards';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackageFileRead, CapabilityPackagePublishedSummary, CapabilityPackageState } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityPackageStoreApplicationResult, CapabilityPackageStoreSelection, CapabilityPackageStoreUpdateReview } from '../app/lib/capabilities/packages/store-contracts';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { PluginWorkspaceCatalogResponse } from '../app/lib/plugins/plugin-workspace-catalog-contracts';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';

type Fixture = { nonce: string; name: string; sourceDirectory: string; sources: CapabilityPackageStoreSelection[] };
type PublishedReceipt = Pick<CapabilityPackagePublishedSummary, 'resourceRef' | 'revisionRef' | 'checksum' | 'version'>;
type CompletedPublication = { state: CapabilityPackageState; published: PublishedReceipt };
type OwnCurrent = Pick<CapabilityPackageStoreApplicationResult, 'resource' | 'state'> & { published: PublishedReceipt };
let fixture: Fixture, admin: BrowserContext, member: BrowserContext, adminPage: Page, memberPage: Page, secondAdminPage: Page;
let adminId = '', memberId = '', memberName = '', memberEmail = '', workspaceId = '', memberWorkspaceId = '', organizationId = '', recovery = '', artifacts = '';
let receipt: OwnedCapabilityPackageFixture | undefined, current: OwnCurrent;
let sourceDirectoryProof: OwnedCapabilityPackageSourceDirectoryProof;
let outstanding: string | null = null;
const draftReceipts = new Map<string, { resourceRef: string; revision: number }>();
const releases = new Set<() => void>();
const unexpectedWrites: string[] = [];
const memberContentReads: string[] = [];
const labels = en.skills.workspace;
const pkg = '/api/capabilities/packages';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

async function data<T>(response: APIResponse | Response, phase: string): Promise<T> {
  if (response.status() !== 200) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  const body = await response.json() as { success?: boolean; data?: T };
  if (body.success !== true || body.data === undefined) throw new Error(`${phase} returned an invalid public envelope.`);
  return body.data;
}
async function saveRecovery() {
  const temp = `${recovery}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ fixture, receipt: receipt ?? null, outstanding, drafts: [...draftReceipts] }), { mode: 0o600 });
  await fs.rename(temp, recovery);
}
function responseFor(page: Page, pathname: string, method: string, match?: (response: Response) => boolean) {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method && (!match || match(response)));
}
async function mutate<T>(page: Page, pathname: string, method: string, control: Locator, record: (result: T) => Promise<void>): Promise<T> {
  if (outstanding) throw new Error('A previous own mutation has no confirmed result; preserve its private receipt.');
  outstanding = `${method} ${pathname}`; await saveRecovery();
  const completed = responseFor(page, pathname, method);
  await control.click(); const response = await completed;
  if (response.status() !== 200) {
    if (response.status() < 500) { outstanding = null; await saveRecovery(); }
    throw new Error(`Own UI mutation returned HTTP ${response.status()}.`);
  }
  const result = await data<T>(response, 'Own completed UI mutation');
  await record(result); outstanding = null; await saveRecovery(); return result;
}
async function recordDraft(value: { draft: CapabilityPackageDraft }) {
  if (value.draft.resourceRef !== current.resource.resourceRef || value.draft.actorUserId !== adminId || value.draft.name !== fixture.name) throw new Error('A completed draft does not match the exact owned package.');
  draftReceipts.set(value.draft.draftRef, { resourceRef: value.draft.resourceRef, revision: value.draft.draftRevision }); await saveRecovery();
}
async function recordPublication(value: CompletedPublication) {
  if (!receipt || value.state.resourceRef !== current.resource.resourceRef || value.state.name !== fixture.name || value.published.resourceRef !== value.state.resourceRef) throw new Error('A completed publication does not match the owned package.');
  receipt.publications.push({ resourceRef: value.published.resourceRef, revisionRef: value.published.revisionRef, checksum: value.published.checksum, version: value.published.version });
  current = { ...current, state: value.state, published: value.published }; await saveRecovery();
}
async function recordResource(value: { resource: CapabilityResourceDescriptor }) {
  if (!receipt || value.resource.metadata.resourceRef !== current.resource.resourceRef) throw new Error('A completed sharing write does not match the exact own resource.');
  receipt.resourceRevisions[0] = { resourceRef: value.resource.metadata.resourceRef, metadataRevision: value.resource.metadata.metadataRevision, grantsRevision: value.resource.metadata.grantsRevision };
  current = { ...current, resource: value.resource.metadata }; await saveRecovery();
  expect(value.resource.metadata.metadataRevision).toBe(1);
  const fresh = await readResource(); expect(fresh.metadata.metadataRevision).toBe(1); expect(fresh.metadata.grantsRevision).toBe(value.resource.metadata.grantsRevision);
}
async function readResource(context = admin, workspace = workspaceId) {
  return (await data<{ resource: CapabilityResourceDescriptor }>(await context.request.get(`/api/capabilities/resources/${encodeURIComponent(current.resource.resourceRef)}?workspaceId=${encodeURIComponent(workspace)}`), 'Exact installed current metadata')).resource;
}
function href(workspace: string, values: Record<string, string>) {
  return `/en/plugins?${new URLSearchParams({ view: 'installed', scope: 'organization', workspaceId: workspace, ...values })}`;
}
async function waitDetail(page: Page, task: string) {
  await expect(page.getByTestId('package-detail-title')).toHaveText(fixture.name);
  await expect(page.getByTestId(`package-detail-tab-${task}`)).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('package-detail-workspace').getByText(labels.detail.loading, { exact: true })).toHaveCount(0);
}
async function pick(page: Page, id: string) {
  const wizard = page.getByTestId('store-package-wizard'); await wizard.getByTestId(id).click();
  const popup = wizard.locator('[data-slot="popover-content"][data-state="open"]');
  await popup.getByRole('combobox', { name: labels.storeWizard.searchPeople, exact: true }).fill(memberEmail);
  await popup.getByTestId(`${id}-option-${memberId}`).click();
}
async function chooseFile(page: Page, file: string, draftRef?: string) {
  const selected = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `${pkg}/${draftRef ? `drafts/${encodeURIComponent(draftRef)}` : encodeURIComponent(current.resource.resourceRef)}/file`
    && new URL(response.url()).searchParams.get('path') === file);
  await page.getByTestId('package-file-picker').selectOption(file); await data<unknown>(await selected, 'Actual complete file selected through UI');
  await expect(page.getByTestId('package-file-content')).toBeVisible();
}
async function snapshot(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const file = path.join(artifacts, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
}
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release: () => release() }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The exact own transport barrier was not reached.')), 45_000); })]); }
  finally { clearTimeout(timer); }
}

test.beforeAll(async ({ browser }) => {
  const file = process.env.CAPABILITY_STORE_E2E_FIXTURE, proofFile = process.env.CAPABILITY_FULLCLICK_SOURCE_PROOF, dataRoot = process.env.DATA;
  const email = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
  const password = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
  if (!file || !path.isAbsolute(file) || !proofFile || !path.isAbsolute(proofFile) || !dataRoot || !email || !password) throw new Error('Actual managed DATA, existing member credentials, the owned private Store fixture and its source proof are required.');
  fixture = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture;
  if (fixture.nonce !== '3454322acc' || fixture.name !== `package-editor-qa-${fixture.nonce}` || !path.isAbsolute(fixture.sourceDirectory)) throw new Error('The configured Store fixture is not the owned acceptance fixture.');
  const proofStat = await fs.lstat(proofFile), original = fixture.sources.find(source => source.version === '1.0.0');
  if (!proofStat.isFile() || proofStat.isSymbolicLink() || proofStat.nlink !== 1 || (proofStat.mode & 0o777) !== 0o600 || !original || !/^[a-f0-9]{64}$/u.test(original.checksum)) throw new Error('The private original Store source proof is missing or invalid.');
  const captured = JSON.parse(await fs.readFile(proofFile, 'utf8')) as { nonce: string; name: string; proof: OwnedCapabilityPackageSourceDirectoryProof };
  if (captured.nonce !== fixture.nonce || captured.name !== fixture.name || !captured.proof || captured.proof.checksum !== original.checksum) throw new Error('The original Store source proof does not match the owned acceptance fixture.');
  await assertOwnedCapabilityPackageSourceDirectory({ sourceDirectory: fixture.sourceDirectory, initialChecksum: original.checksum, proof: captured.proof, configuredSourceRoot: process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT });
  sourceDirectoryProof = { ...captured.proof };
  const intake = JSON.parse(await fs.readFile(path.join(fixture.sourceDirectory, '.canvas-plugin/plugin.json'), 'utf8')) as { name: string; version: string };
  if (intake.name !== fixture.name || intake.version !== '1.0.0') throw new Error('The owned cleanup intake must be rehydrated and unchanged before this run.');
  admin = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } }); member = await createAuthenticatedContext(browser, { viewport: { width: 390, height: 900 } }, { email, password });
  await runManagedTestPreflight(admin); await runManagedTestPreflight(member);
  for (const context of [admin, member]) {
    const user = (await (await requestManagedTestSession(context.request)).json()).user as { id: string; name?: string; email?: string; role?: string };
    const response = await context.request.get('/api/workspaces'); if (!response.ok()) throw new Error('Existing actor workspaces are unavailable.');
    const listing = await response.json() as { organizationId: string; workspaces: ClientWorkspaceSummary[] };
    const own = listing.workspaces.find(value => value.status === 'active' && value.type === 'personal' && value.ownerUserId === user.id);
    if (!own) throw new Error('An existing actor has no active personal browsing workspace.');
    if (context === admin) { adminId = user.id; workspaceId = own.id; organizationId = listing.organizationId; }
    else { memberId = user.id; memberName = user.name || email; memberEmail = user.email || email; memberWorkspaceId = own.id; if (listing.organizationId !== organizationId || user.role === 'admin') throw new Error('The existing test member must be an ordinary member in the same organization.'); }
    await context.addInitScript(value => {
      localStorage.setItem('canvas.activeWorkspaceId', value); if (!localStorage.getItem('theme')) localStorage.setItem('theme', 'light');
      Reflect.set(window, '__ownedPackageHistoryEvents', 0);
      window.addEventListener('popstate', () => Reflect.set(window, '__ownedPackageHistoryEvents', Number(Reflect.get(window, '__ownedPackageHistoryEvents')) + 1), true);
    }, own.id);
    context.on('request', request => {
      const route = new URL(request.url()).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && /^\/api\/(?:composio|mcp|email|integrations|agent|workspaces)(?:\/|$)/u.test(route)) unexpectedWrites.push(`${request.method()} ${route}`);
    });
  }
  const existing = await data<{ items: Array<{ name: string }> }>(await admin.request.get(`/api/plugins/catalog?${new URLSearchParams({ scope: 'organization', kind: 'plugin', q: fixture.name, workspaceId })}`), 'Read-only exact installation collision check');
  if (existing.items.some(item => item.name === fixture.name)) throw new Error('The own package name is already occupied; preserve it and inspect the preceding receipt.');
  artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-plugin-ui-6ac3-fullclick-')); await fs.chmod(artifacts, 0o700);
  recovery = path.join(artifacts, 'recovery.json'); await saveRecovery();
  adminPage = await admin.newPage(); memberPage = await member.newPage(); secondAdminPage = await admin.newPage();
  memberPage.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.startsWith(`${pkg}/`) && /\/(?:file|tree)$/u.test(url.pathname)) memberContentReads.push(url.pathname);
  });
});
test.afterAll(async () => {
  const failures: unknown[] = []; for (const release of releases) release();
  for (const page of [adminPage, memberPage, secondAdminPage]) if (page) await page.close().catch(error => failures.push(error));
  if (receipt && !outstanding) {
    try { await cleanupOwnedCapabilityPackageFixture(receipt); await fs.rm(recovery); }
    catch (error) { failures.push(error); }
  } else if (outstanding) failures.push(new Error(`The own mutation outcome needs inspection; private recovery receipt retained at ${recovery}`));
  else if (recovery) await fs.rm(recovery);
  for (const context of [admin, member]) if (context) await context.close().catch(error => failures.push(error));
  if (failures.length) throw new AggregateError(failures, 'Guarded own full-click cleanup did not complete.');
});

test('real UI installs organization access, edits and publishes immutable bytes, then updates the exact variant without changing grants', async () => {
  const page = adminPage, source = fixture.sources.find(value => value.version === '1.0.0'), upstream = fixture.sources.find(value => value.version === '3.0.0');
  if (!source || !upstream) throw new Error('The owned configured Store must expose the exact first and third versions.');
  await page.goto(href(workspaceId, { scope: 'user', view: 'discover', kind: 'plugin', q: fixture.name }), { waitUntil: 'domcontentloaded' });
  await page.getByTestId('plugin-workspace-offering').getByRole('button', { name: labels.lists.openOffering.replace('{name}', fixture.name), exact: true }).click();
  await expect(page.getByTestId('store-package-wizard')).toHaveAttribute('aria-busy', 'false');
  const preview = responseFor(page, `${pkg}/store/preview`, 'POST', response => response.request().postDataJSON()?.source?.version === '1.0.0');
  await page.getByRole('combobox', { name: labels.shell.version, exact: true }).selectOption('1.0.0'); await data<unknown>(await preview, 'Actual version one UI preview');
  const wizard = page.getByTestId('store-package-wizard'); await expect(wizard).toHaveAttribute('aria-busy', 'false');
  await wizard.getByTestId('store-wizard-target').selectOption('organization');
  const directory = responseFor(page, `${pkg}/store/install-options`, 'POST'); await wizard.getByRole('button', { name: labels.storeWizard.confirmTarget, exact: true }).click(); await data<unknown>(await directory, 'Current manageable organization directory');
  await pick(page, 'store-wizard-responsible'); await pick(page, 'store-wizard-add-user');
  const grant = wizard.getByTestId('store-wizard-grant'); await expect(grant).toHaveCount(1);
  for (const name of [labels.storeWizard.use, labels.storeWizard.edit, labels.storeWizard.manage]) await expect(grant.getByRole('switch', { name: `${memberName}: ${name}`, exact: true })).not.toBeChecked();
  await grant.getByRole('switch', { name: `${memberName}: ${labels.storeWizard.use}`, exact: true }).click();
  current = await mutate<CapabilityPackageStoreApplicationResult>(page, `${pkg}/store/install`, 'POST', wizard.getByRole('button', { name: labels.storeWizard.install, exact: true }), async value => {
    if (value.state.name !== fixture.name || value.published.version !== '1.0.0' || value.resource.ownership.type !== 'organization' || value.resource.ownership.organizationId !== organizationId) throw new Error('The completed installation is not the exact owned organization package.');
    current = value;
    receipt = { nonce: fixture.nonce, names: [fixture.name], actorIds: [adminId, memberId], adminId, organizationId, dataRoot: await fs.realpath(process.env.DATA!),
      sourceDirectory: fixture.sourceDirectory, sourceDirectoryProof, sourceName: fixture.name, initialChecksum: source.checksum, initialVersion: source.version, initialManaged: true,
      sourceResourceRef: value.resource.resourceRef, resourceRevisions: [{ resourceRef: value.resource.resourceRef, metadataRevision: value.resource.metadataRevision, grantsRevision: value.resource.grantsRevision }],
      publications: [{ resourceRef: value.published.resourceRef, revisionRef: value.published.revisionRef, checksum: value.published.checksum, version: value.published.version }] };
    await saveRecovery();
  });
  const ref = current.resource.resourceRef; await expect.poll(() => new URL(page.url()).searchParams.get('resourceRef')).toBe(ref); await waitDetail(page, 'overview');
  const resource = await readResource(); expect(resource.metadata.accessMode).toBe('restricted'); expect(resource.metadata.metadataRevision).toBe(1); expect(resource.metadata.grantsRevision).toBe(1);
  expect(resource.metadata.responsibleUserId).toBe(memberId); expect(resource.grants).toHaveLength(1); expect(resource.grants![0]).toMatchObject({ targetType: 'user', targetId: memberId, canUse: true, canEdit: false, canManage: false });
  const installed = (await data<{ package: CapabilityPackageDescriptor }>(await admin.request.get(`${pkg}/${encodeURIComponent(ref)}?workspaceId=${workspaceId}`), 'Read-only installed activation')).package;
  expect(installed.defaultEnabled).toBe(false); expect(installed.state?.packageRevision).toBe(1);
  await expect(page.getByTestId('resource-management')).toHaveCount(0); await expect(page.getByTestId('package-editor')).toHaveCount(0); await expect(page.getByTestId('package-detail-versions')).toHaveCount(0);
  await snapshot(page, 'organization-installed-overview');
  await page.getByTestId('package-detail-back').click(); const search = page.getByRole('searchbox', { name: labels.shell.search, exact: true }); await search.fill(fixture.name); await search.press('Enter');
  const exactRow = page.locator(`[data-testid="plugin-workspace-resource"][data-resource-ref="${ref}"]`); await expect(exactRow).toBeVisible();
  const installedCatalog = await data<PluginWorkspaceCatalogResponse>(await admin.request.get(`/api/plugins/catalog?${new URLSearchParams({ scope: 'organization', kind: 'plugin', q: fixture.name, workspaceId })}`), 'Read-only current exact installed row activation');
  const exactCatalogRow = installedCatalog.items.find(item => item.resourceRef === ref);
  expect(exactCatalogRow?.ownership).toEqual(current.resource.ownership); expect(exactCatalogRow?.version).toBe('1.0.0'); expect(exactCatalogRow?.activation?.enabled).toBe(false);
  const blocked = exactCatalogRow!.activation?.effectivePolicy === 'blocked' || ['blocked', 'conflict'].includes(exactCatalogRow!.activation?.readiness ?? '');
  await expect(exactRow.getByText(labels.lists.organization, { exact: true })).toBeVisible();
  await expect(exactRow.getByText(blocked ? labels.lists.blocked : labels.lists.disabled, { exact: true })).toBeVisible();
  await exactRow.getByRole('button', { name: labels.lists.openResource.replace('{name}', fixture.name), exact: true }).click(); await waitDetail(page, 'overview');
  await page.getByTestId('package-detail-tab-sharing').click(); await expect(page.getByTestId('resource-management').locator(':scope > dl').getByText(memberName, { exact: true })).toBeVisible();
  await page.getByTestId('package-detail-tab-versions').click(); await expect(page.getByTestId('package-detail-versions').getByText('1.0.0', { exact: true })).toBeVisible();

  await memberPage.goto(href(memberWorkspaceId, { resourceRef: ref, task: 'overview' }), { waitUntil: 'domcontentloaded' }); await waitDetail(memberPage, 'overview');
  const memberResource = await readResource(member, memberWorkspaceId); expect(memberResource.access).toEqual({ canRead: true, canUse: true, canEdit: false, canManage: false }); expect(memberResource.grants).toBeUndefined();
  await memberPage.getByTestId('package-detail-tab-sharing').click();
  await expect(memberPage.getByTestId('resource-management').getByText(en.skills.resourceManagement.readOnly, { exact: true })).toBeVisible(); await expect(memberPage.getByTestId('resource-display-name')).toHaveCount(0);
  await memberPage.evaluate(() => localStorage.setItem('theme', 'dark')); await memberPage.reload({ waitUntil: 'domcontentloaded' }); await waitDetail(memberPage, 'sharing');
  await expect(memberPage.locator('html')).toHaveClass(/\bdark\b/u);
  await expect(memberPage.getByTestId('resource-management').getByText(en.skills.resourceManagement.readOnly, { exact: true })).toBeVisible(); await snapshot(memberPage, 'member-sharing-read-only-mobile');
  await memberPage.getByTestId('package-detail-tab-content').click(); await expect(memberPage.getByTestId('package-reload')).toBeEnabled(); await expect(memberPage.getByTestId('package-create-edit')).toHaveCount(0); await expect(memberPage.getByTestId('package-default-activation')).toHaveCount(0);
  await chooseFile(memberPage, 'README.md'); await expect(memberPage.getByTestId('package-file-content')).toHaveAttribute('readonly', '');

  await page.getByTestId('package-detail-tab-content').click(); await expect(page.getByTestId('package-create-edit')).toBeEnabled();
  let draft = (await mutate<{ draft: CapabilityPackageDraft }>(page, `${pkg}/drafts`, 'POST', page.getByTestId('package-create-edit'), recordDraft)).draft;
  await expect(page.getByTestId('package-validate')).toBeEnabled(); await chooseFile(page, 'README.md', draft.draftRef);
  const oldText = await page.getByTestId('package-file-content').inputValue(), localText = `${oldText}\nLocal revision 1.1.0 ${fixture.nonce}.\n`;
  await page.getByTestId('package-file-content').fill(localText); const savedHref = page.url(); let confirmations = 0;
  const dialogTypes: string[] = [];
  const onDialog = async (dialog: import('@playwright/test').Dialog) => { dialogTypes.push(dialog.type()); confirmations += 1; await dialog.dismiss(); };
  page.on('dialog', onDialog);
  const historyBefore = await page.evaluate(() => Number(Reflect.get(window, '__ownedPackageHistoryEvents')));
  await page.getByRole('button', { name: en.common.back, exact: true }).click(); await expect.poll(() => confirmations).toBe(1);
  expect(dialogTypes).toEqual(['confirm']);
  await expect.poll(() => page.evaluate(() => Number(Reflect.get(window, '__ownedPackageHistoryEvents')))).toBeGreaterThanOrEqual(historyBefore + 2);
  await expect(page).toHaveURL(savedHref); await expect(page.getByTestId('package-file-content')).toHaveValue(localText);

  const held = latch(), entered = latch(); releases.add(held.release);
  const serverResult: { draft?: CapabilityPackageDraft } = {}; let barrierFailure: unknown;
  const draftPath = `${pkg}/drafts/${encodeURIComponent(draft.draftRef)}/file`;
  const matcher = (url: URL) => url.pathname === draftPath;
  const handler = async (route: Route) => {
    const request = route.request(); if (request.method() !== 'PUT') return route.continue();
    try {
      const input = request.postDataJSON(); if (input.path !== 'README.md' || input.expectedDraftRevision !== draft.draftRevision) throw new Error('The transport barrier received an unowned draft mutation.');
      const actual = await route.fetch(); const value = await data<{ draft: CapabilityPackageDraft }>(actual, 'Actual server-completed README PUT');
      await recordDraft(value); serverResult.draft = value.draft; outstanding = null; await saveRecovery(); entered.release(); await held.promise;
      await route.fulfill({ response: actual });
    } catch (error) { barrierFailure = error; entered.release(); await route.abort().catch(() => undefined); }
  };
  await page.route(matcher, handler);
  try {
    outstanding = `PUT ${draftPath}`; await saveRecovery(); const delivered = responseFor(page, draftPath, 'PUT');
    await page.getByTestId('package-save-file').click(); await bounded(entered.promise); if (barrierFailure) throw barrierFailure;
    await expect(page.getByTestId('package-save-file')).toBeDisabled();
    const pendingHistory = await page.evaluate(() => Number(Reflect.get(window, '__ownedPackageHistoryEvents')));
    await page.getByRole('button', { name: en.common.back, exact: true }).click();
    await expect.poll(() => page.evaluate(() => Number(Reflect.get(window, '__ownedPackageHistoryEvents')))).toBeGreaterThanOrEqual(pendingHistory + 2);
    await page.getByTestId('plugin-workspace-scope-user').click(); await expect(page).toHaveURL(savedHref); expect(confirmations).toBe(1);
    await expect(page.getByTestId('package-file-content')).toHaveValue(localText);
    held.release(); await data<unknown>(await delivered, 'Unchanged actual README response delivered'); await expect(page.getByTestId('package-validate')).toBeEnabled();
    if (!serverResult.draft) throw new Error('The actual README response was not captured.'); draft = serverResult.draft;
  } finally { held.release(); releases.delete(held.release); await page.unroute(matcher, handler); page.off('dialog', onDialog); }

  await chooseFile(page, '.canvas-plugin/plugin.json', draft.draftRef); const manifest = JSON.parse(await page.getByTestId('package-file-content').inputValue()) as Record<string, unknown>;
  expect(manifest.name).toBe(fixture.name); manifest.version = '1.1.0'; await page.getByTestId('package-file-content').fill(`${JSON.stringify(manifest, null, 2)}\n`);
  draft = (await mutate<{ draft: CapabilityPackageDraft }>(page, `${pkg}/drafts/${encodeURIComponent(draft.draftRef)}/file`, 'PUT', page.getByTestId('package-save-file'), recordDraft)).draft;
  await expect(page.getByTestId('package-validate')).toBeEnabled();
  const validate = responseFor(page, `${pkg}/drafts/${encodeURIComponent(draft.draftRef)}/validate`, 'POST'); await page.getByTestId('package-validate').click();
  const validation = await data<{ validation: { valid: boolean; version: string } }>(await validate, 'Actual UI full package validation'); expect(validation.validation.valid).toBe(true); expect(validation.validation.version).toBe('1.1.0');
  await expect(page.getByTestId('package-publish')).toBeEnabled();
  await mutate<CompletedPublication>(page, `${pkg}/drafts/${encodeURIComponent(draft.draftRef)}/publish`, 'POST', page.getByTestId('package-publish'), async value => { await recordPublication(value); draftReceipts.delete(draft.draftRef); await saveRecovery(); });
  await expect(page.getByTestId('package-create-edit')).toBeEnabled(); await page.getByTestId('package-detail-tab-versions').click();
  await expect(page.getByTestId('package-detail-versions').getByText('1.1.0', { exact: true })).toBeVisible(); await expect(page.getByTestId('package-detail-versions').getByText('1.0.0', { exact: true })).toBeVisible();
  const localRef = current.published.revisionRef, legacyRef = current.resource.legacyResourceId;
  await page.goto(href(workspaceId, { resourceRef: legacyRef, task: 'overview', plugin: fixture.name, source: 'installed' }), { waitUntil: 'domcontentloaded' }); await waitDetail(page, 'overview');
  await expect(page.getByTestId('package-detail-store-update')).toBeEnabled();
  const reviewResponse = responseFor(page, `${pkg}/${encodeURIComponent(ref)}/store-update/review`, 'POST'); await page.getByTestId('package-detail-store-update').click();
  const review = await data<CapabilityPackageStoreUpdateReview>(await reviewResponse, 'Exact variant Store review'); expect(review.resourceRef).toBe(ref); expect(review.source).toEqual(upstream); expect(review.localChanges).toBe('modified'); expect(review.expectedGrantsRevision).toBe(1);
  const updateWizard = page.getByTestId('store-package-wizard'); await expect(updateWizard).toHaveAttribute('aria-busy', 'false'); await expect(updateWizard.getByRole('button', { name: labels.storeWizard.applyUpdate, exact: true })).toBeDisabled();
  await updateWizard.getByTestId('store-wizard-replace-local').check();

  await secondAdminPage.goto(href(workspaceId, { resourceRef: ref, task: 'overview' }), { waitUntil: 'domcontentloaded' }); await waitDetail(secondAdminPage, 'overview');
  await secondAdminPage.getByTestId('package-detail-tab-sharing').click(); await waitDetail(secondAdminPage, 'sharing');
  const management = secondAdminPage.getByTestId('resource-management'); await management.getByText(en.skills.resourceManagement.edit, { exact: true }).click();
  const nameControl = management.getByTestId('resource-display-name'), originalName = await nameControl.inputValue();
  await nameControl.fill(`Unsaved own package ${fixture.nonce}`); const sharingHref = secondAdminPage.url(); let sharingDialogs = 0;
  const sharingDialog = async (dialog: import('@playwright/test').Dialog) => { sharingDialogs += 1; await dialog.dismiss(); };
  secondAdminPage.on('dialog', sharingDialog);
  await secondAdminPage.getByTestId('plugin-workspace').locator(':scope > header').getByRole('button', { name: labels.shell.refresh, exact: true }).click();
  await expect.poll(() => sharingDialogs).toBe(1); await expect(nameControl).toHaveValue(`Unsaved own package ${fixture.nonce}`);
  await secondAdminPage.getByTestId('plugin-workspace-scope-user').click(); await expect.poll(() => sharingDialogs).toBe(2); await expect(secondAdminPage).toHaveURL(sharingHref);
  const sharingHistory = await secondAdminPage.evaluate(() => Number(Reflect.get(window, '__ownedPackageHistoryEvents')));
  await secondAdminPage.getByRole('button', { name: en.common.back, exact: true }).click(); await expect.poll(() => sharingDialogs).toBe(3);
  await expect.poll(() => secondAdminPage.evaluate(() => Number(Reflect.get(window, '__ownedPackageHistoryEvents')))).toBeGreaterThanOrEqual(sharingHistory + 2);
  await expect(secondAdminPage).toHaveURL(sharingHref); await expect(nameControl).toHaveValue(`Unsaved own package ${fixture.nonce}`);
  await nameControl.fill(originalName); expect((await readResource()).metadata.metadataRevision).toBe(1);
  const existingGrant = management.getByTestId('resource-grant'); await expect(existingGrant).toHaveCount(1);
  await existingGrant.getByRole('checkbox', { name: `${en.skills.resourceManagement.rights.canEdit}: ${memberName}`, exact: true }).check();
  const sharingPath = `/api/capabilities/resources/${encodeURIComponent(ref)}`;
  const grantHeld = latch(), grantEntered = latch(); releases.add(grantHeld.release); let granted: CapabilityResourceDescriptor | null = null, grantBarrierFailure: unknown;
  const grantMatcher = (url: URL) => url.pathname === sharingPath;
  const grantHandler = async (route: Route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    try {
      const input = route.request().postDataJSON(); expect(input.expectedMetadataRevision).toBe(1); expect(input.expectedGrantsRevision).toBe(1); expect(input.metadata).toBeUndefined();
      expect(input.grants).toEqual([{ targetType: 'user', targetId: memberId, canUse: true, canEdit: true, canManage: false }]);
      const actual = await route.fetch(), value = await data<{ resource: CapabilityResourceDescriptor }>(actual, 'Actual completed grants-only PATCH');
      await recordResource(value); expect(value.resource.metadata.grantsRevision).toBe(2); granted = value.resource; outstanding = null; await saveRecovery(); grantEntered.release(); await grantHeld.promise;
      await route.fulfill({ response: actual });
    } catch (error) { grantBarrierFailure = error; grantEntered.release(); await route.abort().catch(() => undefined); }
  };
  await secondAdminPage.route(grantMatcher, grantHandler);
  let staleStatus = 0;
  try {
    outstanding = `PATCH ${sharingPath}`; await saveRecovery(); const grantDelivered = responseFor(secondAdminPage, sharingPath, 'PATCH');
    await management.getByTestId('resource-save').click(); await bounded(grantEntered.promise); if (grantBarrierFailure) throw grantBarrierFailure;
    await expect(management.getByTestId('resource-save')).toBeDisabled();
    const pendingSharingHistory = await secondAdminPage.evaluate(() => Number(Reflect.get(window, '__ownedPackageHistoryEvents')));
    await secondAdminPage.getByRole('button', { name: en.common.back, exact: true }).click();
    await expect.poll(() => secondAdminPage.evaluate(() => Number(Reflect.get(window, '__ownedPackageHistoryEvents')))).toBeGreaterThanOrEqual(pendingSharingHistory + 2);
    await secondAdminPage.getByTestId('plugin-workspace-scope-user').click(); await expect(secondAdminPage).toHaveURL(sharingHref); expect(sharingDialogs).toBe(3);
    const stale = responseFor(page, `${pkg}/${encodeURIComponent(ref)}/store-update`, 'POST'); outstanding = `POST ${pkg}/${encodeURIComponent(ref)}/store-update`; await saveRecovery();
    await updateWizard.getByRole('button', { name: labels.storeWizard.applyUpdate, exact: true }).click(); const rejected = await stale; staleStatus = rejected.status();
    if (staleStatus === 200) { const unexpected = await data<CapabilityPackageStoreApplicationResult>(rejected, 'Unexpected completed stale update'); await recordPublication(unexpected); current = unexpected; await saveRecovery(); }
    if (staleStatus < 500) { outstanding = null; await saveRecovery(); }
    expect(staleStatus).toBe(409); expect(rejected.request().postDataJSON()).toMatchObject({ expectedMetadataRevision: 1, expectedGrantsRevision: 1, expectedPackageRevision: 2, replaceLocalChanges: true });
    await expect(updateWizard.getByTestId('store-wizard-error')).toBeVisible(); await expect(updateWizard.getByRole('button', { name: labels.storeWizard.applyUpdate, exact: true })).toBeDisabled();
    const unchanged = (await data<{ package: CapabilityPackageDescriptor }>(await admin.request.get(`${pkg}/${encodeURIComponent(ref)}?workspaceId=${workspaceId}`), 'Read-only rejected update head')).package;
    expect(unchanged.state?.packageRevision).toBe(2); expect(unchanged.state?.currentPublishedRevisionRef).toBe(localRef); expect(receipt!.publications).toHaveLength(2);
    grantHeld.release(); await data<unknown>(await grantDelivered, 'Unchanged actual grants response delivered');
    await expect(management.getByTestId('resource-save')).toBeEnabled();
  } finally { grantHeld.release(); releases.delete(grantHeld.release); await secondAdminPage.unroute(grantMatcher, grantHandler); secondAdminPage.off('dialog', sharingDialog); }
  if (!granted) throw new Error('The actual grants-only result was not captured.');
  const g2 = await readResource(); expect(g2.metadata.metadataRevision).toBe(1); expect(g2.metadata.grantsRevision).toBe(2); expect(g2.metadata.responsibleUserId).toBe(memberId);
  const reviewed = responseFor(page, `${pkg}/${encodeURIComponent(ref)}/store-update/review`, 'POST'); await updateWizard.getByRole('button', { name: labels.storeWizard.reviewAgain, exact: true }).click();
  const freshReview = await data<CapabilityPackageStoreUpdateReview>(await reviewed, 'Explicit current review after grant conflict'); expect(freshReview.expectedGrantsRevision).toBe(2); expect(freshReview.expectedMetadataRevision).toBe(1);
  await expect(updateWizard.getByTestId('store-wizard-replace-local')).not.toBeChecked(); await updateWizard.getByTestId('store-wizard-replace-local').check();
  const changed = await mutate<CapabilityPackageStoreApplicationResult>(page, `${pkg}/${encodeURIComponent(ref)}/store-update`, 'POST', updateWizard.getByRole('button', { name: labels.storeWizard.applyUpdate, exact: true }), async value => {
    await recordPublication(value); current = value; receipt!.resourceRevisions[0] = { resourceRef: value.resource.resourceRef, metadataRevision: value.resource.metadataRevision, grantsRevision: value.resource.grantsRevision }; await saveRecovery();
  });
  expect(changed.state.packageRevision).toBe(3); expect(changed.published.version).toBe('3.0.0'); await waitDetail(page, 'versions');
  expect(new URL(page.url()).searchParams.get('resourceRef')).toBe(legacyRef);
  const history = page.getByTestId('package-detail-versions'); for (const version of ['1.0.0', '1.1.0', '3.0.0']) await expect(history.getByText(version, { exact: true })).toBeVisible();
  const preserved = await readResource(); expect(preserved.metadata).toEqual(g2.metadata); expect(preserved.grants).toEqual(g2.grants);
  const versions = await data<{ versions: CapabilityPackagePublishedSummary[] }>(await admin.request.get(`${pkg}/${encodeURIComponent(ref)}/versions?workspaceId=${workspaceId}`), 'Read-only exact immutable history');
  expect(versions.versions.map(value => value.version).sort()).toEqual(['1.0.0', '1.1.0', '3.0.0']); expect(versions.versions.every(value => value.resourceRef === ref)).toBe(true);
  const local = await data<{ file: CapabilityPackageFileRead }>(await admin.request.get(`${pkg}/${encodeURIComponent(ref)}/file?${new URLSearchParams({ workspaceId, revisionRef: localRef, path: 'README.md' })}`), 'Read-only preserved local immutable version');
  expect(Buffer.from(local.file.content, 'base64').toString()).toBe(localText);
  const after = (await data<{ package: CapabilityPackageDescriptor }>(await admin.request.get(`${pkg}/${encodeURIComponent(ref)}?workspaceId=${workspaceId}`), 'Read-only preserved activation')).package; expect(after.defaultEnabled).toBe(false);
  await snapshot(page, 'exact-update-preserved-version-history');
  await secondAdminPage.reload({ waitUntil: 'domcontentloaded' }); await waitDetail(secondAdminPage, 'sharing');
  await management.getByText(en.skills.resourceManagement.edit, { exact: true }).click(); await expect(management.getByTestId('resource-grant')).toHaveCount(1);
  await management.getByTestId('resource-grant').getByRole('button', { name: en.skills.resourceManagement.removeGrant.replace('{name}', memberName), exact: true }).click();
  await mutate<{ resource: CapabilityResourceDescriptor }>(secondAdminPage, sharingPath, 'PATCH', management.getByTestId('resource-save'), recordResource);
  const g3 = await readResource(); expect(g3.metadata.metadataRevision).toBe(1); expect(g3.metadata.grantsRevision).toBe(3); expect(g3.grants).toEqual([]); expect(g3.metadata.responsibleUserId).toBe(memberId);
  const readsBeforeRevokeReload = memberContentReads.length;
  await memberPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(memberPage.getByTestId('package-detail-workspace').getByText(labels.detail.accessError, { exact: true })).toBeVisible();
  await expect(memberPage.getByTestId('package-editor')).toHaveCount(0); await expect(memberPage.getByTestId('package-create-edit')).toHaveCount(0); await expect(memberPage.getByTestId('package-publish')).toHaveCount(0);
  expect(memberContentReads.length).toBe(readsBeforeRevokeReload);
  for (const route of [`/api/capabilities/resources/${encodeURIComponent(ref)}`, `${pkg}/${encodeURIComponent(ref)}/presentation`]) expect((await member.request.get(`${route}?workspaceId=${memberWorkspaceId}`)).status()).toBe(404);
  const memberCatalog = await data<{ items: Array<{ resourceRef: string }> }>(await member.request.get(`/api/plugins/catalog?${new URLSearchParams({ scope: 'user', audience: 'shared', workspaceId: memberWorkspaceId, q: fixture.name })}`), 'Current revoked reader catalog');
  expect(memberCatalog.items.some(item => item.resourceRef === ref)).toBe(false);
  await snapshot(memberPage, 'member-revoked-exact-resource'); expect(unexpectedWrites).toEqual([]);
});
