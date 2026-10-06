import { randomBytes } from 'node:crypto';
import { expect, test, type APIResponse, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createAuthenticatedContext, runManagedTestPreflight } from './helpers/managed-test-context';
import type { IntegrationConnectionDescriptor, IntegrationConnectionScopeChoice } from '../app/lib/integration-tools/connections/contracts';
import type { ClientWorkspaceSummary } from '../app/lib/workspaces/client-types';
import type { WorkspaceMemberRecord } from '../app/lib/workspaces/contracts';
import en from '../messages/en.json';

const labels = en.sharedConnections;
const nonce = randomBytes(5).toString('hex');
const namespace = `shared-qa-${nonce}`;
const names = { mcp: `${namespace} MCP Team`, updated: `${namespace} Design Team`, server: `${namespace} Concurrent`, composio: `${namespace} Canva Org` };
const profileName = `${namespace} Profiles`;
type Profile = { id: string; name: string; profileRevision: number; createdByUserId: string; status: 'active' | 'archived' };
type SecretSnapshot = { revision: string; entries: Array<{ key: string; value: string; readable?: boolean }> };
const orgKeyPath = '/api/integrations/env?scope=integrations&secretScope=organization&key=COMPOSIO_API_KEY';
const inertOrgKey = `shared-ui-provider-${nonce}`;
let admin: BrowserContext;
let member: BrowserContext;
let adminPage: Page;
let memberPage: Page;
let adminId = '';
let memberId = '';
let memberSearch = '';
let fixtureUrl = '';
let scopes: IntegrationConnectionScopeChoice[] = [];
let teamId = '';
let ownedTeam: { snapshot: ClientWorkspaceSummary; creatorId: string; membership: string } | null = null;
let ownedProfile: Profile | null = null;
let mcp: IntegrationConnectionDescriptor | null = null;
let composio: IntegrationConnectionDescriptor | null = null;
let originalOrgKey: string | null = null;
let orgKeyChanged = false;
const owned = new Map<string, IntegrationConnectionDescriptor>();
test.use({ trace: 'off', video: 'off' });

async function payload<T>(response: Pick<APIResponse, 'ok' | 'status' | 'json'>, phase: string): Promise<T> {
  if (!response.ok()) throw new Error(`${phase} returned HTTP ${response.status()}.`);
  return await response.json() as T;
}
const pathFor = (ref: string) => `/api/integrations/shared-connections/${encodeURIComponent(ref)}`;
const revisions = (value: IntegrationConnectionDescriptor) => ({ expectedMetadataRevision: value.resource.metadataRevision,
  expectedGrantsRevision: value.resource.grantsRevision, expectedBindingRevision: value.resource.bindingRevision });
const remember = (value: IntegrationConnectionDescriptor) => { owned.set(value.resource.connectionRef, value); return value; };
async function inspect(ref: string, context = admin) {
  return (await payload<{ data: { connection: IntegrationConnectionDescriptor } }>(await context.request.get(pathFor(ref)), 'Connection inspection')).data.connection;
}
function safeDto(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const forbidden of ['shared-ui-key-', 'connectedAccountId', 'composioUserId', 'connected_account_id', 'backend_account_id', 'auth_config', 'stage3_account_', 'private-slack-account']) {
    expect(serialized.includes(forbidden), `Public connection DTO must not include ${forbidden}`).toBe(false);
  }
  expect(Object.hasOwn((value as { backend?: unknown }) || {}, 'backend')).toBe(false);
}
async function openSection(page: Page) {
  const workspaceResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspaces'
    && response.request().method() === 'GET');
  await page.goto('/en/plugins', { waitUntil: 'domcontentloaded' });
  const workspacePayload = await payload<{ workspaces: ClientWorkspaceSummary[] }>(await workspaceResponse, 'Page workspace hydration');
  const available = workspacePayload.workspaces.filter(workspace => workspace.status === 'active').map(workspace => workspace.id);
  await expect.poll(async () => available.includes(await page.evaluate(() => localStorage.getItem('canvas.activeWorkspaceId') || '')),
    { message: 'Wait for the real page workspace selection before opening a context-bound section' }).toBe(true);
  const section = page.getByTestId('shared-connections');
  await expect(section).toBeVisible();
  const disclosure = section.getByRole('button', { name: new RegExp(`^${labels.title}`, 'u') });
  if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(section.getByRole('button', { name: labels.reload, exact: true })).toBeEnabled();
  await expect(section.getByText(labels.loading, { exact: true })).toHaveCount(0);
  await expect(section.getByText(labels.loadError, { exact: true })).toHaveCount(0);
  return section;
}
async function editor(page: Page, name: string) {
  const section = await openSection(page);
  const row = section.getByTestId('shared-connection-row').filter({ hasText: name });
  await expect(row).toHaveCount(1); await row.click();
  const result = page.getByTestId('shared-connection-editor');
  await expect(result).toBeVisible();
  return result;
}
async function choose(page: Page, picker: string, userId: string, keyboard = false) {
  const trigger = page.getByTestId(picker);
  await expect(trigger).toBeEnabled(); await trigger.click();
  const controls = await trigger.getAttribute('aria-controls');
  if (!controls) throw new Error('The shared target picker did not identify its own popover.');
  const popover = page.locator(`[id=${JSON.stringify(controls)}][data-state="open"]`);
  await expect(popover).toBeVisible();
  const search = popover.getByRole('combobox', { name: labels.search, exact: true });
  await search.fill(memberSearch); await expect(search).toBeFocused();
  const option = popover.getByTestId(`${picker}-option-${userId}`);
  await expect(option).toBeVisible();
  if (keyboard) {
    await search.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false'); await expect(trigger).toBeFocused();
    await expect(page.getByTestId('shared-connection-editor')).toBeVisible();
    await trigger.click(); await search.fill(memberSearch); await search.press('ArrowDown');
    await expect(option).toHaveAttribute('aria-selected', 'true'); await search.press('Enter');
  } else await option.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('shared-connection-editor')).toBeVisible();
}
async function save(page: Page, ref: string) {
  const response = page.waitForResponse(result => new URL(result.url()).pathname === pathFor(ref) && result.request().method() === 'PATCH');
  await page.getByTestId('shared-connection-editor').getByRole('button', { name: labels.save, exact: true }).click();
  const value = (await payload<{ data: { connection: IntegrationConnectionDescriptor } }>(await response, 'UI grant save')).data.connection;
  safeDto(value); await expect(page.getByTestId('shared-connection-editor')).toHaveCount(0);
  return remember(value);
}
async function screenshots(info: TestInfo, connection: IntegrationConnectionDescriptor, label: string, contextPage = adminPage) {
  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']] as const) {
    await contextPage.setViewportSize({ width, height: 900 });
    await contextPage.evaluate(value => localStorage.setItem('theme', value), theme);
    await editor(contextPage, connection.resource.displayName);
    await expect(contextPage.getByTestId('shared-connection-editor')).toBeVisible();
    if (connection.access.canManage) await expect(contextPage.locator('#shared-edit-name')).toBeEnabled();
    expect(await contextPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Shared connection UI must fit its viewport').toBe(true);
    const dialog = contextPage.getByRole('dialog').filter({ has: contextPage.getByTestId('shared-connection-editor') });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Connection dialog must not overflow horizontally').toBe(true);
    await contextPage.screenshot({ path: info.outputPath(`${label}-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
    if (connection.access.canManage) {
      const save = dialog.getByRole('button', { name: labels.save, exact: true });
      await expect(save).toBeEnabled(); await save.scrollIntoViewIfNeeded();
      const bounds = await save.boundingBox();
      expect(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= 901,
        'The actual Save control must remain reachable inside the responsive dialog').toBe(true);
      await contextPage.screenshot({ path: info.outputPath(`${label}-${width}-${theme}-grants.png`), fullPage: true, animations: 'disabled' });
    }
    await contextPage.keyboard.press('Escape'); await expect(dialog).toBeHidden();
  }
}
async function beginCreate(scope: 'organization' | 'team', source: 'mcp' | 'composio') {
  const section = await openSection(adminPage); await section.getByTestId('shared-connection-create').click();
  const form = adminPage.getByTestId('shared-connection-create-form'); await expect(form).toBeVisible();
  const index = scopes.findIndex(value => value.ownership.type === scope && (scope !== 'team' || value.ownership.type === 'team' && value.ownership.workspaceId === teamId));
  if (index < 0) throw new Error('The required current managed ownership scope is unavailable.');
  await form.locator('#shared-owner').selectOption(String(index)); await form.locator('#shared-source').selectOption(source);
  return form;
}
async function createFromUi(name: string) {
  const response = adminPage.waitForResponse(value => new URL(value.url()).pathname === '/api/integrations/shared-connections'
    && value.request().method() === 'POST' && value.request().postDataJSON()?.displayName === name);
  await adminPage.getByTestId('shared-connection-create-form').getByRole('button', { name: labels.create, exact: true }).click();
  const value = (await payload<{ data: { connection: IntegrationConnectionDescriptor } }>(await response, 'UI shared connection create')).data.connection;
  safeDto(value); expect(value.resource.createdByUserId).toBe(adminId);
  expect(value.access).toEqual({ canRead: true, canUse: false, canManage: true });
  expect(value.resource.accessMode).toBe('restricted'); expect(value.grants).toEqual([]);
  await expect(adminPage.getByTestId('shared-connection-create-form')).toHaveCount(0);
  return remember(value);
}

test.describe('actual shared connection management UI and fresh authority', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000, retries: 0 });
  test.beforeAll(async ({ browser }) => {
    if (process.env.E2E_EXTERNAL_SERVER !== '1') throw new Error('Shared connection acceptance requires Root’s existing isolated external server; never start another server.');
    const fixture = process.env.INTEGRATION_GATEWAY_E2E_FIXTURE_URL;
    const email = process.env.TEST_SECONDARY_EMAIL || process.env.LOCAL_TEAM_SEAT_SECONDARY_EMAIL;
    const password = process.env.TEST_SECONDARY_PASSWORD || process.env.LOCAL_TEAM_SEAT_SECONDARY_PASSWORD;
    if (!fixture || !email || !password) throw new Error('Loopback INTEGRATION_GATEWAY_E2E_FIXTURE_URL and an existing actual secondary identity are required; no silent skips.');
    const url = new URL(fixture); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Use the Root-owned loopback provider fixture.');
    fixtureUrl = url.origin;
    const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL, adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) throw new Error('The isolated host’s bootstrap admin credentials are required.');
    admin = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } }, { email: adminEmail, password: adminPassword }); await runManagedTestPreflight(admin);
    member = await createAuthenticatedContext(browser, { viewport: { width: 1280, height: 900 } }, { email, password }); await runManagedTestPreflight(member);
    adminId = (await payload<{ user: { id: string } }>(await admin.request.get('/api/auth/get-session'), 'Admin identity')).user.id;
    const memberIdentity = (await payload<{ user: { id: string; email: string; role: string } }>(await member.request.get('/api/auth/get-session'), 'Member identity')).user;
    memberId = memberIdentity.id; memberSearch = memberIdentity.email;
    if (memberId === adminId || memberIdentity.role === 'admin') throw new Error('Use an actual separate non-admin member for this acceptance.');
    const secret = (await payload<{ data: SecretSnapshot }>(await admin.request.get(orgKeyPath), 'Targeted organization provider-key backup')).data;
    const original = secret.entries.find(entry => entry.key === 'COMPOSIO_API_KEY');
    if (original?.readable === false) throw new Error('The organization provider key cannot be safely backed up. Stop before any provider or credential changes.');
    originalOrgKey = original?.value ?? null;
    await payload(await admin.request.patch('/api/integrations/env', { data: { scope: 'integrations', secretScope: 'organization',
      baseRevision: secret.revision, patches: [{ key: 'COMPOSIO_API_KEY', value: inertOrgKey }] } }), 'Targeted inert organization provider-key setup');
    orgKeyChanged = true;
    scopes = (await payload<{ data: { scopes: IntegrationConnectionScopeChoice[] } }>(await admin.request.get('/api/integrations/shared-connections/setup'), 'Ownership setup scopes')).data.scopes;
    if (!scopes.some(scope => scope.ownership.type === 'organization')) throw new Error('The authenticated admin must currently manage organization connections.');
    let team = scopes.find(scope => scope.ownership.type === 'team' && (!process.env.SHARED_CONNECTIONS_E2E_TEAM_ID || scope.ownership.workspaceId === process.env.SHARED_CONNECTIONS_E2E_TEAM_ID));
    if (!team) {
      const created = (await payload<{ workspace: ClientWorkspaceSummary }>(await admin.request.post('/api/workspaces', {
        data: { type: 'team', name: `${namespace} Team`, description: `Owned shared-connection acceptance ${nonce}` },
      }), 'Guarded own team setup')).workspace;
      expect(created.type).toBe('team'); expect(created.status).toBe('active'); expect(created.isDefault).toBe(false);
      const members = (await payload<{ members: WorkspaceMemberRecord[] }>(await admin.request.get(`/api/workspaces/${encodeURIComponent(created.id)}/members`), 'Own team membership guard')).members;
      expect(members).toHaveLength(1); expect(members[0]).toMatchObject({ userId: adminId, status: 'active', canManage: true });
      ownedTeam = { snapshot: created, creatorId: adminId, membership: JSON.stringify(members) };
      scopes = (await payload<{ data: { scopes: IntegrationConnectionScopeChoice[] } }>(await admin.request.get('/api/integrations/shared-connections/setup'), 'Fresh ownership setup scopes')).data.scopes;
      team = scopes.find(scope => scope.ownership.type === 'team' && scope.ownership.workspaceId === created.id);
    }
    if (!team || team.ownership.type !== 'team') throw new Error('Actual managed team ownership was not available after guarded setup.');
    teamId = team.ownership.workspaceId;
    adminPage = await admin.newPage(); memberPage = await member.newPage();
  });

  test('explicit Team MCP setup, metadata/responsible picker and independent member Use grant', async ({}, info) => {
    const form = await beginCreate('team', 'mcp');
    await form.locator('#shared-name').fill(names.mcp); await form.locator('#shared-url').fill(`${fixtureUrl}/mcp`);
    await form.locator('#shared-token').fill(`shared-ui-key-${nonce}`);
    mcp = await createFromUi(names.mcp); expect(mcp.resource.ownership).toMatchObject({ type: 'team', workspaceId: teamId });
    const beforeGrant = await member.request.get(pathFor(mcp.resource.connectionRef)); expect(beforeGrant.status()).toBe(404);
    const edit = await editor(adminPage, names.mcp);
    await expect(edit.locator('#shared-edit-name')).toBeEnabled();
    await edit.locator('#shared-edit-name').fill(names.updated); await edit.locator('#shared-edit-description').fill('Shared design workflow with an explicitly selected person.');
    await choose(adminPage, 'shared-responsible', memberId, true);
    await edit.locator('#shared-target-type').selectOption('user'); await choose(adminPage, 'shared-grant-target', memberId);
    await edit.getByRole('checkbox', { name: labels.canUse, exact: true }).check();
    await expect(edit.getByRole('checkbox', { name: labels.manage, exact: true })).not.toBeChecked();
    await edit.locator('summary').filter({ hasText: labels.grantToolLimits }).click();
    await edit.getByRole('textbox', { name: labels.grantToolLimits, exact: true }).fill('canva_find_designs');
    await edit.getByRole('button', { name: labels.addGrant, exact: true }).click();
    await expect(edit.getByTestId('shared-grants')).toContainText(labels.canUse);
    mcp = await save(adminPage, mcp.resource.connectionRef);
    expect(mcp.resource.responsibleUserId).toBe(memberId);
    expect(mcp.grants).toHaveLength(1); expect(mcp.grants![0]).toMatchObject({ targetType: 'user', targetId: memberId, canUse: true, canManage: false, allowedToolNames: ['canva_find_designs'] });
    const memberDto = await inspect(mcp.resource.connectionRef, member); safeDto(memberDto);
    expect(memberDto.access).toEqual({ canRead: true, canUse: true, canManage: false }); expect(memberDto.grants).toBeUndefined();
    const memberEditor = await editor(memberPage, names.updated);
    await expect(memberEditor.getByText(labels.canUse, { exact: true })).toBeVisible();
    await expect(memberEditor.locator('#shared-edit-name')).toHaveCount(0);
    await expect(memberEditor.getByRole('button', { name: labels.save, exact: true })).toHaveCount(0);
    const denied = await member.request.patch(pathFor(mcp.resource.connectionRef), { data: { ...revisions(mcp), metadata: { displayName: `${namespace} Forbidden` } } });
    expect(denied.status()).toBe(403);
    await screenshots(info, mcp, 'mcp-admin'); await screenshots(info, memberDto, 'mcp-member', memberPage);
  });

  test('real stale revision preserves the draft; Reload and revoke close UI/API access immediately', async () => {
    if (!mcp) throw new Error('The Team MCP setup must finish before the conflict/revocation test.');
    const edit = await editor(adminPage, mcp.resource.displayName);
    await expect(edit.locator('#shared-edit-name')).toBeEnabled();
    const draft = `${namespace} Draft retained`; await edit.locator('#shared-edit-name').fill(draft);
    const changed = (await payload<{ data: { connection: IntegrationConnectionDescriptor } }>(await admin.request.patch(pathFor(mcp.resource.connectionRef), {
      data: { ...revisions(mcp), metadata: { displayName: names.server } },
    }), 'Actual concurrent metadata write')).data.connection;
    remember(changed);
    const stale = adminPage.waitForResponse(value => new URL(value.url()).pathname === pathFor(mcp!.resource.connectionRef) && value.request().method() === 'PATCH');
    await edit.getByRole('button', { name: labels.save, exact: true }).click(); expect((await stale).status()).toBe(409);
    await expect(edit.getByText(labels.conflict, { exact: true })).toBeVisible();
    await expect(edit.locator('#shared-edit-name')).toHaveValue(draft); await expect(edit.getByRole('button', { name: labels.save, exact: true })).toBeDisabled();
    await edit.getByRole('button', { name: labels.reload, exact: true }).click();
    await expect(edit.locator('#shared-edit-name')).toBeEnabled(); await expect(edit.locator('#shared-edit-name')).toHaveValue(names.server);
    await edit.locator('#shared-edit-name').fill(names.updated);
    await edit.getByTestId('shared-grants').getByRole('button', { name: labels.remove, exact: true }).click();
    await expect(edit.getByTestId('shared-grants').getByRole('button')).toHaveCount(0);
    mcp = await save(adminPage, mcp.resource.connectionRef);
    const deniedRead = await member.request.get(pathFor(mcp.resource.connectionRef)); expect(deniedRead.status()).toBe(404);
    const deniedTargets = await member.request.get(`${pathFor(mcp.resource.connectionRef)}/targets`); expect([403, 404]).toContain(deniedTargets.status());
    const section = await openSection(memberPage); await expect(section.getByTestId('shared-connection-row').filter({ hasText: names.updated })).toHaveCount(0);
  });

  test('explicit Organization Composio profile/app and opaque account selection, without exposing other apps', async ({}, info) => {
    const form = await beginCreate('organization', 'composio');
    await form.locator('#shared-name').fill(names.composio);
    await form.locator('summary').filter({ hasText: labels.newProfile }).click(); await form.locator('#shared-profile-name').fill(profileName);
    await form.locator('#shared-profile-mode').selectOption('local');
    const created = adminPage.waitForResponse(response => new URL(response.url()).pathname === '/api/composio/shared-profiles' && response.request().method() === 'POST');
    await form.getByRole('button', { name: labels.createProfile, exact: true }).click();
    ownedProfile = (await payload<{ data: { profile: Profile } }>(await created, 'UI shared profile create')).data.profile;
    expect(ownedProfile.name).toBe(profileName); expect(ownedProfile.createdByUserId).toBe(adminId);
    expect((ownedProfile as Profile & { composioUserId?: string }).composioUserId).toBeUndefined();
    await expect(form.locator('#shared-profile')).toHaveValue(ownedProfile.id); await form.locator('#shared-app').fill('canva');
    composio = await createFromUi(names.composio); expect(composio.resource.ownership.type).toBe('organization'); expect(composio.resource.application).toBe('canva');
    const edit = await editor(adminPage, names.composio); await edit.locator('summary').filter({ hasText: labels.accountSetup }).click();
    const loaded = adminPage.waitForResponse(response => new URL(response.url()).pathname === `/api/composio/shared-connections/${encodeURIComponent(composio!.resource.connectionRef)}/accounts`
      && response.request().method() === 'GET');
    await edit.getByRole('button', { name: labels.loadAccounts, exact: true }).click();
    const accounts = (await payload<{ data: { accounts: Array<{ accountRef: string; label: string; selectable: boolean }> } }>(await loaded, 'Opaque app account picker')).data.accounts;
    expect(accounts).toHaveLength(1); safeDto(accounts);
    expect(accounts.every(account => account.accountRef.startsWith('cmp_account_') && account.selectable)).toBe(true);
    expect(accounts.every(account => Object.keys(account).every(key => ['accountRef', 'label', 'selectable', 'status'].includes(key)))).toBe(true);
    const options = edit.locator('#shared-account option:not([value=""])'); await expect(options).toHaveCount(1);
    const opaque = await options.first().getAttribute('value'); if (!opaque) throw new Error('No opaque app account selection was exposed.');
    await edit.locator('#shared-account').selectOption(opaque);
    const bound = adminPage.waitForResponse(response => new URL(response.url()).pathname === `/api/composio/shared-connections/${encodeURIComponent(composio!.resource.connectionRef)}/accounts`
      && response.request().method() === 'PATCH');
    await edit.getByRole('button', { name: labels.bindAccount, exact: true }).click();
    composio = remember((await payload<{ data: { connection: IntegrationConnectionDescriptor } }>(await bound, 'Explicit UI account binding')).data.connection);
    safeDto(composio); expect(composio.resource.bindingRevision).toBeGreaterThan(1);
    await expect(edit.getByRole('button', { name: labels.checkStatus, exact: true })).toBeEnabled();
    await edit.getByRole('button', { name: labels.checkStatus, exact: true }).click(); await expect(edit.getByText(labels.connected, { exact: true })).toBeVisible();
    await screenshots(info, composio, 'composio-admin');
    expect((await member.request.get(pathFor(composio.resource.connectionRef))).status()).toBe(404);
  });

  test.afterAll(async ({}, info) => {
    const failures: string[] = [];
    const retained: { connectionRefs: string[]; profileIds: string[]; disabledOwnTeamIds: string[]; auditRecordsRetained: boolean } = { connectionRefs: [], profileIds: [], disabledOwnTeamIds: [], auditRecordsRetained: true };
    if (admin) {
      for (const [ref, snapshot] of owned) {
        try {
          let current = await inspect(ref);
          if (current.resource.createdByUserId !== adminId || !current.resource.displayName.startsWith(namespace)
            || JSON.stringify(revisions(current)) !== JSON.stringify(revisions(snapshot))
            || (current.grants || []).some(grant => grant.targetType !== 'user' || grant.targetId !== memberId || grant.canManage)) {
            throw new Error('The owned resource changed; preserve it for review.');
          }
          if (current.resource.source === 'mcp') {
            const removed = await payload<{ data: IntegrationConnectionDescriptor }>(await admin.request.patch(`/api/mcp/shared-connections/${encodeURIComponent(ref)}/secrets`, {
              data: { ...revisions(current), patches: [{ name: 'TOKEN', value: null }] },
            }), 'Own resource secret removal before archival');
            current = removed.data; remember(current);
          }
          current = (await payload<{ data: { connection: IntegrationConnectionDescriptor } }>(await admin.request.patch(pathFor(ref), {
            data: { ...revisions(current), status: 'archived' },
          }), 'Own resource archival')).data.connection;
          expect(current.resource.status).toBe('archived'); remember(current); retained.connectionRefs.push(ref);
        } catch { failures.push(`owned connection ${ref}`); }
      }
      if (ownedProfile) {
        try {
          if (failures.length) throw new Error('Preserve the profile while connection cleanup remains unresolved.');
          const current = (await payload<{ data: { profile: Profile } }>(await admin.request.get(`/api/composio/shared-profiles/${encodeURIComponent(ownedProfile.id)}`), 'Own profile cleanup guard')).data.profile;
          if (current.id !== ownedProfile.id || current.name !== profileName || current.createdByUserId !== adminId || current.profileRevision !== ownedProfile.profileRevision) throw new Error('The owned profile changed.');
          const archived = (await payload<{ data: { profile: Profile } }>(await admin.request.patch(`/api/composio/shared-profiles/${encodeURIComponent(current.id)}`, {
            data: { expectedProfileRevision: current.profileRevision, status: 'archived' },
          }), 'Own profile archival after its connections')).data.profile;
          expect(archived.status).toBe('archived'); retained.profileIds.push(archived.id);
        } catch { failures.push('owned shared profile'); }
      }
      if (ownedTeam) {
        // The API soft-disables the exact owned team. Archived connection and
        // audit rows retain their scope association; no existing team is changed.
        try {
          if (failures.length) throw new Error('Preserve the team while its connection cleanup remains unresolved.');
          const workspaces = (await payload<{ workspaces: ClientWorkspaceSummary[] }>(await admin.request.get('/api/workspaces'), 'Own team snapshot guard')).workspaces;
          expect(workspaces.find(workspace => workspace.id === ownedTeam!.snapshot.id)).toEqual(ownedTeam.snapshot);
          const members = (await payload<{ members: WorkspaceMemberRecord[] }>(await admin.request.get(`/api/workspaces/${encodeURIComponent(ownedTeam.snapshot.id)}/members`), 'Retained own audit-team guard')).members;
          if (JSON.stringify(members) !== ownedTeam.membership || members.length !== 1 || members[0].userId !== ownedTeam.creatorId) throw new Error('The own audit-team membership changed.');
          await payload(await admin.request.delete(`/api/workspaces/${encodeURIComponent(ownedTeam.snapshot.id)}`), 'Exact own team soft-deactivation');
          const after = (await payload<{ workspaces: ClientWorkspaceSummary[] }>(await admin.request.get('/api/workspaces'), 'Own team deactivation verification')).workspaces;
          expect(after.some(workspace => workspace.id === ownedTeam!.snapshot.id && workspace.status === 'active')).toBe(false);
          retained.disabledOwnTeamIds.push(ownedTeam.snapshot.id);
        } catch { failures.push('own audit team'); }
      }
      if (orgKeyChanged) {
        try {
          const current = (await payload<{ data: SecretSnapshot }>(await admin.request.get(orgKeyPath), 'Targeted organization provider-key cleanup read')).data;
          const key = current.entries.find(entry => entry.key === 'COMPOSIO_API_KEY');
          if (key?.readable === false || key?.value !== inertOrgKey) throw new Error('The organization provider key changed; preserve the current value.');
          await payload(await admin.request.patch('/api/integrations/env', { data: { scope: 'integrations', secretScope: 'organization',
            baseRevision: current.revision, patches: [{ key: 'COMPOSIO_API_KEY', value: originalOrgKey }] } }), 'Exact original organization provider-key restoration');
          originalOrgKey = null; orgKeyChanged = false;
        } catch { failures.push('targeted organization provider key'); }
      }
    }
    await info.attach('retained-owned-archives-and-audit.json', { body: Buffer.from(JSON.stringify(retained, null, 2)), contentType: 'application/json' });
    await Promise.allSettled([admin?.close(), member?.close()].filter(Boolean));
    if (failures.length) throw new Error(`Exact owned cleanup needs review: ${failures.join(', ')}. Unverified resources, grants and secrets were preserved.`);
  });
});
