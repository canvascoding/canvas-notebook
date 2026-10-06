import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Page, type Response, type TestInfo } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import { cleanupOwnedCapabilityPackageFixture, type OwnedCapabilityPackageFixture } from './helpers/capability-package-test-cleanup';
import type { CapabilityPackageDescriptor, CapabilityPackageDraft, CapabilityPackageOwnedDraftList,
  CapabilityPackageOwnedDraftStatus } from '../app/lib/capabilities/packages/contracts';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';

const nonce = randomBytes(5).toString('hex'), name = `package-editor-qa-${nonce}`, child = `private-draft-context-${nonce}`;
const script = `skills/${child}/scripts/run.js`, originalText = 'process.stdout.write("OWN_DRAFT_INITIAL");\n';
const savedText = 'process.stdout.write("OWN_DRAFT_SAVED");\n', dirtyText = 'process.stdout.write("OWN_DRAFT_UNSAVED");\n';
const labels = en.skills.drafts, editorLabels = en.skills.packageEditor;
let admin: BrowserContext, member: BrowserContext, page: Page;
let adminId = '', memberId = '', memberWorkspace = '', adminWorkspace = '', sourceRef = '', artifacts = '';
let receipt: OwnedCapabilityPackageFixture | undefined, currentDraft: CapabilityPackageDraft;
const remainingDrafts = new Set<string>();
test.use({ trace: 'off', video: 'off' });

type HttpResponse = Pick<APIResponse | Response, 'ok' | 'status' | 'json'>;
async function payload<T>(response: HttpResponse, phase: string): Promise<T> {
  if (!response.ok()) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  return await response.json() as T;
}
const draftPath = (ref: string, suffix = '') => `/api/capabilities/packages/drafts/${encodeURIComponent(ref)}${suffix}`;
const sourcePath = () => `/api/capabilities/packages/${encodeURIComponent(sourceRef)}`;
async function readResource(): Promise<CapabilityResourceDescriptor> {
  return (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await admin.request.get(`/api/capabilities/resources/${encodeURIComponent(sourceRef)}`), 'Own resource snapshot')).data.resource;
}
async function createDraft() {
  const descriptor = (await payload<{ data: { package: CapabilityPackageDescriptor } }>(await member.request.get(sourcePath()), 'Actual member package access')).data.package;
  currentDraft = (await payload<{ data: { draft: CapabilityPackageDraft } }>(await member.request.post('/api/capabilities/packages/drafts', { data: {
    operation: 'edit', resourceRef: sourceRef, expectedMetadataRevision: descriptor.resource.metadataRevision,
    expectedGrantsRevision: descriptor.resource.grantsRevision, expectedPackageRevision: descriptor.state?.packageRevision ?? 0,
    expectedPublishedRevisionRef: descriptor.state?.currentPublishedRevisionRef ?? null,
  } }), 'Actual member private draft')).data.draft;
  expect(currentDraft.actorUserId).toBe(memberId); remainingDrafts.add(currentDraft.draftRef); return currentDraft;
}
async function hydrate(target: Page, url: string) {
  const hydration = target.waitForResponse(response => new URL(response.url()).pathname === '/api/workspaces' && response.request().method() === 'GET');
  await target.goto(url, { waitUntil: 'domcontentloaded' });
  const workspaces = (await payload<{ workspaces: ClientWorkspaceSummary[] }>(await hydration, 'Actual workspace hydration')).workspaces;
  await expect.poll(async () => {
    const active = await target.evaluate(() => localStorage.getItem('canvas.activeWorkspaceId'));
    return workspaces.some(workspace => workspace.id === active && workspace.status === 'active' && workspace.permissions.canRead);
  }).toBe(true);
}
async function hub(target = page) {
  const listed = target.waitForResponse(response => new URL(response.url()).pathname === '/api/capabilities/packages/drafts' && response.request().method() === 'GET');
  await hydrate(target, `/en/plugins?${new URLSearchParams({ view: 'drafts', workspaceId: target === page ? memberWorkspace : adminWorkspace })}`);
  const list = (await payload<{ data: CapabilityPackageOwnedDraftList }>(await listed, 'Actual creator draft listing')).data;
  await expect(target.getByTestId('package-drafts-section')).toBeVisible(); return list;
}
const ownRow = (target = page) => target.getByTestId('package-draft-row').filter({ hasText: name });
async function resume(target = page) {
  const status = target.waitForResponse(response => new URL(response.url()).pathname === draftPath(currentDraft.draftRef, '/status') && response.request().method() === 'GET');
  await ownRow(target).getByRole('button', { name: labels.open, exact: true }).click();
  const value = (await payload<{ data: { status: CapabilityPackageOwnedDraftStatus } }>(await status, 'Current creator recovery status')).data.status;
  expect(value.sourceResourceRef).toBe(sourceRef);
  await expect(target.getByTestId('package-editor')).toBeVisible();
  await expect(target.getByTestId('package-editor').getByText(editorLabels.loading, { exact: true })).toHaveCount(0);
  const parameters = new URL(target.url()).searchParams;
  expect(parameters.get('resourceRef')).toBe(sourceRef); expect(parameters.get('draftRef')).toBe(currentDraft.draftRef);
}
async function chooseScript() {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === draftPath(currentDraft.draftRef, '/file')
    && new URL(value.url()).searchParams.get('path') === script && value.request().method() === 'GET');
  await page.getByTestId('package-file-picker').selectOption(script); await payload(await response, 'Actual private script read');
  await expect(page.getByTestId('package-file-content')).toBeVisible();
}
async function cancelNavigation(trigger: () => Promise<unknown>) {
  const before = page.url();
  const dialog = new Promise<void>(resolve => page.once('dialog', async value => {
    expect(value.type()).toBe('confirm'); expect(value.message()).toBe(labels.unsavedNavigation); await value.dismiss(); resolve();
  }));
  await trigger(); await dialog; await expect.poll(() => page.url()).toBe(before);
  await expect(page.getByTestId('package-file-content')).toHaveValue(dirtyText);
}
async function screenshot(info: TestInfo, width: number, theme: 'light' | 'dark') {
  const file = path.join(artifacts, `draft-editor-${width}-${theme}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  await info.attach(`draft-editor-${width}-${theme}`, { path: file, contentType: 'image/png' });
}
function recordResource(value: CapabilityResourceDescriptor) {
  const revision = receipt!.resourceRevisions.find(item => item.resourceRef === sourceRef)!;
  revision.metadataRevision = value.metadata.metadataRevision; revision.grantsRevision = value.metadata.grantsRevision;
}

test.describe('Actual global creator-private package draft navigation', () => {
  test.describe.configure({ mode: 'serial', retries: 0, timeout: 180_000 });
  test.beforeAll(async ({ browser }) => {
    const intake = process.env.CAPABILITY_PACKAGE_E2E_SOURCE_ROOT || process.env.CAPABILITY_RESOURCE_E2E_SOURCE_ROOT;
    const email = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
    const password = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
    if (!intake || !path.isAbsolute(intake) || !process.env.DATA || !email || !password) throw new Error('Managed DATA, own intake and existing member credentials are required.');
    admin = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } }); await runManagedTestPreflight(admin);
    member = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } }, { email, password }); await runManagedTestPreflight(member);
    adminId = (await payload<{ user: { id: string } }>(await requestManagedTestSession(admin.request), 'Actual admin identity')).user.id;
    const identity = (await payload<{ user: { id: string; role?: string } }>(await requestManagedTestSession(member.request), 'Actual member identity')).user;
    memberId = identity.id; expect(identity.role).not.toBe('admin');
    for (const context of [admin, member]) {
      const scopes = (await payload<{ workspaces: ClientWorkspaceSummary[] }>(await context.request.get('/api/workspaces'), 'Actual personal context')).workspaces;
      const own = scopes.find(workspace => workspace.type === 'personal' && workspace.status === 'active' && workspace.ownerUserId === (context === admin ? adminId : memberId));
      expect(own).toBeDefined(); if (context === admin) adminWorkspace = own!.id; else memberWorkspace = own!.id;
    }
    artifacts = await fs.mkdtemp(path.join(os.tmpdir(), `canvas-private-drafts-browser-${nonce}-`));
    await fs.mkdir(intake, { recursive: true }); const directory = await fs.mkdtemp(path.join(intake, `${name}-`));
    await fs.mkdir(path.join(directory, '.canvas-plugin')); await fs.mkdir(path.join(directory, 'skills', child, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(directory, '.canvas-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'Owned global private draft acceptance', skills: 'skills' }));
    await fs.writeFile(path.join(directory, 'skills', child, 'SKILL.md'), `---\nname: ${child}\ndescription: Creator-private package context\nmetadata:\n  version: "1.0.0"\n---\nRead the bundled script.\n`);
    await fs.writeFile(path.join(directory, script), originalText);
    const installed = await payload<{ success: boolean; plugin: { resourceId: string; checksum: string; version: string; name: string } }>(await admin.request.post('/api/plugins/install', {
      data: { sourcePath: directory, scope: 'organization', enable: true, replace: false },
    }), 'Own nonce plugin installation'); expect(installed.success).toBe(true); expect(installed.plugin.name).toBe(name);
    const baseline = (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await admin.request.get(`/api/capabilities/resources/${encodeURIComponent(installed.plugin.resourceId)}`), 'Own installed metadata')).data.resource;
    expect(baseline.metadata.ownership.type).toBe('organization');
    const organizationId = baseline.metadata.ownership.type === 'organization' ? baseline.metadata.ownership.organizationId : '';
    receipt = { nonce, names: [name], actorIds: [adminId, memberId], adminId, organizationId, dataRoot: await fs.realpath(process.env.DATA),
      sourceDirectory: directory, sourceName: name, initialVersion: installed.plugin.version, initialChecksum: installed.plugin.checksum,
      publications: [], resourceRevisions: [] };
    const configured = (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await admin.request.post(`/api/capabilities/resources/${encodeURIComponent(installed.plugin.resourceId)}`, { data: {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, accessMode: 'restricted', ownership: { type: 'organization' },
      grants: [{ targetType: 'user', targetId: memberId, canUse: true, canEdit: true, canManage: false }],
    } }), 'Actual member use/edit grant')).data.resource;
    sourceRef = configured.metadata.resourceRef; receipt.sourceResourceRef = sourceRef;
    receipt.resourceRevisions.push({ resourceRef: sourceRef, metadataRevision: configured.metadata.metadataRevision, grantsRevision: configured.metadata.grantsRevision });
    await createDraft(); page = await member.newPage();
    await page.addInitScript(({ workspace, resource }) => {
      localStorage.setItem('canvas.activeWorkspaceId', workspace);
      for (const key of Object.keys(localStorage)) if (key.startsWith(`canvas-private-package-draft:${resource}:`)) localStorage.removeItem(key);
    }, { workspace: memberWorkspace, resource: sourceRef });
  });
  test.afterAll(async () => {
    const failures: unknown[] = [];
    if (page) await page.close().catch(error => failures.push(error));
    if (member) for (const ref of remainingDrafts) {
      try {
        const response = await member.request.get(draftPath(ref, '/status'));
        if (response.status() === 404) continue;
        const status = (await payload<{ data: { status: CapabilityPackageOwnedDraftStatus } }>(response, 'Own draft cleanup status')).data.status;
        expect(status.draftRef).toBe(ref); expect(status.name).toBe(name); expect(status.sourceResourceRef).toBe(sourceRef);
        await payload(await member.request.delete(draftPath(ref), { data: { expectedDraftRevision: status.draftRevision } }), 'Own creator draft cleanup');
      } catch (error) { failures.push(error); }
    }
    if (receipt) try { await cleanupOwnedCapabilityPackageFixture(receipt); } catch (error) { failures.push(error); }
    for (const context of [admin, member]) if (context) await context.close().catch(error => failures.push(error));
    if (failures.length) throw new AggregateError(failures, 'Own private-draft fixture cleanup failed; unmatched resources are preserved.');
  });

  test('global navigation resumes without localStorage and cancels dirty Back, Forward and Home', async ({}, info) => {
    const list = await hub(); expect(list.drafts.some(draft => draft.draftRef === currentDraft.draftRef)).toBe(true);
    await resume(); await page.getByRole('button', { name: labels.backToDrafts, exact: true }).click();
    await expect(ownRow()).toBeVisible(); await resume();
    await page.goBack(); await expect(ownRow()).toBeVisible(); await page.goBack(); await expect(page.getByTestId('package-editor')).toBeVisible();
    await expect(page.getByTestId('package-editor').getByText(editorLabels.loading, { exact: true })).toHaveCount(0);
    await chooseScript(); await expect(page.getByTestId('package-file-content')).toHaveValue(originalText);
    await page.getByTestId('package-file-content').fill(dirtyText);
    const writes: string[] = [];
    const observe = (request: import('@playwright/test').Request) => { if (new URL(request.url()).pathname.startsWith('/api/capabilities/packages/') && request.method() !== 'GET') writes.push(request.method()); };
    page.on('request', observe);
    await cancelNavigation(() => page.getByRole('button', { name: labels.backToDrafts, exact: true }).click());
    await cancelNavigation(() => page.evaluate(() => window.history.back()));
    await cancelNavigation(() => page.evaluate(() => window.history.forward()));
    await page.getByRole('button', { name: en.common.openNavigationMenu, exact: true }).click();
    await cancelNavigation(() => page.getByRole('menuitem', { name: en.common.home, exact: true }).click());
    expect(writes).toEqual([]);
    const save = page.waitForResponse(response => new URL(response.url()).pathname === draftPath(currentDraft.draftRef, '/file') && response.request().method() === 'PUT');
    await page.getByTestId('package-file-content').fill(savedText); await page.getByTestId('package-save-file').click();
    currentDraft = (await payload<{ data: { draft: CapabilityPackageDraft } }>(await save, 'Explicit actual draft save')).data.draft;
    expect(currentDraft.draftRevision).toBe(2); expect(writes).toEqual(['PUT']); page.off('request', observe);
    await expect(page.getByTestId('package-editor').getByText(editorLabels.fileSaved, { exact: true })).toBeVisible();
    await expect(page.getByTestId('package-file-content')).toBeEnabled();
    await expect(page.getByTestId('package-save-file')).toBeDisabled();
    await page.getByRole('button', { name: labels.backToDrafts, exact: true }).click(); await expect(ownRow()).toBeVisible(); await resume(); await chooseScript();
    await expect(page.getByTestId('package-file-content')).toHaveValue(savedText);
    for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']] as const) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(value => localStorage.setItem('theme', value), theme);
      await hydrate(page, page.url()); await chooseScript(); await expect(page.getByTestId('package-file-content')).toHaveValue(savedText);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      expect(await page.getByTestId('package-editor').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await screenshot(info, width, theme);
    }
  });

  test('revoked source stays hidden while global recovery, stale discard and creator cleanup remain available', async () => {
    await hub(); const before = await readResource();
    if (!before.grants) throw new Error('The own fixture manager must receive its grant snapshot.');
    const grantInput = before.grants.map(({ targetType, targetId, canUse, canEdit, canManage }) => ({ targetType, targetId, canUse, canEdit, canManage }));
    currentDraft = (await payload<{ data: { draft: CapabilityPackageDraft } }>(await member.request.put(draftPath(currentDraft.draftRef, '/file'), { data: {
      expectedDraftRevision: currentDraft.draftRevision, path: script, encoding: 'base64', content: Buffer.from('process.stdout.write("CONCURRENT_OWN_SAVE");\n').toString('base64'),
    } }), 'Concurrent creator draft save')).data.draft;
    let revoked: CapabilityResourceDescriptor | undefined;
    try {
      revoked = (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await admin.request.patch(`/api/capabilities/resources/${encodeURIComponent(sourceRef)}`, { data: {
        expectedMetadataRevision: before.metadata.metadataRevision, expectedGrantsRevision: before.metadata.grantsRevision, grants: [],
      } }), 'Actual source access revocation')).data.resource; recordResource(revoked); expect(revoked.metadata.grantsRevision).toBe(2);
      expect((await member.request.get(sourcePath())).status()).toBe(404);
      const plugins = await payload<{ plugins: Array<{ resourceId: string }> }>(await member.request.get(`/api/plugins?workspaceId=${encodeURIComponent(memberWorkspace)}`), 'Actual hidden source catalog');
      expect(plugins.plugins.some(plugin => plugin.resourceId === revoked!.metadata.legacyResourceId)).toBe(false);
      const stale = page.waitForResponse(response => new URL(response.url()).pathname === draftPath(currentDraft.draftRef) && response.request().method() === 'DELETE');
      await ownRow().getByRole('button', { name: labels.discard, exact: true }).click(); expect((await stale).status()).toBe(409);
      await expect(ownRow()).toBeVisible(); await expect(page.getByTestId('package-drafts-section').getByRole('alert')).toHaveText(labels.conflict);
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/capabilities/packages/drafts' && response.request().method() === 'GET');
      await page.getByTestId('package-drafts-section').getByRole('button', { name: labels.refresh, exact: true }).click(); await payload(await refreshed, 'Explicit own list reload after conflict');
      const fresh = await hub(); expect(fresh.drafts.find(draft => draft.draftRef === currentDraft.draftRef)?.draftRevision).toBe(currentDraft.draftRevision);
      const forbiddenRequests: string[] = [];
      const observe = (request: import('@playwright/test').Request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname.startsWith(draftPath(currentDraft.draftRef)) && /\/(?:tree|file|validate|publish)$/u.test(pathname)) forbiddenRequests.push(pathname);
      };
      page.on('request', observe); await resume(); await expect(page.getByTestId('package-discard')).toBeEnabled();
      for (const id of ['package-file-content', 'package-validate', 'package-publish']) await expect(page.getByTestId(id)).toHaveCount(0);
      expect(forbiddenRequests).toEqual([]); page.off('request', observe);
      expect((await member.request.get(draftPath(currentDraft.draftRef, '/tree'))).status()).toBe(403);
      await page.getByRole('button', { name: labels.backToDrafts, exact: true }).click(); await expect(ownRow()).toBeVisible();
      const discarded = page.waitForResponse(response => new URL(response.url()).pathname === draftPath(currentDraft.draftRef) && response.request().method() === 'DELETE');
      await ownRow().getByRole('button', { name: labels.discard, exact: true }).click(); await payload(await discarded, 'Actual revoked creator discard');
      remainingDrafts.delete(currentDraft.draftRef); await expect(ownRow()).toHaveCount(0);
      expect((await member.request.get(draftPath(currentDraft.draftRef, '/status'))).status()).toBe(404);
    } finally {
      if (revoked) {
        const restored = (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await admin.request.patch(`/api/capabilities/resources/${encodeURIComponent(sourceRef)}`, { data: {
          expectedMetadataRevision: revoked.metadata.metadataRevision, expectedGrantsRevision: revoked.metadata.grantsRevision, grants: grantInput,
        } }), 'Restore exact own grant inputs')).data.resource; recordResource(restored);
        expect(restored.grants?.map(({ targetType, targetId, canUse, canEdit, canManage }) => ({ targetType, targetId, canUse, canEdit, canManage }))).toEqual(grantInput);
      }
    }
  });

  test('organization management cannot list or resume another creator draft', async () => {
    await createDraft();
    const list = (await payload<{ data: CapabilityPackageOwnedDraftList }>(await admin.request.get('/api/capabilities/packages/drafts'), 'Actual admin own draft list')).data;
    expect(list.drafts.some(draft => draft.draftRef === currentDraft.draftRef)).toBe(false);
    expect((await admin.request.get(draftPath(currentDraft.draftRef, '/status'))).status()).toBe(404);
    const foreign = await admin.newPage(), requests: string[] = [];
    await foreign.addInitScript(workspace => localStorage.setItem('canvas.activeWorkspaceId', workspace), adminWorkspace);
    foreign.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === sourcePath() || pathname.startsWith(`${sourcePath()}/`)) requests.push(pathname);
    });
    try {
      const denied = foreign.waitForResponse(response => new URL(response.url()).pathname === draftPath(currentDraft.draftRef, '/status'));
      await hydrate(foreign, `/en/plugins?${new URLSearchParams({ view: 'drafts', resourceRef: sourceRef, draftRef: currentDraft.draftRef, task: 'content', workspaceId: adminWorkspace })}`);
      expect((await denied).status()).toBe(404); await expect(foreign.getByTestId('package-editor').getByRole('alert')).toBeVisible();
      for (const id of ['package-file-content', 'package-discard', 'package-validate', 'package-publish']) await expect(foreign.getByTestId(id)).toHaveCount(0);
      expect(requests).toEqual([]);
    } finally { await foreign.close(); }
  });
});
