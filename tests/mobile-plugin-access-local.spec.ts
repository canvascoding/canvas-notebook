import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import { cleanupOwnedCapabilityPackageFixture, type OwnedCapabilityPackageFixture, type OwnedCapabilityPackageSourceDirectoryProof } from './helpers/capability-package-test-cleanup';
import { assertOwnedCapabilityPackageSourceDirectory } from './helpers/capability-package-cleanup-guards';
import type { CapabilityPackageDescriptor } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityPackageStoreApplicationResult, CapabilityPackageStoreSelection } from '../app/lib/capabilities/packages/store-contracts';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { MobilePluginDetail } from '../app/lib/mobile/extensions';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';

type Fixture = { nonce: string; name: string; sourceDirectory: string; sourceParent: string; fixtureDirectory: string;
  sources: CapabilityPackageStoreSelection[]; imageSha256: string; privateReadmeMarker: string; proofFile: string; registryUrl: string };
let fixture: Fixture, sourceProof: OwnedCapabilityPackageSourceDirectoryProof, png: Buffer;
let admin: BrowserContext, member: BrowserContext, page: Page;
let adminId = '', adminEmail = '', memberId = '', memberName = '', memberEmail = '', organizationId = '', workspaceId = '', memberWorkspaceId = '';
let recovery = '', receipt: OwnedCapabilityPackageFixture | undefined, current: CapabilityPackageStoreApplicationResult;
let outstanding: string | null = null;
const unexpectedWrites: string[] = [];
const labels = en.skills.workspace, sharing = en.skills.resourceManagement;
const packages = '/api/capabilities/packages', mobile = '/api/mobile/v1/extensions/plugins';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial', retries: 0 });

async function data<T>(response: APIResponse | Response, phase: string): Promise<T> {
  if (response.status() !== 200) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  const value = await response.json() as { success?: boolean; data?: T };
  if (value.success !== true || value.data === undefined) throw new Error(`${phase} returned an invalid public envelope.`);
  return value.data;
}
async function saveRecovery(): Promise<void> {
  const temporary = `${recovery}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ fixture, receipt: receipt ?? null, outstanding }), { mode: 0o600 });
  await fs.rename(temporary, recovery);
}
function responseFor(pathname: string, method: string): Promise<Response> {
  return page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method);
}
async function mutate<T>(pathname: string, control: Locator, record: (result: T) => Promise<void>): Promise<{ result: T; body: unknown }> {
  if (outstanding) throw new Error('An earlier own mutation is unconfirmed; preserve the private recovery receipt.');
  const method = pathname === `${packages}/store/install` ? 'POST' : 'PATCH';
  outstanding = `${method} ${pathname}`; await saveRecovery();
  const received = responseFor(pathname, method);
  await control.click(); const response = await received;
  if (response.status() !== 200) {
    if (response.status() < 500) { outstanding = null; await saveRecovery(); }
    throw new Error(`Own UI mutation returned HTTP ${response.status()}.`);
  }
  const result = await data<T>(response, 'Own completed UI mutation');
  await record(result); outstanding = null; await saveRecovery();
  return { result, body: response.request().postDataJSON() };
}
async function readResource(context = admin, workspace = workspaceId): Promise<CapabilityResourceDescriptor> {
  return (await data<{ resource: CapabilityResourceDescriptor }>(await context.request.get(
    `/api/capabilities/resources/${encodeURIComponent(current.resource.resourceRef)}?${new URLSearchParams({ workspaceId: workspace })}`), 'Exact current resource')).resource;
}
async function recordGrantWrite(value: { resource: CapabilityResourceDescriptor }): Promise<void> {
  if (!receipt || value.resource.metadata.resourceRef !== current.resource.resourceRef
    || value.resource.metadata.createdByUserId !== adminId || value.resource.metadata.ownership.type !== 'organization'
    || value.resource.metadata.ownership.organizationId !== organizationId) throw new Error('The confirmed sharing result is not the exact own package.');
  receipt.resourceRevisions[0] = { resourceRef: value.resource.metadata.resourceRef,
    metadataRevision: value.resource.metadata.metadataRevision, grantsRevision: value.resource.metadata.grantsRevision };
  current = { ...current, resource: value.resource.metadata }; await saveRecovery();
}
function pluginHref(task: string): string {
  return `/en/plugins?${new URLSearchParams({ view: 'installed', scope: 'organization', workspaceId,
    resourceRef: current.resource.resourceRef, task, plugin: fixture.name, kind: 'plugin' })}`;
}
async function openSharing(): Promise<Locator> {
  await page.goto(pluginHref('sharing'), { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('package-detail-title')).toHaveText(fixture.name);
  await expect(page.getByTestId('package-detail-tab-sharing')).toHaveAttribute('data-state', 'active');
  const section = page.getByTestId('resource-management');
  await section.getByText(sharing.edit, { exact: true }).click();
  await expect(section.getByTestId('resource-save')).toBeEnabled();
  return section;
}
function mobilePaths(workspace: string, scope = 'organization', resourceId: string | null = current.resource.resourceRef): [string, string] {
  const query = new URLSearchParams({ scope, workspaceId: workspace });
  if (resourceId !== null) query.set('resourceId', resourceId);
  const asset = new URLSearchParams(query); asset.set('plugin', fixture.name); asset.set('path', 'assets/icon.png');
  return [`${mobile}/${encodeURIComponent(fixture.name)}?${query}`, `${mobile}/asset?${asset}`];
}
async function assertDenied(context: BrowserContext, workspace: string, scope = 'organization', resourceId: string | null = current.resource.resourceRef): Promise<void> {
  for (const url of mobilePaths(workspace, scope, resourceId)) {
    const response = await context.request.get(url);
    expect(response.status()).toBe(404);
    const body = await response.text();
    expect(body.includes(fixture.privateReadmeMarker)).toBe(false);
    expect(body.includes(fixture.sourceDirectory)).toBe(false);
    expect(body.includes('storeOrigin')).toBe(false);
  }
}
async function assertAllowed(context: BrowserContext, workspace: string, resourceId: string | null = current.resource.resourceRef): Promise<void> {
  const [detailUrl, assetUrl] = mobilePaths(workspace, 'organization', resourceId);
  const response = await context.request.get(detailUrl);
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('private, no-store');
  const body = await response.json() as { success: boolean; plugin: MobilePluginDetail; scope: string };
  expect(body.success).toBe(true); expect(body.scope).toBe('organization'); expect(body.plugin.name).toBe(fixture.name);
  expect(body.plugin.release.version).toBe('1.0.0'); expect(body.plugin.state.enabled).toBe(false);
  const serialized = JSON.stringify(body);
  expect(serialized.includes(fixture.privateReadmeMarker)).toBe(false); expect(serialized.includes(fixture.sourceDirectory)).toBe(false);
  expect(serialized.includes('storeOrigin')).toBe(false);
  const asset = await context.request.get(assetUrl);
  expect(asset.status()).toBe(200); expect(asset.headers()['content-type']).toBe('image/png');
  expect(asset.headers()['cache-control']).toBe('private, no-store');
  expect((await asset.body()).equals(png)).toBe(true);
  // Exercise the actual serializer's legacy icon link as well; the actor/workspace remains explicit.
  if (!body.plugin.icon.url?.startsWith(`${mobile}/asset?`)) throw new Error('The actual mobile detail did not expose its relative package icon link.');
  const icon = new URL(body.plugin.icon.url, process.env.BASE_URL); icon.searchParams.set('workspaceId', workspace);
  expect(icon.searchParams.get('scope')).toBe('organization');
  const linked = await context.request.get(`${icon.pathname}${icon.search}`);
  expect(linked.status()).toBe(200); expect((await linked.body()).equals(png)).toBe(true);
}

test.beforeAll(async ({ browser }) => {
  const file = process.env.MOBILE_PLUGIN_ACCESS_FIXTURE, proofFile = process.env.MOBILE_PLUGIN_ACCESS_SOURCE_PROOF;
  const email = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
  const password = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
  if (!file || !proofFile || !path.isAbsolute(file) || !path.isAbsolute(proofFile) || !process.env.DATA || !email || !password)
    throw new Error('A new private fixture, real managed DATA and existing same-organization member credentials are required.');
  for (const candidate of [file, proofFile]) {
    const stat = await fs.lstat(candidate), parent = await fs.lstat(path.dirname(candidate));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
      || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700) throw new Error('Fixture metadata and source proof must be private regular files.');
  }
  fixture = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture;
  if (!/^[a-f0-9]{10}$/u.test(fixture.nonce) || fixture.name !== `package-editor-qa-${fixture.nonce}`
    || fixture.sources.length !== 1 || fixture.sources[0].kind !== 'plugin' || fixture.sources[0].entryKey !== fixture.name
    || fixture.sources[0].version !== '1.0.0' || !/^[a-f0-9]{64}$/u.test(fixture.sources[0].checksum)
    || fixture.fixtureDirectory !== path.dirname(file) || fixture.proofFile !== proofFile || !path.isAbsolute(fixture.sourceDirectory)
    || !/^[a-f0-9]{64}$/u.test(fixture.imageSha256) || !fixture.privateReadmeMarker?.includes(fixture.nonce)) throw new Error('The new owned fixture identity is invalid.');
  const captured = JSON.parse(await fs.readFile(proofFile, 'utf8')) as { nonce: string; name: string; proof: OwnedCapabilityPackageSourceDirectoryProof };
  if (captured.nonce !== fixture.nonce || captured.name !== fixture.name) throw new Error('The source proof belongs to a different fixture.');
  await assertOwnedCapabilityPackageSourceDirectory({ sourceDirectory: fixture.sourceDirectory, initialChecksum: fixture.sources[0].checksum,
    proof: captured.proof, configuredSourceRoot: process.env.CANVAS_PLUGIN_LOCAL_SOURCE_ROOT });
  sourceProof = { ...captured.proof };
  const imagePath = path.join(fixture.sourceDirectory, 'assets/icon.png'), imageStat = await fs.lstat(imagePath);
  if (!imageStat.isFile() || imageStat.isSymbolicLink() || imageStat.size > 4096 || await fs.realpath(imagePath) !== imagePath) throw new Error('The owned icon is not an exact bounded file.');
  png = await fs.readFile(imagePath);
  if (createHash('sha256').update(png).digest('hex') !== fixture.imageSha256) throw new Error('The original icon bytes changed.');
  admin = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } });
  member = await createAuthenticatedContext(browser, { viewport: { width: 390, height: 900 } }, { email, password });
  await runManagedTestPreflight(admin); await runManagedTestPreflight(member);
  for (const context of [admin, member]) {
    const session = await requestManagedTestSession(context.request);
    if (session.status() !== 200) throw new Error('The real actor session is unavailable.');
    const user = (await session.json()).user as { id: string; name?: string; email?: string; role?: string };
    const response = await context.request.get('/api/workspaces');
    if (!response.ok()) throw new Error('Existing actor workspaces are unavailable.');
    const listing = await response.json() as { organizationId: string; workspaces: ClientWorkspaceSummary[] };
    const own = listing.workspaces.find(value => value.status === 'active' && value.type === 'personal' && value.ownerUserId === user.id);
    if (!own) throw new Error('Each existing actor requires its own active personal browsing workspace.');
    if (context === admin) { adminId = user.id; adminEmail = user.email || process.env.TEST_LOGIN_EMAIL || ''; organizationId = listing.organizationId; workspaceId = own.id; }
    else {
      memberId = user.id; memberName = user.name || email; memberEmail = user.email || email; memberWorkspaceId = own.id;
      if (listing.organizationId !== organizationId || ['admin', 'owner'].includes(user.role || '') || memberId === adminId)
        throw new Error('The existing secondary actor must be an ordinary distinct member of the same organization.');
    }
    await context.addInitScript(value => { localStorage.setItem('canvas.activeWorkspaceId', value); localStorage.setItem('theme', 'light'); }, own.id);
    context.on('request', request => {
      const route = new URL(request.url()).pathname;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && /^\/api\/(?:composio|mcp|email|integrations|agent|agents|workspaces)(?:\/|$)/u.test(route))
        unexpectedWrites.push(`${request.method()} ${route}`);
    });
  }
  const existing = await data<{ items: Array<{ name: string }> }>(await admin.request.get(`/api/plugins/catalog?${new URLSearchParams({
    scope: 'organization', kind: 'plugin', q: fixture.name, workspaceId })}`), 'Exact installation collision check');
  if (existing.items.some(value => value.name === fixture.name)) throw new Error('This own fixture was already installed; preserve its earlier recovery receipt.');
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), `canvas-mobile-plugin-access-${fixture.nonce}-`)); await fs.chmod(artifacts, 0o700);
  recovery = path.join(artifacts, 'recovery.json'); await saveRecovery(); page = await admin.newPage();
});

test.afterAll(async () => {
  const failures: unknown[] = [];
  if (page) await page.close().catch(error => failures.push(error));
  if (receipt && !outstanding) {
    try { await cleanupOwnedCapabilityPackageFixture(receipt); await fs.rm(recovery); }
    catch (error) { failures.push(error); }
  } else if (outstanding) failures.push(new Error(`The own mutation needs inspection; private recovery receipt retained at ${recovery}`));
  else if (recovery) await fs.rm(recovery);
  for (const context of [admin, member]) if (context) await context.close().catch(error => failures.push(error));
  if (failures.length) throw new AggregateError(failures, 'Guarded own mobile plugin fixture cleanup did not complete.');
});

test('actual organization installation and Use-only UI grant gate mobile metadata and exact PNG immediately', async () => {
  await page.goto(`/en/plugins?${new URLSearchParams({ view: 'discover', scope: 'user', kind: 'plugin', q: fixture.name, workspaceId })}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('plugin-workspace-offering').getByRole('button', { name: labels.lists.openOffering.replace('{name}', fixture.name), exact: true }).click();
  const wizard = page.getByTestId('store-package-wizard'); await expect(wizard).toHaveAttribute('aria-busy', 'false');
  await wizard.getByTestId('store-wizard-target').selectOption('organization');
  const targets = responseFor(`${packages}/store/install-options`, 'POST');
  await wizard.getByRole('button', { name: labels.storeWizard.confirmTarget, exact: true }).click();
  await data<unknown>(await targets, 'Actual current organization install options');
  await wizard.getByTestId('store-wizard-responsible').click();
  const popup = wizard.locator('[data-slot="popover-content"][data-state="open"]');
  await popup.getByRole('combobox', { name: labels.storeWizard.searchPeople, exact: true }).fill(adminEmail);
  await popup.getByTestId(`store-wizard-responsible-option-${adminId}`).click();
  await expect(wizard.getByTestId('store-wizard-grant')).toHaveCount(0);
  const installed = await mutate<CapabilityPackageStoreApplicationResult>(`${packages}/store/install`, wizard.getByRole('button', { name: labels.storeWizard.install, exact: true }), async value => {
    if (value.resource.createdByUserId !== adminId || value.resource.ownership.type !== 'organization'
      || value.resource.ownership.organizationId !== organizationId || value.state.name !== fixture.name
      || value.published.resourceRef !== value.resource.resourceRef || value.published.version !== '1.0.0'
      || value.published.checksum !== fixture.sources[0].checksum) throw new Error('The completed installation is not the exact owned package.');
    current = value;
    receipt = { nonce: fixture.nonce, names: [fixture.name], actorIds: [adminId, memberId], adminId, organizationId,
      dataRoot: await fs.realpath(process.env.DATA!), sourceDirectory: fixture.sourceDirectory, sourceDirectoryProof: sourceProof,
      sourceName: fixture.name, initialChecksum: fixture.sources[0].checksum, initialVersion: '1.0.0', initialManaged: true,
      sourceResourceRef: value.resource.resourceRef, resourceRevisions: [{ resourceRef: value.resource.resourceRef,
        metadataRevision: value.resource.metadataRevision, grantsRevision: value.resource.grantsRevision }],
      publications: [{ resourceRef: value.published.resourceRef, revisionRef: value.published.revisionRef, checksum: value.published.checksum, version: value.published.version }] };
    await saveRecovery();
  });
  expect(installed.body).toMatchObject({ source: fixture.sources[0], ownership: { type: 'organization' }, grants: [], responsibleUserId: adminId });
  const initial = await readResource();
  expect(initial.metadata).toMatchObject({ metadataRevision: 1, grantsRevision: 1, accessMode: 'restricted', responsibleUserId: adminId });
  expect(initial.grants).toHaveLength(0);
  const descriptor = (await data<{ package: CapabilityPackageDescriptor }>(await admin.request.get(
    `${packages}/${encodeURIComponent(current.resource.resourceRef)}?workspaceId=${encodeURIComponent(workspaceId)}`), 'Actual disabled installation')).package;
  expect(descriptor.defaultEnabled).toBe(false); expect(descriptor.state?.packageRevision).toBe(1);
  await assertDenied(member, memberWorkspaceId);
  await assertAllowed(admin, workspaceId); // Admin's actual package authority, not a provider/SDK mock.

  const section = await openSharing(); await section.getByTestId('resource-grant-target').click();
  const targetPopup = section.locator('[data-slot="popover-content"][data-state="open"]');
  await targetPopup.getByRole('combobox', { name: sharing.searchTargets, exact: true }).fill(memberEmail);
  await targetPopup.getByTestId(`resource-grant-target-option-${memberId}`).click();
  await section.getByTestId('resource-new-canUse').check();
  await expect(section.getByTestId('resource-new-canEdit')).not.toBeChecked(); await expect(section.getByTestId('resource-new-canManage')).not.toBeChecked();
  await section.getByRole('button', { name: sharing.addGrant, exact: true }).click();
  await expect(section.getByTestId('resource-grant')).toHaveCount(1);
  const grant = await mutate<{ resource: CapabilityResourceDescriptor }>(`/api/capabilities/resources/${encodeURIComponent(current.resource.resourceRef)}`,
    section.getByTestId('resource-save'), recordGrantWrite);
  expect(grant.body).toEqual({ expectedMetadataRevision: 1, expectedGrantsRevision: 1,
    grants: [{ targetType: 'user', targetId: memberId, canUse: true, canEdit: false, canManage: false }] });
  const shared = await readResource(); expect(shared.metadata).toMatchObject({ metadataRevision: 1, grantsRevision: 2, responsibleUserId: adminId });
  expect(shared.grants).toHaveLength(1);
  expect(shared.grants![0]).toMatchObject({ targetType: 'user', targetId: memberId, canUse: true, canEdit: false, canManage: false });
  const readable = await readResource(member, memberWorkspaceId);
  expect(readable.access).toEqual({ canRead: true, canUse: true, canEdit: false, canManage: false }); expect(readable.grants).toBeUndefined();
  await assertAllowed(member, memberWorkspaceId);
  await assertAllowed(member, memberWorkspaceId, null); // Existing name+organization contract stays authorized.
  await assertDenied(member, memberWorkspaceId, 'organization', `canvas-resource:${randomUUID()}`);
  await assertDenied(member, memberWorkspaceId, 'user');
  await assertDenied(member, memberWorkspaceId, 'user', null); // No by-name personal-to-organization fallback.

  const revokeSection = await openSharing();
  await revokeSection.getByRole('button', { name: sharing.removeGrant.replace('{name}', memberName), exact: true }).click();
  await expect(revokeSection.getByTestId('resource-grant')).toHaveCount(0);
  const revoke = await mutate<{ resource: CapabilityResourceDescriptor }>(`/api/capabilities/resources/${encodeURIComponent(current.resource.resourceRef)}`,
    revokeSection.getByTestId('resource-save'), recordGrantWrite);
  expect(revoke.body).toEqual({ expectedMetadataRevision: 1, expectedGrantsRevision: 2, grants: [] });
  const revoked = await readResource(); expect(revoked.metadata).toMatchObject({ metadataRevision: 1, grantsRevision: 3, responsibleUserId: adminId });
  expect(revoked.grants).toHaveLength(0);
  await assertDenied(member, memberWorkspaceId); await assertDenied(member, memberWorkspaceId, 'organization', null);
  await assertAllowed(admin, workspaceId);
  expect(unexpectedWrites).toEqual([]);
  console.info('OWN_MOBILE_PLUGIN_ACCESS_PASS: actual UI install/grant/revoke and authenticated mobile HTTP/PNG boundaries; no native-device or bearer-OAuth claim.');
});
