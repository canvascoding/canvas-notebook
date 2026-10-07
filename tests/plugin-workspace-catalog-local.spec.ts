import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { createAuthenticatedContext, requestManagedTestSession, runManagedTestPreflight } from './helpers/managed-test-context';
import { cleanupOwnedCapabilityPackageFixture, type OwnedCapabilityPackageFixture } from './helpers/capability-package-test-cleanup';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { PluginWorkspaceCatalogResponse } from '../app/lib/plugins/plugin-workspace-catalog-contracts';
import type { CanvasSkillStoreList } from '../app/lib/skills/canvas-skill-store';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import en from '../messages/en.json';

const nonce = process.env.CAPABILITY_CATALOG_E2E_NONCE || randomBytes(5).toString('hex');
const name = `package-editor-qa-${nonce}`, child = `catalog-context-${nonce}`, marker = `PRIVATE_CATALOG_METADATA_${nonce}`;
let admin: BrowserContext, member: BrowserContext, page: Page, adminId = '', memberId = '', memberWorkspace = '', adminWorkspace = '';
let receipt: OwnedCapabilityPackageFixture | undefined, source: CapabilityResourceDescriptor, artifacts = '', setupRecovery = '', organizationId = '';
let skillSettings: { file: string; previous: string | null; installed: string | null } | undefined;
test.use({ trace: 'off', video: 'off' });

async function readSettings(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function recovery(phase: string) {
  await fs.writeFile(setupRecovery, JSON.stringify({ phase, nonce, name, receipt, skillSettings }), { mode: 0o600 });
}

async function payload<T>(response: APIResponse, phase: string): Promise<T> {
  if (!response.ok()) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  return await response.json() as T;
}
async function catalog(query: Record<string, string>, context = member) {
  return (await payload<{ data: PluginWorkspaceCatalogResponse }>(await context.request.get(`/api/plugins/catalog?${new URLSearchParams({
    workspaceId: context === member ? memberWorkspace : adminWorkspace, ...query,
  })}`), 'Actual installed resource catalog')).data;
}
async function library(state: 'all' | 'updates' = 'all') {
  return payload<{ success: boolean } & CanvasSkillStoreList>(await member.request.get(`/api/skills/store?${new URLSearchParams({
    workspaceId: memberWorkspace, q: child, scope: 'user', state,
  })}`), 'Actual actor skill library');
}
async function openLibrary(view: 'library' | 'updates') {
  const loaded = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/skills/store' && url.searchParams.get('workspaceId') === memberWorkspace
      && url.searchParams.get('state') === (view === 'updates' ? 'updates' : 'all');
  });
  await page.goto(`/en/plugins?${new URLSearchParams({ area: 'skills', view, workspaceId: memberWorkspace })}`, { waitUntil: 'domcontentloaded' });
  expect((await loaded).status()).toBe(200);
  await expect(page.getByRole('tab', { name: en.skills.skillLibrary.tabs.library, exact: true })).toBeVisible();
}
async function grants(granted: boolean) {
  const response = await admin.request.patch(`/api/capabilities/resources/${encodeURIComponent(source.metadata.resourceRef)}`, { data: {
    expectedMetadataRevision: source.metadata.metadataRevision, expectedGrantsRevision: source.metadata.grantsRevision,
    grants: granted ? [{ targetType: 'user', targetId: memberId, canUse: true, canEdit: false, canManage: false }] : [],
  } });
  source = (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(response, 'Own resource grant change')).data.resource;
  receipt!.resourceRevisions[0].grantsRevision = source.metadata.grantsRevision;
  await recovery('configured');
}

test.describe('Actual actor-safe installed catalog and skill library', () => {
  test.describe.configure({ mode: 'serial', retries: 0, timeout: 180_000 });
  test.beforeAll(async ({ browser }) => {
    expect(nonce).toMatch(/^[a-f0-9]{10}$/u);
    const intake = process.env.CAPABILITY_PACKAGE_E2E_SOURCE_ROOT;
    const email = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
    const password = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
    if (!intake || !path.isAbsolute(intake) || !process.env.DATA || !email || !password) throw new Error('Own intake, managed DATA and existing member credentials are required.');
    admin = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } }); await runManagedTestPreflight(admin);
    member = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } }, { email, password }); await runManagedTestPreflight(member);
    adminId = (await payload<{ user: { id: string } }>(await requestManagedTestSession(admin.request), 'Actual admin identity')).user.id;
    const identity = (await payload<{ user: { id: string; role?: string } }>(await requestManagedTestSession(member.request), 'Actual member identity')).user;
    memberId = identity.id; expect(identity.role).not.toBe('admin');
    for (const context of [admin, member]) {
      const listing = await payload<{ organizationId: string; workspaces: ClientWorkspaceSummary[] }>(await context.request.get('/api/workspaces'), 'Actual existing personal workspaces');
      if (context === admin) { expect(listing.organizationId).toBeTruthy(); organizationId = listing.organizationId; }
      else expect(listing.organizationId).toBe(organizationId);
      const workspaces = listing.workspaces;
      const own = workspaces.find(workspace => workspace.type === 'personal' && workspace.status === 'active'
        && workspace.ownerUserId === (context === admin ? adminId : memberId));
      expect(own).toBeDefined(); if (context === admin) adminWorkspace = own!.id; else memberWorkspace = own!.id;
    }
    artifacts = await fs.mkdtemp(path.join(os.tmpdir(), `canvas-plugin-catalog-browser-${nonce}-`));
    const directory = await fs.mkdtemp(path.join(intake, `${name}-`));
    await fs.mkdir(path.join(directory, '.canvas-plugin')); await fs.mkdir(path.join(directory, 'skills', child), { recursive: true });
    await fs.writeFile(path.join(directory, '.canvas-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0', description: marker, skills: 'skills' }));
    await fs.writeFile(path.join(directory, 'skills', child, 'SKILL.md'), `---\nname: ${child}\ndescription: ${marker}\nmetadata:\n  version: "1.0.0"\n---\nPrivate package body ${nonce}.\n`);
    setupRecovery = path.join(artifacts, 'setup-recovery.json');
    expect(organizationId).toMatch(/^[a-zA-Z0-9_-]{1,200}$/u);
    const dataRoot = await fs.realpath(process.env.DATA);
    const file = path.join(dataRoot, 'organizations', organizationId, 'settings', 'skills.json');
    skillSettings = { file, previous: await readSettings(file), installed: null };
    await fs.writeFile(setupRecovery, JSON.stringify({ phase: 'installation-pending', nonce, name,
      sourceDirectory: directory, actorIds: [adminId, memberId], adminId, organizationId, skillSettings }), { mode: 0o600 });
    const installed = await payload<{ success: boolean; plugin: { resourceId: string; checksum: string; version: string; name: string } }>(await admin.request.post('/api/plugins/install', {
      data: { sourcePath: directory, scope: 'organization', enable: true, replace: false },
    }), 'Own nonce source installation'); expect(installed.success).toBe(true); expect(installed.plugin.name).toBe(name);
    receipt = { nonce, names: [name], actorIds: [adminId, memberId], adminId, organizationId, dataRoot: await fs.realpath(process.env.DATA),
      sourceDirectory: directory, sourceName: name, initialVersion: installed.plugin.version, initialChecksum: installed.plugin.checksum,
      publications: [], resourceRevisions: [] };
    skillSettings.installed = await readSettings(file);
    expect(await fs.realpath(file)).toBe(file);
    await recovery('installed');
    source = (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await admin.request.get(`/api/capabilities/resources/${encodeURIComponent(installed.plugin.resourceId)}`), 'Own exact source')).data.resource;
    expect(source.metadata.ownership).toEqual({ type: 'organization', organizationId });
    source = (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await admin.request.post(`/api/capabilities/resources/${encodeURIComponent(installed.plugin.resourceId)}`, { data: {
      expectedMetadataRevision: 0, expectedGrantsRevision: 0, ownership: { type: 'organization' }, accessMode: 'restricted', grants: [],
    } }), 'Own restricted source')).data.resource;
    receipt.sourceResourceRef = source.metadata.resourceRef;
    receipt.resourceRevisions.push({ resourceRef: source.metadata.resourceRef, metadataRevision: source.metadata.metadataRevision, grantsRevision: source.metadata.grantsRevision });
    await recovery('configured');
    page = await member.newPage(); await page.addInitScript(workspace => localStorage.setItem('canvas.activeWorkspaceId', workspace), memberWorkspace);
  });
  test.afterAll(async () => {
    const failures: unknown[] = [];
    if (page) await page.close().catch(error => failures.push(error));
    if (receipt) try {
      if (skillSettings) expect(await readSettings(skillSettings.file)).toBe(skillSettings.installed);
      await cleanupOwnedCapabilityPackageFixture(receipt);
      if (skillSettings) {
        // A concurrent unrelated change preserves the recovery record instead of being overwritten.
        expect(await readSettings(skillSettings.file)).toBe(skillSettings.installed);
        if (skillSettings.previous === null) await fs.rm(skillSettings.file);
        else {
          const temporary = `${skillSettings.file}.catalog-${nonce}.tmp`;
          await fs.writeFile(temporary, skillSettings.previous, { mode: 0o600 }); await fs.rename(temporary, skillSettings.file);
        }
        expect(await readSettings(skillSettings.file)).toBe(skillSettings.previous);
      }
      await fs.rm(setupRecovery);
    } catch (error) { failures.push(error); }
    else if (setupRecovery) failures.push(new Error(`Own setup outcome is incomplete; private recovery retained at ${setupRecovery}`));
    for (const context of [admin, member]) if (context) await context.close().catch(error => failures.push(error));
    if (failures.length) throw new AggregateError(failures, 'Own catalog fixture cleanup failed; unmatched resources are preserved.');
  });
  test('hidden organization source does not become installed state through the public store entry', async () => {
    expect((await catalog({ scope: 'organization', kind: 'plugin', q: name })).items).toEqual([]);
    expect((await catalog({ scope: 'user', audience: 'shared', q: name })).items).toEqual([]);
    const team = await catalog({ scope: 'team' }); expect(team.selection.selectionRequired).toBe('team'); expect(team.items).toEqual([]);
    expect((await member.request.get(`/api/plugins/catalog?scope=team&teamId=missing-${nonce}`)).status()).toBe(404);
    for (const query of ['scope=user&scope=organization', 'actorUserId=foreign', 'scope=user&teamId=foreign', 'limit=51']) {
      expect((await member.request.get(`/api/plugins/catalog?${query}`)).status()).toBe(400);
    }
    expect((await member.request.get(`/api/plugins/catalog?workspaceId=${encodeURIComponent(adminWorkspace)}`)).status()).toBe(403);
    const store = await library(); expect(store.comparison).toBe('unknown'); expect(store.skills).toHaveLength(1);
    expect(store.skills[0].installed.installed).toBe(false); expect(store.skills[0].installed.resources).toEqual([]);
    expect(store.skills[0].installed.version).toBeUndefined(); expect(store.skills[0].installed.installedSkill).toBeUndefined();
    expect(JSON.stringify(store)).not.toContain(marker); expect(JSON.stringify(store)).not.toContain(receipt!.sourceDirectory);
    const updates = await library('updates'); expect(updates.skills).toEqual([]); expect(updates.comparison).toBe('unknown');
    await openLibrary('library'); await expect(page.getByRole('heading', { name: `Catalog fixture ${nonce}`, exact: true })).toBeVisible();
    await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
  });
  test('exact organization ownership survives personal sharing and revocation in API and visible library', async () => {
    await grants(true); expect(source.metadata.grantsRevision).toBe(2);
    const shared = await catalog({ scope: 'user', audience: 'shared', kind: 'plugin', q: name }); expect(shared.items).toHaveLength(1);
    expect(shared.items[0].resourceRef).toBe(source.metadata.resourceRef); expect(shared.items[0].ownership.type).toBe('organization');
    expect(shared.items[0].access).toEqual({ canRead: true, canUse: true, canEdit: false, canManage: false });
    expect((await catalog({ scope: 'user', audience: 'own', kind: 'plugin', q: name })).items).toEqual([]);
    expect((await catalog({ scope: 'organization', kind: 'plugin', q: name })).items.map(item => item.resourceRef)).toEqual([source.metadata.resourceRef]);
    const children = await catalog({ scope: 'user', audience: 'shared', kind: 'skill', q: child }); expect(children.items).toHaveLength(1);
    expect(children.items[0].parentResourceRef).toBe(source.metadata.resourceRef);
    const safe = JSON.stringify(shared); for (const field of ['grants', 'checksum', 'installDir', 'sourcePath', 'manifestPath']) expect(safe).not.toContain(`"${field}"`);
    const store = await library(); expect(store.skills[0].installed.resources).toHaveLength(1); expect(store.skills[0].installed.comparison).toBe('unknown');
    expect(store.skills[0].installed.updateAvailable).toBe(false); expect(store.skills[0].installed.restoreAvailable).toBe(false);
    expect(store.skills[0].installed.installedSkill).toBeUndefined(); expect(JSON.stringify(store)).not.toContain(receipt!.sourceDirectory);
    await openLibrary('library'); await expect(page.getByText(en.skills.skillLibrary.comparisonUnknown, { exact: true })).toBeVisible();
    for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']] as const) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(value => localStorage.setItem('theme', value), theme); await openLibrary('library');
      await expect(page.getByText(en.skills.skillLibrary.comparisonUnknown, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(artifacts, `catalog-library-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
    await openLibrary('updates'); await expect(page.getByText(en.skills.skillLibrary.comparisonUnknown, { exact: true })).toBeVisible();
    await expect(page.getByText(en.skills.skillLibrary.noUpdates, { exact: true })).toHaveCount(0);
    await grants(false); expect(source.metadata.grantsRevision).toBe(3);
    expect((await catalog({ scope: 'user', audience: 'shared', q: name })).items).toEqual([]);
    expect((await library()).skills[0].installed.resources).toEqual([]);
    await openLibrary('library'); await expect(page.getByText(en.skills.skillLibrary.comparisonUnknown, { exact: true })).toHaveCount(0);
  });
});
