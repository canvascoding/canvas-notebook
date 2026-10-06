import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIResponse, type BrowserContext, type Page } from '@playwright/test';
import { createAuthenticatedContext, runManagedTestPreflight } from './helpers/managed-test-context';
import type { CapabilityResourceDescriptor } from '../app/lib/capabilities/resources/contracts';
import type { OrganizationPolicyTargetCatalog } from '../app/lib/organization/policy-targets';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import type { WorkspaceMemberRecord } from '../app/lib/workspaces/contracts';
import en from '../messages/en.json';

type InstalledPlugin = { name: string; resourceId: string; checksum: string; version: string; scopeType?: string };
const nonce = randomBytes(5).toString('hex');
const name = `resource-management-qa-${nonce}`;
const labels = en.skills.resourceManagement;
let admin: BrowserContext;
let member: BrowserContext;
let installed: InstalledPlugin | null = null;
let sourceDirectory: string | null = null;
let memberId = '';
let teamId = '';
let teamSearch = '';
let memberSearch = '';
let resourceRef = '';
let ownedTeam: { snapshot: ClientWorkspaceSummary; creatorId: string; memberSnapshot: string | null } | null = null;
test.use({ trace: 'off', video: 'off' });

async function payload<T>(response: Pick<APIResponse, 'ok' | 'status' | 'json'>, phase: string): Promise<T> {
  if (!response.ok()) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  return await response.json() as T;
}

function resourcePath(ref = resourceRef) {
  return `/api/capabilities/resources/${encodeURIComponent(ref)}`;
}

async function inspect(context = admin): Promise<CapabilityResourceDescriptor> {
  return (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await context.request.get(resourcePath()), 'Resource inspection')).data.resource;
}

async function openDetails(page: Page) {
  const query = new URLSearchParams({ view: 'installed', scope: 'organization', plugin: name, source: 'installed', resourceId: installed!.resourceId });
  await page.goto(`/en/plugins?${query}`, { waitUntil: 'domcontentloaded' });
  const section = page.getByTestId('resource-management');
  await expect(section.getByRole('heading', { name: labels.title, exact: true })).toBeVisible();
  await expect(section.getByText(labels.loading, { exact: true })).toHaveCount(0);
  return section;
}

async function editDetails(page: Page) {
  const section = await openDetails(page);
  await section.locator('summary').filter({ hasText: labels.edit }).click();
  await expect(section.getByTestId('resource-display-name')).toBeVisible();
  return section;
}

async function save(page: Page, expectedMethod: 'POST' | 'PATCH' = 'PATCH') {
  const response = page.waitForResponse(value => new URL(value.url()).pathname.startsWith('/api/capabilities/resources/')
    && !new URL(value.url()).pathname.endsWith('/targets') && value.request().method() === expectedMethod);
  await page.getByTestId('resource-save').click();
  const result = await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await response, 'UI resource save');
  await expect(page.getByTestId('resource-save')).toBeEnabled();
  return result.data.resource;
}

async function choose(page: Page, picker: string, targetId: string, query: string, keyboard = false) {
  const trigger = page.getByTestId(picker);
  await trigger.click();
  const controls = await trigger.getAttribute('aria-controls');
  if (!controls) throw new Error('The active resource picker did not identify its popover.');
  const popover = page.getByTestId('resource-management').locator(`[data-slot="popover-content"][data-state="open"][id=${JSON.stringify(controls)}]`);
  await expect(popover).toBeVisible();
  const search = popover.getByRole('combobox', { name: labels.searchTargets, exact: true });
  await search.fill(query);
  await expect(search).toBeFocused();
  const option = popover.getByTestId(`${picker}-option-${targetId}`);
  await expect(option).toBeVisible();
  if (keyboard) {
    await search.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(popover).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible();
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-controls', controls);
    await expect(popover).toBeVisible();
    await search.fill(query);
    await expect(search).toBeFocused();
    await search.press('ArrowDown');
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await search.press('Enter');
  } else await option.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible();
}

test.describe('Actual resource management UI and API', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000, retries: 0 });
  test.beforeAll(async ({ browser }) => {
    const intakeRoot = process.env.CAPABILITY_RESOURCE_E2E_SOURCE_ROOT;
    const email = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
    const password = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
    if (!intakeRoot || !path.isAbsolute(intakeRoot)) throw new Error('CAPABILITY_RESOURCE_E2E_SOURCE_ROOT must identify the running server’s absolute local plugin intake directory.');
    if (!email || !password) throw new Error('Actual non-admin TEST_SECONDARY_EMAIL/PASSWORD are required; this acceptance suite never silently skips.');
    admin = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } });
    await runManagedTestPreflight(admin);
    member = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } }, { email, password });
    await runManagedTestPreflight(member);
    const identity = await payload<{ user: { id: string; role?: string } }>(await member.request.get('/api/auth/get-session'), 'Member identity');
    memberId = identity.user.id;
    if (identity.user.role === 'admin') throw new Error('Resource sharing acceptance requires an actual non-admin member.');
    const owner = await payload<{ user: { id: string } }>(await admin.request.get('/api/auth/get-session'), 'Owner identity');
    const existing = await payload<{ plugins: InstalledPlugin[] }>(await admin.request.get('/api/plugins?scope=organization'), 'Existing organization plugins');
    if (existing.plugins.some(plugin => plugin.name === name)) throw new Error('The temporary plugin name already exists; preservation required.');
    await fs.mkdir(intakeRoot, { recursive: true });
    sourceDirectory = await fs.mkdtemp(path.join(intakeRoot, `${name}-`));
    await fs.mkdir(path.join(sourceDirectory, '.canvas-plugin'));
    await fs.mkdir(path.join(sourceDirectory, 'skills', 'resource-management-context'), { recursive: true });
    await fs.writeFile(path.join(sourceDirectory, '.canvas-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'Resource management acceptance package', skills: 'skills' }));
    await fs.writeFile(path.join(sourceDirectory, 'skills', 'resource-management-context', 'SKILL.md'), '---\nname: resource-management-context\ndescription: Resource management acceptance context\n---\n\nDescribe a design task clearly.\n');
    const created = await payload<{ success: boolean; plugin: InstalledPlugin }>(await admin.request.post('/api/plugins/install', {
      data: { sourcePath: sourceDirectory, scope: 'organization', enable: true, replace: false },
    }), 'Actual plugin installation');
    expect(created.success).toBe(true);
    installed = created.plugin;
    expect(installed.name).toBe(name);
    const initial = (await payload<{ data: { resource: CapabilityResourceDescriptor } }>(await admin.request.get(resourcePath(installed.resourceId)), 'Unmanaged resource inspection')).data.resource;
    resourceRef = initial.metadata.resourceRef;
    expect(initial.metadata.metadataRevision).toBe(0);
    let targetCatalog = (await payload<{ data: { targets: OrganizationPolicyTargetCatalog } }>(await admin.request.get(`${resourcePath(installed.resourceId)}/targets`), 'Manager target catalog')).data.targets;
    expect(targetCatalog.users.some(user => user.userId === memberId)).toBe(true);
    const selectedMember = targetCatalog.users.find(user => user.userId === memberId)!;
    memberSearch = selectedMember.email || selectedMember.name || selectedMember.userId;
    let team = targetCatalog.workspaces.find(workspace => workspace.type === 'team'
      && (!process.env.CAPABILITY_RESOURCE_E2E_TEAM_ID || workspace.workspaceId === process.env.CAPABILITY_RESOURCE_E2E_TEAM_ID));
    if (!team) {
      const createdTeam = (await payload<{ workspace: ClientWorkspaceSummary }>(await admin.request.post('/api/workspaces', {
        data: { type: 'team', name: `Resource management QA ${nonce}`, description: `Owned resource-management acceptance ${nonce}` },
      }), 'Owned actual team creation')).workspace;
      ownedTeam = { snapshot: createdTeam, creatorId: owner.user.id, memberSnapshot: null };
      expect(createdTeam.type).toBe('team');
      expect(createdTeam.isDefault).toBe(false);
      expect(createdTeam.status).toBe('active');
      const memberships = (await payload<{ members: WorkspaceMemberRecord[] }>(await admin.request.get(`/api/workspaces/${encodeURIComponent(createdTeam.id)}/members`), 'Owned team creator membership')).members;
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({ workspaceId: createdTeam.id, userId: owner.user.id, role: 'admin', status: 'active', canManage: true });
      ownedTeam.memberSnapshot = JSON.stringify(memberships.map(({ workspaceId, userId, role, status, canRead, canWrite, canManage, createdAt, updatedAt }) => (
        { workspaceId, userId, role, status, canRead, canWrite, canManage, createdAt, updatedAt })));
      targetCatalog = (await payload<{ data: { targets: OrganizationPolicyTargetCatalog } }>(await admin.request.get(`${resourcePath(installed.resourceId)}/targets`), 'Fresh actual team target catalog')).data.targets;
      team = targetCatalog.workspaces.find(workspace => workspace.workspaceId === createdTeam.id && workspace.type === 'team');
      if (!team) throw new Error('The actual manager catalog did not expose the newly created active team.');
    }
    teamId = team.workspaceId;
    teamSearch = team.name;
  });

  test.afterAll(async () => {
    const failures: string[] = [];
    try {
      if (admin && installed) {
        const current = await payload<{ plugin: InstalledPlugin }>(await admin.request.get(`/api/plugins/${name}?scope=organization&resourceId=${encodeURIComponent(installed.resourceId)}`), 'Owned plugin cleanup verification');
        if (current.plugin.name !== name || current.plugin.resourceId !== installed.resourceId || current.plugin.checksum !== installed.checksum
          || current.plugin.version !== installed.version) throw new Error('The owned package changed; preservation required.');
        await payload(await admin.request.delete(`/api/plugins/${name}?scope=organization`), 'Owned plugin deletion');
        installed = null;
      }
    } catch { failures.push('owned plugin'); }
    try {
      if (admin && ownedTeam) {
        if (installed || !ownedTeam.memberSnapshot) throw new Error('The owned team must be preserved while fixture ownership or cleanup is unresolved.');
        const listing = await payload<{ workspaces: ClientWorkspaceSummary[] }>(await admin.request.get('/api/workspaces'), 'Owned team snapshot guard');
        const current = listing.workspaces.find(workspace => workspace.id === ownedTeam!.snapshot.id);
        expect(current, 'Own team snapshot must remain unchanged before cleanup').toEqual(ownedTeam.snapshot);
        const memberships = (await payload<{ members: WorkspaceMemberRecord[] }>(await admin.request.get(`/api/workspaces/${encodeURIComponent(ownedTeam.snapshot.id)}/members`), 'Own team creator snapshot guard')).members;
        if (memberships.length !== 1 || memberships[0].userId !== ownedTeam.creatorId) throw new Error('Own team membership changed; preservation required.');
        const snapshot = JSON.stringify(memberships.map(({ workspaceId, userId, role, status, canRead, canWrite, canManage, createdAt, updatedAt }) => (
          { workspaceId, userId, role, status, canRead, canWrite, canManage, createdAt, updatedAt })));
        if (snapshot !== ownedTeam.memberSnapshot) throw new Error('Own team creator membership changed; preservation required.');
        await payload(await admin.request.delete(`/api/workspaces/${encodeURIComponent(ownedTeam.snapshot.id)}`), 'Owned team cleanup');
        const after = await payload<{ workspaces: ClientWorkspaceSummary[] }>(await admin.request.get('/api/workspaces'), 'Owned team cleanup verification');
        expect(after.workspaces.some(workspace => workspace.id === ownedTeam!.snapshot.id && workspace.status === 'active')).toBe(false);
        ownedTeam = null;
      }
    } catch { failures.push('owned team'); }
    try {
      if (sourceDirectory && !installed) {
        const manifest = JSON.parse(await fs.readFile(path.join(sourceDirectory, '.canvas-plugin', 'plugin.json'), 'utf8')) as { name?: string };
        if (manifest.name !== name) throw new Error('Intake package identity changed; preservation required.');
        await fs.rm(sourceDirectory, { recursive: true });
      }
    } catch { failures.push('owned intake package'); }
    await member?.close();
    await admin?.close();
    if (failures.length) throw new Error(`Resource acceptance cleanup requires attention: ${failures.join(', ')}.`);
  });

  test('configures team ownership, grants independent member rights, edits metadata and rejects a stale UI save', async ({}, info) => {
    const ownerPage = await admin.newPage();
    const memberPage = await member.newPage();
    let section = await editDetails(ownerPage);
    await section.getByTestId('resource-owner-scope').selectOption('team');
    await choose(ownerPage, 'resource-owner-team', teamId, teamSearch);
    await section.getByTestId('resource-display-name').fill(`Design workflow ${nonce}`);
    await section.getByTestId('resource-description').fill('Managed by the actual team resource UI.');
    await choose(ownerPage, 'resource-responsible-picker', memberId, memberSearch, true);
    await section.getByTestId('resource-access-mode').selectOption('restricted');
    await choose(ownerPage, 'resource-grant-target', memberId, memberSearch);
    await section.getByTestId('resource-new-canUse').check();
    await expect(section.getByTestId('resource-new-canEdit')).not.toBeChecked();
    await expect(section.getByTestId('resource-new-canManage')).not.toBeChecked();
    await section.getByRole('button', { name: labels.addGrant, exact: true }).click();
    const configured = await save(ownerPage, 'POST');
    resourceRef = configured.metadata.resourceRef;
    expect(configured.metadata.ownership).toMatchObject({ type: 'team', workspaceId: teamId });
    expect(configured.metadata.responsibleUserId).toBe(memberId);
    expect(configured.metadata.metadataRevision).toBe(1);
    expect(configured.metadata.grantsRevision).toBe(1);
    expect(configured.artifact.checksum).toBe(installed!.checksum);
    const useOnly = await inspect(member);
    expect(useOnly.access).toMatchObject({ canRead: true, canUse: true, canEdit: false, canManage: false });
    expect(useOnly.grants).toBeUndefined();
    expect((await member.request.get(`${resourcePath()}/targets`)).status()).toBe(403);
    expect((await member.request.patch(resourcePath(), { data: { expectedMetadataRevision: 1, expectedGrantsRevision: 1, metadata: { displayName: 'Denied' } } })).status()).toBe(403);
    const readOnly = await openDetails(memberPage);
    await expect(memberPage.getByText(en.skills.plugins.details.ownership, { exact: true }).locator('..')).toContainText(labels.scopes.team);
    await expect(readOnly.locator('summary')).toHaveCount(0);
    await expect(readOnly.getByTestId('resource-save')).toHaveCount(0);
    await memberPage.screenshot({ path: info.outputPath('member-use-only-1280-light.png'), fullPage: true, animations: 'disabled' });

    section = await editDetails(ownerPage);
    const grant = section.getByTestId('resource-grant');
    await grant.getByRole('checkbox', { name: new RegExp(`^${labels.rights.canUse}:`, 'u') }).uncheck();
    await grant.getByRole('checkbox', { name: new RegExp(`^${labels.rights.canEdit}:`, 'u') }).check();
    await expect(grant.getByRole('checkbox', { name: new RegExp(`^${labels.rights.canManage}:`, 'u') })).not.toBeChecked();
    const editable = await save(ownerPage);
    expect(editable.metadata.grantsRevision).toBe(2);
    expect((await inspect(member)).access).toMatchObject({ canRead: true, canUse: false, canEdit: true, canManage: false });
    const memberSection = await editDetails(memberPage);
    await expect(memberSection.getByTestId('resource-grants')).toHaveCount(0);
    await memberSection.getByTestId('resource-description').fill('Edited by a member without execution rights.');
    const changed = await save(memberPage);
    expect(changed.metadata.updatedByUserId).toBe(memberId);
    expect(changed.metadata.description).toBe('Edited by a member without execution rights.');
    expect(changed.metadata.grantsRevision).toBe(2);
    expect(changed.artifact.checksum).toBe(installed!.checksum);

    section = await editDetails(ownerPage);
    await section.getByTestId('resource-description').fill('Preserved unsaved owner draft.');
    const external = await inspect();
    await payload(await admin.request.patch(resourcePath(), { data: { expectedMetadataRevision: external.metadata.metadataRevision,
      expectedGrantsRevision: external.metadata.grantsRevision, metadata: { description: 'Concurrent latest value.' } } }), 'Actual concurrent metadata update');
    const staleResponse = ownerPage.waitForResponse(response => new URL(response.url()).pathname.startsWith('/api/capabilities/resources/') && response.request().method() === 'PATCH');
    await section.getByTestId('resource-save').click();
    expect((await staleResponse).status()).toBe(409);
    await expect(section.getByTestId('resource-save')).toBeDisabled();
    await expect(section.getByTestId('resource-description')).toHaveValue('Preserved unsaved owner draft.');
    await section.getByRole('button', { name: labels.reload, exact: true }).click();
    await expect(section.getByTestId('resource-description')).toHaveValue('Concurrent latest value.');
    await expect(section.getByTestId('resource-save')).toBeEnabled();

    for (const [width, theme] of [[1280, 'light'], [390, 'light'], [390, 'dark']] as const) {
      await ownerPage.setViewportSize({ width, height: 900 });
      await ownerPage.evaluate(value => localStorage.setItem('theme', value), theme);
      section = await editDetails(ownerPage);
      await expect(section.getByTestId('resource-save')).toBeEnabled();
      expect(await ownerPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const clearButton = section.getByRole('button', { name: labels.clear, exact: true });
      await clearButton.scrollIntoViewIfNeeded();
      await expect(clearButton).toBeVisible();
      await expect(clearButton).toBeInViewport({ ratio: 1 });
      await expect(section.getByTestId('resource-responsible-picker')).toBeInViewport({ ratio: 1 });
      await ownerPage.screenshot({ path: info.outputPath(`manager-${width}-${theme}-responsible.png`), fullPage: false, animations: 'disabled' });
      await section.screenshot({ path: info.outputPath(`manager-${width}-${theme}.png`), animations: 'disabled' });
      const saveButton = section.getByTestId('resource-save');
      const grantRow = section.getByTestId('resource-grant');
      await saveButton.scrollIntoViewIfNeeded();
      await expect(grantRow).toBeVisible();
      await expect(grantRow).toBeInViewport({ ratio: 1 });
      await expect(saveButton).toBeVisible();
      await expect(saveButton).toBeInViewport({ ratio: 1 });
      await ownerPage.screenshot({ path: info.outputPath(`manager-${width}-${theme}-grants-save.png`), fullPage: false, animations: 'disabled' });
    }
    await section.getByTestId('resource-grant').getByRole('button', { name: /^Remove permission/u }).click();
    await save(ownerPage);
    expect((await member.request.get(resourcePath())).status()).toBe(404);
    expect((await member.request.patch(resourcePath(), { data: { expectedMetadataRevision: 999, expectedGrantsRevision: 999,
      metadata: { description: 'After revocation' } } })).status()).toBe(404);
    expect((await inspect()).artifact.checksum).toBe(installed!.checksum);
  });
});
