import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import { cleanupOwnedCapabilityPackageFixture, type OwnedCapabilityPackageFixture } from './helpers/capability-package-test-cleanup';
import type { CapabilityPackageState, CapabilityPackagePublishedSummary } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityResourceDescriptor, CapabilityResourceMetadata } from '../app/lib/capabilities/resources/contracts';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';

type Source = { kind: 'plugin'; registryId: string; entryKey: string; version: string; checksum: string };
type Fixture = { nonce: string; name: string; sourceDirectory: string; sources: [Source, Source, Source] };
type Result = { state: CapabilityPackageState; published: CapabilityPackagePublishedSummary; resource: CapabilityResourceMetadata };
type Review = { source: Source; canUpdate: boolean; localChanges: string; expectedMetadataRevision: number;
  expectedGrantsRevision: number; expectedPackageRevision: number; expectedPublishedRevisionRef: string | null; expectedLocalChecksum: string };
let fixture: Fixture, admin: BrowserContext, member: BrowserContext, page: Page;
let adminId = '', memberId = '', workspaceId = '', memberWorkspace = '', organizationId = '', artifacts = '', recovery = '';
let receipt: OwnedCapabilityPackageFixture | undefined, current: Result, resource: CapabilityResourceDescriptor;

test.use({ trace: 'off', video: 'off' });
async function data<T>(response: APIResponse, label: string): Promise<T> {
  if (!response.ok()) throw new Error(`${label} returned HTTP ${response.status()}.`);
  const body = await response.json() as { success: boolean; data: T };
  expect(body.success).toBe(true); return body.data;
}
function endpoint(suffix = '') {
  return `/api/capabilities/packages/${encodeURIComponent(current.state.resourceRef)}${suffix}?workspaceId=${encodeURIComponent(workspaceId)}`;
}
async function saveReceipt() {
  await fs.writeFile(recovery, JSON.stringify({ fixture, receipt }), { mode: 0o600 });
}
async function refreshResource() {
  resource = (await data<{ resource: CapabilityResourceDescriptor }>(await admin.request.get(
    `/api/capabilities/resources/${encodeURIComponent(current.state.resourceRef)}?workspaceId=${encodeURIComponent(workspaceId)}`), 'Exact installed metadata')).resource;
  receipt!.resourceRevisions = [{ resourceRef: resource.metadata.resourceRef,
    metadataRevision: resource.metadata.metadataRevision, grantsRevision: resource.metadata.grantsRevision }];
  await saveReceipt();
}
function updateRequest(review: Review) {
  return { source: review.source, expectedMetadataRevision: review.expectedMetadataRevision,
    expectedGrantsRevision: review.expectedGrantsRevision, expectedPackageRevision: review.expectedPackageRevision,
    expectedPublishedRevisionRef: review.expectedPublishedRevisionRef, expectedLocalChecksum: review.expectedLocalChecksum,
    replaceLocalChanges: false };
}
async function review(context = admin, source = fixture.sources[1]): Promise<Review> {
  const selectedWorkspace = context === admin ? workspaceId : memberWorkspace;
  return data<Review>(await context.request.post(`/api/capabilities/packages/${encodeURIComponent(current.state.resourceRef)}/store-update/review?workspaceId=${encodeURIComponent(selectedWorkspace)}`,
    { data: { source } }), 'Exact Store update review');
}

test.describe('Actual atomic Store import and scoped versioned update', () => {
  test.describe.configure({ mode: 'serial', retries: 0, timeout: 180_000 });
  test.beforeAll(async ({ browser }) => {
    const file = process.env.CAPABILITY_STORE_E2E_FIXTURE;
    if (!file || !path.isAbsolute(file) || !process.env.DATA) throw new Error('Private owned Store fixture and managed DATA are required.');
    fixture = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture;
    expect(fixture.nonce).toMatch(/^[a-f0-9]{10}$/u); expect(fixture.name).toBe(`package-editor-qa-${fixture.nonce}`);
    const email = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
    const password = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
    if (!email || !password) throw new Error('Existing managed member credentials are required.');
    admin = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } }); await runManagedTestPreflight(admin);
    member = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } }, { email, password }); await runManagedTestPreflight(member);
    adminId = (await (await requestManagedTestSession(admin.request)).json()).user.id;
    memberId = (await (await requestManagedTestSession(member.request)).json()).user.id;
    for (const context of [admin, member]) {
      const listing = await (await context.request.get('/api/workspaces')).json() as { organizationId: string; workspaces: ClientWorkspaceSummary[] };
      if (context === admin) organizationId = listing.organizationId; else expect(listing.organizationId).toBe(organizationId);
      const own = listing.workspaces.find(value => value.type === 'personal' && value.status === 'active'
        && value.ownerUserId === (context === admin ? adminId : memberId)); expect(own).toBeDefined();
      if (context === admin) workspaceId = own!.id; else memberWorkspace = own!.id;
    }
    artifacts = await fs.mkdtemp(path.join(os.tmpdir(), `canvas-package-store-browser-${fixture.nonce}-`));
    recovery = path.join(artifacts, 'setup-recovery.json'); await saveReceipt();
    const source = fixture.sources[0];
    current = await data<Result>(await admin.request.post(`/api/capabilities/packages/store/install?workspaceId=${encodeURIComponent(workspaceId)}`, {
      data: { source, ownership: { type: 'organization' }, grants: [{ targetType: 'user', targetId: memberId,
        canUse: true, canEdit: false, canManage: false }], responsibleUserId: memberId },
    }), 'Actual atomic Store installation');
    receipt = { nonce: fixture.nonce, names: [fixture.name], actorIds: [adminId, memberId], adminId, organizationId,
      dataRoot: await fs.realpath(process.env.DATA), sourceDirectory: fixture.sourceDirectory, sourceName: fixture.name,
      initialChecksum: source.checksum, initialVersion: source.version, initialManaged: true,
      sourceResourceRef: current.state.resourceRef, resourceRevisions: [], publications: [{ resourceRef: current.state.resourceRef,
        revisionRef: current.published.revisionRef, checksum: current.published.checksum, version: current.published.version }] };
    await saveReceipt(); await refreshResource(); page = await admin.newPage();
    await page.addInitScript(value => localStorage.setItem('canvas.activeWorkspaceId', value), workspaceId);
  });
  test.afterAll(async () => {
    const failures: unknown[] = [];
    if (page) await page.close().catch(error => failures.push(error));
    if (receipt) try { await cleanupOwnedCapabilityPackageFixture(receipt); await fs.rm(recovery); }
    catch (error) { failures.push(error); }
    else if (recovery) failures.push(new Error(`Store installation outcome requires inspection; private receipt retained at ${recovery}`));
    for (const context of [admin, member]) if (context) await context.close().catch(error => failures.push(error));
    if (failures.length) throw new AggregateError(failures, 'Own Store fixture cleanup stopped at a guard.');
  });
  test('first commit contains exact scope, restricted grants, responsible person and immutable version', async () => {
    expect(resource.metadata.ownership).toEqual({ type: 'organization', organizationId });
    expect(resource.metadata.accessMode).toBe('restricted'); expect(resource.metadata.responsibleUserId).toBe(memberId);
    expect(resource.metadata.metadataRevision).toBe(1); expect(resource.metadata.grantsRevision).toBe(1);
    expect(resource.grants).toHaveLength(1); expect(resource.grants![0].targetId).toBe(memberId);
    expect(current.state.packageRevision).toBe(1); expect(current.published.version).toBe('1.0.0');
    const installed = await data<{ package: { defaultEnabled: boolean } }>(await admin.request.get(endpoint()), 'Actual managed package');
    expect(installed.package.defaultEnabled).toBe(false);
    const memberView = (await data<{ resource: CapabilityResourceDescriptor }>(await member.request.get(
      `/api/capabilities/resources/${encodeURIComponent(current.state.resourceRef)}?workspaceId=${encodeURIComponent(memberWorkspace)}`), 'Granted current reader')).resource;
    expect(memberView.access).toEqual({ canRead: true, canUse: true, canEdit: false, canManage: false });
    expect(memberView.grants).toBeUndefined();
    const safe = JSON.stringify(await data<unknown>(await admin.request.get(`/api/capabilities/packages/store?kind=plugin&q=${fixture.name}&workspaceId=${encodeURIComponent(workspaceId)}`), 'Safe central Store discovery'));
    expect(safe).toContain(fixture.name);
    for (const key of ['storeOrigin', 'registryIdentity', 'downloadUrl', 'installDir', 'sourcePath']) expect(safe).not.toContain(`"${key}"`);
  });
  test('reviewed exact update preserves sharing and history; current reader cannot publish', async () => {
    const readerReview = await review(member); expect(readerReview.canUpdate).toBe(false);
    expect((await member.request.post(`/api/capabilities/packages/${encodeURIComponent(current.state.resourceRef)}/store-update?workspaceId=${encodeURIComponent(memberWorkspace)}`,
      { data: updateRequest(readerReview) })).status()).toBe(403);
    const selected = await review(); expect(selected.canUpdate).toBe(true); expect(selected.localChanges).toBe('unchanged');
    const oldRef = current.published.revisionRef;
    current = await data<Result>(await admin.request.post(endpoint('/store-update'), { data: updateRequest(selected) }), 'Actual exact versioned update');
    receipt!.publications.push({ resourceRef: current.state.resourceRef, revisionRef: current.published.revisionRef,
      checksum: current.published.checksum, version: current.published.version }); await saveReceipt(); await refreshResource();
    expect(current.state.packageRevision).toBe(2); expect(current.published.version).toBe('2.0.0');
    expect(resource.metadata.responsibleUserId).toBe(memberId); expect(resource.metadata.metadataRevision).toBe(1);
    expect(resource.metadata.grantsRevision).toBe(1); expect(resource.grants).toHaveLength(1);
    const old = await data<{ file: { content: string } }>(await admin.request.get(`${endpoint('/file')}&path=README.md&revisionRef=${encodeURIComponent(oldRef)}`), 'Immutable original Store version');
    expect(Buffer.from(old.file.content, 'base64').toString()).toBe(`Store body v1 ${fixture.nonce}.\n`);
    const versions = await data<{ versions: CapabilityPackagePublishedSummary[] }>(await admin.request.get(endpoint('/versions')), 'Actual preserved version history');
    expect(versions.versions.map(value => value.version).sort()).toEqual(['1.0.0', '2.0.0']);
    const url = `/en/plugins?${new URLSearchParams({ view: 'installed', scope: 'organization', plugin: fixture.name,
      source: 'installed', resourceRef: current.state.resourceRef, task: 'versions', workspaceId })}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']] as const) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(value => localStorage.setItem('theme', value), theme);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: fixture.name, exact: true }).first()).toBeVisible();
      await expect(page.getByRole('dialog', { name: fixture.name, exact: true }).getByText('v2.0.0', { exact: true }).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(artifacts, `store-version-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
  });
  test('stale head, changed grants and revoked current read cannot overwrite the exact variant', async () => {
    const selected = await review(admin, fixture.sources[2]);
    expect((await admin.request.post(endpoint('/store-update'), { data: { ...updateRequest(selected), expectedPackageRevision: 1 } })).status()).toBe(409);
    resource = (await data<{ resource: CapabilityResourceDescriptor }>(await admin.request.patch(
      `/api/capabilities/resources/${encodeURIComponent(current.state.resourceRef)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        data: { expectedMetadataRevision: resource.metadata.metadataRevision, expectedGrantsRevision: resource.metadata.grantsRevision, grants: [] },
      }), 'Own initial grant revocation')).resource;
    receipt!.resourceRevisions[0].grantsRevision = resource.metadata.grantsRevision; await saveReceipt();
    expect((await admin.request.post(endpoint('/store-update'), { data: updateRequest(selected) })).status()).toBe(409);
    expect((await member.request.post(`/api/capabilities/packages/${encodeURIComponent(current.state.resourceRef)}/store-update/review?workspaceId=${encodeURIComponent(memberWorkspace)}`,
      { data: { source: fixture.sources[2] } })).status()).toBe(404);
    const unchanged = await data<{ package: { state: CapabilityPackageState } }>(await admin.request.get(endpoint()), 'Actual unchanged content head');
    expect(unchanged.package.state.currentPublishedRevisionRef).toBe(current.published.revisionRef); expect(unchanged.package.state.packageRevision).toBe(2);
  });
});
